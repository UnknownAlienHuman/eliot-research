PRAGMA foreign_keys = ON;

-- Core's current assignment read model is a compact pointer to the latest
-- immutable audit event for each project. It does not own ACTIVE generation
-- readiness or replace the Search D1 generation registry.
CREATE TABLE managed_target_assignment_current (
  project_id TEXT PRIMARY KEY NOT NULL,
  event_revision INTEGER NOT NULL CHECK (event_revision > 0),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('ASSIGN', 'RETIRE')),
  target_namespace TEXT,
  managed_instance_id TEXT,
  managed_generation TEXT,
  target_profile_identity_sha256 TEXT,
  FOREIGN KEY (project_id, event_revision)
    REFERENCES managed_target_assignment_event(project_id, event_revision),
  CHECK (
    (event_kind = 'ASSIGN'
      AND target_namespace IS NOT NULL
      AND managed_instance_id IS NOT NULL
      AND managed_generation IS NOT NULL
      AND target_profile_identity_sha256 IS NOT NULL)
    OR
    (event_kind = 'RETIRE'
      AND target_namespace IS NULL
      AND managed_instance_id IS NULL
      AND managed_generation IS NULL
      AND target_profile_identity_sha256 IS NULL)
  ),
  CHECK (
    target_profile_identity_sha256 IS NULL OR (
      length(target_profile_identity_sha256) = 64
      AND target_profile_identity_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  )
) STRICT;

CREATE INDEX managed_target_assignment_current_target_idx
  ON managed_target_assignment_current(
    target_namespace, managed_instance_id, managed_generation,
    target_profile_identity_sha256, project_id, event_revision
  ) WHERE event_kind = 'ASSIGN';

-- Install the append projection before backfill. The conditional upsert below
-- makes a concurrent newer append win if it races the one-time history scan.
CREATE TRIGGER managed_target_assignment_current_after_event_insert
AFTER INSERT ON managed_target_assignment_event
BEGIN
  INSERT INTO managed_target_assignment_current(
    project_id, event_revision, event_kind, target_namespace,
    managed_instance_id, managed_generation, target_profile_identity_sha256
  ) VALUES (
    NEW.project_id, NEW.event_revision, NEW.event_kind, NEW.target_namespace,
    NEW.managed_instance_id, NEW.managed_generation, NEW.target_profile_identity_sha256
  )
  ON CONFLICT(project_id) DO UPDATE SET
    event_revision = excluded.event_revision,
    event_kind = excluded.event_kind,
    target_namespace = excluded.target_namespace,
    managed_instance_id = excluded.managed_instance_id,
    managed_generation = excluded.managed_generation,
    target_profile_identity_sha256 = excluded.target_profile_identity_sha256
  WHERE excluded.event_revision > managed_target_assignment_current.event_revision;
END;

-- One bounded historical backfill: one grouped pass over E audit events, then
-- one current row written per project head. Review the deployed event count
-- and this O(E) one-time cost before applying the migration. Runtime reads do
-- not repeat this history scan.
WITH latest AS (
  SELECT project_id, MAX(event_revision) AS event_revision
  FROM managed_target_assignment_event
  GROUP BY project_id
)
INSERT INTO managed_target_assignment_current(
  project_id, event_revision, event_kind, target_namespace,
  managed_instance_id, managed_generation, target_profile_identity_sha256
)
SELECT e.project_id, e.event_revision, e.event_kind, e.target_namespace,
  e.managed_instance_id, e.managed_generation, e.target_profile_identity_sha256
FROM latest l
JOIN managed_target_assignment_event e
  ON e.project_id = l.project_id
  AND e.event_revision = l.event_revision
WHERE 1
ON CONFLICT(project_id) DO UPDATE SET
  event_revision = excluded.event_revision,
  event_kind = excluded.event_kind,
  target_namespace = excluded.target_namespace,
  managed_instance_id = excluded.managed_instance_id,
  managed_generation = excluded.managed_generation,
  target_profile_identity_sha256 = excluded.target_profile_identity_sha256
WHERE excluded.event_revision > managed_target_assignment_current.event_revision;
