-- Server-owned raw conversion -> normalized admission reservation and snapshot witness.
-- The witness is required for the reserved snapshot-view source_view_ref family;
-- deleting it makes final admission fail closed. This table is a reservation/status
-- ledger and never replaces bundle_ingest_operation authority.
CREATE TABLE raw_normalized_admission (
  admission_operation_id TEXT PRIMARY KEY CHECK(length(admission_operation_id)=64 AND admission_operation_id NOT GLOB '*[^0-9a-f]*'),
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  capture_id TEXT NOT NULL CHECK(length(capture_id) BETWEEN 1 AND 256),
  conversion_operation_id TEXT NOT NULL CHECK(length(conversion_operation_id) BETWEEN 1 AND 256),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  input_fingerprint TEXT NOT NULL CHECK(length(input_fingerprint)=64 AND input_fingerprint NOT GLOB '*[^0-9a-f]*'),
  candidate_ref TEXT NOT NULL CHECK(length(candidate_ref) BETWEEN 1 AND 256),
  source_revision_ref TEXT NOT NULL CHECK(length(source_revision_ref) BETWEEN 1 AND 256),
  source_view_ref TEXT NOT NULL CHECK(length(source_view_ref) BETWEEN 1 AND 256),
  snapshot_view_json TEXT NOT NULL CHECK(json_valid(snapshot_view_json) AND length(snapshot_view_json) <= 16384),
  snapshot_view_sha256 TEXT NOT NULL CHECK(length(snapshot_view_sha256)=64 AND snapshot_view_sha256 NOT GLOB '*[^0-9a-f]*'),
  policy_snapshot_json TEXT NOT NULL CHECK(json_valid(policy_snapshot_json) AND length(policy_snapshot_json) <= 16384),
  policy_snapshot_sha256 TEXT NOT NULL CHECK(length(policy_snapshot_sha256)=64 AND policy_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  policy_revision INTEGER NOT NULL CHECK(policy_revision > 0 AND policy_revision < 9007199254740991),
  ingest_operation_id TEXT CHECK(ingest_operation_id IS NULL OR length(ingest_operation_id) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK(state IN ('PREPARING','UPLOAD_REQUIRED','VERIFIED','AUTHORIZED','PROMOTED','COMMITTED','QUARANTINED','REJECTED','UNKNOWN')),
  reason_codes_json TEXT NOT NULL CHECK(json_valid(reason_codes_json) AND length(reason_codes_json) <= 16384),
  receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND length(receipt_json) <= 65536)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(principal_ref, idempotency_key),
  UNIQUE(ingest_operation_id)
) STRICT;

CREATE INDEX raw_normalized_admission_owner_idx
  ON raw_normalized_admission(principal_ref, updated_at DESC);
CREATE INDEX raw_normalized_admission_capture_idx
  ON raw_normalized_admission(capture_id, principal_ref, updated_at DESC);
