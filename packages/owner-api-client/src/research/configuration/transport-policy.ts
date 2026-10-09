/**
 * C3-RC saved model transport policy.
 *
 * Mechanically moved from `packages/pwa-research-workspace/src/research-model-transport-policy-decoder.ts`.
 * The parser is a pure decoder: it performs no transport, and every failure is raised through the
 * injected error factory, so this module never constructs a default error and carries no dependency on
 * any legacy package.
 */

import type { LegacyErrorFactory } from '../../legacy/http';

type JsonRecord = Record<string, unknown>;

const MODEL_IDENTIFIER = /^(?:@[A-Za-z0-9][A-Za-z0-9._:@/-]{0,254}|[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255})$/u;
const PROVIDER_IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,128}$/u;
const BYOK_ALIAS = /^[A-Za-z0-9._-]{1,128}$/u;

export type ResearchModelEffectiveReasoningEffort = "low" | "medium" | "high" | "max";

export type ResearchModelTransportPolicy = Readonly<{
  version: 1;
  transport: "cloudflare-ai-gateway";
  api: "compat-chat-completions" | "openai-chat-completions" | "openai-responses" |
    "openrouter-chat-completions" | "anthropic-messages";
  provider: string;
  model: string;
  billing: Readonly<{ mode: "unified" }> |
    Readonly<{ mode: "byok"; alias: string; free_only?: true }>;
  capabilities: Readonly<{
    max_output_tokens_field: "max_tokens" | "max_completion_tokens" | "max_output_tokens";
    reasoning_efforts: readonly ResearchModelEffectiveReasoningEffort[];
    reasoning_effort_normalizations?: Readonly<Partial<Record<ResearchModelEffectiveReasoningEffort, ResearchModelEffectiveReasoningEffort>>>;
    response_format_normalization?: "json-schema-to-json-object";
  }>;
}>;

/**
 * Builds the pure policy parser.
 *
 * `errors` is required and has no default: a caller that forgets the factory must fail to compile, not
 * silently produce a different error class than every other strict rejection on this wire.
 */
export function createTransportPolicyDecoder(errors: LegacyErrorFactory) {
  function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function schemaMismatch(message: string): never {
    throw errors({ status: 502, code: "API_RESPONSE_SCHEMA_MISMATCH", message, traceId: null, retryable: false });
  }

  function exactRecord(value: unknown, keys: readonly string[], label: string): JsonRecord {
    if (!isRecord(value) || Object.keys(value).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !keys.includes(key))) {
      schemaMismatch(`${label} has missing or unknown fields`);
    }
    return value;
  }

  function boundedText(value: unknown, label: string, maxBytes: number): string {
    if (typeof value !== "string" || value.length === 0 ||
        new TextEncoder().encode(value).byteLength > maxBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
      schemaMismatch(`${label} is invalid`);
    }
    return value;
  }

  /** Decode an exact saved transport policy without inferring capabilities or billing behavior. */
  function decodeResearchModelTransportPolicy(value: unknown): ResearchModelTransportPolicy {
    const raw = exactRecord(value, ["version", "transport", "api", "provider", "model", "billing", "capabilities"], "model transport policy");
    if (raw.version !== 1 || raw.transport !== "cloudflare-ai-gateway" ||
        (raw.api !== "compat-chat-completions" && raw.api !== "openai-chat-completions" &&
         raw.api !== "openai-responses" && raw.api !== "openrouter-chat-completions" && raw.api !== "anthropic-messages")) {
      schemaMismatch("model transport policy is unsupported");
    }
    const hasFreeOnly = isRecord(raw.billing) && Object.hasOwn(raw.billing, "free_only");
    const billingRecord = isRecord(raw.billing) && raw.billing.mode === "unified"
      ? exactRecord(raw.billing, ["mode"], "model billing policy")
      : exactRecord(raw.billing, hasFreeOnly ? ["mode", "alias", "free_only"] : ["mode", "alias"], "model billing policy");
    let billing: ResearchModelTransportPolicy["billing"];
    if (billingRecord.mode === "unified") {
      billing = Object.freeze({ mode: "unified" });
    } else if (billingRecord.mode === "byok") {
      const alias = boundedText(billingRecord.alias, "BYOK alias", 128);
      if (!BYOK_ALIAS.test(alias)) schemaMismatch("BYOK alias is invalid");
      if (hasFreeOnly && billingRecord.free_only !== true) {
        schemaMismatch("free-only billing must be explicitly true");
      }
      billing = Object.freeze({ mode: "byok", alias, ...(hasFreeOnly ? { free_only: true as const } : {}) });
    } else {
      schemaMismatch("model billing mode is unsupported");
    }
    const provider = boundedText(raw.provider, "transport provider", 128);
    if (!PROVIDER_IDENTIFIER.test(provider)) schemaMismatch("transport provider is invalid");
    const expectedNativeProvider = raw.api === "openai-chat-completions" || raw.api === "openai-responses" ? "openai"
      : raw.api === "openrouter-chat-completions" ? "openrouter"
        : raw.api === "anthropic-messages" ? "anthropic" : undefined;
    if (expectedNativeProvider !== undefined && (provider !== expectedNativeProvider || billing.mode !== "byok")) {
      schemaMismatch("native model API provider billing identity does not match");
    }
    if (billing.mode === "byok" && billing.free_only === true &&
        (raw.api !== "openrouter-chat-completions" || provider !== "openrouter")) {
      schemaMismatch("free-only billing requires the OpenRouter native endpoint");
    }
    if (!isRecord(raw.capabilities)) schemaMismatch("model request capabilities are invalid");
    const capabilityKeys = ["max_output_tokens_field", "reasoning_efforts"];
    if (Object.hasOwn(raw.capabilities, "reasoning_effort_normalizations")) capabilityKeys.push("reasoning_effort_normalizations");
    if (Object.hasOwn(raw.capabilities, "response_format_normalization")) capabilityKeys.push("response_format_normalization");
    const capabilities = exactRecord(raw.capabilities, capabilityKeys, "model request capabilities");
    if (capabilities.max_output_tokens_field !== "max_tokens" && capabilities.max_output_tokens_field !== "max_completion_tokens" &&
        capabilities.max_output_tokens_field !== "max_output_tokens") {
      schemaMismatch("model output token parameter is unsupported");
    }
    const allowedEfforts = ["low", "medium", "high", "max"] as const;
    if (!Array.isArray(capabilities.reasoning_efforts) || capabilities.reasoning_efforts.length > allowedEfforts.length ||
        capabilities.reasoning_efforts.some((effort) => !allowedEfforts.includes(effort as typeof allowedEfforts[number])) ||
        new Set(capabilities.reasoning_efforts).size !== capabilities.reasoning_efforts.length) {
      schemaMismatch("model reasoning effort capabilities are invalid");
    }
    let reasoningEffortNormalizations: ResearchModelTransportPolicy["capabilities"]["reasoning_effort_normalizations"];
    if (Object.hasOwn(capabilities, "reasoning_effort_normalizations")) {
      const rawNormalizations = capabilities.reasoning_effort_normalizations;
      if (!isRecord(rawNormalizations)) schemaMismatch("model reasoning effort normalizations are invalid");
      const normalizationKeys = Object.keys(rawNormalizations);
      if (normalizationKeys.length === 0 || normalizationKeys.some((key) =>
        !allowedEfforts.includes(key as typeof allowedEfforts[number]))) {
        schemaMismatch("model reasoning effort normalizations are invalid");
      }
      const normalized: Partial<Record<ResearchModelEffectiveReasoningEffort, ResearchModelEffectiveReasoningEffort>> = {};
      for (const key of normalizationKeys) {
        const alias = key as ResearchModelEffectiveReasoningEffort;
        const effective = rawNormalizations[key];
        if (typeof effective !== "string" || !allowedEfforts.includes(effective as typeof allowedEfforts[number]) ||
            capabilities.reasoning_efforts.includes(alias) || !capabilities.reasoning_efforts.includes(effective as typeof allowedEfforts[number])) {
          schemaMismatch("model reasoning effort normalizations are inconsistent with supported efforts");
        }
        normalized[alias] = effective as ResearchModelEffectiveReasoningEffort;
      }
      reasoningEffortNormalizations = Object.freeze(normalized);
    }
    let responseFormatNormalization: ResearchModelTransportPolicy["capabilities"]["response_format_normalization"];
    if (Object.hasOwn(capabilities, "response_format_normalization")) {
      if (capabilities.response_format_normalization !== "json-schema-to-json-object") {
        schemaMismatch("model response format normalization is unsupported");
      }
      if (raw.api !== "openai-chat-completions" && raw.api !== "openrouter-chat-completions") {
        schemaMismatch("model response format normalization is unsupported for this API");
      }
      responseFormatNormalization = capabilities.response_format_normalization;
    }
    const model = boundedText(raw.model, "transport model", 256);
    if (!MODEL_IDENTIFIER.test(model)) schemaMismatch("transport model is invalid");
    const decodedCapabilities: ResearchModelTransportPolicy["capabilities"] = Object.freeze({
      max_output_tokens_field: capabilities.max_output_tokens_field,
      reasoning_efforts: Object.freeze([...capabilities.reasoning_efforts]) as ResearchModelTransportPolicy["capabilities"]["reasoning_efforts"],
      ...(reasoningEffortNormalizations === undefined ? {} : { reasoning_effort_normalizations: reasoningEffortNormalizations }),
      ...(responseFormatNormalization === undefined ? {} : { response_format_normalization: responseFormatNormalization }),
    });
    return Object.freeze({ version: 1, transport: "cloudflare-ai-gateway", api: raw.api,
      provider, model, billing, capabilities: decodedCapabilities });
  }

  return { decodeResearchModelTransportPolicy };
}

/** Label helpers, moved verbatim. They read a decoded policy and never re-derive capability facts. */
export function researchModelSelectionBillingLabel(policy: ResearchModelTransportPolicy): string {
  return policy.billing.mode === "unified" ? "Unified billing" :
    policy.billing.alias === "default" ? "BYOK · default alias (secret stays server-side)" :
      `BYOK · alias ${policy.billing.alias} (secret stays server-side)`;
}

export function researchModelSelectionApiLabel(policy: ResearchModelTransportPolicy): string {
  const labels: Readonly<Record<ResearchModelTransportPolicy["api"], string>> = {
    "compat-chat-completions": "Chat Completions compatible API",
    "openai-chat-completions": "OpenAI Chat Completions API",
    "openai-responses": "OpenAI Responses API",
    "openrouter-chat-completions": "OpenRouter Chat Completions API",
    "anthropic-messages": "Anthropic Messages API",
  };
  const label = labels[policy.api];
  return policy.capabilities.response_format_normalization === "json-schema-to-json-object"
    ? `${label} · JSON Schema becomes JSON Object`
    : label;
}

export function researchModelSelectionEffortLabel(policy: ResearchModelTransportPolicy): string {
  const supported = policy.capabilities.reasoning_efforts.length === 0
    ? "Reasoning effort: not declared by this transport"
    : `Declared reasoning efforts: ${policy.capabilities.reasoning_efforts.join(", ")}`;
  const normalizations = Object.entries(policy.capabilities.reasoning_effort_normalizations ?? {})
    .map(([input, effective]) => `${input} → ${effective}`).join(", ");
  return normalizations ? `${supported}; normalizes ${normalizations}` : supported;
}
