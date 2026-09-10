-- ER-09 W3: immutable model output residency and receipt binding.
-- The logical output reference is reserved before a provider call.  The
-- content digest and physical R2 key are populated only after bounded output
-- bytes have been received and verified.
PRAGMA foreign_keys = ON;

CREATE TABLE research_model_output (
  output_object_ref TEXT PRIMARY KEY CHECK(length(output_object_ref) BETWEEN 1 AND 256),
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 128),
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  stage_attempt_ref TEXT NOT NULL CHECK(length(stage_attempt_ref) BETWEEN 1 AND 256),
  stage_request_sha256 TEXT NOT NULL CHECK(length(stage_request_sha256) = 64 AND stage_request_sha256 NOT GLOB '*[^0-9a-f]*'),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  workflow_budget_receipt_ref TEXT NOT NULL CHECK(length(workflow_budget_receipt_ref) BETWEEN 1 AND 256),
  residency_domain_json TEXT NOT NULL CHECK(json_valid(residency_domain_json) AND length(CAST(residency_domain_json AS BLOB)) <= 4096),
  residency_domain_sha256 TEXT NOT NULL CHECK(length(residency_domain_sha256) = 64 AND residency_domain_sha256 NOT GLOB '*[^0-9a-f]*'),
  r2_key TEXT,
  r2_etag TEXT,
  output_sha256 TEXT,
  output_size_bytes INTEGER,
  readback_sha256 TEXT,
  state TEXT NOT NULL CHECK(state IN ('PREPARED','COMMITTED')),
  created_at TEXT NOT NULL,
  committed_at TEXT,
  FOREIGN KEY(attempt_id) REFERENCES research_model_attempt(attempt_id),
  UNIQUE(attempt_id, stage_attempt_ref, stage_request_sha256),
  CHECK((state = 'PREPARED' AND r2_key IS NULL AND r2_etag IS NULL AND output_sha256 IS NULL AND output_size_bytes IS NULL AND readback_sha256 IS NULL AND committed_at IS NULL)
    OR (state = 'COMMITTED' AND r2_key IS NOT NULL AND r2_etag IS NOT NULL AND output_sha256 IS NOT NULL AND output_size_bytes IS NOT NULL AND readback_sha256 IS NOT NULL AND committed_at IS NOT NULL)),
  CHECK(output_size_bytes IS NULL OR (output_size_bytes >= 0 AND output_size_bytes <= 8388608)),
  CHECK(r2_key IS NULL OR length(r2_key) BETWEEN 1 AND 1024),
  CHECK(r2_etag IS NULL OR length(r2_etag) BETWEEN 1 AND 512)
) STRICT;

CREATE INDEX research_model_output_attempt_idx
  ON research_model_output(attempt_id, state);

CREATE INDEX research_model_output_principal_idx
  ON research_model_output(principal_ref, stage_attempt_ref, stage_request_sha256, state);

CREATE TRIGGER research_model_output_identity
BEFORE UPDATE ON research_model_output
WHEN OLD.state = 'PREPARED'
  AND (NEW.output_object_ref IS NOT OLD.output_object_ref
    OR NEW.attempt_id IS NOT OLD.attempt_id
    OR NEW.principal_ref IS NOT OLD.principal_ref
    OR NEW.stage_attempt_ref IS NOT OLD.stage_attempt_ref
    OR NEW.stage_request_sha256 IS NOT OLD.stage_request_sha256
    OR NEW.request_sha256 IS NOT OLD.request_sha256
    OR NEW.workflow_budget_receipt_ref IS NOT OLD.workflow_budget_receipt_ref
    OR NEW.residency_domain_json IS NOT OLD.residency_domain_json
    OR NEW.residency_domain_sha256 IS NOT OLD.residency_domain_sha256
    OR NEW.created_at IS NOT OLD.created_at)
BEGIN SELECT RAISE(ABORT, 'MODEL_OUTPUT_IDENTITY_CONFLICT'); END;

CREATE TRIGGER research_model_output_transition
BEFORE UPDATE OF state ON research_model_output
WHEN NOT (OLD.state = 'PREPARED' AND NEW.state = 'COMMITTED')
BEGIN SELECT RAISE(ABORT, 'MODEL_OUTPUT_CONFLICT'); END;

CREATE TRIGGER research_model_output_immutable
BEFORE UPDATE ON research_model_output
WHEN OLD.state = 'COMMITTED'
  OR (OLD.state = 'PREPARED' AND NEW.state = 'PREPARED' AND (NEW.r2_key IS NOT OLD.r2_key
    OR NEW.r2_etag IS NOT OLD.r2_etag
    OR NEW.output_sha256 IS NOT OLD.output_sha256
    OR NEW.output_size_bytes IS NOT OLD.output_size_bytes
    OR NEW.readback_sha256 IS NOT OLD.readback_sha256
    OR NEW.committed_at IS NOT OLD.committed_at))
BEGIN SELECT RAISE(ABORT, 'MODEL_OUTPUT_IMMUTABLE'); END;

CREATE TRIGGER research_model_output_no_delete
BEFORE DELETE ON research_model_output
BEGIN SELECT RAISE(ABORT, 'MODEL_OUTPUT_CONFLICT'); END;
