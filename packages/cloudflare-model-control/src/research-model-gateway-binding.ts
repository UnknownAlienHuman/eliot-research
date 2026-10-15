import { ModelGatewayExecutionError, resolveModelGatewayReasoningEndpoint } from "@eliotr/cloudflare-ai";

/** Native Worker capability; acquisition and authentication stay inside Cloudflare. */
export interface ResearchModelGatewayBinding {
  gateway(gatewayId: string): Pick<AiGateway, "getUrl" | "getLog" | "run">;
}

const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const LOG_METADATA_KEYS = new Set([
  "budget_reservation_ref",
  "evidence_pack_ref",
  "output_object_ref",
  "prompt_generation",
  "schema_generation",
]);
type SafeResponseReason = NonNullable<ModelGatewayExecutionError["safe_response_reason"]>;

function invalid(message: string): never {
  throw new ModelGatewayExecutionError("MODEL_GATEWAY_REQUEST_INVALID", message);
}

function safeResponseCause(cause: unknown): ModelGatewayExecutionError {
  if (cause instanceof ModelGatewayExecutionError) return cause;
  return new ModelGatewayExecutionError("MODEL_GATEWAY_RESPONSE_INVALID", "AI Gateway response normalization failed");
}

function responseInvalid(reason: SafeResponseReason, message: string, cause?: unknown): never {
  throw new ModelGatewayExecutionError("MODEL_GATEWAY_RESPONSE_INVALID", message, {
    safe_response_reason: reason,
    ...(cause === undefined ? {} : { cause: safeResponseCause(cause) }),
  });
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} is invalid`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) invalid(`${label} is invalid`);
  return value;
}

function responseIdentifier(value: unknown, label: string, reason: SafeResponseReason): string {
  try { return identifier(value, label); }
  catch (cause) { responseInvalid(reason, `${label} is invalid`, cause); }
}

function exactMetadata(value: unknown, label: string): Record<string, string> {
  let decoded = value;
  if (typeof decoded === "string") {
    try { decoded = JSON.parse(decoded) as unknown; }
    catch { invalid(`${label} is invalid`); }
  }
  const record = plainRecord(decoded, label);
  const keys = Object.keys(record);
  if (keys.length !== LOG_METADATA_KEYS.size || keys.some((key) => !LOG_METADATA_KEYS.has(key))) {
    invalid(`${label} is invalid`);
  }
  const result: Record<string, string> = {};
  for (const key of LOG_METADATA_KEYS) result[key] = identifier(record[key], `${label}.${key}`);
  return result;
}

function responseMetadata(value: unknown, label: string): Record<string, string> {
  try { return exactMetadata(value, label); }
  catch (cause) { responseInvalid("LOG_CORRELATION_INVALID", `${label} is invalid`, cause); }
}

function sameMetadata(left: Record<string, string>, right: Record<string, string>): boolean {
  for (const key of LOG_METADATA_KEYS) if (left[key] !== right[key]) return false;
  return true;
}

async function readGatewayLog(gateway: Pick<AiGateway, "getLog">, logId: string): Promise<unknown> {
  // Gateway logs are indexed after inference. Retry only a missing readback;
  // the model request above is never repeated.
  const delays = [500, 1500, 3000, 5000];
  for (let attempt = 0; ; attempt += 1) {
    try { return await gateway.getLog(logId); }
    catch (cause) {
      const missing = cause instanceof Error && cause.name === "AiGatewayLogNotFound";
      const delay = delays[attempt];
      if (!missing || delay === undefined) {
        responseInvalid("LOG_READBACK_UNAVAILABLE", "AI Gateway log readback is unavailable", cause);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function normalizeFingerprintHeaders(
  response: Response,
  gateway: Pick<AiGateway, "getLog">,
  requestHeaders: Headers,
): Promise<Response> {
  const provider = response.headers.get("cf-aig-provider");
  const model = response.headers.get("cf-aig-model");
  if (provider !== null && model !== null) return response;
  const logId = response.headers.get("cf-aig-log-id");
  if (logId === null) responseInvalid("LOG_ID_MISSING", "AI Gateway response is missing its response-scoped log id");
  const boundedLogId = responseIdentifier(logId, "AI Gateway response log id", "LOG_ID_INVALID");
  const metadata = responseMetadata(requestHeaders.get("cf-aig-metadata"), "AI Gateway request metadata");
  const log = await readGatewayLog(gateway, boundedLogId);
  let record: Record<string, unknown>;
  try { record = plainRecord(log, "AI Gateway log readback"); }
  catch (cause) { responseInvalid("LOG_CORRELATION_INVALID", "AI Gateway log readback is invalid", cause); }
  if (responseIdentifier(record.id, "AI Gateway log id", "LOG_CORRELATION_INVALID") !== boundedLogId ||
      record.status_code !== response.status ||
      !Number.isSafeInteger(record.status_code) ||
      (record.status_code as number) < 200 || (record.status_code as number) > 299) {
    responseInvalid("LOG_CORRELATION_INVALID", "AI Gateway log readback does not match the response");
  }
  if (record.cached !== false) {
    responseInvalid("CACHE_INVALID", "AI Gateway log readback reports a cached response");
  }
  if (!sameMetadata(metadata, responseMetadata(record.metadata, "AI Gateway log metadata"))) {
    responseInvalid("LOG_CORRELATION_INVALID", "AI Gateway log metadata does not match the request");
  }
  const loggedProvider = responseIdentifier(record.provider, "AI Gateway log provider", "FINGERPRINT_INVALID");
  const loggedModel = responseIdentifier(record.model, "AI Gateway log model", "FINGERPRINT_INVALID");
  if (provider !== null && responseIdentifier(provider, "AI Gateway response provider", "FINGERPRINT_INVALID") !== loggedProvider) {
    responseInvalid("LOG_CORRELATION_INVALID", "AI Gateway response provider does not match its log");
  }
  if (model !== null && responseIdentifier(model, "AI Gateway response model", "FINGERPRINT_INVALID") !== loggedModel) {
    responseInvalid("LOG_CORRELATION_INVALID", "AI Gateway response model does not match its log");
  }
  const headers = new Headers(response.headers);
  if (provider === null) headers.set("cf-aig-provider", loggedProvider);
  if (model === null) headers.set("cf-aig-model", loggedModel);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function createResearchModelGatewayBindingFetch(
  binding: ResearchModelGatewayBinding,
  endpoint: string,
): (url: string, init: RequestInit) => Promise<Response> {
  if (binding === null || typeof binding !== "object" || typeof binding.gateway !== "function") {
    invalid("reasoning gateway Worker binding is unavailable");
  }
  const gateway = binding.gateway("eliotr-reasoning");
  if (gateway === null || typeof gateway !== "object" || typeof gateway.getUrl !== "function" || typeof gateway.run !== "function") {
    invalid("reasoning gateway Worker binding is invalid");
  }
  return async (url, init) => {
    if (url !== endpoint || typeof init.body !== "string") invalid("bound gateway request is invalid");
    const headers = new Headers(init.headers);
    if (headers.has("authorization") || headers.has("cf-aig-authorization")) {
      invalid("bound gateway authentication must not use a request credential");
    }
    if (headers.has("cf-aig-byok-alias") || headers.has("cf-aig-no-wholesale")) {
      invalid("BYOK aliases require direct AI Gateway passthrough transport");
    }
    // getUrl binds the configured account as well as the fixed reasoning gateway.
    const actualBase = await gateway.getUrl();
    if (resolveModelGatewayReasoningEndpoint(actualBase) !== endpoint) {
      invalid("reasoning gateway Worker binding belongs to another account");
    }
    init.signal?.throwIfAborted();
    let query: unknown;
    try { query = JSON.parse(init.body) as unknown; }
    catch { invalid("bound gateway request body is not JSON"); }
    if (query === null || typeof query !== "object" || Array.isArray(query)) invalid("bound gateway request body is invalid");
    const inputs = query as Record<string, unknown>;
    if (typeof inputs.model !== "string" || inputs.model.length === 0) invalid("bound gateway request model is invalid");
    const timeoutMs = Number(headers.get("cf-aig-request-timeout"));
    if (headers.get("cf-aig-collect-log") !== "true" ||
        headers.get("cf-aig-collect-log-payload") !== "false" ||
        headers.get("cf-aig-skip-cache") !== "true" ||
        headers.get("cf-aig-max-attempts") !== "1" ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
      invalid("bound gateway request does not preserve the approved metadata-only single-attempt policy");
    }
    const metadata = exactMetadata(headers.get("cf-aig-metadata"), "AI Gateway request metadata");
    // Preserve canonical cache/logging/timeout/single-attempt headers on the
    // gateway request. Provider headers contain no separate gateway credential.
    // Use the Gateway's HTTP transport so response-scoped routing/log headers survive.
    // This is one Universal request to the existing compatibility route, not a fallback.
    const response = await gateway.run({ provider: "compat", endpoint: "chat/completions", headers: {}, query: inputs }, {
      gateway: {
        collectLog: true,
        skipCache: true,
        metadata,
      },
      extraHeaders: Object.fromEntries(headers),
      ...(init.signal == null ? {} : { signal: init.signal }),
    });
    if (!(response instanceof Response)) invalid("native AI Gateway binding did not return a Response");
    if (!response.ok) return response;
    try {
      // Native responses may omit routing headers. Their response-scoped,
      // authenticated Gateway log supplies observed identity, never a default.
      return await normalizeFingerprintHeaders(response, gateway, headers);
    } catch (cause) {
      const typedCause = safeResponseCause(cause);
      throw new ModelGatewayExecutionError("MODEL_GATEWAY_RESPONSE_INVALID",
        "AI Gateway response does not contain a valid dynamic-route fingerprint", {
          http_status: response.status,
          ...(typedCause.safe_response_reason === undefined ? {} : { safe_response_reason: typedCause.safe_response_reason }),
          cause: typedCause,
        });
    }
  };
}
