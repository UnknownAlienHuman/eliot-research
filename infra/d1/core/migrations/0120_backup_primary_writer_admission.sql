-- ER-34: a verified owner may mint one short-lived bootstrap admission for
-- the exact Worker generation/version currently serving the request.
-- D1 enforces row shape, runtime matching, liveness, revocation and one-use;
-- canonical SHA-256 verification is performed by the Worker and native operator.
PRAGMA foreign_keys = ON;

CREATE TABLE backup_primary_writer_admission (
  admission_ref TEXT PRIMARY KEY CHECK (
    length(admission_ref) = 36 AND admission_ref GLOB '????????-????-????-????-????????????' AND
    admission_ref NOT GLOB '*[^0-9a-f-]*' AND substr(admission_ref,15,1) = '4' AND
    substr(admission_ref,20,1) IN ('8','9','a','b')
  ),
  protocol TEXT NOT NULL CHECK (protocol = 'eliotr.backup-primary-writer-admission.v1'),
  purpose TEXT NOT NULL CHECK (purpose = 'BOOTSTRAP'),
  admission_json TEXT NOT NULL CHECK (json_valid(admission_json) AND length(CAST(admission_json AS BLOB)) BETWEEN 2 AND 8192),
  admission_sha256 TEXT NOT NULL CHECK (length(admission_sha256)=64 AND admission_sha256 NOT GLOB '*[^0-9a-f]*'),
  principal_ref TEXT NOT NULL CHECK (length(trim(principal_ref)) BETWEEN 1 AND 512),
  client_class TEXT NOT NULL CHECK (client_class = 'owner_pwa'),
  credential_generation TEXT NOT NULL CHECK (length(trim(credential_generation)) BETWEEN 1 AND 256),
  issuer TEXT NOT NULL CHECK (length(trim(issuer)) BETWEEN 1 AND 512),
  authentication_method TEXT NOT NULL CHECK (authentication_method = 'cloudflare_access'),
  access_expires_at TEXT NOT NULL CHECK (julianday(access_expires_at) IS NOT NULL),
  deployment_generation TEXT NOT NULL CHECK (length(trim(deployment_generation)) BETWEEN 1 AND 256),
  version_id TEXT NOT NULL CHECK (length(trim(version_id)) BETWEEN 1 AND 256),
  bucket_binding_ref TEXT NOT NULL CHECK (bucket_binding_ref = 'BACKUP_PARTS_BUCKET'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (admission_ref, admission_sha256),
  CHECK (COALESCE(
    json_type(admission_json,'$.protocol') = 'text' AND json_extract(admission_json,'$.protocol') = protocol AND
    json_type(admission_json,'$.admission_ref') = 'text' AND json_extract(admission_json,'$.admission_ref') = admission_ref AND
    json_type(admission_json,'$.purpose') = 'text' AND json_extract(admission_json,'$.purpose') = purpose AND
    json_type(admission_json,'$.principal_ref') = 'text' AND json_extract(admission_json,'$.principal_ref') = principal_ref AND
    json_type(admission_json,'$.client_class') = 'text' AND json_extract(admission_json,'$.client_class') = client_class AND
    json_type(admission_json,'$.credential_generation') = 'text' AND json_extract(admission_json,'$.credential_generation') = credential_generation AND
    json_type(admission_json,'$.issuer') = 'text' AND json_extract(admission_json,'$.issuer') = issuer AND
    json_type(admission_json,'$.authentication_method') = 'text' AND json_extract(admission_json,'$.authentication_method') = authentication_method AND
    json_type(admission_json,'$.access_expires_at') = 'text' AND json_extract(admission_json,'$.access_expires_at') = access_expires_at AND
    json_type(admission_json,'$.deployment_generation') = 'text' AND json_extract(admission_json,'$.deployment_generation') = deployment_generation AND
    json_type(admission_json,'$.version_id') = 'text' AND json_extract(admission_json,'$.version_id') = version_id AND
    json_type(admission_json,'$.bucket_binding_ref') = 'text' AND json_extract(admission_json,'$.bucket_binding_ref') = bucket_binding_ref,
    0) = 1)
) STRICT;

CREATE TABLE backup_primary_writer_admission_revocation (
  admission_ref TEXT PRIMARY KEY,
  admission_sha256 TEXT NOT NULL CHECK (length(admission_sha256)=64 AND admission_sha256 NOT GLOB '*[^0-9a-f]*'),
  revoked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (julianday(revoked_at) IS NOT NULL),
  reason_code TEXT NOT NULL CHECK (reason_code = 'OWNER_REVOKED'),
  FOREIGN KEY (admission_ref, admission_sha256)
    REFERENCES backup_primary_writer_admission(admission_ref, admission_sha256)
) STRICT;

CREATE INDEX backup_primary_writer_admission_scope
  ON backup_primary_writer_admission(principal_ref, deployment_generation, version_id, bucket_binding_ref, access_expires_at);

CREATE TRIGGER backup_primary_writer_admission_insert_guard
BEFORE INSERT ON backup_primary_writer_admission
WHEN julianday(NEW.access_expires_at) <= julianday('now') OR
  EXISTS (SELECT 1 FROM backup_primary_writer_qualification) OR
  EXISTS (
    SELECT 1 FROM backup_primary_writer_admission a
    WHERE a.principal_ref = NEW.principal_ref
      AND a.deployment_generation = NEW.deployment_generation
      AND a.version_id = NEW.version_id
      AND a.bucket_binding_ref = NEW.bucket_binding_ref
      AND julianday(a.access_expires_at) > julianday('now')
      AND NOT EXISTS (
        SELECT 1 FROM backup_primary_writer_admission_revocation r
        WHERE r.admission_ref = a.admission_ref AND r.admission_sha256 = a.admission_sha256
      )
      AND NOT EXISTS (
        SELECT 1 FROM backup_primary_writer_qualification q
        WHERE q.owner_admission_ref = a.admission_ref AND q.owner_admission_sha256 = a.admission_sha256
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'BACKUP_PRIMARY_ADMISSION_UNAVAILABLE');
END;

CREATE TRIGGER backup_primary_writer_admission_immutable_update
BEFORE UPDATE ON backup_primary_writer_admission
BEGIN SELECT RAISE(ABORT, 'backup primary writer admission is immutable'); END;

CREATE TRIGGER backup_primary_writer_admission_immutable_delete
BEFORE DELETE ON backup_primary_writer_admission
BEGIN SELECT RAISE(ABORT, 'backup primary writer admission history is immutable'); END;

CREATE TRIGGER backup_primary_writer_admission_revocation_insert_guard
BEFORE INSERT ON backup_primary_writer_admission_revocation
WHEN NOT EXISTS (
    SELECT 1 FROM backup_primary_writer_admission a
    WHERE a.admission_ref = NEW.admission_ref AND a.admission_sha256 = NEW.admission_sha256
  ) OR EXISTS (
    SELECT 1 FROM backup_primary_writer_qualification q
    WHERE q.owner_admission_ref = NEW.admission_ref AND q.owner_admission_sha256 = NEW.admission_sha256
  )
BEGIN
  SELECT RAISE(ABORT, 'BACKUP_PRIMARY_ADMISSION_CANNOT_BE_REVOKED');
END;

CREATE TRIGGER backup_primary_writer_admission_revocation_immutable_update
BEFORE UPDATE ON backup_primary_writer_admission_revocation
BEGIN SELECT RAISE(ABORT, 'backup primary writer admission revocation is immutable'); END;

CREATE TRIGGER backup_primary_writer_admission_revocation_immutable_delete
BEFORE DELETE ON backup_primary_writer_admission_revocation
BEGIN SELECT RAISE(ABORT, 'backup primary writer admission revocation history is immutable'); END;

CREATE TRIGGER backup_primary_writer_admission_qualification_guard
BEFORE INSERT ON backup_primary_writer_qualification
WHEN NOT EXISTS (
    SELECT 1 FROM backup_primary_writer_admission a
    WHERE a.admission_ref = NEW.owner_admission_ref
      AND a.admission_sha256 = NEW.owner_admission_sha256
      AND a.protocol = 'eliotr.backup-primary-writer-admission.v1'
      AND a.purpose = 'BOOTSTRAP'
      AND a.client_class = 'owner_pwa'
      AND a.authentication_method = 'cloudflare_access'
      AND a.deployment_generation = NEW.controller_generation
      AND a.version_id = NEW.version_id
      AND a.bucket_binding_ref = NEW.bucket_binding_ref
      AND julianday(a.access_expires_at) > julianday('now')
      AND NOT EXISTS (
        SELECT 1 FROM backup_primary_writer_admission_revocation r
        WHERE r.admission_ref = a.admission_ref AND r.admission_sha256 = a.admission_sha256
      )
  ) OR EXISTS (
    SELECT 1 FROM backup_primary_writer_qualification q
    WHERE q.owner_admission_ref = NEW.owner_admission_ref
  )
BEGIN
  SELECT RAISE(ABORT, 'BACKUP_PRIMARY_ADMISSION_NOT_CURRENT_OR_ALREADY_CONSUMED');
END;
