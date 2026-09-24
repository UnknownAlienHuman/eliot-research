-- S32: a grantor may manage its machine runs without assuming machine identity.
-- The historical grant proves entitlement; it is not current service permission.
-- Reading/stopping use fresh owner authority. Recovery also requires the unchanged
-- effective execution grant, sponsor, deadline and original W2/W3 budgets.
CREATE VIEW owner_machine_run_origin AS
SELECT w.operation_id, w.investigation_id, w.principal_ref, w.credential_generation,
  w.deployment_generation, w.handler_generation, w.scope_snapshot_id, w.scope_snapshot_revision,
  w.policy_authority_ref, w.authorization_receipt_ref, g.client_class AS origin_client_class,
  d.grantor_principal_ref AS reader_principal_ref, d.project_id, p.generation AS project_generation,
  d.grant_id AS client_grant_id, d.revision AS client_grant_revision,
  d.record_sha256 AS grant_record_sha256, d.spend_policy_sha256,
  d.spend_deployment_generation, d.spend_expires_at, e.expires_at AS execution_deadline
FROM research_workflow_run w
JOIN scope_snapshot s ON s.snapshot_id=w.scope_snapshot_id AND s.revision=w.scope_snapshot_revision
  AND s.client_fence_ref=w.credential_generation AND s.policy_authority_ref=w.policy_authority_ref
JOIN scope_access_grant g ON g.project_client_run_operation_id=w.operation_id AND g.project_client_operation='run'
  AND g.snapshot_id=s.snapshot_id AND g.snapshot_revision=s.revision AND g.principal_ref=w.principal_ref
  AND g.credential_generation=w.credential_generation AND g.policy_authority_ref=w.policy_authority_ref
  AND g.authorization_receipt_ref=w.authorization_receipt_ref
JOIN project_client_grant d ON d.grant_id=g.project_client_grant_id AND d.revision=g.project_client_grant_revision
  AND d.grantee_subject=g.principal_ref AND d.grantee_method='service_token' AND d.state='ACTIVE'
JOIN project p ON p.project_id=d.project_id
JOIN project_owner po ON po.project_id=p.project_id AND po.principal_ref=d.grantor_principal_ref
JOIN orientation_request e ON e.execution_operation_id=w.operation_id AND e.state='COMPLETE'
  AND e.execution_client_grant_id=d.grant_id AND e.execution_client_grant_revision=d.revision
  AND e.principal_ref=w.principal_ref AND e.client_class=g.client_class AND e.credential_generation=w.credential_generation
  AND e.snapshot_id=s.snapshot_id AND e.snapshot_revision=s.revision
WHERE g.client_class IN ('trusted_agent','named_api_client') AND w.state IN ('ACTIVE','ENGINE_COMPLETED','CANCELLED')
  AND (s.invalidated_at IS NULL OR s.invalidation_reason IN ('SCOPE_INPUT_CHANGED','CLIENT_DELEGATION_STALE'))
  AND json_extract(s.resolved_scope_expression_json,'$.kind')='PROJECT'
  AND json_extract(s.resolved_scope_expression_json,'$.project_id')=d.project_id
  AND EXISTS (SELECT 1 FROM json_each(d.record_json,'$.allowed_operations') WHERE value='run')
  AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) WHERE value='research')
  AND julianday(e.expires_at)>julianday(e.created_at) AND julianday(e.expires_at)<=julianday(e.created_at)+1
  AND julianday(g.expires_at)<=julianday(e.expires_at)
  AND json_extract(e.result_json,'$.execution.operation_id')=w.operation_id
  AND json_extract(e.result_json,'$.execution.deadline')=e.expires_at
  AND NOT EXISTS (SELECT 1 FROM json_each(s.member_source_revision_refs_json) member WHERE NOT EXISTS (
    SELECT 1 FROM source_revision sr JOIN project_source_membership m ON m.source_id=sr.source_id
    WHERE sr.source_revision_ref=member.value AND m.project_id=p.project_id
      AND julianday(m.valid_from)<=julianday('now') AND (m.valid_to IS NULL OR julianday(m.valid_to)>julianday('now'))));

DROP VIEW research_workflow_recovery_authorized;
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
    AND i.policy_decision_ref='research-recovery-authorized:' || r.operation_id || ':' || wa.stage_index
    AND EXISTS (SELECT 1 FROM scope_access_grant owner_grant
      WHERE owner_grant.snapshot_id=r.scope_snapshot_id AND owner_grant.snapshot_revision=r.scope_snapshot_revision
        AND owner_grant.principal_ref=r.principal_ref AND owner_grant.credential_generation=r.credential_generation
        AND owner_grant.authorization_receipt_ref=r.authorization_receipt_ref
        AND owner_grant.policy_authority_ref=r.policy_authority_ref
        AND owner_grant.client_class='owner_pwa' AND owner_grant.project_client_grant_id IS NULL))
  OR EXISTS (
    SELECT 1 FROM project_client_run_control_origin c
    WHERE c.operation_id=r.operation_id AND c.grantee_subject=i.principal_ref
      AND c.spend_policy_sha256 IS NOT NULL AND julianday(c.spend_expires_at)>julianday('now')
      AND c.spend_deployment_generation=r.deployment_generation
      AND json_type(c.grant_record_json,'$.spend_policy_ref')='text'
      AND EXISTS (SELECT 1 FROM json_each(c.grant_record_json,'$.allowed_operations') WHERE value='recover')
      AND i.policy_decision_ref='research-client-recovery:' || c.grant_record_sha256 || ':' || c.project_generation || ':' || c.spend_policy_sha256
      AND i.budget_reservation_ref IS NULL
      AND EXISTS (SELECT 1 FROM research_workflow_current current_run
        WHERE current_run.operation_id=r.operation_id AND current_run.state IN ('ACTIVE','ENGINE_COMPLETED'))
  )
  OR EXISTS (
    SELECT 1 FROM owner_machine_run_origin o
    WHERE o.operation_id=r.operation_id AND o.reader_principal_ref=i.principal_ref
      AND o.spend_policy_sha256 IS NOT NULL AND julianday(o.spend_expires_at)>julianday('now')
      AND o.spend_deployment_generation=r.deployment_generation
      AND julianday(o.execution_deadline)>julianday('now')
      AND i.budget_reservation_ref IS NULL
      AND i.policy_decision_ref='research-owner-machine-recovery:' || o.grant_record_sha256 || ':' || o.project_generation || ':' || o.spend_policy_sha256
      AND EXISTS (SELECT 1 FROM research_workflow_current current_run
        WHERE current_run.operation_id=r.operation_id AND current_run.state IN ('ACTIVE','ENGINE_COMPLETED'))
  );

INSERT INTO schema_state(key,value,updated_at)
VALUES('owner_machine_run_generation','owner-machine-run-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
UPDATE schema_state SET value='project-client-run-control-v2',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE key='project_client_run_control_generation';
