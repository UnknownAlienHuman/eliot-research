-- Explicit admission of native external-wait generation to the existing payload
-- and COMPUTER dispatch bindings. Historical v8 predicates remain identical.
-- New native tasks require the same immutable payload and every existing
-- grant/scope/route/actor/lease fence; 0130 still owns known-result settlement.
PRAGMA foreign_keys = ON;
DROP VIEW research_external_agent_task_current;
DROP VIEW research_external_agent_task_binding;

CREATE VIEW research_external_agent_task_binding AS
SELECT t.*, a.request_json, a.state AS attempt_state,
  CASE WHEN p.task_id IS NULL THEN a.budget_expires_at_ms
    ELSE MIN(
      CAST(unixepoch(p.expires_at,'subsec')*1000 AS INTEGER),
      CAST(unixepoch(sg.expires_at,'subsec')*1000 AS INTEGER),
      CAST(unixepoch(g.expires_at,'subsec')*1000 AS INTEGER)
    ) END AS budget_expires_at_ms,
  r.state AS workflow_state, r.cancellation_receipt_ref,
  g.state AS grant_state, g.expires_at AS grant_expires_at,
  sg.expires_at AS authority_expires_at,
  p.task_kind, p.payload_json, p.payload_sha256,
  p.expires_at AS task_expires_at, p.created_at AS payload_created_at
FROM research_external_agent_task t
JOIN research_workflow_attempt a
  ON a.operation_id=t.operation_id AND a.stage_index=t.stage_index
JOIN research_workflow_run r ON r.operation_id=t.operation_id
JOIN scope_snapshot s
  ON s.snapshot_id=r.scope_snapshot_id AND s.revision=r.scope_snapshot_revision
JOIN project_client_grant g
  ON g.grant_id=t.client_grant_id AND g.revision=t.client_grant_revision
JOIN scope_access_grant sg
  ON sg.snapshot_id=r.scope_snapshot_id AND sg.snapshot_revision=r.scope_snapshot_revision
  AND sg.principal_ref=r.principal_ref AND sg.credential_generation=r.credential_generation
  AND sg.policy_authority_ref=r.policy_authority_ref
  AND sg.authorization_receipt_ref=r.authorization_receipt_ref
  AND sg.project_client_operation='run' AND sg.project_client_run_operation_id=r.operation_id
  AND sg.project_client_grant_id=t.client_grant_id
  AND sg.project_client_grant_revision=t.client_grant_revision
  AND sg.client_class IN ('trusted_agent','named_api_client')
JOIN project_owner po
  ON po.project_id=g.project_id AND po.principal_ref=g.grantor_principal_ref
LEFT JOIN research_external_agent_task_payload p ON p.task_id=t.task_id
  AND json_extract(a.request_json,'$.handler_generation') IN ('research-handlers.exploratory.v8','research-handlers.exploratory.external-wait.v1')
WHERE a.attempt_ref=t.attempt_ref AND a.request_sha256=t.request_sha256
  AND json_extract(a.request_json,'$.operation_id')=t.operation_id
  AND json_extract(a.request_json,'$.stage')=t.stage
  AND g.project_id=t.project_id
  AND g.grantee_issuer=t.grantee_issuer AND g.grantee_subject=t.grantee_subject
  AND g.grantee_method='service_token'
  AND EXISTS(SELECT 1 FROM json_each(g.record_json,'$.allowed_operations') WHERE value='run')
  AND json_extract(s.resolved_scope_expression_json,'$.kind')='PROJECT'
  AND json_extract(s.resolved_scope_expression_json,'$.project_id')=t.project_id
  AND (p.task_id IS NULL OR (
    json_extract(p.payload_json,'$.operation_id')=t.operation_id
    AND json_extract(p.payload_json,'$.stage_index')=t.stage_index
    AND json_extract(p.payload_json,'$.stage')=t.stage
    AND json_extract(p.payload_json,'$.attempt_ref')=t.attempt_ref
    AND json_extract(p.payload_json,'$.request_sha256')=t.request_sha256
    AND json_extract(p.payload_json,'$.project_id')=t.project_id
    AND julianday(p.created_at)<=julianday(t.created_at)
    AND julianday(t.created_at)<=julianday(p.expires_at)
    AND julianday(p.expires_at)<=julianday(g.expires_at)
  ));

CREATE VIEW research_external_agent_task_current AS
SELECT b.* FROM research_external_agent_task_binding b
JOIN project_client_grant_current g
  ON g.grant_id=b.client_grant_id AND g.revision=b.client_grant_revision
JOIN research_workflow_current rw
  ON rw.operation_id=b.operation_id AND rw.next_stage_index=b.stage_index
WHERE g.state='ACTIVE' AND julianday(g.expires_at)>julianday('now')
  AND b.workflow_state='ACTIVE' AND b.attempt_state='STARTED'
  AND b.budget_expires_at_ms>CAST(unixepoch('subsec')*1000 AS INTEGER)
  AND (json_extract(b.request_json,'$.handler_generation') NOT IN ('research-handlers.exploratory.v8','research-handlers.exploratory.external-wait.v1')
    OR (b.payload_json IS NOT NULL AND b.task_kind='RESEARCH_BRANCH_ANALYSIS'
      AND b.stage_index=8 AND b.stage='ANALYZE_BRANCHES'));

DROP TRIGGER computer_agent_dispatch_acceptance_guard;
CREATE TRIGGER computer_agent_dispatch_acceptance_guard
BEFORE INSERT ON computer_agent_dispatch_acceptance
WHEN NOT EXISTS (
  SELECT 1
  FROM computer_agent_dispatch d
  JOIN research_workflow_run w ON w.operation_id=NEW.workflow_instance_id
  JOIN research_computer_agent_route_binding b ON b.operation_id=w.operation_id
  WHERE d.dispatch_id=NEW.dispatch_id
    AND d.actor_issuer=NEW.actor_issuer AND d.actor_subject=NEW.actor_subject
    AND d.qualification_credential_generation=NEW.credential_generation
    AND w.investigation_id=NEW.investigation_id AND w.initial_revision=NEW.investigation_revision
    AND w.principal_ref=NEW.actor_subject AND w.credential_generation=NEW.credential_generation
    AND w.deployment_generation=d.deployment_generation
    AND w.idempotency_key='computer-agent-dispatch:'||d.dispatch_id
    AND w.handler_generation IN ('research-handlers.exploratory.v8','research-handlers.exploratory.external-wait.v1')
    AND b.project_id=d.project_id AND b.task_kind=d.task_kind
    AND b.route_revision=d.route_revision AND b.priority=d.priority
    AND b.connection_id=d.connection_id AND b.connection_revision=d.connection_revision
    AND b.client_grant_id=d.client_grant_id AND b.client_grant_revision=d.client_grant_revision
    AND b.actor_issuer=d.actor_issuer AND b.actor_subject=d.actor_subject
    AND julianday(NEW.accepted_at)>=julianday(d.created_at)
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_DISPATCH_ACCEPTANCE_INVALID'); END;

INSERT INTO schema_state(key,value,updated_at)
VALUES ('native_external_task_payload_binding_generation','native-external-task-payload-binding-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
