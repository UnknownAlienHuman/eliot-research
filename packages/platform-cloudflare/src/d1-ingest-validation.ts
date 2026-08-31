import {
  BundleAdmissionReceiptSchema,
  NormalizedBundleManifestSchema,
  ObjectResidencyKeySchema,
  type NormalizedBundleManifest,
  type ObjectResidencyKey,
} from "@eliotr/contracts";
import { canonicalJson, safeHashEntries } from "./ingest-validation.js";
import { objectResidencyKeyDigest, sha256Utf8 } from "./r2.js";
import type {
  IngestAdmissionPolicySnapshot,
  IngestOperationState,
  PrepareIngestAuthorityInput,
  PreparedIngestOperation,
} from "./d1-ingest-types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const OPERATION_STATES = new Set<IngestOperationState>([
  "PREPARING",
  "UPLOAD_REQUIRED",
  "VERIFIED",
  "AUTHORIZED",
  "PROMOTED",
  "COMMITTED",
  "QUARANTINED",
  "REJECTED",
]);
const OWNERSHIP_MODES = new Set<NormalizedBundleManifest["origin"]["ownership_mode"]>([
  "federated_reference",
  "immutable_import",
  "ownership_cutover",
]);
const ASSURANCE = new Set(["UNVERIFIED", "LOCATOR_ONLY", "CAPTURED", "QUALIFIED", "EXACT"]);
const TAINT = new Set(["CLEARED", "DATA_ONLY", "UNTRUSTED", "COMMAND_LIKE"]);
const EFFECTS = new Set(["READ_ONLY", "CANDIDATE_ONLY", "NO_EXTERNAL_EFFECT"]);
const QUALITY = new Set(["high_fidelity", "standard", "degraded"]);

export type IngestAuthorityErrorCode =
  | "INGEST_AUTHORITY_INPUT_INVALID"
  | "INGEST_AUTHORITY_MISSING"
  | "INGEST_AUTHORITY_CONFLICT"
  | "INGEST_OWNER_NOT_ACTIVE"
  | "INGEST_POLICY_DENIED"
  | "INGEST_STATE_CONFLICT"
  | "INGEST_SETTLEMENT_UNCERTAIN";

export class IngestAuthorityError extends Error {
  public readonly code: IngestAuthorityErrorCode;
  public readonly retryable: boolean;

  public constructor(
    code: IngestAuthorityErrorCode,
    message: string,
    retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "IngestAuthorityError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function authorityFail(
  code: IngestAuthorityErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new IngestAuthorityError(code, message, retryable, cause);
}

export function authorityIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

export function authoritySha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} is not a lowercase SHA-256 digest`);
  }
  return value;
}

export function authorityPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} is not a positive safe integer`);
  }
  return value;
}

export function authorityIso(value: unknown, label: string): string {
  if (typeof value !== "string") {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} is not an ISO timestamp`);
  }
  const epoch = Date.parse(value);
  if (!Number.isSafeInteger(epoch) || new Date(epoch).toISOString() !== value) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} is not canonical ISO-8601`);
  }
  return value;
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} is not JSON text`);
  }
  try {
    return JSON.parse(value);
  } catch (cause) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} is malformed JSON`, false, cause);
  }
}

function identifierArray(value: unknown, label: string, allowEmpty = false): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 256) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} is not a bounded array`);
  }
  const values = value.map((entry) => authorityIdentifier(entry, `${label} member`));
  if (new Set(values).size !== values.length) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} contains duplicates`);
  }
  return values;
}

export interface ActiveOwnerRow {
  readonly source_namespace_id: unknown;
  readonly ownership_record_revision: unknown;
  readonly owner_system_id: unknown;
  readonly source_owner_generation: unknown;
  readonly source_admission_policy_revision: unknown;
  readonly status: unknown;
  readonly cutover_receipt_ref: unknown;
}

export interface AdmissionPolicyRow {
  readonly source_namespace_id: unknown;
  readonly revision: unknown;
  readonly authorized_principal_refs_json: unknown;
  readonly allowed_ownership_modes_json: unknown;
  readonly source_class: unknown;
  readonly assurance_ceiling: unknown;
  readonly instruction_taint: unknown;
  readonly allowed_effects: unknown;
  readonly allowed_use_json: unknown;
  readonly disclosure_ceiling: unknown;
  readonly license_policy_ref: unknown;
  readonly default_storage_policy: unknown;
  readonly default_residency_profile_id: unknown;
  readonly default_retention_policy_id: unknown;
  readonly minimum_quality_state: unknown;
  readonly created_at: unknown;
}

export interface ExistingSourceRow {
  readonly source_id: unknown;
  readonly source_namespace_id: unknown;
  readonly source_owner_system_id: unknown;
  readonly source_owner_generation: unknown;
  readonly ownership_mode: unknown;
  readonly head_rev: unknown;
}

export interface IngestOperationRow {
  readonly operation_id: unknown;
  readonly principal_ref: unknown;
  readonly origin_authentication_receipt_ref: unknown;
  readonly idempotency_key: unknown;
  readonly input_fingerprint: unknown;
  readonly manifest_sha256: unknown;
  readonly manifest_json: unknown;
  readonly file_hashes_json: unknown;
  readonly total_bytes: unknown;
  readonly source_namespace_id: unknown;
  readonly owner_system_id: unknown;
  readonly source_owner_generation: unknown;
  readonly source_revision_ref: unknown;
  readonly source_id: unknown;
  readonly expected_head_revision_ref: unknown;
  readonly residency_key_json: unknown;
  readonly residency_key_digest: unknown;
  readonly policy_revision: unknown;
  readonly policy_snapshot_json: unknown;
  readonly policy_snapshot_sha256: unknown;
  readonly candidate_id: unknown;
  readonly staging_session_ref: unknown;
  readonly qualification_report_ref: unknown;
  readonly decision_receipt_ref: unknown;
  readonly promotion_receipt_ref: unknown;
  readonly state: unknown;
  readonly bundle_receipt_json: unknown;
  readonly bundle_receipt_sha256: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly expires_at: unknown;
}

export function decodePolicyRow(row: AdmissionPolicyRow): IngestAdmissionPolicySnapshot {
  const sourceNamespaceId = authorityIdentifier(row.source_namespace_id, "policy source_namespace_id");
  const revision = authorityPositiveInteger(row.revision, "policy revision");
  const authorized = identifierArray(
    parseJson(row.authorized_principal_refs_json, "authorized principals"),
    "authorized principals",
  );
  const rawModes = parseJson(row.allowed_ownership_modes_json, "allowed ownership modes");
  if (!Array.isArray(rawModes) || rawModes.length === 0 || rawModes.length > 3) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "allowed ownership modes are invalid");
  }
  const modes = rawModes.map((mode) => {
    if (typeof mode !== "string" || !OWNERSHIP_MODES.has(mode as NormalizedBundleManifest["origin"]["ownership_mode"])) {
      authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "policy contains an unsupported ownership mode");
    }
    return mode as NormalizedBundleManifest["origin"]["ownership_mode"];
  });
  if (new Set(modes).size !== modes.length) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "allowed ownership modes contain duplicates");
  }
  const assurance = authorityIdentifier(row.assurance_ceiling, "assurance ceiling");
  const taint = authorityIdentifier(row.instruction_taint, "instruction taint");
  const effects = authorityIdentifier(row.allowed_effects, "allowed effects");
  const minimumQuality = authorityIdentifier(row.minimum_quality_state, "minimum quality state");
  if (!ASSURANCE.has(assurance) || !TAINT.has(taint) || !EFFECTS.has(effects) || !QUALITY.has(minimumQuality)) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "policy enum field is invalid");
  }
  return {
    source_namespace_id: sourceNamespaceId,
    revision,
    authorized_principal_refs: authorized,
    allowed_ownership_modes: modes,
    source_class: authorityIdentifier(row.source_class, "source class"),
    assurance_ceiling: assurance as IngestAdmissionPolicySnapshot["assurance_ceiling"],
    instruction_taint: taint as IngestAdmissionPolicySnapshot["instruction_taint"],
    allowed_effects: effects as IngestAdmissionPolicySnapshot["allowed_effects"],
    allowed_use: identifierArray(parseJson(row.allowed_use_json, "allowed use"), "allowed use", true),
    disclosure_ceiling: authorityIdentifier(row.disclosure_ceiling, "disclosure ceiling"),
    license_policy_ref: authorityIdentifier(row.license_policy_ref, "license policy ref"),
    default_storage_policy: authorityIdentifier(row.default_storage_policy, "default storage policy"),
    default_residency_profile_id: authorityIdentifier(row.default_residency_profile_id, "default residency profile"),
    default_retention_policy_id: authorityIdentifier(row.default_retention_policy_id, "default retention policy"),
    minimum_quality_state: minimumQuality as IngestAdmissionPolicySnapshot["minimum_quality_state"],
    created_at: authorityIso(row.created_at, "policy created_at"),
  };
}

export function residencyKeyForManifest(manifest: NormalizedBundleManifest): ObjectResidencyKey {
  return ObjectResidencyKeySchema.parse({
    scope_domain_id: manifest.residency_and_disclosure.scope_domain_id,
    access_domain_id: manifest.residency_and_disclosure.access_domain_id,
    confidentiality_domain_id: manifest.residency_and_disclosure.confidentiality_domain_id,
    encryption_key_domain_id: manifest.residency_and_disclosure.encryption_key_domain_id,
    retention_domain_id: manifest.residency_and_disclosure.retention_domain_id,
    erasure_domain_id: manifest.residency_and_disclosure.erasure_domain_id,
    content_digest: { algorithm: "sha256", digest: manifest.content.markdown_sha256 },
  });
}

export async function stableIngestId(prefix: string, ...parts: readonly string[]): Promise<string> {
  const digest = await sha256Utf8([prefix, ...parts].join("\u0000"));
  return `${prefix}-${digest.slice(0, 48)}`;
}

export async function canonicalDigest(value: unknown): Promise<string> {
  return sha256Utf8(canonicalJson(value));
}

export async function ingestInputFingerprint(input: {
  readonly principal_ref: string;
  readonly origin_authentication_receipt_ref: string;
  readonly idempotency_key: string;
  readonly manifest: NormalizedBundleManifest;
  readonly file_hashes: Readonly<Record<string, string>>;
  readonly total_bytes: number;
  readonly residency_key: ObjectResidencyKey;
  readonly residency_key_digest: string;
  readonly expected_head_revision_ref: string | null;
  readonly policy_snapshot_sha256: string;
}): Promise<string> {
  return canonicalDigest(input);
}

export async function decodeOperationRow(row: IngestOperationRow): Promise<PreparedIngestOperation> {
  const manifestRaw = parseJson(row.manifest_json, "stored manifest");
  const residencyRaw = parseJson(row.residency_key_json, "stored residency key");
  const fileHashesRaw = parseJson(row.file_hashes_json, "stored file hashes");
  const policyRaw = parseJson(row.policy_snapshot_json, "stored policy snapshot");
  let manifest: NormalizedBundleManifest;
  let residencyKey: ObjectResidencyKey;
  let policy: IngestAdmissionPolicySnapshot;
  try {
    manifest = NormalizedBundleManifestSchema.parse(manifestRaw);
    residencyKey = ObjectResidencyKeySchema.parse(residencyRaw);
    policy = policyRaw as IngestAdmissionPolicySnapshot;
    policy = decodePolicyRow({
      source_namespace_id: policy.source_namespace_id,
      revision: policy.revision,
      authorized_principal_refs_json: JSON.stringify(policy.authorized_principal_refs),
      allowed_ownership_modes_json: JSON.stringify(policy.allowed_ownership_modes),
      source_class: policy.source_class,
      assurance_ceiling: policy.assurance_ceiling,
      instruction_taint: policy.instruction_taint,
      allowed_effects: policy.allowed_effects,
      allowed_use_json: JSON.stringify(policy.allowed_use),
      disclosure_ceiling: policy.disclosure_ceiling,
      license_policy_ref: policy.license_policy_ref,
      default_storage_policy: policy.default_storage_policy,
      default_residency_profile_id: policy.default_residency_profile_id,
      default_retention_policy_id: policy.default_retention_policy_id,
      minimum_quality_state: policy.minimum_quality_state,
      created_at: policy.created_at,
    });
  } catch (cause) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "stored ingest authority failed strict decoding", false, cause);
  }
  if (canonicalJson(manifestRaw) !== row.manifest_json || canonicalJson(policyRaw) !== row.policy_snapshot_json) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "stored ingest JSON is not canonical");
  }
  const fileEntries = safeHashEntries(fileHashesRaw as Readonly<Record<string, string>>, 1024);
  const fileHashes = Object.fromEntries(fileEntries.map((entry) => [entry.path, entry.sha256]));
  const manifestSha = authoritySha256(row.manifest_sha256, "stored manifest digest");
  const policySha = authoritySha256(row.policy_snapshot_sha256, "stored policy digest");
  const residencyDigest = authoritySha256(row.residency_key_digest, "stored residency digest");
  if (
    await canonicalDigest(manifest) !== manifestSha ||
    await canonicalDigest(policy) !== policySha ||
    await objectResidencyKeyDigest(residencyKey) !== residencyDigest
  ) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "stored ingest authority digest mismatch");
  }
  const expectedHead = row.expected_head_revision_ref === null
    ? null
    : authorityIdentifier(row.expected_head_revision_ref, "expected source head");
  const state = authorityIdentifier(row.state, "ingest state") as IngestOperationState;
  if (!OPERATION_STATES.has(state)) authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "ingest state is invalid");
  const totalBytes = authorityPositiveInteger(row.total_bytes, "total bytes");
  const bundleJson = row.bundle_receipt_json;
  const bundleSha = row.bundle_receipt_sha256;
  let bundleReceipt = null;
  if (bundleJson !== null || bundleSha !== null) {
    if (typeof bundleJson !== "string" || typeof bundleSha !== "string") {
      authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "terminal ingest receipt is incomplete");
    }
    const parsed = parseJson(bundleJson, "terminal bundle receipt");
    try { bundleReceipt = BundleAdmissionReceiptSchema.parse(parsed); }
    catch (cause) {
      authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "terminal bundle receipt is malformed", false, cause);
    }
    if (canonicalJson(parsed) !== bundleJson || await canonicalDigest(bundleReceipt) !== authoritySha256(bundleSha, "bundle receipt digest")) {
      authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "terminal bundle receipt digest mismatch");
    }
  }
  const operation: PreparedIngestOperation = {
    operation_id: authorityIdentifier(row.operation_id, "operation_id"),
    principal_ref: authorityIdentifier(row.principal_ref, "principal_ref"),
    origin_authentication_receipt_ref: authorityIdentifier(
      row.origin_authentication_receipt_ref,
      "origin authentication receipt",
    ),
    idempotency_key: authorityIdentifier(row.idempotency_key, "idempotency key"),
    input_fingerprint: authoritySha256(row.input_fingerprint, "input fingerprint"),
    manifest_sha256: manifestSha,
    manifest,
    file_hashes: fileHashes,
    total_bytes: totalBytes,
    source_namespace_id: authorityIdentifier(row.source_namespace_id, "source namespace"),
    owner_system_id: authorityIdentifier(row.owner_system_id, "owner system"),
    source_owner_generation: authorityIdentifier(row.source_owner_generation, "owner generation"),
    source_revision_ref: authorityIdentifier(row.source_revision_ref, "source revision"),
    source_id: authorityIdentifier(row.source_id, "source id"),
    expected_head_revision_ref: expectedHead,
    residency_key: residencyKey,
    residency_key_digest: residencyDigest,
    policy,
    policy_snapshot_sha256: policySha,
    candidate_id: authorityIdentifier(row.candidate_id, "candidate id"),
    staging_session_ref: row.staging_session_ref === null
      ? null
      : authorityIdentifier(row.staging_session_ref, "staging session"),
    qualification_report_ref: row.qualification_report_ref === null
      ? null
      : authorityIdentifier(row.qualification_report_ref, "qualification report ref"),
    decision_receipt_ref: row.decision_receipt_ref === null
      ? null
      : authorityIdentifier(row.decision_receipt_ref, "decision receipt ref"),
    promotion_receipt_ref: row.promotion_receipt_ref === null
      ? null
      : authorityIdentifier(row.promotion_receipt_ref, "promotion receipt ref"),
    state,
    bundle_receipt: bundleReceipt,
    created_at: authorityIso(row.created_at, "operation created_at"),
    updated_at: authorityIso(row.updated_at, "operation updated_at"),
    expires_at: authorityIso(row.expires_at, "operation expires_at"),
  };
  const fingerprint = await ingestInputFingerprint({
    principal_ref: operation.principal_ref,
    origin_authentication_receipt_ref: operation.origin_authentication_receipt_ref,
    idempotency_key: operation.idempotency_key,
    manifest: operation.manifest,
    file_hashes: operation.file_hashes,
    total_bytes: operation.total_bytes,
    residency_key: operation.residency_key,
    residency_key_digest: operation.residency_key_digest,
    expected_head_revision_ref: operation.expected_head_revision_ref,
    policy_snapshot_sha256: operation.policy_snapshot_sha256,
  });
  if (fingerprint !== operation.input_fingerprint) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "stored ingest input fingerprint mismatch");
  }
  return operation;
}

export async function normalizePrepareInput(input: PrepareIngestAuthorityInput): Promise<{
  readonly principal_ref: string;
  readonly origin_authentication_receipt_ref: string;
  readonly idempotency_key: string;
  readonly manifest: NormalizedBundleManifest;
  readonly file_hashes: Readonly<Record<string, string>>;
  readonly total_bytes: number;
  readonly residency_key: ObjectResidencyKey;
}> {
  const principalRef = authorityIdentifier(input.principal_ref, "principal_ref");
  const originReceipt = authorityIdentifier(
    input.origin_authentication_receipt_ref,
    "origin authentication receipt",
  );
  const idempotencyKey = authorityIdentifier(input.idempotency_key, "idempotency key");
  let manifest: NormalizedBundleManifest;
  let residencyKey: ObjectResidencyKey;
  try {
    manifest = NormalizedBundleManifestSchema.parse(input.manifest);
    residencyKey = ObjectResidencyKeySchema.parse(input.residency_key);
  } catch (cause) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "prepare input failed strict contract validation", false, cause);
  }
  const entries = safeHashEntries(input.file_hashes, 1024);
  const fileHashes = Object.fromEntries(entries.map((entry) => [entry.path, entry.sha256]));
  if (!Number.isSafeInteger(input.total_bytes) || input.total_bytes < 1 || input.total_bytes > 50 * 1024 * 1024 * 1024) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "total_bytes is outside its bounded range");
  }
  return {
    principal_ref: principalRef,
    origin_authentication_receipt_ref: originReceipt,
    idempotency_key: idempotencyKey,
    manifest,
    file_hashes: fileHashes,
    total_bytes: input.total_bytes,
    residency_key: residencyKey,
  };
}
