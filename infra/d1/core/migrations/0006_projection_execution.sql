PRAGMA foreign_keys = ON;

ALTER TABLE source_readiness ADD COLUMN receipt_ref TEXT;

CREATE TABLE projection_generation (
  source_revision_ref TEXT NOT NULL REFERENCES source_revision(source_revision_ref),
  projection_generation TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES job(job_id),
  source_owner_generation TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  object_residency_key_digest TEXT NOT NULL CHECK (
    length(object_residency_key_digest) = 64
    AND object_residency_key_digest NOT GLOB '*[^0-9a-f]*'
  ),
  projector_profile TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'PREPARING','MATERIALIZED','D1_READY','COMPLETED','PARTIAL','FAILED','RETIRED'
  )),
  item_count INTEGER CHECK (item_count IS NULL OR (item_count > 0 AND item_count <= 1024)),
  item_set_digest TEXT CHECK (
    item_set_digest IS NULL OR (
      length(item_set_digest) = 64 AND item_set_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  work_manifest_ref TEXT,
  work_manifest_sha256 TEXT CHECK (
    work_manifest_sha256 IS NULL OR (
      length(work_manifest_sha256) = 64
      AND work_manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  d1_search_receipt_ref TEXT,
  d1_search_readback_digest TEXT CHECK (
    d1_search_readback_digest IS NULL OR (
      length(d1_search_readback_digest) = 64
      AND d1_search_readback_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  semantic_instance_id TEXT,
  semantic_generation TEXT,
  semantic_receipt_ref TEXT,
  semantic_readback_digest TEXT CHECK (
    semantic_readback_digest IS NULL OR (
      length(semantic_readback_digest) = 64
      AND semantic_readback_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  reason_codes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reason_codes_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(source_revision_ref, projection_generation),
  UNIQUE(job_id, projection_generation),
  CHECK (
    (item_count IS NULL AND item_set_digest IS NULL
      AND work_manifest_ref IS NULL AND work_manifest_sha256 IS NULL)
    OR
    (item_count IS NOT NULL AND item_set_digest IS NOT NULL
      AND work_manifest_ref IS NOT NULL AND work_manifest_sha256 IS NOT NULL)
  ),
  CHECK (
    semantic_receipt_ref IS NULL
    OR (
      semantic_instance_id IS NOT NULL
      AND semantic_generation IS NOT NULL
      AND semantic_readback_digest IS NOT NULL
    )
  )
) STRICT;

CREATE INDEX projection_generation_state_idx
  ON projection_generation(state, updated_at);
CREATE INDEX projection_generation_job_idx
  ON projection_generation(job_id, state);


CREATE TABLE projection_terminal_guard (
  source_revision_ref TEXT NOT NULL,
  projection_generation TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES job(job_id),
  terminal_receipt_id TEXT NOT NULL,
  terminal_receipt_revision INTEGER NOT NULL CHECK (terminal_receipt_revision > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('SUCCEEDED','PARTIAL')),
  verified INTEGER NOT NULL CHECK (verified = 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY(source_revision_ref, projection_generation),
  FOREIGN KEY(source_revision_ref, projection_generation)
    REFERENCES projection_generation(source_revision_ref, projection_generation),
  FOREIGN KEY(terminal_receipt_id, terminal_receipt_revision)
    REFERENCES operation_receipt(receipt_id, revision)
) STRICT;

UPDATE schema_state
SET value = 'core-v6-projection-execution',
    updated_at = '2026-08-31T18:15:00Z'
WHERE key = 'schema_generation';
