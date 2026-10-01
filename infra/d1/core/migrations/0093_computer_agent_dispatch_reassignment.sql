-- Explicit owner reassignment from one terminal, unaccepted dispatch to one fresh dispatch.
-- The frozen Research request is reused by digest; actor, grant, qualification, dispatch and lease identities are never transferred.
PRAGMA foreign_keys = ON;

CREATE TABLE computer_agent_dispatch_reassignment (
  predecessor_dispatch_id TEXT PRIMARY KEY REFERENCES computer_agent_dispatch(dispatch_id),
  successor_dispatch_id TEXT NOT NULL UNIQUE REFERENCES computer_agent_dispatch(dispatch_id),
  project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 256),
  owner_principal_ref TEXT NOT NULL CHECK(length(owner_principal_ref) BETWEEN 1 AND 256),
  owner_credential_generation TEXT NOT NULL CHECK(length(owner_credential_generation) BETWEEN 1 AND 256),
  predecessor_state TEXT NOT NULL CHECK(predecessor_state IN ('ABANDONED','DECLINED')),
  run_request_sha256 TEXT NOT NULL
    CHECK(length(run_request_sha256)=64 AND run_request_sha256 NOT GLOB '*[^0-9a-f]*'),
  successor_transport TEXT NOT NULL CHECK(successor_transport IN ('MCP_WRITE','WEB_INBOX')),
  successor_route_revision INTEGER NOT NULL CHECK(successor_route_revision BETWEEN 1 AND 2147483647),
  successor_connection_id TEXT NOT NULL CHECK(length(successor_connection_id) BETWEEN 1 AND 256),
  successor_connection_revision INTEGER NOT NULL CHECK(successor_connection_revision BETWEEN 1 AND 2147483647),
  successor_client_grant_id TEXT NOT NULL CHECK(length(successor_client_grant_id) BETWEEN 1 AND 256),
  successor_client_grant_revision INTEGER NOT NULL CHECK(successor_client_grant_revision BETWEEN 1 AND 2147483647),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  request_sha256 TEXT NOT NULL
    CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  record_json TEXT NOT NULL
    CHECK(json_valid(record_json) AND length(CAST(record_json AS BLOB)) BETWEEN 1 AND 49152),
  record_sha256 TEXT NOT NULL
    CHECK(length(record_sha256)=64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'),
  reassigned_at TEXT NOT NULL CHECK(julianday(reassigned_at) IS NOT NULL),
  UNIQUE(owner_principal_ref,idempotency_key),
  CHECK(predecessor_dispatch_id<>successor_dispatch_id),
  CHECK(json_extract(record_json,'$.protocol') IS 'eliotr.computer-agent-dispatch-reassigned.v1'),
  CHECK(json_extract(record_json,'$.predecessor_dispatch_id') IS predecessor_dispatch_id),
  CHECK(json_extract(record_json,'$.successor_dispatch_id') IS successor_dispatch_id),
  CHECK(json_extract(record_json,'$.project_id') IS project_id),
  CHECK(json_extract(record_json,'$.owner_principal_ref') IS owner_principal_ref),
  CHECK(json_extract(record_json,'$.owner_credential_generation') IS owner_credential_generation),
  CHECK(json_extract(record_json,'$.predecessor_state') IS predecessor_state),
  CHECK(json_extract(record_json,'$.run_request_sha256') IS run_request_sha256),
  CHECK(json_extract(record_json,'$.successor_transport') IS successor_transport),
  CHECK(json_extract(record_json,'$.successor_route_revision') IS successor_route_revision),
  CHECK(json_extract(record_json,'$.successor_connection_id') IS successor_connection_id),
  CHECK(json_extract(record_json,'$.successor_connection_revision') IS successor_connection_revision),
  CHECK(json_extract(record_json,'$.successor_client_grant_id') IS successor_client_grant_id),
  CHECK(json_extract(record_json,'$.successor_client_grant_revision') IS successor_client_grant_revision),
  CHECK(json_extract(record_json,'$.idempotency_key') IS idempotency_key),
  CHECK(json_extract(record_json,'$.request_sha256') IS request_sha256),
  CHECK(json_extract(record_json,'$.reassigned_at') IS reassigned_at)
) STRICT;

CREATE INDEX computer_agent_dispatch_reassignment_owner_idx
  ON computer_agent_dispatch_reassignment(
    owner_principal_ref,reassigned_at DESC,predecessor_dispatch_id DESC
  );

CREATE TRIGGER computer_agent_dispatch_reassignment_insert_guard
BEFORE INSERT ON computer_agent_dispatch_reassignment
WHEN NOT EXISTS (
  SELECT 1
  FROM computer_agent_dispatch p
  JOIN computer_agent_dispatch s ON s.dispatch_id=NEW.successor_dispatch_id
  JOIN project_owner o ON o.project_id=p.project_id AND o.principal_ref=p.owner_principal_ref
  LEFT JOIN computer_agent_dispatch_acceptance pa ON pa.dispatch_id=p.dispatch_id
  LEFT JOIN computer_agent_dispatch_abandonment px ON px.dispatch_id=p.dispatch_id
  LEFT JOIN computer_agent_dispatch_decline pd ON pd.dispatch_id=p.dispatch_id
  LEFT JOIN computer_agent_dispatch_acceptance sa ON sa.dispatch_id=s.dispatch_id
  LEFT JOIN computer_agent_dispatch_abandonment sx ON sx.dispatch_id=s.dispatch_id
  LEFT JOIN computer_agent_dispatch_decline sd ON sd.dispatch_id=s.dispatch_id
  WHERE p.dispatch_id=NEW.predecessor_dispatch_id
    AND p.project_id=NEW.project_id AND s.project_id=NEW.project_id
    AND p.owner_principal_ref=NEW.owner_principal_ref
    AND s.owner_principal_ref=NEW.owner_principal_ref
    AND s.owner_credential_generation=NEW.owner_credential_generation
    AND p.run_request_sha256=NEW.run_request_sha256
    AND s.run_request_sha256=NEW.run_request_sha256
    AND s.transport=NEW.successor_transport
    AND s.route_revision=NEW.successor_route_revision
    AND s.connection_id=NEW.successor_connection_id
    AND s.connection_revision=NEW.successor_connection_revision
    AND s.client_grant_id=NEW.successor_client_grant_id
    AND s.client_grant_revision=NEW.successor_client_grant_revision
    AND pa.dispatch_id IS NULL
    AND sa.dispatch_id IS NULL AND sx.dispatch_id IS NULL AND sd.dispatch_id IS NULL
    AND (
      (NEW.predecessor_state='ABANDONED' AND px.dispatch_id IS NOT NULL AND pd.dispatch_id IS NULL
        AND julianday(NEW.reassigned_at)>=julianday(px.abandoned_at))
      OR
      (NEW.predecessor_state='DECLINED' AND pd.dispatch_id IS NOT NULL AND px.dispatch_id IS NULL
        AND julianday(NEW.reassigned_at)>=julianday(pd.declined_at))
    )
    AND julianday(s.created_at)>=julianday(p.created_at)
    AND julianday(NEW.reassigned_at)>=julianday(s.created_at)
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_DISPATCH_REASSIGNMENT_INVALID'); END;

CREATE TRIGGER computer_agent_dispatch_reassignment_no_update
BEFORE UPDATE ON computer_agent_dispatch_reassignment
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_DISPATCH_REASSIGNMENT_IMMUTABLE'); END;
CREATE TRIGGER computer_agent_dispatch_reassignment_no_delete
BEFORE DELETE ON computer_agent_dispatch_reassignment
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_DISPATCH_REASSIGNMENT_IMMUTABLE'); END;

INSERT INTO schema_state(key,value,updated_at)
VALUES('computer_agent_dispatch_reassignment_generation',
  'computer-agent-dispatch-reassignment-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
