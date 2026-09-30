-- Provider-neutral computer-agent payload and deadline authority.
-- A payload may be staged before the W2 task row; it becomes visible only through the exact task binding.
PRAGMA foreign_keys = ON;

CREATE TABLE research_external_agent_task_payload (
  task_id TEXT PRIMARY KEY CHECK(length(task_id) BETWEEN 1 AND 128),
  task_kind TEXT NOT NULL CHECK(
    length(task_kind) BETWEEN 1 AND 64
    AND task_kind NOT GLOB '*[^A-Z0-9_]*'
    AND substr(task_kind,1,1) GLOB '[A-Z]'
  ),
  payload_json TEXT NOT NULL CHECK(
    json_valid(payload_json)
    AND json_type(payload_json)='object'
    AND length(CAST(payload_json AS BLOB)) BETWEEN 1 AND 98304
  ),
  payload_sha256 TEXT NOT NULL CHECK(
    length(payload_sha256)=64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  expires_at TEXT NOT NULL CHECK(julianday(expires_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  CHECK(task_id IS ('external-task:' || json_extract(payload_json,'$.request_sha256'))),
  CHECK(json_extract(payload_json,'$.protocol') IS 'eliotr.external-agent-task-payload.v1'),
  CHECK(json_extract(payload_json,'$.task_kind') IS task_kind),
  CHECK(json_extract(payload_json,'$.task_id') IS task_id),
  CHECK(json_type(payload_json,'$.operation_id') IS 'text'),
  CHECK(json_type(payload_json,'$.stage_index') IS 'integer'),
  CHECK(json_type(payload_json,'$.stage') IS 'text'),
  CHECK(json_type(payload_json,'$.attempt_ref') IS 'text'),
  CHECK(json_type(payload_json,'$.request_sha256') IS 'text'),
  CHECK(json_type(payload_json,'$.project_id') IS 'text'),
  CHECK(json_type(payload_json,'$.body') IS 'object'),
  CHECK(julianday(expires_at)>julianday(created_at)),
  CHECK(julianday(expires_at)<=julianday(created_at)+7)
) STRICT;
CREATE INDEX research_external_agent_task_payload_expiry_idx
  ON research_external_agent_task_payload(expires_at,task_id);

DROP VIEW research_external_agent_task_current;
DROP VIEW research_external_agent_task_binding;

-- Immutable W2/project/grant binding plus optional provider-neutral payload.
-- budget_expires_at_ms remains the runtime lease ceiling consumed by the v1 store:
-- payload tasks use their explicit task deadline; legacy tasks retain the W2 budget.
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
  AND json_extract(a.request_json,'$.handler_generation')='research-handlers.exploratory.v8'
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
    AND julianday(t.created_at)<=julianday(p.created_at,'+5 minutes')
    AND julianday(p.expires_at)<=julianday(g.expires_at)
  ));

-- Computer-agent generation v8 is never claimable before its payload is staged.
-- Status may still read the immutable binding after expiry or cancellation.
CREATE VIEW research_external_agent_task_current AS
SELECT b.* FROM research_external_agent_task_binding b
JOIN project_client_grant_current g
  ON g.grant_id=b.client_grant_id AND g.revision=b.client_grant_revision
JOIN research_workflow_current rw
  ON rw.operation_id=b.operation_id AND rw.next_stage_index=b.stage_index
WHERE g.state='ACTIVE' AND julianday(g.expires_at)>julianday('now')
  AND b.workflow_state='ACTIVE' AND b.attempt_state='STARTED'
  AND b.budget_expires_at_ms>CAST(unixepoch('subsec')*1000 AS INTEGER)
  AND (json_extract(b.request_json,'$.handler_generation')<>'research-handlers.exploratory.v8'
    OR (b.payload_json IS NOT NULL AND b.task_kind='RESEARCH_BRANCH_ANALYSIS'
      AND b.stage_index=8 AND b.stage='ANALYZE_BRANCHES'));

CREATE TRIGGER research_external_agent_task_payload_no_update
BEFORE UPDATE ON research_external_agent_task_payload
BEGIN SELECT RAISE(ABORT,'EXTERNAL_AGENT_TASK_PAYLOAD_IMMUTABLE'); END;
CREATE TRIGGER research_external_agent_task_payload_no_delete
BEFORE DELETE ON research_external_agent_task_payload
BEGIN SELECT RAISE(ABORT,'EXTERNAL_AGENT_TASK_PAYLOAD_IMMUTABLE'); END;

INSERT INTO schema_state(key,value,updated_at)
VALUES('external_agent_task_payload_generation','external-agent-task-payload-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
