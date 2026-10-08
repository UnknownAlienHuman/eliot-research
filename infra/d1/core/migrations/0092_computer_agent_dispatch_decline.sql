-- Exact target-actor decline of an unaccepted computer-agent dispatch.
-- Decline closes one offer. It never selects a replacement or transfers work, leases or credentials.
PRAGMA foreign_keys = ON;

CREATE TABLE computer_agent_dispatch_decline (
  dispatch_id TEXT PRIMARY KEY REFERENCES computer_agent_dispatch(dispatch_id),
  project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 256),
  connection_id TEXT NOT NULL CHECK(length(connection_id) BETWEEN 1 AND 256),
  connection_revision INTEGER NOT NULL CHECK(connection_revision BETWEEN 1 AND 2147483647),
  actor_issuer TEXT NOT NULL CHECK(length(actor_issuer) BETWEEN 1 AND 256),
  actor_subject TEXT NOT NULL CHECK(length(actor_subject) BETWEEN 1 AND 256),
  credential_generation TEXT NOT NULL CHECK(length(credential_generation) BETWEEN 1 AND 256),
  reason TEXT NOT NULL CHECK(reason IN (
    'UNAVAILABLE','UNSUPPORTED_TASK','INSUFFICIENT_CONTEXT',
    'LOCAL_POLICY','TRANSIENT_FAILURE','OTHER'
  )),
  note TEXT CHECK(note IS NULL OR length(note) BETWEEN 1 AND 2048),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  request_sha256 TEXT NOT NULL
    CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  record_json TEXT NOT NULL
    CHECK(json_valid(record_json) AND length(CAST(record_json AS BLOB)) BETWEEN 1 AND 32768),
  record_sha256 TEXT NOT NULL
    CHECK(length(record_sha256)=64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'),
  declined_at TEXT NOT NULL CHECK(julianday(declined_at) IS NOT NULL),
  UNIQUE(actor_issuer,actor_subject,idempotency_key),
  CHECK(reason<>'OTHER' OR note IS NOT NULL),
  CHECK(json_extract(record_json,'$.protocol') IS 'eliotr.computer-agent-dispatch-declined.v1'),
  CHECK(json_extract(record_json,'$.dispatch_id') IS dispatch_id),
  CHECK(json_extract(record_json,'$.project_id') IS project_id),
  CHECK(json_extract(record_json,'$.connection_id') IS connection_id),
  CHECK(json_extract(record_json,'$.connection_revision') IS connection_revision),
  CHECK(json_extract(record_json,'$.actor.issuer') IS actor_issuer),
  CHECK(json_extract(record_json,'$.actor.authentication_method') IS 'service_token'),
  CHECK(json_extract(record_json,'$.actor.subject') IS actor_subject),
  CHECK(json_extract(record_json,'$.credential_generation') IS credential_generation),
  CHECK(json_extract(record_json,'$.reason') IS reason),
  CHECK((note IS NULL AND json_type(record_json,'$.note') IS NULL)
    OR json_extract(record_json,'$.note') IS note),
  CHECK(json_extract(record_json,'$.idempotency_key') IS idempotency_key),
  CHECK(json_extract(record_json,'$.request_sha256') IS request_sha256),
  CHECK(json_extract(record_json,'$.declined_at') IS declined_at)
) STRICT;

CREATE INDEX computer_agent_dispatch_decline_actor_idx
  ON computer_agent_dispatch_decline(
    actor_issuer,actor_subject,declined_at DESC,dispatch_id DESC
  );

CREATE TRIGGER computer_agent_dispatch_decline_insert_guard
BEFORE INSERT ON computer_agent_dispatch_decline
WHEN NOT EXISTS (
  SELECT 1
  FROM computer_agent_dispatch d
  LEFT JOIN computer_agent_dispatch_acceptance a ON a.dispatch_id=d.dispatch_id
  LEFT JOIN computer_agent_dispatch_abandonment x ON x.dispatch_id=d.dispatch_id
  WHERE d.dispatch_id=NEW.dispatch_id
    AND d.project_id=NEW.project_id
    AND d.connection_id=NEW.connection_id
    AND d.connection_revision=NEW.connection_revision
    AND d.actor_issuer=NEW.actor_issuer
    AND d.actor_subject=NEW.actor_subject
    AND d.qualification_credential_generation=NEW.credential_generation
    AND a.dispatch_id IS NULL
    AND x.dispatch_id IS NULL
    AND julianday(NEW.declined_at)>=julianday(d.created_at)
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_DISPATCH_DECLINE_INVALID'); END;

CREATE TRIGGER computer_agent_dispatch_decline_no_update
BEFORE UPDATE ON computer_agent_dispatch_decline
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_DISPATCH_DECLINE_IMMUTABLE'); END;
CREATE TRIGGER computer_agent_dispatch_decline_no_delete
BEFORE DELETE ON computer_agent_dispatch_decline
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_DISPATCH_DECLINE_IMMUTABLE'); END;

-- SQLite serializes writers; whichever immutable terminal record wins first excludes the others.
CREATE TRIGGER computer_agent_dispatch_acceptance_decline_guard
BEFORE INSERT ON computer_agent_dispatch_acceptance
WHEN EXISTS (
  SELECT 1 FROM computer_agent_dispatch_decline x
  WHERE x.dispatch_id=NEW.dispatch_id
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_DISPATCH_DECLINED'); END;

CREATE TRIGGER computer_agent_dispatch_abandonment_decline_guard
BEFORE INSERT ON computer_agent_dispatch_abandonment
WHEN EXISTS (
  SELECT 1 FROM computer_agent_dispatch_decline x
  WHERE x.dispatch_id=NEW.dispatch_id
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_DISPATCH_DECLINED'); END;

CREATE VIEW computer_agent_dispatch_offer_claimable AS
SELECT o.*
FROM computer_agent_dispatch_offer_actionable o
LEFT JOIN computer_agent_dispatch_decline x ON x.dispatch_id=o.dispatch_id
WHERE x.dispatch_id IS NULL;

INSERT INTO schema_state(key,value,updated_at)
VALUES('computer_agent_dispatch_decline_generation',
  'computer-agent-dispatch-decline-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
