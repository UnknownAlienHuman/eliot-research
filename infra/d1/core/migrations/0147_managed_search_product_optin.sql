PRAGMA foreign_keys = ON;

-- V1 assignment rows stay byte-for-byte immutable and retain exact-generation
-- semantics. New V2 owner product decisions are explicitly marked in the same
-- append-only event and current-head tables.
ALTER TABLE managed_target_assignment_event
  ADD COLUMN decision_version INTEGER NOT NULL DEFAULT 1
    CHECK (decision_version IN (1, 2));
ALTER TABLE managed_target_assignment_event
  ADD COLUMN selection_mode TEXT NOT NULL DEFAULT 'EXACT_GENERATION_V1'
    CHECK (selection_mode IN ('EXACT_GENERATION_V1', 'STABLE_PHYSICAL_PROFILE_V2'));
ALTER TABLE managed_target_assignment_event
  ADD COLUMN product_alias TEXT
    CHECK (product_alias IS NULL OR product_alias = 'primary');

ALTER TABLE managed_target_assignment_current
  ADD COLUMN decision_version INTEGER NOT NULL DEFAULT 1
    CHECK (decision_version IN (1, 2));
ALTER TABLE managed_target_assignment_current
  ADD COLUMN selection_mode TEXT NOT NULL DEFAULT 'EXACT_GENERATION_V1'
    CHECK (selection_mode IN ('EXACT_GENERATION_V1', 'STABLE_PHYSICAL_PROFILE_V2'));
ALTER TABLE managed_target_assignment_current
  ADD COLUMN product_alias TEXT
    CHECK (product_alias IS NULL OR product_alias = 'primary');

CREATE TRIGGER managed_target_assignment_event_selection_guard
BEFORE INSERT ON managed_target_assignment_event
WHEN NOT (
  (NEW.decision_version = 1
    AND NEW.selection_mode = 'EXACT_GENERATION_V1'
    AND NEW.product_alias IS NULL)
  OR
  (NEW.decision_version = 2
    AND NEW.selection_mode = 'STABLE_PHYSICAL_PROFILE_V2'
    AND NEW.product_alias = 'primary')
)
BEGIN
  SELECT RAISE(ABORT, 'MANAGED_TARGET_SELECTION_VERSION_INVALID');
END;

-- V2 ENABLED is an explicit same-physical-profile upgrade from a current V1
-- assignment. Core verifies the reviewed immutable profile against SEARCH_DB
-- before append; this D1 guard prevents the upgrade from changing namespace
-- or physical instance. Every other active-to-active transition still retires.
DROP TRIGGER managed_target_assignment_event_insert_guard;
CREATE TRIGGER managed_target_assignment_event_insert_guard
BEFORE INSERT ON managed_target_assignment_event
BEGIN
  SELECT RAISE(ABORT, 'MANAGED_TARGET_ASSIGNMENT_CAS_CONFLICT')
  WHERE NEW.expected_event_revision <> COALESCE((
    SELECT MAX(event_revision)
    FROM managed_target_assignment_event
    WHERE project_id = NEW.project_id
  ), 0);

  SELECT RAISE(ABORT, 'MANAGED_TARGET_ASSIGNMENT_PROJECT_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1 FROM project p
    JOIN project_owner o ON o.project_id = p.project_id
    WHERE p.project_id = NEW.project_id
      AND p.generation = NEW.project_generation
      AND o.principal_ref = NEW.project_owner_principal_ref
  );

  SELECT RAISE(ABORT, 'MANAGED_TARGET_ASSIGNMENT_OWNER_ACTOR_MISMATCH')
  WHERE NEW.actor_kind = 'OWNER'
    AND NEW.actor_principal_ref <> NEW.project_owner_principal_ref;

  SELECT RAISE(ABORT, 'MANAGED_TARGET_ASSIGNMENT_ACTIVE_REQUIRES_RETIREMENT')
  WHERE NEW.event_kind = 'ASSIGN'
    AND EXISTS (
      SELECT 1 FROM managed_target_assignment_event current
      WHERE current.project_id = NEW.project_id
        AND current.event_revision = NEW.expected_event_revision
        AND current.event_kind = 'ASSIGN'
    )
    AND NOT EXISTS (
      SELECT 1 FROM managed_target_assignment_event prior
      WHERE prior.project_id = NEW.project_id
        AND prior.event_revision = NEW.expected_event_revision
        AND prior.event_kind = 'ASSIGN'
        AND prior.decision_version = 1
        AND prior.selection_mode = 'EXACT_GENERATION_V1'
        AND prior.project_owner_principal_ref = NEW.project_owner_principal_ref
        AND prior.target_namespace = NEW.target_namespace
        AND prior.managed_instance_id = NEW.managed_instance_id
        AND NEW.decision_version = 2
        AND NEW.selection_mode = 'STABLE_PHYSICAL_PROFILE_V2'
        AND NEW.product_alias = 'primary'
    );

  SELECT RAISE(ABORT, 'MANAGED_TARGET_ASSIGNMENT_RETIREMENT_STALE')
  WHERE NEW.event_kind = 'RETIRE'
    AND NOT EXISTS (
      SELECT 1 FROM managed_target_assignment_event prior
      WHERE prior.project_id = NEW.project_id
        AND prior.event_revision = NEW.expected_event_revision
        AND prior.event_revision = NEW.previous_assignment_revision
        AND prior.event_kind = 'ASSIGN'
        AND prior.project_owner_principal_ref = NEW.project_owner_principal_ref
    );
END;

-- The current table is a projection of the immutable event. Its added decision
-- fields must remain equal to the referenced event on inserts and upserts.
CREATE TRIGGER managed_target_assignment_current_event_match_insert
BEFORE INSERT ON managed_target_assignment_current
WHEN NOT EXISTS (
  SELECT 1 FROM managed_target_assignment_event e
  WHERE e.project_id = NEW.project_id
    AND e.event_revision = NEW.event_revision
    AND e.event_kind = NEW.event_kind
    AND e.target_namespace IS NEW.target_namespace
    AND e.managed_instance_id IS NEW.managed_instance_id
    AND e.managed_generation IS NEW.managed_generation
    AND e.target_profile_identity_sha256 IS NEW.target_profile_identity_sha256
    AND e.decision_version = NEW.decision_version
    AND e.selection_mode = NEW.selection_mode
    AND e.product_alias IS NEW.product_alias
)
BEGIN
  SELECT RAISE(ABORT, 'MANAGED_TARGET_ASSIGNMENT_CURRENT_EVENT_MISMATCH');
END;

CREATE TRIGGER managed_target_assignment_current_event_match_update
BEFORE UPDATE ON managed_target_assignment_current
WHEN NOT EXISTS (
  SELECT 1 FROM managed_target_assignment_event e
  WHERE e.project_id = NEW.project_id
    AND e.event_revision = NEW.event_revision
    AND e.event_kind = NEW.event_kind
    AND e.target_namespace IS NEW.target_namespace
    AND e.managed_instance_id IS NEW.managed_instance_id
    AND e.managed_generation IS NEW.managed_generation
    AND e.target_profile_identity_sha256 IS NEW.target_profile_identity_sha256
    AND e.decision_version = NEW.decision_version
    AND e.selection_mode = NEW.selection_mode
    AND e.product_alias IS NEW.product_alias
)
BEGIN
  SELECT RAISE(ABORT, 'MANAGED_TARGET_ASSIGNMENT_CURRENT_EVENT_MISMATCH');
END;

DROP TRIGGER managed_target_assignment_current_after_event_insert;
CREATE TRIGGER managed_target_assignment_current_after_event_insert
AFTER INSERT ON managed_target_assignment_event
BEGIN
  INSERT INTO managed_target_assignment_current(
    project_id, event_revision, event_kind, target_namespace,
    managed_instance_id, managed_generation, target_profile_identity_sha256,
    decision_version, selection_mode, product_alias
  ) VALUES (
    NEW.project_id, NEW.event_revision, NEW.event_kind, NEW.target_namespace,
    NEW.managed_instance_id, NEW.managed_generation, NEW.target_profile_identity_sha256,
    NEW.decision_version, NEW.selection_mode, NEW.product_alias
  )
  ON CONFLICT(project_id) DO UPDATE SET
    event_revision = excluded.event_revision,
    event_kind = excluded.event_kind,
    target_namespace = excluded.target_namespace,
    managed_instance_id = excluded.managed_instance_id,
    managed_generation = excluded.managed_generation,
    target_profile_identity_sha256 = excluded.target_profile_identity_sha256,
    decision_version = excluded.decision_version,
    selection_mode = excluded.selection_mode,
    product_alias = excluded.product_alias
  WHERE excluded.event_revision > managed_target_assignment_current.event_revision;
END;

CREATE INDEX managed_target_assignment_current_product_profile_idx
  ON managed_target_assignment_current(
    target_namespace, managed_instance_id, target_profile_identity_sha256,
    project_id, event_revision
  ) WHERE event_kind = 'ASSIGN'
    AND decision_version = 2
    AND selection_mode = 'STABLE_PHYSICAL_PROFILE_V2'
    AND product_alias = 'primary';
