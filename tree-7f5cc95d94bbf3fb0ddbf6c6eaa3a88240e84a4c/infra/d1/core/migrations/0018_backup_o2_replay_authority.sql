-- ER-34 O2 replay/expiry/destination/copy/cut authority (additive; ER-13 integration dependency).
-- One mutable owner per source namespace is unchanged; this only adds O2
-- idempotency, authority, checkpoint and coherent-cut receipts. Never edit earlier migrations.
--
-- Numbering: this file was renamed from 0017_backup_o2_replay_authority.sql to
-- 0018_backup_o2_replay_authority.sql (FIX2) because W1 FIX5 reserves the 0017 slot
-- with 0017_investigation_ledger_fix5.sql (commit a0b78ff9fc9279ef22bd257dcd4c375b6849c52f,
-- agent/launch-04-research-20260905). Numeric predecessors 0014-0016 never landed on
-- this lane, so the gap is intentional and documented here. No placeholder 0017 is
-- created by ER-34, and no W1 product code is copied: each lane keeps its own file.
-- FIX3 (ER-34, same 0018 number, strictly additive): persists the copy-time
-- offsite descriptor identity (failure_domain, descriptor_digest) and the
-- controller authority generation (authority_authorized_at) on the copy receipt,
-- mirrors descriptor/failure-domain/policy digests on the expiry receipt, and adds
-- the per-key durable nonce authority table. Only new columns/tables/indexes are
-- added below; no column is renamed, dropped, reordered or retightened, earlier
-- migrations are untouched, and 0018 remains the only O2 migration number (W1 0017
-- reservation unchanged). O2 is pre-live (IMPLEMENTED_NOT_LIVE, no live receipts),
-- so fresh application of this file is authoritative; environments holding the
-- pre-FIX3 0018 shape fail the migration gate until re-applied.
PRAGMA foreign_keys = ON;

-- Local migration ledger mirror (wrangler D1 convention: name + applied_at).
-- The O2 startup gate requires a row for this file; runtime CREATE TABLE is not
-- a substitute and tests must apply this migration, never swallow its errors.
CREATE TABLE IF NOT EXISTS d1_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;

-- Epoch replay authority: full intent digest + immutable persisted bytes.
-- Exact replay returns receipt_json/draft_json/attempt_json verbatim; any
-- same-key divergence in any bound field conflicts with zero new side effects.
CREATE TABLE IF NOT EXISTS backup_epoch_receipt (
  idempotency_key TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64),
  vector_digest TEXT NOT NULL CHECK (length(vector_digest) = 64),
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
  epoch_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  draft_json TEXT NOT NULL CHECK (json_valid(draft_json)),
  attempt_json TEXT NOT NULL CHECK (json_valid(attempt_json)),
  created_at TEXT NOT NULL
) STRICT;

-- Offsite-copy expiry lifecycle authority (O2 only, not O4 purge replay).
-- Terminal replay must re-prove remote absence part by part; a reappeared part
-- is a resurrection refusal, never DELETED while present.
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
  created_at TEXT NOT NULL
) STRICT;

-- Controller-owned destination authority. Caller owner/auth refs never
-- self-authorize: copy and expiry resolve the persisted AUTHORIZED row keyed by
-- (destination_id, initiating principal_ref, approved policy_decision_ref) and
-- require the caller policy to equal the persisted policy exactly.
CREATE TABLE IF NOT EXISTS backup_destination_authority (
  destination_id TEXT NOT NULL,
  principal_ref TEXT NOT NULL,
  policy_decision_ref TEXT NOT NULL,
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
  authorization_receipt_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('AUTHORIZED','REVOKED')),
  authorized_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (destination_id, principal_ref, policy_decision_ref)
) STRICT;

-- Durable offsite-copy part checkpoints. Restart/cancellation resumes from
-- controller-owned state; nonces are deterministic per
-- (key generation, copy, part ref, content digest) or controller-allocated and
-- recorded here, never an in-memory Set.
CREATE TABLE IF NOT EXISTS backup_offsite_copy_part (
  copy_id TEXT NOT NULL,
  part_ref TEXT NOT NULL,
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  nonce_hex TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('STORED','VERIFIED')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (copy_id, part_ref)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS backup_offsite_copy_part_nonce_unique
  ON backup_offsite_copy_part(copy_id, nonce_hex);

-- Durable offsite-copy success authority. Exact replay returns receipt_json and
-- epoch_json verbatim. expires_at here is the D1-authoritative expiry used by
-- the expiry lifecycle, never caller draft bytes or caller timestamps.
CREATE TABLE IF NOT EXISTS backup_offsite_copy_receipt (
  copy_id TEXT PRIMARY KEY,
  epoch_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  key_generation TEXT NOT NULL,
  policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  epoch_json TEXT NOT NULL CHECK (json_valid(epoch_json)),
  attempt_json TEXT NOT NULL CHECK (json_valid(attempt_json)),
  readback_digest TEXT NOT NULL CHECK (length(readback_digest) = 64),
  expires_at TEXT NOT NULL,
  failure_domain TEXT NOT NULL,
  descriptor_digest TEXT NOT NULL CHECK (length(descriptor_digest) = 64),
  authority_authorized_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

-- Durable coherent-cut record. The phase-1 freeze opens a cut bound to the D1
-- table/schema/migration/purge state plus the R2 inventory generation; phase-2
-- re-verification seals it. Any observable inter-phase divergence rejects.
CREATE TABLE IF NOT EXISTS backup_export_cut (
  cut_id TEXT PRIMARY KEY,
  cut_digest TEXT NOT NULL CHECK (length(cut_digest) = 64),
  state TEXT NOT NULL CHECK (state IN ('OPEN','ACCEPTED','REJECTED')),
  created_at TEXT NOT NULL
) STRICT;

-- Durable per-key nonce allocation authority (FIX3, additive). One row claims a
-- 96-bit nonce for (key generation, copy, part) and the PRIMARY KEY on
-- (key_generation, nonce_hex) makes cross-copy / cross-part reuse under one key
-- an atomic insert conflict BEFORE encryption or remote put, across restarts and
-- concurrent allocators. Key-generation change is a disjoint scope, so rotation
-- never collides with retired material. Controller-allocated and derived nonces
-- share this authority; the copy-part checkpoint UNIQUE on (copy_id, nonce_hex)
-- remains as post-verify defense in depth only.
CREATE TABLE IF NOT EXISTS backup_offsite_nonce_authority (
  key_generation TEXT NOT NULL,
  nonce_hex TEXT NOT NULL CHECK (length(nonce_hex) = 24),
  copy_id TEXT NOT NULL,
  part_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (key_generation, nonce_hex)
) STRICT;
