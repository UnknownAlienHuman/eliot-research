PRAGMA foreign_keys = ON;

CREATE TABLE artifact_draft_reservation (
  intent_id TEXT NOT NULL,
  intent_revision INTEGER NOT NULL CHECK (intent_revision > 0),
  artifact_id TEXT NOT NULL,
  artifact_revision INTEGER NOT NULL CHECK (artifact_revision > 0),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  spec_digest TEXT NOT NULL CHECK (length(spec_digest) = 64 AND spec_digest NOT GLOB '*[^0-9a-f]*'),
  manifest_r2_key TEXT NOT NULL,
  expected_head_revision INTEGER,
  spec_ref_id TEXT NOT NULL,
  spec_ref_revision INTEGER NOT NULL CHECK (spec_ref_revision > 0),
  scope_snapshot_id TEXT NOT NULL,
  scope_snapshot_revision INTEGER NOT NULL CHECK (scope_snapshot_revision > 0),
  intent_json TEXT NOT NULL CHECK (json_valid(intent_json) AND length(intent_json) <= 65536),
  principal_ref TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  topic TEXT NOT NULL,
  planned_objects_json TEXT NOT NULL CHECK (json_valid(planned_objects_json) AND length(planned_objects_json) <= 65536),
  state TEXT NOT NULL CHECK (state IN ('RESERVED','FINALIZED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (intent_id, intent_revision),
  UNIQUE (artifact_id, artifact_revision)
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
BEFORE INSERT ON artifact_draft_binding
WHEN NOT EXISTS (SELECT 1 FROM artifact_draft_head WHERE artifact_id = NEW.artifact_id)
  AND NEW.expected_head_revision IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_DRAFT_HEAD_CONFLICT');
END;

CREATE TRIGGER artifact_draft_binding_head_cas_apply
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

CREATE TRIGGER artifact_draft_reservation_finalize_guard
AFTER UPDATE OF state ON artifact_draft_reservation
WHEN NEW.state = 'FINALIZED'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM operation_intent i
    WHERE i.intent_id = NEW.intent_id AND i.revision = NEW.intent_revision
      AND i.operation_kind = 'REPORT'
      AND i.principal_ref = NEW.principal_ref
      AND i.idempotency_key = NEW.idempotency_key
      AND i.payload_ref = NEW.payload_ref
      AND json_extract(NEW.intent_json, '$.intent_ref.id') = i.intent_id
      AND json_extract(NEW.intent_json, '$.intent_ref.revision') = i.revision
      AND json_extract(NEW.intent_json, '$.operation_kind') = i.operation_kind
      AND json_extract(NEW.intent_json, '$.principal_ref') = i.principal_ref
      AND json_extract(NEW.intent_json, '$.idempotency_key') = i.idempotency_key
      AND json_extract(NEW.intent_json, '$.payload_ref') = i.payload_ref
      AND json_extract(NEW.intent_json, '$.policy_decision_ref') = i.policy_decision_ref
      AND ((json_extract(NEW.intent_json, '$.budget_reservation_ref') = i.budget_reservation_ref)
        OR (json_extract(NEW.intent_json, '$.budget_reservation_ref') IS NULL AND i.budget_reservation_ref IS NULL))
      AND ((json_extract(NEW.intent_json, '$.cancellation_ref') = i.cancellation_ref)
        OR (json_extract(NEW.intent_json, '$.cancellation_ref') IS NULL AND i.cancellation_ref IS NULL))
      AND json_extract(NEW.intent_json, '$.created_at') = i.created_at
  ) THEN RAISE(ABORT, 'ARTIFACT_DRAFT_INTENT_GUARD') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM outbox o
    WHERE o.intent_id = NEW.intent_id AND o.intent_revision = NEW.intent_revision
      AND o.topic = NEW.topic
      AND o.payload_ref = NEW.payload_ref
      AND o.payload_sha256 = json_extract(NEW.planned_objects_json, '$[0].sha256')
  ) THEN RAISE(ABORT, 'ARTIFACT_DRAFT_OUTBOX_GUARD') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM artifact_revision r
    WHERE r.artifact_id = NEW.artifact_id AND r.revision = NEW.artifact_revision
      AND r.status = 'DRAFT'
      AND r.manifest_r2_key = NEW.manifest_r2_key
      AND r.spec_digest = NEW.spec_digest
  ) THEN RAISE(ABORT, 'ARTIFACT_DRAFT_REVISION_GUARD') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM artifact_draft_binding b
    WHERE b.artifact_id = NEW.artifact_id AND b.revision = NEW.artifact_revision
      AND b.intent_id = NEW.intent_id AND b.intent_revision = NEW.intent_revision
      AND b.principal_ref = NEW.principal_ref
      AND b.expected_head_revision IS NEW.expected_head_revision
      AND b.spec_ref_id = NEW.spec_ref_id
      AND b.spec_ref_revision = NEW.spec_ref_revision
      AND b.scope_snapshot_id = NEW.scope_snapshot_id
      AND b.scope_snapshot_revision = NEW.scope_snapshot_revision
      AND b.manifest_r2_key = NEW.manifest_r2_key
      AND b.manifest_sha256 = json_extract(NEW.planned_objects_json, '$[0].sha256')
      AND b.manifest_size_bytes = json_extract(NEW.planned_objects_json, '$[0].size_bytes')
  ) THEN RAISE(ABORT, 'ARTIFACT_DRAFT_BINDING_GUARD') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM artifact_draft_head h
    WHERE h.artifact_id = NEW.artifact_id
      AND h.head_revision = NEW.artifact_revision
      AND h.manifest_r2_key = NEW.manifest_r2_key
      AND h.intent_id = NEW.intent_id
      AND h.intent_revision = NEW.intent_revision
      AND h.updated_at = NEW.updated_at
  ) THEN RAISE(ABORT, 'ARTIFACT_DRAFT_HEAD_GUARD') END;
  SELECT CASE WHEN (SELECT COUNT(*) FROM artifact_draft_object WHERE artifact_id = NEW.artifact_id AND revision = NEW.artifact_revision)
      <> json_array_length(NEW.planned_objects_json)
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.planned_objects_json) p
      WHERE NOT EXISTS (
        SELECT 1 FROM artifact_draft_object o
        WHERE o.artifact_id = NEW.artifact_id AND o.revision = NEW.artifact_revision
          AND o.object_kind = json_extract(p.value, '$.object_kind')
          AND o.object_ref = json_extract(p.value, '$.object_ref')
          AND ((o.section_ordinal = json_extract(p.value, '$.section_ordinal')) OR (o.section_ordinal IS NULL AND json_extract(p.value, '$.section_ordinal') IS NULL))
          AND o.residency_key_digest = json_extract(p.value, '$.residency_digest')
          AND o.residency_key_json = json_extract(p.value, '$.residency')
          AND json_extract(o.receipt_json, '$.key') = json_extract(p.value, '$.key')
          AND json_extract(o.receipt_json, '$.expected_sha256') = json_extract(p.value, '$.sha256')
          AND json_extract(o.receipt_json, '$.readback_sha256') = json_extract(p.value, '$.sha256')
          AND json_extract(o.receipt_json, '$.size_bytes') = json_extract(p.value, '$.size_bytes')
      )
    ) THEN RAISE(ABORT, 'ARTIFACT_DRAFT_OBJECT_GUARD') END;
END;

CREATE INDEX artifact_draft_object_ref_idx ON artifact_draft_object(object_ref);
