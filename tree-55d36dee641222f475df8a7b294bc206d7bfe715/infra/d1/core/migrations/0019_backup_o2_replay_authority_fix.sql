-- ER-34 O2 FIX6 self-atomic forward replay-authority upgrade (additive; ER-13 integration dependency).
-- One mutable owner per source namespace is unchanged; this only upgrades O2
-- idempotency, authority, checkpoint and coherent-cut receipts. Never edit earlier migrations.
--
-- Predecessor: the immutable parent 0018_backup_o2_replay_authority.sql (FIX3 shape:
-- per-key nonce PRIMARY KEY (key_generation, nonce_hex), expiry without
-- authority_authorized_at). 0018 was restored to those parent bytes after the
-- FIX4 in-place mutation; this file carries the FIX4 delta forward so BOTH a
-- fresh database (0001-0013 + parent 0018 + this 0019) and a database holding
-- the applied parent 0018 converge to the identical final shape. Re-applying
-- an edited 0018 could never upgrade (CREATE TABLE IF NOT EXISTS is a silent
-- no-op over applied tables); only this forward file upgrades.
--
-- Numbering: 0019 is the only O2 number after 0018 (0014-0017 are the W1 lane,
-- W1 FIX5 reserves 0017; no other number is used). No placeholder is created
-- and no W1 product code is copied.
--
-- Upgrade mechanics (D1/SQLite-valid, forward-only, no down migration):
-- 0. VALIDATE BEFORE MUTATE (FIX6 self-atomicity): both rebuilds are first
--    copied into staging tables (_validate_backup_offsite_expiry_0019 and
--    _validate_backup_offsite_nonce_authority_0019) and the tightened PRIMARY
--    KEY plus the UNIQUE owner tuple are enforced there. Any duplicate nonce
--    bytes inherited from the parent key abort on the staging copy --
--    cross-generation duplicates on the staging PRIMARY KEY (nonce_hex),
--    same-owner duplicates on the staging owner index -- BEFORE any canonical
--    table is renamed, created, copied or dropped. The staging tables are
--    dropped again before the swap, so a failed validation leaves every
--    canonical table and row exactly as parent 0018 left it: post-failure the
--    prior schema still answers reads and still holds every prior row, and a
--    retry fails closed the same way. No explicit BEGIN/COMMIT wraps this
--    file: D1 rejects transaction control inside migration SQL ("cannot start
--    a transaction within a transaction"; wrangler applies each migration as
--    its own batch and rolls a failed migration back to the last successful
--    state), and the same file must also run under raw SQLite
--    DatabaseSync.exec in local tests with no runner rollback. The supported
--    failure-safe ordering is therefore validation-before-mutation: under D1
--    the runner rolls back, under raw exec there is nothing to roll back
--    because no canonical mutation precedes validation.
-- 1. backup_offsite_expiry is rebuilt (rename, create, copy, drop) to add the
--    controller generation binding authority_authorized_at ahead of created_at
--    (ADD COLUMN would append it last and change column order, and would fail
--    on non-empty tables for a NOT NULL column without a default). Pre-existing
--    rows are preserved with authority_authorized_at backfilled from their own
--    created_at. That backfill is fail-closed by construction: terminal expiry
--    replay requires equality with the LIVE controller grant generation, so a
--    backfilled row can never authorize deletion under a rotated grant; it
--    refuses stale success instead.
-- 2. backup_offsite_nonce_authority is rebuilt (rename, create, copy, drop) to
--    tighten the PRIMARY KEY from (key_generation, nonce_hex) to globally
--    unique nonce_hex, plus the UNIQUE owner tuple
--    (key_generation, copy_id, part_ref). Rows copy verbatim. Any duplicate
--    nonce bytes across generations (legal under the parent key) abort the
--    copy with a uniqueness conflict: the batch fails closed, nothing is
--    silently deduplicated.
-- 3. Fresh databases observe the same final CREATE TABLE / CREATE INDEX text
--    as an in-place application would, so the canonical schema fingerprint is
--    identical for fresh and upgraded databases.
--
-- Rollback: D1 migrations are forward-only; there is no down migration. If
-- this file aborts (for example on duplicate nonce bytes inherited from the
-- parent shape), the batch fails and the operator restores the pre-migration
-- backup. O2 is pre-live (IMPLEMENTED_NOT_LIVE, no live receipts), so no
-- production data depends on either shape.
-- Applying this file to a database that never applied parent 0018 aborts on
-- the staging copy (no such table): the predecessor is mandatory, never
-- skipped or substituted.
PRAGMA foreign_keys = OFF;

-- 0. Staging validation: enforce the tightened constraints on copies BEFORE
--    any canonical mutation. Any abort below leaves canonical tables and rows
--    untouched (only _validate_ staging leftovers remain, which a retry drops
--    and rebuilds deterministically).
DROP TABLE IF EXISTS _validate_backup_offsite_expiry_0019;
CREATE TABLE _validate_backup_offsite_expiry_0019 (
  expiry_intent_key TEXT PRIMARY KEY,
  epoch_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  journal_refs_json TEXT NOT NULL CHECK (json_valid(journal_refs_json)),
  state TEXT NOT NULL CHECK (state IN ('DELETED','BLOCKED')),
  absent_parts INTEGER NOT NULL CHECK (absent_parts >= 0),
  failure_domain TEXT NOT NULL,
  descriptor_digest TEXT NOT NULL CHECK (length(descriptor_digest) = 64),
  policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
  authority_authorized_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
INSERT INTO _validate_backup_offsite_expiry_0019 (expiry_intent_key, epoch_id, destination_id, journal_refs_json, state, absent_parts, failure_domain, descriptor_digest, policy_digest, authority_authorized_at, created_at)
  SELECT expiry_intent_key, epoch_id, destination_id, journal_refs_json, state, absent_parts, failure_domain, descriptor_digest, policy_digest, created_at, created_at
  FROM backup_offsite_expiry;
DROP TABLE IF EXISTS _validate_backup_offsite_nonce_authority_0019;
CREATE TABLE _validate_backup_offsite_nonce_authority_0019 (
  key_generation TEXT NOT NULL,
  nonce_hex TEXT NOT NULL CHECK (length(nonce_hex) = 24),
  copy_id TEXT NOT NULL,
  part_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (nonce_hex)
) STRICT;
INSERT INTO _validate_backup_offsite_nonce_authority_0019 (key_generation, nonce_hex, copy_id, part_ref, created_at)
  SELECT key_generation, nonce_hex, copy_id, part_ref, created_at
  FROM backup_offsite_nonce_authority;
CREATE UNIQUE INDEX _validate_backup_offsite_nonce_owner_unique_0019
  ON _validate_backup_offsite_nonce_authority_0019(key_generation, copy_id, part_ref);
DROP TABLE _validate_backup_offsite_expiry_0019;
DROP TABLE _validate_backup_offsite_nonce_authority_0019;

-- 1. Terminal expiry replay authority: bind the controller generation.
ALTER TABLE backup_offsite_expiry RENAME TO _backup_offsite_expiry_0018;
CREATE TABLE IF NOT EXISTS backup_offsite_expiry (
  expiry_intent_key TEXT PRIMARY KEY,
  epoch_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  journal_refs_json TEXT NOT NULL CHECK (json_valid(journal_refs_json)),
  state TEXT NOT NULL CHECK (state IN ('DELETED','BLOCKED')),
  absent_parts INTEGER NOT NULL CHECK (absent_parts >= 0),
  failure_domain TEXT NOT NULL,
  descriptor_digest TEXT NOT NULL CHECK (length(descriptor_digest) = 64),
  policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
  authority_authorized_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
INSERT INTO backup_offsite_expiry (expiry_intent_key, epoch_id, destination_id, journal_refs_json, state, absent_parts, failure_domain, descriptor_digest, policy_digest, authority_authorized_at, created_at)
  SELECT expiry_intent_key, epoch_id, destination_id, journal_refs_json, state, absent_parts, failure_domain, descriptor_digest, policy_digest, created_at, created_at
  FROM _backup_offsite_expiry_0018;
DROP TABLE _backup_offsite_expiry_0018;

-- 2. Durable globally-unique nonce allocation authority (tightening of the
-- parent per-key table). One row claims a 96-bit nonce for (key generation,
-- copy, part) and the PRIMARY KEY on nonce_hex alone makes ANY reuse of
-- identical nonce bytes an atomic insert conflict BEFORE encryption or remote
-- put, across copies, parts, restarts, concurrent allocators and key
-- generations: rotation never reuses retired material. The UNIQUE owner tuple
-- (key_generation, copy_id, part_ref) separately guarantees one durable owner
-- mapping per allocation scope, so restart/replay cannot silently allocate a
-- different nonce to the same owner tuple. Controller-allocated and derived
-- nonces share this authority; the copy-part checkpoint UNIQUE on
-- (copy_id, nonce_hex) remains as post-verify defense in depth only.
ALTER TABLE backup_offsite_nonce_authority RENAME TO _backup_offsite_nonce_authority_0018;
CREATE TABLE IF NOT EXISTS backup_offsite_nonce_authority (
  key_generation TEXT NOT NULL,
  nonce_hex TEXT NOT NULL CHECK (length(nonce_hex) = 24),
  copy_id TEXT NOT NULL,
  part_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (nonce_hex)
) STRICT;
INSERT INTO backup_offsite_nonce_authority (key_generation, nonce_hex, copy_id, part_ref, created_at)
  SELECT key_generation, nonce_hex, copy_id, part_ref, created_at
  FROM _backup_offsite_nonce_authority_0018;
DROP TABLE _backup_offsite_nonce_authority_0018;
CREATE UNIQUE INDEX IF NOT EXISTS backup_offsite_nonce_owner_unique
  ON backup_offsite_nonce_authority(key_generation, copy_id, part_ref);

PRAGMA foreign_keys = ON;
