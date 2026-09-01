PRAGMA foreign_keys = ON;

CREATE TABLE erasure_search_receipt (
  erasure_id TEXT NOT NULL,
  erasure_revision INTEGER NOT NULL CHECK (erasure_revision > 0),
  target_id TEXT NOT NULL,
  source_revision_ref TEXT NOT NULL,
  projection_generation TEXT NOT NULL,
  deleted_item_count INTEGER NOT NULL CHECK (deleted_item_count >= 0),
  remaining_item_count INTEGER NOT NULL CHECK (remaining_item_count >= 0),
  absence_verified INTEGER NOT NULL CHECK (absence_verified IN (0,1)),
  receipt_ref TEXT NOT NULL,
  receipt_digest TEXT NOT NULL CHECK (
    length(receipt_digest) = 64 AND receipt_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY(erasure_id, erasure_revision, target_id)
) STRICT;
CREATE INDEX erasure_search_source_idx
  ON erasure_search_receipt(source_revision_ref, projection_generation, created_at DESC);

UPDATE schema_state
SET value = 'search-v3-erasure-invalidation',
    updated_at = '2026-09-01T02:00:00Z'
WHERE key = 'schema_generation';
