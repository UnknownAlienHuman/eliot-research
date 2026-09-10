import {
  SNAPSHOT_VIEW_REF_PREFIX,
  SnapshotViewWitnessSchema,
  type SnapshotViewWitness,
} from "@eliotr/contracts";
import { canonicalJson } from "./ingest-validation.js";
import type { PreparedIngestOperation } from "./d1-ingest-types.js";
import {
  authorityFail,
  authorityIdentifier,
  authorityIso,
  authoritySha256,
  canonicalDigest,
} from "./d1-ingest-validation.js";

interface RawAdmissionSnapshotRow {
  readonly admission_operation_id: unknown;
  readonly principal_ref: unknown;
  readonly capture_id: unknown;
  readonly source_revision_ref: unknown;
  readonly source_view_ref: unknown;
  readonly snapshot_view_json: unknown;
  readonly snapshot_view_sha256: unknown;
  readonly state: unknown;
}

export interface VerifiedSnapshotViewFence {
  readonly admission_operation_id: string;
  readonly principal_ref: string;
  readonly capture_id: string;
  readonly source_revision_ref: string;
  readonly source_view_ref: string;
  readonly snapshot_view_json: string;
  readonly snapshot_view_sha256: string;
}

function snapshotViewDescriptor(witness: SnapshotViewWitness): Record<string, unknown> {
  return {
    protocol: witness.protocol,
    capture_id: witness.capture_id,
    source_revision_ref: witness.source_revision_ref,
    source_logical_id: witness.source_logical_id,
    verified_principal_ref: witness.verified_principal_ref,
    owner_system_id: witness.owner_system_id,
    source_namespace_id: witness.source_namespace_id,
    source_owner_generation: witness.source_owner_generation,
    original_sha256: witness.original_sha256,
    original_size_bytes: witness.original_size_bytes,
    residency_key_digest: witness.residency_key_digest,
    policy_snapshot_sha256: witness.policy_snapshot_sha256,
    policy_revision: witness.policy_revision,
    observed_at: witness.observed_at,
    observation_freshness: witness.observation_freshness,
  };
}

export async function loadVerifiedSnapshotViewFence(
  database: D1Database,
  operation: PreparedIngestOperation,
): Promise<VerifiedSnapshotViewFence> {
  const sourceViewRef = operation.manifest.origin.source_view_ref;
  const row = await database.prepare(
    "SELECT admission_operation_id,principal_ref,capture_id,source_revision_ref,source_view_ref," +
    "snapshot_view_json,snapshot_view_sha256,state FROM raw_normalized_admission " +
    "WHERE ingest_operation_id=?1 AND source_view_ref=?2 LIMIT 1",
  ).bind(operation.operation_id, sourceViewRef).first<RawAdmissionSnapshotRow>();
  if (row === null) authorityFail("INGEST_AUTHORITY_MISSING", "raw normalized admission witness is missing");
  const admissionOperationId = authorityIdentifier(row.admission_operation_id, "raw admission operation id");
  const principalRef = authorityIdentifier(row.principal_ref, "raw admission principal");
  const captureId = authorityIdentifier(row.capture_id, "raw admission capture id");
  const sourceRevisionRef = authorityIdentifier(row.source_revision_ref, "raw admission source revision");
  const storedSourceViewRef = authorityIdentifier(row.source_view_ref, "raw admission source view");
  if (storedSourceViewRef !== sourceViewRef || principalRef !== operation.principal_ref || sourceRevisionRef !== operation.source_revision_ref) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "raw admission witness identity does not match ingest operation");
  }
  // UNKNOWN is a recoverable replay state after a lost ACK; only terminal
  // rejection/quarantine rows are barred from entering the commit batch.
  if (row.state === "REJECTED" || row.state === "QUARANTINED") {
    authorityFail("INGEST_STATE_CONFLICT", "raw admission witness is not committable");
  }
  if (typeof row.snapshot_view_json !== "string") authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "raw admission snapshot view is not JSON text");
  let decoded: unknown;
  try { decoded = JSON.parse(row.snapshot_view_json); }
  catch (cause) { authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "raw admission snapshot view is malformed JSON", false, cause); }
  let witness: SnapshotViewWitness;
  try { witness = SnapshotViewWitnessSchema.parse(decoded); }
  catch (cause) { authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "raw admission snapshot view failed strict decoding", false, cause); }
  if (canonicalJson(witness) !== row.snapshot_view_json) authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "raw admission snapshot view is not canonical JSON");
  const snapshotViewSha256 = authoritySha256(row.snapshot_view_sha256, "raw admission snapshot view digest");
  if (await canonicalDigest(witness) !== snapshotViewSha256) authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "raw admission snapshot view digest mismatch");
  authorityIso(witness.observed_at, "raw admission snapshot observed_at");
  const descriptorRef = `${SNAPSHOT_VIEW_REF_PREFIX}${await canonicalDigest(snapshotViewDescriptor(witness))}`;
  if (witness.source_view_ref !== descriptorRef || witness.source_view_ref !== sourceViewRef) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "raw admission snapshot descriptor reference mismatch");
  }
  if (witness.source_revision_ref !== operation.source_revision_ref || witness.verified_principal_ref !== operation.principal_ref) {
    authorityFail("INGEST_AUTHORITY_INPUT_INVALID", "raw admission snapshot binding does not match ingest operation");
  }
  return {
    admission_operation_id: admissionOperationId,
    principal_ref: principalRef,
    capture_id: captureId,
    source_revision_ref: sourceRevisionRef,
    source_view_ref: storedSourceViewRef,
    snapshot_view_json: row.snapshot_view_json,
    snapshot_view_sha256: snapshotViewSha256,
  };
}
