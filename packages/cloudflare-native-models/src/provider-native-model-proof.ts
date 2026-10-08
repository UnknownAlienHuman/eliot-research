import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
} from "@eliotr/cloudflare-ai";
import {
  PROVIDER_NATIVE_MODEL_CANDIDATE_KIND,
  PROVIDER_NATIVE_MODEL_CANDIDATE_PROTOCOL,
  ProviderNativeModelAuthorityError,
  decodeProviderNativeModelCandidate,
  providerNativeModelFailure,
  type ProviderNativeModelCandidateV1,
  type ProviderNativeModelPreparationV1,
} from "./provider-native-model-candidate.js";
import type { StoredProviderNativeModelObservationV1 } from "./provider-native-model-observation.js";
import { decodeModelRouteDeployment, type ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import {
  decodeProviderNativeModelZeroPriceRule,
  providerNativeModelProbeZeroPriceQuoteRef,
  providerNativeModelZeroPriceRule,
  type ProviderNativeModelZeroPriceRuleV1,
} from "./provider-native-model-zero-price.js";

export const PROVIDER_NATIVE_MODEL_QUALIFICATION_PROTOCOL = "eliotr.provider-native-model-qualification.v1" as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PROOF_KEYS = new Set([
  "candidate_kind", "candidate_ref", "candidate_sha256", "protocol", "qualification", "route_ref", "route_version", "stage",
]);
const QUALIFICATION_KEYS = new Set([
  "account_id", "alias", "api", "billed_usd", "exact_model_id", "expires_at", "gateway_id", "gateway_log_id", "input_tokens", "observation_ref",
  "observation_sha256", "output_tokens", "pricing_snapshot_ref", "pricing_snapshot_sha256",
  "installed_deployment", "installed_parameters_sha256", "installed_prompt_sha256", "installed_schema_sha256",
  "pricing_quote_ref", "probe_deployment", "probe_parameters_sha256", "probe_prompt_sha256", "probe_schema_sha256",
  "protocol", "provider", "provider_config_id", "provider_key_metadata_sha256",
  "provider_key_operation_id", "qualification_purpose", "request_body_sha256", "response_body_byte_length",
  "response_body_sha256", "response_model", "tier", "verified_at",
  "zero_price_enforcement",
]);

export interface ProviderNativeModelQualificationProofV1 {
  readonly protocol: typeof PROVIDER_NATIVE_MODEL_QUALIFICATION_PROTOCOL;
  readonly candidate_kind: typeof PROVIDER_NATIVE_MODEL_CANDIDATE_KIND;
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
  readonly stage: ProviderNativeModelPreparationV1["stage"];
  readonly route_ref: string;
  readonly route_version: string;
  readonly qualification: Readonly<{
    readonly protocol: typeof PROVIDER_NATIVE_MODEL_QUALIFICATION_PROTOCOL;
    readonly tier: "LIVE";
    readonly verified_at: string;
    readonly expires_at: string;
    readonly observation_ref: string;
    readonly observation_sha256: string;
    readonly gateway_log_id: string;
    readonly provider: "openrouter";
    readonly api: "openrouter-chat-completions";
    readonly exact_model_id: string;
    readonly account_id: string;
    readonly gateway_id: string;
    readonly provider_config_id: string;
    readonly provider_key_operation_id: string;
    readonly provider_key_metadata_sha256: string;
    readonly qualification_purpose: "structured-output-connectivity";
    readonly alias: string;
    readonly pricing_snapshot_ref: string;
    readonly pricing_snapshot_sha256: string;
    readonly pricing_quote_ref: string;
    readonly zero_price_enforcement?: ProviderNativeModelZeroPriceRuleV1;
    readonly installed_deployment: ModelRouteDeployment;
    readonly installed_prompt_sha256: string;
    readonly installed_schema_sha256: string;
    readonly installed_parameters_sha256: string;
    readonly probe_deployment: ModelRouteDeployment;
    readonly probe_prompt_sha256: string;
    readonly probe_schema_sha256: string;
    readonly probe_parameters_sha256: string;
    readonly request_body_sha256: string;
    readonly response_body_sha256: string;
    readonly response_body_byte_length: number;
    readonly response_model: string;
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly billed_usd: number;
  }>;
}

export interface StoredProviderNativeModelQualificationProofV1 {
  readonly qualification_ref: string;
  readonly qualification_sha256: string;
  readonly qualification_json: string;
  readonly qualification: ProviderNativeModelQualificationProofV1;
}

export interface ProviderNativeModelCandidateProofBundleV1 {
  readonly candidate: Readonly<{
    readonly candidate_ref: string;
    readonly candidate_sha256: string;
    readonly candidate_json: string;
    readonly value: ProviderNativeModelCandidateV1;
  }>;
  readonly proof: StoredProviderNativeModelQualificationProofV1;
}

function proofObject(value: unknown, keys: ReadonlySet<string>, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", `${label} is malformed`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", `${label} is malformed`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.has(key))) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", `${label} contains unsupported fields`);
  }
  return record;
}

function proofId(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", `${label} is invalid`);
  return value;
}

function proofSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", `${label} is invalid`);
  return value;
}

function proofTime(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", `${label} is invalid`);
  }
  return value;
}

function proofCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", `${label} is invalid`);
  }
  return value;
}

export function decodeProviderNativeModelQualificationProof(raw: unknown): ProviderNativeModelQualificationProofV1 {
  const value = proofObject(raw, PROOF_KEYS, "native qualification proof");
  const q = proofObject(value.qualification, QUALIFICATION_KEYS, "native qualification evidence");
  let installedDeployment: ModelRouteDeployment;
  let probeDeployment: ModelRouteDeployment;
  try {
    installedDeployment = decodeModelRouteDeployment(q.installed_deployment);
    probeDeployment = decodeModelRouteDeployment(q.probe_deployment);
  } catch (cause) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "native proof deployment bindings are malformed", cause);
  }
  if (value.protocol !== PROVIDER_NATIVE_MODEL_QUALIFICATION_PROTOCOL ||
      value.candidate_kind !== PROVIDER_NATIVE_MODEL_CANDIDATE_KIND ||
      q.protocol !== PROVIDER_NATIVE_MODEL_QUALIFICATION_PROTOCOL || q.tier !== "LIVE" || q.provider !== "openrouter" ||
      q.api !== "openrouter-chat-completions" || q.qualification_purpose !== "structured-output-connectivity") {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "native qualification proof protocol or tier is invalid");
  }
  if (typeof q.billed_usd !== "number" || !Number.isFinite(q.billed_usd) || q.billed_usd < 0) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "native qualification billed amount is invalid");
  }
  const verifiedAt = proofTime(q.verified_at, "native verification time");
  const expiresAt = proofTime(q.expires_at, "native qualification expiry");
  if (Date.parse(expiresAt) <= Date.parse(verifiedAt)) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "native qualification expiry is invalid");
  }
  const zeroPriceRule = q.zero_price_enforcement === undefined
    ? undefined
    : decodeProviderNativeModelZeroPriceRule(q.zero_price_enforcement);
  if (zeroPriceRule !== undefined &&
      (q.billed_usd !== 0 || zeroPriceRule.provider !== q.provider ||
        zeroPriceRule.exact_model_id !== q.exact_model_id ||
        zeroPriceRule.route_ref !== value.route_ref || zeroPriceRule.route_version !== value.route_version ||
        zeroPriceRule.pricing_snapshot_ref !== q.pricing_snapshot_ref ||
        zeroPriceRule.pricing_snapshot_sha256 !== q.pricing_snapshot_sha256)) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "native zero-price proof differs from its model, route or quote");
  }
  const preparationStage = value.stage;
  if (preparationStage !== "ANALYZE_BRANCHES" && preparationStage !== "AUDIT_CLAIMS" &&
      preparationStage !== "COUNTER_SEARCH" && preparationStage !== "SYNTHESIZE") {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "native qualification stage is invalid");
  }
  const installedParameters = proofSha(q.installed_parameters_sha256, "installed parameters digest");
  const probeParameters = proofSha(q.probe_parameters_sha256, "probe parameters digest");
  if (installedDeployment.route_ref !== value.route_ref || installedDeployment.route_version !== value.route_version ||
      probeDeployment.route_ref !== value.route_ref || probeDeployment.route_version !== value.route_version ||
      installedDeployment.parameters_digest !== installedParameters || probeDeployment.parameters_digest !== probeParameters ||
      installedDeployment.pricing_snapshot_ref !== q.pricing_snapshot_ref ||
      probeDeployment.pricing_snapshot_ref !== q.pricing_snapshot_ref) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "native proof app and probe bindings do not match the exact route tuple");
  }
  return Object.freeze({
    protocol: PROVIDER_NATIVE_MODEL_QUALIFICATION_PROTOCOL,
    candidate_kind: PROVIDER_NATIVE_MODEL_CANDIDATE_KIND,
    candidate_ref: proofId(value.candidate_ref, "candidate reference"),
    candidate_sha256: proofSha(value.candidate_sha256, "candidate digest"),
    stage: preparationStage,
    route_ref: proofId(value.route_ref, "route reference"),
    route_version: proofId(value.route_version, "route version"),
    qualification: Object.freeze({
      protocol: PROVIDER_NATIVE_MODEL_QUALIFICATION_PROTOCOL,
      tier: "LIVE",
      verified_at: verifiedAt,
      expires_at: expiresAt,
      observation_ref: proofId(q.observation_ref, "observation reference"),
      observation_sha256: proofSha(q.observation_sha256, "observation digest"),
      gateway_log_id: proofId(q.gateway_log_id, "gateway log ID"),
      provider: "openrouter",
      api: "openrouter-chat-completions",
      exact_model_id: proofId(q.exact_model_id, "exact provider model"),
      account_id: proofId(q.account_id, "provider account ID"),
      gateway_id: proofId(q.gateway_id, "provider gateway ID"),
      provider_config_id: proofId(q.provider_config_id, "provider config ID"),
      provider_key_operation_id: proofId(q.provider_key_operation_id, "provider key operation"),
      provider_key_metadata_sha256: proofSha(q.provider_key_metadata_sha256, "provider key metadata digest"),
      qualification_purpose: "structured-output-connectivity",
      alias: proofId(q.alias, "provider alias"),
      pricing_snapshot_ref: proofId(q.pricing_snapshot_ref, "pricing snapshot reference"),
      pricing_snapshot_sha256: proofSha(q.pricing_snapshot_sha256, "pricing snapshot digest"),
      pricing_quote_ref: proofId(q.pricing_quote_ref, "pricing quote reference"),
      installed_deployment: installedDeployment,
      installed_prompt_sha256: proofSha(q.installed_prompt_sha256, "installed prompt digest"),
      installed_schema_sha256: proofSha(q.installed_schema_sha256, "installed schema digest"),
      installed_parameters_sha256: installedParameters,
      probe_deployment: probeDeployment,
      probe_prompt_sha256: proofSha(q.probe_prompt_sha256, "probe prompt digest"),
      probe_schema_sha256: proofSha(q.probe_schema_sha256, "probe schema digest"),
      probe_parameters_sha256: probeParameters,
      request_body_sha256: proofSha(q.request_body_sha256, "request body digest"),
      response_body_sha256: proofSha(q.response_body_sha256, "response body digest"),
      response_body_byte_length: (() => {
        const length = proofCount(q.response_body_byte_length, "response body byte length");
        if (length < 1 || length > 32_768) providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "response body byte length is outside its bound");
        return length;
      })(),
      response_model: proofId(q.response_model, "response model"),
      input_tokens: proofCount(q.input_tokens, "input token count"),
      output_tokens: proofCount(q.output_tokens, "output token count"),
      billed_usd: q.billed_usd,
      ...(zeroPriceRule === undefined ? {} : { zero_price_enforcement: zeroPriceRule }),
    }),
  });
}

export async function createProviderNativeModelCandidateProofBundle(input: Readonly<{
  preparation: ProviderNativeModelPreparationV1;
  preparation_ref: string;
  preparation_sha256: string;
  observation: StoredProviderNativeModelObservationV1;
}>): Promise<ProviderNativeModelCandidateProofBundleV1> {
  const preparation = input.preparation;
  if (input.observation.preparation_ref !== input.preparation_ref ||
      input.observation.preparation_sha256 !== input.preparation_sha256 ||
      input.observation.protocol !== "eliotr.provider-native-model-observation.v1") {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "native observation is not bound to its exact preparation");
  }
  const candidateMaterial = Object.freeze({
    protocol: PROVIDER_NATIVE_MODEL_CANDIDATE_PROTOCOL,
    candidate_kind: PROVIDER_NATIVE_MODEL_CANDIDATE_KIND,
    preparation,
    preparation_ref: input.preparation_ref,
    preparation_sha256: input.preparation_sha256,
    observation_ref: input.observation.observation_ref,
    observation_sha256: input.observation.observation_sha256,
    qualification_tier: "LIVE" as const,
    verified_at: input.observation.verified_at,
    qualification_expires_at: input.observation.expires_at,
  });
  const candidateJson = canonicalModelGatewayJson(candidateMaterial);
  const candidateSha = await modelGatewaySha256(candidateJson);
  const candidateRef = `provider-native-model-candidate-${candidateSha}`;
  let candidate: ProviderNativeModelCandidateV1;
  try { candidate = decodeProviderNativeModelCandidate(candidateMaterial); }
  catch (cause) {
    if (cause instanceof ProviderNativeModelAuthorityError) throw cause;
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native model candidate could not be decoded", cause);
  }
  const execution = input.observation.execution;
  if (execution.probe_prompt_sha256 !== preparation.probe_prompt_sha256 ||
      execution.probe_schema_sha256 !== preparation.probe_schema_sha256 ||
      execution.probe_parameters_sha256 !== preparation.probe_parameters_sha256 ||
      execution.route_fingerprint.route_ref !== preparation.probe_deployment.route_ref ||
      execution.route_fingerprint.route_version !== preparation.probe_deployment.route_version ||
      execution.route_fingerprint.prompt_generation !== preparation.probe_deployment.prompt_generation ||
      execution.route_fingerprint.schema_generation !== preparation.probe_deployment.schema_generation ||
      execution.route_fingerprint.parameters_digest !== preparation.probe_deployment.parameters_digest) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "native connectivity observation differs from its prepared probe tuple");
  }
  const zeroPriceRule = preparation.transport_policy.billing.mode === "byok" &&
    preparation.transport_policy.billing.free_only === true
    ? await providerNativeModelZeroPriceRule(preparation)
    : undefined;
  if (zeroPriceRule !== undefined) {
    const expectedQuoteRef = await providerNativeModelProbeZeroPriceQuoteRef(
      preparation,
      execution.route_fingerprint,
      execution.input_tokens,
      execution.output_tokens,
    );
    if (execution.billed_usd !== 0 || execution.pricing_quote_ref !== expectedQuoteRef) {
      providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "free-only native execution lacks its policy-bound zero-price quote");
    }
  }
  const proofValue: ProviderNativeModelQualificationProofV1 = Object.freeze({
    protocol: PROVIDER_NATIVE_MODEL_QUALIFICATION_PROTOCOL,
    candidate_kind: PROVIDER_NATIVE_MODEL_CANDIDATE_KIND,
    candidate_ref: candidateRef,
    candidate_sha256: candidateSha,
    stage: preparation.stage,
    route_ref: preparation.deployment.route_ref,
    route_version: preparation.deployment.route_version,
    qualification: Object.freeze({
      protocol: PROVIDER_NATIVE_MODEL_QUALIFICATION_PROTOCOL,
      tier: "LIVE",
      verified_at: input.observation.verified_at,
      expires_at: input.observation.expires_at,
      observation_ref: input.observation.observation_ref,
      observation_sha256: input.observation.observation_sha256,
      gateway_log_id: execution.gateway_log_id,
      provider: "openrouter",
      api: execution.api,
      exact_model_id: preparation.transport_policy.model,
      account_id: preparation.key_binding.account_id,
      gateway_id: preparation.key_binding.gateway_id,
      provider_config_id: preparation.key_binding.provider_config_id,
      provider_key_operation_id: preparation.key_binding.operation_id,
      provider_key_metadata_sha256: preparation.key_binding.configuration_metadata_sha256,
      qualification_purpose: execution.qualification_purpose,
      alias: preparation.key_binding.alias,
      pricing_snapshot_ref: preparation.pricing_snapshot_ref,
      pricing_snapshot_sha256: preparation.pricing_snapshot_sha256,
      pricing_quote_ref: execution.pricing_quote_ref,
      ...(zeroPriceRule === undefined ? {} : { zero_price_enforcement: zeroPriceRule }),
      installed_deployment: preparation.deployment,
      installed_prompt_sha256: preparation.prompt_sha256,
      installed_schema_sha256: preparation.schema_sha256,
      installed_parameters_sha256: preparation.parameters_sha256,
      probe_deployment: preparation.probe_deployment,
      probe_prompt_sha256: execution.probe_prompt_sha256,
      probe_schema_sha256: execution.probe_schema_sha256,
      probe_parameters_sha256: execution.probe_parameters_sha256,
      request_body_sha256: execution.request_body_sha256,
      response_body_sha256: execution.response_body_sha256,
      response_body_byte_length: execution.response_body_byte_length,
      response_model: execution.response_model,
      input_tokens: execution.input_tokens,
      output_tokens: execution.output_tokens,
      billed_usd: execution.billed_usd,
    }),
  });
  const proofJson = canonicalModelGatewayJson(proofValue);
  if (new TextEncoder().encode(candidateJson).byteLength > 65536 || new TextEncoder().encode(proofJson).byteLength > 65536) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native candidate or proof exceeds its storage bound");
  }
  const proofSha = await modelGatewaySha256(proofJson);
  return Object.freeze({
    candidate: Object.freeze({
      candidate_ref: candidateRef,
      candidate_sha256: candidateSha,
      candidate_json: candidateJson,
      value: candidate,
    }),
    proof: Object.freeze({
      qualification_ref: `provider-native-model-qualification-${proofSha}`,
      qualification_sha256: proofSha,
      qualification_json: proofJson,
      qualification: proofValue,
    }),
  });
}
