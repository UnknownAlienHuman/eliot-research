-- K7 Deep research: explicit bounded jobs. One job owns one Workflow instance
-- and one aggregate paid-effect reservation. Web results are leads until captured
-- as source revisions.

PRAGMA foreign_keys = ON;

ALTER TABLE settings ADD COLUMN research_model TEXT NOT NULL
  DEFAULT 'workers-ai:@cf/zai-org/glm-5.3-flash';
ALTER TABLE settings ADD COLUMN web_search_provider TEXT NOT NULL DEFAULT 'ceramic'
  CHECK (web_search_provider IN ('ceramic', 'exa', 'linkup'));

CREATE TABLE research_job (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  question TEXT NOT NULL CHECK (length(question) BETWEEN 1 AND 20000),
  scope_json TEXT NOT NULL,                     -- frozen source_revision UUID array
  allow_web INTEGER NOT NULL DEFAULT 0 CHECK (allow_web IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN (
    'queued', 'running', 'stopping', 'completed', 'partial',
    'failed', 'cancelled', 'paused_budget'
  )),
  model_route TEXT NOT NULL,
  workflow_id TEXT NOT NULL UNIQUE,
  budget_reservation_id TEXT NOT NULL UNIQUE REFERENCES budget_reservation(id),

  max_model_calls INTEGER NOT NULL CHECK (max_model_calls BETWEEN 0 AND 64),
  max_input_tokens INTEGER NOT NULL CHECK (max_input_tokens >= 0),
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens >= 0),
  max_web_queries INTEGER NOT NULL CHECK (max_web_queries BETWEEN 0 AND 64),
  max_web_captures INTEGER NOT NULL CHECK (max_web_captures BETWEEN 0 AND 64),
  max_browser_seconds INTEGER NOT NULL CHECK (max_browser_seconds BETWEEN 0 AND 3600),
  deadline_at INTEGER NOT NULL,

  used_model_calls INTEGER NOT NULL DEFAULT 0 CHECK (used_model_calls >= 0),
  used_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (used_input_tokens >= 0),
  used_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (used_output_tokens >= 0),
  used_web_queries INTEGER NOT NULL DEFAULT 0 CHECK (used_web_queries >= 0),
  used_web_captures INTEGER NOT NULL DEFAULT 0 CHECK (used_web_captures >= 0),
  used_browser_seconds INTEGER NOT NULL DEFAULT 0 CHECK (used_browser_seconds >= 0),

  plan_key TEXT,                                -- job/<id>/plan.json
  progress_json TEXT NOT NULL DEFAULT '{}',
  progress_seq INTEGER NOT NULL DEFAULT 0 CHECK (progress_seq >= 0),
  partial_key TEXT,                             -- job/<id>/partial.md
  result_page_id TEXT REFERENCES page(id),
  stop_requested_at INTEGER,
  error TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  CHECK (used_model_calls <= max_model_calls),
  CHECK (used_input_tokens <= max_input_tokens),
  CHECK (used_output_tokens <= max_output_tokens),
  CHECK (used_web_queries <= max_web_queries),
  CHECK (used_web_captures <= max_web_captures),
  CHECK (used_browser_seconds <= max_browser_seconds)
);
CREATE INDEX research_job_by_project ON research_job(project_id, created_at DESC);
CREATE INDEX research_job_by_state ON research_job(state, created_at);


CREATE TRIGGER research_job_terminal_immutable
BEFORE UPDATE ON research_job
WHEN OLD.state IN ('completed', 'partial', 'failed', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'terminal_research_job_is_immutable');
END;

CREATE TRIGGER research_job_result_guard_insert
BEFORE INSERT ON research_job
WHEN NEW.result_page_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'research_result_wrong_project_or_kind')
  WHERE NOT EXISTS (
    SELECT 1 FROM page p
    WHERE p.id = NEW.result_page_id
      AND p.project_id = NEW.project_id
      AND p.kind = 'report'
  );
END;


CREATE TRIGGER research_job_budget_guard_insert
BEFORE INSERT ON research_job
BEGIN
  SELECT RAISE(ABORT, 'research_budget_owner_mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM budget_reservation b
    WHERE b.id = NEW.budget_reservation_id
      AND b.operation_kind = 'research'
      AND b.operation_id = NEW.id
  );
END;

CREATE TRIGGER research_job_budget_guard_update
BEFORE UPDATE OF budget_reservation_id, id ON research_job
BEGIN
  SELECT RAISE(ABORT, 'research_budget_owner_mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM budget_reservation b
    WHERE b.id = NEW.budget_reservation_id
      AND b.operation_kind = 'research'
      AND b.operation_id = NEW.id
  );
END;

CREATE TRIGGER research_job_result_guard
BEFORE UPDATE OF result_page_id ON research_job
WHEN NEW.result_page_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'research_result_wrong_project_or_kind')
  WHERE NOT EXISTS (
    SELECT 1 FROM page p
    WHERE p.id = NEW.result_page_id
      AND p.project_id = NEW.project_id
      AND p.kind = 'report'
  );
END;

-- Every planned external/model effect is durable before dispatch. An unknown
-- dispatched outcome is never automatically replayed.
CREATE TABLE research_job_call (
  job_id TEXT NOT NULL REFERENCES research_job(id),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  call_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN (
    'model', 'web_search', 'static_capture', 'browser_capture', 'library_read'
  )),
  state TEXT NOT NULL CHECK (state IN (
    'planned', 'dispatched', 'completed', 'failed', 'unknown', 'cancelled'
  )),
  route_or_provider TEXT,
  input_key TEXT,                              -- job/<id>/calls/<seq>/input.json
  result_key TEXT,                             -- job/<id>/calls/<seq>/result.json|md
  estimated_cost_microusd INTEGER NOT NULL DEFAULT 0 CHECK (estimated_cost_microusd >= 0),
  actual_cost_microusd INTEGER CHECK (actual_cost_microusd IS NULL OR actual_cost_microusd >= 0),
  input_tokens_total INTEGER CHECK (input_tokens_total IS NULL OR input_tokens_total >= 0),
  input_tokens_uncached INTEGER CHECK (input_tokens_uncached IS NULL OR input_tokens_uncached >= 0),
  cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  usage_quality TEXT CHECK (usage_quality IN ('exact', 'derived', 'conservative', 'unknown')),
  browser_seconds INTEGER CHECK (browser_seconds IS NULL OR browser_seconds >= 0),
  error TEXT,
  created_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  finished_at INTEGER,
  PRIMARY KEY (job_id, seq)
);
CREATE INDEX research_job_call_by_state ON research_job_call(job_id, state, seq);

CREATE TABLE research_job_evidence (
  job_id TEXT NOT NULL REFERENCES research_job(id),
  source_revision_id TEXT NOT NULL REFERENCES source_revision(id),
  origin TEXT NOT NULL CHECK (origin IN ('initial', 'captured')),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, source_revision_id)
);
CREATE INDEX research_job_evidence_by_revision
  ON research_job_evidence(source_revision_id, job_id);
