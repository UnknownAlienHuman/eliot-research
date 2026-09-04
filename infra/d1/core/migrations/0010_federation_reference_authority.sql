PRAGMA foreign_keys = ON;

CREATE TABLE federation_scope_snapshot_authority (
  snapshot_id TEXT NOT NULL CHECK (
    length(snapshot_id) BETWEEN 1 AND 256
    AND substr(snapshot_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND snapshot_id NOT GLOB '*[^A-Za-z0-9._:@/-]*'
  ),
  revision INTEGER NOT NULL CHECK (revision > 0),
  digest TEXT NOT NULL CHECK (
    length(digest) = 64
    AND digest NOT GLOB '*[^0-9a-f]*'
  ),
  client_fence_ref TEXT NOT NULL CHECK (
    length(client_fence_ref) BETWEEN 1 AND 256
    AND substr(client_fence_ref, 1, 1) GLOB '[A-Za-z0-9]'
    AND client_fence_ref NOT GLOB '*[^A-Za-z0-9._:@/-]*'
  ),
  policy_authority_ref TEXT NOT NULL CHECK (
    length(policy_authority_ref) BETWEEN 1 AND 256
    AND substr(policy_authority_ref, 1, 1) GLOB '[A-Za-z0-9]'
    AND policy_authority_ref NOT GLOB '*[^A-Za-z0-9._:@/-]*'
  ),
  purge_ledger_revision INTEGER NOT NULL CHECK (purge_ledger_revision > 0),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 35),
  expires_at TEXT NOT NULL CHECK (
    length(expires_at) BETWEEN 20 AND 35
    AND expires_at > created_at
  ),
  snapshot_json TEXT NOT NULL CHECK (
    length(CAST(snapshot_json AS BLOB)) <= 1048576
    AND json_valid(snapshot_json)
    AND json_extract(snapshot_json, '$.snapshot_id') = snapshot_id
    AND json_extract(snapshot_json, '$.revision') = revision
    AND json_extract(snapshot_json, '$.digest') = digest
    AND json_extract(snapshot_json, '$.client_fence_ref') = client_fence_ref
    AND json_extract(snapshot_json, '$.policy_authority_ref') = policy_authority_ref
    AND json_extract(snapshot_json, '$.purge_ledger_revision') = purge_ledger_revision
    AND json_extract(snapshot_json, '$.created_at') = created_at
    AND json_extract(snapshot_json, '$.expires_at') = expires_at
    AND json_type(snapshot_json, '$.resolved_scope_expression') = 'object'
    AND json_type(snapshot_json, '$.participant_generations') = 'object'
    AND json_type(snapshot_json, '$.member_source_revision_refs') = 'array'
    AND json_type(snapshot_json, '$.source_owner_generations') = 'object'
  ),
  stored_at TEXT NOT NULL CHECK (length(stored_at) BETWEEN 20 AND 35),
  PRIMARY KEY (snapshot_id, revision),
  UNIQUE (snapshot_id, revision, client_fence_ref)
) STRICT;

CREATE TABLE federation_allowed_reference_manifest_authority (
  manifest_id TEXT NOT NULL CHECK (
    length(manifest_id) BETWEEN 1 AND 256
    AND substr(manifest_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND manifest_id NOT GLOB '*[^A-Za-z0-9._:@/-]*'
  ),
  revision INTEGER NOT NULL CHECK (revision > 0),
  manifest_digest TEXT NOT NULL CHECK (
    length(manifest_digest) = 64
    AND manifest_digest NOT GLOB '*[^0-9a-f]*'
  ),
  scope_snapshot_id TEXT NOT NULL CHECK (
    length(scope_snapshot_id) BETWEEN 1 AND 256
    AND substr(scope_snapshot_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND scope_snapshot_id NOT GLOB '*[^A-Za-z0-9._:@/-]*'
  ),
  scope_snapshot_revision INTEGER NOT NULL CHECK (scope_snapshot_revision > 0),
  client_fence_ref TEXT NOT NULL CHECK (
    length(client_fence_ref) BETWEEN 1 AND 256
    AND substr(client_fence_ref, 1, 1) GLOB '[A-Za-z0-9]'
    AND client_fence_ref NOT GLOB '*[^A-Za-z0-9._:@/-]*'
  ),
  expires_at TEXT NOT NULL CHECK (length(expires_at) BETWEEN 20 AND 35),
  manifest_json TEXT NOT NULL CHECK (
    length(CAST(manifest_json AS BLOB)) <= 1048576
    AND json_valid(manifest_json)
    AND json_extract(manifest_json, '$.manifest_ref.id') = manifest_id
    AND json_extract(manifest_json, '$.manifest_ref.revision') = revision
    AND json_extract(manifest_json, '$.manifest_digest') = manifest_digest
    AND json_extract(manifest_json, '$.scope_snapshot_ref.id') = scope_snapshot_id
    AND json_extract(manifest_json, '$.scope_snapshot_ref.revision') = scope_snapshot_revision
    AND json_extract(manifest_json, '$.client_fence_ref') = client_fence_ref
    AND json_extract(manifest_json, '$.expires_at') = expires_at
    AND json_type(manifest_json, '$.allowed_source_revision_refs') = 'array'
    AND json_type(manifest_json, '$.allowed_evidence_handle_refs') = 'array'
    AND json_type(manifest_json, '$.provider_and_policy_generations') = 'object'
    AND json_type(manifest_json, '$.stale_or_revoked_entries') = 'array'
    AND json_type(manifest_json, '$.allowed_use') = 'array'
  ),
  stored_at TEXT NOT NULL CHECK (length(stored_at) BETWEEN 20 AND 35),
  PRIMARY KEY (manifest_id, revision),
  FOREIGN KEY (
    scope_snapshot_id,
    scope_snapshot_revision,
    client_fence_ref
  ) REFERENCES federation_scope_snapshot_authority (
    snapshot_id,
    revision,
    client_fence_ref
  ) ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT;

CREATE INDEX federation_scope_snapshot_expiry_idx
ON federation_scope_snapshot_authority(expires_at, snapshot_id, revision);

CREATE INDEX federation_manifest_expiry_idx
ON federation_allowed_reference_manifest_authority(
  expires_at,
  client_fence_ref,
  manifest_id,
  revision
);

CREATE TRIGGER federation_scope_snapshot_immutable
BEFORE UPDATE ON federation_scope_snapshot_authority
BEGIN
  SELECT RAISE(ABORT, 'federation scope snapshot is immutable');
END;

CREATE TRIGGER federation_manifest_immutable
BEFORE UPDATE ON federation_allowed_reference_manifest_authority
BEGIN
  SELECT RAISE(ABORT, 'federation reference manifest is immutable');
END;

UPDATE schema_state
SET value = 'core-v10-federation-reference-authority',
    updated_at = '2026-09-04T13:30:00Z'
WHERE key = 'schema_generation';
