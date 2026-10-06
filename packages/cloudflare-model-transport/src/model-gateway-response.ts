import {
  decodeDynamicRouteFingerprint,
  type ModelRouteDeployment,
  type RouteFingerprint,
} from "@eliotr/platform-cloudflare";
import {
  ModelGatewayExecutionError,
  modelGatewayExecutionFailure,
  type DecodedModelGatewayResponse,
} from "./model-gateway-execution-contract.js";
import {
  decodeModelGatewayProviderBody as decodeModelGatewayBody,
  decodeModelGatewayProviderNativeResponse,
} from "./model-gateway-provider-native-response.js";
import type { ModelGatewayTransportPolicyV1 } from "./model-gateway-transport-policy.js";

export { decodeModelGatewayProviderBody as decodeModelGatewayBody } from "./model-gateway-provider-native-response.js";

const DLP_KEYS = new Set(["action", "findings"]);
const LOG_ID = /^[A-Za-z0-9._:@/-]{1,256}$/u;
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

export function plainObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  return value as Record<string, unknown>;
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

export async function readBoundedBody(
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
        { safe_response_reason: "BODY_SHAPE_INVALID" },
      );
    }
    const declaredLength = Number(rawLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maximumBytes) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_RESPONSE_INVALID",
        "AI Gateway response exceeds its byte budget",
        { safe_response_reason: "BODY_TOO_LARGE" },
      );
    }
  }
  if (response.body === null) {
    if (requireNonEmpty) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_RESPONSE_INVALID",
        "AI Gateway response body is missing",
        { safe_response_reason: "BODY_SHAPE_INVALID" },
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
          { safe_response_reason: "BODY_TOO_LARGE" },
        );
      }
      chunks.push(next.value);
    }
  } catch (cause) {
    if (cause instanceof ModelGatewayExecutionError) throw cause;
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response body could not be read",
      { cause, safe_response_reason: "BODY_SHAPE_INVALID" },
    );
  }
  if (requireNonEmpty && length < 1) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response body is empty",
        { safe_response_reason: "BODY_SHAPE_INVALID" },
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

export function validateBoundedJson(value: unknown, depth: number, state: JsonState): void {
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

export function decodeDlpAction(headers: Headers): "FLAG" | "BLOCK" | undefined {
  const raw = header(headers, "cf-aig-dlp", false);
  if (raw === undefined) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (cause) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway DLP header is not valid JSON",
      { cause, safe_response_reason: "BODY_JSON_INVALID" },
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
      { safe_response_reason: "CONTENT_TYPE_INVALID" },
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
      { safe_response_reason: "LOG_ID_INVALID" },
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
        { safe_response_reason: "CACHE_INVALID" },
      );
    }
    if (normalized === "HIT") {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_RESPONSE_INVALID",
        "AI Gateway returned a cache hit despite explicit cache bypass",
        { safe_response_reason: "CACHE_INVALID" },
      );
    }
    cacheStatus = "MISS";
  }
  const successfulStep = header(response.headers, "cf-aig-step", false);
  const bodyBytes = await readBoundedBody(response, maximumBytes, true);
  const decodedBody = await decodeModelGatewayBody(bodyBytes);
  return Object.freeze({
    ...decodedBody,
    fingerprint,
    log_id: logId,
    ...(cacheStatus === undefined ? {} : { cache_status: cacheStatus }),
    ...(successfulStep === undefined ? {} : { successful_step: successfulStep }),
  });
}

export async function decodeSelectedModelGatewayResponse(
  response: Response,
  deployment: ModelRouteDeployment,
  maximumBytes: number,
  transportPolicy?: ModelGatewayTransportPolicyV1,
): Promise<DecodedModelGatewayResponse> {
  return transportPolicy !== undefined && transportPolicy.api !== "compat-chat-completions"
    ? decodeModelGatewayProviderNativeResponse(response, deployment, maximumBytes, transportPolicy)
    : decodeModelGatewayResponse(response, deployment, maximumBytes);
}
