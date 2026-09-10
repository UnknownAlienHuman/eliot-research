PRAGMA foreign_keys = ON;

ALTER TABLE outbox ADD COLUMN payload_sha256 TEXT
  CHECK (payload_sha256 IS NULL OR (
    length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ));
ALTER TABLE outbox ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0
  CHECK (lease_generation >= 0);

CREATE INDEX outbox_delivery_claim_idx
  ON outbox(state, next_attempt_at, lease_until, created_at, outbox_id);

UPDATE schema_state
SET value = 'core-v4-delivery-fenced', updated_at = '2026-08-30T00:00:00Z'
WHERE key = 'schema_generation';
