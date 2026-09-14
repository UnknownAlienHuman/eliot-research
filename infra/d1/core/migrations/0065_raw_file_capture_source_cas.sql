PRAGMA foreign_keys = ON;

-- An owner raw capture may bind one immutable upload to an existing source
-- head.  The pair is nullable for legacy captures and immutable thereafter;
-- the ingest authority rechecks it when preparing the normalized bundle.
ALTER TABLE raw_file_capture ADD COLUMN target_source_id TEXT;
ALTER TABLE raw_file_capture ADD COLUMN expected_head_revision_ref TEXT;

CREATE INDEX raw_file_capture_target_source_idx
  ON raw_file_capture(target_source_id, expected_head_revision_ref);

CREATE TRIGGER raw_file_capture_target_head_pair_insert
BEFORE INSERT ON raw_file_capture
WHEN (NEW.target_source_id IS NULL) <> (NEW.expected_head_revision_ref IS NULL)
  OR (NEW.target_source_id IS NOT NULL AND (
    length(NEW.target_source_id) NOT BETWEEN 1 AND 256
    OR length(NEW.expected_head_revision_ref) NOT BETWEEN 1 AND 256
  ))
BEGIN
  SELECT RAISE(ABORT, 'RAW_CAPTURE_TARGET_HEAD_PAIR_INVALID');
END;

CREATE TRIGGER raw_file_capture_target_head_pair_update
BEFORE UPDATE OF target_source_id, expected_head_revision_ref ON raw_file_capture
WHEN NEW.target_source_id IS NOT OLD.target_source_id
  OR NEW.expected_head_revision_ref IS NOT OLD.expected_head_revision_ref
  OR (NEW.target_source_id IS NULL) <> (NEW.expected_head_revision_ref IS NULL)
  OR (NEW.target_source_id IS NOT NULL AND (
    length(NEW.target_source_id) NOT BETWEEN 1 AND 256
    OR length(NEW.expected_head_revision_ref) NOT BETWEEN 1 AND 256
  ))
BEGIN
  SELECT RAISE(ABORT, 'RAW_CAPTURE_TARGET_HEAD_IMMUTABLE');
END;
