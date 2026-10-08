-- S11/S32: one recorded-origin predicate for delegated machine and owner-run controls.
-- No new grants or reservations. Cancellation can stop expired execution; recovery
-- separately requires research_workflow_current and its original bounded authority.
CREATE VIEW project_client_run_control_origin AS
SELECT r.operation_id, r.investigation_id, r.principal_ref, r.credential_generation,
  r.deployment_generation, r.handler_generation, r.scope_snapshot_id, r.scope_snapshot_revision,
  r.policy_authority_ref, r.authorization_receipt_ref, g.client_class AS origin_client_class,
  c.grant_id AS client_grant_id, c.revision AS client_grant_revision, c.project_id,
  p.generation AS project_generation, c.grantor_principal_ref,
  c.grantee_issuer, c.grantee_method, c.grantee_subject, c.record_json AS grant_record_json,
  c.record_sha256 AS grant_record_sha256, c.spend_policy_sha256,
  c.spend_deployment_generation, c.spend_expires_at
FROM research_workflow_run r
JOIN scope_snapshot s ON s.snapshot_id=r.scope_snapshot_id AND s.revision=r.scope_snapshot_revision
  AND s.policy_authority_ref=r.policy_authority_ref AND s.client_fence_ref=r.credential_generation
JOIN scope_access_grant g ON g.snapshot_id=s.snapshot_id AND g.snapshot_revision=s.revision
  AND g.principal_ref=r.principal_ref AND g.credential_generation=r.credential_generation
  AND g.authorization_receipt_ref=r.authorization_receipt_ref AND g.policy_authority_ref=r.policy_authority_ref
JOIN project_client_grant_current c ON c.project_id=json_extract(s.resolved_scope_expression_json,'$.project_id')
JOIN project p ON p.project_id=c.project_id
JOIN project_owner o ON o.project_id=p.project_id AND o.principal_ref=c.grantor_principal_ref
WHERE json_extract(s.resolved_scope_expression_json,'$.kind')='PROJECT'
  AND c.grantee_method='service_token' AND c.state='ACTIVE' AND julianday(c.expires_at)>julianday('now')
  AND g.state IN ('ACTIVE','EXPIRED')
  AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) WHERE value='research')
  AND (
    (g.client_class='owner_pwa' AND g.project_client_grant_id IS NULL
      AND r.principal_ref=c.grantor_principal_ref
      AND NOT EXISTS (SELECT 1 FROM scope_access_grant revoked
        WHERE revoked.snapshot_id=s.snapshot_id AND revoked.snapshot_revision=s.revision
          AND revoked.principal_ref=r.principal_ref AND revoked.client_class='owner_pwa' AND revoked.state='REVOKED'))
    OR (g.client_class IN ('trusted_agent','named_api_client') AND r.principal_ref=c.grantee_subject
      AND g.project_client_grant_id=c.grant_id AND g.project_client_grant_revision=c.revision
      AND g.project_client_project_generation=p.generation AND g.project_client_operation='run'
      AND g.project_client_run_operation_id=r.operation_id
      AND EXISTS (SELECT 1 FROM json_each(c.record_json,'$.allowed_operations') WHERE value='run')
      AND EXISTS (SELECT 1 FROM orientation_request e
        WHERE e.execution_operation_id=r.operation_id AND e.state='COMPLETE'
          AND e.execution_client_grant_id=c.grant_id AND e.execution_client_grant_revision=c.revision
          AND e.principal_ref=r.principal_ref AND e.client_class=g.client_class
          AND e.credential_generation=r.credential_generation
          AND e.snapshot_id=s.snapshot_id AND e.snapshot_revision=s.revision
          AND julianday(e.expires_at)<=julianday(e.created_at)+1
          AND julianday(g.expires_at)<=julianday(e.expires_at)
          AND json_extract(e.result_json,'$.execution.operation_id')=r.operation_id
          AND json_extract(e.result_json,'$.execution.deadline')=e.expires_at))
  );

-- W2 and its existing settlement triggers share this view. Matching the run's
-- principal alone is NOT owner authority: a machine is also its run's author.
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
  );

INSERT INTO schema_state(key,value,updated_at)
VALUES('project_client_run_control_generation','project-client-run-control-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
