-- L2 raw-file capture intent and immutable receipt.
-- This table records transport settlement only. It does not create a source,
-- admission decision, normalized manifest, or evidence handle.
CREATE TABLE raw_file_capture (
  capture_id TEXT PRIMARY KEY CHECK(length(capture_id) BETWEEN 1 AND 128),
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  owner_system_id TEXT NOT NULL CHECK(length(owner_system_id) BETWEEN 1 AND 256),
  source_namespace_id TEXT NOT NULL CHECK(length(source_namespace_id) BETWEEN 1 AND 256),
  source_revision_ref TEXT NOT NULL CHECK(length(source_revision_ref) BETWEEN 1 AND 256),
  source_logical_id TEXT NOT NULL CHECK(length(source_logical_id) BETWEEN 1 AND 256),
  source_owner_generation TEXT NOT NULL CHECK(length(source_owner_generation) BETWEEN 1 AND 256),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  original_file_name TEXT NOT NULL CHECK(length(original_file_name) BETWEEN 1 AND 512),
  request_digest TEXT NOT NULL CHECK(length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  residency_key_json TEXT NOT NULL CHECK(json_valid(residency_key_json) AND length(residency_key_json) <= 4096),
  residency_key_digest TEXT NOT NULL CHECK(length(residency_key_digest) = 64 AND residency_key_digest NOT GLOB '*[^0-9a-f]*'),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0 AND size_bytes < 9007199254740991),
  content_type TEXT NOT NULL CHECK(length(content_type) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK(state IN ('INTENT','CAPTURED')),
  object_key TEXT NOT NULL CHECK(length(object_key) BETWEEN 1 AND 1024),
  receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND length(receipt_json) <= 65536)),
  receipt_sha256 TEXT CHECK(receipt_sha256 IS NULL OR (length(receipt_sha256) = 64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE(principal_ref, idempotency_key),
  CHECK((state = 'INTENT' AND receipt_json IS NULL AND receipt_sha256 IS NULL) OR
        (state = 'CAPTURED' AND receipt_json IS NOT NULL AND receipt_sha256 IS NOT NULL))
) STRICT;

CREATE INDEX raw_file_capture_owner_state_idx
  ON raw_file_capture(principal_ref, state, updated_at DESC);

CREATE INDEX raw_file_capture_expiry_idx
  ON raw_file_capture(state, expires_at);
