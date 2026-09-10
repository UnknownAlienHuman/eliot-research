-- ER-15: durable execution fencing and queue-consumer deduplication.
-- Canonical mutation/outbox tables remain owned by the initial schema; this migration adds only
-- coordination state that can be referenced by outbox and queue adapters.

CREATE TABLE IF NOT EXISTS operation_execution_lease (
  operation_id TEXT PRIMARY KEY,
  operation_kind TEXT NOT NULL,
  lease_owner TEXT NOT NULL,
  lease_generation INTEGER NOT NULL CHECK (lease_generation >= 1),
  lease_until INTEGER NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  state TEXT NOT NULL CHECK (state IN ('LEASED', 'COMPLETED', 'FAILED', 'CANCELLED')),
  checkpoint_ref TEXT,
  terminal_receipt_ref TEXT,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS operation_execution_lease_due
ON operation_execution_lease(state, lease_until, operation_kind);

CREATE TABLE IF NOT EXISTS delivery_inbox (
  message_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  topic TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PROCESSING', 'COMPLETED', 'RETRYABLE_FAILURE', 'TERMINAL_FAILURE')),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  lease_owner TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_until INTEGER,
  result_receipt_ref TEXT,
  last_error_code TEXT,
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(topic, idempotency_key)
) STRICT;

CREATE INDEX IF NOT EXISTS delivery_inbox_due
ON delivery_inbox(state, lease_until, topic);
