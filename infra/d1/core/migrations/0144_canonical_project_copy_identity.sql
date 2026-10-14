-- Canonical source identity and physical project-copy authority.
-- Preserve every existing PRIMARY KEY and UNIQUE constraint. No UNIQUE is dropped.
-- The five provider custom metadata fields remain unchanged; folder stays inside provider_key.
PRAGMA foreign_keys = ON;

-- This digest is a server-computed value bound to the existing immutable target pin.
-- Historical rows retain NULL and continue through the legacy flat metadata branch.
ALTER TABLE projection_generation ADD COLUMN managed_target_metadata_generation_digest TEXT
  CHECK (managed_target_metadata_generation_digest IS NULL OR (
    length(managed_target_metadata_generation_digest) = 64
    AND managed_target_metadata_generation_digest NOT GLOB '*[^0-9a-f]*'
  ));

CREATE TRIGGER projection_generation_target_metadata_digest_insert_guard
BEFORE INSERT ON projection_generation
WHEN (NEW.managed_item_protocol IS 'eliotr.managed-item-effects.v1'
    AND (NEW.managed_target_metadata_generation_digest IS NULL
      OR length(NEW.managed_target_metadata_generation_digest) <> 64
      OR NEW.managed_target_metadata_generation_digest GLOB '*[^0-9a-f]*'))
  OR (NEW.managed_item_protocol IS NULL
    AND NEW.managed_target_metadata_generation_digest IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_TARGET_METADATA_DIGEST_INVALID');
END;

CREATE TRIGGER projection_generation_target_metadata_digest_immutable
BEFORE UPDATE OF managed_target_metadata_generation_digest ON projection_generation
WHEN NEW.managed_target_metadata_generation_digest IS NOT OLD.managed_target_metadata_generation_digest
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_TARGET_METADATA_DIGEST_IMMUTABLE');
END;

-- Keep the delivery/execution generation while recording the canonical D1/R2 identity
-- and the separately counted physical project-copy set.
ALTER TABLE projection_generation ADD COLUMN canonical_projection_generation TEXT
  CHECK (canonical_projection_generation IS NULL OR
    length(canonical_projection_generation) BETWEEN 1 AND 256);
ALTER TABLE projection_generation ADD COLUMN canonical_item_count INTEGER
  CHECK (canonical_item_count IS NULL OR canonical_item_count BETWEEN 1 AND 1024);
ALTER TABLE projection_generation ADD COLUMN canonical_item_set_digest TEXT
  CHECK (canonical_item_set_digest IS NULL OR (
    length(canonical_item_set_digest) = 64
    AND canonical_item_set_digest NOT GLOB '*[^0-9a-f]*'
  ));
ALTER TABLE projection_generation ADD COLUMN provider_copy_count INTEGER
  CHECK (provider_copy_count IS NULL OR provider_copy_count BETWEEN 0 AND 256);
ALTER TABLE projection_generation ADD COLUMN provider_copy_set_digest TEXT
  CHECK (provider_copy_set_digest IS NULL OR (
    length(provider_copy_set_digest) = 64
    AND provider_copy_set_digest NOT GLOB '*[^0-9a-f]*'
  ));

-- New rows bind all five fields atomically at materialization. Historical rows keep
-- NULLs and are never reinterpreted as PROJECT_COPY_V1.
CREATE TRIGGER projection_generation_copy_identity_insert_guard
BEFORE INSERT ON projection_generation
WHEN NEW.canonical_projection_generation IS NOT NULL
  OR NEW.canonical_item_count IS NOT NULL
  OR NEW.canonical_item_set_digest IS NOT NULL
  OR NEW.provider_copy_count IS NOT NULL
  OR NEW.provider_copy_set_digest IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_COPY_IDENTITY_INSERT_DENIED');
END;

CREATE TRIGGER projection_generation_copy_identity_complete
BEFORE UPDATE OF canonical_projection_generation, canonical_item_count,
  canonical_item_set_digest, provider_copy_count, provider_copy_set_digest
ON projection_generation
WHEN NOT (
  (NEW.canonical_projection_generation IS NULL
    AND NEW.canonical_item_count IS NULL
    AND NEW.canonical_item_set_digest IS NULL
    AND NEW.provider_copy_count IS NULL
    AND NEW.provider_copy_set_digest IS NULL)
  OR
  (NEW.canonical_projection_generation IS NOT NULL
    AND NEW.canonical_item_count IS NOT NULL
    AND NEW.canonical_item_set_digest IS NOT NULL
    AND NEW.provider_copy_count IS NOT NULL
    AND NEW.provider_copy_set_digest IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_COPY_IDENTITY_INCOMPLETE');
END;

-- First binding is permitted only on the fenced PREPARING -> MATERIALIZED
-- transition and canonical count/digest are aliases of the original Work receipt.
CREATE TRIGGER projection_generation_copy_identity_phase_guard
BEFORE UPDATE OF canonical_projection_generation, canonical_item_count,
  canonical_item_set_digest, provider_copy_count, provider_copy_set_digest
ON projection_generation
WHEN (
  NEW.canonical_projection_generation IS NOT OLD.canonical_projection_generation
  OR NEW.canonical_item_count IS NOT OLD.canonical_item_count
  OR NEW.canonical_item_set_digest IS NOT OLD.canonical_item_set_digest
  OR NEW.provider_copy_count IS NOT OLD.provider_copy_count
  OR NEW.provider_copy_set_digest IS NOT OLD.provider_copy_set_digest
)
AND NOT (
  OLD.state IS 'PREPARING'
  AND NEW.state IS 'MATERIALIZED'
  AND OLD.canonical_projection_generation IS NULL
  AND OLD.canonical_item_count IS NULL
  AND OLD.canonical_item_set_digest IS NULL
  AND OLD.provider_copy_count IS NULL
  AND OLD.provider_copy_set_digest IS NULL
  AND NEW.canonical_projection_generation IS NOT NULL
  AND NEW.canonical_item_count IS NEW.item_count
  AND NEW.canonical_item_set_digest IS NEW.item_set_digest
  AND NEW.provider_copy_count IS NOT NULL
  AND NEW.provider_copy_set_digest IS NOT NULL
  AND NEW.item_count IS NOT NULL
  AND NEW.item_set_digest IS NOT NULL
  AND NEW.work_manifest_ref IS NOT NULL
  AND NEW.work_manifest_sha256 IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_COPY_IDENTITY_PHASE_DENIED');
END;

CREATE TRIGGER projection_generation_copy_identity_immutable
BEFORE UPDATE OF canonical_projection_generation, canonical_item_count,
  canonical_item_set_digest, provider_copy_count, provider_copy_set_digest
ON projection_generation
WHEN OLD.canonical_projection_generation IS NOT NULL AND (
  NEW.canonical_projection_generation IS NOT OLD.canonical_projection_generation
  OR NEW.canonical_item_count IS NOT OLD.canonical_item_count
  OR NEW.canonical_item_set_digest IS NOT OLD.canonical_item_set_digest
  OR NEW.provider_copy_count IS NOT OLD.provider_copy_count
  OR NEW.provider_copy_set_digest IS NOT OLD.provider_copy_set_digest
)
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_COPY_IDENTITY_IMMUTABLE');
END;

-- Canonical count/digest are aliases of the existing Work receipt, so once the
-- copy identity is bound the original Work tuple cannot drift independently.
CREATE TRIGGER projection_generation_copy_identity_work_immutable
BEFORE UPDATE OF item_count, item_set_digest, work_manifest_ref, work_manifest_sha256
ON projection_generation
WHEN OLD.canonical_projection_generation IS NOT NULL AND (
  NEW.item_count IS NOT OLD.item_count
  OR NEW.item_set_digest IS NOT OLD.item_set_digest
  OR NEW.work_manifest_ref IS NOT OLD.work_manifest_ref
  OR NEW.work_manifest_sha256 IS NOT OLD.work_manifest_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_COPY_WORK_RECEIPT_IMMUTABLE');
END;

-- The existing effect table is also the exact provider intent/readback record.
-- Rebuild only to allow provider_key to be the full folder path and to bind each
-- provider copy back to its canonical section and project membership. The old
-- flat-key rows are copied byte-for-byte with NULL copy fields.
DROP TRIGGER projection_managed_item_effect_insert_guard;
DROP TRIGGER projection_managed_item_effect_update_guard;
DROP TRIGGER projection_managed_item_effect_no_delete;
DROP TRIGGER projection_managed_item_effect_target_pin_insert_guard;
DROP INDEX projection_managed_item_effect_state_idx;
ALTER TABLE projection_managed_item_effect
  RENAME TO projection_managed_item_effect_legacy_0144;

CREATE TABLE projection_managed_item_effect (
  source_revision_ref TEXT NOT NULL,
  projection_generation TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES job(job_id),
  item_key TEXT NOT NULL,
  canonical_projection_generation TEXT,
  canonical_item_key TEXT,
  project_id TEXT,
  project_membership_id TEXT,
  membership_generation INTEGER CHECK (membership_generation IS NULL OR membership_generation > 0),
  copy_layout TEXT CHECK (
    copy_layout IS NULL OR copy_layout = 'PROJECT_COPY_V1'
  ),
  metadata_generation_digest TEXT CHECK (metadata_generation_digest IS NULL OR (
    length(metadata_generation_digest) = 64
    AND metadata_generation_digest NOT GLOB '*[^0-9a-f]*'
  )),
  canonical_body_ref TEXT,
  canonical_body_sha256 TEXT CHECK (canonical_body_sha256 IS NULL OR (
    length(canonical_body_sha256) = 64
    AND canonical_body_sha256 NOT GLOB '*[^0-9a-f]*'
  )),
  desired_index INTEGER NOT NULL CHECK (desired_index >= 0),
  normalized_start_byte INTEGER NOT NULL CHECK (normalized_start_byte >= 0),
  normalized_end_byte INTEGER NOT NULL CHECK (normalized_end_byte > normalized_start_byte),
  intent_id TEXT NOT NULL,
  intent_revision INTEGER NOT NULL CHECK (intent_revision > 0),
  attempt_id TEXT NOT NULL REFERENCES operation_attempt(attempt_id),
  execution_operation_id TEXT NOT NULL REFERENCES operation_execution_lease(operation_id),
  dispatch_lease_generation INTEGER CHECK (
    dispatch_lease_generation IS NULL OR dispatch_lease_generation >= 1
  ),
  managed_instance_id TEXT NOT NULL,
  managed_generation TEXT NOT NULL,
  provider_source TEXT NOT NULL CHECK (provider_source = 'builtin'),
  provider_key TEXT NOT NULL,
  section_content_sha256 TEXT NOT NULL CHECK (
    length(section_content_sha256) = 64 AND section_content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  document_sha256 TEXT NOT NULL CHECK (
    length(document_sha256) = 64 AND document_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  document_size_bytes INTEGER NOT NULL CHECK (document_size_bytes BETWEEN 1 AND 4194304),
  metadata_json TEXT NOT NULL CHECK (
    json_valid(metadata_json) AND json_type(metadata_json) IS 'object'
    AND json_type(metadata_json, '$.canonical_section_id') IS 'text'
    AND json_type(metadata_json, '$.content_sha256') IS 'text'
    AND json_type(metadata_json, '$.instruction_taint') IS 'text'
    AND json_type(metadata_json, '$.projection_generation') IS 'text'
    AND json_type(metadata_json, '$.source_revision_ref') IS 'text'
    AND json_remove(metadata_json, '$.canonical_section_id', '$.content_sha256',
      '$.instruction_taint', '$.projection_generation', '$.source_revision_ref') IS '{}'
  ),
  state TEXT NOT NULL CHECK (state IN (
    'INTENT', 'DISPATCHED', 'UNKNOWN', 'READBACK_VERIFIED'
  )),
  provider_item_id TEXT,
  readback_receipt_json TEXT CHECK (
    readback_receipt_json IS NULL OR (
      json_valid(readback_receipt_json) AND json_type(readback_receipt_json) IS 'object'
      AND json_type(readback_receipt_json, '$.item_key') IS 'text'
      AND json_extract(readback_receipt_json, '$.item_key') IS item_key
      AND json_type(readback_receipt_json, '$.provider_item_id') IS 'text'
      AND json_extract(readback_receipt_json, '$.provider_item_id') IS provider_item_id
      AND json_type(readback_receipt_json, '$.provider_key') IS 'text'
      AND json_extract(readback_receipt_json, '$.provider_key') IS provider_key
      AND json_type(readback_receipt_json, '$.file_size') IS 'integer'
      AND json_extract(readback_receipt_json, '$.file_size') IS document_size_bytes
      AND json_type(readback_receipt_json, '$.chunks_count') IS 'integer'
      AND json_extract(readback_receipt_json, '$.chunks_count') > 0
      AND json_type(readback_receipt_json, '$.content_sha256') IS 'text'
      AND json_extract(readback_receipt_json, '$.content_sha256') IS document_sha256
      AND json_type(readback_receipt_json, '$.readback_sha256') IS 'text'
      AND json_extract(readback_receipt_json, '$.readback_sha256') IS readback_sha256
      AND json_remove(readback_receipt_json, '$.chunks_count', '$.content_sha256',
        '$.file_size', '$.item_key', '$.provider_item_id', '$.provider_key',
        '$.readback_sha256') IS '{}'
    )
  ),
  readback_sha256 TEXT CHECK (
    readback_sha256 IS NULL OR (
      length(readback_sha256) = 64 AND readback_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_revision_ref, projection_generation, item_key),
  UNIQUE (job_id, projection_generation, item_key),
  UNIQUE (source_revision_ref, projection_generation, desired_index),
  FOREIGN KEY (source_revision_ref, projection_generation)
    REFERENCES projection_generation(source_revision_ref, projection_generation),
  FOREIGN KEY (intent_id, intent_revision)
    REFERENCES operation_intent(intent_id, revision),
  CHECK (
    (copy_layout IS NULL
      AND canonical_projection_generation IS NULL
      AND canonical_item_key IS NULL
      AND project_id IS NULL
      AND project_membership_id IS NULL
      AND membership_generation IS NULL
      AND metadata_generation_digest IS NULL
      AND canonical_body_ref IS NULL
      AND canonical_body_sha256 IS NULL
      AND provider_key = item_key || '.md')
    OR
    (copy_layout = 'PROJECT_COPY_V1'
      AND canonical_projection_generation IS NOT NULL
      AND length(canonical_projection_generation) BETWEEN 1 AND 256
      AND canonical_item_key IS NOT NULL
      AND length(canonical_item_key) BETWEEN 1 AND 256
      AND project_id IS NOT NULL
      AND length(project_id) BETWEEN 1 AND 256
      AND project_membership_id IS NOT NULL
      AND length(project_membership_id) BETWEEN 1 AND 256
      AND membership_generation IS NOT NULL
      AND membership_generation > 0
      AND project_membership_id = 'project:' || project_id || ':generation:' || membership_generation
      AND metadata_generation_digest IS NOT NULL
      AND canonical_body_ref IS NOT NULL
      AND length(canonical_body_ref) BETWEEN 1 AND 2048
      AND canonical_body_sha256 IS section_content_sha256
      AND length(provider_key) BETWEEN 12 AND 128
      AND substr(provider_key, 1, 11) = 'projection/'
      AND substr(provider_key, -3) = '.md'
      AND instr(provider_key, '//') = 0
      AND instr('/' || provider_key || '/', '/../') = 0
      AND instr('/' || provider_key || '/', '/./') = 0
      AND substr(provider_key, 1, 1) <> '/'
      AND substr(provider_key, -1) <> '/')),
  CHECK (
    (state = 'INTENT' AND dispatch_lease_generation IS NULL)
    OR (state <> 'INTENT' AND dispatch_lease_generation IS NOT NULL)
  ),
  CHECK (
    (state = 'READBACK_VERIFIED' AND provider_item_id IS NOT NULL
      AND readback_receipt_json IS NOT NULL AND readback_sha256 IS NOT NULL)
    OR (state <> 'READBACK_VERIFIED' AND readback_receipt_json IS NULL
      AND readback_sha256 IS NULL)
  ),
  CHECK (json_extract(metadata_json, '$.source_revision_ref') IS source_revision_ref),
  CHECK (json_extract(metadata_json, '$.canonical_section_id') IS NOT NULL
    AND json_extract(metadata_json, '$.canonical_section_id') <> ''),
  CHECK (json_extract(metadata_json, '$.content_sha256') IS section_content_sha256),
  CHECK (
    (copy_layout IS NULL
      AND json_extract(metadata_json, '$.projection_generation') IS managed_generation)
    OR
    (copy_layout = 'PROJECT_COPY_V1'
      AND json_extract(metadata_json, '$.projection_generation') IS metadata_generation_digest)
  )
) STRICT;

INSERT INTO projection_managed_item_effect (
  source_revision_ref, projection_generation, job_id, item_key,
  canonical_projection_generation, canonical_item_key, project_id, project_membership_id,
  membership_generation, copy_layout, metadata_generation_digest, canonical_body_ref,
  canonical_body_sha256,
  desired_index, normalized_start_byte, normalized_end_byte, intent_id, intent_revision,
  attempt_id, execution_operation_id, dispatch_lease_generation, managed_instance_id,
  managed_generation, provider_source, provider_key, section_content_sha256, document_sha256,
  document_size_bytes, metadata_json, state, provider_item_id, readback_receipt_json,
  readback_sha256, created_at, updated_at
)
SELECT
  source_revision_ref, projection_generation, job_id, item_key,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  desired_index, normalized_start_byte, normalized_end_byte, intent_id, intent_revision,
  attempt_id, execution_operation_id, dispatch_lease_generation, managed_instance_id,
  managed_generation, provider_source, provider_key, section_content_sha256, document_sha256,
  document_size_bytes, metadata_json, state, provider_item_id, readback_receipt_json,
  readback_sha256, created_at, updated_at
FROM projection_managed_item_effect_legacy_0144;

DROP TABLE projection_managed_item_effect_legacy_0144;

CREATE INDEX projection_managed_item_effect_state_idx
  ON projection_managed_item_effect(job_id, projection_generation, state, item_key);
CREATE INDEX projection_managed_item_effect_copy_lookup_idx
  ON projection_managed_item_effect(
    source_revision_ref, canonical_projection_generation, project_membership_id,
    canonical_item_key, managed_instance_id, managed_generation
  ) WHERE copy_layout = 'PROJECT_COPY_V1';

CREATE TRIGGER projection_managed_item_effect_insert_guard
BEFORE INSERT ON projection_managed_item_effect
WHEN NOT EXISTS (
  SELECT 1 FROM projection_generation g
  JOIN operation_attempt a ON a.attempt_id = NEW.attempt_id
  WHERE g.source_revision_ref = NEW.source_revision_ref
    AND g.projection_generation = NEW.projection_generation
    AND g.job_id = NEW.job_id
    AND a.intent_id = NEW.intent_id
    AND a.intent_revision = NEW.intent_revision
    AND (
      NEW.copy_layout IS NULL
      OR (
        g.canonical_projection_generation IS NEW.canonical_projection_generation
        AND g.canonical_item_count IS g.item_count
        AND g.canonical_item_set_digest IS g.item_set_digest
        AND g.provider_copy_count BETWEEN 1 AND 256
        AND g.managed_target_metadata_generation_digest IS NEW.metadata_generation_digest
        AND NEW.metadata_generation_digest IS g.managed_target_metadata_generation_digest
        AND EXISTS (
          SELECT 1 FROM source_revision sr
          JOIN project_source_membership m ON m.source_id = sr.source_id
          JOIN project p ON p.project_id = m.project_id
          WHERE sr.source_revision_ref = NEW.source_revision_ref
            AND m.project_id = NEW.project_id
            AND m.valid_to IS NULL
            AND m.membership_generation = NEW.membership_generation
            AND p.membership_generation = NEW.membership_generation
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_MANAGED_ITEM_IDENTITY_INVALID');
END;

CREATE TRIGGER projection_managed_item_effect_update_guard
BEFORE UPDATE ON projection_managed_item_effect
WHEN NEW.source_revision_ref <> OLD.source_revision_ref
  OR NEW.projection_generation <> OLD.projection_generation
  OR NEW.job_id <> OLD.job_id
  OR NEW.item_key <> OLD.item_key
  OR NEW.canonical_projection_generation IS NOT OLD.canonical_projection_generation
  OR NEW.canonical_item_key IS NOT OLD.canonical_item_key
  OR NEW.project_id IS NOT OLD.project_id
  OR NEW.project_membership_id IS NOT OLD.project_membership_id
  OR NEW.membership_generation IS NOT OLD.membership_generation
  OR NEW.copy_layout IS NOT OLD.copy_layout
  OR NEW.metadata_generation_digest IS NOT OLD.metadata_generation_digest
  OR NEW.canonical_body_ref IS NOT OLD.canonical_body_ref
  OR NEW.canonical_body_sha256 IS NOT OLD.canonical_body_sha256
  OR NEW.desired_index <> OLD.desired_index
  OR NEW.normalized_start_byte <> OLD.normalized_start_byte
  OR NEW.normalized_end_byte <> OLD.normalized_end_byte
  OR NEW.intent_id <> OLD.intent_id
  OR NEW.intent_revision <> OLD.intent_revision
  OR NEW.attempt_id <> OLD.attempt_id
  OR NEW.execution_operation_id <> OLD.execution_operation_id
  OR NEW.managed_instance_id <> OLD.managed_instance_id
  OR NEW.managed_generation <> OLD.managed_generation
  OR NEW.provider_source <> OLD.provider_source
  OR NEW.provider_key <> OLD.provider_key
  OR NEW.section_content_sha256 <> OLD.section_content_sha256
  OR NEW.document_sha256 <> OLD.document_sha256
  OR NEW.document_size_bytes <> OLD.document_size_bytes
  OR NEW.metadata_json <> OLD.metadata_json
  OR (OLD.provider_item_id IS NOT NULL AND NEW.provider_item_id IS NOT OLD.provider_item_id)
  OR (OLD.readback_receipt_json IS NOT NULL
    AND (NEW.readback_receipt_json IS NOT OLD.readback_receipt_json
      OR NEW.readback_sha256 IS NOT OLD.readback_sha256))
  OR (OLD.state = 'READBACK_VERIFIED' AND NEW.state <> OLD.state)
  OR (OLD.state = 'INTENT' AND NEW.state NOT IN ('INTENT', 'DISPATCHED'))
  OR (OLD.state = 'DISPATCHED' AND NEW.state NOT IN ('DISPATCHED', 'UNKNOWN', 'READBACK_VERIFIED'))
  OR (OLD.state = 'UNKNOWN' AND NEW.state NOT IN ('UNKNOWN', 'READBACK_VERIFIED'))
  OR (OLD.dispatch_lease_generation IS NOT NULL
    AND NEW.dispatch_lease_generation IS NOT OLD.dispatch_lease_generation)
  OR NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_MANAGED_ITEM_IMMUTABLE');
END;

CREATE TRIGGER projection_managed_item_effect_no_delete
BEFORE DELETE ON projection_managed_item_effect
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_MANAGED_ITEM_IMMUTABLE');
END;

CREATE TRIGGER projection_managed_item_effect_target_pin_insert_guard
BEFORE INSERT ON projection_managed_item_effect
WHEN NOT EXISTS (
  SELECT 1 FROM projection_generation g
  WHERE g.source_revision_ref = NEW.source_revision_ref
    AND g.projection_generation = NEW.projection_generation
    AND g.job_id = NEW.job_id
    AND g.managed_item_protocol IS 'eliotr.managed-item-effects.v1'
    AND g.managed_target_instance_id IS NEW.managed_instance_id
    AND g.managed_target_generation IS NEW.managed_generation
    AND (NEW.copy_layout IS NULL
      OR g.managed_target_metadata_generation_digest IS NEW.metadata_generation_digest)
)
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_MANAGED_ITEM_TARGET_MISMATCH');
END;
