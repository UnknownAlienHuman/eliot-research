-- One logical project/client grant, append-only revisions, and exact idempotency receipts.
-- Configured Client IDs are locators. Authentication remains the signed Access token.
PRAGMA foreign_keys = ON;
CREATE TABLE project_client_grant (
  grant_id TEXT NOT NULL CHECK(length(grant_id) BETWEEN 1 AND 256),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
  project_id TEXT NOT NULL REFERENCES project(project_id),
  grantor_principal_ref TEXT NOT NULL CHECK(length(grantor_principal_ref) BETWEEN 1 AND 256),
  grantee_issuer TEXT NOT NULL CHECK(length(grantee_issuer) BETWEEN 1 AND 256),
  grantee_method TEXT NOT NULL CHECK(grantee_method='service_token'),
  grantee_subject TEXT NOT NULL CHECK(length(grantee_subject) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','REVOKED')),
  expires_at TEXT NOT NULL CHECK(julianday(expires_at) IS NOT NULL),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  record_json TEXT NOT NULL CHECK(json_valid(record_json) AND length(CAST(record_json AS BLOB)) BETWEEN 1 AND 24576),
  record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64 AND record_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(grant_id,revision),
  UNIQUE(grantor_principal_ref,idempotency_key),
  CHECK(json_extract(record_json,'$.protocol') IS 'eliotr.project-client-grant.v1'),
  CHECK(json_extract(record_json,'$.grant_id') IS grant_id),
  CHECK(json_extract(record_json,'$.revision') IS revision),
  CHECK(json_extract(record_json,'$.project_id') IS project_id),
  CHECK(json_extract(record_json,'$.grantor_principal_ref') IS grantor_principal_ref),
  CHECK(json_extract(record_json,'$.grantee.issuer') IS grantee_issuer),
  CHECK(json_extract(record_json,'$.grantee.authentication_method') IS grantee_method),
  CHECK(json_extract(record_json,'$.grantee.subject') IS grantee_subject),
  CHECK(json_extract(record_json,'$.state') IS state),
  CHECK(json_extract(record_json,'$.expires_at') IS expires_at),
  CHECK(json_type(record_json,'$.allowed_operations') IS 'array'),
  CHECK(json_array_length(record_json,'$.allowed_operations') BETWEEN 1 AND 11),
  CHECK(json_type(record_json,'$.ingest_namespace_ids') IS 'array'),
  CHECK(json_array_length(record_json,'$.ingest_namespace_ids')<=64),
  CHECK(julianday(json_extract(record_json,'$.created_at')) IS NOT NULL),
  CHECK(julianday(json_extract(record_json,'$.updated_at')) IS NOT NULL),
  CHECK(julianday(json_extract(record_json,'$.updated_at'))>=julianday(json_extract(record_json,'$.created_at')))
) STRICT;
CREATE INDEX project_client_grant_actor_idx
  ON project_client_grant(project_id,grantee_issuer,grantee_method,grantee_subject,revision DESC);
CREATE INDEX project_client_grant_project_idx ON project_client_grant(project_id,grant_id,revision DESC);
CREATE VIEW project_client_grant_current AS
  SELECT g.* FROM project_client_grant g
  WHERE NOT EXISTS (SELECT 1 FROM project_client_grant n WHERE n.grant_id=g.grant_id AND n.revision>g.revision);

CREATE TRIGGER project_client_grant_insert_guard BEFORE INSERT ON project_client_grant
BEGIN
  SELECT RAISE(ABORT,'CLIENT_GRANT_REVISION_CONFLICT')
  WHERE NEW.revision <> COALESCE((SELECT MAX(revision) FROM project_client_grant WHERE grant_id=NEW.grant_id),0)+1;
  SELECT RAISE(ABORT,'CLIENT_GRANT_OWNER_REQUIRED') WHERE NOT EXISTS
    (SELECT 1 FROM project_owner o WHERE o.project_id=NEW.project_id AND o.principal_ref=NEW.grantor_principal_ref);
  SELECT RAISE(ABORT,'CLIENT_GRANT_IDENTITY_CONFLICT') WHERE EXISTS (
    SELECT 1 FROM project_client_grant g WHERE g.grant_id=NEW.grant_id AND
      (g.project_id IS NOT NEW.project_id OR g.grantor_principal_ref IS NOT NEW.grantor_principal_ref OR
       g.grantee_issuer IS NOT NEW.grantee_issuer OR g.grantee_method IS NOT NEW.grantee_method OR
       g.grantee_subject IS NOT NEW.grantee_subject OR
       json_extract(g.record_json,'$.created_at') IS NOT json_extract(NEW.record_json,'$.created_at')));
  SELECT RAISE(ABORT,'CLIENT_GRANT_IDENTITY_CONFLICT') WHERE EXISTS (
    SELECT 1 FROM project_client_grant g WHERE g.project_id=NEW.project_id AND g.grantee_issuer=NEW.grantee_issuer
      AND g.grantee_method=NEW.grantee_method AND g.grantee_subject=NEW.grantee_subject AND g.grant_id<>NEW.grant_id);
  SELECT RAISE(ABORT,'CLIENT_GRANT_INITIAL_STATE_INVALID') WHERE NEW.revision=1 AND NEW.state<>'ACTIVE';
  SELECT RAISE(ABORT,'CLIENT_GRANT_EXPIRED') WHERE NEW.state='ACTIVE' AND julianday(NEW.expires_at)<=julianday('now');
  SELECT RAISE(ABORT,'CLIENT_GRANT_TIME_INVALID') WHERE EXISTS (
    SELECT 1 FROM project_client_grant g WHERE g.grant_id=NEW.grant_id AND g.revision=NEW.revision-1
      AND julianday(json_extract(g.record_json,'$.updated_at'))>julianday(json_extract(NEW.record_json,'$.updated_at')));
  SELECT RAISE(ABORT,'CLIENT_GRANT_OPERATION_INVALID') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.record_json,'$.allowed_operations') WHERE type<>'text' OR value NOT IN
      ('catalog','query','run','status','report','evidence','cancel','recover','ingest.bundle','workspace.admit','project.attach'));
  SELECT RAISE(ABORT,'CLIENT_GRANT_OPERATION_INVALID') WHERE
    (SELECT COUNT(DISTINCT value) FROM json_each(NEW.record_json,'$.allowed_operations'))
      <>json_array_length(NEW.record_json,'$.allowed_operations');
  SELECT RAISE(ABORT,'CLIENT_GRANT_NAMESPACE_INVALID') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.record_json,'$.ingest_namespace_ids') WHERE type<>'text' OR length(value) NOT BETWEEN 1 AND 256);
  SELECT RAISE(ABORT,'CLIENT_GRANT_NAMESPACE_INVALID') WHERE
    (SELECT COUNT(DISTINCT value) FROM json_each(NEW.record_json,'$.ingest_namespace_ids'))
      <>json_array_length(NEW.record_json,'$.ingest_namespace_ids');
  SELECT RAISE(ABORT,'CLIENT_GRANT_NAMESPACE_INVALID') WHERE
    (EXISTS (SELECT 1 FROM json_each(NEW.record_json,'$.allowed_operations') WHERE value IN ('ingest.bundle','workspace.admit')))
      <> (json_array_length(NEW.record_json,'$.ingest_namespace_ids')>0);
END;
CREATE TRIGGER project_client_grant_no_update BEFORE UPDATE ON project_client_grant
BEGIN SELECT RAISE(ABORT,'CLIENT_GRANT_IMMUTABLE'); END;
CREATE TRIGGER project_client_grant_no_delete BEFORE DELETE ON project_client_grant
BEGIN SELECT RAISE(ABORT,'CLIENT_GRANT_IMMUTABLE'); END;
-- Existing catalog cursors and in-flight reads settle against this primary mutation fence.
CREATE TRIGGER project_client_grant_epoch AFTER INSERT ON project_client_grant
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
-- Namespace admission policy changes must also invalidate any in-flight delegation ceiling check.
CREATE TRIGGER client_grant_policy_epoch_insert AFTER INSERT ON source_admission_policy
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER client_grant_policy_epoch_update AFTER UPDATE ON source_admission_policy
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
CREATE TRIGGER client_grant_policy_epoch_delete AFTER DELETE ON source_admission_policy
BEGIN UPDATE orientation_authority_epoch SET generation=generation+1 WHERE singleton=1; END;
INSERT INTO schema_state(key,value,updated_at)
VALUES('project_client_grant_generation','project-client-grant-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
