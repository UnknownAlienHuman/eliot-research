-- ER-37: retain the MCP principal that issued the workspace observation
-- separately from the owner principal that performs raw admission.
PRAGMA foreign_keys = ON;

-- 0047's immutable update triggers must be paused for the one-time backfill.
DROP TRIGGER workspace_mcp_raw_admission_transition;
DROP TRIGGER workspace_mcp_raw_admission_identity_immutable;

ALTER TABLE workspace_mcp_raw_normalized_admission
  ADD COLUMN observation_principal_ref TEXT;

-- Rows written before cross-principal authorization were necessarily same-owner
-- bindings; preserve their known identity while making new rows explicit.
UPDATE workspace_mcp_raw_normalized_admission
SET observation_principal_ref = principal_ref
WHERE observation_principal_ref IS NULL;

CREATE TRIGGER workspace_mcp_raw_admission_observation_principal_required
BEFORE INSERT ON workspace_mcp_raw_normalized_admission
WHEN NEW.observation_principal_ref IS NULL OR length(NEW.observation_principal_ref) NOT BETWEEN 1 AND 256
BEGIN
  SELECT RAISE(ABORT, 'WORKSPACE_ADMISSION_OBSERVATION_PRINCIPAL_REQUIRED');
END;

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
  OR NEW.observation_principal_ref IS NOT OLD.observation_principal_ref
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
