import { modelGatewayExecutionFailure } from "./model-gateway-execution-contract.js";

export type ModelGatewayApi =
  | "compat-chat-completions"
  | "openai-chat-completions"
  | "openai-responses"
  | "openrouter-chat-completions"
  | "anthropic-messages";

export type ModelGatewayRequestCapabilitiesV1 = Readonly<{
  readonly max_output_tokens_field: "max_tokens" | "max_completion_tokens" | "max_output_tokens";
  readonly reasoning_efforts: readonly ("low" | "medium" | "high" | "max")[];
  readonly reasoning_effort_normalizations?: Readonly<Partial<Record<"low" | "medium" | "high" | "max", "low" | "medium" | "high" | "max">>>;
  readonly response_format_normalization?: "json-schema-to-json-object";
}>;

export type ModelGatewayTransportPolicyV1 = Readonly<{
  readonly version: 1;
  readonly transport: "cloudflare-ai-gateway";
  readonly api: ModelGatewayApi;
  readonly provider: string;
  readonly model: string;
  readonly billing:
    | Readonly<{ readonly mode: "unified" }>
    | Readonly<{ readonly mode: "byok"; readonly alias: string; readonly free_only?: true }>;
  readonly capabilities: ModelGatewayRequestCapabilitiesV1;
}>;

const POLICY_KEYS = new Set([
  "api",
  "billing",
  "capabilities",
  "model",
  "provider",
  "transport",
  "version",
]);
const CAPABILITY_KEYS = new Set([
  "max_output_tokens_field",
  "reasoning_effort_normalizations",
  "reasoning_efforts",
  "response_format_normalization",
]);
const REASONING_EFFORT_KEYS = new Set(["high", "low", "max", "medium"]);
const POLICY_IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,128}$/u;
const BYOK_ALIAS = /^[A-Za-z0-9._-]{1,128}$/u;
const REASONING_EFFORTS = new Set(["low", "medium", "high", "max"]);

function exactObject(
  value: unknown,
  keys: ReadonlySet<string>,
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
    if (!keys.has(key)) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_REQUEST_INVALID",
        `${label} contains unsupported field ${key}`,
      );
    }
  }
  return record;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !POLICY_IDENTIFIER.test(value)) {
    modelGatewayExecutionFailure("MODEL_GATEWAY_REQUEST_INVALID", `${label} is invalid`);
  }
  return value;
}

export function validateModelGatewayRequestCapabilities(
  raw: unknown,
): ModelGatewayRequestCapabilitiesV1 {
  const value = exactObject(raw, CAPABILITY_KEYS, "model gateway request capabilities");
  if (value.max_output_tokens_field !== "max_tokens" &&
      value.max_output_tokens_field !== "max_completion_tokens" &&
      value.max_output_tokens_field !== "max_output_tokens") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model gateway output token capability is unsupported",
    );
  }
  const efforts = value.reasoning_efforts;
  if (!Array.isArray(efforts) || efforts.length > REASONING_EFFORTS.size ||
      efforts.some((effort) => typeof effort !== "string" || !REASONING_EFFORTS.has(effort)) ||
      new Set(efforts).size !== efforts.length) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model gateway reasoning effort capabilities are invalid",
    );
  }
  const normalizationsRaw = value.reasoning_effort_normalizations;
  let normalizations: ModelGatewayRequestCapabilitiesV1["reasoning_effort_normalizations"];
  if (normalizationsRaw !== undefined) {
    const entries = exactObject(
      normalizationsRaw,
      REASONING_EFFORT_KEYS,
      "model gateway reasoning effort normalizations",
    );
    const normalized: Partial<Record<"low" | "medium" | "high" | "max", "low" | "medium" | "high" | "max">> = {};
    for (const [alias, rawTarget] of Object.entries(entries)) {
      if (!REASONING_EFFORT_KEYS.has(alias) || typeof rawTarget !== "string" ||
          !REASONING_EFFORTS.has(rawTarget) || rawTarget === alias ||
          efforts.includes(alias) || !efforts.includes(rawTarget)) {
        modelGatewayExecutionFailure(
          "MODEL_GATEWAY_REQUEST_INVALID",
          "model gateway reasoning effort normalization is unsupported",
        );
      }
      normalized[alias as "low" | "medium" | "high" | "max"] =
        rawTarget as "low" | "medium" | "high" | "max";
    }
    if (Object.keys(normalized).length === 0) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_REQUEST_INVALID",
        "model gateway reasoning effort normalizations cannot be empty",
      );
    }
    normalizations = Object.freeze(normalized);
  }
  const responseFormatNormalization = value.response_format_normalization;
  if (responseFormatNormalization !== undefined &&
      responseFormatNormalization !== "json-schema-to-json-object") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model gateway response format normalization is unsupported",
    );
  }
  return Object.freeze({
    max_output_tokens_field: value.max_output_tokens_field,
    reasoning_efforts: Object.freeze([...efforts]) as ModelGatewayRequestCapabilitiesV1["reasoning_efforts"],
    ...(normalizations === undefined ? {} : { reasoning_effort_normalizations: normalizations }),
    ...(responseFormatNormalization === undefined ? {} : {
      response_format_normalization: responseFormatNormalization,
    }),
  });
}

export function normalizeModelGatewayReasoningEffort(
  raw: unknown,
  capabilities: ModelGatewayRequestCapabilitiesV1,
): "low" | "medium" | "high" | "max" {
  if (typeof raw !== "string" || !REASONING_EFFORTS.has(raw)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model request reasoning_effort is invalid",
    );
  }
  if (capabilities.reasoning_efforts.includes(raw as "low" | "medium" | "high" | "max")) {
    return raw as "low" | "medium" | "high" | "max";
  }
  const normalized = capabilities.reasoning_effort_normalizations?.[
    raw as "low" | "medium" | "high" | "max"
  ];
  if (normalized === undefined) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model request reasoning_effort is unsupported by the selected model API",
    );
  }
  return normalized;
}

export function validateModelGatewayTransportPolicy(
  raw: unknown,
): ModelGatewayTransportPolicyV1 {
  const value = exactObject(raw, POLICY_KEYS, "model gateway transport policy");
  if (value.version !== 1 || value.transport !== "cloudflare-ai-gateway") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model gateway transport policy version or transport is unsupported",
    );
  }
  const api = value.api;
  if (api !== "compat-chat-completions" && api !== "openai-chat-completions" &&
      api !== "openai-responses" && api !== "openrouter-chat-completions" && api !== "anthropic-messages") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model gateway provider API is unsupported",
    );
  }
  const billingValue = value.billing;
  const billingKeys = typeof billingValue === "object" && billingValue !== null &&
    !Array.isArray(billingValue) && (billingValue as Record<string, unknown>).mode === "unified"
    ? new Set(["mode"])
    : new Set(["alias", "free_only", "mode"]);
  const billing = exactObject(billingValue, billingKeys, "model gateway billing policy");
  let decodedBilling: ModelGatewayTransportPolicyV1["billing"];
  if (billing.mode === "unified") {
    decodedBilling = Object.freeze({ mode: "unified" });
  } else if (billing.mode === "byok") {
    if (typeof billing.alias !== "string" || !BYOK_ALIAS.test(billing.alias)) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_REQUEST_INVALID",
        "model gateway BYOK alias is invalid",
      );
    }
    if (billing.free_only !== undefined && billing.free_only !== true) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_REQUEST_INVALID",
        "model gateway free-only policy must be explicitly true",
      );
    }
    decodedBilling = Object.freeze({
      mode: "byok",
      alias: billing.alias,
      ...(billing.free_only === true ? { free_only: true as const } : {}),
    });
  } else {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model gateway billing mode is unsupported",
    );
  }
  const provider = identifier(value.provider, "model gateway provider");
  const capabilities = validateModelGatewayRequestCapabilities(value.capabilities);
  if ((api === "openai-responses" && capabilities.max_output_tokens_field !== "max_output_tokens") ||
      (api === "anthropic-messages" && capabilities.max_output_tokens_field !== "max_tokens") ||
      ((api === "openai-chat-completions" || api === "openrouter-chat-completions") &&
        capabilities.max_output_tokens_field === "max_output_tokens")) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model gateway output token capability does not match its provider API",
    );
  }
  if (capabilities.response_format_normalization !== undefined &&
      api !== "openai-chat-completions" && api !== "openrouter-chat-completions") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "JSON schema response format normalization requires a documented JSON-object-capable Chat API",
    );
  }
  if (api === "compat-chat-completions" && decodedBilling.mode === "byok" &&
      decodedBilling.alias !== "default") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "non-default BYOK aliases require a provider-native endpoint",
    );
  }
  if (provider === "workers-ai" && decodedBilling.mode === "byok") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "Workers AI billing cannot select a provider BYOK key",
    );
  }
  if (api === "openai-chat-completions" || api === "openai-responses") {
    if (provider !== "openai" || decodedBilling.mode !== "byok") {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_REQUEST_INVALID",
        "OpenAI provider-native endpoints require exact OpenAI BYOK selection",
      );
    }
  }
  if (api === "openrouter-chat-completions" &&
      (provider !== "openrouter" || decodedBilling.mode !== "byok")) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "OpenRouter native endpoint requires exact OpenRouter BYOK selection",
    );
  }
  if (decodedBilling.mode === "byok" && decodedBilling.free_only === true &&
      (api !== "openrouter-chat-completions" || provider !== "openrouter")) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "free-only billing requires the OpenRouter-native endpoint",
    );
  }
  if (provider === "openrouter" && api !== "openrouter-chat-completions") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "OpenRouter requires its provider-native endpoint",
    );
  }
  if (api === "anthropic-messages" &&
      (provider !== "anthropic" || decodedBilling.mode !== "byok")) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "Anthropic provider-native endpoint requires exact Anthropic BYOK selection",
    );
  }
  return Object.freeze({
    version: 1,
    transport: "cloudflare-ai-gateway",
    api,
    provider,
    model: identifier(value.model, "model gateway exact model"),
    billing: decodedBilling,
    capabilities,
  });
}

export function validateModelGatewayTransportSelection(
  policy: ModelGatewayTransportPolicyV1 | undefined,
  bindingTransport: boolean,
): void {
  if (bindingTransport && policy?.billing.mode === "byok") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "BYOK aliases require direct AI Gateway passthrough transport",
    );
  }
}

export function assertModelGatewayObservedIdentity(
  policy: ModelGatewayTransportPolicyV1 | undefined,
  provider: string,
  model: string,
): void {
  if (policy !== undefined &&
      (provider !== policy.provider || model !== policy.model)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "observed provider or model differs from the selected transport policy",
    );
  }
}
