-- ER-08/ER-13 FIX3: transaction-time ledger authority with per-operation guards and ledger epoch.
-- Additive only: 0014 tables and triggers are untouched. All RAISE() calls live inside triggers.
-- Authority model: D1 Core is canonical. The provider fence is a preflight hint only.
-- Transaction-time authority is enforced by BEFORE INSERT guard triggers reading live D1 rows
-- (scope_snapshot, scope_access_grant, investigation_current_policy/deployment, purge_ledger,
-- investigation_ledger_epoch) inside the same batch() transaction as the ledger mutations.
-- Any concurrent committed authority change before batch BEGIN is visible to triggers and aborts
-- the whole batch (guard + heads + events roll back). No direct head/event write without a guard.

PRAGMA foreign_keys = ON;

-- Canonical current policy generation materialized in D1 (external rotations must write here).
CREATE TABLE IF NOT EXISTS investigation_current_policy (
  policy_generation TEXT PRIMARY KEY CHECK(length(policy_generation) BETWEEN 1 AND 256),
  policy_authority_ref TEXT NOT NULL CHECK(length(policy_authority_ref) BETWEEN 1 AND 256),
  state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','RETIRED')),
  created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS investigation_current_policy_single_active
  ON investigation_current_policy(state) WHERE state = 'ACTIVE';

-- Canonical current deployment generation materialized in D1 (rotations must write here).
CREATE TABLE IF NOT EXISTS investigation_current_deployment (
  deployment_generation TEXT PRIMARY KEY CHECK(length(deployment_generation) BETWEEN 1 AND 256),
  state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','RETIRED')),
  created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS investigation_current_deployment_single_active
  ON investigation_current_deployment(state) WHERE state = 'ACTIVE';

-- Ledger-specific monotone authority epoch. orientation_authority_epoch stays a cache discriminator.
CREATE TABLE IF NOT EXISTS investigation_ledger_epoch (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  generation INTEGER NOT NULL CHECK(generation > 0)
) STRICT;
INSERT INTO investigation_ledger_epoch(singleton, generation) SELECT 1, 1
  WHERE NOT EXISTS (SELECT 1 FROM investigation_ledger_epoch WHERE singleton = 1);

-- Canonical materialized ledger authority, one row per principal/scope identity for mutations.
CREATE TABLE IF NOT EXISTS investigation_ledger_authority (
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  scope_snapshot_id TEXT NOT NULL CHECK(length(scope_snapshot_id) BETWEEN 1 AND 256),
  scope_snapshot_revision INTEGER NOT NULL CHECK(scope_snapshot_revision BETWEEN 1 AND 1000000),
  policy_generation TEXT NOT NULL CHECK(length(policy_generation) BETWEEN 1 AND 256),
  policy_authority_ref TEXT NOT NULL CHECK(length(policy_authority_ref) BETWEEN 1 AND 256),
  deployment_generation TEXT NOT NULL CHECK(length(deployment_generation) BETWEEN 1 AND 256),
  global_purge_revision INTEGER NOT NULL CHECK(global_purge_revision >= 0),
  scope_purge_revision INTEGER NOT NULL CHECK(scope_purge_revision >= 0),
  observed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(principal_ref, scope_snapshot_id, scope_snapshot_revision),
  FOREIGN KEY(scope_snapshot_id, scope_snapshot_revision) REFERENCES scope_snapshot(snapshot_id, revision),
  CHECK(julianday(expires_at) > julianday(observed_at)),
  CHECK(julianday(expires_at) <= julianday(observed_at, '+10 minutes'))
) STRICT;

-- Bounded per-operation guard identity. Guard insert + ledger effects + consume share one batch().
CREATE TABLE IF NOT EXISTS investigation_ledger_guard (
  guard_id TEXT PRIMARY KEY CHECK(length(guard_id) BETWEEN 1 AND 256),
  op_kind TEXT NOT NULL CHECK(op_kind IN ('CREATE','APPEND','SUPERSEDE')),
  investigation_id TEXT NOT NULL CHECK(length(investigation_id) BETWEEN 1 AND 128),
  new_investigation_id TEXT CHECK(new_investigation_id IS NULL OR length(new_investigation_id) BETWEEN 1 AND 128),
  expected_old_revision INTEGER NOT NULL CHECK(expected_old_revision >= 0),
  expected_new_revision INTEGER NOT NULL CHECK(expected_new_revision BETWEEN 1 AND 1000000),
  expected_old_event_head INTEGER NOT NULL CHECK(expected_old_event_head >= 0),
  expected_new_event_head INTEGER NOT NULL CHECK(expected_new_event_head BETWEEN 1 AND 1000000),
  expected_event_id TEXT NOT NULL CHECK(length(expected_event_id) BETWEEN 1 AND 128),
  expected_new_event_id TEXT CHECK(expected_new_event_id IS NULL OR length(expected_new_event_id) BETWEEN 1 AND 128),
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  scope_snapshot_id TEXT NOT NULL CHECK(length(scope_snapshot_id) BETWEEN 1 AND 256),
  scope_snapshot_revision INTEGER NOT NULL CHECK(scope_snapshot_revision BETWEEN 1 AND 1000000),
  policy_generation TEXT NOT NULL CHECK(length(policy_generation) BETWEEN 1 AND 256),
  policy_authority_ref TEXT NOT NULL CHECK(length(policy_authority_ref) BETWEEN 1 AND 256),
  deployment_generation TEXT NOT NULL CHECK(length(deployment_generation) BETWEEN 1 AND 256),
  global_purge_revision INTEGER NOT NULL CHECK(global_purge_revision >= 0),
  scope_purge_revision INTEGER NOT NULL CHECK(scope_purge_revision >= 0),
  expected_epoch INTEGER NOT NULL CHECK(expected_epoch > 0),
  observed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','CONSUMED')),
  CHECK(julianday(expires_at) > julianday(observed_at)),
  CHECK(julianday(expires_at) <= julianday(observed_at, '+10 minutes')),
  CHECK(expected_new_revision = expected_old_revision + 1 OR (op_kind = 'CREATE' AND expected_old_revision = 0 AND expected_new_revision = 1)),
  CHECK(expected_new_event_head = expected_old_event_head + 1 OR (op_kind = 'CREATE' AND expected_old_event_head = 0 AND expected_new_event_head = 1))
) STRICT;
CREATE INDEX IF NOT EXISTS investigation_ledger_guard_pending_idx
  ON investigation_ledger_guard(investigation_id, state);

-- Ledger epoch advancement: every relevant D1 authority materialization/change bumps the epoch.
-- Scope snapshot (covers indirect invalidation via orientation triggers on project/source/tag/etc).
CREATE TRIGGER IF NOT EXISTS ledger_epoch_scope_snapshot_insert AFTER INSERT ON scope_snapshot BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS ledger_epoch_scope_snapshot_update AFTER UPDATE ON scope_snapshot BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS ledger_epoch_scope_snapshot_delete AFTER DELETE ON scope_snapshot BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
-- Scope grants (principal authorization, revocation, expiry, policy ref).
CREATE TRIGGER IF NOT EXISTS ledger_epoch_grant_insert AFTER INSERT ON scope_access_grant BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS ledger_epoch_grant_update AFTER UPDATE ON scope_access_grant BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS ledger_epoch_grant_delete AFTER DELETE ON scope_access_grant BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
-- Read policy (affects grant currentness).
CREATE TRIGGER IF NOT EXISTS ledger_epoch_read_policy_insert AFTER INSERT ON scope_read_policy BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS ledger_epoch_read_policy_update AFTER UPDATE ON scope_read_policy BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS ledger_epoch_read_policy_delete AFTER DELETE ON scope_read_policy BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
-- Purge ledger (global purge frontier).
CREATE TRIGGER IF NOT EXISTS ledger_epoch_purge_insert AFTER INSERT ON purge_ledger BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS ledger_epoch_purge_update AFTER UPDATE ON purge_ledger BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS ledger_epoch_purge_delete AFTER DELETE ON purge_ledger BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
-- Source revision purge transitions (feeds scope invalidation).
CREATE TRIGGER IF NOT EXISTS ledger_epoch_source_rev_insert AFTER INSERT ON source_revision BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS ledger_epoch_source_rev_update AFTER UPDATE ON source_revision BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS ledger_epoch_source_rev_delete AFTER DELETE ON source_revision BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
-- Admission policy (policy authority).
CREATE TRIGGER IF NOT EXISTS ledger_epoch_admission_policy_insert AFTER INSERT ON source_admission_policy BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS ledger_epoch_admission_policy_update AFTER UPDATE ON source_admission_policy BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS ledger_epoch_admission_policy_delete AFTER DELETE ON source_admission_policy BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
-- Materialized current policy/deployment.
CREATE TRIGGER IF NOT EXISTS ledger_epoch_cur_policy_insert AFTER INSERT ON investigation_current_policy BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS ledger_epoch_cur_policy_update AFTER UPDATE ON investigation_current_policy BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS ledger_epoch_cur_policy_delete AFTER DELETE ON investigation_current_policy BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS ledger_epoch_cur_deploy_insert AFTER INSERT ON investigation_current_deployment BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS ledger_epoch_cur_deploy_update AFTER UPDATE ON investigation_current_deployment BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS ledger_epoch_cur_deploy_delete AFTER DELETE ON investigation_current_deployment BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
-- Ledger authority materialization itself.
CREATE TRIGGER IF NOT EXISTS ledger_epoch_authority_insert AFTER INSERT ON investigation_ledger_authority BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS ledger_epoch_authority_update AFTER UPDATE ON investigation_ledger_authority BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;
CREATE TRIGGER IF NOT EXISTS ledger_epoch_authority_delete AFTER DELETE ON investigation_ledger_authority BEGIN UPDATE investigation_ledger_epoch SET generation = generation + 1 WHERE singleton = 1; END;

-- Guard validation at transaction time. Each dim fails with its typed code; any failure rolls back all.
CREATE TRIGGER IF NOT EXISTS ledger_guard_epoch_current BEFORE INSERT ON investigation_ledger_guard
WHEN NEW.expected_epoch IS NOT (SELECT generation FROM investigation_ledger_epoch WHERE singleton = 1)
BEGIN SELECT RAISE(ABORT, 'LEDGER_STALE_HEAD: ledger authority epoch changed'); END;
CREATE TRIGGER IF NOT EXISTS ledger_guard_scope_current BEFORE INSERT ON investigation_ledger_guard
WHEN NOT EXISTS (SELECT 1 FROM scope_snapshot s WHERE s.snapshot_id = NEW.scope_snapshot_id AND s.revision = NEW.scope_snapshot_revision AND s.invalidated_at IS NULL AND julianday(s.expires_at) > julianday('now'))
BEGIN SELECT RAISE(ABORT, 'LEDGER_SCOPE_FOREIGN: scope snapshot missing invalidated expired or foreign'); END;
CREATE TRIGGER IF NOT EXISTS ledger_guard_grant_active BEFORE INSERT ON investigation_ledger_guard
WHEN NOT EXISTS (SELECT 1 FROM scope_access_grant g WHERE g.snapshot_id = NEW.scope_snapshot_id AND g.snapshot_revision = NEW.scope_snapshot_revision AND g.principal_ref = NEW.principal_ref AND g.state = 'ACTIVE' AND julianday(g.expires_at) > julianday('now') AND g.policy_authority_ref = NEW.policy_authority_ref)
BEGIN SELECT RAISE(ABORT, 'LEDGER_PRINCIPAL_DENIED: grant missing revoked expired or policy ref mismatch'); END;
CREATE TRIGGER IF NOT EXISTS ledger_guard_policy_current BEFORE INSERT ON investigation_ledger_guard
WHEN NOT EXISTS (SELECT 1 FROM investigation_current_policy p WHERE p.policy_generation = NEW.policy_generation AND p.policy_authority_ref = NEW.policy_authority_ref AND p.state = 'ACTIVE')
OR (SELECT s.policy_authority_ref FROM scope_snapshot s WHERE s.snapshot_id = NEW.scope_snapshot_id AND s.revision = NEW.scope_snapshot_revision) IS NOT NEW.policy_authority_ref
BEGIN SELECT RAISE(ABORT, 'LEDGER_POLICY_STALE: policy generation or authority ref mismatch'); END;
CREATE TRIGGER IF NOT EXISTS ledger_guard_deployment_current BEFORE INSERT ON investigation_ledger_guard
WHEN NOT EXISTS (SELECT 1 FROM investigation_current_deployment d WHERE d.deployment_generation = NEW.deployment_generation AND d.state = 'ACTIVE')
BEGIN SELECT RAISE(ABORT, 'LEDGER_DEPLOYMENT_STALE: deployment generation mismatch'); END;
CREATE TRIGGER IF NOT EXISTS ledger_guard_purge_current BEFORE INSERT ON investigation_ledger_guard
WHEN NEW.global_purge_revision IS NOT COALESCE((SELECT MAX(ledger_revision) FROM purge_ledger), 0)
OR NEW.scope_purge_revision IS NOT (SELECT s.purge_ledger_revision FROM scope_snapshot s WHERE s.snapshot_id = NEW.scope_snapshot_id AND s.revision = NEW.scope_snapshot_revision)
OR (SELECT s.purge_ledger_revision FROM scope_snapshot s WHERE s.snapshot_id = NEW.scope_snapshot_id AND s.revision = NEW.scope_snapshot_revision) < COALESCE((SELECT MAX(ledger_revision) FROM purge_ledger), 0)
BEGIN SELECT RAISE(ABORT, 'LEDGER_PURGE_STALE: global or scope purge revision mismatch'); END;
CREATE TRIGGER IF NOT EXISTS ledger_guard_authority_materialized BEFORE INSERT ON investigation_ledger_guard
WHEN NOT EXISTS (SELECT 1 FROM investigation_ledger_authority a WHERE a.principal_ref = NEW.principal_ref AND a.scope_snapshot_id = NEW.scope_snapshot_id AND a.scope_snapshot_revision = NEW.scope_snapshot_revision AND a.policy_generation = NEW.policy_generation AND a.policy_authority_ref = NEW.policy_authority_ref AND a.deployment_generation = NEW.deployment_generation AND a.global_purge_revision = NEW.global_purge_revision AND a.scope_purge_revision = NEW.scope_purge_revision)
BEGIN SELECT RAISE(ABORT, 'LEDGER_SCOPE_FOREIGN: ledger authority not materialized for principal scope'); END;

-- Head/event sequencing and guard binding. Direct unguarded writes fail here.
CREATE TRIGGER IF NOT EXISTS ledger_head_insert_guard BEFORE INSERT ON investigation_ledger_head
WHEN NOT EXISTS (SELECT 1 FROM investigation_ledger_guard g WHERE g.state = 'PENDING'
AND g.principal_ref = NEW.principal_ref AND g.scope_snapshot_id = NEW.scope_snapshot_id
AND g.scope_snapshot_revision = NEW.scope_snapshot_revision AND g.policy_generation = NEW.policy_generation
AND g.policy_authority_ref = NEW.policy_authority_ref AND g.deployment_generation = NEW.deployment_generation
AND ((g.op_kind = 'CREATE' AND g.investigation_id = NEW.investigation_id AND g.expected_new_revision = NEW.revision AND g.expected_new_event_head = NEW.event_head AND NEW.revision = 1 AND NEW.event_head = 1 AND NEW.supersedes_id IS NULL)
OR (g.op_kind = 'SUPERSEDE' AND g.new_investigation_id = NEW.investigation_id AND NEW.revision = 1 AND NEW.event_head = 1 AND NEW.supersedes_id = g.investigation_id)))
BEGIN SELECT RAISE(ABORT, 'LEDGER_CONFLICT: head insert without matching pending guard'); END;
CREATE TRIGGER IF NOT EXISTS ledger_head_update_guard BEFORE UPDATE ON investigation_ledger_head
WHEN NOT EXISTS (SELECT 1 FROM investigation_ledger_guard g WHERE g.state = 'PENDING'
AND g.investigation_id = OLD.investigation_id AND g.investigation_id = NEW.investigation_id
AND g.expected_old_revision = OLD.revision AND g.expected_new_revision = NEW.revision
AND g.expected_old_event_head = OLD.event_head AND g.expected_new_event_head = NEW.event_head
AND NEW.revision = OLD.revision + 1 AND NEW.event_head = OLD.event_head + 1
AND NEW.principal_ref = OLD.principal_ref AND NEW.scope_snapshot_id = OLD.scope_snapshot_id
AND NEW.scope_snapshot_revision = OLD.scope_snapshot_revision AND NEW.policy_generation = OLD.policy_generation
AND NEW.policy_authority_ref = OLD.policy_authority_ref AND NEW.deployment_generation = OLD.deployment_generation
AND NEW.input_digest = OLD.input_digest AND NEW.idempotency_key = OLD.idempotency_key
AND NEW.investigation_id = OLD.investigation_id AND NEW.protocol_version = OLD.protocol_version
AND g.principal_ref = OLD.principal_ref AND g.scope_snapshot_id = OLD.scope_snapshot_id
AND g.scope_snapshot_revision = OLD.scope_snapshot_revision AND g.policy_generation = OLD.policy_generation
AND g.policy_authority_ref = OLD.policy_authority_ref AND g.deployment_generation = OLD.deployment_generation
AND ((g.op_kind = 'APPEND') OR (g.op_kind = 'SUPERSEDE' AND OLD.status = 'OPEN' AND NEW.status = 'SUPERSEDED')))
BEGIN SELECT RAISE(ABORT, 'LEDGER_STALE_HEAD: head update without matching pending guard CAS or authority'); END;
CREATE TRIGGER IF NOT EXISTS ledger_event_insert_guard BEFORE INSERT ON investigation_ledger_event
WHEN NOT EXISTS (SELECT 1 FROM investigation_ledger_guard g WHERE g.state = 'PENDING'
AND (g.investigation_id = NEW.investigation_id OR g.new_investigation_id = NEW.investigation_id)
AND (NEW.event_id = g.expected_event_id OR NEW.event_id = g.expected_new_event_id)
AND ((g.op_kind = 'CREATE' AND NEW.investigation_id = g.investigation_id AND NEW.sequence = 1 AND NEW.kind = 'CREATED')
OR (g.op_kind = 'APPEND' AND NEW.investigation_id = g.investigation_id AND NEW.sequence = g.expected_new_event_head)
OR (g.op_kind = 'SUPERSEDE' AND ((NEW.investigation_id = g.investigation_id AND NEW.event_id = g.expected_event_id AND NEW.sequence = g.expected_new_event_head AND NEW.kind = 'SUPERSEDED')
OR (NEW.investigation_id = g.new_investigation_id AND NEW.event_id = g.expected_new_event_id AND NEW.sequence = 1 AND NEW.kind = 'CREATED')))))
BEGIN SELECT RAISE(ABORT, 'LEDGER_CONFLICT: event insert without matching pending guard'); END;

-- Guard lifecycle: no delete, only PENDING to CONSUMED.
CREATE TRIGGER IF NOT EXISTS ledger_guard_no_delete BEFORE DELETE ON investigation_ledger_guard
BEGIN SELECT RAISE(ABORT, 'ledger guards are append-only'); END;
CREATE TRIGGER IF NOT EXISTS ledger_guard_state_frozen BEFORE UPDATE ON investigation_ledger_guard
WHEN OLD.state IS NOT 'PENDING' OR NEW.state IS NOT 'CONSUMED'
BEGIN SELECT RAISE(ABORT, 'ledger guard must move PENDING to CONSUMED'); END;

UPDATE schema_state SET value = 'core-v11-owner-orientation', updated_at = '2026-09-06T00:00:00Z'
WHERE key = 'schema_generation';
INSERT INTO schema_state(key, value, updated_at) VALUES('investigation_ledger_authority_generation', 'investigation-ledger-authority-v1', '2026-09-06T00:00:00Z');
