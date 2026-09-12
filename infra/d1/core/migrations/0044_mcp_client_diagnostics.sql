PRAGMA foreign_keys = ON;

-- Core-owned one-shot MCP client diagnostic challenges. The bearer token is
-- never persisted; token_sha256 is the only token representation in D1.
-- Expiry is interpreted by the read/consume path and never rewrites history.
CREATE TABLE mcp_client_diagnostic_challenge (
  challenge_id TEXT PRIMARY KEY NOT NULL CHECK(
    length(challenge_id) BETWEEN 1 AND 256
  ),
  token_sha256 TEXT NOT NULL CHECK(
    length(token_sha256) = 64
    AND token_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  owner_principal_ref TEXT NOT NULL CHECK(
    length(owner_principal_ref) BETWEEN 1 AND 256
  ),
  owner_credential_generation TEXT NOT NULL CHECK(
    length(owner_credential_generation) BETWEEN 1 AND 256
  ),
  deployment_generation TEXT NOT NULL CHECK(
    length(deployment_generation) BETWEEN 1 AND 256
  ),
  auth_profile TEXT NOT NULL CHECK(
    auth_profile IN ('service-token', 'managed-oauth')
  ),
  issued_at TEXT NOT NULL CHECK(
    issued_at GLOB '????-??-??T??:??:??.???Z'
    AND julianday(issued_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', issued_at) IS issued_at
    AND CAST(substr(issued_at, 6, 2) AS INTEGER) BETWEEN 1 AND 12
    AND CAST(substr(issued_at, 9, 2) AS INTEGER) BETWEEN 1 AND 31
    AND CAST(substr(issued_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(issued_at, 15, 2) AS INTEGER) BETWEEN 0 AND 59
    AND CAST(substr(issued_at, 18, 2) AS INTEGER) BETWEEN 0 AND 59
  ),
  expires_at TEXT NOT NULL CHECK(
    expires_at GLOB '????-??-??T??:??:??.???Z'
    AND julianday(expires_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at
    AND CAST(substr(expires_at, 6, 2) AS INTEGER) BETWEEN 1 AND 12
    AND CAST(substr(expires_at, 9, 2) AS INTEGER) BETWEEN 1 AND 31
    AND CAST(substr(expires_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(expires_at, 15, 2) AS INTEGER) BETWEEN 0 AND 59
    AND CAST(substr(expires_at, 18, 2) AS INTEGER) BETWEEN 0 AND 59
  ),
  state TEXT NOT NULL CHECK(
    state IN ('ISSUED', 'CONFIRMED')
  ),
  observation_ref TEXT CHECK(
    observation_ref IS NULL
    OR length(observation_ref) BETWEEN 1 AND 256
  ),
  observed_at TEXT CHECK(
    observed_at IS NULL
    OR (
      observed_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(observed_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', observed_at) IS observed_at
      AND CAST(substr(observed_at, 6, 2) AS INTEGER) BETWEEN 1 AND 12
      AND CAST(substr(observed_at, 9, 2) AS INTEGER) BETWEEN 1 AND 31
      AND CAST(substr(observed_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23
      AND CAST(substr(observed_at, 15, 2) AS INTEGER) BETWEEN 0 AND 59
      AND CAST(substr(observed_at, 18, 2) AS INTEGER) BETWEEN 0 AND 59
    )
  ),
  trace_id TEXT CHECK(
    trace_id IS NULL
    OR length(trace_id) BETWEEN 1 AND 256
  ),
  verified_actor_ref TEXT CHECK(
    verified_actor_ref IS NULL
    OR length(verified_actor_ref) BETWEEN 1 AND 256
  ),
  verified_credential_generation TEXT CHECK(
    verified_credential_generation IS NULL
    OR length(verified_credential_generation) BETWEEN 1 AND 256
  ),
  verified_authentication_method TEXT CHECK(
    verified_authentication_method IS NULL
    OR verified_authentication_method IN ('cloudflare_access', 'service_token')
  ),
  verified_expires_at TEXT CHECK(
    verified_expires_at IS NULL
    OR (
      verified_expires_at GLOB '????-??-??T??:??:??.???Z'
      AND julianday(verified_expires_at) IS NOT NULL
      AND strftime('%Y-%m-%dT%H:%M:%fZ', verified_expires_at) IS verified_expires_at
      AND CAST(substr(verified_expires_at, 6, 2) AS INTEGER) BETWEEN 1 AND 12
      AND CAST(substr(verified_expires_at, 9, 2) AS INTEGER) BETWEEN 1 AND 31
      AND CAST(substr(verified_expires_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23
      AND CAST(substr(verified_expires_at, 15, 2) AS INTEGER) BETWEEN 0 AND 59
      AND CAST(substr(verified_expires_at, 18, 2) AS INTEGER) BETWEEN 0 AND 59
    )
  ),
  UNIQUE(token_sha256),
  CHECK(
    julianday(expires_at) IS NOT NULL
    AND julianday(issued_at) IS NOT NULL
    AND julianday(expires_at) > julianday(issued_at)
  ),
  -- ISSUED rows carry no observation or verifier data. CONFIRMED rows carry
  -- the complete server-side readback, including the verified expiry.
  CHECK(
    (
      state = 'ISSUED'
      AND observation_ref IS NULL
      AND observed_at IS NULL
      AND trace_id IS NULL
      AND verified_actor_ref IS NULL
      AND verified_credential_generation IS NULL
      AND verified_authentication_method IS NULL
      AND verified_expires_at IS NULL
    )
    OR (
      state = 'CONFIRMED'
      AND observation_ref IS NOT NULL
      AND observed_at IS NOT NULL
      AND trace_id IS NOT NULL
      AND verified_actor_ref IS NOT NULL
      AND verified_credential_generation IS NOT NULL
      AND verified_authentication_method IS NOT NULL
      AND verified_expires_at IS NOT NULL
    )
  ),
  -- The authenticated method must agree with the profile under which the
  -- challenge was issued. The ISSUED arm keeps all verifier fields absent.
  CHECK(
    (
      state = 'ISSUED'
      AND verified_authentication_method IS NULL
    )
    OR (
      state = 'CONFIRMED'
      AND (
        (
          auth_profile = 'service-token'
          AND verified_authentication_method = 'service_token'
        )
        OR (
          auth_profile = 'managed-oauth'
          AND verified_authentication_method = 'cloudflare_access'
        )
      )
    )
  ),
  -- These comparisons are guarded by non-NULL julianday values. The
  -- per-column canonical checks above require UTC millis-Z before a row can
  -- satisfy the confirmed timing relation.
  CHECK(
    state = 'ISSUED'
    OR (
      julianday(observed_at) IS NOT NULL
      AND julianday(verified_expires_at) IS NOT NULL
      AND julianday(observed_at) >= julianday(issued_at)
      AND julianday(observed_at) < julianday(expires_at)
      AND julianday(verified_expires_at) > julianday(observed_at)
    )
  )
) STRICT;

CREATE INDEX mcp_client_diagnostic_challenge_latest_idx
  ON mcp_client_diagnostic_challenge(
    owner_principal_ref,
    owner_credential_generation,
    deployment_generation,
    issued_at DESC,
    challenge_id DESC
  );

CREATE UNIQUE INDEX mcp_client_diagnostic_challenge_observation_ref_uq
  ON mcp_client_diagnostic_challenge(observation_ref)
  WHERE observation_ref IS NOT NULL;

-- A challenge is issued empty and can only be completed by the guarded
-- ISSUED -> CONFIRMED transition. This keeps direct CONFIRMED inserts out of
-- the durable protocol even when every confirmation column is supplied.
CREATE TRIGGER mcp_client_diagnostic_challenge_issue_guard
BEFORE INSERT ON mcp_client_diagnostic_challenge
WHEN NEW.state IS NOT 'ISSUED'
  OR NEW.observation_ref IS NOT NULL
  OR NEW.observed_at IS NOT NULL
  OR NEW.trace_id IS NOT NULL
  OR NEW.verified_actor_ref IS NOT NULL
  OR NEW.verified_credential_generation IS NOT NULL
  OR NEW.verified_authentication_method IS NOT NULL
  OR NEW.verified_expires_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'MCP_DIAGNOSTIC_CHALLENGE_DIRECT_CONFIRM_FORBIDDEN');
END;

-- All issuance identity, ownership, profile, generation, and lifecycle
-- timestamps remain fixed. A single atomic update may fill the full
-- observation and verifier readback exactly once.
CREATE TRIGGER mcp_client_diagnostic_challenge_transition_guard
BEFORE UPDATE ON mcp_client_diagnostic_challenge
WHEN OLD.state IS NOT 'ISSUED'
  OR NEW.state IS NOT 'CONFIRMED'
  OR NEW.challenge_id IS NOT OLD.challenge_id
  OR NEW.token_sha256 IS NOT OLD.token_sha256
  OR NEW.owner_principal_ref IS NOT OLD.owner_principal_ref
  OR NEW.owner_credential_generation IS NOT OLD.owner_credential_generation
  OR NEW.deployment_generation IS NOT OLD.deployment_generation
  OR NEW.auth_profile IS NOT OLD.auth_profile
  OR NEW.issued_at IS NOT OLD.issued_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.observation_ref IS NULL
  OR NEW.observed_at IS NULL
  OR NEW.trace_id IS NULL
  OR NEW.verified_actor_ref IS NULL
  OR NEW.verified_credential_generation IS NULL
  OR NEW.verified_authentication_method IS NULL
  OR NEW.verified_expires_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'MCP_DIAGNOSTIC_CHALLENGE_TRANSITION_INVALID');
END;

CREATE TRIGGER mcp_client_diagnostic_challenge_no_delete
BEFORE DELETE ON mcp_client_diagnostic_challenge
BEGIN
  SELECT RAISE(ABORT, 'MCP_DIAGNOSTIC_CHALLENGE_IMMUTABLE');
END;
