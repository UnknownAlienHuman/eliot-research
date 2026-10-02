-- Preserve original artifact authorship evidence without transferring the
-- installation's current grants, project ownership, or credentials on restore.
-- These append-only snapshots are provenance inputs only; O3 still requires
-- fresh owner, membership, source-scope, and credential admission.
-- The backfill records only rows present at this migration's installation;
-- it does not claim unavailable pre-migration transitions or grantor facts.
PRAGMA foreign_keys = ON;

CREATE TABLE historical_scope_access_grant (
  archive_id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_revision INTEGER NOT NULL CHECK(archive_revision > 0),
  snapshot_id TEXT NOT NULL,
  snapshot_revision INTEGER NOT NULL CHECK(snapshot_revision > 0),
  principal_ref TEXT NOT NULL,
  client_class TEXT NOT NULL,
  credential_generation TEXT NOT NULL,
  policy_authority_ref TEXT NOT NULL,
  authorization_receipt_ref TEXT NOT NULL,
  allowed_use_json TEXT NOT NULL CHECK(json_valid(allowed_use_json)),
  disclosure_ceiling TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','REVOKED','EXPIRED')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  project_client_grant_id TEXT,
  project_client_grant_revision INTEGER,
  project_client_operation TEXT,
  project_client_project_generation INTEGER,
  project_client_run_operation_id TEXT,
  project_client_artifact_id TEXT,
  project_client_artifact_revision INTEGER,
  project_client_authority_epoch INTEGER,
  event_kind TEXT NOT NULL CHECK(event_kind IN ('INSERT','UPDATE','DELETE','BACKFILL')),
  recorded_at TEXT NOT NULL,
  UNIQUE(snapshot_id,snapshot_revision,principal_ref,client_class,credential_generation,authorization_receipt_ref,archive_revision),
  CHECK((project_client_grant_id IS NULL) = (project_client_grant_revision IS NULL))
) STRICT;
CREATE INDEX historical_scope_access_grant_origin_idx
  ON historical_scope_access_grant(snapshot_id,snapshot_revision,principal_ref,client_class,authorization_receipt_ref);

CREATE TABLE historical_project_client_grant (
  archive_id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_revision INTEGER NOT NULL CHECK(archive_revision > 0),
  grant_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  project_id TEXT NOT NULL,
  grantor_principal_ref TEXT NOT NULL,
  grantee_issuer TEXT NOT NULL,
  grantee_method TEXT NOT NULL,
  grantee_subject TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','REVOKED')),
  expires_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  record_sha256 TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK(event_kind IN ('INSERT','UPDATE','DELETE','BACKFILL')),
  recorded_at TEXT NOT NULL,
  UNIQUE(grant_id,revision,archive_revision)
) STRICT;

CREATE TRIGGER historical_scope_access_grant_insert
AFTER INSERT ON scope_access_grant
BEGIN
  INSERT INTO historical_scope_access_grant(
    archive_revision,snapshot_id,snapshot_revision,principal_ref,client_class,credential_generation,
    policy_authority_ref,authorization_receipt_ref,allowed_use_json,disclosure_ceiling,
    state,expires_at,created_at,project_client_grant_id,project_client_grant_revision,
    project_client_operation,project_client_project_generation,project_client_run_operation_id,
    project_client_artifact_id,project_client_artifact_revision,project_client_authority_epoch,
    event_kind,recorded_at
  ) VALUES (
    COALESCE((SELECT MAX(archive_revision)+1 FROM historical_scope_access_grant WHERE snapshot_id=NEW.snapshot_id AND snapshot_revision=NEW.snapshot_revision AND principal_ref=NEW.principal_ref AND client_class=NEW.client_class AND credential_generation=NEW.credential_generation AND authorization_receipt_ref=NEW.authorization_receipt_ref),1),
    NEW.snapshot_id,NEW.snapshot_revision,NEW.principal_ref,NEW.client_class,NEW.credential_generation,
    NEW.policy_authority_ref,NEW.authorization_receipt_ref,NEW.allowed_use_json,NEW.disclosure_ceiling,
    NEW.state,NEW.expires_at,NEW.created_at,NEW.project_client_grant_id,NEW.project_client_grant_revision,
    NEW.project_client_operation,NEW.project_client_project_generation,NEW.project_client_run_operation_id,
    NEW.project_client_artifact_id,NEW.project_client_artifact_revision,NEW.project_client_authority_epoch,
    'INSERT',strftime('%Y-%m-%dT%H:%M:%fZ','now')
  );
END;

CREATE TRIGGER historical_scope_access_grant_update
AFTER UPDATE ON scope_access_grant
BEGIN
  INSERT INTO historical_scope_access_grant(
    archive_revision,snapshot_id,snapshot_revision,principal_ref,client_class,credential_generation,
    policy_authority_ref,authorization_receipt_ref,allowed_use_json,disclosure_ceiling,
    state,expires_at,created_at,project_client_grant_id,project_client_grant_revision,
    project_client_operation,project_client_project_generation,project_client_run_operation_id,
    project_client_artifact_id,project_client_artifact_revision,project_client_authority_epoch,
    event_kind,recorded_at
  ) VALUES (
    COALESCE((SELECT MAX(archive_revision)+1 FROM historical_scope_access_grant WHERE snapshot_id=NEW.snapshot_id AND snapshot_revision=NEW.snapshot_revision AND principal_ref=NEW.principal_ref AND client_class=NEW.client_class AND credential_generation=NEW.credential_generation AND authorization_receipt_ref=NEW.authorization_receipt_ref),1),
    NEW.snapshot_id,NEW.snapshot_revision,NEW.principal_ref,NEW.client_class,NEW.credential_generation,
    NEW.policy_authority_ref,NEW.authorization_receipt_ref,NEW.allowed_use_json,NEW.disclosure_ceiling,
    NEW.state,NEW.expires_at,NEW.created_at,NEW.project_client_grant_id,NEW.project_client_grant_revision,
    NEW.project_client_operation,NEW.project_client_project_generation,NEW.project_client_run_operation_id,
    NEW.project_client_artifact_id,NEW.project_client_artifact_revision,NEW.project_client_authority_epoch,
    'UPDATE',strftime('%Y-%m-%dT%H:%M:%fZ','now')
  );
END;

CREATE TRIGGER historical_scope_access_grant_delete
AFTER DELETE ON scope_access_grant
BEGIN
  INSERT INTO historical_scope_access_grant(
    archive_revision,snapshot_id,snapshot_revision,principal_ref,client_class,credential_generation,
    policy_authority_ref,authorization_receipt_ref,allowed_use_json,disclosure_ceiling,
    state,expires_at,created_at,project_client_grant_id,project_client_grant_revision,
    project_client_operation,project_client_project_generation,project_client_run_operation_id,
    project_client_artifact_id,project_client_artifact_revision,project_client_authority_epoch,
    event_kind,recorded_at
  ) VALUES (
    COALESCE((SELECT MAX(archive_revision)+1 FROM historical_scope_access_grant WHERE snapshot_id=OLD.snapshot_id AND snapshot_revision=OLD.snapshot_revision AND principal_ref=OLD.principal_ref AND client_class=OLD.client_class AND credential_generation=OLD.credential_generation AND authorization_receipt_ref=OLD.authorization_receipt_ref),1),
    OLD.snapshot_id,OLD.snapshot_revision,OLD.principal_ref,OLD.client_class,OLD.credential_generation,
    OLD.policy_authority_ref,OLD.authorization_receipt_ref,OLD.allowed_use_json,OLD.disclosure_ceiling,
    OLD.state,OLD.expires_at,OLD.created_at,OLD.project_client_grant_id,OLD.project_client_grant_revision,
    OLD.project_client_operation,OLD.project_client_project_generation,OLD.project_client_run_operation_id,
    OLD.project_client_artifact_id,OLD.project_client_artifact_revision,OLD.project_client_authority_epoch,
    'DELETE',strftime('%Y-%m-%dT%H:%M:%fZ','now')
  );
END;

CREATE TRIGGER historical_project_client_grant_insert
AFTER INSERT ON project_client_grant
BEGIN
  INSERT INTO historical_project_client_grant(
    archive_revision,grant_id,revision,project_id,grantor_principal_ref,grantee_issuer,grantee_method,
    grantee_subject,state,expires_at,idempotency_key,request_sha256,record_json,record_sha256,event_kind,recorded_at
  ) VALUES (
    COALESCE((SELECT MAX(archive_revision)+1 FROM historical_project_client_grant WHERE grant_id=NEW.grant_id AND revision=NEW.revision),1),
    NEW.grant_id,NEW.revision,NEW.project_id,NEW.grantor_principal_ref,NEW.grantee_issuer,NEW.grantee_method,
    NEW.grantee_subject,NEW.state,NEW.expires_at,NEW.idempotency_key,NEW.request_sha256,NEW.record_json,
    NEW.record_sha256,'INSERT',strftime('%Y-%m-%dT%H:%M:%fZ','now')
  );
END;

CREATE TRIGGER historical_project_client_grant_update
AFTER UPDATE ON project_client_grant
BEGIN
  INSERT INTO historical_project_client_grant(
    archive_revision,grant_id,revision,project_id,grantor_principal_ref,grantee_issuer,grantee_method,
    grantee_subject,state,expires_at,idempotency_key,request_sha256,record_json,record_sha256,event_kind,recorded_at
  ) VALUES (
    COALESCE((SELECT MAX(archive_revision)+1 FROM historical_project_client_grant WHERE grant_id=NEW.grant_id AND revision=NEW.revision),1),
    NEW.grant_id,NEW.revision,NEW.project_id,NEW.grantor_principal_ref,NEW.grantee_issuer,NEW.grantee_method,
    NEW.grantee_subject,NEW.state,NEW.expires_at,NEW.idempotency_key,NEW.request_sha256,NEW.record_json,
    NEW.record_sha256,'UPDATE',strftime('%Y-%m-%dT%H:%M:%fZ','now')
  );
END;

CREATE TRIGGER historical_project_client_grant_delete
AFTER DELETE ON project_client_grant
BEGIN
  INSERT INTO historical_project_client_grant(
    archive_revision,grant_id,revision,project_id,grantor_principal_ref,grantee_issuer,grantee_method,
    grantee_subject,state,expires_at,idempotency_key,request_sha256,record_json,record_sha256,event_kind,recorded_at
  ) VALUES (
    COALESCE((SELECT MAX(archive_revision)+1 FROM historical_project_client_grant WHERE grant_id=OLD.grant_id AND revision=OLD.revision),1),
    OLD.grant_id,OLD.revision,OLD.project_id,OLD.grantor_principal_ref,OLD.grantee_issuer,OLD.grantee_method,
    OLD.grantee_subject,OLD.state,OLD.expires_at,OLD.idempotency_key,OLD.request_sha256,OLD.record_json,
    OLD.record_sha256,'DELETE',strftime('%Y-%m-%dT%H:%M:%fZ','now')
  );
END;

CREATE TRIGGER historical_scope_access_grant_immutable_update
BEFORE UPDATE ON historical_scope_access_grant BEGIN SELECT RAISE(ABORT,'HISTORICAL_SCOPE_GRANT_IMMUTABLE'); END;
CREATE TRIGGER historical_scope_access_grant_immutable_delete
BEFORE DELETE ON historical_scope_access_grant BEGIN SELECT RAISE(ABORT,'HISTORICAL_SCOPE_GRANT_IMMUTABLE'); END;
CREATE TRIGGER historical_project_client_grant_immutable_update
BEFORE UPDATE ON historical_project_client_grant BEGIN SELECT RAISE(ABORT,'HISTORICAL_CLIENT_GRANT_IMMUTABLE'); END;
CREATE TRIGGER historical_project_client_grant_immutable_delete
BEFORE DELETE ON historical_project_client_grant BEGIN SELECT RAISE(ABORT,'HISTORICAL_CLIENT_GRANT_IMMUTABLE'); END;

INSERT INTO historical_scope_access_grant(
  archive_revision,snapshot_id,snapshot_revision,principal_ref,client_class,credential_generation,
  policy_authority_ref,authorization_receipt_ref,allowed_use_json,disclosure_ceiling,
  state,expires_at,created_at,project_client_grant_id,project_client_grant_revision,
  project_client_operation,project_client_project_generation,project_client_run_operation_id,
  project_client_artifact_id,project_client_artifact_revision,project_client_authority_epoch,
  event_kind,recorded_at
)
SELECT 1,snapshot_id,snapshot_revision,principal_ref,client_class,credential_generation,
  policy_authority_ref,authorization_receipt_ref,allowed_use_json,disclosure_ceiling,
  state,expires_at,created_at,project_client_grant_id,project_client_grant_revision,
  project_client_operation,project_client_project_generation,project_client_run_operation_id,
  project_client_artifact_id,project_client_artifact_revision,project_client_authority_epoch,
  'BACKFILL',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM scope_access_grant;

INSERT INTO historical_project_client_grant(
  archive_revision,grant_id,revision,project_id,grantor_principal_ref,grantee_issuer,grantee_method,
  grantee_subject,state,expires_at,idempotency_key,request_sha256,record_json,record_sha256,event_kind,recorded_at
)
SELECT 1,grant_id,revision,project_id,grantor_principal_ref,grantee_issuer,grantee_method,
  grantee_subject,state,expires_at,idempotency_key,request_sha256,record_json,record_sha256,
  'BACKFILL',strftime('%Y-%m-%dT%H:%M:%fZ','now')
FROM project_client_grant;

INSERT INTO schema_state(key,value,updated_at)
VALUES('historical_grant_provenance_generation','historical-grant-provenance-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
