-- Owner-authorized FIRST_READY selection. Selection is immutable and precedes exact dispatch creation.
-- A retry reuses the selected connection instead of re-reading a changed readiness order.
PRAGMA foreign_keys = ON;

CREATE TABLE computer_agent_preferred_dispatch_selection (
  selection_id TEXT PRIMARY KEY CHECK(length(selection_id) BETWEEN 1 AND 128),
  project_id TEXT NOT NULL REFERENCES project(project_id),
  task_kind TEXT NOT NULL CHECK(task_kind='RESEARCH_BRANCH_ANALYSIS'),
  selection_strategy TEXT NOT NULL CHECK(selection_strategy='FIRST_READY'),
  transport TEXT NOT NULL CHECK(transport IN ('MCP_WRITE','WEB_INBOX')),
  route_revision INTEGER NOT NULL CHECK(route_revision BETWEEN 1 AND 2147483647),
  priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 15),
  connection_id TEXT NOT NULL,
  connection_revision INTEGER NOT NULL CHECK(connection_revision BETWEEN 1 AND 2147483647),
  client_grant_id TEXT NOT NULL,
  client_grant_revision INTEGER NOT NULL CHECK(client_grant_revision BETWEEN 1 AND 2147483647),
  owner_principal_ref TEXT NOT NULL CHECK(length(owner_principal_ref) BETWEEN 1 AND 256),
  owner_credential_generation TEXT NOT NULL CHECK(length(owner_credential_generation) BETWEEN 1 AND 256),
  qualification_challenge_id TEXT NOT NULL
    REFERENCES computer_agent_connection_qualification_binding(challenge_id),
  qualification_observation_ref TEXT NOT NULL CHECK(length(qualification_observation_ref) BETWEEN 1 AND 256),
  qualification_credential_generation TEXT NOT NULL CHECK(length(qualification_credential_generation) BETWEEN 1 AND 256),
  qualification_ready_until TEXT NOT NULL CHECK(julianday(qualification_ready_until) IS NOT NULL),
  deployment_generation TEXT NOT NULL CHECK(length(deployment_generation) BETWEEN 1 AND 256),
  run_request_sha256 TEXT NOT NULL
    CHECK(length(run_request_sha256)=64 AND run_request_sha256 NOT GLOB '*[^0-9a-f]*'),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  request_sha256 TEXT NOT NULL
    CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  record_json TEXT NOT NULL
    CHECK(json_valid(record_json) AND length(CAST(record_json AS BLOB)) BETWEEN 1 AND 32768),
  record_sha256 TEXT NOT NULL
    CHECK(length(record_sha256)=64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'),
  selected_at TEXT NOT NULL CHECK(julianday(selected_at) IS NOT NULL),
  UNIQUE(owner_principal_ref,idempotency_key),
  FOREIGN KEY(project_id,task_kind,route_revision,priority,connection_id,connection_revision)
    REFERENCES project_computer_agent_route_entry(
      project_id,task_kind,route_revision,priority,connection_id,connection_revision
    ),
  FOREIGN KEY(client_grant_id,client_grant_revision)
    REFERENCES project_client_grant(grant_id,revision),
  CHECK(selection_id='preferred-selection-' || substr(request_sha256,1,48)),
  CHECK(julianday(qualification_ready_until)>julianday(selected_at)),
  CHECK(json_extract(record_json,'$.protocol') IS 'eliotr.computer-agent-preferred-selection.v1'),
  CHECK(json_extract(record_json,'$.selection_id') IS selection_id),
  CHECK(json_extract(record_json,'$.project_id') IS project_id),
  CHECK(json_extract(record_json,'$.task_kind') IS task_kind),
  CHECK(json_extract(record_json,'$.selection_strategy') IS selection_strategy),
  CHECK(json_extract(record_json,'$.transport') IS transport),
  CHECK(json_extract(record_json,'$.route_revision') IS route_revision),
  CHECK(json_extract(record_json,'$.priority') IS priority),
  CHECK(json_extract(record_json,'$.connection_id') IS connection_id),
  CHECK(json_extract(record_json,'$.connection_revision') IS connection_revision),
  CHECK(json_extract(record_json,'$.client_grant_id') IS client_grant_id),
  CHECK(json_extract(record_json,'$.client_grant_revision') IS client_grant_revision),
  CHECK(json_extract(record_json,'$.owner_principal_ref') IS owner_principal_ref),
  CHECK(json_extract(record_json,'$.owner_credential_generation') IS owner_credential_generation),
  CHECK(json_extract(record_json,'$.qualification.challenge_id') IS qualification_challenge_id),
  CHECK(json_extract(record_json,'$.qualification.observation_ref') IS qualification_observation_ref),
  CHECK(json_extract(record_json,'$.qualification.verified_credential_generation')
    IS qualification_credential_generation),
  CHECK(json_extract(record_json,'$.qualification.ready_until') IS qualification_ready_until),
  CHECK(json_extract(record_json,'$.qualification.deployment_generation') IS deployment_generation),
  CHECK(json_extract(record_json,'$.run_request_sha256') IS run_request_sha256),
  CHECK(json_extract(record_json,'$.idempotency_key') IS idempotency_key),
  CHECK(json_extract(record_json,'$.request_sha256') IS request_sha256),
  CHECK(json_extract(record_json,'$.selected_at') IS selected_at)
) STRICT;

CREATE INDEX computer_agent_preferred_selection_project_idx
  ON computer_agent_preferred_dispatch_selection(project_id,task_kind,selected_at,selection_id);

CREATE VIEW computer_agent_preferred_ready_qualification AS
SELECT q.*
FROM computer_agent_connection_qualification_observation q
WHERE q.challenge_id=(
  SELECT q2.challenge_id
  FROM computer_agent_connection_qualification_observation q2
  WHERE q2.connection_id=q.connection_id
    AND q2.connection_revision=q.connection_revision AND q2.transport=q.transport
  ORDER BY q2.issued_at DESC,q2.challenge_id DESC LIMIT 1
)
AND q.challenge_state='CONFIRMED' AND q.auth_profile='service-token'
AND q.connection_state='ENABLED' AND q.current_connection_state='ENABLED'
AND q.current_connection_revision=q.connection_revision
AND q.verified_authentication_method='service_token'
AND q.verified_actor_ref=q.actor_subject;

CREATE TRIGGER computer_agent_preferred_selection_route_guard
BEFORE INSERT ON computer_agent_preferred_dispatch_selection
WHEN NOT EXISTS (
  SELECT 1
  FROM project_computer_agent_route_current r
  JOIN project_computer_agent_route_entry e
    ON e.project_id=r.project_id AND e.task_kind=r.task_kind AND e.route_revision=r.revision
    AND e.priority=NEW.priority AND e.connection_id=NEW.connection_id
    AND e.connection_revision=NEW.connection_revision
  JOIN computer_agent_connection_current c
    ON c.connection_id=e.connection_id AND c.revision=e.connection_revision AND c.state='ENABLED'
  JOIN project_owner o ON o.project_id=r.project_id AND o.principal_ref=r.owner_principal_ref
  WHERE r.project_id=NEW.project_id AND r.task_kind=NEW.task_kind
    AND r.revision=NEW.route_revision AND r.state='ACTIVE'
    AND r.owner_principal_ref=NEW.owner_principal_ref
    AND c.owner_principal_ref=NEW.owner_principal_ref
    AND EXISTS (SELECT 1 FROM json_each(c.task_kinds_json) WHERE value=NEW.task_kind)
    AND EXISTS (SELECT 1 FROM json_each(c.transport_capabilities_json) WHERE value=NEW.transport)
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_PREFERRED_SELECTION_AUTHORITY_STALE'); END;

CREATE TRIGGER computer_agent_preferred_selection_grant_guard
BEFORE INSERT ON computer_agent_preferred_dispatch_selection
WHEN NOT EXISTS (
  SELECT 1
  FROM project_client_grant_current g
  JOIN computer_agent_connection_current c
    ON c.connection_id=NEW.connection_id AND c.revision=NEW.connection_revision
  WHERE g.grant_id=NEW.client_grant_id AND g.revision=NEW.client_grant_revision
    AND g.state='ACTIVE' AND g.project_id=NEW.project_id
    AND g.grantor_principal_ref=NEW.owner_principal_ref
    AND g.grantee_method='service_token'
    AND g.grantee_issuer=c.actor_issuer AND g.grantee_subject=c.actor_subject
    AND json_extract(g.record_json,'$.spend_policy_ref') IS NOT NULL
    AND julianday(g.expires_at)>julianday(NEW.selected_at)
    AND EXISTS (SELECT 1 FROM json_each(g.record_json,'$.allowed_operations') WHERE value='run')
    AND EXISTS (SELECT 1 FROM json_each(g.record_json,'$.allowed_operations') WHERE value='recover')
    AND EXISTS (SELECT 1 FROM json_each(g.record_json,'$.allowed_operations') WHERE value='evidence')
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_PREFERRED_SELECTION_AUTHORITY_STALE'); END;

CREATE TRIGGER computer_agent_preferred_selection_qualification_guard
BEFORE INSERT ON computer_agent_preferred_dispatch_selection
WHEN NOT EXISTS (
  SELECT 1
  FROM computer_agent_preferred_ready_qualification q
  WHERE q.challenge_id=NEW.qualification_challenge_id
    AND q.connection_id=NEW.connection_id
    AND q.connection_revision=NEW.connection_revision
    AND q.transport=NEW.transport
    AND q.owner_principal_ref=NEW.owner_principal_ref
    AND q.observation_ref=NEW.qualification_observation_ref
    AND q.verified_credential_generation=NEW.qualification_credential_generation
    AND q.deployment_generation=NEW.deployment_generation
    AND julianday(q.observed_at)<=julianday(NEW.selected_at)
    AND julianday(NEW.selected_at)<julianday(q.observed_at,'+1 day')
    AND julianday(NEW.selected_at)<julianday(q.verified_expires_at)
    AND julianday(NEW.qualification_ready_until)<=julianday(q.observed_at,'+1 day')
    AND julianday(NEW.qualification_ready_until)<=julianday(q.verified_expires_at)
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_PREFERRED_SELECTION_AUTHORITY_STALE'); END;

CREATE TRIGGER computer_agent_preferred_selection_priority_guard
BEFORE INSERT ON computer_agent_preferred_dispatch_selection
WHEN EXISTS (
  SELECT 1
  FROM project_computer_agent_route_entry pe
  JOIN computer_agent_connection_current pc
    ON pc.connection_id=pe.connection_id AND pc.revision=pe.connection_revision
    AND pc.state='ENABLED'
  JOIN computer_agent_preferred_ready_qualification pq
    ON pq.connection_id=pe.connection_id AND pq.connection_revision=pe.connection_revision
    AND pq.transport=NEW.transport
  WHERE pe.project_id=NEW.project_id AND pe.task_kind=NEW.task_kind
    AND pe.route_revision=NEW.route_revision AND pe.priority<NEW.priority
    AND pc.owner_principal_ref=NEW.owner_principal_ref
    AND EXISTS (SELECT 1 FROM json_each(pc.task_kinds_json) WHERE value=NEW.task_kind)
    AND EXISTS (SELECT 1 FROM json_each(pc.transport_capabilities_json) WHERE value=NEW.transport)
    AND pq.deployment_generation=NEW.deployment_generation
    AND julianday(pq.observed_at)<=julianday(NEW.selected_at)
    AND julianday(NEW.selected_at)<julianday(pq.observed_at,'+1 day')
    AND julianday(NEW.selected_at)<julianday(pq.verified_expires_at)
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_PREFERRED_SELECTION_AUTHORITY_STALE'); END;

CREATE TRIGGER computer_agent_preferred_selection_no_update
BEFORE UPDATE ON computer_agent_preferred_dispatch_selection
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_PREFERRED_SELECTION_IMMUTABLE'); END;
CREATE TRIGGER computer_agent_preferred_selection_no_delete
BEFORE DELETE ON computer_agent_preferred_dispatch_selection
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_PREFERRED_SELECTION_IMMUTABLE'); END;

CREATE TABLE computer_agent_preferred_dispatch_settlement (
  selection_id TEXT PRIMARY KEY
    REFERENCES computer_agent_preferred_dispatch_selection(selection_id),
  dispatch_id TEXT NOT NULL UNIQUE REFERENCES computer_agent_dispatch(dispatch_id),
  record_json TEXT NOT NULL
    CHECK(json_valid(record_json) AND length(CAST(record_json AS BLOB)) BETWEEN 1 AND 8192),
  record_sha256 TEXT NOT NULL
    CHECK(length(record_sha256)=64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'),
  settled_at TEXT NOT NULL CHECK(julianday(settled_at) IS NOT NULL),
  CHECK(json_extract(record_json,'$.protocol')
    IS 'eliotr.computer-agent-preferred-dispatch-settlement.v1'),
  CHECK(json_extract(record_json,'$.selection_id') IS selection_id),
  CHECK(json_extract(record_json,'$.dispatch_id') IS dispatch_id),
  CHECK(json_extract(record_json,'$.settled_at') IS settled_at)
) STRICT;

CREATE TRIGGER computer_agent_preferred_settlement_insert_guard
BEFORE INSERT ON computer_agent_preferred_dispatch_settlement
WHEN NOT EXISTS (
  SELECT 1
  FROM computer_agent_preferred_dispatch_selection s
  JOIN computer_agent_dispatch d ON d.dispatch_id=NEW.dispatch_id
  WHERE s.selection_id=NEW.selection_id
    AND d.project_id=s.project_id AND d.task_kind=s.task_kind AND d.transport=s.transport
    AND d.route_revision=s.route_revision AND d.priority=s.priority
    AND d.connection_id=s.connection_id AND d.connection_revision=s.connection_revision
    AND d.client_grant_id=s.client_grant_id AND d.client_grant_revision=s.client_grant_revision
    AND d.owner_principal_ref=s.owner_principal_ref
    AND d.owner_credential_generation=s.owner_credential_generation
    AND d.qualification_challenge_id=s.qualification_challenge_id
    AND d.qualification_observation_ref=s.qualification_observation_ref
    AND d.qualification_credential_generation=s.qualification_credential_generation
    AND d.deployment_generation=s.deployment_generation
    AND d.run_request_sha256=s.run_request_sha256
    AND julianday(d.created_at)>=julianday(s.selected_at)
    AND julianday(d.expires_at)<=julianday(s.qualification_ready_until)
    AND julianday(NEW.settled_at)>=julianday(d.created_at)
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_PREFERRED_SETTLEMENT_CONFLICT'); END;

CREATE TRIGGER computer_agent_preferred_settlement_no_update
BEFORE UPDATE ON computer_agent_preferred_dispatch_settlement
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_PREFERRED_SETTLEMENT_IMMUTABLE'); END;
CREATE TRIGGER computer_agent_preferred_settlement_no_delete
BEFORE DELETE ON computer_agent_preferred_dispatch_settlement
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_PREFERRED_SETTLEMENT_IMMUTABLE'); END;

INSERT INTO schema_state(key,value,updated_at)
VALUES('computer_agent_preferred_dispatch_generation','computer-agent-preferred-dispatch-v1',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'));
