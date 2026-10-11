-- S64: immutable, bounded transport-terminal diagnostics, never business outcomes.
-- Malformed/foreign input retains only native transport metadata, with no invented
-- outbox identity, raw body, error, provider payload, prompt or evidence bytes.
CREATE TABLE queue_terminal_observation (
  queue_name TEXT NOT NULL CHECK (length(queue_name) BETWEEN 1 AND 256),
  platform_message_id TEXT NOT NULL CHECK (length(platform_message_id) BETWEEN 1 AND 256),
  platform_attempt INTEGER NOT NULL CHECK (platform_attempt >= 1),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms BETWEEN 0 AND 253402300799999),
  disposition TEXT NOT NULL CHECK (disposition IN ('MALFORMED','IDENTITY_MISMATCH','QUARANTINED','COMPLETED')),
  outbox_id TEXT REFERENCES outbox(outbox_id) ON DELETE CASCADE,
  original_message_json TEXT CHECK (original_message_json IS NULL OR
    (length(original_message_json) <= 16384 AND json_valid(original_message_json))),
  completed_receipt_ref TEXT CHECK (completed_receipt_ref IS NULL OR length(completed_receipt_ref) BETWEEN 1 AND 1024),
  PRIMARY KEY (queue_name, platform_message_id),
  CHECK (
    (disposition IN ('MALFORMED','IDENTITY_MISMATCH') AND outbox_id IS NULL AND
      original_message_json IS NULL AND completed_receipt_ref IS NULL) OR
    (disposition = 'QUARANTINED' AND outbox_id IS NOT NULL AND
      original_message_json IS NOT NULL AND completed_receipt_ref IS NULL) OR
    (disposition = 'COMPLETED' AND outbox_id IS NOT NULL AND
      original_message_json IS NOT NULL AND completed_receipt_ref IS NOT NULL)
  )
) STRICT;

CREATE INDEX queue_terminal_observation_outbox
  ON queue_terminal_observation(outbox_id, observed_at_ms);

-- Owner replay gets a separate effect receipt; it cannot rewrite an observation.
CREATE TRIGGER queue_terminal_observation_immutable
BEFORE UPDATE ON queue_terminal_observation
BEGIN
  SELECT RAISE(ABORT, 'queue terminal observations are immutable');
END;
