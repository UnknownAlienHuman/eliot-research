PRAGMA foreign_keys = ON;

-- The workflow checkpoint trigger advances the run only after the final
-- MATERIALIZE checkpoint has been durably recorded.  Emit the completion
-- change from that state transition so replaying the transaction stays
-- idempotent and no backfill is needed.
CREATE TRIGGER IF NOT EXISTS research_workflow_completed_change_feed
AFTER UPDATE OF state ON research_workflow_run
WHEN OLD.state <> NEW.state AND NEW.state = 'ENGINE_COMPLETED'
BEGIN
  INSERT OR IGNORE INTO research_change_feed (
    change_ref,
    kind,
    subject_ref,
    subject_revision,
    payload_ref,
    payload_sha256,
    visibility_principal_ref,
    visibility_snapshot_id,
    visibility_snapshot_revision,
    occurred_at,
    metadata_json
  )
  SELECT
    'research-completed:' || NEW.operation_id,
    'RESEARCH_COMPLETED',
    'research-run:' || NEW.operation_id,
    NEW.current_revision,
    json_extract(c.receipt_json, '$.output_manifest.object_ref'),
    json_extract(c.receipt_json, '$.output_manifest.sha256'),
    NEW.principal_ref,
    NEW.scope_snapshot_id,
    NEW.scope_snapshot_revision,
    c.created_at,
    json_object(
      'attempt_ref', json_extract(c.receipt_json, '$.attempt_ref'),
      'engine_state', json_extract(c.receipt_json, '$.engine_state'),
      'operation_id', NEW.operation_id,
      'output_manifest_ref', json_extract(c.receipt_json, '$.output_manifest.object_ref'),
      'output_manifest_sha256', json_extract(c.receipt_json, '$.output_manifest.sha256'),
      'receipt_ref', json_extract(c.receipt_json, '$.receipt_ref'),
      'stage', json_extract(c.receipt_json, '$.stage'),
      'stage_index', c.stage_index
    )
  FROM research_workflow_checkpoint c
  JOIN research_workflow_attempt a
    ON a.operation_id = c.operation_id
   AND a.stage_index = c.stage_index
   AND a.request_sha256 = c.request_sha256
   AND a.state = 'COMMITTED'
  WHERE c.operation_id = NEW.operation_id
    AND c.stage_index = 17
    AND json_extract(c.receipt_json, '$.operation_id') = NEW.operation_id
    AND json_extract(c.receipt_json, '$.stage') = 'MATERIALIZE'
    AND json_extract(c.receipt_json, '$.engine_state') = 'ENGINE_COMPLETED'
    AND json_extract(c.receipt_json, '$.output_manifest.object_ref') = json_extract(a.output_json, '$.object_ref')
    AND json_extract(c.receipt_json, '$.output_manifest.sha256') = json_extract(a.output_json, '$.sha256');
END;
