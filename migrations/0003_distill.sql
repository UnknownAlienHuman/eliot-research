-- K3 Distill: one-time source understanding, attempt-scoped Workflow runs,
-- exact quote verification and typed claim cards.

PRAGMA foreign_keys = ON;

ALTER TABLE settings ADD COLUMN distill_model TEXT NOT NULL
  DEFAULT 'workers-ai:@cf/zai-org/glm-5.3-flash';
ALTER TABLE settings ADD COLUMN auto_distill INTEGER NOT NULL DEFAULT 1
  CHECK (auto_distill IN (0, 1));
ALTER TABLE settings ADD COLUMN max_distill_reserved_microusd INTEGER NOT NULL DEFAULT 500000
  CHECK (max_distill_reserved_microusd >= 0);

ALTER TABLE source ADD COLUMN authors TEXT NOT NULL DEFAULT '';
ALTER TABLE source ADD COLUMN published TEXT;

ALTER TABLE source_revision ADD COLUMN distill_state TEXT NOT NULL DEFAULT 'none'
  CHECK (distill_state IN (
    'none', 'queued', 'running', 'paused_budget', 'paused_too_large',
    'done', 'partial', 'failed'
  ));
ALTER TABLE source_revision ADD COLUMN guide_summary TEXT;
CREATE INDEX source_revision_distill_queue
  ON source_revision(distill_state, created_at);

-- Every explicit retry creates a new run and a new Workflow ID. Failed/partial
-- attempts remain inspectable; accepted claim rows point to the run that made them.
CREATE TABLE distill_run (
  id TEXT PRIMARY KEY,
  source_revision_id TEXT NOT NULL REFERENCES source_revision(id),
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  workflow_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'running', 'paused_budget', 'paused_too_large',
    'done', 'partial', 'failed', 'cancelled'
  )),
  model_route TEXT NOT NULL,
  budget_reservation_id TEXT UNIQUE REFERENCES budget_reservation(id),
  max_model_calls INTEGER NOT NULL DEFAULT 2 CHECK (max_model_calls BETWEEN 1 AND 2),
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

  artifact_prefix TEXT NOT NULL UNIQUE,         -- source/<revision>/distill/<run>/
  kept_claims INTEGER,
  dropped_claims INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  UNIQUE (source_revision_id, attempt_no)
);
CREATE INDEX distill_run_by_revision ON distill_run(source_revision_id, attempt_no DESC);
CREATE INDEX distill_run_by_state ON distill_run(state, created_at);


CREATE TRIGGER distill_run_terminal_immutable
BEFORE UPDATE ON distill_run
WHEN OLD.state IN ('done', 'partial', 'failed', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'terminal_distill_run_is_immutable');
END;

ALTER TABLE source_revision ADD COLUMN current_distill_run_id TEXT REFERENCES distill_run(id);


CREATE TRIGGER source_revision_distill_null_on_insert
BEFORE INSERT ON source_revision
WHEN NEW.current_distill_run_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'current_distill_run_must_start_null');
END;

CREATE TRIGGER source_revision_distill_guard
BEFORE UPDATE OF current_distill_run_id ON source_revision
WHEN NEW.current_distill_run_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'current_distill_run_wrong_revision_or_state')
  WHERE NOT EXISTS (
    SELECT 1 FROM distill_run r
    WHERE r.id = NEW.current_distill_run_id
      AND r.source_revision_id = NEW.id
      AND r.state IN ('done', 'partial')
  );
END;

CREATE TRIGGER distill_run_budget_guard_insert
BEFORE INSERT ON distill_run
WHEN NEW.budget_reservation_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'distill_budget_owner_mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM budget_reservation b
    WHERE b.id = NEW.budget_reservation_id
      AND b.operation_kind = 'distill'
      AND b.operation_id = NEW.id
  );
END;

CREATE TRIGGER distill_run_budget_guard_update
BEFORE UPDATE OF budget_reservation_id, id ON distill_run
WHEN NEW.budget_reservation_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'distill_budget_owner_mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM budget_reservation b
    WHERE b.id = NEW.budget_reservation_id
      AND b.operation_kind = 'distill'
      AND b.operation_id = NEW.id
  );
END;

-- Only the currently accepted claim set remains in this table. A successful
-- retry replaces one revision's claims in a transaction and advances
-- current_distill_run_id after the R2 artifacts exist.
CREATE TABLE claim (
  id TEXT PRIMARY KEY,
  source_revision_id TEXT NOT NULL REFERENCES source_revision(id),
  distill_run_id TEXT NOT NULL REFERENCES distill_run(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('method', 'result', 'limitation', 'dataset', 'definition', 'other')),
  statement TEXT NOT NULL,

  subject TEXT,
  task TEXT,
  metric TEXT,
  dataset TEXT,
  split TEXT,
  protocol TEXT,
  value_text TEXT,
  value_number REAL,
  unit TEXT,
  higher_is_better INTEGER CHECK (higher_is_better IN (0, 1)),
  conditions_text TEXT,
  conditions_json TEXT NOT NULL DEFAULT '{}',

  quote TEXT NOT NULL,
  block_index INTEGER NOT NULL CHECK (block_index >= 0),
  start_byte INTEGER NOT NULL CHECK (start_byte >= 0),
  end_byte INTEGER NOT NULL,
  ambiguous INTEGER NOT NULL DEFAULT 0 CHECK (ambiguous IN (0, 1)),
  created_at INTEGER NOT NULL,
  UNIQUE (source_revision_id, ordinal),
  CHECK (end_byte > start_byte)
);
CREATE INDEX claim_by_revision ON claim(source_revision_id, ordinal);
CREATE INDEX claim_by_raw_key ON claim(subject, task, metric, dataset, split);


CREATE TRIGGER claim_run_guard_insert
BEFORE INSERT ON claim
BEGIN
  SELECT RAISE(ABORT, 'claim_run_wrong_revision_or_state')
  WHERE NOT EXISTS (
    SELECT 1 FROM distill_run r
    WHERE r.id = NEW.distill_run_id
      AND r.source_revision_id = NEW.source_revision_id
      AND r.state IN ('done', 'partial')
  );
END;

CREATE TRIGGER claim_run_guard_update
BEFORE UPDATE OF distill_run_id, source_revision_id ON claim
BEGIN
  SELECT RAISE(ABORT, 'claim_run_wrong_revision_or_state')
  WHERE NOT EXISTS (
    SELECT 1 FROM distill_run r
    WHERE r.id = NEW.distill_run_id
      AND r.source_revision_id = NEW.source_revision_id
      AND r.state IN ('done', 'partial')
  );
END;
