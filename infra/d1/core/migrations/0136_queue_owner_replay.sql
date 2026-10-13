-- An explicit owner action releases one original outbox delivery. Cloudflare still
-- owns transport retries; this record neither runs the handler nor resets Inbox.
CREATE TABLE queue_owner_replay (
  queue_name TEXT NOT NULL,
  platform_message_id TEXT NOT NULL,
  outbox_id TEXT NOT NULL REFERENCES outbox(outbox_id) ON DELETE CASCADE,
  original_message_id TEXT NOT NULL CHECK (length(original_message_id) BETWEEN 1 AND 256),
  replay_outbox_attempt INTEGER NOT NULL CHECK (replay_outbox_attempt BETWEEN 2 AND 10000),
  principal_ref TEXT NOT NULL CHECK (length(principal_ref) BETWEEN 1 AND 256),
  credential_generation TEXT NOT NULL CHECK (length(credential_generation) BETWEEN 1 AND 256),
  request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 1 AND 256),
  authorized_at_ms INTEGER NOT NULL CHECK (authorized_at_ms BETWEEN 0 AND 253402300799999),
  PRIMARY KEY (queue_name, platform_message_id),
  UNIQUE (outbox_id, original_message_id),
  UNIQUE (principal_ref, request_key),
  FOREIGN KEY (queue_name, platform_message_id)
    REFERENCES queue_terminal_observation(queue_name, platform_message_id) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER queue_owner_replay_identity_guard
BEFORE INSERT ON queue_owner_replay
WHEN NOT EXISTS (
  SELECT 1 FROM queue_terminal_observation q
  JOIN outbox o ON o.outbox_id=q.outbox_id
  JOIN operation_intent i ON (i.intent_id,i.revision)=(o.intent_id,o.intent_revision)
  WHERE q.queue_name=NEW.queue_name AND q.platform_message_id=NEW.platform_message_id
    AND q.disposition='QUARANTINED' AND q.outbox_id=NEW.outbox_id
    AND json_extract(q.original_message_json,'$.message_id')=NEW.original_message_id
    AND json_extract(q.original_message_json,'$.outbox_id')=o.outbox_id
    AND json_extract(q.original_message_json,'$.topic')=o.topic
    AND json_extract(q.original_message_json,'$.payload_ref')=o.payload_ref
    AND json_extract(q.original_message_json,'$.payload_sha256')=o.payload_sha256
    AND json_extract(q.original_message_json,'$.idempotency_key')=i.idempotency_key
    AND json_extract(q.original_message_json,'$.created_at_ms')=CAST(unixepoch(o.created_at,'subsec')*1000 AS INTEGER)
    AND json_extract(q.original_message_json,'$.outbox_attempt')<=o.attempts
    AND NEW.replay_outbox_attempt=o.attempts+1
    AND o.state IN ('SENT','DEAD_LETTERED') AND o.lease_owner IS NULL AND o.lease_until IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM delivery_inbox b WHERE b.topic=o.topic AND b.idempotency_key=i.idempotency_key
        AND (b.state<>'RETRYABLE_FAILURE' OR b.payload_ref<>o.payload_ref
          OR b.payload_sha256 IS NOT o.payload_sha256
          OR b.last_error_code IN ('DELIVERY_SETTLEMENT_UNCERTAIN','EFFECT_UNKNOWN'))
    )
)
BEGIN SELECT RAISE(ABORT,'QUEUE_REPLAY_DENIED'); END;

-- A single INSERT commits both the authorization link and original delivery intent.
CREATE TRIGGER queue_owner_replay_release_outbox
AFTER INSERT ON queue_owner_replay
BEGIN
  UPDATE outbox SET state='PENDING', next_attempt_at=NEW.authorized_at_ms,
    queue_message_id=NULL, last_error_code=NULL,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ',NEW.authorized_at_ms/1000.0,'unixepoch')
  WHERE outbox_id=NEW.outbox_id AND attempts=NEW.replay_outbox_attempt-1
    AND state IN ('SENT','DEAD_LETTERED') AND lease_owner IS NULL AND lease_until IS NULL;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'QUEUE_REPLAY_CONFLICT') END;
END;

CREATE TRIGGER queue_owner_replay_immutable
BEFORE UPDATE ON queue_owner_replay
BEGIN SELECT RAISE(ABORT,'QUEUE_REPLAY_IMMUTABLE'); END;

INSERT INTO schema_state(key,value,updated_at)
VALUES ('queue_owner_replay_generation','queue-owner-replay-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
