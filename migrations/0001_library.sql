-- K1 Read: projects, shared Library sources, immutable captures and readable revisions.
-- This migration may be edited only until the first remote D1 apply.
-- Conventions: TEXT UUIDs, INTEGER Unix milliseconds, INTEGER 0/1 booleans.

PRAGMA foreign_keys = ON;

CREATE TABLE project (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '',
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE source (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  kind TEXT NOT NULL CHECK (kind IN ('file', 'url', 'text')),
  language TEXT,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived', 'deleted')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Every upload, paste, static fetch, rendered capture, replacement or owner-supplied
-- Markdown is a new immutable revision. Original bytes are retained for every kind.
CREATE TABLE source_revision (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source(id),
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),

  -- Race-safe duplicate identity. See IMPLEMENTATION §4 for kind-specific construction.
  dedup_key TEXT NOT NULL UNIQUE,
  original_key TEXT NOT NULL UNIQUE,             -- source/<revision>/original
  original_sha256 TEXT NOT NULL CHECK (length(original_sha256) = 64),
  original_size INTEGER NOT NULL CHECK (original_size >= 0),
  original_filename TEXT,
  original_mime TEXT NOT NULL,

  capture_method TEXT NOT NULL
    CHECK (capture_method IN ('upload', 'paste', 'static_fetch', 'browser_fetch', 'owner_markdown')),
  requested_url TEXT,
  final_url TEXT,
  http_status INTEGER,
  captured_at INTEGER,
  capture_metadata_key TEXT,                    -- source/<revision>/capture.json

  readable_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (readable_state IN ('pending', 'readable', 'readable_with_warnings', 'needs_conversion', 'failed')),
  converter TEXT CHECK (converter IN ('utf8', 'unpdf', 'html_text', 'owner_markdown')),
  converter_version TEXT,
  canonical_key TEXT UNIQUE,                    -- source/<revision>/text.md
  canonical_sha256 TEXT CHECK (canonical_sha256 IS NULL OR length(canonical_sha256) = 64),
  canonical_size INTEGER CHECK (canonical_size IS NULL OR canonical_size >= 0),
  blocks_key TEXT UNIQUE,                       -- source/<revision>/blocks.json
  block_count INTEGER CHECK (block_count IS NULL OR block_count >= 0),
  warning_summary TEXT,
  error TEXT,

  -- A Workflow ID is idempotent only inside one attempt. Retry increments the
  -- attempt and stores a new ID; it never restarts a terminal instance.
  ingest_attempt INTEGER NOT NULL DEFAULT 1 CHECK (ingest_attempt >= 1),
  ingest_workflow_id TEXT UNIQUE,
  ingest_started_at INTEGER,
  ingest_finished_at INTEGER,

  deleted_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (source_id, revision_no),
  CHECK (
    (capture_method IN ('static_fetch', 'browser_fetch')
      AND requested_url IS NOT NULL AND final_url IS NOT NULL
      AND http_status IS NOT NULL AND captured_at IS NOT NULL
      AND capture_metadata_key IS NOT NULL)
    OR (capture_method NOT IN ('static_fetch', 'browser_fetch')
      AND requested_url IS NULL AND final_url IS NULL
      AND http_status IS NULL AND capture_metadata_key IS NULL)
  ),
  CHECK (
    (readable_state IN ('readable', 'readable_with_warnings')
      AND canonical_key IS NOT NULL AND canonical_sha256 IS NOT NULL
      AND canonical_size IS NOT NULL AND blocks_key IS NOT NULL AND block_count IS NOT NULL)
    OR readable_state NOT IN ('readable', 'readable_with_warnings')
  )
);

ALTER TABLE source ADD COLUMN current_revision_id TEXT REFERENCES source_revision(id);


-- A source is created before its first revision. The accepted pointer may later
-- reference only a readable, non-deleted revision owned by that source.
CREATE TRIGGER source_current_revision_null_on_insert
BEFORE INSERT ON source
WHEN NEW.current_revision_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'source_current_revision_must_start_null');
END;

CREATE TRIGGER source_current_revision_guard
BEFORE UPDATE OF current_revision_id ON source
WHEN NEW.current_revision_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'current_revision_wrong_source_or_state')
  WHERE NOT EXISTS (
    SELECT 1 FROM source_revision r
    WHERE r.id = NEW.current_revision_id
      AND r.source_id = NEW.id
      AND r.readable_state IN ('readable', 'readable_with_warnings')
      AND r.deleted_at IS NULL
  );
END;

CREATE INDEX source_revision_by_source ON source_revision(source_id, revision_no DESC);
CREATE INDEX source_revision_by_sha ON source_revision(original_sha256);
CREATE INDEX source_revision_ingest ON source_revision(readable_state, created_at);


CREATE TRIGGER source_revision_capture_identity_immutable
BEFORE UPDATE ON source_revision
WHEN NEW.id <> OLD.id
  OR NEW.source_id <> OLD.source_id
  OR NEW.revision_no <> OLD.revision_no
  OR NEW.dedup_key <> OLD.dedup_key
  OR NEW.original_key <> OLD.original_key
  OR NEW.original_sha256 <> OLD.original_sha256
  OR NEW.original_size <> OLD.original_size
  OR NEW.original_filename IS NOT OLD.original_filename
  OR NEW.original_mime <> OLD.original_mime
  OR NEW.capture_method <> OLD.capture_method
  OR NEW.requested_url IS NOT OLD.requested_url
  OR NEW.final_url IS NOT OLD.final_url
  OR NEW.http_status IS NOT OLD.http_status
  OR NEW.captured_at IS NOT OLD.captured_at
  OR NEW.capture_metadata_key IS NOT OLD.capture_metadata_key
  OR NEW.created_by <> OLD.created_by
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'source_revision_capture_identity_is_immutable');
END;

CREATE TRIGGER source_revision_accepted_text_immutable
BEFORE UPDATE ON source_revision
WHEN OLD.readable_state IN ('readable', 'readable_with_warnings', 'needs_conversion')
  AND (
    NEW.readable_state <> OLD.readable_state
    OR NEW.converter IS NOT OLD.converter
    OR NEW.converter_version IS NOT OLD.converter_version
    OR NEW.canonical_key IS NOT OLD.canonical_key
    OR NEW.canonical_sha256 IS NOT OLD.canonical_sha256
    OR NEW.canonical_size IS NOT OLD.canonical_size
    OR NEW.blocks_key IS NOT OLD.blocks_key
    OR NEW.block_count IS NOT OLD.block_count
    OR NEW.warning_summary IS NOT OLD.warning_summary
    OR NEW.error IS NOT OLD.error
  )
BEGIN
  SELECT RAISE(ABORT, 'accepted_canonical_text_is_immutable');
END;

CREATE TABLE project_source (
  project_id TEXT NOT NULL REFERENCES project(id),
  source_id TEXT NOT NULL REFERENCES source(id),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, source_id)
);
CREATE INDEX project_source_by_source ON project_source(source_id);
