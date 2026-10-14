-- S40: preserve the per-role model digest and bind its original W2 stage.
-- Existing rows are untouched. Nullable legacy values are not backfilled.
-- Original table, shape/deployment/no-delete guards and lookup index remain intact.
-- The existing unconditional UPDATE prohibition covers the added column.
ALTER TABLE research_model_spend_admission
  ADD COLUMN workflow_stage_request_sha256 TEXT CHECK (
    workflow_stage_request_sha256 IS NULL OR
    (length(workflow_stage_request_sha256) = 64 AND workflow_stage_request_sha256 NOT GLOB '*[^0-9a-f]*')
  );

DROP TRIGGER research_model_spend_admission_w2_guard;
CREATE TRIGGER research_model_spend_admission_w2_guard
BEFORE INSERT ON research_model_spend_admission
BEGIN
  SELECT RAISE(ABORT, 'MODEL_SPEND_ADMISSION_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1
    FROM research_workflow_current r
    JOIN research_workflow_attempt a
      ON (a.operation_id, a.stage_index)
      = (r.operation_id, NEW.stage_index)
    JOIN scope_access_grant g
      ON (g.snapshot_id, g.snapshot_revision, g.principal_ref)
      = (r.scope_snapshot_id, r.scope_snapshot_revision, r.principal_ref)
    WHERE (r.operation_id, r.state, r.next_stage_index, r.current_revision, r.ledger_revision, a.state)
      = (NEW.workflow_operation_id, 'ACTIVE', NEW.stage_index, a.expected_revision, a.expected_revision, 'STARTED')
      AND a.output_json IS NULL
      AND (a.attempt_ref, a.request_sha256, a.budget_receipt_ref)
      = (NEW.stage_attempt_ref,
        CASE WHEN NEW.stage_index IN (8, 9) THEN NEW.workflow_stage_request_sha256 ELSE NEW.stage_request_sha256 END,
        NEW.workflow_budget_receipt_ref)
      AND (NEW.stage_index NOT IN (8, 9) OR NEW.workflow_stage_request_sha256 IS NOT NULL)
      AND (NEW.stage_index IN (8, 9) OR NEW.workflow_stage_request_sha256 IS NULL
        OR NEW.workflow_stage_request_sha256 = NEW.stage_request_sha256)
      AND json_extract(a.request_json, '$.protocol') IS 'eliotr.workflow-stage.v1'
      AND json_extract(a.request_json, '$.operation_id') IS r.operation_id
      AND json_extract(a.request_json, '$.stage') IS CASE NEW.stage_index
        WHEN 8 THEN 'ANALYZE_BRANCHES' WHEN 9 THEN 'COUNTER_SEARCH'
        WHEN 12 THEN 'SYNTHESIZE' WHEN 13 THEN 'VERIFY' WHEN 14 THEN 'AUDIT_CLAIMS' END
      AND json_extract(a.request_json, '$.investigation_ref.id') IS r.investigation_id
      AND json_extract(a.request_json, '$.investigation_ref.revision') IS r.current_revision
      AND json_extract(a.request_json, '$.idempotency_key') IS r.idempotency_key
      AND json_extract(a.request_json, '$.handler_generation') IS r.handler_generation
      AND (r.principal_ref, r.credential_generation, r.deployment_generation, r.policy_generation, r.scope_snapshot_id, r.scope_snapshot_revision,
        r.authorization_receipt_ref, g.client_class, g.credential_generation, g.policy_authority_ref, g.authorization_receipt_ref, g.state)
      = (NEW.principal_ref, NEW.credential_generation, NEW.deployment_generation, NEW.policy_generation, NEW.scope_snapshot_id,
        NEW.scope_snapshot_revision, NEW.workflow_authorization_receipt_ref, NEW.client_class, NEW.credential_generation, r.policy_authority_ref,
        NEW.workflow_authorization_receipt_ref, 'ACTIVE')
      AND julianday(g.expires_at) > julianday('now')
      AND json_type(g.allowed_use_json) = 'array'
      AND EXISTS (
        SELECT 1 FROM json_each(g.allowed_use_json) u
        WHERE (u.type, u.value)
      = ('text', 'research')
      )
  );
END;
