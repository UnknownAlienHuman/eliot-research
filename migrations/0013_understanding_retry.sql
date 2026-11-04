-- Current state remains on the revision. Explicit retry archives its terminal predecessor.
ALTER TABLE source_revision ADD COLUMN distill_attempt_id TEXT;
ALTER TABLE source_revision ADD COLUMN distill_request_json TEXT;
CREATE UNIQUE INDEX source_revision_distill_identity ON source_revision(coalesce(distill_attempt_id,id));
CREATE TABLE distill_history (
  attempt_id TEXT PRIMARY KEY,
  source_revision_id TEXT NOT NULL REFERENCES source_revision(id),
  request_json TEXT,
  snapshot_key TEXT,
  rejection TEXT,
  archived_at INTEGER NOT NULL,
  CHECK ((snapshot_key IS NOT NULL AND rejection IS NULL) OR (snapshot_key IS NULL AND rejection IS NOT NULL))
);
CREATE INDEX distill_history_revision ON distill_history(source_revision_id,archived_at,attempt_id);
CREATE TRIGGER distill_history_immutable BEFORE UPDATE ON distill_history
BEGIN SELECT RAISE(ABORT,'distill_history_is_immutable'); END;
CREATE TRIGGER distill_attempt_switch_guard BEFORE UPDATE OF distill_attempt_id ON source_revision
WHEN NEW.distill_attempt_id IS NOT OLD.distill_attempt_id
BEGIN
  SELECT RAISE(ABORT,'distill_attempt_requires_archived_failure')
  WHERE OLD.distill_state NOT IN ('failed','partial') OR NEW.distill_attempt_id IS NULL
    OR NOT EXISTS(SELECT 1 FROM distill_history WHERE attempt_id=coalesce(OLD.distill_attempt_id,OLD.id) AND source_revision_id=OLD.id)
    OR EXISTS(SELECT 1 FROM distill_history WHERE attempt_id=NEW.distill_attempt_id);
END;
