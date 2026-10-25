-- K3 Distill: bibliographic fields filled by distillation, distillation state and report, claim cards.

ALTER TABLE settings ADD COLUMN distill_model TEXT NOT NULL DEFAULT 'workers-ai:@cf/zai-org/glm-5.3-flash';

ALTER TABLE source ADD COLUMN authors TEXT NOT NULL DEFAULT '';   -- display string
ALTER TABLE source ADD COLUMN published TEXT;                    -- as given, possibly partial ('2017')

ALTER TABLE source_revision ADD COLUMN distill_state TEXT NOT NULL DEFAULT 'none'
  CHECK (distill_state IN ('none', 'queued', 'running', 'done', 'partial', 'failed'));
ALTER TABLE source_revision ADD COLUMN distill_model TEXT;
ALTER TABLE source_revision ADD COLUMN distill_input_tokens INTEGER;
ALTER TABLE source_revision ADD COLUMN distill_output_tokens INTEGER;
ALTER TABLE source_revision ADD COLUMN guide_summary TEXT;           -- first sentence of the guide, for lists

-- Every card carries a verbatim quote that code located in text.md (IMPLEMENTATION §5).
CREATE TABLE claim (
  id TEXT PRIMARY KEY,
  source_revision_id TEXT NOT NULL REFERENCES source_revision(id),
  kind TEXT NOT NULL CHECK (kind IN ('method', 'result', 'limitation', 'dataset', 'definition', 'other')),
  statement TEXT NOT NULL,            -- one sentence in the source language
  task TEXT,                          -- normalised keys for comparison tables (K6)
  metric TEXT,
  dataset TEXT,
  value TEXT,                         -- number with unit, as written
  conditions TEXT,
  quote TEXT NOT NULL,
  block_index INTEGER NOT NULL,
  start_byte INTEGER NOT NULL,        -- UTF-8 range of the quote in text.md
  end_byte INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (end_byte > start_byte)
);
CREATE INDEX claim_by_revision ON claim(source_revision_id);
CREATE INDEX claim_by_key ON claim(task, metric);

