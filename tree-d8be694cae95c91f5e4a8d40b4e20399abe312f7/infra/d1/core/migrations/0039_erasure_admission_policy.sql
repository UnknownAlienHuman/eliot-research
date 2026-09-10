PRAGMA foreign_keys = ON;

-- Operator-installed destructive permission.  This is deliberately separate
-- from source admission and read/disclosure grants.
CREATE TABLE erasure_admission_policy (
  permission_ref TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  source_namespace_id TEXT NOT NULL,
  owner_system_id TEXT NOT NULL,
  source_owner_generation TEXT NOT NULL,
  principal_ref TEXT NOT NULL,
  credential_generation TEXT NOT NULL,
  authorization_binding_ref TEXT NOT NULL,
  legal_basis_ref TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','REVOKED')),
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json) AND length(CAST(policy_json AS BLOB)) <= 16384),
  policy_sha256 TEXT NOT NULL CHECK (
    length(policy_sha256) = 64 AND policy_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY(permission_ref, revision),
  CHECK ((state = 'ACTIVE' AND revoked_at IS NULL) OR (state = 'REVOKED' AND revoked_at IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX erasure_admission_active_identity
  ON erasure_admission_policy(
    source_namespace_id, owner_system_id, source_owner_generation,
    principal_ref, credential_generation, authorization_binding_ref
  ) WHERE state = 'ACTIVE';

CREATE TABLE erasure_admission_request (
  erasure_id TEXT NOT NULL,
  erasure_revision INTEGER NOT NULL CHECK (erasure_revision > 0),
  permission_ref TEXT NOT NULL,
  permission_revision INTEGER NOT NULL CHECK (permission_revision > 0),
  principal_ref TEXT NOT NULL,
  credential_generation TEXT NOT NULL,
  permission_sha256 TEXT NOT NULL CHECK (
    length(permission_sha256) = 64 AND permission_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  request_json TEXT NOT NULL CHECK (json_valid(request_json) AND length(CAST(request_json AS BLOB)) <= 262144),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  request_identity_sha256 TEXT NOT NULL CHECK (
    length(request_identity_sha256) = 64 AND request_identity_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  admitted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(erasure_id, erasure_revision),
  FOREIGN KEY(permission_ref, permission_revision)
    REFERENCES erasure_admission_policy(permission_ref, revision)
) STRICT;

CREATE INDEX erasure_admission_request_identity
  ON erasure_admission_request(permission_ref, permission_revision, request_identity_sha256);

CREATE TRIGGER erasure_admission_request_immutable
BEFORE UPDATE ON erasure_admission_request
BEGIN
  SELECT RAISE(ABORT, 'erasure admission request is immutable');
END;

CREATE TRIGGER erasure_admission_policy_immutable
BEFORE UPDATE ON erasure_admission_policy
WHEN NEW.permission_ref IS NOT OLD.permission_ref
  OR NEW.revision IS NOT OLD.revision
  OR NEW.source_namespace_id IS NOT OLD.source_namespace_id
  OR NEW.owner_system_id IS NOT OLD.owner_system_id
  OR NEW.source_owner_generation IS NOT OLD.source_owner_generation
  OR NEW.principal_ref IS NOT OLD.principal_ref
  OR NEW.credential_generation IS NOT OLD.credential_generation
  OR NEW.authorization_binding_ref IS NOT OLD.authorization_binding_ref
  OR NEW.legal_basis_ref IS NOT OLD.legal_basis_ref
  OR NEW.valid_from IS NOT OLD.valid_from
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.policy_json IS NOT OLD.policy_json
  OR NEW.policy_sha256 IS NOT OLD.policy_sha256
  OR NEW.created_at IS NOT OLD.created_at
  OR (OLD.state = 'REVOKED' AND NEW.state <> 'REVOKED')
  OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
BEGIN
  SELECT RAISE(ABORT, 'erasure admission policy identity is immutable');
END;
