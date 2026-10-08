-- S05: separate exact deployment provenance from bounded execution compatibility.
-- The original deployment generation on heads/runs/receipts remains immutable.  Only an
-- evidence-backed equal backend fingerprint permits the currently ACTIVE Worker to continue it.

ALTER TABLE investigation_current_deployment ADD COLUMN backend_fingerprint TEXT
  CHECK(backend_fingerprint IS NULL OR (
    length(backend_fingerprint)=64 AND backend_fingerprint NOT GLOB '*[^0-9a-f]*'
  ));
CREATE INDEX investigation_deployment_fingerprint_idx
  ON investigation_current_deployment(backend_fingerprint, state);

CREATE VIEW research_deployment_compatible AS
SELECT origin.deployment_generation AS origin_deployment_generation,
       active.deployment_generation AS active_deployment_generation,
       origin.backend_fingerprint AS backend_fingerprint
FROM investigation_current_deployment origin
JOIN investigation_current_deployment active
  ON active.state='ACTIVE'
 AND (
   active.deployment_generation=origin.deployment_generation
   OR (
     origin.backend_fingerprint IS NOT NULL
     AND active.backend_fingerprint=origin.backend_fingerprint
   )
 );

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
    AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) u WHERE u.type = 'text' AND u.value = 'research'));

DROP TRIGGER ledger_guard_deployment_current;
CREATE TRIGGER ledger_guard_deployment_current BEFORE INSERT ON investigation_ledger_guard
WHEN NOT EXISTS (
  SELECT 1 FROM research_deployment_compatible c
  WHERE c.origin_deployment_generation=NEW.deployment_generation
)
BEGIN SELECT RAISE(ABORT, 'LEDGER_DEPLOYMENT_STALE: deployment generation mismatch'); END;

DROP TRIGGER ledger_cmd_deployment_current;
CREATE TRIGGER ledger_cmd_deployment_current BEFORE INSERT ON investigation_ledger_command
WHEN NOT EXISTS (
  SELECT 1 FROM research_deployment_compatible c
  WHERE c.origin_deployment_generation=NEW.deployment_generation
)
BEGIN SELECT RAISE(ABORT, 'LEDGER_DEPLOYMENT_STALE: deployment generation mismatch'); END;
