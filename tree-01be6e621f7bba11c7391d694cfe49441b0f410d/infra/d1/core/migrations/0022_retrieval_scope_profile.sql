-- ER-24 Q3 item 2: scope-profile versioning for the 64-source metadata-Lens bound.
-- Additive only: one table plus immutability guards, changes no existing table,
-- backfills nothing and rewrites no applied migration. Consumes the next free
-- number 0022, verified against main before writing (0021 is taken by the Q3
-- retrieval query persistence).
--
-- A frozen scope records which profile version bounded it (profile_version with
-- the max_sources/max_results it enforces). Writers use INSERT ...
-- ON CONFLICT DO NOTHING followed by an exact readback: a replay under the
-- same profile is byte-identical, while a later replay under a different
-- profile version observes the recorded mismatch at the app layer and fails
-- closed instead of silently replaying a frozen scope under a changed bound.
-- A changed bound (profile mismatch on the same snapshot identity) is therefore
-- distinguishable from a changed corpus (different snapshot identity).
--
-- Profile rows are immutable audit history: no UPDATE or DELETE path exists.
-- Scope/grant/purge invalidation never deletes profile rows; the recorded
-- bound stays inspectable after the scope dies. A query never mints source
-- grants through this table: it carries no authorization of its own.
--
-- Intent -> Attempt -> Receipt -> Readback -> Reconciliation: the app layer
-- inserts the profile row after freezing the scope and before granting it,
-- then reconciles the readback byte-for-byte. No HTTP, model or R2 effect
-- occurs inside these statements.
--
-- This additive, uncomposed capability does not promote the public Worker
-- readiness generation. Runtime generation changes belong to the later
-- composition/release gate.
PRAGMA foreign_keys = ON;

CREATE TABLE retrieval_scope_profile (
  snapshot_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  profile_version TEXT NOT NULL CHECK (
    length(profile_version) BETWEEN 1 AND 128
  ),
  max_sources INTEGER NOT NULL CHECK (
    max_sources > 0 AND max_sources <= 64
  ),
  max_results INTEGER NOT NULL CHECK (
    max_results > 0 AND max_results <= 16
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, revision),
  FOREIGN KEY(snapshot_id, revision)
    REFERENCES scope_snapshot(snapshot_id, revision)
) STRICT;

CREATE TRIGGER retrieval_scope_profile_immutable BEFORE UPDATE ON retrieval_scope_profile
BEGIN SELECT RAISE(ABORT, 'RETRIEVAL_PROFILE_CONFLICT'); END;

CREATE TRIGGER retrieval_scope_profile_no_delete BEFORE DELETE ON retrieval_scope_profile
BEGIN SELECT RAISE(ABORT, 'RETRIEVAL_PROFILE_CONFLICT'); END;
