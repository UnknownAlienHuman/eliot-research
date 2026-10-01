-- Two-phase owner authorization for a new computer-agent Research run.
-- The owner records one exact short-lived intent; only the bound service actor may accept it.
-- No existing task, attempt or lease is reassigned by this protocol.
PRAGMA foreign_keys = ON;

CREATE TABLE computer_agent_dispatch (
  dispatch_id TEXT PRIMARY KEY CHECK(length(dispatch_id) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL REFERENCES project(project_id),
  task_kind TEXT NOT NULL CHECK(task_kind='RESEARCH_BRANCH_ANALYSIS'),
  transport TEXT NOT NULL CHECK(transport IN ('MCP_WRITE','WEB_INBOX')),
  route_revision INTEGER NOT NULL CHECK(route_revision BETWEEN 1 AND 2147483647),
  priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 15),
  connection_id TEXT NOT NULL,
  connection_revision INTEGER NOT NULL CHECK(connection_revision BETWEEN 1 AND 2147483647),
  client_grant_id TEXT NOT NULL,
  client_grant_revision INTEGER NOT NULL CHECK(client_grant_revision BETWEEN 1 AND 2147483647),
  owner_principal_ref TEXT NOT NULL CHECK(length(owner_principal_ref) BETWEEN 1 AND 256),
  owner_credential_generation TEXT NOT NULL CHECK(length(owner_credential_generation) BETWEEN 1 AND 256),
  actor_issuer TEXT NOT NULL CHECK(length(actor_issuer) BETWEEN 1 AND 256),
  actor_subject TEXT NOT NULL CHECK(length(actor_subject) BETWEEN 1 AND 256),
  qualification_challenge_id TEXT NOT NULL
    REFERENCES computer_agent_connection_qualification_binding(challenge_id),
  qualification_observation_ref TEXT NOT NULL CHECK(length(qualification_observation_ref) BETWEEN 1 AND 256),
  qualification_credential_generation TEXT NOT NULL
    CHECK(length(qualification_credential_generation) BETWEEN 1 AND 256),
  deployment_generation TEXT NOT NULL CHECK(length(deployment_generation) BETWEEN 1 AND 256),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  run_request_sha256 TEXT NOT NULL
    CHECK(length(run_request_sha256)=64 AND run_request_sha256 NOT GLOB '*[^0-9a-f]*'),
  record_json TEXT NOT NULL
    CHECK(json_valid(record_json) AND length(CAST(record_json AS BLOB)) BETWEEN 1 AND 294912),
  record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  expires_at TEXT NOT NULL CHECK(julianday(expires_at) IS NOT NULL),
  UNIQUE(owner_principal_ref,idempotency_key),
  FOREIGN KEY(project_id,task_kind,route_revision,priority,connection_id,connection_revision)
    REFERENCES project_computer_agent_route_entry(
      project_id,task_kind,route_revision,priority,connection_id,connection_revision
    ),
  FOREIGN KEY(client_grant_id,client_grant_revision)
    REFERENCES project_client_grant(grant_id,revision),
  CHECK(json_extract(record_json,'$.protocol') IS 'eliotr.computer-agent-dispatch.v1'),
  CHECK(json_extract(record_json,'$.dispatch_id') IS dispatch_id),
  CHECK(json_extract(record_json,'$.project_id') IS project_id),
  CHECK(json_extract(record_json,'$.task_kind') IS task_kind),
  CHECK(json_extract(record_json,'$.transport') IS transport),
  CHECK(json_extract(record_json,'$.route_revision') IS route_revision),
  CHECK(json_extract(record_json,'$.priority') IS priority),
  CHECK(json_extract(record_json,'$.connection_id') IS connection_id),
  CHECK(json_extract(record_json,'$.connection_revision') IS connection_revision),
  CHECK(json_extract(record_json,'$.client_grant_id') IS client_grant_id),
  CHECK(json_extract(record_json,'$.client_grant_revision') IS client_grant_revision),
  CHECK(json_extract(record_json,'$.owner_principal_ref') IS owner_principal_ref),
  CHECK(json_extract(record_json,'$.owner_credential_generation') IS owner_credential_generation),
  CHECK(json_extract(record_json,'$.actor.issuer') IS actor_issuer),
  CHECK(json_extract(record_json,'$.actor.authentication_method') IS 'service_token'),
  CHECK(json_extract(record_json,'$.actor.subject') IS actor_subject),
  CHECK(json_extract(record_json,'$.qualification.challenge_id') IS qualification_challenge_id),
  CHECK(json_extract(record_json,'$.qualification.observation_ref') IS qualification_observation_ref),
  CHECK(json_extract(record_json,'$.qualification.verified_credential_generation')
    IS qualification_credential_generation),
  CHECK(json_extract(record_json,'$.qualification.deployment_generation') IS deployment_generation),
  CHECK(json_extract(record_json,'$.run_request.scope_expression.kind') IS 'PROJECT'),
  CHECK(json_extract(record_json,'$.run_request.scope_expression.project_id') IS project_id),
  CHECK(json_extract(record_json,'$.run_request.request_version') IS 'eliotr.research-run-request.v2'),
  CHECK(json_extract(record_json,'$.run_request_sha256') IS run_request_sha256),
  CHECK(json_extract(record_json,'$.created_at') IS created_at),
  CHECK(json_extract(record_json,'$.expires_at') IS expires_at),
  CHECK(julianday(expires_at)>julianday(created_at)),
  CHECK(julianday(expires_at)<=julianday(created_at,'+1 hour'))
) STRICT;

CREATE INDEX computer_agent_dispatch_owner_idx
  ON computer_agent_dispatch(owner_principal_ref,project_id,created_at DESC,dispatch_id DESC);
CREATE INDEX computer_agent_dispatch_target_idx
  ON computer_agent_dispatch(
    actor_issuer,actor_subject,client_grant_id,client_grant_revision,transport,created_at,dispatch_id
  );

CREATE TRIGGER computer_agent_dispatch_insert_guard
BEFORE INSERT ON computer_agent_dispatch
WHEN NOT EXISTS (
  SELECT 1
  FROM project_computer_agent_route_current r
  JOIN project_computer_agent_route_entry e
    ON e.project_id=r.project_id AND e.task_kind=r.task_kind AND e.route_revision=r.revision
    AND e.priority=NEW.priority AND e.connection_id=NEW.connection_id
    AND e.connection_revision=NEW.connection_revision
  JOIN computer_agent_connection_current c
    ON c.connection_id=e.connection_id AND c.revision=e.connection_revision AND c.state='ENABLED'
  JOIN project_client_grant_current g
    ON g.grant_id=NEW.client_grant_id AND g.revision=NEW.client_grant_revision AND g.state='ACTIVE'
  JOIN project_owner o ON o.project_id=r.project_id AND o.principal_ref=r.owner_principal_ref
  JOIN computer_agent_connection_qualification_observation q
    ON q.challenge_id=NEW.qualification_challenge_id
    AND q.connection_id=NEW.connection_id AND q.connection_revision=NEW.connection_revision
    AND q.transport=NEW.transport
  WHERE r.project_id=NEW.project_id AND r.task_kind=NEW.task_kind
    AND r.revision=NEW.route_revision AND r.state='ACTIVE' AND r.strategy='ORIGINATING_MATCH'
    AND r.owner_principal_ref=NEW.owner_principal_ref
    AND c.owner_principal_ref=NEW.owner_principal_ref
    AND c.actor_issuer=NEW.actor_issuer AND c.actor_subject=NEW.actor_subject
    AND EXISTS (SELECT 1 FROM json_each(c.transport_capabilities_json) WHERE value=NEW.transport)
    AND EXISTS (SELECT 1 FROM json_each(c.task_kinds_json) WHERE value=NEW.task_kind)
    AND g.project_id=NEW.project_id AND g.grantor_principal_ref=NEW.owner_principal_ref
    AND g.grantee_method='service_token' AND g.grantee_issuer=NEW.actor_issuer
    AND g.grantee_subject=NEW.actor_subject
    AND EXISTS (SELECT 1 FROM json_each(g.record_json,'$.allowed_operations') WHERE value='run')
    AND EXISTS (SELECT 1 FROM json_each(g.record_json,'$.allowed_operations') WHERE value='recover')
    AND EXISTS (SELECT 1 FROM json_each(g.record_json,'$.allowed_operations') WHERE value='evidence')
    AND q.owner_principal_ref=NEW.owner_principal_ref
    AND q.deployment_generation=NEW.deployment_generation
    AND q.challenge_state='CONFIRMED' AND q.auth_profile='service-token'
    AND q.observation_ref=NEW.qualification_observation_ref
    AND q.verified_actor_ref=NEW.actor_subject
    AND q.verified_credential_generation=NEW.qualification_credential_generation
    AND q.verified_authentication_method='service_token'
    AND q.actor_issuer=NEW.actor_issuer AND q.actor_subject=NEW.actor_subject
    AND q.current_connection_revision=NEW.connection_revision
    AND q.current_connection_state='ENABLED'
    AND q.observed_at IS NOT NULL AND q.verified_expires_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM computer_agent_connection_qualification_binding n
      WHERE n.connection_id=q.connection_id AND n.connection_revision=q.connection_revision
        AND n.transport=q.transport
        AND (julianday(n.issued_at)>julianday(q.issued_at)
          OR (n.issued_at=q.issued_at AND n.challenge_id>q.challenge_id))
    )
    AND julianday(NEW.expires_at)>julianday('now')
    AND julianday(NEW.expires_at)<=julianday(g.expires_at)
    AND julianday(NEW.expires_at)<=julianday(q.observed_at,'+1 day')
    AND julianday(NEW.expires_at)<=julianday(q.verified_expires_at)
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_DISPATCH_AUTHORITY_STALE'); END;

CREATE TRIGGER computer_agent_dispatch_no_update
BEFORE UPDATE ON computer_agent_dispatch
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_DISPATCH_IMMUTABLE'); END;
CREATE TRIGGER computer_agent_dispatch_no_delete
BEFORE DELETE ON computer_agent_dispatch
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_DISPATCH_IMMUTABLE'); END;

CREATE TABLE computer_agent_dispatch_acceptance (
  dispatch_id TEXT PRIMARY KEY REFERENCES computer_agent_dispatch(dispatch_id),
  workflow_instance_id TEXT NOT NULL UNIQUE REFERENCES research_workflow_run(operation_id)
    CHECK(length(workflow_instance_id) BETWEEN 1 AND 128),
  investigation_id TEXT NOT NULL CHECK(length(investigation_id) BETWEEN 1 AND 128),
  investigation_revision INTEGER NOT NULL CHECK(investigation_revision BETWEEN 1 AND 2147483647),
  actor_issuer TEXT NOT NULL CHECK(length(actor_issuer) BETWEEN 1 AND 256),
  actor_subject TEXT NOT NULL CHECK(length(actor_subject) BETWEEN 1 AND 256),
  credential_generation TEXT NOT NULL CHECK(length(credential_generation) BETWEEN 1 AND 256),
  record_json TEXT NOT NULL
    CHECK(json_valid(record_json) AND length(CAST(record_json AS BLOB)) BETWEEN 1 AND 24576),
  record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'),
  accepted_at TEXT NOT NULL CHECK(julianday(accepted_at) IS NOT NULL),
  CHECK(json_extract(record_json,'$.protocol') IS 'eliotr.computer-agent-dispatch-accepted.v1'),
  CHECK(json_extract(record_json,'$.dispatch_id') IS dispatch_id),
  CHECK(json_extract(record_json,'$.workflow_instance_id') IS workflow_instance_id),
  CHECK(json_extract(record_json,'$.investigation_ref.id') IS investigation_id),
  CHECK(json_extract(record_json,'$.investigation_ref.revision') IS investigation_revision),
  CHECK(json_extract(record_json,'$.actor.issuer') IS actor_issuer),
  CHECK(json_extract(record_json,'$.actor.authentication_method') IS 'service_token'),
  CHECK(json_extract(record_json,'$.actor.subject') IS actor_subject),
  CHECK(json_extract(record_json,'$.credential_generation') IS credential_generation),
  CHECK(json_extract(record_json,'$.accepted_at') IS accepted_at)
) STRICT;

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
    AND w.handler_generation='research-handlers.exploratory.v8'
    AND b.project_id=d.project_id AND b.task_kind=d.task_kind
    AND b.route_revision=d.route_revision AND b.priority=d.priority
    AND b.connection_id=d.connection_id AND b.connection_revision=d.connection_revision
    AND b.client_grant_id=d.client_grant_id AND b.client_grant_revision=d.client_grant_revision
    AND b.actor_issuer=d.actor_issuer AND b.actor_subject=d.actor_subject
    AND julianday(NEW.accepted_at)>=julianday(d.created_at)
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_DISPATCH_ACCEPTANCE_INVALID'); END;

CREATE TRIGGER computer_agent_dispatch_acceptance_no_update
BEFORE UPDATE ON computer_agent_dispatch_acceptance
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_DISPATCH_ACCEPTANCE_IMMUTABLE'); END;
CREATE TRIGGER computer_agent_dispatch_acceptance_no_delete
BEFORE DELETE ON computer_agent_dispatch_acceptance
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_DISPATCH_ACCEPTANCE_IMMUTABLE'); END;

CREATE VIEW computer_agent_dispatch_offer_current AS
SELECT d.*
FROM computer_agent_dispatch d
JOIN project_computer_agent_route_current r
  ON r.project_id=d.project_id AND r.task_kind=d.task_kind AND r.revision=d.route_revision
JOIN project_computer_agent_route_entry e
  ON e.project_id=d.project_id AND e.task_kind=d.task_kind AND e.route_revision=d.route_revision
  AND e.priority=d.priority AND e.connection_id=d.connection_id
  AND e.connection_revision=d.connection_revision
JOIN computer_agent_connection_current c
  ON c.connection_id=d.connection_id AND c.revision=d.connection_revision AND c.state='ENABLED'
JOIN project_client_grant_current g
  ON g.grant_id=d.client_grant_id AND g.revision=d.client_grant_revision AND g.state='ACTIVE'
JOIN project_owner o ON o.project_id=d.project_id AND o.principal_ref=d.owner_principal_ref
JOIN computer_agent_connection_qualification_observation q
  ON q.challenge_id=d.qualification_challenge_id
  AND q.connection_id=d.connection_id AND q.connection_revision=d.connection_revision
  AND q.transport=d.transport
LEFT JOIN computer_agent_dispatch_acceptance a ON a.dispatch_id=d.dispatch_id
WHERE a.dispatch_id IS NULL
  AND r.state='ACTIVE' AND r.strategy='ORIGINATING_MATCH'
  AND r.owner_principal_ref=d.owner_principal_ref
  AND c.owner_principal_ref=d.owner_principal_ref
  AND c.actor_issuer=d.actor_issuer AND c.actor_subject=d.actor_subject
  AND EXISTS (SELECT 1 FROM json_each(c.transport_capabilities_json) WHERE value=d.transport)
  AND EXISTS (SELECT 1 FROM json_each(c.task_kinds_json) WHERE value=d.task_kind)
  AND g.project_id=d.project_id AND g.grantor_principal_ref=d.owner_principal_ref
  AND g.grantee_method='service_token' AND g.grantee_issuer=d.actor_issuer
  AND g.grantee_subject=d.actor_subject
  AND EXISTS (SELECT 1 FROM json_each(g.record_json,'$.allowed_operations') WHERE value='run')
  AND EXISTS (SELECT 1 FROM json_each(g.record_json,'$.allowed_operations') WHERE value='recover')
  AND EXISTS (SELECT 1 FROM json_each(g.record_json,'$.allowed_operations') WHERE value='evidence')
  AND q.owner_principal_ref=d.owner_principal_ref
  AND q.deployment_generation=d.deployment_generation
  AND q.challenge_state='CONFIRMED' AND q.auth_profile='service-token'
  AND q.observation_ref=d.qualification_observation_ref
  AND q.verified_actor_ref=d.actor_subject
  AND q.verified_credential_generation=d.qualification_credential_generation
  AND q.verified_authentication_method='service_token'
  AND q.actor_issuer=d.actor_issuer AND q.actor_subject=d.actor_subject
  AND q.current_connection_revision=d.connection_revision
  AND q.current_connection_state='ENABLED'
  AND q.observed_at IS NOT NULL AND q.verified_expires_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM computer_agent_connection_qualification_binding n
    WHERE n.connection_id=q.connection_id AND n.connection_revision=q.connection_revision
      AND n.transport=q.transport
      AND (julianday(n.issued_at)>julianday(q.issued_at)
        OR (n.issued_at=q.issued_at AND n.challenge_id>q.challenge_id))
  )
  AND julianday(d.expires_at)>julianday('now')
  AND julianday(d.expires_at)<=julianday(g.expires_at)
  AND julianday(d.expires_at)<=julianday(q.observed_at,'+1 day')
  AND julianday(d.expires_at)<=julianday(q.verified_expires_at);

INSERT INTO schema_state(key,value,updated_at)
VALUES('computer_agent_dispatch_generation','computer-agent-dispatch-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
