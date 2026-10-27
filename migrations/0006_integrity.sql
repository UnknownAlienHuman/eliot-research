-- Cross-contour integrity guards discovered while reconciling the superseded
-- final-contract audit with the implemented K1-K3 schema. These triggers are
-- appended because migrations 0001-0005 have already shipped on main.

PRAGMA foreign_keys = ON;

-- A source is created before its first revision. Afterwards its accepted head
-- may point only at a readable, non-deleted revision owned by that source.
CREATE TRIGGER source_current_revision_null_on_insert
BEFORE INSERT ON source
WHEN NEW.current_revision_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'source_current_revision_must_start_null');
END;

CREATE TRIGGER source_current_revision_guard
BEFORE UPDATE OF current_revision_id ON source
WHEN NEW.current_revision_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'current_revision_wrong_source_or_state')
  WHERE NOT EXISTS (
    SELECT 1 FROM source_revision r
    WHERE r.id = NEW.current_revision_id
      AND r.source_id = NEW.id
      AND r.readable_state IN ('readable', 'readable_with_warnings')
      AND r.deleted_at IS NULL
  );
END;

-- Capture identity is immutable. Conversion, understanding and lifecycle state
-- remain mutable in their existing columns; replacement creates a new revision.
CREATE TRIGGER source_revision_capture_identity_immutable
BEFORE UPDATE ON source_revision
WHEN NEW.id <> OLD.id
  OR NEW.source_id <> OLD.source_id
  OR NEW.revision_no <> OLD.revision_no
  OR NEW.original_key IS NOT OLD.original_key
  OR NEW.original_sha256 IS NOT OLD.original_sha256
  OR NEW.original_size IS NOT OLD.original_size
  OR NEW.original_filename IS NOT OLD.original_filename
  OR NEW.original_mime IS NOT OLD.original_mime
  OR NEW.created_by <> OLD.created_by
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'source_revision_capture_identity_is_immutable');
END;

-- A terminal turn is a measured receipt. Replays return the stored turn rather
-- than mutating its usage, state, scope or error fields.
CREATE TRIGGER chat_turn_terminal_immutable
BEFORE UPDATE ON chat_turn
WHEN OLD.state IN ('completed', 'partial', 'failed', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'terminal_chat_turn_is_immutable');
END;

-- A page starts without a head. Its accepted head must belong to the same page.
CREATE TRIGGER page_head_null_on_insert
BEFORE INSERT ON page
WHEN NEW.head_revision_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'page_head_must_start_null');
END;

CREATE TRIGGER page_head_guard
BEFORE UPDATE OF head_revision_id ON page
WHEN NEW.head_revision_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'page_head_wrong_page_or_status')
  WHERE NOT EXISTS (
    SELECT 1 FROM page_revision r
    WHERE r.id = NEW.head_revision_id
      AND r.page_id = NEW.id
      AND r.status = 'accepted'
  );
END;

CREATE TRIGGER page_revision_identity_immutable
BEFORE UPDATE ON page_revision
WHEN NEW.id <> OLD.id
  OR NEW.page_id <> OLD.page_id
  OR NEW.revision_no <> OLD.revision_no
  OR NEW.origin <> OLD.origin
  OR NEW.actor <> OLD.actor
  OR NEW.body_key <> OLD.body_key
  OR NEW.citations_key IS NOT OLD.citations_key
  OR NEW.inputs_json <> OLD.inputs_json
  OR NEW.mutation_id <> OLD.mutation_id
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'page_revision_identity_is_immutable');
END;

CREATE TRIGGER page_revision_status_transition
BEFORE UPDATE OF status ON page_revision
WHEN NEW.status <> OLD.status
BEGIN
  SELECT RAISE(ABORT, 'invalid_page_revision_transition')
  WHERE OLD.status <> 'proposed' OR NEW.status NOT IN ('accepted', 'rejected');
END;
