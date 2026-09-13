-- ER-09 bootstrap: one-shot provider execution dispatch for dynamic-route
-- qualification.  The dispatch claim is separate from the existing
-- qualification observation claim so the provider call cannot be repeated
-- after an ambiguous Worker/D1 write.
PRAGMA foreign_keys = ON;

CREATE TABLE model_route_qualification_dispatch (
  probe_idempotency_key TEXT PRIMARY KEY CHECK(
    length(probe_idempotency_key) BETWEEN 1 AND 256
  ),
  probe_input_sha256 TEXT NOT NULL CHECK(
    length(probe_input_sha256) = 64
    AND probe_input_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  claim_ref TEXT NOT NULL UNIQUE CHECK(length(claim_ref) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK(state IN ('STARTED', 'COMPLETED')),
  observation_sha256 TEXT CHECK(
    observation_sha256 IS NULL
    OR (
      length(observation_sha256) = 64
      AND observation_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  observation_json TEXT CHECK(
    observation_json IS NULL
    OR (
      json_valid(observation_json)
      AND length(CAST(observation_json AS BLOB)) BETWEEN 1 AND 32768
    )
  ),
  started_at TEXT NOT NULL CHECK(
    started_at GLOB '????-??-??T??:??:??.???Z'
    AND julianday(started_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', started_at) IS started_at
  ),
  completed_at TEXT CHECK(
    completed_at IS NULL OR (
      completed_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(completed_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) IS completed_at
    )
  ),
  FOREIGN KEY(probe_idempotency_key)
    REFERENCES model_route_qualification_probe(probe_idempotency_key),
  FOREIGN KEY(claim_ref)
    REFERENCES model_route_qualification_probe(claim_ref),
  CHECK(
    (
      state = 'STARTED'
      AND observation_sha256 IS NULL
      AND observation_json IS NULL
      AND completed_at IS NULL
    )
    OR (
      state = 'COMPLETED'
      AND observation_sha256 IS NOT NULL
      AND observation_json IS NOT NULL
      AND completed_at IS NOT NULL
    )
  )
) STRICT;

CREATE INDEX model_route_qualification_dispatch_claim_idx
  ON model_route_qualification_dispatch(claim_ref);

-- The first dispatch row is admitted only for the exact unfinished
-- qualification claim.  A duplicate replay of an already durable dispatch
-- is allowed to reach the application's exact readback path.
CREATE TRIGGER model_route_qualification_dispatch_claim_guard
BEFORE INSERT ON model_route_qualification_dispatch
BEGIN
  SELECT RAISE(ABORT, 'MODEL_QUALIFICATION_DISPATCH_CLAIM_INVALID')
  WHERE NOT EXISTS (
    SELECT 1
    FROM model_route_qualification_probe p
    WHERE p.probe_idempotency_key = NEW.probe_idempotency_key
      AND p.probe_input_sha256 = NEW.probe_input_sha256
      AND p.claim_ref = NEW.claim_ref
      AND p.execution_probe_ref IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM model_route_qualification_dispatch d
    WHERE d.probe_idempotency_key = NEW.probe_idempotency_key
      AND d.probe_input_sha256 = NEW.probe_input_sha256
      AND d.claim_ref = NEW.claim_ref
  );
END;

-- Only STARTED -> COMPLETED may change the dispatch row.  Identity and the
-- original start timestamp remain immutable, and a completed result cannot
-- be replaced or deleted.
CREATE TRIGGER model_route_qualification_dispatch_immutable_update
BEFORE UPDATE ON model_route_qualification_dispatch
WHEN OLD.state = 'COMPLETED'
  OR NEW.probe_idempotency_key IS NOT OLD.probe_idempotency_key
  OR NEW.probe_input_sha256 IS NOT OLD.probe_input_sha256
  OR NEW.claim_ref IS NOT OLD.claim_ref
  OR NEW.started_at IS NOT OLD.started_at
  OR (OLD.state = 'STARTED' AND NEW.state <> 'COMPLETED')
BEGIN
  SELECT RAISE(ABORT, 'MODEL_QUALIFICATION_DISPATCH_IMMUTABLE');
END;

CREATE TRIGGER model_route_qualification_dispatch_immutable_delete
BEFORE DELETE ON model_route_qualification_dispatch
BEGIN
  SELECT RAISE(ABORT, 'MODEL_QUALIFICATION_DISPATCH_IMMUTABLE');
END;
