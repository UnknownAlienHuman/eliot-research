-- K5 Library scale: optional AI Search projection state and Eliot-local usage
-- counters. Canonical evidence remains in R2/source_revision.

PRAGMA foreign_keys = ON;

ALTER TABLE settings ADD COLUMN ai_search_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (ai_search_enabled IN (0, 1));
ALTER TABLE settings ADD COLUMN ai_search_profile_version TEXT;
ALTER TABLE settings ADD COLUMN ai_search_monthly_ingestion_cap INTEGER NOT NULL DEFAULT 4500000
  CHECK (ai_search_monthly_ingestion_cap >= 0);
ALTER TABLE settings ADD COLUMN ai_search_monthly_semantic_cap INTEGER NOT NULL DEFAULT 900
  CHECK (ai_search_monthly_semantic_cap >= 0);
ALTER TABLE settings ADD COLUMN ai_search_monthly_fulltext_cap INTEGER NOT NULL DEFAULT 900
  CHECK (ai_search_monthly_fulltext_cap >= 0);
ALTER TABLE settings ADD COLUMN ai_search_indexed_bytes_cap INTEGER NOT NULL DEFAULT 9663676416
  CHECK (ai_search_indexed_bytes_cap >= 0); -- 9 GiB

CREATE TABLE search_projection_run (
  id TEXT PRIMARY KEY,
  source_revision_id TEXT NOT NULL REFERENCES source_revision(id),
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  workflow_id TEXT NOT NULL UNIQUE,
  profile_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'ready', 'blocked', 'failed', 'cancelled')),
  budget_reservation_id TEXT UNIQUE REFERENCES budget_reservation(id),
  estimated_ingestion_tokens INTEGER NOT NULL CHECK (estimated_ingestion_tokens >= 0),
  actual_ingestion_tokens INTEGER CHECK (actual_ingestion_tokens IS NULL OR actual_ingestion_tokens >= 0),
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  UNIQUE (source_revision_id, profile_version, attempt_no)
);
CREATE INDEX search_projection_run_by_state ON search_projection_run(state, created_at);


CREATE TRIGGER search_projection_run_terminal_immutable
BEFORE UPDATE ON search_projection_run
WHEN OLD.state IN ('ready', 'blocked', 'failed', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'terminal_search_projection_run_is_immutable');
END;


CREATE TRIGGER search_projection_run_budget_guard_insert
BEFORE INSERT ON search_projection_run
WHEN NEW.budget_reservation_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'search_ingest_budget_owner_mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM budget_reservation b
    WHERE b.id = NEW.budget_reservation_id
      AND b.operation_kind = 'ai_search_ingest'
      AND b.operation_id = NEW.id
  );
END;

CREATE TRIGGER search_projection_run_budget_guard_update
BEFORE UPDATE OF budget_reservation_id, id ON search_projection_run
WHEN NEW.budget_reservation_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'search_ingest_budget_owner_mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM budget_reservation b
    WHERE b.id = NEW.budget_reservation_id
      AND b.operation_kind = 'ai_search_ingest'
      AND b.operation_id = NEW.id
  );
END;

CREATE TABLE search_projection (
  source_revision_id TEXT PRIMARY KEY REFERENCES source_revision(id),
  profile_version TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'indexing', 'ready', 'blocked', 'failed', 'deleted')),
  indexed_sha256 TEXT CHECK (indexed_sha256 IS NULL OR length(indexed_sha256) = 64),
  indexed_bytes INTEGER CHECK (indexed_bytes IS NULL OR indexed_bytes >= 0),
  ingestion_tokens INTEGER CHECK (ingestion_tokens IS NULL OR ingestion_tokens >= 0),
  item_count INTEGER CHECK (item_count IS NULL OR item_count >= 0),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
ALTER TABLE search_projection ADD COLUMN current_run_id TEXT REFERENCES search_projection_run(id);


CREATE TRIGGER search_projection_current_run_null_on_insert
BEFORE INSERT ON search_projection
WHEN NEW.current_run_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'search_current_run_must_start_null');
END;


CREATE TRIGGER search_projection_current_run_guard
BEFORE UPDATE OF current_run_id, profile_version ON search_projection
WHEN NEW.current_run_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'search_current_run_wrong_projection_or_state')
  WHERE NOT EXISTS (
    SELECT 1 FROM search_projection_run r
    WHERE r.id = NEW.current_run_id
      AND r.source_revision_id = NEW.source_revision_id
      AND r.profile_version = NEW.profile_version
      AND r.state = 'ready'
  );
END;
CREATE INDEX search_projection_by_state ON search_projection(state, updated_at);

-- A canonical revision larger than one AI Search item is split at source-block
-- boundaries. Offsets returned by Search are segment-local and are translated
-- through start_byte plus the stored chunk map before citation.
CREATE TABLE search_projection_item (
  source_revision_id TEXT NOT NULL REFERENCES source_revision(id),
  profile_version TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  item_key TEXT NOT NULL UNIQUE,               -- revision/<uuid>/<profile>/<ordinal>.md
  item_id TEXT UNIQUE,
  start_byte INTEGER NOT NULL CHECK (start_byte >= 0),
  end_byte INTEGER NOT NULL,
  chunks_key TEXT,                             -- source/<revision>/search/<profile>/<ordinal>.json
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'indexing', 'ready', 'failed', 'deleted')),
  ingestion_tokens INTEGER CHECK (ingestion_tokens IS NULL OR ingestion_tokens >= 0),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_revision_id, profile_version, ordinal),
  CHECK (end_byte > start_byte)
);
CREATE INDEX search_projection_item_by_state
  ON search_projection_item(state, updated_at);

CREATE TABLE search_query_run (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES project(id),
  owner_operation_kind TEXT NOT NULL CHECK (owner_operation_kind IN ('chat_turn', 'mcp_tool', 'eval', 'research_job')),
  owner_operation_id TEXT NOT NULL,
  step_no INTEGER NOT NULL CHECK (step_no >= 1),
  scope_json TEXT NOT NULL,                    -- frozen source_revision UUIDs
  query TEXT NOT NULL CHECK (length(query) BETWEEN 1 AND 20000),
  retrieval_type TEXT NOT NULL CHECK (retrieval_type IN ('fulltext', 'hybrid')),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'dispatched', 'completed', 'failed', 'cancelled')),
  budget_reservation_id TEXT NOT NULL REFERENCES budget_reservation(id),
  budget_mode TEXT NOT NULL CHECK (budget_mode IN ('direct', 'aggregate')),
  result_count INTEGER CHECK (result_count IS NULL OR result_count >= 0),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  error TEXT,
  created_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  finished_at INTEGER,
  UNIQUE (owner_operation_kind, owner_operation_id, step_no)
);
CREATE INDEX search_query_run_by_owner
  ON search_query_run(owner_operation_kind, owner_operation_id, created_at);


CREATE TRIGGER search_query_run_terminal_immutable
BEFORE UPDATE ON search_query_run
WHEN OLD.state IN ('completed', 'failed', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'terminal_search_query_run_is_immutable');
END;


CREATE TRIGGER search_query_budget_guard_insert
BEFORE INSERT ON search_query_run
BEGIN
  SELECT RAISE(ABORT, 'search_query_budget_owner_mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM budget_reservation b
    WHERE b.id = NEW.budget_reservation_id
      AND (
        (NEW.budget_mode = 'direct'
          AND b.operation_kind = 'ai_search_query'
          AND b.operation_id = NEW.id)
        OR
        (NEW.budget_mode = 'aggregate'
          AND NEW.owner_operation_kind = 'research_job'
          AND b.operation_kind = 'research'
          AND b.operation_id = NEW.owner_operation_id)
      )
  );
END;

CREATE TRIGGER search_query_budget_guard_update
BEFORE UPDATE OF budget_reservation_id, budget_mode, owner_operation_kind, owner_operation_id, id
ON search_query_run
BEGIN
  SELECT RAISE(ABORT, 'search_query_budget_owner_mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM budget_reservation b
    WHERE b.id = NEW.budget_reservation_id
      AND (
        (NEW.budget_mode = 'direct'
          AND b.operation_kind = 'ai_search_query'
          AND b.operation_id = NEW.id)
        OR
        (NEW.budget_mode = 'aggregate'
          AND NEW.owner_operation_kind = 'research_job'
          AND b.operation_kind = 'research'
          AND b.operation_id = NEW.owner_operation_id)
      )
  );
END;

CREATE TABLE search_usage_month (
  month_key TEXT PRIMARY KEY CHECK (month_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  ingestion_tokens INTEGER NOT NULL DEFAULT 0 CHECK (ingestion_tokens >= 0),
  semantic_queries INTEGER NOT NULL DEFAULT 0 CHECK (semantic_queries >= 0),
  fulltext_queries INTEGER NOT NULL DEFAULT 0 CHECK (fulltext_queries >= 0),
  indexed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (indexed_bytes >= 0),
  updated_at INTEGER NOT NULL
);
