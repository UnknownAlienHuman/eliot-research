-- Explicit owner-requested PDF OCR. Inputs and preview bodies remain in R2.
-- Starting, polling and applying are separate operations; applying performs no inference.
CREATE TABLE source_ocr_job (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  source_id TEXT NOT NULL REFERENCES source(id),
  base_revision_id TEXT NOT NULL REFERENCES source_revision(id),
  base_current_revision_id TEXT REFERENCES source_revision(id),
  model_route TEXT NOT NULL,
  model_snapshot TEXT NOT NULL,
  page_count INTEGER NOT NULL CHECK (page_count BETWEEN 1 AND 1000),
  pages_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'preparing'
    CHECK (state IN ('preparing','queued','running','ready','failed','cancelled','applied')),
  calls INTEGER NOT NULL DEFAULT 0 CHECK (calls >= 0),
  completed_pages INTEGER NOT NULL DEFAULT 0 CHECK (completed_pages >= 0),
  token_limit INTEGER NOT NULL CHECK (token_limit > 0),
  input_tokens INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  deadline_at INTEGER,
  preview_sha256 TEXT,
  preview_size INTEGER,
  error TEXT,
  applied_revision_id TEXT REFERENCES source_revision(id),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  CHECK (calls <= page_count),
  CHECK (completed_pages <= page_count)
);
CREATE INDEX source_ocr_by_source ON source_ocr_job(source_id, created_at DESC);
