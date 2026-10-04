-- ER-34 O3 restore intent, one-shot attempt, and unqualified readback receipt.
-- A started or unknown restore is never silently replayed into a partially
-- written target. Traffic qualification remains a separate acceptance step.

CREATE TABLE IF NOT EXISTS backup_restore_intent (
  restore_id TEXT PRIMARY KEY,
  principal_ref TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  intent_revision INTEGER NOT NULL CHECK (intent_revision >= 1),
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64),
  epoch_id TEXT NOT NULL,
  offsite_copy_ref TEXT NOT NULL,
  target_binding_json TEXT NOT NULL CHECK (json_valid(target_binding_json)),
  state TEXT NOT NULL CHECK (state IN ('ADMITTED','ATTEMPTING','UNKNOWN','BLOCKED','RESTORED_UNQUALIFIED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (principal_ref, idempotency_key)
) STRICT;

CREATE INDEX IF NOT EXISTS backup_restore_intent_epoch_state
  ON backup_restore_intent(epoch_id, state, created_at);

CREATE TABLE IF NOT EXISTS backup_restore_attempt (
  restore_id TEXT NOT NULL REFERENCES backup_restore_intent(restore_id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  attempt_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('STARTED','UNKNOWN','FAILED','SUCCEEDED')),
  attempt_json TEXT NOT NULL CHECK (json_valid(attempt_json)),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  error_code TEXT,
  readback_digest TEXT CHECK (readback_digest IS NULL OR length(readback_digest) = 64),
  PRIMARY KEY (restore_id, attempt_number),
  CHECK ((state = 'STARTED' AND ended_at IS NULL AND error_code IS NULL AND readback_digest IS NULL) OR
         (state = 'UNKNOWN' AND ended_at IS NOT NULL AND error_code IS NOT NULL AND readback_digest IS NULL) OR
         (state = 'FAILED' AND ended_at IS NOT NULL AND error_code IS NOT NULL AND readback_digest IS NULL) OR
         (state = 'SUCCEEDED' AND ended_at IS NOT NULL AND error_code IS NULL AND readback_digest IS NOT NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS backup_restore_receipt (
  restore_id TEXT PRIMARY KEY,
  attempt_number INTEGER NOT NULL,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  receipt_digest TEXT NOT NULL CHECK (length(receipt_digest) = 64),
  created_at TEXT NOT NULL,
  FOREIGN KEY (restore_id, attempt_number)
    REFERENCES backup_restore_attempt(restore_id, attempt_number)
) STRICT;
