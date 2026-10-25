-- K2 Ask: model settings, chats, turns, project pages (saved answers and notes).

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  answer_model TEXT NOT NULL,        -- model route, see IMPLEMENTATION §11
  updated_at INTEGER NOT NULL
);
INSERT INTO settings (id, answer_model, updated_at) VALUES (1, 'workers-ai:@cf/zai-org/glm-5.3-flash', 0);

ALTER TABLE project ADD COLUMN instructions TEXT NOT NULL DEFAULT '';  -- standing answer instructions
ALTER TABLE project ADD COLUMN answer_model TEXT;                     -- NULL = settings.answer_model

-- Messages live in the ChatAgent Durable Object; D1 keeps the inventory and one row per turn.
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

-- Written before the model is called; read by chat history, eval and the usage view.
CREATE TABLE chat_turn (
  chat_id TEXT NOT NULL REFERENCES chat(id),
  turn_id TEXT NOT NULL,              -- client request ID; a repeated ID returns the existing turn
  model TEXT NOT NULL,
  scope_mode TEXT NOT NULL CHECK (scope_mode IN ('project_default', 'explicit', 'empty')),
  scope_json TEXT NOT NULL,           -- JSON array of source_revision IDs given to the model
  context_mode TEXT NOT NULL CHECK (context_mode IN ('whole', 'claims', 'search', 'none')),
  state TEXT NOT NULL DEFAULT 'started'
    CHECK (state IN ('started', 'completed', 'partial', 'failed', 'cancelled')),
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  citations INTEGER,                  -- labels that resolved
  invalid_labels INTEGER,             -- labels removed because they did not resolve
  first_token_ms INTEGER,
  total_ms INTEGER,
  error TEXT,                         -- owner-readable reason when failed
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, turn_id)
);

-- Project knowledge pages. Bodies are Markdown in R2 with citations in the stored label form (IMPLEMENTATION §5).
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
  citations_key TEXT,                 -- page/<rev>/citations.json
  inputs_json TEXT NOT NULL DEFAULT '[]',  -- source_revision IDs the page cites; drives "stale"
  mutation_id TEXT NOT NULL UNIQUE,   -- client operation ID; a repeat returns this row
  created_at INTEGER NOT NULL,
  UNIQUE (page_id, revision_no)
);
CREATE INDEX page_revision_proposed ON page_revision(page_id) WHERE status = 'proposed';
