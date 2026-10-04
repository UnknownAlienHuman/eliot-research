import { modelGatewayExecutionFailure } from "./model-gateway-execution-contract.js";

export type ModelGatewayApi =
  | "compat-chat-completions"
  | "openai-responses"
  | "anthropic-messages";

export type ModelGatewayRequestCapabilitiesV1 = Readonly<{
  readonly max_output_tokens_field: "max_tokens" | "max_completion_tokens";
  readonly reasoning_efforts: readonly ("low" | "medium" | "high" | "max")[];
}>;

export type ModelGatewayTransportPolicyV1 = Readonly<{
  readonly version: 1;
  readonly transport: "cloudflare-ai-gateway";
  readonly api: ModelGatewayApi;
  readonly provider: string;
  readonly model: string;
  readonly billing:
    | Readonly<{ readonly mode: "unified" }>
    | Readonly<{ readonly mode: "byok"; readonly alias: string }>;
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
  "reasoning_efforts",
]);
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
      value.max_output_tokens_field !== "max_completion_tokens") {
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
  return Object.freeze({
    max_output_tokens_field: value.max_output_tokens_field,
    reasoning_efforts: Object.freeze([...efforts]) as ModelGatewayRequestCapabilitiesV1["reasoning_efforts"],
  });
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
  if (api !== "compat-chat-completions" && api !== "openai-responses" &&
      api !== "anthropic-messages") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model gateway provider API is unsupported",
    );
  }
  const billingValue = value.billing;
  const billingKeys = typeof billingValue === "object" && billingValue !== null &&
    !Array.isArray(billingValue) && (billingValue as Record<string, unknown>).mode === "unified"
    ? new Set(["mode"])
    : new Set(["alias", "mode"]);
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
    decodedBilling = Object.freeze({ mode: "byok", alias: billing.alias });
  } else {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "model gateway billing mode is unsupported",
    );
  }
  return Object.freeze({
    version: 1,
    transport: "cloudflare-ai-gateway",
    api,
    provider: identifier(value.provider, "model gateway provider"),
    model: identifier(value.model, "model gateway exact model"),
    billing: decodedBilling,
    capabilities: validateModelGatewayRequestCapabilities(value.capabilities),
  });
}

export function validateModelGatewayTransportSelection(
  policy: ModelGatewayTransportPolicyV1 | undefined,
  bindingTransport: boolean,
): void {
  if (policy !== undefined && policy.api !== "compat-chat-completions") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_REQUEST_INVALID",
      "selected provider API is unsupported by the response decoder",
    );
  }
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
