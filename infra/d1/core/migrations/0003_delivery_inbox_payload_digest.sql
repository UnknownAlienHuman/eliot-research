-- Bind a queue-consumer idempotency identity to the exact immutable payload.
-- The table is introduced empty by 0002; nullable keeps SQLite ALTER TABLE portable.
-- Runtime refuses legacy/null rows, while the CHECK prevents malformed non-null digests.

ALTER TABLE delivery_inbox ADD COLUMN payload_sha256 TEXT
  CHECK (payload_sha256 IS NULL OR (
    length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ));

CREATE INDEX IF NOT EXISTS delivery_inbox_payload_identity
ON delivery_inbox(topic, idempotency_key, payload_ref, payload_sha256);
