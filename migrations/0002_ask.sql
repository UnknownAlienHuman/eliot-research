-- K2 Ask: model/budget settings, chats, turns and versioned project pages.
-- See docs/MAP.md K2 and docs/IMPLEMENTATION.md §§1, 3, 8, 11.

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  answer_model TEXT NOT NULL,                  -- model route, IMPLEMENTATION §11
  monthly_model_budget_microusd INTEGER NOT NULL DEFAULT 5000000
    CHECK (monthly_model_budget_microusd >= 0),
  updated_at INTEGER NOT NULL
);
INSERT INTO settings (id, answer_model, monthly_model_budget_microusd, updated_at)
VALUES (1, 'workers-ai:@cf/zai-org/glm-5.3-flash', 5000000, 0);

ALTER TABLE project ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE project ADD COLUMN answer_model TEXT;       -- NULL = settings.answer_model

-- Messages remain in the ChatAgent Durable Object. D1 owns inventory, frozen scope and measured usage per turn.
CREATE TABLE chat (
  id TEXT PRIMARY KEY,                         -- also the Durable Object name
  project_id TEXT NOT NULL REFERENCES project(id),
  title TEXT NOT NULL DEFAULT '',
  archived_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX chat_by_project ON chat(project_id, updated_at DESC);

CREATE TABLE chat_turn (
  chat_id TEXT NOT NULL REFERENCES chat(id),
  turn_id TEXT NOT NULL,                       -- natural idempotency key
  model TEXT NOT NULL,
  scope_mode TEXT NOT NULL CHECK (scope_mode IN ('project_default', 'explicit', 'empty')),
  scope_json TEXT NOT NULL,                    -- JSON array of immutable source_revision IDs
  context_mode TEXT NOT NULL CHECK (context_mode IN ('whole', 'claims', 'search', 'none')),
  state TEXT NOT NULL DEFAULT 'started'
    CHECK (state IN ('started', 'completed', 'partial', 'failed', 'cancelled')),
  input_tokens INTEGER,
  cached_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost_microusd INTEGER CHECK (estimated_cost_microusd IS NULL OR estimated_cost_microusd >= 0),
  pricing_checked_on TEXT,                     -- YYYY-MM-DD price snapshot used by src/cost.ts
  citations INTEGER NOT NULL DEFAULT 0,
  invalid_labels INTEGER NOT NULL DEFAULT 0,
  first_token_ms INTEGER,
  total_ms INTEGER,
  error TEXT,                                  -- owner-readable failure/budget reason
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, turn_id)
);
CREATE INDEX chat_turn_by_created ON chat_turn(created_at);

-- Project knowledge pages. Bodies/citations are immutable R2 objects; D1 owns identity and accepted head.
CREATE TABLE page (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  kind TEXT NOT NULL CHECK (kind IN ('overview', 'note', 'answer', 'report', 'wiki', 'map')),
  title TEXT NOT NULL,
  head_revision_id TEXT REFERENCES page_revision(id),
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
  body_key TEXT NOT NULL,                      -- page/<revision>/body.md
  citations_key TEXT,                         -- page/<revision>/citations.json
  inputs_json TEXT NOT NULL DEFAULT '[]',     -- full source_revision IDs; drives staleness
  mutation_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  UNIQUE (page_id, revision_no)
);
CREATE INDEX page_revision_proposed ON page_revision(page_id) WHERE status = 'proposed';
