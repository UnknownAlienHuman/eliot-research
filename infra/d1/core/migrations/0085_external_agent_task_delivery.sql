-- External subscription-agent delivery over the existing Research workflow attempt.
-- This table owns only delivery/lease/callback state. W1/W2 remain completion authority.
PRAGMA foreign_keys = ON;

CREATE TABLE research_external_agent_task (
  task_id TEXT PRIMARY KEY CHECK(length(task_id) BETWEEN 1 AND 128),
  operation_id TEXT NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 128),
  stage_index INTEGER NOT NULL CHECK(stage_index BETWEEN 0 AND 17),
  stage TEXT NOT NULL CHECK(stage IN (
    'FREEZE_PROTOCOL_AND_SCOPE','ORIENT','INTERPRET','COMPILE_OBLIGATIONS','PLAN',
    'RETRIEVE_BRANCHES','ACQUIRE_AND_CAPTURE','READ_AND_EXTRACT','ANALYZE_BRANCHES',
    'COUNTER_SEARCH','RECONCILE','FREEZE_EVIDENCE','SYNTHESIZE','VERIFY',
    'AUDIT_CLAIMS','RESOLVE_CITATIONS','CALCULATE_COVERAGE','MATERIALIZE'
  )),
  attempt_ref TEXT NOT NULL UNIQUE CHECK(length(attempt_ref) BETWEEN 1 AND 128),
  request_sha256 TEXT NOT NULL UNIQUE
    CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 256),
  client_grant_id TEXT NOT NULL CHECK(length(client_grant_id) BETWEEN 1 AND 256),
  client_grant_revision INTEGER NOT NULL CHECK(client_grant_revision BETWEEN 1 AND 2147483647),
  grantee_issuer TEXT NOT NULL CHECK(length(grantee_issuer) BETWEEN 1 AND 256),
  grantee_subject TEXT NOT NULL CHECK(length(grantee_subject) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK(state IN ('AVAILABLE','LEASED','RESULT_RECORDED')),
  lease_id TEXT UNIQUE CHECK(lease_id IS NULL OR length(lease_id) BETWEEN 1 AND 128),
  lease_slot TEXT CHECK(lease_slot IS NULL OR
    (length(lease_slot) BETWEEN 1 AND 64 AND lease_slot NOT GLOB '*[^A-Za-z0-9._:-]*'
      AND substr(lease_slot,1,1) GLOB '[A-Za-z0-9]')),
  lease_credential_generation TEXT CHECK(lease_credential_generation IS NULL OR length(lease_credential_generation) BETWEEN 1 AND 256),
  lease_revision INTEGER NOT NULL DEFAULT 0 CHECK(lease_revision BETWEEN 0 AND 2147483647),
  lease_expires_at TEXT CHECK(lease_expires_at IS NULL OR julianday(lease_expires_at) IS NOT NULL),
  result_idempotency_key TEXT CHECK(result_idempotency_key IS NULL OR length(result_idempotency_key) BETWEEN 1 AND 256),
  result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND length(CAST(result_json AS BLOB)) BETWEEN 1 AND 98304)),
  result_sha256 TEXT CHECK(result_sha256 IS NULL OR (length(result_sha256)=64 AND result_sha256 NOT GLOB '*[^0-9a-f]*')),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK(julianday(updated_at) IS NOT NULL),
  UNIQUE(operation_id,stage_index),
  FOREIGN KEY(operation_id,stage_index) REFERENCES research_workflow_attempt(operation_id,stage_index),
  FOREIGN KEY(client_grant_id,client_grant_revision) REFERENCES project_client_grant(grant_id,revision),
  CHECK(task_id='external-task:' || request_sha256),
  CHECK(julianday(updated_at)>=julianday(created_at)),
  CHECK(
    (state='AVAILABLE' AND lease_id IS NULL AND lease_slot IS NULL AND lease_credential_generation IS NULL
      AND lease_revision=0 AND lease_expires_at IS NULL
      AND result_idempotency_key IS NULL AND result_json IS NULL AND result_sha256 IS NULL)
    OR
    (state='LEASED' AND lease_id IS NOT NULL AND lease_slot IS NOT NULL AND lease_credential_generation IS NOT NULL
      AND lease_revision>=1 AND lease_expires_at IS NOT NULL
      AND result_idempotency_key IS NULL AND result_json IS NULL AND result_sha256 IS NULL)
    OR
    (state='RESULT_RECORDED' AND lease_id IS NOT NULL AND lease_slot IS NOT NULL AND lease_credential_generation IS NOT NULL
      AND lease_revision>=1 AND lease_expires_at IS NOT NULL
      AND result_idempotency_key IS NOT NULL AND result_json IS NOT NULL AND result_sha256 IS NOT NULL)
  )
) STRICT;

CREATE INDEX research_external_agent_task_pull_idx
  ON research_external_agent_task(client_grant_id,client_grant_revision,state,created_at,task_id);
CREATE UNIQUE INDEX research_external_agent_one_active_lease_per_slot
  ON research_external_agent_task(client_grant_id,client_grant_revision,lease_slot)
  WHERE state='LEASED';

CREATE TABLE research_external_agent_task_progress (
  task_id TEXT NOT NULL REFERENCES research_external_agent_task(task_id),
  cursor INTEGER NOT NULL CHECK(cursor BETWEEN 1 AND 4096),
  lease_id TEXT NOT NULL CHECK(length(lease_id) BETWEEN 1 AND 128),
  credential_generation TEXT NOT NULL CHECK(length(credential_generation) BETWEEN 1 AND 256),
  progress_json TEXT NOT NULL CHECK(json_valid(progress_json) AND length(CAST(progress_json AS BLOB)) BETWEEN 1 AND 16384),
  progress_sha256 TEXT NOT NULL CHECK(length(progress_sha256)=64 AND progress_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  PRIMARY KEY(task_id,cursor)
) STRICT;

-- Immutable binding to the exact W2 attempt, project scope and historical grant revision.
CREATE VIEW research_external_agent_task_binding AS
SELECT t.*, a.request_json, a.state AS attempt_state, a.budget_expires_at_ms,
  r.state AS workflow_state, r.cancellation_receipt_ref,
  g.state AS grant_state, g.expires_at AS grant_expires_at
FROM research_external_agent_task t
JOIN research_workflow_attempt a
  ON a.operation_id=t.operation_id AND a.stage_index=t.stage_index
JOIN research_workflow_run r ON r.operation_id=t.operation_id
JOIN scope_snapshot s
  ON s.snapshot_id=r.scope_snapshot_id AND s.revision=r.scope_snapshot_revision
JOIN project_client_grant g
  ON g.grant_id=t.client_grant_id AND g.revision=t.client_grant_revision
JOIN project_owner po
  ON po.project_id=g.project_id AND po.principal_ref=g.grantor_principal_ref
WHERE a.attempt_ref=t.attempt_ref AND a.request_sha256=t.request_sha256
  AND json_extract(a.request_json,'$.operation_id')=t.operation_id
  AND json_extract(a.request_json,'$.stage')=t.stage
  AND g.project_id=t.project_id
  AND g.grantee_issuer=t.grantee_issuer AND g.grantee_subject=t.grantee_subject
  AND g.grantee_method='service_token'
  AND EXISTS(SELECT 1 FROM json_each(g.record_json,'$.allowed_operations') WHERE value='run')
  AND json_extract(s.resolved_scope_expression_json,'$.kind')='PROJECT'
  AND json_extract(s.resolved_scope_expression_json,'$.project_id')=t.project_id;

-- Current mutation authority. Status may still read the immutable binding after cancellation.
CREATE VIEW research_external_agent_task_current AS
SELECT b.* FROM research_external_agent_task_binding b
JOIN project_client_grant_current g
  ON g.grant_id=b.client_grant_id AND g.revision=b.client_grant_revision
WHERE g.state='ACTIVE' AND julianday(g.expires_at)>julianday('now')
  AND b.workflow_state='ACTIVE' AND b.attempt_state='STARTED'
  AND b.budget_expires_at_ms>CAST(unixepoch('subsec')*1000 AS INTEGER);

CREATE TRIGGER research_external_agent_task_insert_guard
AFTER INSERT ON research_external_agent_task
WHEN NEW.updated_at IS NOT NEW.created_at OR NOT EXISTS (
  SELECT 1 FROM research_external_agent_task_current c
  WHERE c.task_id=NEW.task_id AND c.state='AVAILABLE'
    AND c.stage_index=CASE c.stage
      WHEN 'FREEZE_PROTOCOL_AND_SCOPE' THEN 0 WHEN 'ORIENT' THEN 1 WHEN 'INTERPRET' THEN 2
      WHEN 'COMPILE_OBLIGATIONS' THEN 3 WHEN 'PLAN' THEN 4 WHEN 'RETRIEVE_BRANCHES' THEN 5
      WHEN 'ACQUIRE_AND_CAPTURE' THEN 6 WHEN 'READ_AND_EXTRACT' THEN 7 WHEN 'ANALYZE_BRANCHES' THEN 8
      WHEN 'COUNTER_SEARCH' THEN 9 WHEN 'RECONCILE' THEN 10 WHEN 'FREEZE_EVIDENCE' THEN 11
      WHEN 'SYNTHESIZE' THEN 12 WHEN 'VERIFY' THEN 13 WHEN 'AUDIT_CLAIMS' THEN 14
      WHEN 'RESOLVE_CITATIONS' THEN 15 WHEN 'CALCULATE_COVERAGE' THEN 16 WHEN 'MATERIALIZE' THEN 17 END
    AND c.stage_index=(SELECT r.next_stage_index FROM research_workflow_run r WHERE r.operation_id=c.operation_id)
)
BEGIN SELECT RAISE(ABORT,'EXTERNAL_AGENT_TASK_AUTHORITY_STALE'); END;

CREATE TRIGGER research_external_agent_task_transition
BEFORE UPDATE ON research_external_agent_task
WHEN NEW.task_id IS NOT OLD.task_id OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.stage_index IS NOT OLD.stage_index OR NEW.stage IS NOT OLD.stage
  OR NEW.attempt_ref IS NOT OLD.attempt_ref OR NEW.request_sha256 IS NOT OLD.request_sha256
  OR NEW.project_id IS NOT OLD.project_id OR NEW.client_grant_id IS NOT OLD.client_grant_id
  OR NEW.client_grant_revision IS NOT OLD.client_grant_revision
  OR NEW.grantee_issuer IS NOT OLD.grantee_issuer OR NEW.grantee_subject IS NOT OLD.grantee_subject
  OR NEW.created_at IS NOT OLD.created_at
  OR julianday(NEW.updated_at)<julianday(OLD.updated_at)
  OR OLD.state='RESULT_RECORDED'
  OR NOT ((OLD.state='AVAILABLE' AND NEW.state='LEASED')
    OR (OLD.state='LEASED' AND NEW.state='LEASED')
    OR (OLD.state='LEASED' AND NEW.state='RESULT_RECORDED'))
  OR NEW.lease_revision <> OLD.lease_revision + CASE WHEN NEW.lease_id IS NOT OLD.lease_id THEN 1 ELSE 0 END
  OR (NEW.lease_id IS OLD.lease_id AND
    (NEW.lease_slot IS NOT OLD.lease_slot OR NEW.lease_credential_generation IS NOT OLD.lease_credential_generation))
  OR (OLD.state='LEASED' AND NEW.state='LEASED' AND NEW.lease_id IS OLD.lease_id
    AND julianday(NEW.lease_expires_at)<julianday(OLD.lease_expires_at))
  OR (NEW.state='RESULT_RECORDED' AND NEW.lease_id IS NOT OLD.lease_id)
BEGIN SELECT RAISE(ABORT,'EXTERNAL_AGENT_TASK_CONFLICT'); END;

CREATE TRIGGER research_external_agent_task_current_guard
BEFORE UPDATE ON research_external_agent_task
WHEN NOT EXISTS (
  SELECT 1 FROM research_external_agent_task_current c
  WHERE c.task_id=OLD.task_id
    AND julianday(NEW.lease_expires_at)<=julianday(c.grant_expires_at)
    AND CAST(unixepoch(NEW.lease_expires_at,'subsec')*1000 AS INTEGER)<=c.budget_expires_at_ms
    AND julianday(NEW.lease_expires_at)>julianday(NEW.updated_at)
    AND (OLD.state='AVAILABLE'
      OR (NEW.lease_id IS OLD.lease_id AND julianday(OLD.lease_expires_at)>julianday(NEW.updated_at))
      OR (NEW.lease_id IS NOT OLD.lease_id AND OLD.state='LEASED'
        AND julianday(OLD.lease_expires_at)<=julianday(NEW.updated_at)))
)
BEGIN SELECT RAISE(ABORT,'EXTERNAL_AGENT_TASK_AUTHORITY_STALE'); END;

CREATE TRIGGER research_external_agent_task_result_guard
BEFORE UPDATE ON research_external_agent_task
WHEN NEW.state='RESULT_RECORDED' AND (
  json_extract(NEW.result_json,'$.protocol') IS NOT 'eliotr.external-agent-result.v1'
  OR json_extract(NEW.result_json,'$.task_id') IS NOT NEW.task_id
  OR json_extract(NEW.result_json,'$.operation_id') IS NOT NEW.operation_id
  OR json_extract(NEW.result_json,'$.stage_index') IS NOT NEW.stage_index
  OR json_extract(NEW.result_json,'$.stage') IS NOT NEW.stage
  OR json_extract(NEW.result_json,'$.attempt_ref') IS NOT NEW.attempt_ref
  OR json_extract(NEW.result_json,'$.request_sha256') IS NOT NEW.request_sha256
  OR json_extract(NEW.result_json,'$.lease_id') IS NOT NEW.lease_id
  OR json_extract(NEW.result_json,'$.idempotency_key') IS NOT NEW.result_idempotency_key
  OR json_extract(NEW.result_json,'$.disposition') NOT IN ('SUCCEEDED','PARTIAL','FAILED')
  OR json_extract(NEW.result_json,'$.submitted_at') IS NOT NEW.updated_at
  OR julianday(json_extract(NEW.result_json,'$.submitted_at')) IS NULL
)
BEGIN SELECT RAISE(ABORT,'EXTERNAL_AGENT_RESULT_INVALID'); END;

CREATE TRIGGER research_external_agent_task_no_delete
BEFORE DELETE ON research_external_agent_task
BEGIN SELECT RAISE(ABORT,'EXTERNAL_AGENT_TASK_IMMUTABLE'); END;

CREATE TRIGGER research_external_agent_progress_insert_guard
BEFORE INSERT ON research_external_agent_task_progress
WHEN NOT EXISTS (
  SELECT 1 FROM research_external_agent_task_current c
  WHERE c.task_id=NEW.task_id AND c.state='LEASED' AND c.lease_id=NEW.lease_id
    AND c.lease_credential_generation=NEW.credential_generation
    AND julianday(c.lease_expires_at)>julianday(NEW.created_at)
    AND NEW.cursor=COALESCE((SELECT MAX(p.cursor)+1 FROM research_external_agent_task_progress p
      WHERE p.task_id=NEW.task_id),1)
    AND json_extract(NEW.progress_json,'$.protocol')='eliotr.external-agent-progress.v1'
    AND json_extract(NEW.progress_json,'$.task_id')=NEW.task_id
    AND json_extract(NEW.progress_json,'$.operation_id')=c.operation_id
    AND json_extract(NEW.progress_json,'$.stage_index')=c.stage_index
    AND json_extract(NEW.progress_json,'$.stage')=c.stage
    AND json_extract(NEW.progress_json,'$.attempt_ref')=c.attempt_ref
    AND json_extract(NEW.progress_json,'$.request_sha256')=c.request_sha256
    AND json_extract(NEW.progress_json,'$.lease_id')=NEW.lease_id
    AND json_extract(NEW.progress_json,'$.cursor')=NEW.cursor
    AND json_extract(NEW.progress_json,'$.recorded_at')=NEW.created_at
)
BEGIN SELECT RAISE(ABORT,'EXTERNAL_AGENT_PROGRESS_CONFLICT'); END;

CREATE TRIGGER research_external_agent_progress_no_update
BEFORE UPDATE ON research_external_agent_task_progress
BEGIN SELECT RAISE(ABORT,'EXTERNAL_AGENT_PROGRESS_IMMUTABLE'); END;
CREATE TRIGGER research_external_agent_progress_no_delete
BEFORE DELETE ON research_external_agent_task_progress
BEGIN SELECT RAISE(ABORT,'EXTERNAL_AGENT_PROGRESS_IMMUTABLE'); END;

INSERT INTO schema_state(key,value,updated_at)
VALUES('external_agent_task_generation','external-agent-task-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
