import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import { modelGatewayExecutionFailure } from "./model-gateway-execution-contract.js";

const JSON_BODY_KEYS = new Set([
  "max_tokens",
  "messages",
  "model",
  "response_format",
  "seed",
  "stop",
  "stream",
  "temperature",
  "top_p",
]);
const PARAMETER_KEYS = Object.freeze([
  "max_tokens",
  "response_format",
  "seed",
  "stop",
  "stream",
  "temperature",
  "top_p",
] as const);
const MESSAGE_KEYS = new Set(["content", "role"]);
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_MESSAGES = 128;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_MEMBERS = 4096;
const MAX_STRING_BYTES = 192 * 1024;

function exactObject(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      `${label} must be a plain object`,
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      `${label} must be a plain object`,
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_REQUEST_INVALID",
        `${label} contains unsupported field ${key}`,
      );
    }
  }
  return record;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedText(
  value: unknown,
  label: string,
  maximum = MAX_STRING_BYTES,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    utf8Bytes(value) > maximum ||
    /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      `${label} is invalid`,
    );
  }
  return value;
}

function safeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      `${label} is outside its allowed range`,
    );
  }
  return value;
}

function unitInterval(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      `${label} must be a finite number in [0, 1]`,
    );
  }
  return value;
}

function temperature(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 2
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model request temperature must be a finite number in [0, 2]",
    );
  }
  return value;
}

function validateMessages(raw: unknown): void {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > MAX_MESSAGES) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      `model request messages must contain 2-${MAX_MESSAGES} entries`,
    );
  }
  let userMessages = 0;
  raw.forEach((rawMessage, index) => {
    const message = exactObject(
      rawMessage,
      MESSAGE_KEYS,
      `model request messages[${index}]`,
    );
    if (
      message.role !== "system" &&
      message.role !== "user" &&
      message.role !== "assistant"
    ) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_REQUEST_INVALID",
        `model request messages[${index}].role is unsupported`,
      );
    }
    if (index === 0 && message.role !== "system") {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_REQUEST_INVALID",
        "model request must begin with trusted system instructions",
      );
    }
    if (message.role === "user") userMessages += 1;
    boundedText(message.content, `model request messages[${index}].content`);
  });
  if (userMessages < 1) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model request must contain at least one user message",
    );
  }
}

function validateStop(raw: unknown): void {
  if (raw === undefined) return;
  if (typeof raw === "string") {
    boundedText(raw, "model request stop", 1024);
    return;
  }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model request stop must be one string or 1-4 strings",
    );
  }
  raw.forEach((value, index) =>
    boundedText(value, `model request stop[${index}]`, 1024),
  );
}

interface JsonValidationState {
  members: number;
  readonly ancestors: WeakSet<object>;
}

function validateJsonTree(
  value: unknown,
  depth: number,
  state: JsonValidationState,
): void {
  if (depth > MAX_JSON_DEPTH) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model request response_format exceeds the JSON depth bound",
    );
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    if (typeof value === "string" && utf8Bytes(value) > MAX_STRING_BYTES) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_REQUEST_INVALID",
        "model request response_format contains an oversized string",
      );
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_REQUEST_INVALID",
        "model request response_format contains a non-finite number",
      );
    }
    return;
  }
  if (typeof value !== "object" || value === undefined) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model request response_format contains a non-JSON value",
    );
  }
  if (state.ancestors.has(value)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model request response_format contains a cycle",
    );
  }
  state.ancestors.add(value);
  if (Array.isArray(value)) {
    state.members += value.length;
    if (state.members > MAX_JSON_MEMBERS) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_REQUEST_INVALID",
        "model request response_format exceeds the member bound",
      );
    }
    value.forEach((entry) => validateJsonTree(entry, depth + 1, state));
    state.ancestors.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model request response_format must contain plain JSON objects",
    );
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  state.members += keys.length;
  if (state.members > MAX_JSON_MEMBERS) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model request response_format exceeds the member bound",
    );
  }
  keys.forEach((key) => {
    boundedText(key, "model request response_format key", 256);
    validateJsonTree(record[key], depth + 1, state);
  });
  state.ancestors.delete(value);
}

function canonicalJson(value: unknown, ancestors: WeakSet<object>): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_REQUEST_INVALID",
        "canonical model request contains an unsupported primitive",
      );
    }
    return encoded;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_REQUEST_INVALID",
        "canonical model request contains a non-finite number",
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "canonical model request contains a non-JSON value",
    );
  }
  if (ancestors.has(value)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "canonical model request contains a cycle",
    );
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    const encoded = `[${value
      .map((entry) => canonicalJson(entry, ancestors))
      .join(",")}]`;
    ancestors.delete(value);
    return encoded;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "canonical model request contains a non-plain object",
    );
  }
  const record = value as Record<string, unknown>;
  const encoded = `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`,
    )
    .join(",")}}`;
  ancestors.delete(value);
  return encoded;
}

export function canonicalModelGatewayJson(value: unknown): string {
  return canonicalJson(value, new WeakSet());
}

export async function modelGatewaySha256(
  value: string | Uint8Array,
): Promise<string> {
  const source =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function validateRequestParameters(body: Record<string, unknown>): void {
  safeInteger(body.max_tokens, "model request max_tokens", 1, 1_000_000);
  if (body.stream !== false) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model request must disable streaming for immutable output persistence",
    );
  }
  if (body.temperature !== undefined) temperature(body.temperature);
  if (body.top_p !== undefined) unitInterval(body.top_p, "model request top_p");
  if (body.seed !== undefined) {
    safeInteger(body.seed, "model request seed", 0, Number.MAX_SAFE_INTEGER);
  }
  validateStop(body.stop);
  if (body.response_format !== undefined) {
    validateJsonTree(body.response_format, 0, {
      members: 0,
      ancestors: new WeakSet(),
    });
  }
}

function parameterProjection(
  body: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  const projection: Record<string, unknown> = {};
  for (const key of PARAMETER_KEYS) {
    if (body[key] !== undefined) projection[key] = body[key];
  }
  return Object.freeze(projection);
}

export async function modelGatewayRequestParametersSha256(
  rawBody: unknown,
): Promise<string> {
  const body = exactObject(rawBody, JSON_BODY_KEYS, "model request body");
  validateRequestParameters(body);
  return modelGatewaySha256(
    canonicalModelGatewayJson(parameterProjection(body)),
  );
}

export async function validateModelGatewayRequestBody(
  raw: unknown,
  deployment: ModelRouteDeployment,
  maximumInputBytes: number,
  maximumOutputBytes: number,
): Promise<{
  readonly body: string;
  readonly parameters_sha256: string;
}> {
  const body = exactObject(raw, JSON_BODY_KEYS, "model request body");
  if (body.model !== deployment.route_ref) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model request must address the deployed dynamic route",
    );
  }
  validateMessages(body.messages);
  validateRequestParameters(body);
  const maxTokens = safeInteger(
    body.max_tokens,
    "model request max_tokens",
    1,
    1_000_000,
  );
  if (maxTokens > maximumOutputBytes) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model request max_tokens exceeds the reserved output byte ceiling",
    );
  }
  const canonical = canonicalModelGatewayJson(body);
  const bodyBytes = utf8Bytes(canonical);
  if (bodyBytes > MAX_REQUEST_BYTES || bodyBytes > maximumInputBytes) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "canonical model request exceeds the reserved input byte budget",
    );
  }
  return Object.freeze({
    body: canonical,
    parameters_sha256: await modelGatewaySha256(
      canonicalModelGatewayJson(parameterProjection(body)),
    ),
  });
}
