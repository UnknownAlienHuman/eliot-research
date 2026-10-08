-- S33: server-owned Research lifetime, distinct from the 15-minute ORIENT lease.
-- No existing snapshot, grant, receipt or bearer credential is rewritten.
ALTER TABLE orientation_request ADD COLUMN execution_operation_id TEXT;
CREATE UNIQUE INDEX orientation_execution_operation_idx
  ON orientation_request(execution_operation_id) WHERE execution_operation_id IS NOT NULL;

CREATE TRIGGER orientation_execution_scope_insert BEFORE INSERT ON orientation_request
WHEN NEW.execution_operation_id IS NOT NULL AND (
  length(NEW.execution_operation_id)<>52 OR substr(NEW.execution_operation_id,1,4)<>'run-'
  OR substr(NEW.execution_operation_id,5) GLOB '*[^0-9a-f]*'
  OR NEW.idempotency_key IS NOT ('research-execution:' || NEW.execution_operation_id)
  OR NEW.client_class<>'owner_pwa' OR NEW.state<>'PREPARED' OR NEW.snapshot_id IS NOT NULL
  OR NEW.result_json IS NOT NULL
  OR julianday(NEW.created_at) IS NULL OR julianday(NEW.expires_at) IS NULL
  OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NOT NEW.created_at
  OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.expires_at) IS NOT NEW.expires_at
  OR julianday(NEW.expires_at)<=julianday(NEW.created_at)
  OR julianday(NEW.expires_at)>julianday(NEW.created_at)+1
)
BEGIN SELECT RAISE(ABORT,'RESEARCH_EXECUTION_SCOPE_INVALID'); END;

CREATE TRIGGER orientation_execution_identity_immutable BEFORE UPDATE ON orientation_request
WHEN NEW.execution_operation_id IS NOT OLD.execution_operation_id
BEGIN SELECT RAISE(ABORT,'RESEARCH_EXECUTION_SCOPE_IMMUTABLE'); END;

CREATE TRIGGER orientation_execution_scope_bind BEFORE UPDATE ON orientation_request
WHEN NEW.execution_operation_id IS NOT NULL AND NEW.snapshot_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM scope_snapshot s WHERE s.snapshot_id=NEW.snapshot_id AND s.revision=NEW.snapshot_revision
    AND s.created_at=NEW.created_at AND s.client_fence_ref=NEW.credential_generation
    AND julianday(s.expires_at)<=julianday(NEW.expires_at)
    AND julianday(s.expires_at)>julianday(s.created_at)
)
BEGIN SELECT RAISE(ABORT,'RESEARCH_EXECUTION_SCOPE_CONFLICT'); END;

CREATE TRIGGER orientation_execution_scope_complete BEFORE UPDATE ON orientation_request
WHEN NEW.execution_operation_id IS NOT NULL AND NEW.state='COMPLETE' AND (
  json_extract(NEW.result_json,'$.execution.operation_id') IS NOT NEW.execution_operation_id
  OR json_extract(NEW.result_json,'$.execution.deadline') IS NOT NEW.expires_at
  OR json_type(NEW.result_json,'$.execution.request_digest') IS NOT 'text'
  OR length(json_extract(NEW.result_json,'$.execution.request_digest'))<>64
  OR json_extract(NEW.result_json,'$.execution.request_digest') GLOB '*[^0-9a-f]*'
  OR json_extract(NEW.result_json,'$.result.evidence_pack.scope_snapshot_ref.id') IS NOT NEW.snapshot_id
  OR json_extract(NEW.result_json,'$.result.evidence_pack.scope_snapshot_ref.revision') IS NOT NEW.snapshot_revision
)
BEGIN SELECT RAISE(ABORT,'RESEARCH_EXECUTION_SCOPE_UNCONFIRMED'); END;

-- Keep the binding as immutable execution provenance; deletion would let an
-- operation fall back to legacy short-scope rules. Invalidation remains allowed.
CREATE TRIGGER orientation_execution_scope_no_delete BEFORE DELETE ON orientation_request
WHEN OLD.execution_operation_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'RESEARCH_EXECUTION_SCOPE_IMMUTABLE'); END;

DROP VIEW research_workflow_current;
CREATE VIEW research_workflow_current AS
SELECT r.*, h.revision AS ledger_revision, h.checkpoint_head, h.event_head
FROM research_workflow_run r JOIN investigation_ledger_head h ON h.investigation_id = r.investigation_id
JOIN scope_snapshot s ON s.snapshot_id = r.scope_snapshot_id AND s.revision = r.scope_snapshot_revision
WHERE h.status = 'OPEN' AND h.principal_ref = r.principal_ref
  AND h.scope_snapshot_id = r.scope_snapshot_id AND h.scope_snapshot_revision = r.scope_snapshot_revision
  AND h.policy_generation = r.policy_generation AND h.policy_authority_ref = r.policy_authority_ref
  AND h.deployment_generation = r.deployment_generation
  AND s.invalidated_at IS NULL AND julianday(s.expires_at) > julianday('now')
  AND s.policy_authority_ref = r.policy_authority_ref AND s.purge_ledger_revision = r.purge_revision
  AND r.purge_revision = COALESCE((SELECT MAX(ledger_revision) FROM purge_ledger), 0)
  AND EXISTS (SELECT 1 FROM investigation_current_policy p WHERE p.state = 'ACTIVE'
    AND p.policy_generation = r.policy_generation AND p.policy_authority_ref = r.policy_authority_ref)
  AND EXISTS (SELECT 1 FROM research_deployment_compatible c
    WHERE c.origin_deployment_generation = r.deployment_generation)
  AND EXISTS (SELECT 1 FROM scope_access_grant g WHERE g.snapshot_id = r.scope_snapshot_id
    AND g.snapshot_revision = r.scope_snapshot_revision AND g.principal_ref = r.principal_ref
    AND g.credential_generation = r.credential_generation AND g.policy_authority_ref = r.policy_authority_ref
    AND g.authorization_receipt_ref = r.authorization_receipt_ref
    AND g.state = 'ACTIVE' AND julianday(g.expires_at) > julianday('now')
    AND json_type(g.allowed_use_json) = 'array'
    AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) u WHERE u.type = 'text' AND u.value = 'research'))
  -- A long-lived scope is usable only by its originally admitted operation.
  -- Existing short-lived snapshots keep their original grant/expiry behavior.
  AND (
    NOT EXISTS (SELECT 1 FROM orientation_request e
      WHERE e.snapshot_id=r.scope_snapshot_id AND e.snapshot_revision=r.scope_snapshot_revision
        AND e.execution_operation_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM orientation_request e
      WHERE e.execution_operation_id=r.operation_id
        AND e.snapshot_id=r.scope_snapshot_id AND e.snapshot_revision=r.scope_snapshot_revision
        AND e.principal_ref=r.principal_ref AND e.client_class='owner_pwa'
        AND e.credential_generation=r.credential_generation AND e.state='COMPLETE'
        AND julianday(e.expires_at)>julianday('now')
        AND julianday(e.expires_at)<=julianday(e.created_at)+1
        AND json_extract(e.result_json,'$.execution.operation_id')=r.operation_id
        AND json_extract(e.result_json,'$.execution.deadline')=e.expires_at)
  );

INSERT INTO schema_state(key,value,updated_at)
VALUES('research_execution_scope_generation','research-execution-scope-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
