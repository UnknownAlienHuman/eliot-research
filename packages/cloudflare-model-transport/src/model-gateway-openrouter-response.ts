import {
  modelGatewayExecutionFailure,
  type DecodedModelGatewayResponse,
  type ModelGatewaySafeResponseReason,
  type ModelGatewayUsageObservation,
} from "./model-gateway-execution-contract.js";

const ROOT_KEYS = new Set(["choices", "created", "id", "model", "object", "system_fingerprint", "usage"]);
const CHOICE_KEYS = new Set(["error", "finish_reason", "index", "logprobs", "message", "native_finish_reason"]);
const MESSAGE_KEYS = new Set(["content", "reasoning", "reasoning_content", "reasoning_details", "refusal", "role", "tool_calls"]);
const USAGE_KEYS = new Set([
  "completion_tokens", "completion_tokens_details", "cost", "cost_details", "is_byok",
  "prompt_tokens", "prompt_tokens_details", "server_tool_use", "total_tokens",
]);
const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_MEMBERS = 2048;

function invalid(
  message: string,
  safeResponseReason: ModelGatewaySafeResponseReason = "BODY_SHAPE_INVALID",
): never {
  modelGatewayExecutionFailure("MODEL_GATEWAY_RESPONSE_INVALID", message, {
    safe_response_reason: safeResponseReason,
  });
}

function exactObject(value: unknown, keys: ReadonlySet<string>, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    invalid(`${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!keys.has(key)) invalid(`${label} contains unsupported field ${key}`);
  return record;
}

function string(
  value: unknown,
  label: string,
  maximumBytes = 8192,
  safeResponseReason: ModelGatewaySafeResponseReason = "BODY_SHAPE_INVALID",
): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0 ||
      new TextEncoder().encode(value).byteLength > maximumBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
    invalid(`${label} is invalid`, safeResponseReason);
  }
  return value;
}

function tokenCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(`${label} is invalid`);
  return value;
}

function cost(value: unknown, label: string, nullable = false): void {
  if (nullable && value === null) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(`${label} is invalid`);
}

function boundedJson(value: unknown, depth = 0, state = { members: 0 }): void {
  if (depth > MAX_JSON_DEPTH) invalid("OpenRouter response JSON is excessively deep");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("OpenRouter response JSON contains a non-finite number");
    return;
  }
  if (Array.isArray(value)) {
    state.members += value.length;
    if (state.members > MAX_JSON_MEMBERS) invalid("OpenRouter response JSON exceeds the member bound");
    for (const item of value) boundedJson(item, depth + 1, state);
    return;
  }
  if (typeof value !== "object") invalid("OpenRouter response contains a non-JSON value");
  const entries = Object.entries(value as Record<string, unknown>);
  state.members += entries.length;
  if (state.members > MAX_JSON_MEMBERS) invalid("OpenRouter response JSON exceeds the member bound");
  for (const [, item] of entries) boundedJson(item, depth + 1, state);
}

function tokenDetails(value: unknown, keys: ReadonlySet<string>, label: string): void {
  if (value === undefined) return;
  const details = exactObject(value, keys, label);
  for (const [key, count] of Object.entries(details)) tokenCount(count, `${label}.${key}`);
}

function usage(raw: unknown): ModelGatewayUsageObservation {
  const value = exactObject(raw, USAGE_KEYS, "OpenRouter usage");
  const input = tokenCount(value.prompt_tokens, "OpenRouter prompt_tokens");
  const output = tokenCount(value.completion_tokens, "OpenRouter completion_tokens");
  const total = tokenCount(value.total_tokens, "OpenRouter total_tokens");
  if (input + output !== total) invalid("OpenRouter token totals do not reconcile");
  tokenDetails(value.prompt_tokens_details,
    new Set(["audio_tokens", "cache_write_tokens", "cached_tokens", "video_tokens"]), "OpenRouter prompt token details");
  tokenDetails(value.completion_tokens_details,
    new Set(["audio_tokens", "image_tokens", "reasoning_tokens"]), "OpenRouter completion token details");
  if (value.cost !== undefined) cost(value.cost, "OpenRouter usage cost");
  if (value.is_byok !== undefined && typeof value.is_byok !== "boolean") invalid("OpenRouter is_byok is invalid");
  if (value.cost_details !== undefined) {
    const details = exactObject(value.cost_details,
      new Set(["server_tool_cost", "upstream_inference_completions_cost", "upstream_inference_cost", "upstream_inference_prompt_cost"]),
      "OpenRouter cost details");
    if (details.upstream_inference_prompt_cost === undefined || details.upstream_inference_completions_cost === undefined) {
      invalid("OpenRouter cost details are incomplete");
    }
    if (details.upstream_inference_cost !== undefined) cost(details.upstream_inference_cost, "OpenRouter upstream inference cost", true);
    cost(details.upstream_inference_prompt_cost, "OpenRouter upstream prompt cost");
    cost(details.upstream_inference_completions_cost, "OpenRouter upstream completion cost");
    if (details.server_tool_cost !== undefined) {
      cost(details.server_tool_cost, "OpenRouter server tool cost", true);
      if (details.server_tool_cost !== null && details.server_tool_cost !== 0) invalid("OpenRouter reports unrequested server-tool cost");
    }
  }
  if (value.server_tool_use !== undefined) {
    const tools = exactObject(value.server_tool_use, new Set(["web_search_requests"]), "OpenRouter server tool usage");
    for (const [key, count] of Object.entries(tools)) {
      if (tokenCount(count, `OpenRouter server tool usage.${key}`) !== 0) invalid("OpenRouter reports unrequested server-tool usage");
    }
  }
  return Object.freeze({ input_tokens: input, output_tokens: output, total_tokens: total });
}

/** Decode OpenRouter's documented Chat response while keeping its raw bytes authoritative. */
export function decodeModelGatewayOpenRouterBody(
  raw: unknown,
  bodyBytes: Uint8Array,
): Omit<DecodedModelGatewayResponse, "fingerprint" | "log_id"> {
  if (bodyBytes.byteLength < 1) invalid("OpenRouter response body is empty");
  if (bodyBytes.byteLength > MAX_BODY_BYTES) invalid("OpenRouter response body exceeds its byte bound", "BODY_TOO_LARGE");
  const body = exactObject(raw, ROOT_KEYS, "OpenRouter Chat response");
  if (body.object !== "chat.completion") invalid("OpenRouter response is not a non-streaming Chat completion");
  const id = string(body.id, "OpenRouter response id");
  if (!IDENTIFIER.test(id)) invalid("OpenRouter response id is not a bounded identifier");
  if (typeof body.created !== "number" || !Number.isSafeInteger(body.created) || body.created < 0) invalid("OpenRouter created is invalid");
  const responseModel = string(body.model, "OpenRouter response model", 8192, "MODEL_ID_INVALID");
  if (!IDENTIFIER.test(responseModel)) invalid("OpenRouter response model is not a bounded identifier", "MODEL_ID_INVALID");
  if (body.system_fingerprint !== undefined) string(body.system_fingerprint, "OpenRouter system fingerprint");
  if (!Array.isArray(body.choices) || body.choices.length !== 1) invalid("OpenRouter response must contain exactly one choice");
  const choice = exactObject(body.choices[0], CHOICE_KEYS, "OpenRouter response choice");
  if (choice.index !== 0) invalid("OpenRouter response choice index must be zero");
  if (choice.error !== undefined && choice.error !== null) {
    boundedJson(choice.error);
    modelGatewayExecutionFailure("MODEL_GATEWAY_RESPONSE_INVALID", "OpenRouter response choice contains an error");
  }
  if (choice.native_finish_reason !== undefined && choice.native_finish_reason !== null) {
    string(choice.native_finish_reason, "OpenRouter native finish reason");
  }
  if (choice.finish_reason === "length") modelGatewayExecutionFailure("MODEL_GATEWAY_OUTPUT_TRUNCATED", "OpenRouter response reached the output limit");
  if (choice.finish_reason === "content_filter") modelGatewayExecutionFailure("MODEL_GATEWAY_POLICY_REJECTED", "OpenRouter filtered the model output");
  if (choice.finish_reason !== "stop") invalid("OpenRouter response did not finish with stop");
  if (choice.logprobs !== undefined && choice.logprobs !== null) invalid("OpenRouter returned unrequested logprobs");
  const message = exactObject(choice.message, MESSAGE_KEYS, "OpenRouter assistant message");
  if (message.role !== "assistant") invalid("OpenRouter response role is not assistant");
  if (message.tool_calls !== undefined) invalid("OpenRouter returned unrequested tool calls");
  if (message.refusal !== undefined && message.refusal !== null) {
    modelGatewayExecutionFailure("MODEL_GATEWAY_POLICY_REJECTED", "OpenRouter response contains a refusal");
  }
  for (const field of ["reasoning", "reasoning_content"] as const) {
    if (message[field] !== undefined && message[field] !== null) {
      const hidden = message[field];
      if (typeof hidden !== "string" || new TextEncoder().encode(hidden).byteLength > MAX_BODY_BYTES) invalid(`OpenRouter ${field} is invalid`);
    }
  }
  if (message.reasoning_details !== undefined && message.reasoning_details !== null) boundedJson(message.reasoning_details);
  const content = string(message.content, "OpenRouter assistant content", MAX_BODY_BYTES);
  return Object.freeze({
    body_bytes: bodyBytes,
    body_sha256: "",
    assistant_content: content,
    response_model: responseModel,
    usage: usage(body.usage),
  });
}
