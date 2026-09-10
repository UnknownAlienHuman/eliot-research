-- ER-09 W3: immutable, scope-bound AllowedReferenceManifest storage.
-- The manifest bytes live in immutable WORK R2.  D1 stores the exact binding
-- and receipt needed to reconcile a lost R2/D1 acknowledgement.  No network,
-- model, or R2 effect occurs inside a D1 transaction.
PRAGMA foreign_keys = ON;

CREATE TABLE research_reference_manifest (
  manifest_id TEXT NOT NULL CHECK(length(manifest_id) BETWEEN 1 AND 256),
  manifest_revision INTEGER NOT NULL CHECK(manifest_revision > 0),
  manifest_digest TEXT NOT NULL CHECK(length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  r2_content_sha256 TEXT NOT NULL CHECK(length(r2_content_sha256) = 64 AND r2_content_sha256 NOT GLOB '*[^0-9a-f]*'),
  r2_residency_key_json TEXT NOT NULL CHECK(json_valid(r2_residency_key_json) AND length(CAST(r2_residency_key_json AS BLOB)) <= 4096),
  r2_residency_key_digest TEXT NOT NULL CHECK(length(r2_residency_key_digest) = 64 AND r2_residency_key_digest NOT GLOB '*[^0-9a-f]*'),
  r2_key TEXT NOT NULL CHECK(length(r2_key) BETWEEN 1 AND 1024),
  r2_etag TEXT NOT NULL CHECK(length(r2_etag) BETWEEN 1 AND 1024),
  r2_size_bytes INTEGER NOT NULL CHECK(r2_size_bytes > 0 AND r2_size_bytes <= 262144),
  scope_snapshot_id TEXT NOT NULL CHECK(length(scope_snapshot_id) BETWEEN 1 AND 256),
  scope_snapshot_revision INTEGER NOT NULL CHECK(scope_snapshot_revision > 0),
  scope_snapshot_digest TEXT NOT NULL CHECK(length(scope_snapshot_digest) = 64 AND scope_snapshot_digest NOT GLOB '*[^0-9a-f]*'),
  policy_authority_ref TEXT NOT NULL CHECK(length(policy_authority_ref) BETWEEN 1 AND 256),
  authorization_receipt_ref TEXT NOT NULL CHECK(length(authorization_receipt_ref) BETWEEN 1 AND 256),
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  credential_generation TEXT NOT NULL CHECK(length(credential_generation) BETWEEN 1 AND 256),
  pack_ref_id TEXT NOT NULL CHECK(length(pack_ref_id) BETWEEN 1 AND 256),
  pack_ref_revision INTEGER NOT NULL CHECK(pack_ref_revision > 0),
  trace_ref_id TEXT NOT NULL CHECK(length(trace_ref_id) BETWEEN 1 AND 256),
  trace_ref_revision INTEGER NOT NULL CHECK(trace_ref_revision > 0),
  stage_attempt_ref TEXT NOT NULL CHECK(length(stage_attempt_ref) BETWEEN 1 AND 256),
  stage_request_sha256 TEXT NOT NULL CHECK(length(stage_request_sha256) = 64 AND stage_request_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('WRITING','COMMITTED')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(manifest_id, manifest_revision),
  UNIQUE(manifest_digest)
) STRICT;

CREATE INDEX research_reference_manifest_owner_idx
  ON research_reference_manifest(principal_ref, scope_snapshot_id, scope_snapshot_revision, state);

CREATE INDEX research_reference_manifest_stage_idx
  ON research_reference_manifest(stage_attempt_ref, stage_request_sha256, state);

CREATE TRIGGER research_reference_manifest_identity
BEFORE UPDATE ON research_reference_manifest
WHEN OLD.state = 'WRITING'
  AND (NEW.manifest_id IS NOT OLD.manifest_id
    OR NEW.manifest_revision IS NOT OLD.manifest_revision
    OR NEW.manifest_digest IS NOT OLD.manifest_digest
    OR NEW.r2_content_sha256 IS NOT OLD.r2_content_sha256
    OR NEW.r2_residency_key_json IS NOT OLD.r2_residency_key_json
    OR NEW.r2_residency_key_digest IS NOT OLD.r2_residency_key_digest
    OR NEW.r2_key IS NOT OLD.r2_key
    OR NEW.r2_size_bytes IS NOT OLD.r2_size_bytes
    OR NEW.scope_snapshot_id IS NOT OLD.scope_snapshot_id
    OR NEW.scope_snapshot_revision IS NOT OLD.scope_snapshot_revision
    OR NEW.scope_snapshot_digest IS NOT OLD.scope_snapshot_digest
    OR NEW.policy_authority_ref IS NOT OLD.policy_authority_ref
    OR NEW.authorization_receipt_ref IS NOT OLD.authorization_receipt_ref
    OR NEW.principal_ref IS NOT OLD.principal_ref
    OR NEW.credential_generation IS NOT OLD.credential_generation
    OR NEW.pack_ref_id IS NOT OLD.pack_ref_id
    OR NEW.pack_ref_revision IS NOT OLD.pack_ref_revision
    OR NEW.trace_ref_id IS NOT OLD.trace_ref_id
    OR NEW.trace_ref_revision IS NOT OLD.trace_ref_revision
    OR NEW.stage_attempt_ref IS NOT OLD.stage_attempt_ref
    OR NEW.stage_request_sha256 IS NOT OLD.stage_request_sha256
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.expires_at IS NOT OLD.expires_at)
BEGIN SELECT RAISE(ABORT, 'REFERENCE_MANIFEST_CONFLICT'); END;

CREATE TRIGGER research_reference_manifest_immutable
BEFORE UPDATE ON research_reference_manifest
WHEN OLD.state = 'COMMITTED'
  AND (NEW.state IS NOT OLD.state
    OR NEW.manifest_id IS NOT OLD.manifest_id
    OR NEW.manifest_revision IS NOT OLD.manifest_revision
    OR NEW.manifest_digest IS NOT OLD.manifest_digest
    OR NEW.r2_content_sha256 IS NOT OLD.r2_content_sha256
    OR NEW.r2_residency_key_json IS NOT OLD.r2_residency_key_json
    OR NEW.r2_residency_key_digest IS NOT OLD.r2_residency_key_digest
    OR NEW.r2_key IS NOT OLD.r2_key
    OR NEW.r2_etag IS NOT OLD.r2_etag
    OR NEW.r2_size_bytes IS NOT OLD.r2_size_bytes
    OR NEW.scope_snapshot_id IS NOT OLD.scope_snapshot_id
    OR NEW.scope_snapshot_revision IS NOT OLD.scope_snapshot_revision
    OR NEW.scope_snapshot_digest IS NOT OLD.scope_snapshot_digest
    OR NEW.policy_authority_ref IS NOT OLD.policy_authority_ref
    OR NEW.authorization_receipt_ref IS NOT OLD.authorization_receipt_ref
    OR NEW.principal_ref IS NOT OLD.principal_ref
    OR NEW.credential_generation IS NOT OLD.credential_generation
    OR NEW.pack_ref_id IS NOT OLD.pack_ref_id
    OR NEW.pack_ref_revision IS NOT OLD.pack_ref_revision
    OR NEW.trace_ref_id IS NOT OLD.trace_ref_id
    OR NEW.trace_ref_revision IS NOT OLD.trace_ref_revision
    OR NEW.stage_attempt_ref IS NOT OLD.stage_attempt_ref
    OR NEW.stage_request_sha256 IS NOT OLD.stage_request_sha256
    OR NEW.created_at IS NOT OLD.created_at
    OR NEW.expires_at IS NOT OLD.expires_at)
BEGIN SELECT RAISE(ABORT, 'REFERENCE_MANIFEST_CONFLICT'); END;

CREATE TRIGGER research_reference_manifest_no_delete
BEFORE DELETE ON research_reference_manifest
WHEN OLD.state = 'COMMITTED'
BEGIN SELECT RAISE(ABORT, 'REFERENCE_MANIFEST_CONFLICT'); END;
