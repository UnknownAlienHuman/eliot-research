import type {
  ModelGatewayPricingPort,
  ModelGatewayPricingQuoteInput,
  ModelGatewayPricingQuote,
} from "@eliotr/cloudflare-ai";
import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
} from "@eliotr/cloudflare-ai";
import type {
  ResearchModelPricingSnapshot,
} from "@eliotr/cloudflare-model-control";
import { decodeModelRouteDeployment, type RouteFingerprint } from "@eliotr/platform-cloudflare";
import {
  providerNativeModelFailure,
  type ProviderNativeModelPreparationV1,
} from "./provider-native-model-candidate.js";

export const PROVIDER_NATIVE_MODEL_ZERO_PRICE_PROTOCOL = "eliotr.provider-native-zero-price.v1" as const;

const MAX_TOKEN_COUNT = 1_000_000;
const RULE_KEYS = new Set([
  "allow_fallbacks", "exact_model_id", "max_price", "pricing_snapshot_ref",
  "pricing_snapshot_sha256", "protocol", "provider", "route_ref", "route_version",
  "transport_policy_sha256",
]);
const MAX_PRICE_KEYS = new Set(["completion", "image", "prompt", "request"]);
const FINGERPRINT_KEYS = new Set([
  "exact_model_id", "parameters_digest", "pricing_snapshot_ref", "prompt_generation",
  "provider", "route_ref", "route_version", "schema_generation",
]);

export interface ProviderNativeModelZeroPriceRuleV1 {
  readonly protocol: typeof PROVIDER_NATIVE_MODEL_ZERO_PRICE_PROTOCOL;
  readonly transport_policy_sha256: string;
  readonly provider: "openrouter";
  readonly exact_model_id: string;
  readonly route_ref: string;
  readonly route_version: string;
  readonly pricing_snapshot_ref: string;
  readonly pricing_snapshot_sha256: string;
  readonly allow_fallbacks: false;
  readonly max_price: Readonly<{
    readonly prompt: 0;
    readonly completion: 0;
    readonly request: 0;
    readonly image: 0;
  }>;
}

function exactRecord(value: unknown, allowed: ReadonlySet<string>, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", `${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", `${label} contains unsupported fields`);
  }
  return record;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

function id(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u.test(value)) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

function count(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_TOKEN_COUNT) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", `${label} is outside its bound`);
  }
  return value;
}

function decodeFingerprint(raw: unknown): RouteFingerprint {
  const value = exactRecord(raw, FINGERPRINT_KEYS, "native zero-price route fingerprint");
  const deployment = decodeModelRouteDeployment({
    route_ref: value.route_ref,
    route_version: value.route_version,
    prompt_generation: value.prompt_generation,
    schema_generation: value.schema_generation,
    parameters_digest: value.parameters_digest,
    pricing_snapshot_ref: value.pricing_snapshot_ref,
  });
  return Object.freeze({
    ...deployment,
    provider: id(value.provider, "native zero-price provider"),
    exact_model_id: id(value.exact_model_id, "native zero-price model"),
  });
}

function freeOnly(preparation: ProviderNativeModelPreparationV1): void {
  if (preparation.transport_policy.api !== "openrouter-chat-completions" ||
      preparation.transport_policy.provider !== "openrouter" ||
      preparation.transport_policy.billing.mode !== "byok" ||
      preparation.transport_policy.billing.free_only !== true) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native zero-price quote requires explicit OpenRouter free-only policy");
  }
}

export function decodeProviderNativeModelZeroPriceRule(raw: unknown): ProviderNativeModelZeroPriceRuleV1 {
  const value = exactRecord(raw, RULE_KEYS, "native zero-price enforcement rule");
  const maxPrice = exactRecord(value.max_price, MAX_PRICE_KEYS, "native maximum price");
  if (Object.keys(maxPrice).length !== MAX_PRICE_KEYS.size ||
      [...MAX_PRICE_KEYS].some((key) => maxPrice[key] !== 0) ||
      value.protocol !== PROVIDER_NATIVE_MODEL_ZERO_PRICE_PROTOCOL ||
      value.provider !== "openrouter" || value.allow_fallbacks !== false) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "native zero-price enforcement rule is invalid");
  }
  return Object.freeze({
    protocol: PROVIDER_NATIVE_MODEL_ZERO_PRICE_PROTOCOL,
    transport_policy_sha256: digest(value.transport_policy_sha256, "transport policy digest"),
    provider: "openrouter",
    exact_model_id: id(value.exact_model_id, "exact model"),
    route_ref: id(value.route_ref, "route reference"),
    route_version: id(value.route_version, "route version"),
    pricing_snapshot_ref: id(value.pricing_snapshot_ref, "pricing snapshot reference"),
    pricing_snapshot_sha256: digest(value.pricing_snapshot_sha256, "pricing snapshot digest"),
    allow_fallbacks: false,
    max_price: Object.freeze({ prompt: 0, completion: 0, request: 0, image: 0 }),
  });
}

export async function providerNativeModelZeroPriceRule(
  preparation: ProviderNativeModelPreparationV1,
): Promise<ProviderNativeModelZeroPriceRuleV1> {
  freeOnly(preparation);
  return Object.freeze({
    protocol: PROVIDER_NATIVE_MODEL_ZERO_PRICE_PROTOCOL,
    transport_policy_sha256: await modelGatewaySha256(canonicalModelGatewayJson(preparation.transport_policy)),
    provider: "openrouter",
    exact_model_id: preparation.transport_policy.model,
    route_ref: preparation.deployment.route_ref,
    route_version: preparation.deployment.route_version,
    pricing_snapshot_ref: preparation.pricing_snapshot_ref,
    pricing_snapshot_sha256: preparation.pricing_snapshot_sha256,
    allow_fallbacks: false,
    max_price: Object.freeze({ prompt: 0, completion: 0, request: 0, image: 0 }),
  });
}

function assertSnapshot(
  preparation: ProviderNativeModelPreparationV1,
  snapshot: ResearchModelPricingSnapshot,
): void {
  freeOnly(preparation);
  if (snapshot.pricing_snapshot_ref !== preparation.pricing_snapshot_ref ||
      snapshot.snapshot_sha256 !== preparation.pricing_snapshot_sha256 ||
      snapshot.route_ref !== preparation.deployment.route_ref ||
      snapshot.route_version !== preparation.deployment.route_version ||
      snapshot.provider !== "openrouter" ||
      snapshot.exact_model_id !== preparation.transport_policy.model ||
      snapshot.pricing_basis !== "EXACT_TOKEN_RATES_V1" ||
      snapshot.input_rate_usd_per_1k_tokens !== "0" ||
      snapshot.output_rate_usd_per_1k_tokens !== "0" ||
      snapshot.approval_receipt_ref.length === 0 ||
      !Number.isFinite(Date.parse(snapshot.effective_at)) ||
      !Number.isFinite(Date.parse(snapshot.expires_at)) ||
      Date.parse(snapshot.expires_at) <= Date.parse(snapshot.effective_at)) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "native zero-price snapshot does not match the exact free-only tuple");
  }
}

function assertFingerprint(
  fingerprint: RouteFingerprint,
  preparation: ProviderNativeModelPreparationV1,
): void {
  const deployment = preparation.deployment;
  if (fingerprint.route_ref !== deployment.route_ref || fingerprint.route_version !== deployment.route_version ||
      fingerprint.prompt_generation !== deployment.prompt_generation || fingerprint.schema_generation !== deployment.schema_generation ||
      fingerprint.parameters_digest !== deployment.parameters_digest ||
      fingerprint.pricing_snapshot_ref !== preparation.pricing_snapshot_ref ||
      fingerprint.provider !== "openrouter" || fingerprint.exact_model_id !== preparation.transport_policy.model) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "native zero-price quote fingerprint differs from its pinned preparation");
  }
}

export async function providerNativeModelZeroPriceQuoteRef(
  preparation: ProviderNativeModelPreparationV1,
  fingerprint: RouteFingerprint,
  inputTokens: number,
  outputTokens: number,
): Promise<string> {
  freeOnly(preparation);
  assertFingerprint(fingerprint, preparation);
  return quoteRef(fingerprint, preparation, inputTokens, outputTokens);
}

function assertProbeFingerprint(
  fingerprint: RouteFingerprint,
  preparation: ProviderNativeModelPreparationV1,
): void {
  const deployment = preparation.probe_deployment;
  if (fingerprint.route_ref !== deployment.route_ref || fingerprint.route_version !== deployment.route_version ||
      fingerprint.prompt_generation !== deployment.prompt_generation || fingerprint.schema_generation !== deployment.schema_generation ||
      fingerprint.parameters_digest !== deployment.parameters_digest ||
      fingerprint.pricing_snapshot_ref !== preparation.pricing_snapshot_ref ||
      fingerprint.provider !== "openrouter" || fingerprint.exact_model_id !== preparation.transport_policy.model) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "native connectivity quote fingerprint differs from its pinned probe tuple");
  }
}

export async function providerNativeModelProbeZeroPriceQuoteRef(
  preparation: ProviderNativeModelPreparationV1,
  fingerprint: RouteFingerprint,
  inputTokens: number,
  outputTokens: number,
): Promise<string> {
  freeOnly(preparation);
  assertProbeFingerprint(fingerprint, preparation);
  return quoteRef(fingerprint, preparation, inputTokens, outputTokens);
}

async function quoteRef(
  fingerprint: RouteFingerprint,
  preparation: ProviderNativeModelPreparationV1,
  inputTokens: number,
  outputTokens: number,
): Promise<string> {
  count(inputTokens, "native input token count");
  count(outputTokens, "native output token count");
  const rule = await providerNativeModelZeroPriceRule(preparation);
  const digestValue = await modelGatewaySha256(canonicalModelGatewayJson({
    protocol: PROVIDER_NATIVE_MODEL_ZERO_PRICE_PROTOCOL,
    rule,
    fingerprint,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  }));
  return `provider-native-zero-price-${digestValue}`;
}

/**
 * Dedicated quote port for free-only native requests. Its zero result is valid
 * only with the immutable zero-rate snapshot and exact policy-bound native
 * request. The transport policy emits allow_fallbacks:false and four zero
 * max_price fields on the actual OpenRouter request.
 */
export function createProviderNativeModelZeroPricePort(
  preparation: ProviderNativeModelPreparationV1,
  snapshot: ResearchModelPricingSnapshot,
): ModelGatewayPricingPort {
  assertSnapshot(preparation, snapshot);
  return Object.freeze({
    async quote(rawInput: ModelGatewayPricingQuoteInput): Promise<ModelGatewayPricingQuote> {
      const input = exactRecord(rawInput, new Set(["fingerprint", "input_tokens", "output_tokens", "pricing_snapshot_ref"]), "native zero-price quote input");
      if (input.pricing_snapshot_ref !== preparation.pricing_snapshot_ref) {
        providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "native zero-price quote selected another pricing snapshot");
      }
      const quoteRef = await providerNativeModelZeroPriceQuoteRef(
        preparation,
        decodeFingerprint(input.fingerprint),
        count(input.input_tokens, "native input token count"),
        count(input.output_tokens, "native output token count"),
      );
      return Object.freeze({
        quote_ref: quoteRef,
        pricing_snapshot_ref: preparation.pricing_snapshot_ref,
        billed_usd: 0,
      });
    },
  });
}
