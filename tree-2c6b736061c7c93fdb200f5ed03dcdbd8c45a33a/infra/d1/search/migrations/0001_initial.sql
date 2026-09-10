PRAGMA foreign_keys = ON;

CREATE TABLE schema_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
INSERT INTO schema_state(key, value, updated_at)
VALUES ('schema_generation', 'search-v1', '2026-08-28T00:00:00Z');

CREATE TABLE projection_item (
  item_key TEXT PRIMARY KEY,
  source_revision_ref TEXT NOT NULL,
  canonical_section_id TEXT NOT NULL,
  project_membership_ids_json TEXT NOT NULL CHECK (json_valid(project_membership_ids_json)),
  source_class TEXT NOT NULL,
  title TEXT NOT NULL,
  heading_path TEXT NOT NULL,
  document_context_header TEXT NOT NULL,
  section_text TEXT NOT NULL,
  normalized_offset_map_ref TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  instruction_taint TEXT NOT NULL,
  projection_generation TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  updated_at TEXT NOT NULL,
  UNIQUE(source_revision_ref, canonical_section_id, projection_generation)
) STRICT;
CREATE INDEX projection_source_idx ON projection_item(source_revision_ref, active);
CREATE INDEX projection_generation_idx ON projection_item(projection_generation, active);

CREATE VIRTUAL TABLE section_fts USING fts5(
  item_key UNINDEXED,
  title,
  heading_path,
  document_context_header,
  section_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE literal_gram (
  gram TEXT NOT NULL,
  item_key TEXT NOT NULL REFERENCES projection_item(item_key) ON DELETE CASCADE,
  position_hint INTEGER NOT NULL CHECK (position_hint >= 0),
  projection_generation TEXT NOT NULL,
  PRIMARY KEY(gram, item_key, position_hint)
) WITHOUT ROWID;
CREATE INDEX literal_item_idx ON literal_gram(item_key, projection_generation);

CREATE TABLE exact_identifier (
  identifier TEXT NOT NULL,
  identifier_kind TEXT NOT NULL,
  item_key TEXT NOT NULL REFERENCES projection_item(item_key) ON DELETE CASCADE,
  normalized_start_byte INTEGER NOT NULL CHECK (normalized_start_byte >= 0),
  normalized_end_byte INTEGER NOT NULL CHECK (normalized_end_byte >= normalized_start_byte),
  projection_generation TEXT NOT NULL,
  PRIMARY KEY(identifier, identifier_kind, item_key, normalized_start_byte)
) WITHOUT ROWID;
CREATE INDEX exact_identifier_item_idx ON exact_identifier(item_key, projection_generation);

CREATE TABLE projection_watermark (
  channel TEXT NOT NULL,
  projection_generation TEXT NOT NULL,
  source_revision_ref TEXT NOT NULL,
  projected_item_count INTEGER NOT NULL CHECK (projected_item_count >= 0),
  state TEXT NOT NULL CHECK (state IN ('BUILDING','READY','DEGRADED','STALE','RETIRED')),
  readback_receipt_ref TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(channel, projection_generation, source_revision_ref)
) STRICT;
CREATE INDEX watermark_state_idx ON projection_watermark(channel, projection_generation, state);

CREATE TABLE exact_scan_checkpoint (
  job_id TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  source_revision_ref TEXT NOT NULL,
  section_cursor TEXT,
  scanned_sections INTEGER NOT NULL CHECK (scanned_sections >= 0),
  matches INTEGER NOT NULL CHECK (matches >= 0),
  partial_result_ref TEXT,
  state TEXT NOT NULL CHECK (state IN ('PENDING','RUNNING','COMPLETE','FAILED')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(job_id, shard_id, source_revision_ref)
) STRICT;
