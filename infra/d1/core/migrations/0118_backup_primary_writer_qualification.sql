-- ER-34 isolated primary-writer qualification. Authority is installed only by
-- the reviewed native operator; Worker/runtime code has SELECT-only access.
PRAGMA foreign_keys = ON;

CREATE TABLE backup_primary_writer_qualification (
  qualification_ref TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  protocol TEXT NOT NULL CHECK (protocol = 'eliotr.backup-primary-writer-qualification.v1'),
  mode TEXT NOT NULL CHECK (mode IN ('ISOLATED_NEW_BUCKET','LEGACY_WRITERS_DRAINED')),
  authority_json TEXT NOT NULL CHECK (json_valid(authority_json) AND length(CAST(authority_json AS BLOB)) BETWEEN 2 AND 131072),
  authority_sha256 TEXT NOT NULL CHECK (length(authority_sha256)=64 AND authority_sha256 NOT GLOB '*[^0-9a-f]*'),
  owner_admission_ref TEXT NOT NULL,
  owner_admission_sha256 TEXT NOT NULL CHECK (length(owner_admission_sha256)=64 AND owner_admission_sha256 NOT GLOB '*[^0-9a-f]*'),
  erasure_mode TEXT NOT NULL CHECK (erasure_mode IN ('NO_ACTIVE_ERASURE','FENCED')),
  erasure_id TEXT,
  erasure_revision INTEGER CHECK (erasure_revision IS NULL OR erasure_revision > 0),
  erasure_fence_json TEXT CHECK (erasure_fence_json IS NULL OR json_valid(erasure_fence_json)),
  erasure_request_sha256 TEXT CHECK (erasure_request_sha256 IS NULL OR (length(erasure_request_sha256)=64 AND erasure_request_sha256 NOT GLOB '*[^0-9a-f]*')),
  producer_claim_count INTEGER NOT NULL CHECK (producer_claim_count >= 0),
  producer_claim_digest TEXT NOT NULL CHECK (length(producer_claim_digest)=64 AND producer_claim_digest NOT GLOB '*[^0-9a-f]*'),
  export_cut_count INTEGER NOT NULL CHECK (export_cut_count >= 0),
  export_cut_digest TEXT NOT NULL CHECK (length(export_cut_digest)=64 AND export_cut_digest NOT GLOB '*[^0-9a-f]*'),
  primary_prefix_count INTEGER NOT NULL CHECK (primary_prefix_count >= 0),
  primary_prefix_digest TEXT NOT NULL CHECK (length(primary_prefix_digest)=64 AND primary_prefix_digest NOT GLOB '*[^0-9a-f]*'),
  account_id TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  version_etag TEXT NOT NULL,
  controller_generation TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  configuration_sha256 TEXT NOT NULL CHECK (length(configuration_sha256)=64 AND configuration_sha256 NOT GLOB '*[^0-9a-f]*'),
  compiled_artifact_sha256 TEXT NOT NULL CHECK (length(compiled_artifact_sha256)=64 AND compiled_artifact_sha256 NOT GLOB '*[^0-9a-f]*'),
  bucket_binding_ref TEXT NOT NULL,
  bucket_name TEXT NOT NULL,
  reserved_prefix TEXT NOT NULL CHECK (reserved_prefix = 'backup-parts/'),
  bootstrap_zero_d1_ref TEXT NOT NULL,
  bootstrap_zero_d1_json TEXT NOT NULL CHECK (json_valid(bootstrap_zero_d1_json)),
  bootstrap_zero_d1_sha256 TEXT NOT NULL CHECK (length(bootstrap_zero_d1_sha256)=64 AND bootstrap_zero_d1_sha256 NOT GLOB '*[^0-9a-f]*'),
  reserved_prefix_readback_ref TEXT NOT NULL,
  reserved_prefix_readback_sha256 TEXT NOT NULL CHECK (length(reserved_prefix_readback_sha256)=64 AND reserved_prefix_readback_sha256 NOT GLOB '*[^0-9a-f]*'),
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (qualification_ref, revision),
  UNIQUE (qualification_ref, revision, authority_sha256),
  CHECK ((erasure_mode = 'NO_ACTIVE_ERASURE' AND erasure_id IS NULL AND erasure_revision IS NULL AND erasure_fence_json IS NULL AND erasure_request_sha256 IS NULL)
    OR (erasure_mode = 'FENCED' AND erasure_id IS NOT NULL AND erasure_revision IS NOT NULL AND erasure_fence_json IS NOT NULL AND erasure_request_sha256 IS NOT NULL))
) STRICT;

CREATE TABLE backup_primary_writer_operation (
  operation_ref TEXT PRIMARY KEY,
  qualification_ref TEXT NOT NULL,
  qualification_revision INTEGER NOT NULL CHECK (qualification_revision > 0),
  intent_ref TEXT NOT NULL,
  intent_revision INTEGER NOT NULL CHECK (intent_revision > 0),
  intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
  intent_sha256 TEXT NOT NULL CHECK (length(intent_sha256)=64 AND intent_sha256 NOT GLOB '*[^0-9a-f]*'),
  attempt_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  attempt_json TEXT NOT NULL CHECK (json_valid(attempt_json)),
  attempt_sha256 TEXT NOT NULL CHECK (length(attempt_sha256)=64 AND attempt_sha256 NOT GLOB '*[^0-9a-f]*'),
  receipt_ref TEXT NOT NULL,
  operation_json TEXT NOT NULL CHECK (json_valid(operation_json)),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  receipt_sha256 TEXT NOT NULL CHECK (length(receipt_sha256)=64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
  readback_receipt_ref TEXT NOT NULL,
  readback_sha256 TEXT NOT NULL CHECK (length(readback_sha256)=64 AND readback_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('ADMITTED','UNKNOWN','COMMITTED','BLOCKED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (qualification_ref, qualification_revision)
    REFERENCES backup_primary_writer_qualification(qualification_ref, revision)
) STRICT;

CREATE TABLE backup_primary_writer_current (
  slot TEXT PRIMARY KEY CHECK (slot = 'primary'),
  qualification_ref TEXT NOT NULL,
  qualification_revision INTEGER NOT NULL CHECK (qualification_revision > 0),
  qualification_sha256 TEXT NOT NULL CHECK (length(qualification_sha256)=64 AND qualification_sha256 NOT GLOB '*[^0-9a-f]*'),
  controller_generation TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ACTIVE','DRAINING','RETIRED')),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (qualification_ref, qualification_revision, qualification_sha256)
    REFERENCES backup_primary_writer_qualification(qualification_ref, revision, authority_sha256)
) STRICT;

CREATE INDEX backup_primary_writer_operation_qualification
  ON backup_primary_writer_operation(qualification_ref, qualification_revision, state);

CREATE TRIGGER backup_primary_writer_bootstrap_guard
BEFORE INSERT ON backup_primary_writer_qualification
WHEN NEW.mode = 'ISOLATED_NEW_BUCKET' AND (
  NEW.erasure_mode <> 'NO_ACTIVE_ERASURE' OR
  NEW.producer_claim_count <> 0 OR NEW.export_cut_count <> 0 OR NEW.primary_prefix_count <> 0 OR
  EXISTS (SELECT 1 FROM erasure_case) OR EXISTS (SELECT 1 FROM erasure_execution)
)
BEGIN
  SELECT RAISE(ABORT, 'BACKUP_PRIMARY_BOOTSTRAP_BASELINE_NOT_ZERO');
END;

CREATE TRIGGER backup_primary_writer_qualification_immutable_update
BEFORE UPDATE ON backup_primary_writer_qualification
BEGIN SELECT RAISE(ABORT, 'backup primary qualification is immutable'); END;

CREATE TRIGGER backup_primary_writer_qualification_immutable_delete
BEFORE DELETE ON backup_primary_writer_qualification
BEGIN SELECT RAISE(ABORT, 'backup primary qualification history is immutable'); END;

CREATE TRIGGER backup_primary_writer_operation_immutable_update
BEFORE UPDATE ON backup_primary_writer_operation
BEGIN SELECT RAISE(ABORT, 'backup primary operation is immutable'); END;

CREATE TRIGGER backup_primary_writer_operation_immutable_delete
BEFORE DELETE ON backup_primary_writer_operation
BEGIN SELECT RAISE(ABORT, 'backup primary operation history is immutable'); END;

CREATE TRIGGER backup_primary_writer_current_delete_guard
BEFORE DELETE ON backup_primary_writer_current
BEGIN SELECT RAISE(ABORT, 'backup primary current authority cannot be deleted'); END;

CREATE TRIGGER backup_primary_writer_current_transition_guard
BEFORE UPDATE ON backup_primary_writer_current
BEGIN
  SELECT CASE WHEN NEW.slot IS NOT OLD.slot OR NEW.qualification_ref IS NOT OLD.qualification_ref OR
    NEW.qualification_revision IS NOT OLD.qualification_revision OR NEW.qualification_sha256 IS NOT OLD.qualification_sha256 OR
    NEW.controller_generation IS NOT OLD.controller_generation OR NOT (
      (OLD.state = 'ACTIVE' AND NEW.state = 'DRAINING') OR
      (OLD.state = 'DRAINING' AND NEW.state = 'RETIRED')
    ) THEN RAISE(ABORT, 'invalid backup primary authority transition') END;
END;
