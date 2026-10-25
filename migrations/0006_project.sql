-- K6 Project knowledge: bounded incremental project-map runs and accepted map pointer.

PRAGMA foreign_keys = ON;

ALTER TABLE settings ADD COLUMN project_knowledge_model TEXT NOT NULL
  DEFAULT 'workers-ai:@cf/zai-org/glm-5.3-flash';
ALTER TABLE settings ADD COLUMN max_project_map_reserved_microusd INTEGER NOT NULL DEFAULT 500000
  CHECK (max_project_map_reserved_microusd >= 0);

CREATE TABLE project_knowledge_run (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  input_revisions_json TEXT NOT NULL,          -- sorted full source_revision UUIDs
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  workflow_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'running', 'paused_budget', 'done', 'partial', 'failed', 'cancelled'
  )),
  model_route TEXT NOT NULL,
  budget_reservation_id TEXT UNIQUE REFERENCES budget_reservation(id),
  max_model_calls INTEGER NOT NULL DEFAULT 1 CHECK (max_model_calls BETWEEN 0 AND 1),
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

  result_page_revision_id TEXT REFERENCES page_revision(id),
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  UNIQUE (project_id, input_hash, attempt_no)
);
CREATE INDEX project_knowledge_run_by_project
  ON project_knowledge_run(project_id, created_at DESC);
CREATE INDEX project_knowledge_run_by_state
  ON project_knowledge_run(state, created_at);


CREATE TRIGGER project_knowledge_run_terminal_immutable
BEFORE UPDATE ON project_knowledge_run
WHEN OLD.state IN ('done', 'partial', 'failed', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'terminal_project_knowledge_run_is_immutable');
END;

CREATE TRIGGER project_knowledge_result_guard_insert
BEFORE INSERT ON project_knowledge_run
WHEN NEW.result_page_revision_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'project_map_result_wrong_project_or_status')
  WHERE NOT EXISTS (
    SELECT 1
    FROM page_revision r
    JOIN page p ON p.id = r.page_id
    WHERE r.id = NEW.result_page_revision_id
      AND p.project_id = NEW.project_id
      AND p.kind = 'map'
      AND r.status = 'accepted'
  );
END;


CREATE TRIGGER project_knowledge_budget_guard_insert
BEFORE INSERT ON project_knowledge_run
WHEN NEW.budget_reservation_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'project_map_budget_owner_mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM budget_reservation b
    WHERE b.id = NEW.budget_reservation_id
      AND b.operation_kind = 'project_map'
      AND b.operation_id = NEW.id
  );
END;

CREATE TRIGGER project_knowledge_budget_guard_update
BEFORE UPDATE OF budget_reservation_id, id ON project_knowledge_run
WHEN NEW.budget_reservation_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'project_map_budget_owner_mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM budget_reservation b
    WHERE b.id = NEW.budget_reservation_id
      AND b.operation_kind = 'project_map'
      AND b.operation_id = NEW.id
  );
END;

CREATE TRIGGER project_knowledge_result_guard
BEFORE UPDATE OF result_page_revision_id ON project_knowledge_run
WHEN NEW.result_page_revision_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'project_map_result_wrong_project_or_status')
  WHERE NOT EXISTS (
    SELECT 1
    FROM page_revision r
    JOIN page p ON p.id = r.page_id
    WHERE r.id = NEW.result_page_revision_id
      AND p.project_id = NEW.project_id
      AND p.kind = 'map'
      AND r.status = 'accepted'
  );
END;

ALTER TABLE project ADD COLUMN current_map_run_id TEXT REFERENCES project_knowledge_run(id);


CREATE TRIGGER project_current_map_null_on_insert
BEFORE INSERT ON project
WHEN NEW.current_map_run_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'project_current_map_must_start_null');
END;

CREATE TRIGGER project_current_map_guard
BEFORE UPDATE OF current_map_run_id ON project
WHEN NEW.current_map_run_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'project_current_map_wrong_project_or_state')
  WHERE NOT EXISTS (
    SELECT 1 FROM project_knowledge_run r
    WHERE r.id = NEW.current_map_run_id
      AND r.project_id = NEW.id
      AND r.state IN ('done', 'partial')
      AND r.result_page_revision_id IS NOT NULL
  );
END;
