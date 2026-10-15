-- A REPORT admission is committed with the artifact's final atomic batch.
-- Reserving its private draft must instead bind the exact live MATERIALIZE
-- attempt. Require the committed admission before the draft becomes FINALIZED.
DROP TRIGGER client_execution_artifact_intent_guard;

CREATE TRIGGER client_execution_artifact_intent_guard
BEFORE INSERT ON artifact_draft_reservation
WHEN EXISTS (
  SELECT 1 FROM scope_access_grant
  WHERE project_client_grant_id IS NOT NULL
    AND ((snapshot_id=NEW.scope_snapshot_id AND snapshot_revision=NEW.scope_snapshot_revision)
      OR principal_ref=NEW.principal_ref)
)
AND NOT EXISTS (
  SELECT 1 FROM scope_access_grant_effective g
  JOIN research_workflow_current r ON r.operation_id=g.project_client_run_operation_id
  JOIN research_workflow_attempt w ON w.operation_id=r.operation_id AND w.stage_index=17
  WHERE g.snapshot_id=NEW.scope_snapshot_id AND g.snapshot_revision=NEW.scope_snapshot_revision
    AND NEW.state='RESERVED'
    AND g.principal_ref=NEW.principal_ref AND g.project_client_operation='run'
    AND g.client_class IN ('trusted_agent','named_api_client')
    AND g.credential_generation=r.credential_generation
    AND g.authorization_receipt_ref=r.authorization_receipt_ref
    AND r.principal_ref=NEW.principal_ref AND r.scope_snapshot_id=NEW.scope_snapshot_id
    AND r.scope_snapshot_revision=NEW.scope_snapshot_revision
    AND r.state='ACTIVE' AND r.next_stage_index=17
    AND w.state='STARTED' AND w.output_json IS NULL AND w.expected_revision=r.current_revision
    AND w.budget_expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
    AND json_extract(w.request_json,'$.idempotency_key')=NEW.idempotency_key
    AND json_extract(NEW.intent_json,'$.operation_kind')='REPORT'
    AND json_extract(NEW.intent_json,'$.principal_ref')=NEW.principal_ref
    AND json_extract(NEW.intent_json,'$.idempotency_key')=NEW.idempotency_key
    AND json_extract(NEW.intent_json,'$.intent_ref.id')=NEW.intent_id
    AND json_extract(NEW.intent_json,'$.intent_ref.revision')=NEW.intent_revision
    AND json_extract(NEW.intent_json,'$.payload_ref')=NEW.payload_ref
    AND julianday(g.expires_at)>julianday('now')
)
BEGIN SELECT RAISE(ABORT,'REPORT_ADMISSION_AUTHORITY_STALE'); END;

CREATE TRIGGER client_execution_artifact_finalize_guard
BEFORE UPDATE OF state ON artifact_draft_reservation
WHEN NEW.state='FINALIZED' AND EXISTS (
  SELECT 1 FROM scope_access_grant
  WHERE project_client_grant_id IS NOT NULL
    AND ((snapshot_id=NEW.scope_snapshot_id AND snapshot_revision=NEW.scope_snapshot_revision)
      OR principal_ref=NEW.principal_ref)
)
AND NOT EXISTS (
  SELECT 1 FROM scope_access_grant_effective g
  JOIN research_report_admission a ON a.operation_id=g.project_client_run_operation_id
    AND a.intent_id=NEW.intent_id AND a.intent_revision=NEW.intent_revision
  WHERE g.snapshot_id=NEW.scope_snapshot_id AND g.snapshot_revision=NEW.scope_snapshot_revision
    AND g.principal_ref=NEW.principal_ref AND g.project_client_operation='run'
    AND a.principal_ref=NEW.principal_ref AND a.idempotency_key=NEW.idempotency_key
    AND a.scope_snapshot_id=NEW.scope_snapshot_id AND a.scope_snapshot_revision=NEW.scope_snapshot_revision
    AND a.client_class=g.client_class AND a.credential_generation=g.credential_generation
    AND a.authorization_receipt_ref=g.authorization_receipt_ref
    AND julianday(a.expires_at)>julianday('now')
    AND julianday(g.expires_at)>julianday('now')
)
BEGIN SELECT RAISE(ABORT,'REPORT_ADMISSION_AUTHORITY_STALE'); END;
