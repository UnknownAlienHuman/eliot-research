-- Bind a queue-consumer idempotency identity to the exact immutable payload.
-- The table is introduced empty by 0002; the nullable declaration keeps SQLite ALTER TABLE portable.
-- The runtime fails closed if any row lacks this digest.

ALTER TABLE delivery_inbox ADD COLUMN payload_sha256 TEXT;

CREATE INDEX IF NOT EXISTS delivery_inbox_payload_identity
ON delivery_inbox(topic, idempotency_key, payload_ref, payload_sha256);
