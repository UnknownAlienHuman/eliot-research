-- Eliot Research schema for contours K0–K3 (shell, read, ask, distill). See docs/MAP.md.
-- Later contours add their own numbered migrations (K4 agents, K5 search columns, K6/K7 jobs, ...).
-- Edit this file in place until its first remote apply; afterwards only add new migrations.
--
-- Conventions: TEXT UUID keys, INTEGER Unix-millisecond timestamps, 0/1 INTEGER booleans.
-- `actor` holds the server-resolved actor ('owner' or 'agent:<id>'), never a client-supplied name.
-- Bodies live in R2 under the keys listed in docs/IMPLEMENTATION.md §3; D1 holds identity, state and small text.

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  answer_model TEXT NOT NULL,        -- default model route for Ask, e.g. 'workers-ai:@cf/zai-org/glm-5.3-flash'
  distill_model TEXT NOT NULL,       -- default model route for per-source distillation
  updated_at INTEGER NOT NULL
);

CREATE TABLE project (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',  -- owner's standing answer instructions for this project
  answer_model TEXT,                      -- NULL = settings.answer_model
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
  authors TEXT NOT NULL DEFAULT '',   -- display string; structured authors arrive with filters
  published TEXT,                     -- as given by the source, possibly partial ('2017', '2017-06')
  language TEXT,                      -- 'en', 'ru', ... detected at ingest
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
  original_key TEXT,                  -- R2 source/<rev>/original; NULL for pasted text
  original_sha256 TEXT,               -- exact-duplicate detection only
  original_size INTEGER,
  original_filename TEXT,
  original_mime TEXT,
  readable_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (readable_state IN ('pending', 'readable', 'readable_with_warnings', 'needs_conversion', 'failed')),
  converter TEXT,                     -- 'local_text' | 'workers_ai_markdown' | 'browser_markdown' | 'owner_markdown'
  readable_size INTEGER,              -- bytes of source/<rev>/text.md
  block_count INTEGER,                -- blocks in source/<rev>/blocks.json
  warning_summary TEXT,               -- one owner-readable line, NULL when clean
  distill_state TEXT NOT NULL DEFAULT 'none'
    CHECK (distill_state IN ('none', 'queued', 'running', 'done', 'partial', 'failed')),
  distill_model TEXT,                 -- model that produced guide/claims/digest
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

-- Distilled claim cards (K3). Every card carries a verbatim quote that code located in text.md.
CREATE TABLE claim (
  id TEXT PRIMARY KEY,
  source_revision_id TEXT NOT NULL REFERENCES source_revision(id),
  kind TEXT NOT NULL CHECK (kind IN ('method', 'result', 'limitation', 'dataset', 'definition', 'other')),
  statement TEXT NOT NULL,            -- one-sentence claim in the source language
  task TEXT,                          -- normalised keys used by comparison tables (K6)
  metric TEXT,
  dataset TEXT,
  value TEXT,                         -- number with unit, as written
  conditions TEXT,                    -- conditions under which the value holds
  quote TEXT NOT NULL,                -- verbatim text from text.md
  block_index INTEGER NOT NULL,
  start_byte INTEGER NOT NULL,        -- UTF-8 range of the quote in text.md
  end_byte INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (end_byte > start_byte)
);
CREATE INDEX claim_by_revision ON claim(source_revision_id);
CREATE INDEX claim_by_key ON claim(task, metric);

-- Substring search over claims in any language (trigram works for Russian). App code writes both tables.
CREATE VIRTUAL TABLE claim_fts USING fts5(claim_id UNINDEXED, body, tokenize = 'trigram');

-- Chats: messages live in the AIChatAgent Durable Object; D1 keeps the inventory and one row per turn.
CREATE TABLE chat (
  id TEXT PRIMARY KEY,                -- also the Durable Object name
  project_id TEXT NOT NULL REFERENCES project(id),
  title TEXT NOT NULL DEFAULT '',
  archived_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX chat_by_project ON chat(project_id, updated_at DESC);

-- Written before the model is called. Holds what the turn used and how it went; read by history and eval.
CREATE TABLE chat_turn (
  chat_id TEXT NOT NULL REFERENCES chat(id),
  turn_id TEXT NOT NULL,              -- client request ID; a repeated ID returns the existing turn
  model TEXT NOT NULL,
  scope_mode TEXT NOT NULL CHECK (scope_mode IN ('project_default', 'explicit', 'empty')),
  scope_json TEXT NOT NULL,           -- JSON array of source_revision IDs actually given to the model
  context_mode TEXT NOT NULL CHECK (context_mode IN ('whole', 'claims', 'search', 'none')),
  state TEXT NOT NULL DEFAULT 'started'
    CHECK (state IN ('started', 'completed', 'partial', 'failed', 'cancelled')),
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  first_token_ms INTEGER,
  total_ms INTEGER,
  error TEXT,                         -- owner-readable reason when failed
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, turn_id)
);

-- Project knowledge: notes, saved answers, reports, Wiki and map pages. Bodies are Markdown in R2.
CREATE TABLE page (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  kind TEXT NOT NULL CHECK (kind IN ('overview', 'note', 'answer', 'report', 'wiki', 'map')),
  title TEXT NOT NULL,
  head_revision_id TEXT REFERENCES page_revision(id),  -- accepted head; NULL while only proposals exist
  freshness TEXT NOT NULL DEFAULT 'current' CHECK (freshness IN ('current', 'stale')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX page_by_project ON page(project_id, kind, updated_at DESC);

CREATE TABLE page_revision (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES page(id),
  revision_no INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'proposed', 'rejected')),
  origin TEXT NOT NULL CHECK (origin IN ('owner', 'chat', 'agent', 'job')),
  actor TEXT NOT NULL,
  body_key TEXT NOT NULL,             -- page/<rev>/body.md
  citations_key TEXT,                 -- page/<rev>/citations.json (resolved label -> revision/range)
  inputs_json TEXT NOT NULL DEFAULT '[]',  -- source_revision IDs the page cites; drives "stale" marking
  mutation_id TEXT NOT NULL UNIQUE,   -- client operation ID; a repeat returns this row
  created_at INTEGER NOT NULL,
  UNIQUE (page_id, revision_no)
);
CREATE INDEX page_revision_proposed ON page_revision(page_id) WHERE status = 'proposed';
