-- Explicit owner abandonment of an unaccepted computer-agent dispatch.
-- Abandonment closes one exact offer; it never creates a replacement or transfers a task/lease.
PRAGMA foreign_keys = ON;

CREATE TABLE computer_agent_dispatch_abandonment (
  dispatch_id TEXT PRIMARY KEY REFERENCES computer_agent_dispatch(dispatch_id),
  project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 256),
  owner_principal_ref TEXT NOT NULL CHECK(length(owner_principal_ref) BETWEEN 1 AND 256),
  owner_credential_generation TEXT NOT NULL CHECK(length(owner_credential_generation) BETWEEN 1 AND 256),
  reason TEXT NOT NULL CHECK(reason IN (
    'TARGET_UNAVAILABLE','QUALIFICATION_EXPIRED','ROUTE_CHANGED',
    'OWNER_REASSIGNMENT','OWNER_CANCELLED','OTHER'
  )),
  note TEXT CHECK(note IS NULL OR length(note) BETWEEN 1 AND 2048),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  request_sha256 TEXT NOT NULL
    CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  record_json TEXT NOT NULL
    CHECK(json_valid(record_json) AND length(CAST(record_json AS BLOB)) BETWEEN 1 AND 32768),
  record_sha256 TEXT NOT NULL
    CHECK(length(record_sha256)=64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'),
  abandoned_at TEXT NOT NULL CHECK(julianday(abandoned_at) IS NOT NULL),
  UNIQUE(owner_principal_ref,idempotency_key),
  CHECK(reason<>'OTHER' OR note IS NOT NULL),
  CHECK(json_extract(record_json,'$.protocol') IS 'eliotr.computer-agent-dispatch-abandoned.v1'),
  CHECK(json_extract(record_json,'$.dispatch_id') IS dispatch_id),
  CHECK(json_extract(record_json,'$.project_id') IS project_id),
  CHECK(json_extract(record_json,'$.owner_principal_ref') IS owner_principal_ref),
  CHECK(json_extract(record_json,'$.owner_credential_generation') IS owner_credential_generation),
  CHECK(json_extract(record_json,'$.reason') IS reason),
  CHECK((note IS NULL AND json_type(record_json,'$.note') IS NULL)
    OR json_extract(record_json,'$.note') IS note),
  CHECK(json_extract(record_json,'$.idempotency_key') IS idempotency_key),
  CHECK(json_extract(record_json,'$.request_sha256') IS request_sha256),
  CHECK(json_extract(record_json,'$.abandoned_at') IS abandoned_at)
) STRICT;

CREATE INDEX computer_agent_dispatch_abandonment_owner_idx
  ON computer_agent_dispatch_abandonment(owner_principal_ref,abandoned_at DESC,dispatch_id DESC);

CREATE TRIGGER computer_agent_dispatch_abandonment_insert_guard
BEFORE INSERT ON computer_agent_dispatch_abandonment
WHEN NOT EXISTS (
  SELECT 1
  FROM computer_agent_dispatch d
  JOIN project_owner o
    ON o.project_id=d.project_id AND o.principal_ref=d.owner_principal_ref
  LEFT JOIN computer_agent_dispatch_acceptance a ON a.dispatch_id=d.dispatch_id
  WHERE d.dispatch_id=NEW.dispatch_id
    AND d.project_id=NEW.project_id
    AND d.owner_principal_ref=NEW.owner_principal_ref
    AND a.dispatch_id IS NULL
    AND julianday(NEW.abandoned_at)>=julianday(d.created_at)
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_DISPATCH_ABANDONMENT_INVALID'); END;

CREATE TRIGGER computer_agent_dispatch_abandonment_no_update
BEFORE UPDATE ON computer_agent_dispatch_abandonment
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_DISPATCH_ABANDONMENT_IMMUTABLE'); END;
CREATE TRIGGER computer_agent_dispatch_abandonment_no_delete
BEFORE DELETE ON computer_agent_dispatch_abandonment
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_DISPATCH_ABANDONMENT_IMMUTABLE'); END;

-- SQLite serializes writers; whichever immutable terminal record wins first excludes the other.
CREATE TRIGGER computer_agent_dispatch_acceptance_abandonment_guard
BEFORE INSERT ON computer_agent_dispatch_acceptance
WHEN EXISTS (
  SELECT 1 FROM computer_agent_dispatch_abandonment x
  WHERE x.dispatch_id=NEW.dispatch_id
)
BEGIN SELECT RAISE(ABORT,'COMPUTER_AGENT_DISPATCH_ABANDONED'); END;

CREATE VIEW computer_agent_dispatch_offer_actionable AS
SELECT o.*
FROM computer_agent_dispatch_offer_current o
LEFT JOIN computer_agent_dispatch_abandonment x ON x.dispatch_id=o.dispatch_id
WHERE x.dispatch_id IS NULL;

INSERT INTO schema_state(key,value,updated_at)
VALUES('computer_agent_dispatch_abandonment_generation',
  'computer-agent-dispatch-abandonment-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
