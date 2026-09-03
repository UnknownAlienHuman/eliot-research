import {
  decodeDynamicRouteFingerprint,
  type ModelRouteDeployment,
  type RouteFingerprint,
} from "@eliotr/platform-cloudflare";
import {
  ModelGatewayExecutionError,
  modelGatewayExecutionFailure,
  type DecodedModelGatewayResponse,
  type ModelGatewayUsageObservation,
} from "./model-gateway-execution-contract.js";
import { modelGatewaySha256 } from "./model-gateway-request.js";

const RESPONSE_KEYS = new Set([
  "choices",
  "created",
  "id",
  "model",
  "object",
  "service_tier",
  "system_fingerprint",
  "usage",
]);
const CHOICE_KEYS = new Set(["finish_reason", "index", "logprobs", "message"]);
const MESSAGE_KEYS = new Set(["annotations", "content", "refusal", "role"]);
const USAGE_KEYS = new Set([
  "completion_tokens",
  "completion_tokens_details",
  "prompt_tokens",
  "prompt_tokens_details",
  "total_tokens",
]);
const DLP_KEYS = new Set(["action", "findings"]);
const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const LOG_ID = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const POLICY_ERROR_CODES = new Set([2016, 2017, 2029, 2030]);
const RATE_LIMIT_ERROR_CODES = new Set([2003]);
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_MEMBERS = 2048;

function exactObject(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      `${label} must be a plain object`,
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      `${label} must be a plain object`,
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_RESPONSE_INVALID",
        `${label} contains unsupported field ${key}`,
      );
    }
  }
  return record;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return value as Record<string, unknown>;
}

function boundedString(
  value: unknown,
  label: string,
  maximumBytes = 256 * 1024,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.trim().length < 1 ||
    new TextEncoder().encode(value).byteLength > maximumBytes ||
    /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      `${label} is invalid`,
    );
  }
  return value;
}

function optionalBoundedString(
  value: unknown,
  label: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return boundedString(value, label, 1024);
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      `${label} must be a non-negative safe integer`,
    );
  }
  return value;
}

function header(
  headers: Headers,
  name: string,
  required: boolean,
): string | undefined {
  const value = headers.get(name);
  if (value === null) {
    if (required) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_RESPONSE_INVALID",
        `AI Gateway response is missing ${name}`,
      );
    }
    return undefined;
  }
  if (
    value.length < 1 ||
    value.length > 8192 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      `AI Gateway response header ${name} is invalid`,
    );
  }
  return value;
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  requireNonEmpty: boolean,
): Promise<Uint8Array> {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/u.test(rawLength)) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_RESPONSE_INVALID",
        "AI Gateway content-length is invalid",
      );
    }
    const declaredLength = Number(rawLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maximumBytes) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_RESPONSE_INVALID",
        "AI Gateway response exceeds its byte budget",
      );
    }
  }
  if (response.body === null) {
    if (requireNonEmpty) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_RESPONSE_INVALID",
        "AI Gateway response body is missing",
      );
    }
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel("response byte budget exceeded");
        modelGatewayExecutionFailure(
          "MODEL_GATEWAY_RESPONSE_INVALID",
          "AI Gateway response exceeds its byte budget",
        );
      }
      chunks.push(next.value);
    }
  } catch (cause) {
    if (cause instanceof ModelGatewayExecutionError) throw cause;
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response body could not be read",
      { cause },
    );
  }
  if (requireNonEmpty && length < 1) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response body is empty",
    );
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

interface JsonState {
  members: number;
  readonly ancestors: WeakSet<object>;
}

function validateBoundedJson(value: unknown, depth: number, state: JsonState): void {
  if (depth > MAX_JSON_DEPTH) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response contains excessively deep JSON",
    );
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    if (
      typeof value === "string" &&
      new TextEncoder().encode(value).byteLength > MAX_ERROR_BODY_BYTES
    ) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_RESPONSE_INVALID",
        "AI Gateway response contains an oversized JSON string",
      );
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_RESPONSE_INVALID",
        "AI Gateway response contains a non-finite JSON number",
      );
    }
    return;
  }
  if (typeof value !== "object" || value === undefined) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response contains a non-JSON value",
    );
  }
  if (state.ancestors.has(value)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response contains cyclic JSON",
    );
  }
  state.ancestors.add(value);
  if (Array.isArray(value)) {
    state.members += value.length;
    if (state.members > MAX_JSON_MEMBERS) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_RESPONSE_INVALID",
        "AI Gateway response exceeds the JSON member bound",
      );
    }
    value.forEach((entry) => validateBoundedJson(entry, depth + 1, state));
    state.ancestors.delete(value);
    return;
  }
  const record = plainObject(value);
  if (record === null) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response contains a non-plain JSON object",
    );
  }
  const keys = Object.keys(record);
  state.members += keys.length;
  if (state.members > MAX_JSON_MEMBERS) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response exceeds the JSON member bound",
    );
  }
  keys.forEach((key) => validateBoundedJson(record[key], depth + 1, state));
  state.ancestors.delete(value);
}

function decodeDlpAction(headers: Headers): "FLAG" | "BLOCK" | undefined {
  const raw = header(headers, "cf-aig-dlp", false);
  if (raw === undefined) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (cause) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway DLP header is not valid JSON",
      { cause },
    );
  }
  const value = exactObject(decoded, DLP_KEYS, "AI Gateway DLP header");
  if (value.action !== "FLAG" && value.action !== "BLOCK") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway DLP action is unsupported",
    );
  }
  if (!Array.isArray(value.findings) || value.findings.length < 1 || value.findings.length > 64) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway DLP findings are invalid",
    );
  }
  validateBoundedJson(value.findings, 0, {
    members: 0,
    ancestors: new WeakSet(),
  });
  return value.action;
}

function decodeUsage(raw: unknown): ModelGatewayUsageObservation {
  const usage = exactObject(raw, USAGE_KEYS, "AI Gateway response usage");
  const inputTokens = nonnegativeInteger(
    usage.prompt_tokens,
    "AI Gateway response usage.prompt_tokens",
  );
  const outputTokens = nonnegativeInteger(
    usage.completion_tokens,
    "AI Gateway response usage.completion_tokens",
  );
  const totalTokens = nonnegativeInteger(
    usage.total_tokens,
    "AI Gateway response usage.total_tokens",
  );
  if (inputTokens + outputTokens !== totalTokens) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response token totals do not reconcile",
    );
  }
  for (const [key, value] of [
    ["prompt_tokens_details", usage.prompt_tokens_details],
    ["completion_tokens_details", usage.completion_tokens_details],
  ] as const) {
    if (value !== undefined && value !== null) {
      validateBoundedJson(value, 0, {
        members: 0,
        ancestors: new WeakSet(),
      });
      if (plainObject(value) === null) {
        modelGatewayExecutionFailure(
          "MODEL_GATEWAY_RESPONSE_INVALID",
          `AI Gateway response usage.${key} must be an object`,
        );
      }
    }
  }
  return Object.freeze({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  });
}

function decodeAssistantContent(rawChoices: unknown): string {
  if (!Array.isArray(rawChoices) || rawChoices.length !== 1) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response must contain exactly one choice",
    );
  }
  const choice = exactObject(rawChoices[0], CHOICE_KEYS, "AI Gateway response choice");
  if (choice.index !== 0) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response choice index must be zero",
    );
  }
  if (choice.finish_reason === "length") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_OUTPUT_TRUNCATED",
      "AI Gateway response reached the model output limit",
    );
  }
  if (choice.finish_reason === "content_filter") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_POLICY_REJECTED",
      "AI Gateway provider content policy filtered the model output",
    );
  }
  if (choice.finish_reason !== "stop") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response did not finish with stop",
    );
  }
  if (choice.logprobs !== undefined && choice.logprobs !== null) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response logprobs were not requested",
    );
  }
  const message = exactObject(
    choice.message,
    MESSAGE_KEYS,
    "AI Gateway response choice.message",
  );
  if (message.role !== "assistant") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response role must be assistant",
    );
  }
  if (message.refusal !== undefined && message.refusal !== null) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_POLICY_REJECTED",
      "AI Gateway response contains a provider refusal",
    );
  }
  if (
    message.annotations !== undefined &&
    (!Array.isArray(message.annotations) || message.annotations.length !== 0)
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response contains unsupported annotations",
    );
  }
  return boundedString(message.content, "AI Gateway response assistant content");
}

function decodeFingerprint(
  headers: Headers,
  deployment: ModelRouteDeployment,
): RouteFingerprint {
  try {
    return decodeDynamicRouteFingerprint(headers, deployment);
  } catch (cause) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response does not contain a valid dynamic-route fingerprint",
      { cause },
    );
  }
}

function possibleErrorCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^(0|[1-9][0-9]{0,9})$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

function collectErrorCodes(raw: unknown): ReadonlySet<number> {
  const codes = new Set<number>();
  const root = plainObject(raw);
  if (root === null) return codes;
  const direct = possibleErrorCode(root.code);
  if (direct !== undefined) codes.add(direct);
  const error = plainObject(root.error);
  const errorCode = possibleErrorCode(error?.code);
  if (errorCode !== undefined) codes.add(errorCode);
  if (Array.isArray(root.errors) && root.errors.length <= 32) {
    for (const entry of root.errors) {
      const record = plainObject(entry);
      const code = possibleErrorCode(record?.code);
      if (code !== undefined) codes.add(code);
    }
  }
  return codes;
}

export async function rejectModelGatewayHttpFailure(
  response: Response,
): Promise<never> {
  const dlpAction = decodeDlpAction(response.headers);
  const bytes = await readBoundedBody(response, MAX_ERROR_BODY_BYTES, false);
  let raw: unknown;
  if (bytes.byteLength > 0) {
    try {
      raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      validateBoundedJson(raw, 0, {
        members: 0,
        ancestors: new WeakSet(),
      });
    } catch (cause) {
      if (cause instanceof ModelGatewayExecutionError) throw cause;
      raw = undefined;
    }
  }
  const codes = collectErrorCodes(raw);
  if (
    dlpAction !== undefined ||
    [...codes].some((code) => POLICY_ERROR_CODES.has(code))
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_POLICY_REJECTED",
      "AI Gateway blocked the request or response under DLP or guardrail policy",
      { http_status: response.status },
    );
  }
  if (response.status === 401 || response.status === 403) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_AUTH_REJECTED",
      "AI Gateway rejected the authenticated request",
      { http_status: response.status },
    );
  }
  if (
    response.status === 429 ||
    [...codes].some((code) => RATE_LIMIT_ERROR_CODES.has(code))
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_LIMIT_REJECTED",
      "AI Gateway rejected the request because a rate or spend limit was reached",
      { http_status: response.status },
    );
  }
  modelGatewayExecutionFailure(
    "MODEL_GATEWAY_UPSTREAM_REJECTED",
    "AI Gateway returned a non-success status",
    { http_status: response.status },
  );
}

export async function decodeModelGatewayResponse(
  response: Response,
  deployment: ModelRouteDeployment,
  maximumBytes: number,
): Promise<DecodedModelGatewayResponse> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 256 * 1024) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "reserved output byte budget is invalid",
    );
  }
  const contentType = response.headers.get("content-type");
  if (contentType === null || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response must be application/json",
    );
  }
  const dlpAction = decodeDlpAction(response.headers);
  if (dlpAction !== undefined) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_POLICY_REJECTED",
      `AI Gateway returned a DLP ${dlpAction} observation`,
    );
  }
  const fingerprint = decodeFingerprint(response.headers, deployment);
  const logId = header(response.headers, "cf-aig-log-id", true);
  if (logId === undefined || !LOG_ID.test(logId)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway log identifier is invalid",
    );
  }
  const rawCacheStatus = header(response.headers, "cf-aig-cache-status", false);
  let cacheStatus: "MISS" | undefined;
  if (rawCacheStatus !== undefined) {
    const normalized = rawCacheStatus.toUpperCase();
    if (normalized !== "HIT" && normalized !== "MISS") {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_RESPONSE_INVALID",
        "AI Gateway cache status is unsupported",
      );
    }
    if (normalized === "HIT") {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_RESPONSE_INVALID",
        "AI Gateway returned a cache hit despite explicit cache bypass",
      );
    }
    cacheStatus = "MISS";
  }
  const successfulStep = header(response.headers, "cf-aig-step", false);
  const bodyBytes = await readBoundedBody(response, maximumBytes, true);
  let rawBody: unknown;
  try {
    rawBody = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes));
  } catch (cause) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response is not valid UTF-8 JSON",
      { cause },
    );
  }
  const body = exactObject(rawBody, RESPONSE_KEYS, "AI Gateway response");
  const responseId = boundedString(body.id, "AI Gateway response id", 256);
  if (!IDENTIFIER.test(responseId)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response id is not a bounded identifier",
    );
  }
  if (body.object !== "chat.completion") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response object is not chat.completion",
    );
  }
  nonnegativeInteger(body.created, "AI Gateway response created");
  optionalBoundedString(body.service_tier, "AI Gateway response service_tier");
  optionalBoundedString(
    body.system_fingerprint,
    "AI Gateway response system_fingerprint",
  );
  const responseModel = boundedString(body.model, "AI Gateway response model", 256);
  if (!IDENTIFIER.test(responseModel)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response model is not a bounded model identifier",
    );
  }
  const assistantContent = decodeAssistantContent(body.choices);
  const usage = decodeUsage(body.usage);
  return Object.freeze({
    body_bytes: bodyBytes,
    body_sha256: await modelGatewaySha256(bodyBytes),
    assistant_content: assistantContent,
    response_model: responseModel,
    usage,
    fingerprint,
    log_id: logId,
    ...(cacheStatus === undefined ? {} : { cache_status: cacheStatus }),
    ...(successfulStep === undefined ? {} : { successful_step: successfulStep }),
  });
}
