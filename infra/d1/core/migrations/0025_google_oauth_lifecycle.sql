-- G3 explicit reconnect fencing and bounded proof-retention metadata.
-- The initial OAuth intent remains no-overwrite; this table is only populated
-- by an explicit reconnect request carrying an expected credential snapshot.
CREATE TABLE google_oauth_reconnect_intent (
  intent_id TEXT PRIMARY KEY REFERENCES google_oauth_intent(intent_id),
  connection_id TEXT NOT NULL REFERENCES google_exchange_connection(connection_id),
  expected_credential_generation TEXT NOT NULL CHECK(length(expected_credential_generation) BETWEEN 1 AND 256),
  expected_credential_revision INTEGER NOT NULL CHECK(expected_credential_revision > 0 AND expected_credential_revision < 9007199254740991),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX google_oauth_reconnect_connection_idx ON google_oauth_reconnect_intent(connection_id, created_at);

-- Retains only non-secret outcome metadata after bounded proof cleanup.
CREATE TABLE google_oauth_intent_receipt (
  intent_id TEXT PRIMARY KEY,
  operation_ref TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  configuration_json TEXT NOT NULL CHECK(json_valid(configuration_json) AND length(configuration_json)<=4096),
  state_sha256 TEXT NOT NULL CHECK(length(state_sha256)=64 AND state_sha256 NOT GLOB '*[^0-9a-f]*'),
  terminal_state TEXT NOT NULL CHECK(terminal_state IN ('DENIED','FAILED','EXPIRED')),
  terminal_at TEXT NOT NULL,
  retained_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX google_oauth_receipt_operation ON google_oauth_intent_receipt(principal_id, operation_ref);

-- Idempotent owner disconnect outcome. It stores only the nonsecret request
-- fence and terminal snapshot, so a lost HTTP ACK can be replayed safely.
CREATE TABLE google_oauth_disconnect_receipt (
  principal_id TEXT NOT NULL,
  operation_ref TEXT NOT NULL CHECK(length(operation_ref) BETWEEN 1 AND 256),
  connection_id TEXT NOT NULL REFERENCES google_exchange_connection(connection_id),
  configuration_json TEXT NOT NULL CHECK(json_valid(configuration_json) AND length(configuration_json)<=4096),
  expected_credential_generation TEXT NOT NULL CHECK(length(expected_credential_generation) BETWEEN 1 AND 256),
  expected_credential_revision INTEGER NOT NULL CHECK(expected_credential_revision > 0 AND expected_credential_revision < 9007199254740991),
  result_credential_generation TEXT,
  result_credential_revision INTEGER,
  result_state TEXT CHECK(result_state IS NULL OR result_state='REVOKED'),
  created_at TEXT NOT NULL,
  PRIMARY KEY(principal_id, operation_ref),
  UNIQUE(connection_id, operation_ref)
) STRICT;
CREATE INDEX google_oauth_intent_expiry_idx ON google_oauth_intent(expires_at_epoch_ms, state);
INSERT INTO schema_state(key,value,updated_at) VALUES ('google_oauth_lifecycle_generation','google-oauth-lifecycle-v1','2026-09-09T00:00:00Z');
