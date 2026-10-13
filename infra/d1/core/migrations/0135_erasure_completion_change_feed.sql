PRAGMA foreign_keys = ON;

-- Record only a committed full completion, in the existing guarded terminal batch.
-- Historical cases are not backfilled and blocked subset erasure is not completion.
CREATE TRIGGER erasure_execution_completion_change_feed
AFTER UPDATE OF state ON erasure_execution
WHEN OLD.state = 'INVALIDATE_DEPENDENTS' AND NEW.state = 'COMPLETE'
BEGIN
  INSERT INTO research_change_feed (
    change_ref, kind, subject_ref, subject_revision, payload_ref, payload_sha256,
    visibility_principal_ref, visibility_snapshot_id, visibility_snapshot_revision,
    occurred_at, metadata_json
  )
  SELECT
    'erasure-completed:' || NEW.erasure_id || ':' || NEW.revision,
    'ERASURE_COMPLETED', NEW.erasure_id, NEW.revision, p.receipt_ref,
    NEW.terminal_receipt_sha256,
    json_extract(NEW.request_json, '$.requested_by_principal_ref'), NULL, NULL,
    json_extract(NEW.terminal_receipt_json, '$.issued_at'), '{}'
  FROM erasure_terminal_guard g
  JOIN erasure_case c ON c.erasure_id = g.erasure_id AND c.revision = g.erasure_revision
  JOIN purge_ledger p ON p.ledger_revision = g.purge_ledger_revision
  WHERE g.erasure_id = NEW.erasure_id AND g.erasure_revision = NEW.revision
    AND g.verified = 1 AND g.terminal_state = 'COMPLETE' AND c.state = 'COMPLETE'
    AND g.receipt_sha256 = NEW.terminal_receipt_sha256
    AND g.closure_digest = NEW.closure_digest
    AND g.purge_ledger_revision = NEW.purge_ledger_revision
    AND g.requested_locations_json = g.completed_locations_json
    AND g.completed_locations_json = c.completed_locations_json
    AND g.requested_locations_json = c.requested_locations_json
    AND g.blocked_locations_json = c.blocked_locations_json
    AND json_array_length(g.blocked_locations_json) = 0
    AND p.erasure_id = NEW.erasure_id AND p.disposition = 'COMPLETE'
    AND json_type(NEW.request_json, '$.requested_by_principal_ref') = 'text'
    AND json_extract(NEW.request_json, '$.erasure_ref.id') = NEW.erasure_id
    AND json_extract(NEW.request_json, '$.erasure_ref.revision') = NEW.revision
    AND json_extract(NEW.terminal_receipt_json, '$.state') = 'COMPLETE'
    AND json_extract(NEW.terminal_receipt_json, '$.erasure_ref.id') = NEW.erasure_id
    AND json_extract(NEW.terminal_receipt_json, '$.erasure_ref.revision') = NEW.revision
    AND json_extract(NEW.terminal_receipt_json, '$.purge_ledger_entry_ref') = p.receipt_ref
    AND json_type(NEW.terminal_receipt_json, '$.issued_at') = 'text';
END;
