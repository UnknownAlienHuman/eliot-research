-- Reuse the execution lease ledger. A promotion hold does NOT expire with its
-- worker: only exact Search transition readback and Core reconciliation release it.
ALTER TABLE operation_execution_lease ADD COLUMN managed_target_hold_json TEXT
  CHECK (managed_target_hold_json IS NULL OR json_valid(managed_target_hold_json));
ALTER TABLE operation_execution_lease ADD COLUMN managed_target_hold_sha256 TEXT;
ALTER TABLE operation_execution_lease ADD COLUMN managed_target_registry_readback_json TEXT
  CHECK (managed_target_registry_readback_json IS NULL OR json_valid(managed_target_registry_readback_json));

CREATE INDEX projection_managed_item_target_drain_idx
  ON projection_managed_item_effect(managed_instance_id,managed_generation,state);

CREATE TRIGGER managed_target_hold_shape_insert
BEFORE INSERT ON operation_execution_lease
WHEN (NEW.operation_kind='MANAGED_TARGET_PROMOTION' AND NEW.managed_target_hold_json IS NULL)
  OR (NEW.managed_target_hold_json IS NULL AND
      (NEW.managed_target_hold_sha256 IS NOT NULL OR NEW.managed_target_registry_readback_json IS NOT NULL))
  OR (NEW.managed_target_hold_json IS NOT NULL AND (
    NEW.operation_kind IS NOT 'MANAGED_TARGET_PROMOTION' OR NEW.state IS NOT 'LEASED'
    OR NEW.managed_target_registry_readback_json IS NOT NULL
    OR json_extract(NEW.managed_target_hold_json,'$.protocol') IS NOT 'eliotr.managed-generation-promotion-hold.v1'
    OR json_extract(NEW.managed_target_hold_json,'$.operation_id') IS NOT NEW.operation_id
    OR json_extract(NEW.managed_target_hold_json,'$.state') IS NOT 'HELD'
    OR json_extract(NEW.managed_target_hold_json,'$.operation') NOT IN ('QUALIFY','PROMOTE','ROLLBACK')
    OR json_type(NEW.managed_target_hold_json,'$.operation') IS NOT 'text'
    OR json_type(NEW.managed_target_hold_json,'$.targets') IS NOT 'array'
    OR json_array_length(NEW.managed_target_hold_json,'$.targets') NOT BETWEEN 1 AND 2
    OR length(NEW.managed_target_hold_sha256) IS NOT 64
    OR NEW.managed_target_hold_sha256 GLOB '*[^0-9a-f]*'
    OR json_extract(NEW.managed_target_hold_json,'$.hold_sha256') IS NOT NEW.managed_target_hold_sha256
    OR EXISTS (SELECT 1 FROM json_each(NEW.managed_target_hold_json,'$.targets') t
      WHERE json_type(t.value,'$.target.managed_instance_id') IS NOT 'text'
        OR json_type(t.value,'$.target.managed_generation') IS NOT 'text'
        OR json_extract(t.value,'$.outstanding_writer_count') IS NOT 0)
    OR (SELECT COUNT(DISTINCT json_extract(value,'$.target.managed_instance_id')||char(0)||
          json_extract(value,'$.target.managed_generation')) FROM json_each(NEW.managed_target_hold_json,'$.targets'))
       <> json_array_length(NEW.managed_target_hold_json,'$.targets')
  ))
BEGIN SELECT RAISE(ABORT,'MANAGED_TARGET_HOLD_INVALID'); END;

-- Insertion and the zero-writer predicate execute in the same Core transaction.
CREATE TRIGGER managed_target_hold_acquire_guard
BEFORE INSERT ON operation_execution_lease
WHEN NEW.managed_target_hold_json IS NOT NULL AND (
  EXISTS (SELECT 1 FROM json_each(NEW.managed_target_hold_json,'$.targets') t
    JOIN projection_managed_item_effect e
      ON e.managed_instance_id=json_extract(t.value,'$.target.managed_instance_id')
      AND e.managed_generation=json_extract(t.value,'$.target.managed_generation')
    WHERE e.state<>'READBACK_VERIFIED')
  OR EXISTS (SELECT 1 FROM operation_execution_lease l,
    json_each(l.managed_target_hold_json,'$.targets') a,
    json_each(NEW.managed_target_hold_json,'$.targets') b
    WHERE l.state='LEASED' AND l.managed_target_hold_json IS NOT NULL
      AND l.operation_id<>NEW.operation_id
      AND json_extract(a.value,'$.target.managed_instance_id')=json_extract(b.value,'$.target.managed_instance_id')
      AND json_extract(a.value,'$.target.managed_generation')=json_extract(b.value,'$.target.managed_generation'))
)
BEGIN SELECT RAISE(ABORT,'MANAGED_TARGET_WRITERS_NOT_DRAINED'); END;

CREATE TRIGGER managed_target_hold_immutable
BEFORE UPDATE ON operation_execution_lease
WHEN (OLD.managed_target_hold_json IS NULL AND
      (NEW.managed_target_hold_json IS NOT NULL OR NEW.managed_target_hold_sha256 IS NOT NULL
       OR NEW.managed_target_registry_readback_json IS NOT NULL))
  OR (OLD.managed_target_hold_json IS NOT NULL AND (
    NEW.operation_id IS NOT OLD.operation_id OR NEW.operation_kind IS NOT OLD.operation_kind
    OR NEW.lease_owner IS NOT OLD.lease_owner OR NEW.lease_generation IS NOT OLD.lease_generation
    OR NEW.attempt IS NOT OLD.attempt OR NEW.created_at IS NOT OLD.created_at
    OR NEW.managed_target_hold_json IS NOT OLD.managed_target_hold_json
    OR NEW.managed_target_hold_sha256 IS NOT OLD.managed_target_hold_sha256
    OR NEW.state NOT IN ('LEASED','COMPLETED')
    OR (OLD.state='COMPLETED' AND (NEW.state IS NOT 'COMPLETED'
      OR NEW.managed_target_registry_readback_json IS NOT OLD.managed_target_registry_readback_json
      OR NEW.terminal_receipt_ref IS NOT OLD.terminal_receipt_ref))
    OR (NEW.state='LEASED' AND NEW.managed_target_registry_readback_json IS NOT NULL)
    OR (NEW.state='COMPLETED' AND (NEW.managed_target_registry_readback_json IS NULL
      OR NEW.terminal_receipt_ref IS NULL))
  ))
BEGIN SELECT RAISE(ABORT,'MANAGED_TARGET_HOLD_IMMUTABLE'); END;

CREATE TRIGGER managed_target_hold_no_delete
BEFORE DELETE ON operation_execution_lease
WHEN OLD.managed_target_hold_json IS NOT NULL
BEGIN SELECT RAISE(ABORT,'MANAGED_TARGET_HOLD_IMMUTABLE'); END;

CREATE TRIGGER managed_target_hold_blocks_effect_prepare
BEFORE INSERT ON projection_managed_item_effect
WHEN EXISTS (SELECT 1 FROM operation_execution_lease l,
  json_each(l.managed_target_hold_json,'$.targets') t
  WHERE l.state='LEASED' AND l.managed_target_hold_json IS NOT NULL
    AND json_extract(t.value,'$.target.managed_instance_id')=NEW.managed_instance_id
    AND json_extract(t.value,'$.target.managed_generation')=NEW.managed_generation)
BEGIN SELECT RAISE(ABORT,'MANAGED_TARGET_WRITERS_HELD'); END;

CREATE TRIGGER managed_target_hold_blocks_effect_dispatch
BEFORE UPDATE OF state ON projection_managed_item_effect
WHEN NEW.state='DISPATCHED' AND EXISTS (SELECT 1 FROM operation_execution_lease l,
  json_each(l.managed_target_hold_json,'$.targets') t
  WHERE l.state='LEASED' AND l.managed_target_hold_json IS NOT NULL
    AND json_extract(t.value,'$.target.managed_instance_id')=NEW.managed_instance_id
    AND json_extract(t.value,'$.target.managed_generation')=NEW.managed_generation)
BEGIN SELECT RAISE(ABORT,'MANAGED_TARGET_WRITERS_HELD'); END;
