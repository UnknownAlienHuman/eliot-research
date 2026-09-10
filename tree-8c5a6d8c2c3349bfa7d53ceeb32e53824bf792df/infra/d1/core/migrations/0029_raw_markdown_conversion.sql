-- L3 candidate-only raw capture conversion attempt ledger.
-- This records one server-owned Workers AI conversion effect and its immutable
-- readback. It does not create normalized evidence, manifests, or admission.
CREATE TABLE raw_markdown_conversion (
  operation_id TEXT PRIMARY KEY CHECK(length(operation_id)=64 AND operation_id NOT GLOB '*[^0-9a-f]*'),
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  capture_id TEXT NOT NULL CHECK(length(capture_id) BETWEEN 1 AND 128),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0 AND size_bytes < 9007199254740991),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(request_json) <= 16384),
  authority_sha256 TEXT NOT NULL CHECK(length(authority_sha256)=64 AND authority_sha256 NOT GLOB '*[^0-9a-f]*'),
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK(state IN ('STARTED','COMPLETE','FAILED','UNKNOWN')),
  result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND length(result_json) <= 65536)),
  result_sha256 TEXT CHECK(result_sha256 IS NULL OR (length(result_sha256)=64 AND result_sha256 NOT GLOB '*[^0-9a-f]*')),
  output_object_key TEXT NOT NULL CHECK(length(output_object_key) BETWEEN 1 AND 1024),
  receipt_object_key TEXT NOT NULL CHECK(length(receipt_object_key) BETWEEN 1 AND 1024),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(principal_ref, capture_id, request_sha256, authority_sha256),
  CHECK((state='STARTED' AND result_json IS NULL AND result_sha256 IS NULL) OR
        (state IN ('COMPLETE','FAILED','UNKNOWN') AND result_json IS NOT NULL)),
  CHECK((state='COMPLETE' AND result_sha256 IS NOT NULL) OR state <> 'COMPLETE')
) STRICT;

CREATE UNIQUE INDEX raw_markdown_conversion_attempt_idx
  ON raw_markdown_conversion(attempt_id);
CREATE INDEX raw_markdown_conversion_owner_idx
  ON raw_markdown_conversion(principal_ref, updated_at DESC);
