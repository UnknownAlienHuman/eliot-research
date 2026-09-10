PRAGMA foreign_keys = ON;

CREATE TABLE artifact_draft_reservation (
  intent_id TEXT NOT NULL,
  intent_revision INTEGER NOT NULL CHECK (intent_revision > 0),
  artifact_id TEXT NOT NULL,
  artifact_revision INTEGER NOT NULL CHECK (artifact_revision > 0),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  planned_objects_json TEXT NOT NULL CHECK (json_valid(planned_objects_json) AND length(planned_objects_json) <= 65536),
  state TEXT NOT NULL CHECK (state IN ('RESERVED','FINALIZED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (intent_id, intent_revision),
  UNIQUE (artifact_id, artifact_revision),
  FOREIGN KEY (intent_id, intent_revision) REFERENCES operation_intent(intent_id, revision)
) STRICT;

CREATE TABLE artifact_draft_head (
  artifact_id TEXT PRIMARY KEY,
  head_revision INTEGER NOT NULL CHECK (head_revision > 0),
  manifest_r2_key TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  intent_revision INTEGER NOT NULL CHECK (intent_revision > 0),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (artifact_id, head_revision) REFERENCES artifact_revision(artifact_id, revision),
  FOREIGN KEY (intent_id, intent_revision) REFERENCES operation_intent(intent_id, revision)
) STRICT;

CREATE TABLE artifact_draft_binding (
  artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  intent_id TEXT NOT NULL,
  intent_revision INTEGER NOT NULL CHECK (intent_revision > 0),
  expected_head_revision INTEGER,
  principal_ref TEXT NOT NULL,
  spec_ref_id TEXT NOT NULL,
  spec_ref_revision INTEGER NOT NULL CHECK (spec_ref_revision > 0),
  scope_snapshot_id TEXT NOT NULL,
  scope_snapshot_revision INTEGER NOT NULL CHECK (scope_snapshot_revision > 0),
  manifest_r2_key TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  manifest_size_bytes INTEGER NOT NULL CHECK (manifest_size_bytes >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, revision),
  UNIQUE (intent_id, intent_revision),
  FOREIGN KEY (artifact_id, revision) REFERENCES artifact_revision(artifact_id, revision),
  FOREIGN KEY (intent_id, intent_revision) REFERENCES operation_intent(intent_id, revision)
) STRICT;

CREATE TABLE artifact_draft_object (
  artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  object_kind TEXT NOT NULL CHECK (object_kind IN ('MANIFEST','SECTION_BODY','DEPENDENCY_MANIFEST','EVIDENCE_LEDGER','VERIFICATION_RECEIPT','EXPORT')),
  object_ref TEXT NOT NULL,
  section_ordinal INTEGER,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json) AND length(receipt_json) <= 65536),
  residency_key_json TEXT NOT NULL CHECK (json_valid(residency_key_json) AND length(residency_key_json) <= 65536),
  residency_key_digest TEXT NOT NULL CHECK (length(residency_key_digest) = 64 AND residency_key_digest NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, revision, object_kind, object_ref),
  FOREIGN KEY (artifact_id, revision) REFERENCES artifact_revision(artifact_id, revision),
  CHECK ((object_kind = 'SECTION_BODY' AND section_ordinal IS NOT NULL AND section_ordinal >= 0) OR
         (object_kind <> 'SECTION_BODY' AND section_ordinal IS NULL))
) STRICT;

CREATE TRIGGER artifact_draft_binding_status_guard
BEFORE INSERT ON artifact_draft_binding
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM artifact_revision r
    WHERE r.artifact_id = NEW.artifact_id AND r.revision = NEW.revision AND r.status = 'DRAFT'
  ) THEN RAISE(ABORT, 'ARTIFACT_DRAFT_STATUS_CONFLICT') END;
END;

CREATE TRIGGER artifact_draft_binding_head_cas
AFTER INSERT ON artifact_draft_binding
BEGIN
  INSERT INTO artifact_draft_head(artifact_id, head_revision, manifest_r2_key, intent_id, intent_revision, updated_at)
  VALUES (NEW.artifact_id, NEW.revision, NEW.manifest_r2_key, NEW.intent_id, NEW.intent_revision, NEW.created_at)
  ON CONFLICT(artifact_id) DO UPDATE SET
    head_revision = excluded.head_revision,
    manifest_r2_key = excluded.manifest_r2_key,
    intent_id = excluded.intent_id,
    intent_revision = excluded.intent_revision,
    updated_at = excluded.updated_at
  WHERE artifact_draft_head.head_revision = NEW.expected_head_revision;
  SELECT CASE WHEN changes() <> 1 THEN RAISE(ABORT, 'ARTIFACT_DRAFT_HEAD_CONFLICT') END;
END;

CREATE INDEX artifact_draft_object_ref_idx ON artifact_draft_object(object_ref);
