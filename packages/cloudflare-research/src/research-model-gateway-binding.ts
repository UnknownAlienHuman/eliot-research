import { ModelGatewayExecutionError, resolveModelGatewayReasoningEndpoint } from "@eliotr/cloudflare-ai";

/** Native Worker capability; acquisition and authentication stay inside Cloudflare. */
export interface ResearchModelGatewayBinding {
  gateway(gatewayId: string): Pick<AiGateway, "getUrl" | "getLog">;
  run(
    model: string,
    inputs: Record<string, unknown>,
    options: {
      readonly gateway: { readonly id: string };
      readonly returnRawResponse: true;
      readonly extraHeaders: Record<string, string>;
      readonly signal?: AbortSignal;
    },
  ): Promise<unknown>;
}

const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const LOG_METADATA_KEYS = new Set([
  "budget_reservation_ref",
  "evidence_pack_ref",
  "output_object_ref",
  "prompt_generation",
  "schema_generation",
]);

function invalid(message: string): never {
  throw new ModelGatewayExecutionError("MODEL_GATEWAY_REQUEST_INVALID", message);
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
      if (!missing || delay === undefined) invalid("AI Gateway log readback is unavailable");
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
  if (logId === null) invalid("AI Gateway response is missing its response-scoped log id");
  const boundedLogId = identifier(logId, "AI Gateway response log id");
  const metadata = exactMetadata(requestHeaders.get("cf-aig-metadata"), "AI Gateway request metadata");
  const log = await readGatewayLog(gateway, boundedLogId);
  const record = plainRecord(log, "AI Gateway log readback");
  if (identifier(record.id, "AI Gateway log id") !== boundedLogId ||
      record.status_code !== response.status ||
      !Number.isSafeInteger(record.status_code) ||
      (record.status_code as number) < 200 || (record.status_code as number) > 299 ||
      record.cached !== false) {
    invalid("AI Gateway log readback does not match the response");
  }
  if (!sameMetadata(metadata, exactMetadata(record.metadata, "AI Gateway log metadata"))) {
    invalid("AI Gateway log metadata does not match the request");
  }
  const loggedProvider = identifier(record.provider, "AI Gateway log provider");
  const loggedModel = identifier(record.model, "AI Gateway log model");
  if (provider !== null && identifier(provider, "AI Gateway response provider") !== loggedProvider) {
    invalid("AI Gateway response provider does not match its log");
  }
  if (model !== null && identifier(model, "AI Gateway response model") !== loggedModel) {
    invalid("AI Gateway response model does not match its log");
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
  if (binding === null || typeof binding !== "object" || typeof binding.gateway !== "function" || typeof binding.run !== "function") {
    invalid("reasoning gateway Worker binding is unavailable");
  }
  const gateway = binding.gateway("eliotr-reasoning");
  if (gateway === null || typeof gateway !== "object" || typeof gateway.getUrl !== "function") {
    invalid("reasoning gateway Worker binding is invalid");
  }
  return async (url, init) => {
    if (url !== endpoint || typeof init.body !== "string") invalid("bound gateway request is invalid");
    const headers = new Headers(init.headers);
    if (headers.has("authorization") || headers.has("cf-aig-authorization")) {
      invalid("bound gateway authentication must not use a request credential");
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
    // Preserve canonical cache/logging/timeout/single-attempt headers on the
    // gateway request. Provider headers contain no separate gateway credential.
    const response = await binding.run(inputs.model, inputs, {
      gateway: { id: "eliotr-reasoning" },
      returnRawResponse: true,
      extraHeaders: Object.fromEntries(headers),
      ...(init.signal == null ? {} : { signal: init.signal }),
    });
    if (!(response instanceof Response)) invalid("native Workers AI binding did not return a Response");
    if (!response.ok) return response;
    try {
      // Native responses may omit routing headers. Their response-scoped,
      // authenticated Gateway log supplies observed identity, never a default.
      return await normalizeFingerprintHeaders(response, gateway, headers);
    } catch (cause) {
      throw new ModelGatewayExecutionError("MODEL_GATEWAY_RESPONSE_INVALID",
        "AI Gateway response does not contain a valid dynamic-route fingerprint", { cause });
    }
  };
}
