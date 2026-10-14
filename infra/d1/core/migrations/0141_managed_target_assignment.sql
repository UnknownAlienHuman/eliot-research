PRAGMA foreign_keys = ON;

-- Core owns the explicit project-to-managed-target assignment.  These rows
-- record intent only; they do not declare a target indexed, ready, or active.
CREATE TABLE managed_target_assignment_event (
  project_id TEXT NOT NULL REFERENCES project_owner(project_id),
  event_revision INTEGER NOT NULL CHECK (event_revision > 0),
  expected_event_revision INTEGER NOT NULL CHECK (expected_event_revision >= 0),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('ASSIGN', 'RETIRE')),
  project_generation INTEGER NOT NULL CHECK (project_generation > 0),
  project_owner_principal_ref TEXT NOT NULL
    CHECK (length(project_owner_principal_ref) BETWEEN 1 AND 256),
  target_namespace TEXT,
  managed_instance_id TEXT,
  managed_generation TEXT,
  target_profile_identity_sha256 TEXT,
  previous_assignment_revision INTEGER,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('OWNER', 'OPERATOR')),
  actor_principal_ref TEXT NOT NULL CHECK (length(actor_principal_ref) BETWEEN 1 AND 256),
  authorization_receipt_ref TEXT NOT NULL
    CHECK (length(authorization_receipt_ref) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL CHECK (
    created_at GLOB '????-??-??T??:??:??.???Z'
    AND julianday(created_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at
  ),
  PRIMARY KEY (project_id, event_revision),
  FOREIGN KEY (project_id, previous_assignment_revision)
    REFERENCES managed_target_assignment_event(project_id, event_revision),
  CHECK (event_revision = expected_event_revision + 1),
  CHECK (
    (event_kind = 'ASSIGN'
      AND target_namespace IS NOT NULL
      AND managed_instance_id IS NOT NULL
      AND managed_generation IS NOT NULL
      AND target_profile_identity_sha256 IS NOT NULL
      AND previous_assignment_revision IS NULL)
    OR
    (event_kind = 'RETIRE'
      AND target_namespace IS NULL
      AND managed_instance_id IS NULL
      AND managed_generation IS NULL
      AND target_profile_identity_sha256 IS NULL
      AND previous_assignment_revision = expected_event_revision
      AND expected_event_revision > 0)
  ),
  CHECK (
    target_namespace IS NULL OR (
      length(target_namespace) BETWEEN 1 AND 256
      AND target_namespace GLOB '[A-Za-z0-9]*'
      AND target_namespace NOT GLOB '*[^A-Za-z0-9._:@/-]*'
    )
  ),
  CHECK (
    managed_instance_id IS NULL OR (
      length(managed_instance_id) BETWEEN 1 AND 256
      AND managed_instance_id GLOB '[A-Za-z0-9]*'
      AND managed_instance_id NOT GLOB '*[^A-Za-z0-9._:@/-]*'
    )
  ),
  CHECK (
    managed_generation IS NULL OR (
      length(managed_generation) BETWEEN 1 AND 256
      AND managed_generation GLOB '[A-Za-z0-9]*'
      AND managed_generation NOT GLOB '*[^A-Za-z0-9._:@/-]*'
    )
  ),
  CHECK (
    target_profile_identity_sha256 IS NULL OR (
      length(target_profile_identity_sha256) = 64
      AND target_profile_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (actor_kind <> 'OWNER' OR actor_principal_ref = project_owner_principal_ref)
) STRICT;

CREATE INDEX managed_target_assignment_target_idx
  ON managed_target_assignment_event(
    target_namespace, managed_instance_id, managed_generation,
    project_id, event_revision
  ) WHERE event_kind = 'ASSIGN';

-- Every append is a per-project compare-and-set.  A target change must first
-- append an explicit RETIRE event; assignment rows are never rewritten.
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

CREATE TRIGGER managed_target_assignment_event_immutable_update
BEFORE UPDATE ON managed_target_assignment_event
BEGIN
  SELECT RAISE(ABORT, 'MANAGED_TARGET_ASSIGNMENT_IMMUTABLE');
END;

CREATE TRIGGER managed_target_assignment_event_immutable_delete
BEFORE DELETE ON managed_target_assignment_event
BEGIN
  SELECT RAISE(ABORT, 'MANAGED_TARGET_ASSIGNMENT_IMMUTABLE');
END;

-- The established Core epoch already fences project, membership, source head,
-- admission, purge, and namespace-ownership mutations.  Assignment appends
-- join that same fence so paged enumerations can detect any interleaving.
CREATE TRIGGER managed_target_assignment_event_authority_epoch
AFTER INSERT ON managed_target_assignment_event
BEGIN
  UPDATE orientation_authority_epoch
  SET generation = generation + 1
  WHERE singleton = 1;
END;
