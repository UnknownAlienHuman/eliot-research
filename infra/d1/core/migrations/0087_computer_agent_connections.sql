-- Owner-controlled, append-only computer-agent connection registry.
-- Vendor contour is metadata. Exact Access issuer/subject is the stable actor identity.
PRAGMA foreign_keys = ON;

CREATE TABLE computer_agent_connection (
  connection_id TEXT NOT NULL CHECK(length(connection_id) BETWEEN 1 AND 256),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
  owner_principal_ref TEXT NOT NULL CHECK(length(owner_principal_ref) BETWEEN 1 AND 256),
  actor_issuer TEXT NOT NULL CHECK(length(actor_issuer) BETWEEN 1 AND 256),
  actor_method TEXT NOT NULL CHECK(actor_method='service_token'),
  actor_subject TEXT NOT NULL CHECK(length(actor_subject) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK(state IN ('ENABLED','DISABLED')),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 128),
  contour TEXT NOT NULL CHECK(contour IN ('GEMINI_SPARK','META_MUSE','OPENAI_DOT','OTHER')),
  transport_capabilities_json TEXT NOT NULL CHECK(
    json_valid(transport_capabilities_json) AND json_type(transport_capabilities_json)='array'
    AND json_array_length(transport_capabilities_json) BETWEEN 1 AND 8
  ),
  computer_capabilities_json TEXT NOT NULL CHECK(
    json_valid(computer_capabilities_json) AND json_type(computer_capabilities_json)='array'
    AND json_array_length(computer_capabilities_json) BETWEEN 0 AND 16
  ),
  task_kinds_json TEXT NOT NULL CHECK(
    json_valid(task_kinds_json) AND json_type(task_kinds_json)='array'
    AND json_array_length(task_kinds_json) BETWEEN 1 AND 8
  ),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  record_json TEXT NOT NULL CHECK(json_valid(record_json) AND length(CAST(record_json AS BLOB)) BETWEEN 1 AND 24576),
  record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK(julianday(updated_at) IS NOT NULL),
  PRIMARY KEY(connection_id,revision),
  UNIQUE(owner_principal_ref,idempotency_key),
  CHECK(json_extract(record_json,'$.protocol') IS 'eliotr.computer-agent-connection.v1'),
  CHECK(json_extract(record_json,'$.connection_id') IS connection_id),
  CHECK(json_extract(record_json,'$.revision') IS revision),
  CHECK(json_extract(record_json,'$.owner_principal_ref') IS owner_principal_ref),
  CHECK(json_extract(record_json,'$.actor.issuer') IS actor_issuer),
  CHECK(json_extract(record_json,'$.actor.authentication_method') IS actor_method),
  CHECK(json_extract(record_json,'$.actor.subject') IS actor_subject),
  CHECK(json_extract(record_json,'$.state') IS state),
  CHECK(json_extract(record_json,'$.display_name') IS display_name),
  CHECK(json_extract(record_json,'$.contour') IS contour),
  CHECK(json_extract(record_json,'$.transport_capabilities') IS json(transport_capabilities_json)),
  CHECK(json_extract(record_json,'$.computer_capabilities') IS json(computer_capabilities_json)),
  CHECK(json_extract(record_json,'$.task_kinds') IS json(task_kinds_json)),
  CHECK(json_extract(record_json,'$.created_at') IS created_at),
  CHECK(json_extract(record_json,'$.updated_at') IS updated_at),
  CHECK(julianday(updated_at)>=julianday(created_at))
) STRICT;

CREATE INDEX computer_agent_connection_owner_idx
  ON computer_agent_connection(owner_principal_ref,connection_id,revision DESC);
CREATE INDEX computer_agent_connection_actor_idx
  ON computer_agent_connection(actor_issuer,actor_subject,revision DESC);
CREATE VIEW computer_agent_connection_current AS
SELECT c.* FROM computer_agent_connection c
WHERE NOT EXISTS (
  SELECT 1 FROM computer_agent_connection n
  WHERE n.connection_id=c.connection_id AND n.revision>c.revision
);

CREATE TRIGGER computer_agent_connection_insert_guard
BEFORE INSERT ON computer_agent_connection
BEGIN
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_REVISION_CONFLICT')
  WHERE NEW.revision<>COALESCE((SELECT MAX(revision) FROM computer_agent_connection
    WHERE connection_id=NEW.connection_id),0)+1;
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_IDENTITY_CONFLICT') WHERE EXISTS (
    SELECT 1 FROM computer_agent_connection c WHERE c.connection_id=NEW.connection_id AND (
      c.owner_principal_ref IS NOT NEW.owner_principal_ref OR c.actor_issuer IS NOT NEW.actor_issuer
      OR c.actor_method IS NOT NEW.actor_method OR c.actor_subject IS NOT NEW.actor_subject
      OR c.created_at IS NOT NEW.created_at
    )
  );
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_IDENTITY_CONFLICT') WHERE EXISTS (
    SELECT 1 FROM computer_agent_connection c
    WHERE c.actor_issuer=NEW.actor_issuer AND c.actor_subject=NEW.actor_subject
      AND c.connection_id<>NEW.connection_id
  );
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_INITIAL_STATE_INVALID')
  WHERE NEW.revision=1 AND NEW.state<>'ENABLED';
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_TIME_INVALID') WHERE EXISTS (
    SELECT 1 FROM computer_agent_connection c
    WHERE c.connection_id=NEW.connection_id AND c.revision=NEW.revision-1
      AND julianday(c.updated_at)>julianday(NEW.updated_at)
  );
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_TRANSPORT_INVALID') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.transport_capabilities_json)
    WHERE type<>'text' OR value NOT IN ('MCP_READ','MCP_WRITE','WEB_INBOX')
  );
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_TRANSPORT_INVALID') WHERE
    (SELECT COUNT(DISTINCT value) FROM json_each(NEW.transport_capabilities_json))
      <>json_array_length(NEW.transport_capabilities_json);
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_CAPABILITY_INVALID') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.computer_capabilities_json)
    WHERE type<>'text' OR value NOT IN (
      'CLOUD_BROWSER','CLOUD_DESKTOP','CLOUD_NETWORK','LOCAL_COMPUTER','LOCAL_FILES','LOCAL_SHELL',
      'PYTHON_VM','CONNECTED_APPS','SCHEDULED_WORK','PROACTIVE_WORK','MESSAGING','SCREENSHOTS'
    )
  );
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_CAPABILITY_INVALID') WHERE
    (SELECT COUNT(DISTINCT value) FROM json_each(NEW.computer_capabilities_json))
      <>json_array_length(NEW.computer_capabilities_json);
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_TASK_INVALID') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.task_kinds_json)
    WHERE type<>'text' OR value<>'RESEARCH_BRANCH_ANALYSIS'
  );
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_TASK_INVALID') WHERE
    (SELECT COUNT(DISTINCT value) FROM json_each(NEW.task_kinds_json))
      <>json_array_length(NEW.task_kinds_json);
  SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_WRITE_TRANSPORT_REQUIRED')
  WHERE NOT EXISTS (
    SELECT 1 FROM json_each(NEW.transport_capabilities_json)
    WHERE value IN ('MCP_WRITE','WEB_INBOX')
  );
END;

CREATE TRIGGER computer_agent_connection_no_update
BEFORE UPDATE ON computer_agent_connection
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_IMMUTABLE'); END;
CREATE TRIGGER computer_agent_connection_no_delete
BEFORE DELETE ON computer_agent_connection
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_CONNECTION_IMMUTABLE'); END;

INSERT INTO schema_state(key,value,updated_at)
VALUES('computer_agent_connection_generation','computer-agent-connection-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
