import {
  canonicalDigest,
  IngestAuthorityError,
  type BundlePromotionAuthorization,
  type IngestAdmissionAuthority,
  type PreparedIngestOperation,
} from "@eliotr/platform-cloudflare";

interface OwnerFenceIdentity {
  readonly source_namespace_id: string;
  readonly owner_system_id: string;
  readonly source_owner_generation: string;
  readonly policy_revision?: number;
}

export async function requireCurrentIngestOwner(
  database: D1Database,
  identity: OwnerFenceIdentity,
): Promise<void> {
  const row = await database.prepare(
    "SELECT source_admission_policy_revision FROM source_namespace_ownership " +
    "WHERE source_namespace_id = ?1 AND owner_system_id = ?2 " +
    "AND source_owner_generation = ?3 AND status = 'ACTIVE' LIMIT 1",
  ).bind(
    identity.source_namespace_id,
    identity.owner_system_id,
    identity.source_owner_generation,
  ).first<{ source_admission_policy_revision: unknown }>();
  const revision = row?.source_admission_policy_revision;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    (identity.policy_revision !== undefined && revision !== identity.policy_revision)
  ) {
    throw new IngestAuthorityError(
      "INGEST_OWNER_NOT_ACTIVE",
      "source owner generation or admission policy changed during ingest",
    );
  }
}

async function operationForStagingSession(
  database: D1Database,
  authority: IngestAdmissionAuthority,
  sessionRef: string,
): Promise<PreparedIngestOperation | null> {
  const row = await database.prepare(
    "SELECT operation_id FROM bundle_ingest_operation WHERE staging_session_ref = ?1 LIMIT 1",
  ).bind(sessionRef).first<{ operation_id: unknown }>();
  if (typeof row?.operation_id !== "string") return null;
  return authority.load(row.operation_id);
}

export async function stagedBundleInputFingerprint(
  operation: PreparedIngestOperation,
): Promise<string> {
  const files = Object.entries(operation.file_hashes)
    .map(([path, sha256]) => ({ path, sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return canonicalDigest({
    manifest: operation.manifest,
    residency_key: operation.residency_key,
    file_hashes: files,
    total_bytes: operation.total_bytes,
  });
}

export async function authorizeIngestPromotion(
  database: D1Database,
  authority: IngestAdmissionAuthority,
  input: BundlePromotionAuthorization,
  admissionReceiptRef: string,
): Promise<boolean> {
  const operation = await operationForStagingSession(database, authority, input.session_id);
  if (operation === null) return false;
  await requireCurrentIngestOwner(database, {
    source_namespace_id: operation.source_namespace_id,
    owner_system_id: operation.owner_system_id,
    source_owner_generation: operation.source_owner_generation,
    policy_revision: operation.policy.revision,
  });
  if (
    operation.state !== "AUTHORIZED" ||
    operation.staging_session_ref !== input.session_id ||
    await stagedBundleInputFingerprint(operation) !== input.input_fingerprint ||
    operation.residency_key_digest !== input.residency_key_digest ||
    operation.owner_system_id !== input.owner_system_id ||
    operation.source_namespace_id !== input.source_namespace_id ||
    operation.source_owner_generation !== input.source_owner_generation ||
    operation.source_revision_ref !== input.source_revision_ref ||
    operation.decision_receipt_ref !== admissionReceiptRef
  ) return false;
  return authority.authorizePromotion(
    { ...input, input_fingerprint: operation.input_fingerprint },
    admissionReceiptRef,
  );
}
