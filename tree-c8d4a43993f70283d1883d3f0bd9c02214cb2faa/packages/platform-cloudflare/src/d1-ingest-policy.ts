import type { IngestAdmissionPolicySnapshot, PreparedIngestOperation } from "./d1-ingest-types.js";
import { authorityFail, canonicalDigest, decodePolicyRow, type ActiveOwnerRow, type AdmissionPolicyRow } from "./d1-ingest-validation.js";

export async function activeOwner(
  database: D1Database,
  namespaceId: string,
): Promise<ActiveOwnerRow> {
  const row = await database.prepare(
    "SELECT source_namespace_id, ownership_record_revision, owner_system_id, " +
    "source_owner_generation, source_admission_policy_revision, status, cutover_receipt_ref " +
    "FROM source_namespace_ownership WHERE source_namespace_id = ?1 AND status = 'ACTIVE' " +
    "ORDER BY ownership_record_revision DESC LIMIT 1",
  ).bind(namespaceId).first<ActiveOwnerRow>();
  if (row === null) authorityFail("INGEST_OWNER_NOT_ACTIVE", "source namespace has no active owner");
  return row;
}

export async function policySnapshot(
  database: D1Database,
  namespaceId: string,
  revision: number,
): Promise<IngestAdmissionPolicySnapshot> {
  const row = await database.prepare(
    "SELECT source_namespace_id, revision, authorized_principal_refs_json, " +
    "allowed_ownership_modes_json, source_class, assurance_ceiling, instruction_taint, " +
    "allowed_effects, allowed_use_json, disclosure_ceiling, license_policy_ref, " +
    "default_storage_policy, default_residency_profile_id, default_retention_policy_id, " +
    "minimum_quality_state, created_at FROM source_admission_policy " +
    "WHERE source_namespace_id = ?1 AND revision = ?2 LIMIT 1",
  ).bind(namespaceId, revision).first<AdmissionPolicyRow>();
  if (row === null) authorityFail("INGEST_POLICY_DENIED", "active source admission policy is missing");
  return decodePolicyRow(row);
}

export function ensureOwnerAndPolicy(
  input: Pick<PreparedIngestOperation, "manifest" | "principal_ref">,
  owner: ActiveOwnerRow,
  policy: IngestAdmissionPolicySnapshot,
): void {
  const manifest = input.manifest;
  if (
    owner.source_namespace_id !== manifest.origin.source_namespace_id ||
    owner.owner_system_id !== manifest.origin.owner_system_id ||
    owner.source_owner_generation !== manifest.origin.source_owner_generation ||
    owner.status !== "ACTIVE"
  ) {
    authorityFail("INGEST_OWNER_NOT_ACTIVE", "normalized bundle owner generation is not active");
  }
  if (
    typeof owner.source_admission_policy_revision !== "number" ||
    owner.source_admission_policy_revision !== policy.revision
  ) {
    authorityFail("INGEST_POLICY_DENIED", "active owner policy revision is inconsistent");
  }
  const cutoverRef = manifest.origin.ownership_cutover_receipt_ref;
  if (manifest.origin.ownership_mode === "ownership_cutover") {
    if (typeof owner.cutover_receipt_ref !== "string" || owner.cutover_receipt_ref !== cutoverRef) {
      authorityFail("INGEST_OWNER_NOT_ACTIVE", "ownership cutover receipt is not bound to the active owner");
    }
  } else if (owner.cutover_receipt_ref !== null && cutoverRef !== undefined) {
    authorityFail("INGEST_OWNER_NOT_ACTIVE", "unexpected ownership cutover receipt");
  }
  if (!policy.authorized_principal_refs.includes(input.principal_ref)) {
    authorityFail("INGEST_POLICY_DENIED", "principal is not authorized by the source admission policy");
  }
  if (!policy.allowed_ownership_modes.includes(manifest.origin.ownership_mode)) {
    authorityFail("INGEST_POLICY_DENIED", "ownership mode is not allowed by the source admission policy");
  }
  if (manifest.residency_and_disclosure.disclosure_ceiling !== policy.disclosure_ceiling) {
    authorityFail("INGEST_POLICY_DENIED", "manifest disclosure ceiling does not match policy");
  }
  if (manifest.residency_and_disclosure.allowed_use.some((use) => !policy.allowed_use.includes(use))) {
    authorityFail("INGEST_POLICY_DENIED", "manifest requests an allowed-use capability outside policy");
  }
}


/** The reservation is a snapshot, not a perpetual grant. Check the current owner and exact policy. */
export async function requireCurrentIngestPolicy(database: D1Database, operation: PreparedIngestOperation,
  now: () => number): Promise<void> {
  const owner = await activeOwner(database, operation.source_namespace_id);
  if (typeof owner.source_admission_policy_revision !== "number" || owner.source_admission_policy_revision !== operation.policy.revision) {
    authorityFail("INGEST_POLICY_DENIED", "admission policy revision changed after reservation");
  }
  const policy = await policySnapshot(database, operation.source_namespace_id, operation.policy.revision);
  ensureOwnerAndPolicy(operation, owner, policy);
  if (await canonicalDigest(policy) !== operation.policy_snapshot_sha256) {
    authorityFail("INGEST_POLICY_DENIED", "admission policy bytes changed after reservation");
  }
  const timestamp = now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || (!operation.bundle_receipt && Date.parse(operation.expires_at) <= timestamp)) {
    authorityFail("INGEST_STATE_CONFLICT", "ingest operation expired or clock is invalid");
  }
}

/** p = current policy, b = stored operation. Used INSIDE the source/head/outbox transaction guard. */
export const CURRENT_INGEST_POLICY_SQL = [
  ...["source_namespace_id", "source_class", "assurance_ceiling", "instruction_taint", "allowed_effects", "disclosure_ceiling",
    "license_policy_ref", "default_storage_policy", "default_residency_profile_id", "default_retention_policy_id", "minimum_quality_state", "created_at", "revision"]
    .map((field) => `p.${field}=json_extract(b.policy_snapshot_json,'$.${field}')`),
  ...["authorized_principal_refs", "allowed_ownership_modes", "allowed_use"]
    .map((field) => `json(p.${field}_json)=json_extract(b.policy_snapshot_json,'$.${field}')`),
].join(" AND ");
