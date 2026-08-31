PRAGMA foreign_keys = ON;

CREATE TABLE projection_span (
  item_key TEXT PRIMARY KEY REFERENCES projection_item(item_key) ON DELETE CASCADE,
  source_revision_ref TEXT NOT NULL,
  normalized_start_byte INTEGER NOT NULL CHECK (normalized_start_byte >= 0),
  normalized_end_byte INTEGER NOT NULL CHECK (
    normalized_end_byte > normalized_start_byte
  ),
  precision_kind TEXT NOT NULL CHECK (precision_kind = 'normalized_bytes'),
  projection_generation TEXT NOT NULL
) STRICT;
CREATE INDEX projection_span_source_idx
  ON projection_span(source_revision_ref, projection_generation, normalized_start_byte);

CREATE TABLE projection_generation_receipt (
  source_revision_ref TEXT NOT NULL,
  projection_generation TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('BUILDING','READY','STALE','RETIRED')),
  item_count INTEGER NOT NULL CHECK (item_count > 0 AND item_count <= 1024),
  item_set_digest TEXT NOT NULL CHECK (
    length(item_set_digest) = 64 AND item_set_digest NOT GLOB '*[^0-9a-f]*'
  ),
  readback_digest TEXT CHECK (
    readback_digest IS NULL OR (
      length(readback_digest) = 64 AND readback_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  receipt_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(source_revision_ref, projection_generation),
  CHECK (
    (state = 'BUILDING' AND readback_digest IS NULL AND receipt_ref IS NULL)
    OR
    (state IN ('READY','STALE','RETIRED') AND readback_digest IS NOT NULL AND receipt_ref IS NOT NULL)
  )
) STRICT;
CREATE INDEX projection_generation_receipt_state_idx
  ON projection_generation_receipt(state, updated_at);


CREATE TABLE projection_activation_guard (
  source_revision_ref TEXT NOT NULL,
  projection_generation TEXT NOT NULL,
  receipt_ref TEXT NOT NULL,
  readback_digest TEXT NOT NULL CHECK (
    length(readback_digest) = 64 AND readback_digest NOT GLOB '*[^0-9a-f]*'
  ),
  item_count INTEGER NOT NULL CHECK (item_count > 0 AND item_count <= 1024),
  verified INTEGER NOT NULL CHECK (verified = 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY(source_revision_ref, projection_generation),
  FOREIGN KEY(source_revision_ref, projection_generation)
    REFERENCES projection_generation_receipt(source_revision_ref, projection_generation)
) STRICT;

UPDATE schema_state
SET value = 'search-v2-projection-generations',
    updated_at = '2026-08-31T18:15:00Z'
WHERE key = 'schema_generation';
