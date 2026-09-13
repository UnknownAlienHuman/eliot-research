-- ER-24: durable owner namespace initialization.  This is an additive
-- capability: it does not advance the public schema/readiness generation.
PRAGMA foreign_keys = ON;

CREATE TABLE source_namespace_initialization (
  source_namespace_id TEXT PRIMARY KEY CHECK(length(source_namespace_id) BETWEEN 1 AND 256),
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  credential_generation TEXT NOT NULL CHECK(length(credential_generation) BETWEEN 1 AND 256),
  profile_id TEXT NOT NULL CHECK(length(profile_id) BETWEEN 1 AND 256),
  profile_revision INTEGER NOT NULL CHECK(profile_revision > 0),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  owner_incarnation_ref TEXT NOT NULL CHECK(length(owner_incarnation_ref) BETWEEN 1 AND 256),
  source_owner_generation TEXT NOT NULL CHECK(length(source_owner_generation) BETWEEN 1 AND 256),
  ownership_record_revision INTEGER NOT NULL CHECK(ownership_record_revision = 1),
  source_admission_policy_revision INTEGER NOT NULL CHECK(source_admission_policy_revision = 1),
  scope_policy_ref TEXT NOT NULL CHECK(length(scope_policy_ref) BETWEEN 1 AND 256),
  scope_policy_generation INTEGER NOT NULL CHECK(scope_policy_generation = 1),
  request_sha256 TEXT NOT NULL CHECK(
    length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK(
    created_at GLOB '????-??-??T??:??:??.???Z'
    AND julianday(created_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at
  ),
  UNIQUE(principal_ref, idempotency_key),
  FOREIGN KEY(source_namespace_id, ownership_record_revision)
    REFERENCES source_namespace_ownership(source_namespace_id, ownership_record_revision)
) STRICT;

CREATE INDEX source_namespace_initialization_principal_idx
  ON source_namespace_initialization(principal_ref, created_at, source_namespace_id);

CREATE TRIGGER source_namespace_initialization_immutable
BEFORE UPDATE ON source_namespace_initialization
BEGIN
  SELECT RAISE(ABORT, 'SOURCE_NAMESPACE_INITIALIZATION_IMMUTABLE');
END;

CREATE TRIGGER source_namespace_initialization_no_delete
BEFORE DELETE ON source_namespace_initialization
BEGIN
  SELECT RAISE(ABORT, 'SOURCE_NAMESPACE_INITIALIZATION_IMMUTABLE');
END;
