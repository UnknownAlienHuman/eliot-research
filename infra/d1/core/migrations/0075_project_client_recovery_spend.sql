-- Bind optional model-spend sponsorship to an immutable project grant revision.
-- Existing grants remain unchanged and confer no spend authority without this binding.
-- Recovery may resume only the original owner's already-authorized operation.
ALTER TABLE project_client_grant ADD COLUMN spend_policy_sha256 TEXT
  CHECK(spend_policy_sha256 IS NULL OR (length(spend_policy_sha256)=64 AND spend_policy_sha256 NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE project_client_grant ADD COLUMN spend_deployment_generation TEXT
  CHECK(spend_deployment_generation IS NULL OR length(spend_deployment_generation) BETWEEN 1 AND 256);
ALTER TABLE project_client_grant ADD COLUMN spend_expires_at TEXT
  CHECK(spend_expires_at IS NULL OR julianday(spend_expires_at) IS NOT NULL);

CREATE TRIGGER project_client_grant_spend_guard BEFORE INSERT ON project_client_grant
BEGIN
  SELECT RAISE(ABORT,'CLIENT_GRANT_SPEND_DENIED') WHERE NOT (
    (json_type(NEW.record_json,'$.spend_policy_ref') IS NULL AND NEW.spend_policy_sha256 IS NULL
      AND NEW.spend_deployment_generation IS NULL AND NEW.spend_expires_at IS NULL)
    OR (json_type(NEW.record_json,'$.spend_policy_ref') IS 'text'
      AND length(json_extract(NEW.record_json,'$.spend_policy_ref')) BETWEEN 1 AND 256
      AND NEW.spend_policy_sha256 IS NOT NULL AND NEW.spend_deployment_generation IS NOT NULL
      AND NEW.spend_expires_at IS NOT NULL AND julianday(NEW.expires_at)<=julianday(NEW.spend_expires_at)
      AND EXISTS (SELECT 1 FROM json_each(NEW.record_json,'$.allowed_operations') WHERE value IN ('run','recover'))));
  SELECT RAISE(ABORT,'CLIENT_GRANT_SPEND_DENIED') WHERE NEW.state='ACTIVE' AND NEW.spend_expires_at IS NOT NULL
    AND julianday(NEW.spend_expires_at)<=julianday('now');
  -- Revocation never needs live approval, but preserves the exact previous binding.
  SELECT RAISE(ABORT,'CLIENT_GRANT_SPEND_DENIED') WHERE NEW.state='REVOKED' AND NOT EXISTS (
    SELECT 1 FROM project_client_grant p WHERE p.grant_id=NEW.grant_id AND p.revision=NEW.revision-1
      AND p.spend_policy_sha256 IS NEW.spend_policy_sha256
      AND p.spend_deployment_generation IS NEW.spend_deployment_generation
      AND p.spend_expires_at IS NEW.spend_expires_at
      AND json_extract(p.record_json,'$.spend_policy_ref') IS json_extract(NEW.record_json,'$.spend_policy_ref'));
END;

-- One readback-only recovery authorization shared by W2 and its SQL settlement guards.
-- This does not renew scopes/reservations or authorize a fresh provider invocation.
CREATE VIEW research_workflow_recovery_authorized AS
SELECT r.operation_id, wa.stage_index, r.principal_ref, i.intent_id
FROM research_workflow_run r
JOIN research_workflow_attempt wa ON wa.operation_id=r.operation_id
JOIN operation_intent i ON i.intent_id='research-recover:' || r.operation_id || ':' || wa.stage_index
  AND i.revision=1 AND i.operation_kind='research.run.recover.v1'
  AND i.payload_ref='research-run:' || r.operation_id || ':' || wa.stage_index
  AND i.cancellation_ref='workflow:' || r.operation_id
JOIN operation_attempt oa ON oa.intent_id=i.intent_id AND oa.intent_revision=i.revision
  AND oa.attempt_id='research-recover-attempt:' || r.operation_id || ':' || wa.stage_index
  AND oa.attempt_number=1 AND oa.state IN ('CHECKPOINTED','SUCCEEDED')
  AND oa.checkpoint_ref IN ('resume:' || i.intent_id, 'restart:' || i.intent_id)
WHERE (i.principal_ref=r.principal_ref AND i.budget_reservation_ref IS NULL
    AND i.policy_decision_ref='research-recovery-authorized:' || r.operation_id || ':' || wa.stage_index)
  OR EXISTS (
    SELECT 1 FROM project_client_grant_current c
    JOIN project p ON p.project_id=c.project_id
    JOIN project_owner o ON o.project_id=p.project_id AND o.principal_ref=c.grantor_principal_ref
    JOIN scope_snapshot s ON s.snapshot_id=r.scope_snapshot_id AND s.revision=r.scope_snapshot_revision
    JOIN scope_access_grant g ON g.snapshot_id=s.snapshot_id AND g.snapshot_revision=s.revision
      AND g.principal_ref=r.principal_ref AND g.credential_generation=r.credential_generation
      AND g.authorization_receipt_ref=r.authorization_receipt_ref AND g.policy_authority_ref=r.policy_authority_ref
    WHERE c.grantor_principal_ref=r.principal_ref AND c.grantee_subject=i.principal_ref
      AND c.grantee_method='service_token' AND c.state='ACTIVE'
      AND julianday(c.expires_at)>julianday('now') AND julianday(c.spend_expires_at)>julianday('now')
      AND c.spend_deployment_generation=r.deployment_generation AND c.spend_policy_sha256 IS NOT NULL
      AND json_type(c.record_json,'$.spend_policy_ref')='text'
      AND EXISTS (SELECT 1 FROM json_each(c.record_json,'$.allowed_operations') WHERE value='recover')
      AND i.policy_decision_ref='research-client-recovery:' || c.record_sha256 || ':' || p.generation || ':' || c.spend_policy_sha256
      AND i.budget_reservation_ref IS NULL
      AND json_extract(s.resolved_scope_expression_json,'$.kind')='PROJECT'
      AND json_extract(s.resolved_scope_expression_json,'$.project_id')=c.project_id
      AND s.invalidated_at IS NULL AND julianday(s.expires_at)>julianday('now')
      AND g.client_class='owner_pwa' AND g.project_client_grant_id IS NULL AND g.state='ACTIVE'
      AND julianday(g.expires_at)>julianday('now')
      AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) WHERE value='research')
  );

DROP TRIGGER research_workflow_output_authority;
CREATE TRIGGER research_workflow_output_authority BEFORE UPDATE ON research_workflow_attempt
WHEN NEW.state = 'OUTPUT_RECORDED' AND (
 (NEW.budget_expires_at_ms <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
   AND NOT EXISTS (
     SELECT 1 FROM research_workflow_recovery_authorized a
     WHERE a.operation_id=NEW.operation_id AND a.stage_index=NEW.stage_index
   ))
 OR NOT EXISTS (SELECT 1 FROM research_workflow_current r WHERE r.operation_id = NEW.operation_id
   AND r.state = 'ACTIVE' AND r.next_stage_index = NEW.stage_index
   AND r.current_revision = NEW.expected_revision AND r.ledger_revision = NEW.expected_revision)
 OR json_extract(NEW.output_json, '$.object_ref') IS NOT ('workflow/' || NEW.request_sha256 || '/' || NEW.attempt_ref)
 OR json_extract(NEW.output_json, '$.byte_length') NOT BETWEEN 0 AND 8388608
 OR length(json_extract(NEW.output_json, '$.sha256')) IS NOT 64
 OR json_extract(NEW.output_json, '$.sha256') GLOB '*[^0-9a-f]*'
 OR json_extract(NEW.output_json, '$.residency.content_digest.digest') IS NOT json_extract(NEW.output_json, '$.sha256')
 OR json_extract(NEW.output_json, '$.residency.content_digest.algorithm') IS NOT 'sha256'
 OR json_extract(NEW.output_json, '$.residency.scope_domain_id') IS NOT json_extract(NEW.request_json, '$.input_manifest.residency.scope_domain_id')
 OR json_extract(NEW.output_json, '$.residency.access_domain_id') IS NOT json_extract(NEW.request_json, '$.input_manifest.residency.access_domain_id')
 OR json_extract(NEW.output_json, '$.residency.confidentiality_domain_id') IS NOT json_extract(NEW.request_json, '$.input_manifest.residency.confidentiality_domain_id')
 OR json_extract(NEW.output_json, '$.residency.encryption_key_domain_id') IS NOT json_extract(NEW.request_json, '$.input_manifest.residency.encryption_key_domain_id')
 OR json_extract(NEW.output_json, '$.residency.retention_domain_id') IS NOT json_extract(NEW.request_json, '$.input_manifest.residency.retention_domain_id')
 OR json_extract(NEW.output_json, '$.residency.erasure_domain_id') IS NOT json_extract(NEW.request_json, '$.input_manifest.residency.erasure_domain_id')
)
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTHORITY_STALE'); END;

DROP TRIGGER research_workflow_checkpoint_guard;
CREATE TRIGGER research_workflow_checkpoint_guard BEFORE INSERT ON research_workflow_checkpoint
WHEN NOT EXISTS (
 SELECT 1 FROM research_workflow_current r
 JOIN research_workflow_attempt a ON a.operation_id = r.operation_id AND a.stage_index = NEW.stage_index
 JOIN investigation_ledger_event e ON e.event_id = NEW.ledger_event_id
 WHERE r.operation_id = NEW.operation_id AND r.state = 'ACTIVE' AND r.next_stage_index = NEW.stage_index
 AND a.state = 'OUTPUT_RECORDED' AND a.request_sha256 = NEW.request_sha256
 AND (a.budget_expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
   OR EXISTS (
     SELECT 1 FROM research_workflow_recovery_authorized recovery
     WHERE recovery.operation_id=NEW.operation_id AND recovery.stage_index=NEW.stage_index
       AND recovery.principal_ref=r.principal_ref
   ))
 AND r.current_revision = a.expected_revision AND r.ledger_revision = a.expected_revision + 1
 AND e.investigation_id = r.investigation_id AND e.sequence = r.event_head AND e.kind = 'CHECKPOINT'
 AND e.actor_ref = r.principal_ref AND e.verifier_ref IS NULL
 AND e.payload_handle_ref = json_extract(a.output_json, '$.object_ref')
 AND e.payload_digest = json_extract(a.output_json, '$.sha256')
 AND NEW.ledger_event_id = 'wcp:' || NEW.request_sha256
 AND json_extract(NEW.receipt_json, '$.protocol') = 'eliotr.workflow-checkpoint.v1'
 AND json_extract(NEW.receipt_json, '$.operation_id') = r.operation_id
 AND json_extract(NEW.receipt_json, '$.request_sha256') = a.request_sha256
 AND json_extract(NEW.receipt_json, '$.stage') = json_extract(a.request_json, '$.stage')
 AND json_extract(NEW.receipt_json, '$.attempt_ref') = a.attempt_ref
 AND json_extract(NEW.receipt_json, '$.receipt_ref') = 'wcp:' || NEW.request_sha256
 AND json_extract(NEW.receipt_json, '$.investigation_ref.id') = r.investigation_id
 AND json_extract(NEW.receipt_json, '$.investigation_ref.revision') = r.ledger_revision
 AND json_extract(NEW.receipt_json, '$.input_manifest_ref') = json_extract(a.request_json, '$.input_manifest.object_ref')
 AND json_extract(NEW.receipt_json, '$.output_manifest') = a.output_json
 AND json_extract(NEW.receipt_json, '$.budget_receipt_ref') = a.budget_receipt_ref
 AND json_extract(NEW.receipt_json, '$.cancellation_checked_at') = NEW.created_at
 AND json_extract(NEW.receipt_json, '$.engine_state') = CASE WHEN NEW.stage_index = 17 THEN 'ENGINE_COMPLETED' ELSE 'CHECKPOINTED' END
)
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTHORITY_STALE'); END;

INSERT INTO schema_state(key,value,updated_at)
VALUES('project_client_spend_generation','project-client-spend-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
