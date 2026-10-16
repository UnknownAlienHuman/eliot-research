import { canonicalModelGatewayJson, modelGatewaySha256, validateModelGatewayTransportPolicy,
  type ModelGatewayTransportPolicyV1 } from "@eliotr/cloudflare-ai";
import { decodeCanonicalBase64Bytes, encodeCanonicalBase64Bytes } from "@eliotr/platform-cloudflare";
import {
  createProviderNativeModelCatalogCandidateBundleV2,
  decodeProviderNativeModelCatalogCandidateV2,
  decodeProviderNativeModelCatalogObservationV2,
  decodeProviderNativeModelCatalogPreparationV2,
  decodeProviderNativeModelCatalogProofV2,
  decodeProviderNativeModelCatalogSelectionV2,
  ProviderNativeModelCatalogV2Error,
  type ProviderNativeModelCatalogBindingV2,
  type ProviderNativeModelCatalogPreparationInputV2,
  type ProviderNativeModelCatalogPreparationV2,
  type ProviderNativeModelCatalogPricingSnapshotV2,
  type ProviderNativeModelCatalogSelectionV2,
  type ProviderNativeModelCatalogV2AuthorityPort,
  type ResolvedProviderNativeModelCatalogV2,
} from "./provider-native-model-catalog-v2.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_PREPARATION_TTL_MS = 5 * 60 * 1000;

type State = "PREPARED" | "CLAIMED" | "OBSERVED" | "COMPLETED" | "UNCERTAIN";

interface ConsentAndBindingRow {
  readonly owner_id: unknown;
  readonly project_id: unknown;
  readonly operation_id: unknown;
  readonly provider_id: unknown;
  readonly provider_operation_id: unknown;
  readonly route_provider_id: unknown;
  readonly model_id: unknown;
  readonly account_id: unknown;
  readonly gateway_id: unknown;
  readonly alias: unknown;
  readonly provider_config_id: unknown;
  readonly configuration_metadata_sha256: unknown;
  readonly request_sha256: unknown;
  readonly project_generation: unknown;
  readonly state: unknown;
  readonly provider_slug: unknown;
  readonly provider_state: unknown;
  readonly provider_failure_code: unknown;
  readonly provider_http_status: unknown;
  readonly configured_alias: unknown;
  readonly configured_provider_config_id: unknown;
  readonly configured_metadata_sha256: unknown;
  readonly project_owner_ref: unknown;
  readonly current_project_generation: unknown;
}

interface EvidenceRow {
  readonly owner_ref: unknown;
  readonly project_id: unknown;
  readonly consent_operation_id: unknown;
  readonly stage: unknown;
  readonly provider_id: unknown;
  readonly provider_slug: unknown;
  readonly provider_operation_id: unknown;
  readonly model_id: unknown;
  readonly alias: unknown;
  readonly provider_config_id: unknown;
  readonly configuration_metadata_sha256: unknown;
  readonly request_sha256: unknown;
  readonly pricing_snapshot_ref: unknown;
  readonly pricing_snapshot_sha256: unknown;
  readonly preparation_ref: unknown;
  readonly preparation_sha256: unknown;
  readonly preparation_json: unknown;
  readonly state: unknown;
  readonly observation_ref: unknown;
  readonly observation_sha256: unknown;
  readonly observation_json: unknown;
  readonly request_body_base64: unknown;
  readonly response_body_base64: unknown;
  readonly candidate_ref: unknown;
  readonly candidate_sha256: unknown;
  readonly candidate_json: unknown;
  readonly qualification_ref: unknown;
  readonly qualification_sha256: unknown;
  readonly qualification_json: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface Evidence {
  readonly owner_ref: string;
  readonly project_id: string;
  readonly consent_operation_id: string;
  readonly stage: ProviderNativeModelCatalogPreparationV2["stage"];
  readonly provider_id: string;
  readonly provider_slug: string;
  readonly provider_operation_id: string;
  readonly model_id: string;
  readonly alias: string;
  readonly provider_config_id: string;
  readonly configuration_metadata_sha256: string;
  readonly request_sha256: string;
  readonly pricing_snapshot_ref: string;
  readonly pricing_snapshot_sha256: string;
  readonly preparation_ref: string;
  readonly preparation_sha256: string;
  readonly preparation_json: string;
  readonly state: State;
  readonly observation_ref: string | null;
  readonly observation_sha256: string | null;
  readonly observation_json: string | null;
  readonly request_body_base64: string | null;
  readonly response_body_base64: string | null;
  readonly candidate_ref: string | null;
  readonly candidate_sha256: string | null;
  readonly candidate_json: string | null;
  readonly qualification_ref: string | null;
  readonly qualification_sha256: string | null;
  readonly qualification_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ProviderNativeModelCatalogV2PricingReader {
  read(input: Readonly<{ pricing_snapshot_ref: string; pricing_snapshot_sha256: string; provider_id: string;
    provider_slug: string; exact_model_id: string; owner_ref: string; project_id: string; consent_operation_id: string
  }>): Promise<ProviderNativeModelCatalogPricingSnapshotV2 | null>;
}

function invalid(message: string, cause?: unknown): never {
  throw new ProviderNativeModelCatalogV2Error("INPUT_INVALID", message, cause);
}

function stale(message: string, cause?: unknown): never {
  throw new ProviderNativeModelCatalogV2Error("AUTHORITY_STALE", message, cause);
}

function proofFailure(message: string, cause?: unknown): never {
  throw new ProviderNativeModelCatalogV2Error("PROOF_INVALID", message, cause);
}

function canonicalNow(now: () => string): Readonly<{ value: string; ms: number }> {
  let value: string;
  try { value = now(); } catch (cause) { stale("catalog native v2 authority clock is unavailable", cause); }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) stale("catalog native v2 authority clock is invalid");
  return Object.freeze({ value, ms });
}

function readString(value: unknown, label: string, pattern = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u): string {
  if (typeof value !== "string" || !pattern.test(value)) stale(`stored catalog native v2 ${label} is malformed`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : readString(value, label);
}

function decodeEvidence(row: EvidenceRow): Evidence {
  const state = row.state;
  if (state !== "PREPARED" && state !== "CLAIMED" && state !== "OBSERVED" && state !== "COMPLETED" && state !== "UNCERTAIN") {
    stale("stored catalog native v2 state is invalid");
  }
  const observationRef = nullableString(row.observation_ref, "observation ref");
  const observationSha = row.observation_sha256 === null ? null : readString(row.observation_sha256, "observation digest", SHA256);
  const observationJson = row.observation_json === null ? null : readString(row.observation_json, "observation JSON", /^[\s\S]{2,32768}$/u);
  const requestBody = row.request_body_base64 === null ? null : readString(row.request_body_base64, "request bytes", /^[A-Za-z0-9+/]+={0,2}$/u);
  const responseBody = row.response_body_base64 === null ? null : readString(row.response_body_base64, "response bytes", /^[A-Za-z0-9+/]+={0,2}$/u);
  const candidateRef = nullableString(row.candidate_ref, "candidate ref");
  const candidateSha = row.candidate_sha256 === null ? null : readString(row.candidate_sha256, "candidate digest", SHA256);
  const candidateJson = row.candidate_json === null ? null : readString(row.candidate_json, "candidate JSON", /^[\s\S]{2,65536}$/u);
  const qualificationRef = nullableString(row.qualification_ref, "qualification ref");
  const qualificationSha = row.qualification_sha256 === null ? null : readString(row.qualification_sha256, "qualification digest", SHA256);
  const qualificationJson = row.qualification_json === null ? null : readString(row.qualification_json, "qualification JSON", /^[\s\S]{2,65536}$/u);
  if ((observationRef === null) !== (observationSha === null) || (observationRef === null) !== (observationJson === null) ||
      (observationRef === null) !== (requestBody === null) || (observationRef === null) !== (responseBody === null) ||
      (candidateRef === null) !== (candidateSha === null) || (candidateRef === null) !== (candidateJson === null) ||
      (qualificationRef === null) !== (qualificationSha === null) || (qualificationRef === null) !== (qualificationJson === null) ||
      ((state === "OBSERVED" || state === "COMPLETED") !== (observationRef !== null)) ||
      (state === "COMPLETED") !== (candidateRef !== null) || (state === "COMPLETED") !== (qualificationRef !== null)) {
    stale("stored catalog native v2 evidence is incomplete");
  }
  return Object.freeze({
    owner_ref: readString(row.owner_ref, "owner"), project_id: readString(row.project_id, "project"),
    consent_operation_id: readString(row.consent_operation_id, "consent operation", UUID),
    stage: readString(row.stage, "stage") as Evidence["stage"], provider_id: readString(row.provider_id, "logical provider"),
    provider_slug: readString(row.provider_slug, "physical provider"),
    provider_operation_id: readString(row.provider_operation_id, "provider operation", UUID),
    model_id: readString(row.model_id, "model"), alias: readString(row.alias, "alias", /^eliotr-[a-f0-9]{48}$/u),
    provider_config_id: readString(row.provider_config_id, "provider config"),
    configuration_metadata_sha256: readString(row.configuration_metadata_sha256, "provider metadata digest", SHA256),
    request_sha256: readString(row.request_sha256, "request digest", SHA256),
    pricing_snapshot_ref: readString(row.pricing_snapshot_ref, "pricing snapshot"),
    pricing_snapshot_sha256: readString(row.pricing_snapshot_sha256, "pricing snapshot digest", SHA256),
    preparation_ref: readString(row.preparation_ref, "preparation ref"),
    preparation_sha256: readString(row.preparation_sha256, "preparation digest", SHA256),
    preparation_json: readString(row.preparation_json, "preparation JSON", /^[\s\S]{2,65536}$/u), state,
    observation_ref: observationRef, observation_sha256: observationSha, observation_json: observationJson,
    request_body_base64: requestBody, response_body_base64: responseBody,
    candidate_ref: candidateRef, candidate_sha256: candidateSha, candidate_json: candidateJson,
    qualification_ref: qualificationRef, qualification_sha256: qualificationSha, qualification_json: qualificationJson,
    created_at: readString(row.created_at, "created_at"), updated_at: readString(row.updated_at, "updated_at"),
  });
}

function decodeJson<T>(raw: string, label: string): T {
  try { return JSON.parse(raw) as T; } catch (cause) { stale(`stored catalog native v2 ${label} JSON is malformed`, cause); }
}

function same(left: unknown, right: unknown): boolean {
  return canonicalModelGatewayJson(left) === canonicalModelGatewayJson(right);
}

function validatePricingSnapshot(
  raw: ProviderNativeModelCatalogPricingSnapshotV2 | null,
  preparation: ProviderNativeModelCatalogPreparationV2,
  now: number,
  requireCurrent: boolean,
): ProviderNativeModelCatalogPricingSnapshotV2 {
  if (raw === null || raw.pricing_snapshot_ref !== preparation.pricing_snapshot_ref ||
      raw.snapshot_sha256 !== preparation.pricing_snapshot_sha256 || raw.provider_id !== preparation.provider_id ||
      raw.provider_slug !== preparation.provider_slug || raw.exact_model_id !== preparation.model_id ||
      raw.api !== preparation.transport_policy.api ||
      canonicalModelGatewayJson(raw.capabilities) !== canonicalModelGatewayJson(preparation.transport_policy.capabilities) ||
      (preparation.catalog_sdk !== "" && raw.catalog_sdk !== preparation.catalog_sdk) ||
      (preparation.sdk_base_url !== "" && raw.sdk_base_url !== preparation.sdk_base_url) ||
      (preparation.catalog_metadata_sha256 !== "" && raw.catalog_metadata_sha256 !== preparation.catalog_metadata_sha256) ||
      (preparation.pricing_snapshot_expires_at !== "" && raw.expires_at !== preparation.pricing_snapshot_expires_at) ||
      typeof raw.pricing_port !== "object" || raw.pricing_port === null) {
    stale("trusted pricing snapshot does not match the exact catalog model tuple");
  }
  let sdkBase: URL;
  try { sdkBase = new URL(raw.sdk_base_url); } catch (cause) { stale("trusted catalog SDK base URL is invalid", cause); }
  if (sdkBase.protocol !== "https:" || sdkBase.username.length > 0 || sdkBase.password.length > 0 ||
      typeof raw.catalog_sdk !== "string" || raw.catalog_sdk.length < 1 || raw.catalog_sdk.length > 256 ||
      !/^[a-f0-9]{64}$/u.test(raw.catalog_metadata_sha256)) {
    stale("trusted provider SDK metadata is malformed");
  }
  const effective = Date.parse(raw.effective_at), expires = Date.parse(raw.expires_at);
  if (!Number.isFinite(effective) || !Number.isFinite(expires) || effective > now || (requireCurrent && expires <= now)) {
    stale("trusted pricing snapshot is not currently effective");
  }
  return raw;
}

function bindingFromRow(row: ConsentAndBindingRow, ownerRef: string, projectId: string, operationId: string): ProviderNativeModelCatalogBindingV2 {
  if (row.owner_id !== ownerRef || row.project_id !== projectId || row.operation_id !== operationId ||
      typeof row.provider_operation_id !== "string" || !UUID.test(row.provider_operation_id) ||
      row.project_owner_ref !== ownerRef ||
      row.provider_state !== "CONFIGURED" || row.provider_failure_code !== null || row.provider_http_status !== null ||
      row.provider_id === null || row.provider_slug === null ||
      row.configured_alias !== row.alias || row.configured_provider_config_id !== row.provider_config_id ||
      row.configured_metadata_sha256 !== row.configuration_metadata_sha256 ||
      row.current_project_generation !== row.project_generation) {
    stale("exact configured catalog provider connection or owner project binding is stale");
  }
  if (typeof row.account_id !== "string" || !/^[a-f0-9]{32}$/u.test(row.account_id) ||
      typeof row.gateway_id !== "string" || typeof row.alias !== "string" ||
      !/^eliotr-[a-f0-9]{48}$/u.test(row.alias) || row.alias === "default" ||
      typeof row.provider_config_id !== "string" || typeof row.configuration_metadata_sha256 !== "string" ||
      !SHA256.test(row.configuration_metadata_sha256)) stale("configured catalog provider binding is malformed");
  return Object.freeze({ protocol: "eliotr.research-provider-key-configuration.v1", owner_ref: ownerRef, project_id: projectId,
    operation_id: row.provider_operation_id, provider_id: readString(row.provider_id, "logical provider"),
    provider_slug: readString(row.provider_slug, "physical provider"), account_id: row.account_id,
    gateway_id: readString(row.gateway_id, "Gateway id"), alias: row.alias,
    provider_config_id: readString(row.provider_config_id, "provider config id"),
    configuration_metadata_sha256: row.configuration_metadata_sha256 });
}

function preparationReceipt(preparation: ProviderNativeModelCatalogPreparationV2, ref: string, sha: string) {
  return Object.freeze({ preparation_ref: ref, preparation_sha256: sha, preparation });
}

/**
 * Versioned v2 authority for exact owner-consented provider/model tuples. Its
 * D1 one-shot claim and proof records are independent of the OpenRouter v1
 * tables; pricing is mandatory and must be supplied by a trusted resolver.
 */
export function createD1ProviderNativeModelCatalogV2Authority(input: Readonly<{
  database: D1Database;
  pricing_snapshots: ProviderNativeModelCatalogV2PricingReader;
  now?: () => string;
}>): ProviderNativeModelCatalogV2AuthorityPort {
  if (input.database === undefined || typeof input.database.prepare !== "function" ||
      input.pricing_snapshots === undefined || typeof input.pricing_snapshots.read !== "function") {
    invalid("catalog native v2 authority requires D1 and an explicit trusted pricing reader");
  }
  const now = input.now ?? (() => new Date().toISOString());
  const db = input.database;

  async function currentBinding(ownerRef: string, projectId: string, consentOperationId: string,
    allowedStates: readonly string[]): Promise<Readonly<{ binding: ProviderNativeModelCatalogBindingV2; request_sha256: string;
      model_id: string; provider_id: string; provider_slug: string }>> {
    let row: ConsentAndBindingRow | null;
    try {
      row = await db.prepare(
        "SELECT a.owner_id,a.project_id,a.operation_id,a.provider_id,a.provider_operation_id,a.route_provider_id,a.model_id," +
        "a.account_id,a.gateway_id,a.alias,a.provider_config_id,a.configuration_metadata_sha256,a.request_sha256,a.project_generation,a.state," +
        "g.provider_slug,g.state AS provider_state,g.failure_code AS provider_failure_code,g.provider_http_status," +
        "g.alias AS configured_alias,g.provider_config_id AS configured_provider_config_id,g.metadata_sha256 AS configured_metadata_sha256," +
        "o.principal_ref AS project_owner_ref,p.generation AS current_project_generation " +
        "FROM research_catalog_model_use_authorization a " +
        "JOIN service_model_provider_operation g ON g.owner_id=a.owner_id AND g.operation_id=a.provider_operation_id " +
        "JOIN project p ON p.project_id=a.project_id JOIN project_owner o ON o.project_id=p.project_id " +
        "WHERE a.owner_id=?1 AND a.project_id=?2 AND a.operation_id=?3 LIMIT 1",
      ).bind(ownerRef, projectId, consentOperationId).first<ConsentAndBindingRow>();
    } catch (cause) { stale("catalog consent and configured provider readback is unavailable", cause); }
    if (row === null || !allowedStates.includes(String(row.state))) stale("exact catalog owner consent is unavailable");
    const binding = bindingFromRow(row, ownerRef, projectId, consentOperationId);
    if (row.provider_id !== binding.provider_id || row.route_provider_id !== binding.provider_slug ||
        typeof row.model_id !== "string" || !/^(?:@[A-Za-z0-9][A-Za-z0-9._:~@/-]{0,254}|[A-Za-z0-9~][A-Za-z0-9._:~@/-]{0,255})$/u.test(row.model_id) ||
        typeof row.request_sha256 !== "string" || !SHA256.test(row.request_sha256)) stale("catalog consent does not bind the exact provider/model tuple");
    return Object.freeze({ binding, request_sha256: row.request_sha256, model_id: row.model_id,
      provider_id: binding.provider_id, provider_slug: binding.provider_slug });
  }

  async function readEvidenceByConsent(ownerRef: string, projectId: string, operationId: string, stageName: string): Promise<Evidence | null> {
    let row: EvidenceRow | null;
    try {
      row = await db.prepare(
        "SELECT owner_ref,project_id,consent_operation_id,stage,provider_id,provider_slug,provider_operation_id,model_id,alias," +
        "provider_config_id,configuration_metadata_sha256,request_sha256,pricing_snapshot_ref,pricing_snapshot_sha256," +
        "preparation_ref,preparation_sha256,preparation_json,state,observation_ref,observation_sha256,observation_json," +
        "request_body_base64,response_body_base64,candidate_ref,candidate_sha256,candidate_json,qualification_ref," +
        "qualification_sha256,qualification_json,created_at,updated_at FROM provider_native_model_catalog_v2_evidence " +
        "WHERE owner_ref=?1 AND project_id=?2 AND consent_operation_id=?3 AND stage=?4 LIMIT 1",
      ).bind(ownerRef, projectId, operationId, stageName).first<EvidenceRow>();
    } catch (cause) { stale("catalog native v2 evidence readback is unavailable", cause); }
    return row === null ? null : decodeEvidence(row);
  }

  async function readEvidenceBySelection(selection: ProviderNativeModelCatalogSelectionV2): Promise<Evidence | null> {
    let row: EvidenceRow | null;
    try {
      row = await db.prepare(
        "SELECT owner_ref,project_id,consent_operation_id,stage,provider_id,provider_slug,provider_operation_id,model_id,alias," +
        "provider_config_id,configuration_metadata_sha256,request_sha256,pricing_snapshot_ref,pricing_snapshot_sha256," +
        "preparation_ref,preparation_sha256,preparation_json,state,observation_ref,observation_sha256,observation_json," +
        "request_body_base64,response_body_base64,candidate_ref,candidate_sha256,candidate_json,qualification_ref," +
        "qualification_sha256,qualification_json,created_at,updated_at FROM provider_native_model_catalog_v2_evidence " +
        "WHERE candidate_ref=?1 AND candidate_sha256=?2 AND qualification_ref=?3 AND qualification_sha256=?4 LIMIT 1",
      ).bind(selection.candidate_ref, selection.candidate_sha256, selection.qualification_ref, selection.qualification_sha256)
        .first<EvidenceRow>();
    } catch (cause) { stale("catalog native v2 candidate readback is unavailable", cause); }
    return row === null ? null : decodeEvidence(row);
  }

  async function readPricing(preparation: ProviderNativeModelCatalogPreparationV2, currentMs: number, requireCurrent: boolean) {
    let snapshot: ProviderNativeModelCatalogPricingSnapshotV2 | null;
    try {
      snapshot = await input.pricing_snapshots.read({ pricing_snapshot_ref: preparation.pricing_snapshot_ref,
        pricing_snapshot_sha256: preparation.pricing_snapshot_sha256, provider_id: preparation.provider_id,
        provider_slug: preparation.provider_slug, exact_model_id: preparation.model_id,
        owner_ref: preparation.owner_ref, project_id: preparation.project_id,
        consent_operation_id: preparation.consent_operation_id });
    } catch (cause) { stale("trusted catalog pricing readback is unavailable", cause); }
    return validatePricingSnapshot(snapshot, preparation, currentMs, requireCurrent);
  }

  async function assertPreparationCurrent(preparation: ProviderNativeModelCatalogPreparationV2, requirePricing: boolean,
    requireUnexpiredPreparation = true) {
    const identity = await currentBinding(preparation.owner_ref, preparation.project_id, preparation.consent_operation_id,
      ["ACCEPTED", "PREPARING", "QUALIFYING", "IMPORTING", "SELECTED"]);
    const binding = identity.binding;
    if (identity.request_sha256 !== preparation.request_sha256 || binding.operation_id !== preparation.provider_operation_id ||
        binding.provider_id !== preparation.provider_id || binding.provider_slug !== preparation.provider_slug ||
        binding.alias !== preparation.key_binding.alias || binding.provider_config_id !== preparation.key_binding.provider_config_id ||
        binding.configuration_metadata_sha256 !== preparation.key_binding.configuration_metadata_sha256 ||
        preparation.transport_policy.provider !== binding.provider_slug || preparation.transport_policy.model !== preparation.model_id) {
      stale("catalog consent, provider connection, alias or selected model changed after preparation");
    }
    const current = canonicalNow(now);
    if (requireUnexpiredPreparation && Date.parse(preparation.preparation_expires_at) <= current.ms) {
      stale("catalog native v2 preparation expired");
    }
    const pricing = await readPricing(preparation, current.ms, requirePricing);
    return Object.freeze({ binding, pricing, now: current });
  }

  async function readRevocation(ownerRef: string, projectId: string, qualificationRef: string, qualificationSha: string): Promise<boolean> {
    try {
      const row = await db.prepare("SELECT qualification_ref FROM provider_native_model_catalog_v2_revocation " +
        "WHERE owner_ref=?1 AND project_id=?2 AND qualification_ref=?3 AND qualification_sha256=?4 LIMIT 1")
        .bind(ownerRef, projectId, qualificationRef, qualificationSha).first<{ readonly qualification_ref: unknown }>();
      return row !== null;
    } catch (cause) { stale("catalog native v2 revocation readback is unavailable", cause); }
  }

  async function makeResolved(selection: ProviderNativeModelCatalogSelectionV2, evidence: Evidence,
    allowExpired: boolean): Promise<ResolvedProviderNativeModelCatalogV2> {
    if (evidence.state !== "COMPLETED" || evidence.observation_json === null || evidence.candidate_json === null ||
        evidence.qualification_json === null || evidence.observation_ref === null || evidence.observation_sha256 === null ||
        evidence.candidate_ref === null || evidence.candidate_sha256 === null || evidence.qualification_ref === null ||
        evidence.qualification_sha256 === null) proofFailure("catalog native v2 candidate is not complete");
    if (await readRevocation(evidence.owner_ref, evidence.project_id, evidence.qualification_ref, evidence.qualification_sha256)) {
      stale("catalog native v2 qualification has been revoked");
    }
    const preparation = decodeProviderNativeModelCatalogPreparationV2(decodeJson(evidence.preparation_json, "preparation"));
    const candidate = decodeProviderNativeModelCatalogCandidateV2(decodeJson(evidence.candidate_json, "candidate"));
    const qualification = decodeProviderNativeModelCatalogProofV2(decodeJson(evidence.qualification_json, "qualification"));
    const observation = decodeProviderNativeModelCatalogObservationV2(decodeJson(evidence.observation_json, "observation"));
    const prepJson = canonicalModelGatewayJson(preparation);
    const prepSha = await modelGatewaySha256(prepJson);
    const observationJson = canonicalModelGatewayJson(observation);
    const observationSha = await modelGatewaySha256(observationJson);
    let requestBytes: Uint8Array;
    let responseBytes: Uint8Array;
    try {
      requestBytes = decodeCanonicalBase64Bytes(evidence.request_body_base64 ?? "", { max_bytes: 32_768 });
      responseBytes = decodeCanonicalBase64Bytes(evidence.response_body_base64 ?? "", { max_bytes: 262_144 });
    } catch (cause) { proofFailure("stored catalog native v2 request or response bytes are malformed", cause); }
    const actualRequestSha = await modelGatewaySha256(requestBytes);
    const actualResponseSha = await modelGatewaySha256(responseBytes);
    const candidateJson = canonicalModelGatewayJson(candidate);
    const candidateSha = await modelGatewaySha256(candidateJson);
    const qualificationJson = canonicalModelGatewayJson(qualification);
    const qualificationSha = await modelGatewaySha256(qualificationJson);
    if (prepJson !== evidence.preparation_json || prepSha !== evidence.preparation_sha256 ||
        evidence.preparation_ref !== `provider-native-model-preparation-v2-${prepSha}` ||
        observationJson !== evidence.observation_json || observationSha !== evidence.observation_sha256 ||
        evidence.observation_ref !== `provider-native-model-observation-v2-${observationSha}` ||
        candidateJson !== evidence.candidate_json || candidateSha !== evidence.candidate_sha256 ||
        evidence.candidate_ref !== `provider-native-model-candidate-v2-${candidateSha}` ||
        qualificationJson !== evidence.qualification_json || qualificationSha !== evidence.qualification_sha256 ||
        evidence.qualification_ref !== `provider-native-model-qualification-v2-${qualificationSha}` ||
        candidate.preparation_ref !== evidence.preparation_ref || candidate.preparation_sha256 !== evidence.preparation_sha256 ||
        candidate.observation_ref !== evidence.observation_ref || candidate.observation_sha256 !== evidence.observation_sha256 ||
        qualification.candidate_ref !== evidence.candidate_ref || qualification.candidate_sha256 !== evidence.candidate_sha256 ||
        qualification.preparation_ref !== evidence.preparation_ref || qualification.preparation_sha256 !== evidence.preparation_sha256 ||
        qualification.observation_ref !== evidence.observation_ref || qualification.observation_sha256 !== evidence.observation_sha256 ||
        qualification.owner_ref !== evidence.owner_ref || qualification.project_id !== evidence.project_id ||
        qualification.consent_operation_id !== evidence.consent_operation_id || qualification.provider_id !== evidence.provider_id ||
        qualification.provider_slug !== evidence.provider_slug || qualification.provider_operation_id !== evidence.provider_operation_id ||
        qualification.model_id !== evidence.model_id || qualification.pricing_snapshot_ref !== evidence.pricing_snapshot_ref ||
        qualification.pricing_snapshot_sha256 !== evidence.pricing_snapshot_sha256 ||
        qualification.catalog_sdk !== preparation.catalog_sdk || qualification.sdk_base_url !== preparation.sdk_base_url ||
        qualification.catalog_metadata_sha256 !== preparation.catalog_metadata_sha256 ||
        observation.consent_request_sha256 !== evidence.request_sha256 ||
        observation.request_body_sha256 !== actualRequestSha || observation.response_body_sha256 !== actualResponseSha ||
        observation.response_model !== evidence.model_id || candidate.preparation.owner_ref !== evidence.owner_ref ||
        candidate.preparation.project_id !== evidence.project_id || candidate.preparation.consent_operation_id !== evidence.consent_operation_id ||
        candidate.preparation.provider_id !== evidence.provider_id || candidate.preparation.provider_slug !== evidence.provider_slug ||
        candidate.preparation.provider_operation_id !== evidence.provider_operation_id || candidate.preparation.model_id !== evidence.model_id ||
        selection.stage !== evidence.stage || selection.route_ref !== preparation.deployment.route_ref ||
        selection.route_version !== preparation.deployment.route_version ||
        !same(selection.transport_policy, preparation.transport_policy) ||
        Date.parse(qualification.expires_at) <= Date.parse(canonicalNow(now).value) && !allowExpired) {
      proofFailure("catalog native v2 readback differs from the exact owner consent, candidate or execution proof");
    }
    const current = await assertPreparationCurrent(preparation, !allowExpired, false);
    return Object.freeze({ selection, candidate: Object.freeze({ candidate_ref: evidence.candidate_ref,
      candidate_sha256: evidence.candidate_sha256, candidate }), proof: Object.freeze({ qualification_ref: evidence.qualification_ref,
      qualification_sha256: evidence.qualification_sha256, qualification }), observation,
      pricing_snapshot: current.pricing, deployment: preparation.deployment, pricing_port: current.pricing.pricing_port });
  }

  const authority: ProviderNativeModelCatalogV2AuthorityPort = {
    async prepare(rawInput: ProviderNativeModelCatalogPreparationInputV2) {
      let policy: ModelGatewayTransportPolicyV1;
      try { policy = validateModelGatewayTransportPolicy(rawInput.transport_policy); }
      catch (cause) { invalid("catalog model transport policy is invalid", cause); }
      if (rawInput.consent_operation_id !== rawInput.owner_operation_id ||
          !UUID.test(rawInput.consent_operation_id) || !UUID.test(rawInput.provider_operation_id) ||
          rawInput.request_sha256.length !== 64 || !SHA256.test(rawInput.request_sha256)) invalid("catalog model preparation identity is invalid");
      const current = await currentBinding(rawInput.owner_ref, rawInput.project_id, rawInput.consent_operation_id,
        ["ACCEPTED", "PREPARING", "QUALIFYING"]);
      const binding = current.binding;
      if (current.request_sha256 !== rawInput.request_sha256 || current.model_id !== rawInput.model_id ||
          binding.provider_id !== rawInput.provider_id ||
          binding.provider_slug !== rawInput.provider_slug || binding.operation_id !== rawInput.provider_operation_id ||
          rawInput.model_id.length === 0 ||
          policy.provider !== binding.provider_slug || policy.model !== rawInput.model_id ||
          policy.api === "compat-chat-completions" || policy.billing.mode !== "byok" ||
          policy.billing.alias !== binding.alias || binding.alias === "default" ||
          rawInput.deployment.pricing_snapshot_ref !== rawInput.pricing_snapshot_ref ||
          rawInput.probe_deployment.pricing_snapshot_ref !== rawInput.pricing_snapshot_ref ||
          rawInput.parameters_sha256 !== rawInput.deployment.parameters_digest ||
          rawInput.probe_parameters_sha256 !== rawInput.probe_deployment.parameters_digest) {
        stale("catalog preparation does not match exact current owner consent, connection, model or price tuple");
      }
      const currentTime = canonicalNow(now);
      const provisionalExpiry = new Date(currentTime.ms + MAX_PREPARATION_TTL_MS).toISOString();
      const pricing = await readPricing({ ...rawInput, protocol: "eliotr.provider-native-model-preparation.v2",
        key_binding: binding, prepared_at: currentTime.value,
        preparation_expires_at: provisionalExpiry, pricing_snapshot_expires_at: "",
        catalog_sdk: "", sdk_base_url: "", catalog_metadata_sha256: "" }, currentTime.ms, true);
      const expiresMs = Math.min(currentTime.ms + MAX_PREPARATION_TTL_MS, Date.parse(pricing.expires_at));
      if (!Number.isFinite(expiresMs) || expiresMs <= currentTime.ms) stale("trusted pricing expires before catalog qualification can start");
      const preparation = decodeProviderNativeModelCatalogPreparationV2({ ...rawInput,
        protocol: "eliotr.provider-native-model-preparation.v2", key_binding: binding,
        prepared_at: currentTime.value, preparation_expires_at: new Date(expiresMs).toISOString(),
        pricing_snapshot_expires_at: pricing.expires_at, catalog_sdk: pricing.catalog_sdk,
        sdk_base_url: pricing.sdk_base_url, catalog_metadata_sha256: pricing.catalog_metadata_sha256 });
      const preparationJson = canonicalModelGatewayJson(preparation);
      const preparationSha = await modelGatewaySha256(preparationJson);
      const preparationRef = `provider-native-model-preparation-v2-${preparationSha}`;
      const createdAt = currentTime.value;
      try {
        await db.prepare(
          "INSERT INTO provider_native_model_catalog_v2_evidence (owner_ref,project_id,consent_operation_id,stage,provider_id," +
          "provider_slug,provider_operation_id,model_id,alias,provider_config_id,configuration_metadata_sha256,request_sha256," +
          "pricing_snapshot_ref,pricing_snapshot_sha256,preparation_ref,preparation_sha256,preparation_json,state,created_at,updated_at) " +
          "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,'PREPARED',?18,?18) " +
          "ON CONFLICT(owner_ref,project_id,consent_operation_id,stage) DO NOTHING",
        ).bind(preparation.owner_ref, preparation.project_id, preparation.consent_operation_id, preparation.stage,
          preparation.provider_id, preparation.provider_slug, preparation.provider_operation_id, preparation.model_id,
          binding.alias, binding.provider_config_id, binding.configuration_metadata_sha256, preparation.request_sha256,
          preparation.pricing_snapshot_ref, preparation.pricing_snapshot_sha256, preparationRef, preparationSha,
          preparationJson, createdAt).run();
      } catch (cause) { stale("catalog native v2 preparation could not be persisted", cause); }
      const existing = await readEvidenceByConsent(preparation.owner_ref, preparation.project_id,
        preparation.consent_operation_id, preparation.stage);
      if (existing === null || existing.preparation_ref !== preparationRef || existing.preparation_sha256 !== preparationSha ||
          existing.preparation_json !== preparationJson) stale("catalog native v2 preparation did not read back exactly");
      return preparationReceipt(preparation, preparationRef, preparationSha);
    },

    async qualify(inputValue) {
      const input = inputValue;
      if (!UUID.test(input.owner_operation_id) || !/^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u.test(input.preparation_ref) ||
          typeof input.executor?.executeOnce !== "function") invalid("catalog native v2 qualification input is invalid");
      let evidence = await readEvidenceByConsent(input.owner_ref, input.project_id, input.owner_operation_id, input.stage);
      if (evidence === null || evidence.preparation_ref !== input.preparation_ref || evidence.preparation_sha256 !== input.preparation_sha256) {
        stale("catalog native v2 preparation is missing or differs from its exact owner operation");
      }
      let preparation: ProviderNativeModelCatalogPreparationV2;
      try { preparation = decodeProviderNativeModelCatalogPreparationV2(decodeJson(evidence.preparation_json, "preparation")); }
      catch (cause) { stale("catalog native v2 preparation failed strict readback", cause); }
      await assertPreparationCurrent(preparation, true);
      if (evidence.state === "COMPLETED") {
        const selection = decodeProviderNativeModelCatalogSelectionV2({ candidate_kind: "provider-native-v2", stage: preparation.stage,
          route_ref: preparation.deployment.route_ref, route_version: preparation.deployment.route_version,
          candidate_ref: evidence.candidate_ref, candidate_sha256: evidence.candidate_sha256,
          qualification_ref: evidence.qualification_ref, qualification_sha256: evidence.qualification_sha256,
          transport_policy: preparation.transport_policy });
        await makeResolved(selection, evidence, false);
        return selection;
      }
      if (evidence.state === "OBSERVED" && evidence.observation_json !== null) {
        const observation = decodeProviderNativeModelCatalogObservationV2(decodeJson(evidence.observation_json, "observation"));
        const bundle = await createProviderNativeModelCatalogCandidateBundleV2({ preparation,
          preparation_ref: evidence.preparation_ref, preparation_sha256: evidence.preparation_sha256, observation });
        try {
          await db.prepare("UPDATE provider_native_model_catalog_v2_evidence SET state='COMPLETED',candidate_ref=?1,candidate_sha256=?2," +
            "candidate_json=?3,qualification_ref=?4,qualification_sha256=?5,qualification_json=?6,updated_at=?7 " +
            "WHERE owner_ref=?8 AND project_id=?9 AND consent_operation_id=?10 AND stage=?11 AND state='OBSERVED'")
            .bind(bundle.candidate_ref, bundle.candidate_sha256, bundle.candidate_json, bundle.qualification_ref,
              bundle.qualification_sha256, bundle.qualification_json, canonicalNow(now).value, input.owner_ref,
              input.project_id, input.owner_operation_id, input.stage).run();
        } catch (cause) { stale("catalog native v2 proof could not be persisted", cause); }
        evidence = await readEvidenceByConsent(input.owner_ref, input.project_id, input.owner_operation_id, input.stage);
        if (evidence === null || evidence.state !== "COMPLETED" || evidence.candidate_json !== bundle.candidate_json ||
            evidence.qualification_json !== bundle.qualification_json) stale("catalog native v2 proof readback is unavailable");
        return bundle.selection;
      }
      if (evidence.state !== "PREPARED") stale("catalog native v2 provider call is already claimed; retry is forbidden");
      let claimed;
      try {
        claimed = await db.prepare("UPDATE provider_native_model_catalog_v2_evidence SET state='CLAIMED',updated_at=?1 " +
          "WHERE owner_ref=?2 AND project_id=?3 AND consent_operation_id=?4 AND stage=?5 AND state='PREPARED'")
          .bind(canonicalNow(now).value, input.owner_ref, input.project_id, input.owner_operation_id, input.stage).run();
      } catch (cause) { stale("catalog native v2 one-shot qualification claim failed", cause); }
      if ((claimed.meta?.changes ?? 0) !== 1) stale("catalog native v2 qualification was concurrently claimed; retry is forbidden");
      try {
        await assertPreparationCurrent(preparation, true);
        const execution = await input.executor.executeOnce(preparation);
        const observation = decodeProviderNativeModelCatalogObservationV2({
          protocol: execution.protocol,
          qualification_purpose: execution.qualification_purpose,
          api: execution.api,
          provider_id: execution.provider_id,
          provider_slug: execution.provider_slug,
          model_id: execution.model_id,
          consent_request_sha256: execution.consent_request_sha256,
          request_body_sha256: execution.request_body_sha256,
          response_body_sha256: execution.response_body_sha256,
          response_model: execution.response_model,
          gateway_log_id: execution.gateway_log_id,
          input_tokens: execution.input_tokens,
          output_tokens: execution.output_tokens,
          verified_at: execution.verified_at,
          expires_at: execution.expires_at,
        });
        const observedAt = Date.parse(observation.verified_at);
        const claimedAt = Date.parse(preparation.prepared_at);
        const observedNow = canonicalNow(now).ms;
        if (observation.provider_id !== preparation.provider_id || observation.provider_slug !== preparation.provider_slug ||
            observation.model_id !== preparation.model_id || observation.api !== preparation.transport_policy.api ||
            observation.consent_request_sha256 !== preparation.request_sha256 ||
            observedAt < claimedAt || observedAt > observedNow || observedAt >= Date.parse(preparation.preparation_expires_at) ||
            execution.request_body_bytes.byteLength < 1 || execution.request_body_bytes.byteLength > 32_768 ||
            execution.response_body_bytes.byteLength < 1 || execution.response_body_bytes.byteLength > 262_144) {
          proofFailure("catalog qualification execution differs from exact prepared provider and model");
        }
        if (await modelGatewaySha256(execution.request_body_bytes) !== observation.request_body_sha256 ||
            await modelGatewaySha256(execution.response_body_bytes) !== observation.response_body_sha256) {
          proofFailure("catalog qualification request or response digest differs from the actual bytes");
        }
        await assertPreparationCurrent(preparation, false);
        const nowValue = canonicalNow(now).value;
        const observationJson = canonicalModelGatewayJson(observation);
        const observationSha = await modelGatewaySha256(observationJson);
        const observationRef = `provider-native-model-observation-v2-${observationSha}`;
        const requestBase64 = encodeCanonicalBase64Bytes(execution.request_body_bytes, 32_768);
        const responseBase64 = encodeCanonicalBase64Bytes(execution.response_body_bytes, 262_144);
        try {
          await db.prepare("UPDATE provider_native_model_catalog_v2_evidence SET state='OBSERVED',observation_ref=?1," +
            "observation_sha256=?2,observation_json=?3,request_body_base64=?4,response_body_base64=?5,updated_at=?6 " +
            "WHERE owner_ref=?7 AND project_id=?8 AND consent_operation_id=?9 AND stage=?10 AND state='CLAIMED'")
            .bind(observationRef, observationSha, observationJson, requestBase64, responseBase64, nowValue,
              input.owner_ref, input.project_id, input.owner_operation_id, input.stage).run();
        } catch (cause) { stale("catalog native v2 provider observation could not be persisted", cause); }
      } catch (cause) {
        try {
          await db.prepare("UPDATE provider_native_model_catalog_v2_evidence SET state='UNCERTAIN',updated_at=?1 " +
            "WHERE owner_ref=?2 AND project_id=?3 AND consent_operation_id=?4 AND stage=?5 AND state='CLAIMED'")
            .bind(canonicalNow(now).value, input.owner_ref, input.project_id, input.owner_operation_id, input.stage).run();
        } catch { /* The original one-shot effect remains unknown; no retry is allowed. */ }
        throw cause;
      }
      const observed = await readEvidenceByConsent(input.owner_ref, input.project_id, input.owner_operation_id, input.stage);
      if (observed === null || observed.state !== "OBSERVED" || observed.observation_json === null) stale("catalog v2 observation readback is unavailable");
      const observation = decodeProviderNativeModelCatalogObservationV2(decodeJson(observed.observation_json, "observation"));
      const bundle = await createProviderNativeModelCatalogCandidateBundleV2({ preparation,
        preparation_ref: observed.preparation_ref, preparation_sha256: observed.preparation_sha256, observation });
      try {
        await db.prepare("UPDATE provider_native_model_catalog_v2_evidence SET state='COMPLETED',candidate_ref=?1,candidate_sha256=?2," +
          "candidate_json=?3,qualification_ref=?4,qualification_sha256=?5,qualification_json=?6,updated_at=?7 " +
          "WHERE owner_ref=?8 AND project_id=?9 AND consent_operation_id=?10 AND stage=?11 AND state='OBSERVED'")
          .bind(bundle.candidate_ref, bundle.candidate_sha256, bundle.candidate_json, bundle.qualification_ref,
            bundle.qualification_sha256, bundle.qualification_json, canonicalNow(now).value,
            input.owner_ref, input.project_id, input.owner_operation_id, input.stage).run();
      } catch (cause) { stale("catalog native v2 proof could not be persisted", cause); }
      const completed = await readEvidenceByConsent(input.owner_ref, input.project_id, input.owner_operation_id, input.stage);
      if (completed === null || completed.state !== "COMPLETED" || completed.candidate_json !== bundle.candidate_json ||
          completed.qualification_json !== bundle.qualification_json) stale("catalog native v2 proof failed immutable readback");
      await makeResolved(bundle.selection, completed, false);
      return bundle.selection;
    },

    async resolvePinned(raw) {
      if (typeof raw.allow_expired_snapshot_v2 !== "boolean") invalid("catalog native v2 snapshot mode is invalid");
      const selection = decodeProviderNativeModelCatalogSelectionV2(raw.selection);
      const evidence = await readEvidenceBySelection(selection);
      if (evidence === null || evidence.owner_ref !== raw.owner_ref || evidence.project_id !== raw.project_id) {
        stale("catalog native v2 candidate is not available for this owner project");
      }
      return makeResolved(selection, evidence, raw.allow_expired_snapshot_v2);
    },

    async revoke(raw) {
      const selection = decodeProviderNativeModelCatalogSelectionV2(raw.selection);
      if (raw.owner_ref.length === 0 || raw.project_id.length === 0 || raw.reason.trim().length === 0 || raw.reason.length > 1024) {
        invalid("catalog native v2 revocation input is invalid");
      }
      const evidence = await readEvidenceBySelection(selection);
      if (evidence === null || evidence.owner_ref !== raw.owner_ref || evidence.project_id !== raw.project_id ||
          evidence.state !== "COMPLETED" || evidence.qualification_ref === null || evidence.qualification_sha256 === null) {
        stale("catalog native v2 proof is not available for revocation");
      }
      try {
        await db.prepare("INSERT INTO provider_native_model_catalog_v2_revocation(owner_ref,project_id,consent_operation_id,stage," +
          "qualification_ref,qualification_sha256,revoked_by,reason,revoked_at) VALUES (?1,?2,?3,?4,?5,?6,?1,?7,?8) " +
          "ON CONFLICT(owner_ref,project_id,qualification_ref,qualification_sha256) DO NOTHING")
          .bind(raw.owner_ref, raw.project_id, evidence.consent_operation_id, evidence.stage, evidence.qualification_ref,
            evidence.qualification_sha256, raw.reason.trim(), canonicalNow(now).value).run();
      } catch (cause) { stale("catalog native v2 revocation could not be persisted", cause); }
      if (!await readRevocation(raw.owner_ref, raw.project_id, evidence.qualification_ref, evidence.qualification_sha256)) {
        stale("catalog native v2 revocation did not read back");
      }
    },
  };
  return Object.freeze(authority);
}
