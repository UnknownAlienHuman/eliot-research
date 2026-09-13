PRAGMA foreign_keys = ON;

-- Claim commits before the external model call. An unfinished claim is never
-- reclaimed automatically: a lost response may already have incurred usage.
CREATE TABLE model_route_qualification_probe (
  probe_idempotency_key TEXT PRIMARY KEY CHECK (length(probe_idempotency_key) BETWEEN 1 AND 256),
  probe_input_sha256 TEXT NOT NULL CHECK (length(probe_input_sha256) = 64 AND probe_input_sha256 NOT GLOB '*[^0-9a-f]*'),
  claim_ref TEXT NOT NULL UNIQUE CHECK (length(claim_ref) BETWEEN 1 AND 256),
  started_at TEXT NOT NULL,
  execution_probe_ref TEXT UNIQUE,
  observation_sha256 TEXT,
  observation_json TEXT,
  CHECK (
    (execution_probe_ref IS NULL AND observation_sha256 IS NULL AND observation_json IS NULL)
    OR
    (execution_probe_ref IS NOT NULL AND length(execution_probe_ref) BETWEEN 1 AND 256
      AND observation_sha256 IS NOT NULL AND length(observation_sha256) = 64
      AND observation_sha256 NOT GLOB '*[^0-9a-f]*'
      AND observation_json IS NOT NULL AND json_valid(observation_json)
      AND length(CAST(observation_json AS BLOB)) BETWEEN 1 AND 32768)
  )
) STRICT;

CREATE TRIGGER model_route_qualification_probe_immutable_claim
BEFORE UPDATE ON model_route_qualification_probe
WHEN NEW.probe_idempotency_key IS NOT OLD.probe_idempotency_key
  OR NEW.probe_input_sha256 IS NOT OLD.probe_input_sha256
  OR NEW.claim_ref IS NOT OLD.claim_ref
  OR NEW.started_at IS NOT OLD.started_at
  OR OLD.execution_probe_ref IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'qualification claims and completed observations are immutable');
END;

CREATE TRIGGER model_route_qualification_probe_immutable_delete
BEFORE DELETE ON model_route_qualification_probe
BEGIN
  SELECT RAISE(ABORT, 'qualification claims cannot be deleted or retried');
END;
