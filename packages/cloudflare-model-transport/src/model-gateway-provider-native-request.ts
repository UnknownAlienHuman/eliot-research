import { modelGatewayExecutionFailure } from "./model-gateway-execution-contract.js";
import type {
  ModelGatewayApi,
  ModelGatewayRequestCapabilitiesV1,
  ModelGatewayTransportPolicyV1,
} from "./model-gateway-transport-policy.js";

const PARAMETER_KEYS = [
  "max_completion_tokens",
  "max_tokens",
  "max_output_tokens",
  "reasoning_effort",
  "response_format",
  "seed",
  "stop",
  "stream",
  "temperature",
  "top_p",
] as const;

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    modelGatewayExecutionFailure("MODEL_GATEWAY_REQUEST_INVALID", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    modelGatewayExecutionFailure("MODEL_GATEWAY_REQUEST_INVALID", `${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) {
      modelGatewayExecutionFailure("MODEL_GATEWAY_REQUEST_INVALID", `${label} contains unsupported field ${key}`);
    }
  }
  return record;
}

function chatResponseFormat(
  raw: unknown,
  api: ModelGatewayApi,
  capabilities: ModelGatewayRequestCapabilitiesV1 | undefined,
): unknown {
  const normalization = capabilities?.response_format_normalization;
  if (normalization === undefined) return raw;
  if (normalization !== "json-schema-to-json-object") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "selected response format normalization is unsupported",
    );
  }
  if (api !== "openai-chat-completions" && api !== "openrouter-chat-completions") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "JSON schema response format normalization requires a documented JSON-object-capable Chat API",
    );
  }
  const format = exactObject(raw, ["json_schema", "type"], "Chat Completions response format");
  if (format.type === "json_object" && format.json_schema === undefined) {
    return Object.freeze({ type: "json_object" });
  }
  if (format.type !== "json_schema") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "selected response format normalization supports only JSON schema or JSON object",
    );
  }
  const schema = exactObject(
    format.json_schema,
    ["description", "name", "schema", "strict"],
    "Chat Completions JSON schema",
  );
  if (typeof schema.name !== "string" || schema.name.length === 0 ||
      typeof schema.schema !== "object" || schema.schema === null || Array.isArray(schema.schema) ||
      (schema.description !== undefined && typeof schema.description !== "string") ||
      (schema.strict !== undefined && typeof schema.strict !== "boolean")) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "Chat Completions JSON schema is invalid for JSON object normalization",
    );
  }
  return Object.freeze({ type: "json_object" });
}

export function modelGatewayProviderNativePath(api: ModelGatewayApi): string {
  switch (api) {
    case "compat-chat-completions": return "/compat/chat/completions";
    case "openai-chat-completions": return "/openai/chat/completions";
    case "openrouter-chat-completions": return "/openrouter/chat/completions";
    case "openai-responses": return "/openai/responses";
    case "anthropic-messages": return "/anthropic/v1/messages";
  }
}

export function modelGatewayProviderNativeParameterProjection(
  rawBody: Record<string, unknown>,
  api: ModelGatewayApi,
  capabilities?: ModelGatewayRequestCapabilitiesV1,
): Readonly<Record<string, unknown>> {
  const body = rawBody;
  if (api === "compat-chat-completions" || api === "openai-chat-completions" || api === "openrouter-chat-completions") {
    const result: Record<string, unknown> = {};
    for (const key of PARAMETER_KEYS) {
      if (body[key] === undefined) continue;
      result[key] = key === "response_format"
        ? chatResponseFormat(body[key], api, capabilities)
        : body[key];
    }
    return Object.freeze(result);
  }
  if (api === "openai-responses") {
    if (body.seed !== undefined || body.stop !== undefined) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_REQUEST_INVALID",
        "OpenAI Responses does not support the selected seed or stop parameter",
      );
    }
    const result: Record<string, unknown> = { stream: false, store: false };
    if (body.max_output_tokens !== undefined) result.max_output_tokens = body.max_output_tokens;
    if (body.reasoning_effort !== undefined) result.reasoning = { effort: body.reasoning_effort };
    if (body.response_format !== undefined) result.text = { format: openAiResponseFormat(body.response_format) };
    for (const key of ["temperature", "top_p"] as const) {
      if (body[key] !== undefined) result[key] = body[key];
    }
    return Object.freeze(result);
  }
  if (body.seed !== undefined) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "Anthropic Messages does not support the selected seed parameter",
    );
  }
  const result: Record<string, unknown> = { max_tokens: body.max_tokens };
  if (body.reasoning_effort !== undefined) result.output_config = { effort: body.reasoning_effort };
  if (body.response_format !== undefined) result.output_config = {
    ...(result.output_config as Record<string, unknown> | undefined),
    format: anthropicMessageFormat(body.response_format),
  };
  if (body.stop !== undefined) result.stop_sequences = body.stop;
  for (const key of ["temperature", "top_p"] as const) {
    if (body[key] !== undefined) result[key] = body[key];
  }
  return Object.freeze(result);
}

export function modelGatewayProviderNativeRequest(
  rawBody: unknown,
  policy: ModelGatewayTransportPolicyV1,
): Readonly<Record<string, unknown>> {
  const freeOnly = policy.billing.mode === "byok" && policy.billing.free_only === true;
  if (freeOnly &&
      (policy.api !== "openrouter-chat-completions" || policy.provider !== "openrouter")) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "free-only billing requires the OpenRouter-native endpoint",
    );
  }
  const body = exactObject(rawBody, [
    ...PARAMETER_KEYS,
    "messages",
    "model",
  ], "compiled provider request");
  if (policy.api === "compat-chat-completions") return Object.freeze(body);
  if (body.model === undefined || !Array.isArray(body.messages)) {
    modelGatewayExecutionFailure("MODEL_GATEWAY_REQUEST_INVALID", "compiled provider request is incomplete");
  }
  const messages = body.messages.map((raw, index) => {
    const message = exactObject(raw, ["content", "role"], `compiled provider messages[${index}]`);
    if (typeof message.content !== "string" ||
        (message.role !== "system" && message.role !== "user" && message.role !== "assistant")) {
      modelGatewayExecutionFailure("MODEL_GATEWAY_REQUEST_INVALID", "compiled provider message is invalid");
    }
    return Object.freeze({ role: message.role, content: message.content });
  });
  const parameters = modelGatewayProviderNativeParameterProjection(body, policy.api, policy.capabilities);
  if (policy.api === "anthropic-messages") {
    const systemMessages = messages.filter((message) => message.role === "system");
    const conversation = messages.filter((message) => message.role !== "system");
    if (systemMessages.length !== 1 || messages[0]?.role !== "system" ||
        conversation.some((message) => message.role !== "user" && message.role !== "assistant")) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_REQUEST_INVALID",
        "Anthropic Messages requires one leading system message and user/assistant turns",
      );
    }
    return Object.freeze({
      model: policy.model,
      system: systemMessages[0]?.content,
      messages: Object.freeze(conversation),
      ...parameters,
    });
  }
  if (policy.api === "openai-responses") {
    return Object.freeze({
      model: policy.model,
      input: Object.freeze(messages),
      ...parameters,
    });
  }
  if (freeOnly) {
    return Object.freeze({
      model: policy.model,
      messages: Object.freeze(messages),
      ...parameters,
      provider: Object.freeze({
        allow_fallbacks: false,
        max_price: Object.freeze({
          prompt: 0,
          completion: 0,
          request: 0,
          image: 0,
        }),
      }),
    });
  }
  return Object.freeze({
    model: policy.model,
    messages: Object.freeze(messages),
    ...parameters,
  });
}

function openAiResponseFormat(raw: unknown): unknown {
  const value = exactObject(raw, ["json_schema", "type"], "OpenAI Responses format");
  if (value.type === "json_object") return Object.freeze({ type: "json_object" });
  if (value.type !== "json_schema") {
    modelGatewayExecutionFailure("MODEL_GATEWAY_REQUEST_INVALID", "OpenAI Responses format is unsupported");
  }
  const schema = exactObject(value.json_schema, ["description", "name", "schema", "strict"], "OpenAI Responses JSON schema");
  if (typeof schema.name !== "string" || schema.name.length < 1 || schema.schema === undefined ||
      (schema.strict !== undefined && typeof schema.strict !== "boolean")) {
    modelGatewayExecutionFailure("MODEL_GATEWAY_REQUEST_INVALID", "OpenAI Responses JSON schema is invalid");
  }
  return Object.freeze({
    type: "json_schema",
    name: schema.name,
    ...(schema.description === undefined ? {} : { description: schema.description }),
    schema: schema.schema,
    ...(schema.strict === undefined ? {} : { strict: schema.strict }),
  });
}

function anthropicMessageFormat(raw: unknown): unknown {
  const value = exactObject(raw, ["json_schema", "type"], "Anthropic Messages format");
  if (value.type !== "json_schema") {
    modelGatewayExecutionFailure("MODEL_GATEWAY_REQUEST_INVALID", "Anthropic Messages requires a JSON schema format");
  }
  const schema = exactObject(value.json_schema, ["description", "name", "schema", "strict"], "Anthropic Messages JSON schema");
  if (schema.schema === undefined) {
    modelGatewayExecutionFailure("MODEL_GATEWAY_REQUEST_INVALID", "Anthropic Messages schema is missing");
  }
  return Object.freeze({ type: "json_schema", schema: schema.schema });
}
