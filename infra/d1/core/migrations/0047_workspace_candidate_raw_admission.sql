-- ER-36/ER-37: owner-authorized Workspace observation -> raw capture ->
-- normalized admission binding.  The workspace ledger remains candidate-only;
-- this sidecar records the separate owner admission decision and its operation.
PRAGMA foreign_keys = ON;

CREATE TABLE workspace_mcp_raw_normalized_admission (
  binding_id TEXT PRIMARY KEY CHECK(length(binding_id)=64 AND binding_id NOT GLOB '*[^0-9a-f]*'),
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  deployment_generation TEXT NOT NULL CHECK(length(deployment_generation) BETWEEN 1 AND 256),
  auth_profile TEXT NOT NULL CHECK(auth_profile IN ('service-token','managed-oauth')),
  google_transport TEXT NOT NULL CHECK(google_transport='gemini-mcp'),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  plan_idempotency_key TEXT NOT NULL CHECK(length(plan_idempotency_key) BETWEEN 1 AND 256),
  plan_id TEXT NOT NULL CHECK(length(plan_id) BETWEEN 1 AND 256),
  plan_sha256 TEXT NOT NULL CHECK(length(plan_sha256)=64 AND plan_sha256 NOT GLOB '*[^0-9a-f]*'),
  observation_id TEXT NOT NULL CHECK(length(observation_id) BETWEEN 1 AND 256),
  observation_receipt_sha256 TEXT NOT NULL CHECK(length(observation_receipt_sha256)=64 AND observation_receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
  capture_id TEXT NOT NULL CHECK(length(capture_id) BETWEEN 1 AND 128),
  capture_content_sha256 TEXT NOT NULL CHECK(length(capture_content_sha256)=64 AND capture_content_sha256 NOT GLOB '*[^0-9a-f]*'),
  conversion_operation_id TEXT NOT NULL CHECK(length(conversion_operation_id) BETWEEN 1 AND 256),
  admission_operation_id TEXT CHECK(admission_operation_id IS NULL OR (length(admission_operation_id)=64 AND admission_operation_id NOT GLOB '*[^0-9a-f]*')),
  state TEXT NOT NULL CHECK(state IN ('RESERVED','BOUND')),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z' AND julianday(created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z' AND julianday(updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS updated_at),
  UNIQUE(principal_ref, idempotency_key),
  UNIQUE(admission_operation_id),
  CHECK((state='RESERVED' AND admission_operation_id IS NULL) OR (state='BOUND' AND admission_operation_id IS NOT NULL)),
  FOREIGN KEY(plan_id) REFERENCES workspace_mcp_plan(plan_id),
  FOREIGN KEY(observation_id) REFERENCES workspace_mcp_observation(observation_id),
  FOREIGN KEY(capture_id) REFERENCES raw_file_capture(capture_id),
  FOREIGN KEY(conversion_operation_id) REFERENCES raw_markdown_conversion(operation_id),
  FOREIGN KEY(admission_operation_id) REFERENCES raw_normalized_admission(admission_operation_id)
) STRICT;

CREATE INDEX workspace_mcp_raw_admission_owner_idx
  ON workspace_mcp_raw_normalized_admission(principal_ref, updated_at DESC);
CREATE INDEX workspace_mcp_raw_admission_observation_idx
  ON workspace_mcp_raw_normalized_admission(observation_id, updated_at DESC);

-- A reservation can be attached to exactly one raw admission operation after
-- the existing admission service returns its durable operation identity.
CREATE TRIGGER workspace_mcp_raw_admission_transition
BEFORE UPDATE ON workspace_mcp_raw_normalized_admission
WHEN NOT (OLD.state='RESERVED' AND NEW.state='BOUND' AND OLD.admission_operation_id IS NULL AND NEW.admission_operation_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'WORKSPACE_ADMISSION_BINDING_IMMUTABLE');
END;

CREATE TRIGGER workspace_mcp_raw_admission_identity_immutable
BEFORE UPDATE ON workspace_mcp_raw_normalized_admission
WHEN NEW.binding_id IS NOT OLD.binding_id
  OR NEW.principal_ref IS NOT OLD.principal_ref
  OR NEW.deployment_generation IS NOT OLD.deployment_generation
  OR NEW.auth_profile IS NOT OLD.auth_profile
  OR NEW.google_transport IS NOT OLD.google_transport
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.plan_idempotency_key IS NOT OLD.plan_idempotency_key
  OR NEW.plan_id IS NOT OLD.plan_id
  OR NEW.plan_sha256 IS NOT OLD.plan_sha256
  OR NEW.observation_id IS NOT OLD.observation_id
  OR NEW.observation_receipt_sha256 IS NOT OLD.observation_receipt_sha256
  OR NEW.capture_id IS NOT OLD.capture_id
  OR NEW.capture_content_sha256 IS NOT OLD.capture_content_sha256
  OR NEW.conversion_operation_id IS NOT OLD.conversion_operation_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'WORKSPACE_ADMISSION_BINDING_IMMUTABLE');
END;

CREATE TRIGGER workspace_mcp_raw_admission_no_delete
BEFORE DELETE ON workspace_mcp_raw_normalized_admission
BEGIN
  SELECT RAISE(ABORT, 'WORKSPACE_ADMISSION_BINDING_IMMUTABLE');
END;
