PRAGMA foreign_keys = ON;

-- A row is the immutable per-item upload intent and its eventual exact readback receipt.
-- The projection job/generation and existing operation/lease identities remain authoritative.
CREATE TABLE projection_managed_item_effect (
  source_revision_ref TEXT NOT NULL,
  projection_generation TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES job(job_id),
  item_key TEXT NOT NULL,
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
  CHECK (provider_key = item_key || '.md'),
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
  CHECK (json_extract(metadata_json, '$.projection_generation') IS managed_generation)
) STRICT;

CREATE INDEX projection_managed_item_effect_state_idx
  ON projection_managed_item_effect(job_id, projection_generation, state, item_key);

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
