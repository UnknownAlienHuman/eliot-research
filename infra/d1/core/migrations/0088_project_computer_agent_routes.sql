-- Owner-selected project routing for computer agents. ORIGINATING_MATCH records priority
-- without reassigning an existing grant, task or lease to another actor.
PRAGMA foreign_keys = ON;

CREATE TABLE project_computer_agent_route (
  project_id TEXT NOT NULL REFERENCES project(project_id),
  task_kind TEXT NOT NULL CHECK(task_kind='RESEARCH_BRANCH_ANALYSIS'),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
  owner_principal_ref TEXT NOT NULL CHECK(length(owner_principal_ref) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','DISABLED')),
  strategy TEXT NOT NULL CHECK(strategy='ORIGINATING_MATCH'),
  connection_order_json TEXT NOT NULL CHECK(
    json_valid(connection_order_json) AND json_type(connection_order_json)='array'
    AND json_array_length(connection_order_json) BETWEEN 1 AND 16
  ),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  record_json TEXT NOT NULL CHECK(json_valid(record_json) AND length(CAST(record_json AS BLOB)) BETWEEN 1 AND 24576),
  record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK(julianday(updated_at) IS NOT NULL),
  PRIMARY KEY(project_id,task_kind,revision),
  UNIQUE(owner_principal_ref,idempotency_key),
  CHECK(json_extract(record_json,'$.protocol') IS 'eliotr.project-computer-agent-route.v1'),
  CHECK(json_extract(record_json,'$.project_id') IS project_id),
  CHECK(json_extract(record_json,'$.task_kind') IS task_kind),
  CHECK(json_extract(record_json,'$.revision') IS revision),
  CHECK(json_extract(record_json,'$.owner_principal_ref') IS owner_principal_ref),
  CHECK(json_extract(record_json,'$.state') IS state),
  CHECK(json_extract(record_json,'$.strategy') IS strategy),
  CHECK(json_extract(record_json,'$.connections') IS json(connection_order_json)),
  CHECK(json_extract(record_json,'$.created_at') IS created_at),
  CHECK(json_extract(record_json,'$.updated_at') IS updated_at),
  CHECK(julianday(updated_at)>=julianday(created_at))
) STRICT;

CREATE TABLE project_computer_agent_route_entry (
  project_id TEXT NOT NULL,
  task_kind TEXT NOT NULL,
  route_revision INTEGER NOT NULL,
  priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 15),
  connection_id TEXT NOT NULL,
  connection_revision INTEGER NOT NULL,
  PRIMARY KEY(project_id,task_kind,route_revision,priority),
  UNIQUE(project_id,task_kind,route_revision,connection_id),
  UNIQUE(project_id,task_kind,route_revision,priority,connection_id,connection_revision),
  FOREIGN KEY(project_id,task_kind,route_revision)
    REFERENCES project_computer_agent_route(project_id,task_kind,revision),
  FOREIGN KEY(connection_id,connection_revision)
    REFERENCES computer_agent_connection(connection_id,revision)
) STRICT;

CREATE INDEX project_computer_agent_route_owner_idx
  ON project_computer_agent_route(owner_principal_ref,project_id,task_kind,revision DESC);
CREATE INDEX project_computer_agent_route_connection_idx
  ON project_computer_agent_route_entry(connection_id,connection_revision,project_id,task_kind);

CREATE VIEW project_computer_agent_route_current AS
SELECT r.* FROM project_computer_agent_route r
WHERE NOT EXISTS (
  SELECT 1 FROM project_computer_agent_route n
  WHERE n.project_id=r.project_id AND n.task_kind=r.task_kind AND n.revision>r.revision
)
AND (SELECT COUNT(*) FROM project_computer_agent_route_entry e
  WHERE e.project_id=r.project_id AND e.task_kind=r.task_kind AND e.route_revision=r.revision)
  =json_array_length(r.connection_order_json)
AND NOT EXISTS (
  SELECT 1 FROM project_computer_agent_route_entry e
  WHERE e.project_id=r.project_id AND e.task_kind=r.task_kind AND e.route_revision=r.revision
    AND (json_extract(r.connection_order_json,'$['||e.priority||'].connection_id') IS NOT e.connection_id
      OR json_extract(r.connection_order_json,'$['||e.priority||'].connection_revision') IS NOT e.connection_revision)
);

CREATE TRIGGER project_computer_agent_route_insert_guard
BEFORE INSERT ON project_computer_agent_route
BEGIN
  SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_REVISION_CONFLICT')
  WHERE NEW.revision<>COALESCE((SELECT MAX(revision) FROM project_computer_agent_route
    WHERE project_id=NEW.project_id AND task_kind=NEW.task_kind),0)+1;
  SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_OWNER_REQUIRED') WHERE NOT EXISTS (
    SELECT 1 FROM project_owner o
    WHERE o.project_id=NEW.project_id AND o.principal_ref=NEW.owner_principal_ref
  );
  SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_IDENTITY_CONFLICT') WHERE EXISTS (
    SELECT 1 FROM project_computer_agent_route r
    WHERE r.project_id=NEW.project_id AND r.task_kind=NEW.task_kind
      AND (r.owner_principal_ref IS NOT NEW.owner_principal_ref OR r.created_at IS NOT NEW.created_at)
  );
  SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_INITIAL_STATE_INVALID')
  WHERE NEW.revision=1 AND NEW.state<>'ACTIVE';
  SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_TIME_INVALID') WHERE EXISTS (
    SELECT 1 FROM project_computer_agent_route r
    WHERE r.project_id=NEW.project_id AND r.task_kind=NEW.task_kind AND r.revision=NEW.revision-1
      AND julianday(r.updated_at)>julianday(NEW.updated_at)
  );
  SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_CONNECTION_INVALID') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.connection_order_json) e
    WHERE json_type(e.value)<>'object'
      OR json_type(e.value,'$.connection_id')<>'text'
      OR json_type(e.value,'$.connection_revision')<>'integer'
      OR length(json_extract(e.value,'$.connection_id')) NOT BETWEEN 1 AND 256
      OR json_extract(e.value,'$.connection_revision') NOT BETWEEN 1 AND 2147483647
  );
  SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_CONNECTION_INVALID') WHERE
    (SELECT COUNT(DISTINCT json_extract(value,'$.connection_id')) FROM json_each(NEW.connection_order_json))
      <>json_array_length(NEW.connection_order_json);
END;

CREATE TRIGGER project_computer_agent_route_entry_guard
BEFORE INSERT ON project_computer_agent_route_entry
WHEN NOT EXISTS (
  SELECT 1 FROM project_computer_agent_route r
  JOIN computer_agent_connection c
    ON c.connection_id=NEW.connection_id AND c.revision=NEW.connection_revision
  WHERE r.project_id=NEW.project_id AND r.task_kind=NEW.task_kind AND r.revision=NEW.route_revision
    AND c.owner_principal_ref=r.owner_principal_ref AND c.state='ENABLED'
    AND EXISTS (SELECT 1 FROM json_each(c.task_kinds_json) WHERE value=NEW.task_kind)
    AND json_extract(r.connection_order_json,'$['||NEW.priority||'].connection_id')=NEW.connection_id
    AND json_extract(r.connection_order_json,'$['||NEW.priority||'].connection_revision')=NEW.connection_revision
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_CONNECTION_STALE'); END;

CREATE TRIGGER project_computer_agent_route_no_update
BEFORE UPDATE ON project_computer_agent_route
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_IMMUTABLE'); END;
CREATE TRIGGER project_computer_agent_route_no_delete
BEFORE DELETE ON project_computer_agent_route
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_IMMUTABLE'); END;
CREATE TRIGGER project_computer_agent_route_entry_no_update
BEFORE UPDATE ON project_computer_agent_route_entry
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_IMMUTABLE'); END;
CREATE TRIGGER project_computer_agent_route_entry_no_delete
BEFORE DELETE ON project_computer_agent_route_entry
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_IMMUTABLE'); END;

CREATE TABLE research_computer_agent_route_binding (
  operation_id TEXT PRIMARY KEY CHECK(length(operation_id) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL,
  task_kind TEXT NOT NULL,
  route_revision INTEGER NOT NULL,
  priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 15),
  connection_id TEXT NOT NULL,
  connection_revision INTEGER NOT NULL,
  client_grant_id TEXT NOT NULL,
  client_grant_revision INTEGER NOT NULL,
  actor_issuer TEXT NOT NULL CHECK(length(actor_issuer) BETWEEN 1 AND 256),
  actor_subject TEXT NOT NULL CHECK(length(actor_subject) BETWEEN 1 AND 256),
  binding_json TEXT NOT NULL CHECK(json_valid(binding_json) AND length(CAST(binding_json AS BLOB)) BETWEEN 1 AND 24576),
  binding_sha256 TEXT NOT NULL CHECK(length(binding_sha256)=64 AND binding_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  FOREIGN KEY(project_id,task_kind,route_revision,priority,connection_id,connection_revision)
    REFERENCES project_computer_agent_route_entry(project_id,task_kind,route_revision,priority,connection_id,connection_revision),
  FOREIGN KEY(client_grant_id,client_grant_revision)
    REFERENCES project_client_grant(grant_id,revision),
  CHECK(json_extract(binding_json,'$.protocol') IS 'eliotr.research-computer-agent-route-binding.v1'),
  CHECK(json_extract(binding_json,'$.operation_id') IS operation_id),
  CHECK(json_extract(binding_json,'$.project_id') IS project_id),
  CHECK(json_extract(binding_json,'$.task_kind') IS task_kind),
  CHECK(json_extract(binding_json,'$.route_revision') IS route_revision),
  CHECK(json_extract(binding_json,'$.priority') IS priority),
  CHECK(json_extract(binding_json,'$.connection_id') IS connection_id),
  CHECK(json_extract(binding_json,'$.connection_revision') IS connection_revision),
  CHECK(json_extract(binding_json,'$.client_grant_id') IS client_grant_id),
  CHECK(json_extract(binding_json,'$.client_grant_revision') IS client_grant_revision),
  CHECK(json_extract(binding_json,'$.actor.issuer') IS actor_issuer),
  CHECK(json_extract(binding_json,'$.actor.authentication_method') IS 'service_token'),
  CHECK(json_extract(binding_json,'$.actor.subject') IS actor_subject),
  CHECK(json_extract(binding_json,'$.created_at') IS created_at)
) STRICT;

CREATE TRIGGER research_computer_agent_route_binding_guard
BEFORE INSERT ON research_computer_agent_route_binding
WHEN NOT EXISTS (
  SELECT 1 FROM project_computer_agent_route_current r
  JOIN project_computer_agent_route_entry e
    ON e.project_id=r.project_id AND e.task_kind=r.task_kind AND e.route_revision=r.revision
    AND e.priority=NEW.priority AND e.connection_id=NEW.connection_id
    AND e.connection_revision=NEW.connection_revision
  JOIN computer_agent_connection_current c
    ON c.connection_id=e.connection_id AND c.revision=e.connection_revision AND c.state='ENABLED'
  JOIN project_client_grant_current g
    ON g.grant_id=NEW.client_grant_id AND g.revision=NEW.client_grant_revision AND g.state='ACTIVE'
  JOIN project_owner o ON o.project_id=r.project_id AND o.principal_ref=r.owner_principal_ref
  WHERE r.project_id=NEW.project_id AND r.task_kind=NEW.task_kind AND r.revision=NEW.route_revision
    AND r.state='ACTIVE' AND r.strategy='ORIGINATING_MATCH'
    AND c.owner_principal_ref=r.owner_principal_ref
    AND g.project_id=r.project_id AND g.grantor_principal_ref=r.owner_principal_ref
    AND g.grantee_issuer=NEW.actor_issuer AND g.grantee_subject=NEW.actor_subject
    AND g.grantee_method='service_token'
    AND c.actor_issuer=NEW.actor_issuer AND c.actor_subject=NEW.actor_subject
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_AUTHORITY_STALE'); END;

CREATE TRIGGER research_computer_agent_route_binding_no_update
BEFORE UPDATE ON research_computer_agent_route_binding
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_BINDING_IMMUTABLE'); END;
CREATE TRIGGER research_computer_agent_route_binding_no_delete
BEFORE DELETE ON research_computer_agent_route_binding
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_ROUTE_BINDING_IMMUTABLE'); END;

CREATE VIEW research_computer_agent_route_binding_valid AS
SELECT b.* FROM research_computer_agent_route_binding b
JOIN project_computer_agent_route r
  ON r.project_id=b.project_id AND r.task_kind=b.task_kind AND r.revision=b.route_revision
JOIN project_computer_agent_route_entry e
  ON e.project_id=b.project_id AND e.task_kind=b.task_kind AND e.route_revision=b.route_revision
  AND e.priority=b.priority AND e.connection_id=b.connection_id AND e.connection_revision=b.connection_revision
JOIN computer_agent_connection c
  ON c.connection_id=b.connection_id AND c.revision=b.connection_revision
JOIN project_client_grant g
  ON g.grant_id=b.client_grant_id AND g.revision=b.client_grant_revision
JOIN project_owner o ON o.project_id=b.project_id AND o.principal_ref=r.owner_principal_ref
WHERE r.state='ACTIVE' AND r.strategy='ORIGINATING_MATCH' AND c.state='ENABLED'
  AND c.owner_principal_ref=r.owner_principal_ref
  AND c.actor_issuer=b.actor_issuer AND c.actor_subject=b.actor_subject
  AND g.state='ACTIVE' AND g.project_id=b.project_id AND g.grantor_principal_ref=r.owner_principal_ref
  AND g.grantee_method='service_token' AND g.grantee_issuer=b.actor_issuer AND g.grantee_subject=b.actor_subject;

INSERT INTO schema_state(key,value,updated_at)
VALUES('project_computer_agent_route_generation','project-computer-agent-route-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
