-- Explicit retry may archive a completed predecessor as well as a failed/partial one.
DROP TRIGGER distill_attempt_switch_guard;
CREATE TRIGGER distill_attempt_switch_guard BEFORE UPDATE OF distill_attempt_id ON source_revision
WHEN NEW.distill_attempt_id IS NOT OLD.distill_attempt_id
BEGIN
  SELECT RAISE(ABORT,'distill_attempt_requires_archived_terminal')
  WHERE OLD.distill_state NOT IN ('failed','partial','done') OR NEW.distill_attempt_id IS NULL
    OR NOT EXISTS(SELECT 1 FROM distill_history WHERE attempt_id=coalesce(OLD.distill_attempt_id,OLD.id)
      AND source_revision_id=OLD.id AND snapshot_key IS NOT NULL AND rejection IS NULL)
    OR EXISTS(SELECT 1 FROM distill_history WHERE attempt_id=NEW.distill_attempt_id);
END;
