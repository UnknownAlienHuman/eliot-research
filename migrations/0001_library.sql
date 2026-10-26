-- K1 Read: projects, Library sources, immutable revisions, memberships. See docs/MAP.md and docs/IMPLEMENTATION.md §3.
-- Each contour adds its own migration; edit a migration in place only until its first remote apply.
--
-- Conventions: TEXT UUID keys, INTEGER Unix-millisecond timestamps, 0/1 INTEGER booleans.
-- created_by / actor hold the server-resolved actor ("owner" or "agent:<client-id>"), never a client-supplied name.
-- Bodies live in R2 (keys in IMPLEMENTATION §3); D1 holds identity, state and small text.

CREATE TABLE project (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One Library source, shared by any number of projects through project_source.
CREATE TABLE source (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'url', 'text')),
  origin_url TEXT,
  language TEXT,                      -- en, ru or other, detected at ingest
  current_revision_id TEXT REFERENCES source_revision(id),  -- newest readable revision; NULL until one exists
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived', 'deleted')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Every capture, replacement or reconversion is a new immutable revision.
CREATE TABLE source_revision (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source(id),
  revision_no INTEGER NOT NULL,
  original_key TEXT,                  -- R2 source/<rev>/original, including submitted UTF-8 text bytes
  original_sha256 TEXT,               -- exact-duplicate notice only
  original_size INTEGER,
  original_filename TEXT,
  original_mime TEXT,
  readable_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (readable_state IN ('pending', 'readable', 'readable_with_warnings', 'needs_conversion', 'failed')),
  converter TEXT,                     -- local_text | workers_ai_markdown | owner_markdown | browser_markdown (K7)
  readable_size INTEGER,              -- bytes of source/<rev>/text.md
  block_count INTEGER,                -- entries in source/<rev>/blocks.json
  warning_summary TEXT,               -- one owner-readable line; NULL when clean
  error TEXT,                         -- owner-readable reason when failed
  conversion_tokens INTEGER,
  conversion_calls INTEGER NOT NULL DEFAULT 0,
  conversion_ms INTEGER,
  deleted_at INTEGER,                 -- hidden from use; identity kept so old citations show "deleted"
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (source_id, revision_no)
);
CREATE INDEX source_revision_sha ON source_revision(original_sha256);

CREATE TABLE project_source (
  project_id TEXT NOT NULL REFERENCES project(id),
  source_id TEXT NOT NULL REFERENCES source(id),
  enabled INTEGER NOT NULL DEFAULT 1,  -- 0 = kept in the project but excluded from answers
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, source_id)
);
CREATE INDEX project_source_by_source ON project_source(source_id);
