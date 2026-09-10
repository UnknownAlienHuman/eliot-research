-- ER-09 W3: durable model-call reservation and settlement identity.
-- This migration does not call a provider or write R2. A reservation and the
-- operation intent are committed before a gateway boundary; an attempt stays
-- STARTED when its provider outcome is unknown and is never auto-retried.
PRAGMA foreign_keys = ON;

ALTER TABLE budget_reservation ADD COLUMN principal_ref TEXT;
ALTER TABLE budget_reservation ADD COLUMN idempotency_key TEXT;
ALTER TABLE budget_reservation ADD COLUMN request_sha256 TEXT;
ALTER TABLE budget_reservation ADD COLUMN request_json TEXT;
ALTER TABLE budget_reservation ADD COLUMN policy_decision_ref TEXT;
ALTER TABLE budget_reservation ADD COLUMN credential_generation TEXT;
ALTER TABLE budget_reservation ADD COLUMN deployment_generation TEXT;
ALTER TABLE budget_reservation ADD COLUMN quote_ref TEXT;
ALTER TABLE budget_reservation ADD COLUMN expected_sources INTEGER;
ALTER TABLE budget_reservation ADD COLUMN expected_sections INTEGER;
ALTER TABLE budget_reservation ADD COLUMN confidence REAL;
ALTER TABLE budget_reservation ADD COLUMN quote_json TEXT;
ALTER TABLE budget_reservation ADD COLUMN authority_json TEXT;
ALTER TABLE budget_reservation ADD COLUMN stage_attempt_ref TEXT;
ALTER TABLE budget_reservation ADD COLUMN stage_request_sha256 TEXT;

CREATE UNIQUE INDEX budget_reservation_model_identity_idx
  ON budget_reservation(principal_ref, operation_kind, idempotency_key)
  WHERE principal_ref IS NOT NULL AND idempotency_key IS NOT NULL;

CREATE TABLE research_model_attempt (
  attempt_id TEXT PRIMARY KEY CHECK(length(attempt_id) BETWEEN 1 AND 128),
  intent_id TEXT NOT NULL,
  intent_revision INTEGER NOT NULL CHECK(intent_revision > 0),
  reservation_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
  principal_ref TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(CAST(request_json AS BLOB)) <= 65536),
  authority_json TEXT NOT NULL CHECK(json_valid(authority_json) AND length(CAST(authority_json AS BLOB)) <= 65536),
  route_ref TEXT NOT NULL,
  prompt_generation TEXT NOT NULL,
  schema_generation TEXT NOT NULL,
  credential_generation TEXT NOT NULL,
  deployment_generation TEXT NOT NULL,
  stage_attempt_ref TEXT NOT NULL,
  stage_request_sha256 TEXT NOT NULL CHECK(length(stage_request_sha256) = 64 AND stage_request_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('STARTED','SUCCEEDED','FAILED','CANCELLED')),
  receipt_json TEXT CHECK(receipt_json IS NULL OR (json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) <= 65536)),
  receipt_sha256 TEXT CHECK(receipt_sha256 IS NULL OR (length(receipt_sha256) = 64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*')),
  output_object_ref TEXT,
  output_sha256 TEXT CHECK(output_sha256 IS NULL OR (length(output_sha256) = 64 AND output_sha256 NOT GLOB '*[^0-9a-f]*')),
  output_size_bytes INTEGER CHECK(output_size_bytes IS NULL OR output_size_bytes >= 0),
  readback_sha256 TEXT CHECK(readback_sha256 IS NULL OR (length(readback_sha256) = 64 AND readback_sha256 NOT GLOB '*[^0-9a-f]*')),
  error_code TEXT,
  reason_codes_json TEXT NOT NULL CHECK(json_valid(reason_codes_json) AND length(CAST(reason_codes_json AS BLOB)) <= 65536),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  FOREIGN KEY(intent_id, intent_revision) REFERENCES operation_intent(intent_id, revision),
  FOREIGN KEY(reservation_id) REFERENCES budget_reservation(reservation_id),
  FOREIGN KEY(attempt_id) REFERENCES operation_attempt(attempt_id),
  UNIQUE(intent_id, intent_revision, attempt_number),
  CHECK((state = 'STARTED') = (ended_at IS NULL)),
  CHECK((state = 'SUCCEEDED') = (receipt_json IS NOT NULL AND receipt_sha256 IS NOT NULL AND output_object_ref IS NOT NULL AND output_sha256 IS NOT NULL AND output_size_bytes IS NOT NULL AND readback_sha256 IS NOT NULL AND error_code IS NULL)),
  CHECK((state IN ('FAILED','CANCELLED')) = (error_code IS NOT NULL AND receipt_json IS NULL AND output_object_ref IS NULL AND output_sha256 IS NULL AND output_size_bytes IS NULL AND readback_sha256 IS NULL))
) STRICT;

CREATE INDEX research_model_attempt_lookup_idx
  ON research_model_attempt(principal_ref, operation_kind, idempotency_key, attempt_number);

CREATE TRIGGER research_model_attempt_immutable
BEFORE UPDATE ON research_model_attempt
WHEN NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.intent_id IS NOT OLD.intent_id
  OR NEW.intent_revision IS NOT OLD.intent_revision
  OR NEW.reservation_id IS NOT OLD.reservation_id
  OR NEW.attempt_number IS NOT OLD.attempt_number
  OR NEW.principal_ref IS NOT OLD.principal_ref
  OR NEW.operation_kind IS NOT OLD.operation_kind
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.request_sha256 IS NOT OLD.request_sha256
  OR NEW.request_json IS NOT OLD.request_json
  OR NEW.authority_json IS NOT OLD.authority_json
  OR NEW.route_ref IS NOT OLD.route_ref
  OR NEW.prompt_generation IS NOT OLD.prompt_generation
  OR NEW.schema_generation IS NOT OLD.schema_generation
  OR NEW.credential_generation IS NOT OLD.credential_generation
  OR NEW.deployment_generation IS NOT OLD.deployment_generation
  OR NEW.stage_attempt_ref IS NOT OLD.stage_attempt_ref
  OR NEW.stage_request_sha256 IS NOT OLD.stage_request_sha256
  OR NEW.started_at IS NOT OLD.started_at
BEGIN SELECT RAISE(ABORT, 'MODEL_ATTEMPT_IDENTITY_CONFLICT'); END;

CREATE TRIGGER research_model_attempt_transition
BEFORE UPDATE OF state ON research_model_attempt
WHEN NOT (
  (OLD.state = 'STARTED' AND NEW.state IN ('SUCCEEDED','FAILED','CANCELLED') AND NEW.ended_at IS NOT NULL)
)
BEGIN SELECT RAISE(ABORT, 'MODEL_ATTEMPT_CONFLICT'); END;

CREATE TRIGGER research_model_attempt_no_delete
BEFORE DELETE ON research_model_attempt
BEGIN SELECT RAISE(ABORT, 'MODEL_ATTEMPT_CONFLICT'); END;

CREATE TRIGGER research_model_attempt_terminal_immutable
BEFORE UPDATE ON research_model_attempt
WHEN OLD.state IN ('SUCCEEDED','FAILED','CANCELLED')
  AND (NEW.state IS NOT OLD.state
    OR NEW.receipt_json IS NOT OLD.receipt_json
    OR NEW.receipt_sha256 IS NOT OLD.receipt_sha256
    OR NEW.output_object_ref IS NOT OLD.output_object_ref
    OR NEW.output_sha256 IS NOT OLD.output_sha256
    OR NEW.output_size_bytes IS NOT OLD.output_size_bytes
    OR NEW.readback_sha256 IS NOT OLD.readback_sha256
    OR NEW.error_code IS NOT OLD.error_code
    OR NEW.reason_codes_json IS NOT OLD.reason_codes_json
    OR NEW.ended_at IS NOT OLD.ended_at)
BEGIN SELECT RAISE(ABORT, 'MODEL_ATTEMPT_CONFLICT'); END;
