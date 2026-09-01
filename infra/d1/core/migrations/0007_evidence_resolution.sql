PRAGMA foreign_keys = ON;

CREATE TABLE scope_access_grant (
  snapshot_id TEXT NOT NULL,
  snapshot_revision INTEGER NOT NULL CHECK (snapshot_revision > 0),
  principal_ref TEXT NOT NULL,
  client_class TEXT NOT NULL CHECK (client_class IN (
    'owner_pwa','named_api_client','trusted_agent','federation_client'
  )),
  credential_generation TEXT NOT NULL,
  policy_authority_ref TEXT NOT NULL,
  allowed_use_json TEXT NOT NULL CHECK (json_valid(allowed_use_json)),
  disclosure_ceiling TEXT NOT NULL,
  authorization_receipt_ref TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','REVOKED','EXPIRED')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(
    snapshot_id,
    snapshot_revision,
    principal_ref,
    client_class,
    credential_generation
  ),
  FOREIGN KEY(snapshot_id, snapshot_revision)
    REFERENCES scope_snapshot(snapshot_id, revision)
) STRICT;
CREATE INDEX scope_access_grant_state_idx
  ON scope_access_grant(state, expires_at, principal_ref);

CREATE TABLE evidence_handle_identity (
  identity_digest TEXT PRIMARY KEY CHECK (
    length(identity_digest) = 64 AND identity_digest NOT GLOB '*[^0-9a-f]*'
  ),
  handle_id TEXT NOT NULL,
  handle_revision INTEGER NOT NULL CHECK (handle_revision > 0),
  created_at TEXT NOT NULL,
  UNIQUE(handle_id, handle_revision),
  FOREIGN KEY(handle_id, handle_revision)
    REFERENCES evidence_handle(handle_id, revision)
) STRICT;

CREATE TABLE evidence_resolution_receipt (
  receipt_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  handle_id TEXT NOT NULL,
  handle_revision INTEGER NOT NULL CHECK (handle_revision > 0),
  source_revision_ref TEXT NOT NULL REFERENCES source_revision(source_revision_ref),
  scope_snapshot_id TEXT NOT NULL,
  scope_snapshot_revision INTEGER NOT NULL CHECK (scope_snapshot_revision > 0),
  authorization_receipt_ref TEXT NOT NULL,
  normalized_object_ref TEXT NOT NULL,
  normalized_object_ref_digest TEXT NOT NULL CHECK (
    length(normalized_object_ref_digest) = 64
    AND normalized_object_ref_digest NOT GLOB '*[^0-9a-f]*'
  ),
  source_revision_content_sha256 TEXT NOT NULL CHECK (
    length(source_revision_content_sha256) = 64
    AND source_revision_content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_object_size INTEGER NOT NULL CHECK (source_object_size > 0),
  scope_snapshot_digest TEXT NOT NULL CHECK (
    length(scope_snapshot_digest) = 64
    AND scope_snapshot_digest NOT GLOB '*[^0-9a-f]*'
  ),
  anchor_digest TEXT NOT NULL CHECK (
    length(anchor_digest) = 64 AND anchor_digest NOT GLOB '*[^0-9a-f]*'
  ),
  excerpt_sha256 TEXT NOT NULL CHECK (
    length(excerpt_sha256) = 64 AND excerpt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  excerpt_byte_length INTEGER NOT NULL CHECK (excerpt_byte_length > 0),
  source_owner_generation TEXT NOT NULL,
  purge_state TEXT NOT NULL CHECK (purge_state = 'LIVE'),
  terminal_state TEXT NOT NULL CHECK (terminal_state = 'LIVE'),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  receipt_sha256 TEXT NOT NULL CHECK (
    length(receipt_sha256) = 64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  resolved_at TEXT NOT NULL,
  PRIMARY KEY(receipt_id, revision),
  FOREIGN KEY(handle_id, handle_revision)
    REFERENCES evidence_handle(handle_id, revision),
  FOREIGN KEY(scope_snapshot_id, scope_snapshot_revision)
    REFERENCES scope_snapshot(snapshot_id, revision),
  FOREIGN KEY(authorization_receipt_ref)
    REFERENCES scope_access_grant(authorization_receipt_ref)
) STRICT;
CREATE INDEX evidence_resolution_handle_idx
  ON evidence_resolution_receipt(handle_id, handle_revision, resolved_at DESC);
CREATE INDEX evidence_resolution_source_idx
  ON evidence_resolution_receipt(source_revision_ref, resolved_at DESC);

CREATE TABLE evidence_resolution_guard (
  handle_id TEXT NOT NULL,
  handle_revision INTEGER NOT NULL CHECK (handle_revision > 0),
  receipt_id TEXT NOT NULL,
  receipt_revision INTEGER NOT NULL CHECK (receipt_revision > 0),
  identity_digest TEXT NOT NULL,
  verified INTEGER NOT NULL CHECK (verified = 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY(handle_id, handle_revision, receipt_id, receipt_revision),
  FOREIGN KEY(handle_id, handle_revision)
    REFERENCES evidence_handle(handle_id, revision),
  FOREIGN KEY(receipt_id, receipt_revision)
    REFERENCES evidence_resolution_receipt(receipt_id, revision),
  FOREIGN KEY(identity_digest)
    REFERENCES evidence_handle_identity(identity_digest)
) STRICT;

CREATE TABLE citation_resolution_receipt (
  receipt_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  scope_snapshot_id TEXT NOT NULL,
  scope_snapshot_revision INTEGER NOT NULL CHECK (scope_snapshot_revision > 0),
  principal_ref TEXT NOT NULL,
  client_class TEXT NOT NULL CHECK (client_class IN (
    'owner_pwa','named_api_client','trusted_agent','federation_client'
  )),
  credential_generation TEXT NOT NULL,
  authorization_receipt_ref TEXT NOT NULL,
  requested_handle_refs_json TEXT NOT NULL CHECK (json_valid(requested_handle_refs_json)),
  resolved_json TEXT NOT NULL CHECK (json_valid(resolved_json)),
  rejected_json TEXT NOT NULL CHECK (json_valid(rejected_json)),
  requested_count INTEGER NOT NULL CHECK (requested_count >= 0 AND requested_count <= 512),
  resolved_count INTEGER NOT NULL CHECK (resolved_count >= 0 AND resolved_count <= requested_count),
  all_material_citations_resolved INTEGER NOT NULL CHECK (all_material_citations_resolved IN (0,1)),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  receipt_sha256 TEXT NOT NULL CHECK (
    length(receipt_sha256) = 64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY(receipt_id, revision),
  FOREIGN KEY(scope_snapshot_id, scope_snapshot_revision)
    REFERENCES scope_snapshot(snapshot_id, revision),
  FOREIGN KEY(authorization_receipt_ref)
    REFERENCES scope_access_grant(authorization_receipt_ref)
) STRICT;
CREATE INDEX citation_resolution_scope_idx
  ON citation_resolution_receipt(scope_snapshot_id, scope_snapshot_revision, created_at DESC);

CREATE TABLE citation_resolution_guard (
  receipt_id TEXT NOT NULL,
  receipt_revision INTEGER NOT NULL CHECK (receipt_revision > 0),
  verified INTEGER NOT NULL CHECK (verified = 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY(receipt_id, receipt_revision),
  FOREIGN KEY(receipt_id, receipt_revision)
    REFERENCES citation_resolution_receipt(receipt_id, revision)
) STRICT;

CREATE TABLE evidence_handle_invalidation (
  invalidation_ref TEXT PRIMARY KEY,
  handle_id TEXT NOT NULL,
  handle_revision INTEGER NOT NULL CHECK (handle_revision > 0),
  terminal_state TEXT NOT NULL CHECK (terminal_state IN (
    'STALE','COLD_RESTORABLE','REDACTED','RETENTION_BLOCKED','BROKEN_INTEGRITY'
  )),
  reason_code TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  FOREIGN KEY(handle_id, handle_revision)
    REFERENCES evidence_handle(handle_id, revision)
) STRICT;
CREATE INDEX evidence_invalidation_handle_idx
  ON evidence_handle_invalidation(handle_id, handle_revision, observed_at DESC);

UPDATE schema_state
SET value = 'core-v7-evidence-resolution',
    updated_at = '2026-08-31T22:30:00Z'
WHERE key = 'schema_generation';
