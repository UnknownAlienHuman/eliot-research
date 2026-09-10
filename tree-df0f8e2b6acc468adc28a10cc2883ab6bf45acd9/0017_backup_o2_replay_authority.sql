-- ER-34 O2 replay/expiry authority (additive; integration dependency with ER-13).
-- One mutable owner per source namespace is unchanged; this only adds O2
-- idempotency receipts. Never edit earlier migrations.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS backup_epoch_receipt (
  idempotency_key TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  vector_digest TEXT NOT NULL CHECK (length(vector_digest) = 64),
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
  epoch_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS backup_offsite_expiry (
  expiry_intent_key TEXT PRIMARY KEY,
  epoch_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  journal_refs_json TEXT NOT NULL CHECK (json_valid(journal_refs_json)),
  state TEXT NOT NULL CHECK (state IN ('DELETED','BLOCKED')),
  created_at TEXT NOT NULL
) STRICT;
