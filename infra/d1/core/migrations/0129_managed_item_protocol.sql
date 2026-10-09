PRAGMA foreign_keys = ON;

-- The new per-item protocol is opt-in per generation. Historical rows remain
-- NULL and are not synthesized into per-item proof.
ALTER TABLE projection_generation ADD COLUMN managed_item_protocol TEXT
  CHECK (managed_item_protocol IS NULL OR
    managed_item_protocol = 'eliotr.managed-item-effects.v1');
ALTER TABLE projection_generation ADD COLUMN managed_target_instance_id TEXT
  CHECK (managed_target_instance_id IS NULL OR
    length(managed_target_instance_id) BETWEEN 1 AND 256);
ALTER TABLE projection_generation ADD COLUMN managed_target_generation TEXT
  CHECK (managed_target_generation IS NULL OR
    length(managed_target_generation) BETWEEN 1 AND 256);

CREATE TRIGGER projection_generation_managed_item_protocol_insert_guard
BEFORE INSERT ON projection_generation
WHEN NEW.managed_item_protocol IS NOT 'eliotr.managed-item-effects.v1'
  OR (
    NEW.managed_target_instance_id IS NULL OR
    NEW.managed_target_generation IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_MANAGED_ITEM_PROTOCOL_INVALID');
END;

CREATE TRIGGER projection_generation_managed_item_protocol_immutable
BEFORE UPDATE OF managed_item_protocol, managed_target_instance_id,
  managed_target_generation ON projection_generation
WHEN NEW.managed_item_protocol IS NOT OLD.managed_item_protocol
  OR NEW.managed_target_instance_id IS NOT OLD.managed_target_instance_id
  OR NEW.managed_target_generation IS NOT OLD.managed_target_generation
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_MANAGED_ITEM_TARGET_IMMUTABLE');
END;

-- Effect rows must inherit the immutable target pinned by their exact parent.
CREATE TRIGGER projection_managed_item_effect_target_pin_insert_guard
BEFORE INSERT ON projection_managed_item_effect
WHEN NOT EXISTS (
  SELECT 1 FROM projection_generation g
  WHERE g.source_revision_ref = NEW.source_revision_ref
    AND g.projection_generation = NEW.projection_generation
    AND g.job_id = NEW.job_id
    AND g.managed_item_protocol IS 'eliotr.managed-item-effects.v1'
    AND g.managed_target_instance_id IS NEW.managed_instance_id
    AND g.managed_target_generation IS NEW.managed_generation
)
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_MANAGED_ITEM_TARGET_MISMATCH');
END;

-- ER-28 retains Core tombstone authority; keep versioned target identity from
-- being reset by deleting and reinserting the same generation key. Historical
-- NULL-marker rows retain their prior deletion behavior.
CREATE TRIGGER projection_generation_managed_item_protocol_no_delete
BEFORE DELETE ON projection_generation
WHEN OLD.managed_item_protocol IS 'eliotr.managed-item-effects.v1'
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_MANAGED_ITEM_TARGET_IMMUTABLE');
END;
