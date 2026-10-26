-- K3 Distill: one-time source understanding, measured model usage and verified claim cards.
-- See docs/MAP.md K3 and docs/IMPLEMENTATION.md §§5–6, 11–12.

ALTER TABLE settings ADD COLUMN distill_model TEXT NOT NULL
  DEFAULT 'workers-ai:@cf/zai-org/glm-5.3-flash';
ALTER TABLE settings ADD COLUMN auto_distill INTEGER NOT NULL DEFAULT 1
  CHECK (auto_distill IN (0, 1));

ALTER TABLE source ADD COLUMN authors TEXT NOT NULL DEFAULT '';
ALTER TABLE source ADD COLUMN published TEXT;             -- source-provided date/year, possibly partial

ALTER TABLE source_revision ADD COLUMN distill_state TEXT NOT NULL DEFAULT 'none'
  CHECK (distill_state IN ('none', 'queued', 'running', 'paused', 'done', 'partial', 'failed'));
ALTER TABLE source_revision ADD COLUMN distill_model TEXT;
ALTER TABLE source_revision ADD COLUMN distill_input_tokens INTEGER;
ALTER TABLE source_revision ADD COLUMN distill_cached_tokens INTEGER;
ALTER TABLE source_revision ADD COLUMN distill_output_tokens INTEGER;
ALTER TABLE source_revision ADD COLUMN distill_estimated_cost_microusd INTEGER
  CHECK (distill_estimated_cost_microusd IS NULL OR distill_estimated_cost_microusd >= 0);
ALTER TABLE source_revision ADD COLUMN distill_pricing_checked_on TEXT;
ALTER TABLE source_revision ADD COLUMN distill_error TEXT;
ALTER TABLE source_revision ADD COLUMN distill_started_at INTEGER;
ALTER TABLE source_revision ADD COLUMN distill_calls INTEGER NOT NULL DEFAULT 0 CHECK (distill_calls BETWEEN 0 AND 2);
ALTER TABLE source_revision ADD COLUMN distill_ms INTEGER;
ALTER TABLE source_revision ADD COLUMN distill_report_key TEXT; -- explicit storage-only completion, original report retained
ALTER TABLE source_revision ADD COLUMN claim_count INTEGER NOT NULL DEFAULT 0 CHECK (claim_count BETWEEN 0 AND 32);
-- Current claims are the ordinal prefix [0, claim_count). Cached corrections retain old trailing rows.
ALTER TABLE source_revision ADD COLUMN guide_summary TEXT;
CREATE INDEX source_revision_distill_queue ON source_revision(distill_state, created_at);

-- Every claim has a quote that code resolved to exact canonical-text bytes.
CREATE TABLE claim (
  id TEXT PRIMARY KEY,
  source_revision_id TEXT NOT NULL REFERENCES source_revision(id),
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('method', 'result', 'limitation', 'dataset', 'definition', 'other')),
  statement TEXT NOT NULL,
  task TEXT,                                      -- source-language/raw semantic key
  metric TEXT,
  dataset TEXT,
  value_text TEXT,                                -- value as written in the source
  value_number REAL,                              -- parsed only when code can do so unambiguously
  unit TEXT,
  conditions TEXT,
  quote TEXT NOT NULL,
  block_index INTEGER NOT NULL,
  start_byte INTEGER NOT NULL,
  end_byte INTEGER NOT NULL,
  ambiguous INTEGER NOT NULL DEFAULT 0 CHECK (ambiguous IN (0, 1)),
  created_at INTEGER NOT NULL,
  UNIQUE (source_revision_id, ordinal),
  CHECK (end_byte > start_byte)
);
CREATE INDEX claim_by_revision ON claim(source_revision_id, ordinal);
CREATE INDEX claim_by_raw_key ON claim(task, metric, dataset);
