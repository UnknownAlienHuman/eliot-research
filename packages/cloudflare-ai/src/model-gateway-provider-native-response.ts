import type { ModelRouteDeployment, RouteFingerprint } from "@eliotr/platform-cloudflare";
import {
  ModelGatewayExecutionError,
  modelGatewayExecutionFailure,
  type DecodedModelGatewayResponse,
  type ModelGatewayUsageObservation,
} from "./model-gateway-execution-contract.js";
import type { ModelGatewayApi, ModelGatewayTransportPolicyV1 } from "./model-gateway-transport-policy.js";
import { modelGatewaySha256 } from "./model-gateway-request.js";
import { decodeModelGatewayOpenRouterBody } from "./model-gateway-openrouter-response.js";

const CHAT_RESPONSE_KEYS = new Set(["choices", "created", "id", "model", "object", "service_tier", "system_fingerprint", "usage"]);
const CHAT_CHOICE_KEYS = new Set(["finish_reason", "index", "logprobs", "message"]);
const CHAT_MESSAGE_KEYS = new Set(["annotations", "content", "reasoning_content", "refusal", "role"]);
const CHAT_USAGE_KEYS = new Set(["completion_tokens", "completion_tokens_details", "neurons", "prompt_tokens", "prompt_tokens_details", "total_tokens"]);
const RESPONSES_KEYS = new Set([
  "background", "billing", "completed_at", "created_at", "error", "frequency_penalty", "id", "incomplete_details",
  "instructions", "max_output_tokens", "max_tool_calls", "metadata", "model", "object", "output", "parallel_tool_calls",
  "presence_penalty", "previous_response_id", "prompt_cache_key", "prompt_cache_retention", "reasoning", "safety_identifier",
  "service_tier", "status", "temperature", "text", "tool_choice", "tools", "top_logprobs", "top_p", "truncation", "usage", "user",
]);
const RESPONSES_USAGE_KEYS = new Set(["input_tokens", "input_tokens_details", "output_tokens", "output_tokens_details", "total_tokens"]);
const ANTHROPIC_RESPONSE_KEYS = new Set([
  "content", "context_management", "container", "id", "model", "role", "service_tier", "stop_details", "stop_reason", "stop_sequence", "type", "usage",
]);
const ANTHROPIC_USAGE_KEYS = new Set([
  "cache_creation", "cache_creation_input_tokens", "cache_read_input_tokens", "input_tokens", "output_tokens", "server_tool_use", "service_tier",
]);
const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_MEMBERS = 2048;

function invalid(message: string): never {
  modelGatewayExecutionFailure("MODEL_GATEWAY_RESPONSE_INVALID", message);
}

function exactObject(value: unknown, allowed: ReadonlySet<string>, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    invalid(`${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!allowed.has(key)) invalid(`${label} contains unsupported field ${key}`);
  return record;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}

function boundedJson(value: unknown, depth = 0, state = { members: 0 }): void {
  if (depth > MAX_JSON_DEPTH) invalid("provider response JSON is excessively deep");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("provider response JSON contains a non-finite number");
    return;
  }
  if (Array.isArray(value)) {
    state.members += value.length;
    if (state.members > MAX_JSON_MEMBERS) invalid("provider response JSON exceeds the member bound");
    for (const entry of value) boundedJson(entry, depth + 1, state);
    return;
  }
  if (typeof value !== "object") invalid("provider response contains a non-JSON value");
  const entries = Object.entries(value as Record<string, unknown>);
  state.members += entries.length;
  if (state.members > MAX_JSON_MEMBERS) invalid("provider response JSON exceeds the member bound");
  for (const [, entry] of entries) boundedJson(entry, depth + 1, state);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || new TextEncoder().encode(value).byteLength > 256 * 1024 ||
      /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) invalid(`${label} is invalid`);
  return value;
}

function legacyBoundedString(value: unknown, label: string, maximumBytes = 256 * 1024): string {
  if (typeof value !== "string" || value.length < 1 || value.trim().length < 1 ||
      new TextEncoder().encode(value).byteLength > maximumBytes ||
      /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) invalid(`${label} is invalid`);
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.trim().length < 1 ||
      new TextEncoder().encode(value).byteLength > 256 || /[\u0000-\u001f\u007f]/u.test(value) ||
      !IDENTIFIER.test(value)) invalid(`${label} is not a bounded identifier`);
  const result = value;
  return result;
}

function legacyOptionalString(value: unknown, label: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || value.length < 1 || value.trim().length < 1 ||
      new TextEncoder().encode(value).byteLength > 1024 ||
      /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) invalid(`${label} is invalid`);
}

function tokenCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(`${label} is invalid`);
  return value;
}

function usage(input: number, output: number): ModelGatewayUsageObservation {
  return Object.freeze({ input_tokens: input, output_tokens: output, total_tokens: input + output });
}

function hasOpenRouterResponseFields(body: Record<string, unknown>): boolean {
  const rawUsage = plainRecord(body.usage);
  const choice = Array.isArray(body.choices) && body.choices.length === 1 ? plainRecord(body.choices[0]) : null;
  const message = plainRecord(choice?.message);
  return choice?.native_finish_reason !== undefined || rawUsage?.cost !== undefined ||
    rawUsage?.cost_details !== undefined || rawUsage?.is_byok !== undefined || rawUsage?.server_tool_use !== undefined ||
    message?.reasoning !== undefined || message?.reasoning_content !== undefined || message?.reasoning_details !== undefined;
}

function decodeChatBody(body: Record<string, unknown>, bodyBytes: Uint8Array): Omit<DecodedModelGatewayResponse, "fingerprint" | "log_id"> {
  if (body.object !== "chat.completion") invalid("AI Gateway response object is not chat.completion");
  identifier(body.id, "chat response id");
  tokenCount(body.created, "chat response created");
  legacyOptionalString(body.service_tier, "chat response service_tier");
  legacyOptionalString(body.system_fingerprint, "chat response system_fingerprint");
  const responseModel = identifier(body.model, "chat response model");
  if (!Array.isArray(body.choices) || body.choices.length !== 1) invalid("chat response must contain exactly one choice");
  const choice = exactObject(body.choices[0], CHAT_CHOICE_KEYS, "chat response choice");
  if (choice.index !== 0) invalid("chat response choice index must be zero");
  if (choice.finish_reason === "length") modelGatewayExecutionFailure("MODEL_GATEWAY_OUTPUT_TRUNCATED", "provider response reached the model output limit");
  if (choice.finish_reason === "content_filter") modelGatewayExecutionFailure("MODEL_GATEWAY_POLICY_REJECTED", "provider content policy filtered the model output");
  if (choice.finish_reason !== "stop") invalid("chat response did not finish with stop");
  if (choice.logprobs !== undefined && choice.logprobs !== null) invalid("chat response contains unrequested logprobs");
  const message = exactObject(choice.message, CHAT_MESSAGE_KEYS, "chat response message");
  if (message.role !== "assistant") invalid("chat response role is not assistant");
  if (message.refusal !== undefined && message.refusal !== null) modelGatewayExecutionFailure("MODEL_GATEWAY_POLICY_REJECTED", "provider response contains a refusal");
  if (message.annotations !== undefined && (!Array.isArray(message.annotations) || message.annotations.length !== 0)) invalid("chat response contains unsupported annotations");
  if (message.reasoning_content !== undefined && message.reasoning_content !== null &&
      (typeof message.reasoning_content !== "string" || new TextEncoder().encode(message.reasoning_content).byteLength > 256 * 1024)) {
    invalid("chat reasoning content is invalid");
  }
  const content = legacyBoundedString(message.content, "chat response assistant content");
  const rawUsage = exactObject(body.usage, CHAT_USAGE_KEYS, "chat response usage");
  const inputTokens = tokenCount(rawUsage.prompt_tokens, "chat input tokens");
  const outputTokens = tokenCount(rawUsage.completion_tokens, "chat output tokens");
  const totalTokens = tokenCount(rawUsage.total_tokens, "chat total tokens");
  if (inputTokens + outputTokens !== totalTokens) invalid("chat response token totals do not reconcile");
  if (rawUsage.neurons !== undefined && (typeof rawUsage.neurons !== "number" || !Number.isFinite(rawUsage.neurons) || rawUsage.neurons < 0)) invalid("chat response neurons are invalid");
  for (const detail of [rawUsage.prompt_tokens_details, rawUsage.completion_tokens_details]) {
    if (detail === undefined || detail === null) continue;
    boundedJson(detail);
    if (typeof detail !== "object" || Array.isArray(detail)) invalid("chat response usage details must be objects");
  }
  return Object.freeze({ body_bytes: bodyBytes, body_sha256: "", assistant_content: content, response_model: responseModel, usage: usage(inputTokens, outputTokens) });
}

function decodeResponsesBody(body: Record<string, unknown>, bodyBytes: Uint8Array): Omit<DecodedModelGatewayResponse, "fingerprint" | "log_id"> {
  if (body.object !== "response" || body.status !== "completed" || (body.error !== null && body.error !== undefined)) invalid("OpenAI Responses result is not a completed successful response");
  identifier(body.id, "OpenAI Responses id");
  tokenCount(body.created_at, "OpenAI Responses created_at");
  const responseModel = identifier(body.model, "OpenAI Responses model");
  if (body.incomplete_details !== null && body.incomplete_details !== undefined) modelGatewayExecutionFailure("MODEL_GATEWAY_OUTPUT_TRUNCATED", "OpenAI Responses output is incomplete");
  if (!Array.isArray(body.output) || body.output.length < 1 || body.output.length > 3) invalid("OpenAI Responses output is invalid");
  let messageCount = 0;
  const content: string[] = [];
  for (const [index, rawItem] of body.output.entries()) {
    const item = exactObject(rawItem, new Set(["content", "encrypted_content", "id", "role", "status", "summary", "type"]), `OpenAI Responses output[${index}]`);
    if (item.type === "reasoning") {
      if (item.summary !== undefined) boundedJson(item.summary);
      continue;
    }
    if (item.type !== "message" || item.role !== "assistant" || item.status !== "completed" || !Array.isArray(item.content)) invalid("OpenAI Responses contains an unsupported output item");
    messageCount++;
    for (const [contentIndex, rawContent] of item.content.entries()) {
      const block = exactObject(rawContent, new Set(["annotations", "refusal", "text", "type"]), `OpenAI Responses content[${contentIndex}]`);
      if (block.type === "refusal") {
        text(block.refusal, "OpenAI Responses refusal");
        modelGatewayExecutionFailure("MODEL_GATEWAY_POLICY_REJECTED", "OpenAI Responses contains a refusal");
      }
      if (block.type !== "output_text") invalid("OpenAI Responses contains unsupported assistant content");
      if (block.annotations !== undefined) boundedJson(block.annotations);
      content.push(text(block.text, "OpenAI Responses output text"));
    }
  }
  if (messageCount !== 1 || content.length === 0) invalid("OpenAI Responses must contain one text message");
  const rawUsage = exactObject(body.usage, RESPONSES_USAGE_KEYS, "OpenAI Responses usage");
  const inputTokens = tokenCount(rawUsage.input_tokens, "OpenAI Responses input tokens");
  const outputTokens = tokenCount(rawUsage.output_tokens, "OpenAI Responses output tokens");
  const totalTokens = tokenCount(rawUsage.total_tokens, "OpenAI Responses total tokens");
  if (inputTokens + outputTokens !== totalTokens) invalid("OpenAI Responses token totals do not reconcile");
  if (rawUsage.input_tokens_details !== undefined) boundedJson(rawUsage.input_tokens_details);
  if (rawUsage.output_tokens_details !== undefined) boundedJson(rawUsage.output_tokens_details);
  return Object.freeze({ body_bytes: bodyBytes, body_sha256: "", assistant_content: content.join(""), response_model: responseModel, usage: usage(inputTokens, outputTokens) });
}

function decodeAnthropicBody(body: Record<string, unknown>, bodyBytes: Uint8Array): Omit<DecodedModelGatewayResponse, "fingerprint" | "log_id"> {
  if (body.type !== "message" || body.role !== "assistant") invalid("Anthropic response is not an assistant message");
  const responseModel = identifier(body.model, "Anthropic response model");
  identifier(body.id, "Anthropic response id");
  if (body.stop_reason === "max_tokens") modelGatewayExecutionFailure("MODEL_GATEWAY_OUTPUT_TRUNCATED", "Anthropic response reached max_tokens");
  if (body.stop_reason === "refusal") modelGatewayExecutionFailure("MODEL_GATEWAY_POLICY_REJECTED", "Anthropic response contains a refusal");
  if (body.stop_reason !== "end_turn" && body.stop_reason !== "stop_sequence") invalid("Anthropic response did not complete as a text answer");
  if (!Array.isArray(body.content) || body.content.length < 1 || body.content.length > 64) invalid("Anthropic response content is invalid");
  const content: string[] = [];
  for (const [index, rawBlock] of body.content.entries()) {
    const block = exactObject(rawBlock, new Set(["data", "signature", "text", "thinking", "type"]), `Anthropic content[${index}]`);
    if (block.type === "text") content.push(text(block.text, "Anthropic response text"));
    else if (block.type === "thinking") {
      text(block.thinking, "Anthropic thinking block");
      if (block.signature !== undefined) text(block.signature, "Anthropic thinking signature");
    } else if (block.type === "redacted_thinking") {
      text(block.data, "Anthropic redacted thinking block");
    } else invalid("Anthropic response contains unsupported assistant content");
  }
  const rawUsage = exactObject(body.usage, ANTHROPIC_USAGE_KEYS, "Anthropic response usage");
  const inputTokens = tokenCount(rawUsage.input_tokens, "Anthropic input tokens");
  const outputTokens = tokenCount(rawUsage.output_tokens, "Anthropic output tokens");
  for (const key of ["cache_creation_input_tokens", "cache_read_input_tokens"] as const) {
    if (rawUsage[key] !== undefined && tokenCount(rawUsage[key], `Anthropic ${key}`) !== 0) {
      invalid("Anthropic response reports unrequested cached input usage");
    }
  }
  if (rawUsage.cache_creation !== undefined && rawUsage.cache_creation !== null &&
      Object.values(exactObject(rawUsage.cache_creation, new Set(["ephemeral_1h_input_tokens", "ephemeral_5m_input_tokens"]), "Anthropic cache creation usage")).some((value) => value !== 0)) {
    invalid("Anthropic response reports unrequested cache creation usage");
  }
  if (rawUsage.server_tool_use !== undefined) {
    const toolUse = exactObject(rawUsage.server_tool_use, new Set(["bash_code_execution_requests", "code_execution_requests", "web_fetch_requests", "web_search_requests"]), "Anthropic server tool usage");
    if (Object.values(toolUse).some((value) => value !== 0)) invalid("Anthropic response reports unrequested server-tool usage");
  }
  if (rawUsage.service_tier !== undefined) text(rawUsage.service_tier, "Anthropic usage service_tier");
  return Object.freeze({ body_bytes: bodyBytes, body_sha256: "", assistant_content: content.join(""), response_model: responseModel, usage: usage(inputTokens, outputTokens) });
}

/** Decode stored provider-native bodies without rewriting their immutable bytes. */
export async function decodeModelGatewayProviderBody(
  bodyBytes: Uint8Array,
  expectedApi?: ModelGatewayApi,
): Promise<Omit<DecodedModelGatewayResponse, "fingerprint" | "log_id" | "cache_status" | "successful_step">> {
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes)) as unknown; }
  catch (cause) { modelGatewayExecutionFailure("MODEL_GATEWAY_RESPONSE_INVALID", "provider response is not valid UTF-8 JSON", { cause }); }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) invalid("provider response must be a plain object");
  const record = raw as Record<string, unknown>;
  let decoded: Omit<DecodedModelGatewayResponse, "fingerprint" | "log_id">;
  if (record.object === "chat.completion" && (expectedApi === "openrouter-chat-completions" ||
      (expectedApi === undefined && hasOpenRouterResponseFields(record)))) {
    decoded = decodeModelGatewayOpenRouterBody(record, bodyBytes);
  } else if (record.object === "chat.completion" && (expectedApi === undefined || expectedApi === "compat-chat-completions" || expectedApi === "openai-chat-completions")) {
    decoded = decodeChatBody(exactObject(record, CHAT_RESPONSE_KEYS, "chat response"), bodyBytes);
  } else if (record.object === "response" && (expectedApi === undefined || expectedApi === "openai-responses")) {
    boundedJson(raw);
    decoded = decodeResponsesBody(exactObject(record, RESPONSES_KEYS, "OpenAI Responses"), bodyBytes);
  } else if (record.type === "message" && (expectedApi === undefined || expectedApi === "anthropic-messages")) {
    boundedJson(raw);
    decoded = decodeAnthropicBody(exactObject(record, ANTHROPIC_RESPONSE_KEYS, "Anthropic response"), bodyBytes);
  }
  else invalid("provider response format is unsupported");
  return Object.freeze({ ...decoded, body_sha256: await modelGatewaySha256(bodyBytes) });
}

function header(headers: Headers, name: string, required: boolean): string | undefined {
  const value = headers.get(name);
  if (value === null) {
    if (required) invalid(`AI Gateway response is missing ${name}`);
    return undefined;
  }
  if (value.length < 1 || value.length > 8192 || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`AI Gateway response header ${name} is invalid`);
  return value;
}

function assertResponseHeaders(response: Response, policy: ModelGatewayTransportPolicyV1): { logId: string; cacheStatus?: "MISS"; successfulStep?: string } {
  const contentType = response.headers.get("content-type");
  if (contentType === null || !/^application\/json(?:\s*;|$)/iu.test(contentType)) invalid("provider response must be application/json");
  const dlp = header(response.headers, "cf-aig-dlp", false);
  if (dlp !== undefined) {
    let value: unknown;
    try { value = JSON.parse(dlp) as unknown; } catch (cause) { modelGatewayExecutionFailure("MODEL_GATEWAY_RESPONSE_INVALID", "AI Gateway DLP header is invalid JSON", { cause }); }
    const result = exactObject(value, new Set(["action", "findings"]), "AI Gateway DLP header");
    if ((result.action !== "FLAG" && result.action !== "BLOCK") || !Array.isArray(result.findings) || result.findings.length === 0 || result.findings.length > 64) invalid("AI Gateway DLP observation is invalid");
    boundedJson(result.findings);
    modelGatewayExecutionFailure("MODEL_GATEWAY_POLICY_REJECTED", `AI Gateway returned a DLP ${result.action} observation`);
  }
  const logId = identifier(header(response.headers, "cf-aig-log-id", true), "AI Gateway log identifier");
  for (const [name, expected] of [["cf-aig-provider", policy.provider], ["cf-aig-model", policy.model]] as const) {
    const observed = header(response.headers, name, false);
    if (observed !== undefined && observed !== expected) invalid(`AI Gateway ${name} differs from the selected transport policy`);
  }
  const rawCache = header(response.headers, "cf-aig-cache-status", false);
  if (rawCache !== undefined && rawCache.toUpperCase() !== "MISS" && rawCache.toUpperCase() !== "HIT") invalid("AI Gateway cache status is unsupported");
  if (rawCache?.toUpperCase() === "HIT") invalid("AI Gateway returned a cache hit despite explicit cache bypass");
  const successfulStep = header(response.headers, "cf-aig-step", false);
  return { logId, ...(rawCache === undefined ? {} : { cacheStatus: "MISS" as const }), ...(successfulStep === undefined ? {} : { successfulStep }) };
}

async function readResponseBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 256 * 1024) invalid("reserved output byte budget is invalid");
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null && (!/^(0|[1-9][0-9]*)$/u.test(rawLength) || !Number.isSafeInteger(Number(rawLength)) || Number(rawLength) > maximumBytes)) invalid("provider response exceeds its byte budget");
  if (response.body === null) invalid("provider response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) { await reader.cancel("response byte budget exceeded"); invalid("provider response exceeds its byte budget"); }
      chunks.push(next.value);
    }
  } catch (cause) {
    if (cause instanceof ModelGatewayExecutionError) throw cause;
    modelGatewayExecutionFailure("MODEL_GATEWAY_RESPONSE_INVALID", "provider response body could not be read", { cause });
  }
  if (length === 0) invalid("provider response body is empty");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function decodeModelGatewayProviderNativeResponse(
  response: Response,
  deployment: ModelRouteDeployment,
  maximumBytes: number,
  policy: ModelGatewayTransportPolicyV1,
): Promise<DecodedModelGatewayResponse> {
  if (policy.api === "compat-chat-completions") invalid("provider-native decoder cannot read the compatibility API");
  const headerState = assertResponseHeaders(response, policy);
  const bodyBytes = await readResponseBody(response, maximumBytes);
  const decoded = await decodeModelGatewayProviderBody(bodyBytes, policy.api);
  if (decoded.response_model !== policy.model) invalid("provider response model differs from the selected exact model");
  const fingerprint: RouteFingerprint = Object.freeze({ ...deployment, provider: policy.provider, exact_model_id: policy.model });
  return Object.freeze({
    ...decoded,
    fingerprint,
    log_id: headerState.logId,
    ...(headerState.cacheStatus === undefined ? {} : { cache_status: headerState.cacheStatus }),
    ...(headerState.successfulStep === undefined ? {} : { successful_step: headerState.successfulStep }),
  });
}
