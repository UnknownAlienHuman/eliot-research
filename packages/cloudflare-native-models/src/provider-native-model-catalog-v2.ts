import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
  validateModelGatewayTransportPolicy,
  type ModelGatewayPricingPort,
  type ModelGatewayApi,
  type ModelGatewayRequestCapabilitiesV1,
  type ModelGatewayTransportPolicyV1,
} from "@eliotr/cloudflare-ai";
import { decodeModelRouteDeployment, type ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import type { ProviderNativeModelStage } from "./provider-native-model-candidate.js";

export const PROVIDER_NATIVE_MODEL_CATALOG_V2_KIND = "provider-native-v2" as const;
export const PROVIDER_NATIVE_MODEL_CATALOG_V2_PREPARATION_PROTOCOL =
  "eliotr.provider-native-model-preparation.v2" as const;
export const PROVIDER_NATIVE_MODEL_CATALOG_V2_OBSERVATION_PROTOCOL =
  "eliotr.provider-native-model-observation.v2" as const;
export const PROVIDER_NATIVE_MODEL_CATALOG_V2_CANDIDATE_PROTOCOL =
  "eliotr.provider-native-model-candidate.v2" as const;
export const PROVIDER_NATIVE_MODEL_CATALOG_V2_PROOF_PROTOCOL =
  "eliotr.provider-native-model-qualification.v2" as const;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;
const MODEL_IDENTIFIER = /^[A-Za-z0-9~][A-Za-z0-9:._/~@-]{0,255}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ALIAS = /^eliotr-[a-f0-9]{48}$/u;
const PREPARATION_KEYS = new Set([
  "protocol", "owner_ref", "project_id", "owner_operation_id", "consent_operation_id", "stage",
  "provider_id", "provider_slug", "provider_operation_id", "model_id", "prepared_at",
  "preparation_expires_at", "deployment", "probe_deployment", "transport_policy", "key_binding",
  "pricing_snapshot_expires_at", "catalog_sdk", "sdk_base_url", "catalog_metadata_sha256",
  "pricing_snapshot_ref", "pricing_snapshot_sha256", "request_sha256", "prompt_sha256", "schema_sha256",
  "parameters_sha256", "probe_prompt_sha256", "probe_schema_sha256", "probe_parameters_sha256",
]);
const BINDING_KEYS = new Set([
  "protocol", "owner_ref", "project_id", "operation_id", "provider_id", "provider_slug", "account_id",
  "gateway_id", "alias", "provider_config_id", "configuration_metadata_sha256",
]);
const SELECTION_KEYS = new Set([
  "candidate_kind", "stage", "route_ref", "route_version", "candidate_ref", "candidate_sha256",
  "qualification_ref", "qualification_sha256", "transport_policy",
]);
const CANDIDATE_KEYS = new Set([
  "protocol", "candidate_kind", "preparation", "preparation_ref", "preparation_sha256", "observation_ref",
  "observation_sha256", "qualification_tier", "verified_at", "qualification_expires_at",
]);
const PROOF_KEYS = new Set([
  "protocol", "candidate_kind", "candidate_ref", "candidate_sha256", "preparation_ref", "preparation_sha256",
  "observation_ref", "observation_sha256", "stage", "owner_ref", "project_id", "consent_operation_id",
  "provider_id", "provider_slug", "provider_operation_id", "model_id", "pricing_snapshot_ref",
  "pricing_snapshot_sha256", "catalog_sdk", "sdk_base_url", "catalog_metadata_sha256",
  "qualification_tier", "qualification_purpose", "verified_at", "expires_at",
]);

export class ProviderNativeModelCatalogV2Error extends Error {
  public constructor(public readonly code: "INPUT_INVALID" | "AUTHORITY_STALE" | "PROOF_INVALID", message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProviderNativeModelCatalogV2Error";
  }
}

function fail(code: ProviderNativeModelCatalogV2Error["code"], message: string, cause?: unknown): never {
  throw new ProviderNativeModelCatalogV2Error(code, message, cause);
}

function object(value: unknown, keys: ReadonlySet<string>, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return fail("INPUT_INVALID", `${label} must be a plain object`);
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.size || Object.keys(result).some((key) => !keys.has(key))) {
    return fail("INPUT_INVALID", `${label} has missing or unsupported fields`);
  }
  return result;
}

function id(value: unknown, label: string, pattern = IDENTIFIER): string {
  if (typeof value !== "string" || !pattern.test(value)) return fail("INPUT_INVALID", `${label} is invalid`);
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) return fail("INPUT_INVALID", `${label} is invalid`);
  return value;
}

function utc(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    return fail("INPUT_INVALID", `${label} must be canonical UTC`);
  }
  return value;
}

function sdkName(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[@A-Za-z0-9][@A-Za-z0-9._/+:-]{0,255}$/u.test(value)) {
    return fail("INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

function httpsUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f]/u.test(value)) {
    return fail("INPUT_INVALID", `${label} is invalid`);
  }
  let parsed: URL;
  try { parsed = new URL(value); } catch (cause) { return fail("INPUT_INVALID", `${label} is invalid`, cause); }
  if (parsed.protocol !== "https:" || parsed.username.length > 0 || parsed.password.length > 0 || parsed.hash.length > 0) {
    return fail("INPUT_INVALID", `${label} must be an HTTPS base URL without credentials or fragment`);
  }
  return value;
}

function stage(value: unknown): ProviderNativeModelStage {
  if (value !== "ANALYZE_BRANCHES" && value !== "AUDIT_CLAIMS" && value !== "COUNTER_SEARCH" && value !== "SYNTHESIZE") {
    return fail("INPUT_INVALID", "native catalog model stage is invalid");
  }
  return value;
}

export interface ProviderNativeModelCatalogBindingV2 {
  readonly protocol: "eliotr.research-provider-key-configuration.v1";
  readonly owner_ref: string;
  readonly project_id: string;
  readonly operation_id: string;
  readonly provider_id: string;
  readonly provider_slug: string;
  readonly account_id: string;
  readonly gateway_id: string;
  readonly alias: string;
  readonly provider_config_id: string;
  readonly configuration_metadata_sha256: string;
}

export interface ProviderNativeModelCatalogPreparationV2 {
  readonly protocol: typeof PROVIDER_NATIVE_MODEL_CATALOG_V2_PREPARATION_PROTOCOL;
  readonly owner_ref: string;
  readonly project_id: string;
  readonly owner_operation_id: string;
  readonly consent_operation_id: string;
  readonly stage: ProviderNativeModelStage;
  readonly provider_id: string;
  readonly provider_slug: string;
  readonly provider_operation_id: string;
  readonly model_id: string;
  readonly prepared_at: string;
  readonly preparation_expires_at: string;
  readonly deployment: ModelRouteDeployment;
  readonly probe_deployment: ModelRouteDeployment;
  readonly transport_policy: ModelGatewayTransportPolicyV1;
  readonly key_binding: ProviderNativeModelCatalogBindingV2;
  readonly pricing_snapshot_ref: string;
  readonly pricing_snapshot_sha256: string;
  readonly pricing_snapshot_expires_at: string;
  readonly catalog_sdk: string;
  readonly sdk_base_url: string;
  readonly catalog_metadata_sha256: string;
  readonly request_sha256: string;
  readonly prompt_sha256: string;
  readonly schema_sha256: string;
  readonly parameters_sha256: string;
  readonly probe_prompt_sha256: string;
  readonly probe_schema_sha256: string;
  readonly probe_parameters_sha256: string;
}

export type ProviderNativeModelCatalogPreparationInputV2 = Omit<ProviderNativeModelCatalogPreparationV2,
  "protocol" | "key_binding" | "prepared_at" | "preparation_expires_at" | "pricing_snapshot_expires_at" |
  "catalog_sdk" | "sdk_base_url" | "catalog_metadata_sha256">;

export interface ProviderNativeModelCatalogObservationV2 {
  readonly protocol: typeof PROVIDER_NATIVE_MODEL_CATALOG_V2_OBSERVATION_PROTOCOL;
  readonly qualification_purpose: "structured-output-connectivity";
  readonly api: ModelGatewayTransportPolicyV1["api"];
  readonly provider_id: string;
  readonly provider_slug: string;
  readonly model_id: string;
  readonly consent_request_sha256: string;
  readonly request_body_sha256: string;
  readonly response_body_sha256: string;
  readonly response_model: string;
  readonly gateway_log_id: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly verified_at: string;
  readonly expires_at: string;
}

export interface ProviderNativeModelCatalogCandidateV2 {
  readonly protocol: typeof PROVIDER_NATIVE_MODEL_CATALOG_V2_CANDIDATE_PROTOCOL;
  readonly candidate_kind: typeof PROVIDER_NATIVE_MODEL_CATALOG_V2_KIND;
  readonly preparation: ProviderNativeModelCatalogPreparationV2;
  readonly preparation_ref: string;
  readonly preparation_sha256: string;
  readonly observation_ref: string;
  readonly observation_sha256: string;
  readonly qualification_tier: "LIVE";
  readonly verified_at: string;
  readonly qualification_expires_at: string;
}

export interface ProviderNativeModelCatalogProofV2 {
  readonly protocol: typeof PROVIDER_NATIVE_MODEL_CATALOG_V2_PROOF_PROTOCOL;
  readonly candidate_kind: typeof PROVIDER_NATIVE_MODEL_CATALOG_V2_KIND;
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
  readonly preparation_ref: string;
  readonly preparation_sha256: string;
  readonly observation_ref: string;
  readonly observation_sha256: string;
  readonly stage: ProviderNativeModelStage;
  readonly owner_ref: string;
  readonly project_id: string;
  readonly consent_operation_id: string;
  readonly provider_id: string;
  readonly provider_slug: string;
  readonly provider_operation_id: string;
  readonly model_id: string;
  readonly pricing_snapshot_ref: string;
  readonly pricing_snapshot_sha256: string;
  readonly catalog_sdk: string;
  readonly sdk_base_url: string;
  readonly catalog_metadata_sha256: string;
  readonly qualification_tier: "LIVE";
  readonly qualification_purpose: "structured-output-connectivity";
  readonly verified_at: string;
  readonly expires_at: string;
}

export interface ProviderNativeModelCatalogSelectionV2 {
  readonly candidate_kind: typeof PROVIDER_NATIVE_MODEL_CATALOG_V2_KIND;
  readonly stage: ProviderNativeModelStage;
  readonly route_ref: string;
  readonly route_version: string;
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
  readonly qualification_ref: string;
  readonly qualification_sha256: string;
  readonly transport_policy: ModelGatewayTransportPolicyV1;
}

export interface ProviderNativeModelCatalogCandidateBundleV2 {
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
  readonly candidate_json: string;
  readonly candidate: ProviderNativeModelCatalogCandidateV2;
  readonly qualification_ref: string;
  readonly qualification_sha256: string;
  readonly qualification_json: string;
  readonly qualification: ProviderNativeModelCatalogProofV2;
  readonly selection: ProviderNativeModelCatalogSelectionV2;
}

export interface ProviderNativeModelCatalogPricingSnapshotV2 {
  readonly pricing_snapshot_ref: string;
  readonly snapshot_sha256: string;
  readonly provider_id: string;
  readonly provider_slug: string;
  readonly exact_model_id: string;
  readonly api: ModelGatewayApi;
  readonly capabilities: ModelGatewayRequestCapabilitiesV1;
  readonly catalog_sdk: string;
  readonly sdk_base_url: string;
  readonly catalog_metadata_sha256: string;
  readonly effective_at: string;
  readonly expires_at: string;
  /** Pricing adapter from the same trusted snapshot; the v2 flow has no price default. */
  readonly pricing_port: ModelGatewayPricingPort;
}

export interface ResolvedProviderNativeModelCatalogV2 {
  readonly selection: ProviderNativeModelCatalogSelectionV2;
  readonly candidate: Readonly<{ candidate_ref: string; candidate_sha256: string; candidate: ProviderNativeModelCatalogCandidateV2 }>;
  readonly proof: Readonly<{ qualification_ref: string; qualification_sha256: string; qualification: ProviderNativeModelCatalogProofV2 }>;
  readonly observation: ProviderNativeModelCatalogObservationV2;
  readonly pricing_snapshot: ProviderNativeModelCatalogPricingSnapshotV2;
  readonly deployment: ModelRouteDeployment;
  readonly pricing_port: ModelGatewayPricingPort;
}

export interface ProviderNativeModelCatalogV2AuthorityPort {
  prepare(input: ProviderNativeModelCatalogPreparationInputV2): Promise<Readonly<{
    preparation_ref: string; preparation_sha256: string; preparation: ProviderNativeModelCatalogPreparationV2;
  }>>;
  qualify(input: Readonly<{
    owner_ref: string; project_id: string; owner_operation_id: string; stage: ProviderNativeModelStage;
    preparation_ref: string; preparation_sha256: string;
    executor: Readonly<{ executeOnce(preparation: ProviderNativeModelCatalogPreparationV2):
      Promise<ProviderNativeModelCatalogObservationV2 & { request_body_bytes: Uint8Array; response_body_bytes: Uint8Array }> }>;
  }>): Promise<ProviderNativeModelCatalogSelectionV2>;
  resolvePinned(input: Readonly<{
    selection: unknown; owner_ref: string; project_id: string; allow_expired_snapshot_v2: boolean;
  }>): Promise<ResolvedProviderNativeModelCatalogV2>;
  revoke(input: Readonly<{
    owner_ref: string; project_id: string; selection: unknown; reason: string;
  }>): Promise<void>;
}

export function decodeProviderNativeModelCatalogBindingV2(raw: unknown): ProviderNativeModelCatalogBindingV2 {
  const value = object(raw, BINDING_KEYS, "catalog provider binding");
  if (value.protocol !== "eliotr.research-provider-key-configuration.v1" ||
      typeof value.operation_id !== "string" || !UUID.test(value.operation_id) ||
      typeof value.account_id !== "string" || !/^[a-f0-9]{32}$/u.test(value.account_id) ||
      typeof value.alias !== "string" || !ALIAS.test(value.alias) ||
      typeof value.provider_id !== "string" || !IDENTIFIER.test(value.provider_id) ||
      typeof value.provider_slug !== "string" || !IDENTIFIER.test(value.provider_slug)) {
    return fail("INPUT_INVALID", "configured catalog provider binding is invalid");
  }
  return Object.freeze({ protocol: "eliotr.research-provider-key-configuration.v1",
    owner_ref: id(value.owner_ref, "provider owner"), project_id: id(value.project_id, "provider project"),
    operation_id: value.operation_id, provider_id: value.provider_id, provider_slug: value.provider_slug,
    account_id: value.account_id, gateway_id: id(value.gateway_id, "gateway id"), alias: value.alias,
    provider_config_id: id(value.provider_config_id, "provider config id"),
    configuration_metadata_sha256: digest(value.configuration_metadata_sha256, "provider metadata digest") });
}

export function decodeProviderNativeModelCatalogPreparationV2(raw: unknown): ProviderNativeModelCatalogPreparationV2 {
  const value = object(raw, PREPARATION_KEYS, "catalog model preparation");
  let deployment: ModelRouteDeployment;
  let probeDeployment: ModelRouteDeployment;
  let policy: ModelGatewayTransportPolicyV1;
  try {
    deployment = decodeModelRouteDeployment(value.deployment);
    probeDeployment = decodeModelRouteDeployment(value.probe_deployment);
    policy = validateModelGatewayTransportPolicy(value.transport_policy);
  } catch (cause) { return fail("INPUT_INVALID", "catalog model deployment or transport policy is invalid", cause); }
  const binding = decodeProviderNativeModelCatalogBindingV2(value.key_binding);
  const ownerRef = id(value.owner_ref, "catalog model owner");
  const projectId = id(value.project_id, "catalog model project");
  const providerId = id(value.provider_id, "logical provider id");
  const providerSlug = id(value.provider_slug, "physical provider slug");
  const modelId = id(value.model_id, "catalog model id", MODEL_IDENTIFIER);
  const operationId = value.owner_operation_id;
  const consentId = value.consent_operation_id;
  const preparedAt = utc(value.prepared_at, "preparation time");
  const preparationExpiresAt = utc(value.preparation_expires_at, "preparation expiry");
  const pricingExpiresAt = utc(value.pricing_snapshot_expires_at, "pricing snapshot expiry");
  if (value.protocol !== PROVIDER_NATIVE_MODEL_CATALOG_V2_PREPARATION_PROTOCOL ||
      typeof operationId !== "string" || !UUID.test(operationId) ||
      typeof consentId !== "string" || !UUID.test(consentId) ||
      typeof value.provider_operation_id !== "string" || !UUID.test(value.provider_operation_id) ||
      value.provider_operation_id !== binding.operation_id || binding.owner_ref !== ownerRef || binding.project_id !== projectId ||
      binding.provider_id !== providerId || binding.provider_slug !== providerSlug ||
      policy.provider !== providerSlug || policy.model !== modelId || policy.api === "compat-chat-completions" ||
      policy.billing.mode !== "byok" || policy.billing.alias !== binding.alias || binding.alias === "default" ||
      deployment.pricing_snapshot_ref !== value.pricing_snapshot_ref ||
      probeDeployment.route_ref !== deployment.route_ref || probeDeployment.route_version !== deployment.route_version ||
      probeDeployment.pricing_snapshot_ref !== deployment.pricing_snapshot_ref ||
      Date.parse(pricingExpiresAt) <= Date.parse(preparedAt) ||
      Date.parse(preparationExpiresAt) <= Date.parse(preparedAt) || Date.parse(preparationExpiresAt) > Date.parse(pricingExpiresAt)) {
    return fail("INPUT_INVALID", "catalog model preparation identity is inconsistent");
  }
  if (value.consent_operation_id !== operationId) {
    return fail("INPUT_INVALID", "catalog model consent must be the exact owner operation");
  }
  const parameters = digest(value.parameters_sha256, "request parameters digest");
  const probeParameters = digest(value.probe_parameters_sha256, "probe parameters digest");
  if (parameters !== deployment.parameters_digest || probeParameters !== probeDeployment.parameters_digest) {
    return fail("INPUT_INVALID", "catalog model request parameters differ from the deployment");
  }
  return Object.freeze({
    protocol: PROVIDER_NATIVE_MODEL_CATALOG_V2_PREPARATION_PROTOCOL,
    owner_ref: ownerRef, project_id: projectId, owner_operation_id: operationId, consent_operation_id: consentId,
    stage: stage(value.stage), provider_id: providerId, provider_slug: providerSlug,
    provider_operation_id: value.provider_operation_id, model_id: modelId,
    prepared_at: preparedAt,
    preparation_expires_at: preparationExpiresAt,
    deployment, probe_deployment: probeDeployment, transport_policy: policy, key_binding: binding,
    pricing_snapshot_ref: id(value.pricing_snapshot_ref, "pricing snapshot reference"),
    pricing_snapshot_sha256: digest(value.pricing_snapshot_sha256, "pricing snapshot digest"),
    pricing_snapshot_expires_at: pricingExpiresAt,
    catalog_sdk: sdkName(value.catalog_sdk, "catalog SDK"), sdk_base_url: httpsUrl(value.sdk_base_url, "catalog SDK base URL"),
    catalog_metadata_sha256: digest(value.catalog_metadata_sha256, "catalog metadata digest"),
    request_sha256: digest(value.request_sha256, "owner consent request digest"),
    prompt_sha256: digest(value.prompt_sha256, "prompt digest"), schema_sha256: digest(value.schema_sha256, "schema digest"),
    parameters_sha256: parameters, probe_prompt_sha256: digest(value.probe_prompt_sha256, "probe prompt digest"),
    probe_schema_sha256: digest(value.probe_schema_sha256, "probe schema digest"), probe_parameters_sha256: probeParameters,
  });
}

export function decodeProviderNativeModelCatalogObservationV2(raw: unknown): ProviderNativeModelCatalogObservationV2 {
  const keys = new Set(["protocol", "qualification_purpose", "api", "provider_id", "provider_slug", "model_id",
    "consent_request_sha256", "request_body_sha256", "response_body_sha256", "response_model", "gateway_log_id",
    "input_tokens", "output_tokens", "verified_at", "expires_at"]);
  const value = object(raw, keys, "catalog model observation");
  const allowedApis = new Set(["openai-chat-completions", "openai-responses", "openrouter-chat-completions",
    "anthropic-messages", "custom-chat-completions", "custom-responses", "custom-anthropic-messages"]);
  if (value.protocol !== PROVIDER_NATIVE_MODEL_CATALOG_V2_OBSERVATION_PROTOCOL ||
      value.qualification_purpose !== "structured-output-connectivity" ||
      typeof value.api !== "string" || !allowedApis.has(value.api) ||
      typeof value.input_tokens !== "number" || !Number.isSafeInteger(value.input_tokens) || value.input_tokens < 0 ||
      typeof value.output_tokens !== "number" || !Number.isSafeInteger(value.output_tokens) || value.output_tokens < 0) {
    return fail("INPUT_INVALID", "catalog model observation is invalid");
  }
  const modelId = id(value.model_id, "observed model id", MODEL_IDENTIFIER);
  if (value.response_model !== modelId) return fail("PROOF_INVALID", "provider response model does not match the exact selected model");
  return Object.freeze({ protocol: PROVIDER_NATIVE_MODEL_CATALOG_V2_OBSERVATION_PROTOCOL,
    qualification_purpose: "structured-output-connectivity", api: value.api as ProviderNativeModelCatalogObservationV2["api"],
    provider_id: id(value.provider_id, "observed logical provider"), provider_slug: id(value.provider_slug, "observed physical provider"),
    model_id: modelId, consent_request_sha256: digest(value.consent_request_sha256, "consent request digest"),
    request_body_sha256: digest(value.request_body_sha256, "observed provider request digest"),
    response_body_sha256: digest(value.response_body_sha256, "observed provider response digest"), response_model: modelId,
    gateway_log_id: id(value.gateway_log_id, "Gateway log id"), input_tokens: value.input_tokens, output_tokens: value.output_tokens,
    verified_at: utc(value.verified_at, "observation time"), expires_at: utc(value.expires_at, "observation expiry") });
}

export function decodeProviderNativeModelCatalogSelectionV2(raw: unknown): ProviderNativeModelCatalogSelectionV2 {
  const value = object(raw, SELECTION_KEYS, "catalog model selection");
  let policy: ModelGatewayTransportPolicyV1;
  try { policy = validateModelGatewayTransportPolicy(value.transport_policy); }
  catch (cause) { return fail("INPUT_INVALID", "catalog model selection policy is invalid", cause); }
  if (value.candidate_kind !== PROVIDER_NATIVE_MODEL_CATALOG_V2_KIND ||
      policy.api === "compat-chat-completions" || policy.billing.mode !== "byok" || policy.billing.alias === "default") {
    return fail("INPUT_INVALID", "catalog model selection requires provider-native v2 and an exact saved BYOK alias");
  }
  return Object.freeze({ candidate_kind: PROVIDER_NATIVE_MODEL_CATALOG_V2_KIND, stage: stage(value.stage),
    route_ref: id(value.route_ref, "selection route"), route_version: id(value.route_version, "selection route version"),
    candidate_ref: id(value.candidate_ref, "candidate reference"), candidate_sha256: digest(value.candidate_sha256, "candidate digest"),
    qualification_ref: id(value.qualification_ref, "qualification reference"), qualification_sha256: digest(value.qualification_sha256, "qualification digest"),
    transport_policy: policy });
}

export async function createProviderNativeModelCatalogCandidateBundleV2(input: Readonly<{
  preparation: ProviderNativeModelCatalogPreparationV2;
  preparation_ref: string;
  preparation_sha256: string;
  observation: ProviderNativeModelCatalogObservationV2;
}>): Promise<ProviderNativeModelCatalogCandidateBundleV2> {
  const preparation = decodeProviderNativeModelCatalogPreparationV2(input.preparation);
  const observation = decodeProviderNativeModelCatalogObservationV2(input.observation);
  const canonicalPreparation = canonicalModelGatewayJson(preparation);
  const actualPreparationSha = await modelGatewaySha256(canonicalPreparation);
  if (observation.provider_id !== preparation.provider_id || observation.provider_slug !== preparation.provider_slug ||
      observation.model_id !== preparation.model_id || observation.api !== preparation.transport_policy.api ||
      actualPreparationSha !== input.preparation_sha256 ||
      input.preparation_ref !== `provider-native-model-preparation-v2-${actualPreparationSha}` ||
      observation.consent_request_sha256 !== preparation.request_sha256 ||
      Date.parse(observation.expires_at) <= Date.parse(observation.verified_at) ||
      Date.parse(observation.expires_at) > Date.parse(preparation.pricing_snapshot_expires_at)) {
    return fail("PROOF_INVALID", "catalog model observation does not match its exact preparation");
  }
  const preparationRef = id(input.preparation_ref, "preparation reference");
  const preparationSha = digest(input.preparation_sha256, "preparation digest");
  const observationSha = await modelGatewaySha256(canonicalModelGatewayJson(observation));
  const observationRef = `provider-native-model-observation-v2-${observationSha}`;
  const candidateBase = Object.freeze({ protocol: PROVIDER_NATIVE_MODEL_CATALOG_V2_CANDIDATE_PROTOCOL,
    candidate_kind: PROVIDER_NATIVE_MODEL_CATALOG_V2_KIND, preparation,
    preparation_ref: preparationRef, preparation_sha256: preparationSha,
    observation_ref: observationRef, observation_sha256: observationSha, qualification_tier: "LIVE" as const,
    verified_at: observation.verified_at, qualification_expires_at: observation.expires_at });
  const candidateJson = canonicalModelGatewayJson(candidateBase);
  const candidateSha = await modelGatewaySha256(candidateJson);
  const candidateRef = `provider-native-model-candidate-v2-${candidateSha}`;
  const proofBase: ProviderNativeModelCatalogProofV2 = Object.freeze({
    protocol: PROVIDER_NATIVE_MODEL_CATALOG_V2_PROOF_PROTOCOL,
    candidate_kind: PROVIDER_NATIVE_MODEL_CATALOG_V2_KIND, candidate_ref: candidateRef, candidate_sha256: candidateSha,
    preparation_ref: preparationRef, preparation_sha256: preparationSha,
    observation_ref: observationRef, observation_sha256: observationSha,
    stage: preparation.stage, owner_ref: preparation.owner_ref, project_id: preparation.project_id,
    consent_operation_id: preparation.consent_operation_id, provider_id: preparation.provider_id,
    provider_slug: preparation.provider_slug, provider_operation_id: preparation.provider_operation_id,
    model_id: preparation.model_id, pricing_snapshot_ref: preparation.pricing_snapshot_ref,
    pricing_snapshot_sha256: preparation.pricing_snapshot_sha256,
    catalog_sdk: preparation.catalog_sdk, sdk_base_url: preparation.sdk_base_url,
    catalog_metadata_sha256: preparation.catalog_metadata_sha256, qualification_tier: "LIVE",
    qualification_purpose: "structured-output-connectivity", verified_at: observation.verified_at, expires_at: observation.expires_at,
  });
  const proofJson = canonicalModelGatewayJson(proofBase);
  const proofSha = await modelGatewaySha256(proofJson);
  const proofRef = `provider-native-model-qualification-v2-${proofSha}`;
  const candidate = decodeProviderNativeModelCatalogCandidateV2(JSON.parse(candidateJson) as unknown);
  const qualification = decodeProviderNativeModelCatalogProofV2(proofBase);
  const selection = decodeProviderNativeModelCatalogSelectionV2({ candidate_kind: PROVIDER_NATIVE_MODEL_CATALOG_V2_KIND,
    stage: preparation.stage, route_ref: preparation.deployment.route_ref, route_version: preparation.deployment.route_version,
    candidate_ref: candidateRef, candidate_sha256: candidateSha, qualification_ref: proofRef,
    qualification_sha256: proofSha, transport_policy: preparation.transport_policy });
  return Object.freeze({ candidate_ref: candidateRef, candidate_sha256: candidateSha, candidate_json: candidateJson,
    candidate, qualification_ref: proofRef, qualification_sha256: proofSha, qualification_json: proofJson, qualification,
    selection });
}

export function decodeProviderNativeModelCatalogCandidateV2(raw: unknown): ProviderNativeModelCatalogCandidateV2 {
  const value = object(raw, CANDIDATE_KEYS, "catalog model candidate");
  if (value.protocol !== PROVIDER_NATIVE_MODEL_CATALOG_V2_CANDIDATE_PROTOCOL ||
      value.candidate_kind !== PROVIDER_NATIVE_MODEL_CATALOG_V2_KIND || value.qualification_tier !== "LIVE") {
    return fail("INPUT_INVALID", "catalog model candidate protocol or qualification tier is invalid");
  }
  const preparation = decodeProviderNativeModelCatalogPreparationV2(value.preparation);
  const verifiedAt = utc(value.verified_at, "candidate verification time");
  const expiresAt = utc(value.qualification_expires_at, "candidate expiry");
  if (Date.parse(expiresAt) <= Date.parse(verifiedAt)) return fail("INPUT_INVALID", "catalog model candidate expiry is invalid");
  return Object.freeze({ protocol: PROVIDER_NATIVE_MODEL_CATALOG_V2_CANDIDATE_PROTOCOL,
    candidate_kind: PROVIDER_NATIVE_MODEL_CATALOG_V2_KIND, preparation,
    preparation_ref: id(value.preparation_ref, "preparation reference"),
    preparation_sha256: digest(value.preparation_sha256, "preparation digest"),
    observation_ref: id(value.observation_ref, "observation reference"),
    observation_sha256: digest(value.observation_sha256, "observation digest"),
    qualification_tier: "LIVE", verified_at: verifiedAt, qualification_expires_at: expiresAt });
}

export function decodeProviderNativeModelCatalogProofV2(raw: unknown): ProviderNativeModelCatalogProofV2 {
  const value = object(raw, PROOF_KEYS, "catalog model qualification proof");
  if (value.protocol !== PROVIDER_NATIVE_MODEL_CATALOG_V2_PROOF_PROTOCOL ||
      value.candidate_kind !== PROVIDER_NATIVE_MODEL_CATALOG_V2_KIND || value.qualification_tier !== "LIVE" ||
      value.qualification_purpose !== "structured-output-connectivity") {
    return fail("INPUT_INVALID", "catalog model proof protocol or purpose is invalid");
  }
  const proof = Object.freeze({ protocol: PROVIDER_NATIVE_MODEL_CATALOG_V2_PROOF_PROTOCOL,
    candidate_kind: PROVIDER_NATIVE_MODEL_CATALOG_V2_KIND, candidate_ref: id(value.candidate_ref, "candidate ref"),
    candidate_sha256: digest(value.candidate_sha256, "candidate digest"), preparation_ref: id(value.preparation_ref, "preparation ref"),
    preparation_sha256: digest(value.preparation_sha256, "preparation digest"), observation_ref: id(value.observation_ref, "observation ref"),
    observation_sha256: digest(value.observation_sha256, "observation digest"), stage: stage(value.stage),
    owner_ref: id(value.owner_ref, "proof owner"), project_id: id(value.project_id, "proof project"),
    consent_operation_id: id(value.consent_operation_id, "consent operation"), provider_id: id(value.provider_id, "proof logical provider"),
    provider_slug: id(value.provider_slug, "proof physical provider"), provider_operation_id: id(value.provider_operation_id, "provider operation"),
    model_id: id(value.model_id, "proof model", MODEL_IDENTIFIER), pricing_snapshot_ref: id(value.pricing_snapshot_ref, "pricing snapshot ref"),
    pricing_snapshot_sha256: digest(value.pricing_snapshot_sha256, "pricing snapshot digest"),
    catalog_sdk: sdkName(value.catalog_sdk, "proof catalog SDK"),
    sdk_base_url: httpsUrl(value.sdk_base_url, "proof SDK base URL"),
    catalog_metadata_sha256: digest(value.catalog_metadata_sha256, "proof catalog metadata digest"),
    qualification_tier: "LIVE" as const,
    qualification_purpose: "structured-output-connectivity" as const,
    verified_at: utc(value.verified_at, "proof verification time"), expires_at: utc(value.expires_at, "proof expiry") });
  if (!UUID.test(proof.consent_operation_id) || !UUID.test(proof.provider_operation_id) ||
      Date.parse(proof.expires_at) <= Date.parse(proof.verified_at)) return fail("INPUT_INVALID", "catalog model proof identity is invalid");
  return proof;
}
