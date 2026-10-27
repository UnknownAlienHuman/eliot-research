-- K6: each generated page revision owns its bounded operation and usage.
ALTER TABLE project ADD COLUMN knowledge_page_id TEXT REFERENCES page(id);
ALTER TABLE project ADD COLUMN knowledge_active_revision_id TEXT REFERENCES page_revision(id);
ALTER TABLE page_revision ADD COLUMN generation_state TEXT NOT NULL DEFAULT 'none'
  CHECK (generation_state IN ('none','running','paused','done','failed'));
ALTER TABLE page_revision ADD COLUMN generation_error TEXT;
ALTER TABLE page_revision ADD COLUMN generation_payload_key TEXT;
ALTER TABLE page_revision ADD COLUMN model TEXT;
ALTER TABLE page_revision ADD COLUMN model_calls INTEGER NOT NULL DEFAULT 0 CHECK (model_calls BETWEEN 0 AND 2);
ALTER TABLE page_revision ADD COLUMN model_input_tokens INTEGER;
ALTER TABLE page_revision ADD COLUMN model_cached_tokens INTEGER;
ALTER TABLE page_revision ADD COLUMN model_output_tokens INTEGER;
ALTER TABLE page_revision ADD COLUMN model_estimated_cost_microusd INTEGER
  CHECK (model_estimated_cost_microusd IS NULL OR model_estimated_cost_microusd >= 0);
ALTER TABLE page_revision ADD COLUMN model_pricing_checked_on TEXT;
ALTER TABLE page_revision ADD COLUMN model_started_at INTEGER;
CREATE INDEX knowledge_usage_by_started ON page_revision(model_started_at)
  WHERE model_started_at IS NOT NULL;

-- Only the accepted head's actual input revisions make a page stale.
CREATE TRIGGER page_stale_on_readable_replacement AFTER UPDATE OF current_revision_id ON source
WHEN OLD.current_revision_id IS NOT NULL AND NEW.current_revision_id IS NOT OLD.current_revision_id
BEGIN
  UPDATE page SET freshness='stale'
    WHERE head_revision_id IN (
      SELECT r.id FROM page_revision r, json_each(r.inputs_json) input
      WHERE input.value=OLD.current_revision_id
    );
END;
CREATE TRIGGER page_stale_on_understanding_change AFTER UPDATE OF distill_report_key ON source_revision
WHEN OLD.distill_report_key IS NOT NEW.distill_report_key
BEGIN
  UPDATE page SET freshness='stale'
    WHERE head_revision_id IN (
      SELECT r.id FROM page_revision r, json_each(r.inputs_json) input WHERE input.value=NEW.id
    );
END;
CREATE TRIGGER map_stale_on_source_attach AFTER INSERT ON project_source
BEGIN
  UPDATE page SET freshness='stale'
    WHERE id=(SELECT knowledge_page_id FROM project WHERE id=NEW.project_id);
END;
CREATE TRIGGER page_stale_on_source_detach AFTER DELETE ON project_source
BEGIN
  UPDATE page SET freshness='stale' WHERE project_id=OLD.project_id AND (
    id=(SELECT knowledge_page_id FROM project WHERE id=OLD.project_id) OR
    head_revision_id IN (
      SELECT r.id FROM page_revision r, json_each(r.inputs_json) input
      JOIN source_revision s ON s.id=input.value WHERE s.source_id=OLD.source_id
    )
  );
END;
