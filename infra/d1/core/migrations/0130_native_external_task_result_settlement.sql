-- Native result settlement only. Reservation/callback/progress deadlines remain unchanged.
-- Old generations retain the exact 0105 recovery predicate; no historical run is replayed.
PRAGMA foreign_keys = ON;
CREATE VIEW research_workflow_legacy_recovery_authorized AS
SELECT DISTINCT r.operation_id, wa.stage_index, r.principal_ref, i.intent_id
FROM research_workflow_run r
JOIN research_workflow_attempt wa ON wa.operation_id=r.operation_id
JOIN operation_intent i ON i.intent_id='research-recover:' || r.operation_id || ':' || wa.stage_index
  AND (i.revision, i.operation_kind)
      = (1, 'research.run.recover.v1')
  AND i.payload_ref='research-run:' || r.operation_id || ':' || wa.stage_index
  AND i.cancellation_ref='workflow:' || r.operation_id
JOIN operation_attempt oa ON (oa.intent_id, oa.intent_revision)
      = (i.intent_id, i.revision)
  AND oa.attempt_id='research-recover-attempt:' || r.operation_id || ':' || wa.stage_index
  AND oa.attempt_number=1 AND oa.state IN ('CHECKPOINTED','SUCCEEDED')
  AND oa.checkpoint_ref IN ('resume:' || i.intent_id, 'restart:' || i.intent_id)
LEFT JOIN project_client_run_control_origin c ON c.operation_id=r.operation_id
LEFT JOIN owner_machine_run_origin o ON o.operation_id=r.operation_id
LEFT JOIN research_workflow_current current_run ON current_run.operation_id=r.operation_id
  AND current_run.state IN ('ACTIVE','ENGINE_COMPLETED')
WHERE (i.principal_ref=r.principal_ref AND i.budget_reservation_ref IS NULL
    AND i.policy_decision_ref='research-recovery-authorized:' || r.operation_id || ':' || wa.stage_index
    AND EXISTS (SELECT 1 FROM scope_access_grant owner_grant
      WHERE (owner_grant.snapshot_id, owner_grant.snapshot_revision, owner_grant.principal_ref, owner_grant.credential_generation,
        owner_grant.authorization_receipt_ref, owner_grant.policy_authority_ref, owner_grant.client_class)
      = (r.scope_snapshot_id, r.scope_snapshot_revision, r.principal_ref, r.credential_generation, r.authorization_receipt_ref,
        r.policy_authority_ref, 'owner_pwa') AND owner_grant.project_client_grant_id IS NULL))
 OR (c.operation_id IS NOT NULL AND (c.operation_id, c.grantee_subject)
      = (r.operation_id, i.principal_ref)
      AND c.spend_policy_sha256 IS NOT NULL AND julianday(c.spend_expires_at)>julianday('now')
      AND ((COALESCE(c.spend_policy_protocol,'eliotr.research-owner-spend-template.v1')='eliotr.research-owner-spend-template.v1' AND c.spend_deployment_generation=r.deployment_generation) OR (c.spend_policy_protocol='eliotr.research-owner-spend-template.v2' AND c.spend_deployment_generation IS NULL))
      AND json_type(c.grant_record_json,'$.spend_policy_ref')='text'
      AND EXISTS (SELECT 1 FROM json_each(c.grant_record_json,'$.allowed_operations') WHERE value='recover')
      AND i.policy_decision_ref='research-client-recovery:' || c.grant_record_sha256 || ':' || c.project_generation || ':' || c.spend_policy_sha256
      AND i.budget_reservation_ref IS NULL
      AND current_run.operation_id IS NOT NULL)
 OR (o.operation_id IS NOT NULL AND (o.operation_id, o.reader_principal_ref)
      = (r.operation_id, i.principal_ref)
      AND o.spend_policy_sha256 IS NOT NULL AND julianday(o.spend_expires_at)>julianday('now')
      AND ((COALESCE(o.spend_policy_protocol,'eliotr.research-owner-spend-template.v1')='eliotr.research-owner-spend-template.v1' AND o.spend_deployment_generation=r.deployment_generation) OR (o.spend_policy_protocol='eliotr.research-owner-spend-template.v2' AND o.spend_deployment_generation IS NULL))
      AND julianday(o.execution_deadline)>julianday('now')
      AND i.budget_reservation_ref IS NULL
      AND i.policy_decision_ref='research-owner-machine-recovery:' || o.grant_record_sha256 || ':' || o.project_generation || ':' || o.spend_policy_sha256
      AND current_run.operation_id IS NOT NULL);

-- A recorded callback can authorize readback settlement, never another dispatch.
-- Existing W2 output/checkpoint triggers still enforce the exact output and ledger mutation.
CREATE VIEW research_external_agent_result_settlement_authorized AS
SELECT r.operation_id, t.stage_index, r.principal_ref, t.task_id AS intent_id
FROM research_external_agent_task t
JOIN research_workflow_current r ON r.operation_id=t.operation_id
  AND r.state='ACTIVE' AND r.next_stage_index=t.stage_index
JOIN research_workflow_attempt a ON a.operation_id=t.operation_id AND a.stage_index=t.stage_index
  AND a.attempt_ref=t.attempt_ref AND a.request_sha256=t.request_sha256
JOIN project_client_grant_current g ON g.grant_id=t.client_grant_id AND g.revision=t.client_grant_revision
  AND g.project_id=t.project_id AND g.grantee_subject=t.grantee_subject AND g.grantee_issuer=t.grantee_issuer
JOIN scope_snapshot s ON s.snapshot_id=r.scope_snapshot_id AND s.revision=r.scope_snapshot_revision
WHERE r.handler_generation='research-handlers.exploratory.external-wait.v1'
  AND t.stage_index=8 AND t.stage='ANALYZE_BRANCHES' AND t.state='RESULT_RECORDED'
  AND a.state IN ('STARTED','OUTPUT_RECORDED') AND a.expected_revision=r.current_revision
  AND r.ledger_revision BETWEEN a.expected_revision AND a.expected_revision+1
  AND json_extract(a.request_json,'$.handler_generation')=r.handler_generation
  AND json_extract(a.request_json,'$.operation_id')=t.operation_id
  AND json_extract(a.request_json,'$.stage')=t.stage
  AND json_extract(s.resolved_scope_expression_json,'$.kind')='PROJECT'
  AND json_extract(s.resolved_scope_expression_json,'$.project_id')=t.project_id
  AND g.state='ACTIVE' AND g.grantee_method='service_token' AND g.grantee_subject=r.principal_ref
  AND julianday(g.expires_at)>julianday('now')
  AND EXISTS (SELECT 1 FROM json_each(g.record_json,'$.allowed_operations') WHERE value='run')
  AND EXISTS (SELECT 1 FROM json_each(g.record_json,'$.allowed_operations') WHERE value='recover')
  AND EXISTS (SELECT 1 FROM json_each(g.record_json,'$.allowed_operations') WHERE value='evidence')
  AND t.task_id='external-task:' || t.request_sha256
  AND t.result_json IS NOT NULL AND length(t.result_sha256)=64
  AND t.result_sha256 NOT GLOB '*[^0-9a-f]*'
  AND json_extract(t.result_json,'$.protocol')='eliotr.external-agent-result.v1'
  AND json_extract(t.result_json,'$.task_id')=t.task_id
  AND json_extract(t.result_json,'$.operation_id')=t.operation_id
  AND json_extract(t.result_json,'$.stage_index')=t.stage_index
  AND json_extract(t.result_json,'$.stage')=t.stage
  AND json_extract(t.result_json,'$.attempt_ref')=t.attempt_ref
  AND json_extract(t.result_json,'$.request_sha256')=t.request_sha256
  AND json_extract(t.result_json,'$.lease_id')=t.lease_id
  AND json_extract(t.result_json,'$.idempotency_key')=t.result_idempotency_key
  AND json_extract(t.result_json,'$.submitted_at')=t.updated_at
  AND julianday(t.updated_at)>=julianday(t.created_at)
  AND julianday(t.updated_at)<julianday(t.lease_expires_at)
  AND julianday(t.updated_at)<julianday(a.budget_expires_at_ms/1000.0,'unixepoch');

DROP VIEW research_workflow_recovery_authorized;
CREATE VIEW research_workflow_recovery_authorized AS
SELECT operation_id,stage_index,principal_ref,intent_id FROM research_workflow_legacy_recovery_authorized
UNION ALL
SELECT operation_id,stage_index,principal_ref,intent_id FROM research_external_agent_result_settlement_authorized;

INSERT INTO schema_state(key,value,updated_at)
VALUES ('native_external_task_wait_generation','native-external-task-wait-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
