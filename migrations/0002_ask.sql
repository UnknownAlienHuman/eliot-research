-- K2 Ask: settings, atomic paid-effect reservations, chat inventory/turn metrics
-- and versioned project pages. AIChatAgent owns the message transcript.

PRAGMA foreign_keys = ON;

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  answer_model TEXT NOT NULL,
  monthly_paid_effect_budget_microusd INTEGER NOT NULL DEFAULT 5000000
    CHECK (monthly_paid_effect_budget_microusd >= 0),
  max_turn_reserved_microusd INTEGER NOT NULL DEFAULT 250000
    CHECK (max_turn_reserved_microusd >= 0),
  updated_at INTEGER NOT NULL
);
INSERT INTO settings (
  id, answer_model, monthly_paid_effect_budget_microusd,
  max_turn_reserved_microusd, updated_at
) VALUES (
  1, 'workers-ai:@cf/zai-org/glm-5.3-flash', 5000000, 250000, 0
);

ALTER TABLE project ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE project ADD COLUMN answer_model TEXT;

-- One aggregate row serializes reservations for a UTC calendar month. The limit
-- is copied from settings when the first reservation is admitted; changing it
-- later is an explicit owner mutation of this row.
CREATE TABLE budget_month (
  month_key TEXT PRIMARY KEY CHECK (month_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  limit_microusd INTEGER NOT NULL CHECK (limit_microusd >= 0),
  spent_microusd INTEGER NOT NULL DEFAULT 0 CHECK (spent_microusd >= 0),
  reserved_microusd INTEGER NOT NULL DEFAULT 0 CHECK (reserved_microusd >= 0),
  updated_at INTEGER NOT NULL,
  CHECK (spent_microusd + reserved_microusd <= limit_microusd)
);

-- This is a narrow spend-concurrency primitive, not a generic effect ledger.
-- Each reservation is owned by one concrete operation row.
CREATE TABLE budget_reservation (
  id TEXT PRIMARY KEY,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN (
    'chat_turn', 'distill', 'project_map', 'research',
    'ai_search_ingest', 'ai_search_query'
  )),
  operation_id TEXT NOT NULL,
  month_key TEXT NOT NULL REFERENCES budget_month(month_key),
  reserved_microusd INTEGER NOT NULL CHECK (reserved_microusd >= 0),
  actual_microusd INTEGER CHECK (actual_microusd IS NULL OR actual_microusd >= 0),
  state TEXT NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'settled', 'released')),
  dispatched_at INTEGER,
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  UNIQUE (operation_kind, operation_id),
  CHECK (
    (state = 'reserved' AND actual_microusd IS NULL AND settled_at IS NULL)
    OR (state = 'settled' AND actual_microusd IS NOT NULL AND settled_at IS NOT NULL
        AND actual_microusd <= reserved_microusd)
    OR (state = 'released' AND actual_microusd IS NULL AND settled_at IS NOT NULL)
  )
);
CREATE INDEX budget_reservation_open ON budget_reservation(state, created_at);

CREATE TRIGGER budget_reservation_admit
BEFORE INSERT ON budget_reservation
WHEN NEW.state = 'reserved'
BEGIN
  INSERT INTO budget_month (
    month_key, limit_microusd, spent_microusd, reserved_microusd, updated_at
  )
  SELECT NEW.month_key, monthly_paid_effect_budget_microusd, 0, 0, NEW.created_at
  FROM settings WHERE id = 1
  ON CONFLICT(month_key) DO NOTHING;

  UPDATE budget_month
  SET reserved_microusd = reserved_microusd + NEW.reserved_microusd,
      updated_at = NEW.created_at
  WHERE month_key = NEW.month_key
    AND spent_microusd + reserved_microusd + NEW.reserved_microusd <= limit_microusd;

  SELECT RAISE(ABORT, 'budget_exceeded') WHERE changes() <> 1;
END;

CREATE TRIGGER budget_reservation_identity_immutable
BEFORE UPDATE ON budget_reservation
WHEN NEW.id <> OLD.id
  OR NEW.operation_kind <> OLD.operation_kind
  OR NEW.operation_id <> OLD.operation_id
  OR NEW.month_key <> OLD.month_key
  OR NEW.reserved_microusd <> OLD.reserved_microusd
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'budget_reservation_identity_is_immutable');
END;

CREATE TRIGGER budget_reservation_final_immutable
BEFORE UPDATE ON budget_reservation
WHEN OLD.state IN ('settled', 'released')
BEGIN
  SELECT RAISE(ABORT, 'final_budget_reservation_is_immutable');
END;

CREATE TRIGGER budget_reservation_transition
BEFORE UPDATE OF state ON budget_reservation
WHEN NEW.state <> OLD.state
BEGIN
  SELECT RAISE(ABORT, 'invalid_budget_transition')
  WHERE OLD.state <> 'reserved' OR NEW.state NOT IN ('settled', 'released');
END;

CREATE TRIGGER budget_reservation_settle
AFTER UPDATE OF state ON budget_reservation
WHEN OLD.state = 'reserved' AND NEW.state = 'settled'
BEGIN
  UPDATE budget_month
  SET reserved_microusd = reserved_microusd - OLD.reserved_microusd,
      spent_microusd = spent_microusd + NEW.actual_microusd,
      updated_at = NEW.settled_at
  WHERE month_key = OLD.month_key;
END;

CREATE TRIGGER budget_reservation_release
AFTER UPDATE OF state ON budget_reservation
WHEN OLD.state = 'reserved' AND NEW.state = 'released'
BEGIN
  UPDATE budget_month
  SET reserved_microusd = reserved_microusd - OLD.reserved_microusd,
      updated_at = NEW.settled_at
  WHERE month_key = OLD.month_key;
END;

CREATE TRIGGER budget_reservation_no_delete
BEFORE DELETE ON budget_reservation
BEGIN
  SELECT RAISE(ABORT, 'budget_reservations_are_immutable');
END;

CREATE TABLE chat (
  id TEXT PRIMARY KEY,                         -- Durable Object instance name
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
  turn_id TEXT NOT NULL,                       -- AIChatAgent request ID
  user_message_id TEXT NOT NULL,
  assistant_message_id TEXT,
  model_route TEXT NOT NULL,
  scope_mode TEXT NOT NULL CHECK (scope_mode IN ('project_default', 'explicit', 'empty')),
  scope_json TEXT NOT NULL,                    -- frozen source_revision UUID array
  context_mode TEXT NOT NULL CHECK (context_mode IN ('whole', 'claims', 'search', 'none')),
  state TEXT NOT NULL DEFAULT 'started'
    CHECK (state IN ('started', 'streaming', 'completed', 'partial', 'failed', 'cancelled')),
  budget_reservation_id TEXT NOT NULL UNIQUE REFERENCES budget_reservation(id),
  input_token_limit INTEGER NOT NULL CHECK (input_token_limit >= 0),
  output_token_limit INTEGER NOT NULL CHECK (output_token_limit >= 0),
  deadline_at INTEGER NOT NULL,

  input_tokens_total INTEGER,
  input_tokens_uncached INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  output_tokens INTEGER,
  usage_quality TEXT CHECK (usage_quality IN ('exact', 'derived', 'conservative', 'unknown')),
  settled_cost_microusd INTEGER CHECK (settled_cost_microusd IS NULL OR settled_cost_microusd >= 0),
  pricing_checked_on TEXT,

  citations_key TEXT,                          -- chat/<chat>/<turn>/citations.json
  citations INTEGER NOT NULL DEFAULT 0 CHECK (citations >= 0),
  invalid_labels INTEGER NOT NULL DEFAULT 0 CHECK (invalid_labels >= 0),
  first_token_ms INTEGER,
  total_ms INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY (chat_id, turn_id),
  UNIQUE (chat_id, user_message_id),
  CHECK (input_tokens_total IS NULL OR input_tokens_total >= 0),
  CHECK (input_tokens_uncached IS NULL OR input_tokens_uncached >= 0),
  CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  CHECK (output_tokens IS NULL OR output_tokens >= 0)
);
CREATE INDEX chat_turn_by_created ON chat_turn(created_at);
CREATE INDEX chat_turn_by_state ON chat_turn(state, created_at);


CREATE TRIGGER chat_turn_terminal_immutable
BEFORE UPDATE ON chat_turn
WHEN OLD.state IN ('completed', 'partial', 'failed', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'terminal_chat_turn_is_immutable');
END;


-- Reservation ownership is structural, not a convention hidden in TypeScript.
-- The reservation is inserted first in the same D1 batch; failure of this row
-- rolls the full batch back.
CREATE TRIGGER chat_turn_budget_guard_insert
BEFORE INSERT ON chat_turn
BEGIN
  SELECT RAISE(ABORT, 'chat_turn_budget_owner_mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM budget_reservation b
    WHERE b.id = NEW.budget_reservation_id
      AND b.operation_kind = 'chat_turn'
      AND b.operation_id = NEW.chat_id || ':' || NEW.turn_id
  );
END;

CREATE TRIGGER chat_turn_budget_guard_update
BEFORE UPDATE OF budget_reservation_id, chat_id, turn_id ON chat_turn
BEGIN
  SELECT RAISE(ABORT, 'chat_turn_budget_owner_mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM budget_reservation b
    WHERE b.id = NEW.budget_reservation_id
      AND b.operation_kind = 'chat_turn'
      AND b.operation_id = NEW.chat_id || ':' || NEW.turn_id
  );
END;

CREATE TABLE page (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  kind TEXT NOT NULL CHECK (kind IN ('overview', 'note', 'answer', 'report', 'wiki', 'map')),
  title TEXT NOT NULL,
  freshness TEXT NOT NULL DEFAULT 'current' CHECK (freshness IN ('current', 'stale')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX page_by_project ON page(project_id, kind, updated_at DESC);

CREATE TABLE page_revision (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES page(id),
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'proposed', 'rejected')),
  origin TEXT NOT NULL CHECK (origin IN ('owner', 'chat', 'agent', 'job')),
  actor TEXT NOT NULL,
  body_key TEXT NOT NULL UNIQUE,               -- page/<revision>/body.md
  citations_key TEXT,                          -- page/<revision>/citations.json
  data_key TEXT,                               -- page/<revision>/data.json
  inputs_json TEXT NOT NULL DEFAULT '[]',      -- full source_revision UUIDs
  mutation_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  UNIQUE (page_id, revision_no)
);
ALTER TABLE page ADD COLUMN head_revision_id TEXT REFERENCES page_revision(id);


CREATE TRIGGER page_head_null_on_insert
BEFORE INSERT ON page
WHEN NEW.head_revision_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'page_head_must_start_null');
END;

CREATE TRIGGER page_head_guard
BEFORE UPDATE OF head_revision_id ON page
WHEN NEW.head_revision_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'page_head_wrong_page_or_status')
  WHERE NOT EXISTS (
    SELECT 1 FROM page_revision r
    WHERE r.id = NEW.head_revision_id
      AND r.page_id = NEW.id
      AND r.status = 'accepted'
  );
END;

CREATE TRIGGER page_revision_identity_immutable
BEFORE UPDATE ON page_revision
WHEN NEW.id <> OLD.id
  OR NEW.page_id <> OLD.page_id
  OR NEW.revision_no <> OLD.revision_no
  OR NEW.origin <> OLD.origin
  OR NEW.actor <> OLD.actor
  OR NEW.body_key <> OLD.body_key
  OR NEW.citations_key IS NOT OLD.citations_key
  OR NEW.data_key IS NOT OLD.data_key
  OR NEW.inputs_json <> OLD.inputs_json
  OR NEW.mutation_id <> OLD.mutation_id
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'page_revision_identity_is_immutable');
END;

CREATE TRIGGER page_revision_status_transition
BEFORE UPDATE OF status ON page_revision
WHEN NEW.status <> OLD.status
BEGIN
  SELECT RAISE(ABORT, 'invalid_page_revision_transition')
  WHERE OLD.status <> 'proposed' OR NEW.status NOT IN ('accepted', 'rejected');
END;

CREATE INDEX page_revision_proposed ON page_revision(page_id, created_at DESC)
  WHERE status = 'proposed';
