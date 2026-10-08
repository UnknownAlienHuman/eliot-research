-- ER-34 O4 durable copy replay and erasure intent authority.
-- Earlier migrations are immutable; apply through the canonical migration ledger.
PRAGMA foreign_keys = ON;

-- The current backup_offsite_copy_receipt stores a digest but not the original
-- OperationIntent, controller destination policy, or primary failure domain.
-- Persist those exact values before the first remote PUT so a later erasure can
-- reconstruct the original authority and call expireOffsiteCopy without
-- inventing caller credentials or identities.
CREATE TABLE backup_offsite_copy_replay_authority (
  copy_id TEXT PRIMARY KEY,
  epoch_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  principal_ref TEXT NOT NULL,
  policy_decision_ref TEXT NOT NULL,
  operation_intent_json TEXT NOT NULL CHECK (json_valid(operation_intent_json)),
  key_generation TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  primary_failure_domain TEXT NOT NULL,
  destination_policy_json TEXT NOT NULL CHECK (json_valid(destination_policy_json)),
  intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 64 AND intent_digest NOT GLOB '*[^0-9a-f]*'),
  policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64 AND policy_digest NOT GLOB '*[^0-9a-f]*'),
  descriptor_digest TEXT NOT NULL CHECK (length(descriptor_digest) = 64 AND descriptor_digest NOT GLOB '*[^0-9a-f]*'),
  authority_authorized_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('INTENT','COMMITTED')),
  created_at TEXT NOT NULL,
  committed_at TEXT,
  CHECK ((state = 'INTENT' AND committed_at IS NULL) OR (state = 'COMMITTED' AND committed_at IS NOT NULL))
) STRICT;
CREATE INDEX backup_offsite_copy_replay_epoch_idx
  ON backup_offsite_copy_replay_authority(epoch_id, state, destination_id, copy_id);

-- One row per erasure/epoch/copy/expiry-intent attempt. The intent row is
-- inserted and read back before expiry invokes any destination DELETE. BLOCKED
-- attempts remain durable; policy/hold/descriptor state changes derive a
-- distinct expiry_intent_key rather than overwriting an old attempt. A DELETED
-- receipt contains the exact O2 expiry bytes and is returned only after O2's
-- descriptor, hold and per-part absence reconciliation succeeds.
CREATE TABLE backup_erasure_replay_obligation (
  erasure_id TEXT NOT NULL,
  erasure_revision INTEGER NOT NULL CHECK (erasure_revision > 0),
  backup_epoch_id TEXT NOT NULL,
  copy_id TEXT NOT NULL REFERENCES backup_offsite_copy_replay_authority(copy_id),
  target_id TEXT NOT NULL,
  expiry_intent_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('PENDING','BLOCKED','DELETED')),
  reason_code TEXT,
  receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(erasure_id, erasure_revision, backup_epoch_id, copy_id, expiry_intent_key),
  FOREIGN KEY(erasure_id, erasure_revision, target_id)
    REFERENCES erasure_target(erasure_id, erasure_revision, target_id),
  CHECK (
    (state = 'PENDING' AND reason_code IS NULL AND receipt_json IS NULL) OR
    (state = 'BLOCKED' AND reason_code IS NOT NULL) OR
    (state = 'DELETED' AND reason_code IS NULL AND receipt_json IS NOT NULL)
  )
) STRICT;
CREATE INDEX backup_erasure_replay_target_idx
  ON backup_erasure_replay_obligation(erasure_id, erasure_revision, backup_epoch_id, copy_id, created_at);

-- Identity is fixed before the first offsite PUT. Only exact committed O2
-- readback may close the authority; terminal rows cannot be edited or removed.
CREATE TRIGGER backup_copy_replay_shape_guard
BEFORE INSERT ON backup_offsite_copy_replay_authority
BEGIN
  SELECT (CASE WHEN NEW.state <> 'INTENT'
    OR json_type(NEW.operation_intent_json) IS NOT 'object'
    OR json_extract(NEW.operation_intent_json,'$.operation_kind') IS NOT 'BACKUP'
    OR json_extract(NEW.operation_intent_json,'$.principal_ref') IS NOT NEW.principal_ref
    OR json_extract(NEW.operation_intent_json,'$.policy_decision_ref') IS NOT NEW.policy_decision_ref
    OR NOT EXISTS (SELECT 1 FROM backup_destination_authority a
      WHERE a.destination_id=NEW.destination_id AND a.principal_ref=NEW.principal_ref
        AND a.policy_decision_ref=NEW.policy_decision_ref AND a.state='AUTHORIZED'
        AND a.policy_json=NEW.destination_policy_json AND a.policy_digest=NEW.policy_digest
        AND a.authorized_at=NEW.authority_authorized_at)
    THEN RAISE(ABORT,'BACKUP_COPY_REPLAY_AUTHORITY_INVALID') END);
END;
CREATE TRIGGER backup_copy_replay_transition_guard
BEFORE UPDATE ON backup_offsite_copy_replay_authority
BEGIN
  SELECT (CASE WHEN
    (NEW.copy_id,NEW.epoch_id,NEW.destination_id,NEW.principal_ref,NEW.policy_decision_ref,
      NEW.operation_intent_json,NEW.key_generation,NEW.expires_at,NEW.primary_failure_domain,
      NEW.destination_policy_json,NEW.intent_digest,NEW.policy_digest,NEW.descriptor_digest,
      NEW.authority_authorized_at,NEW.created_at)
    IS NOT
    (OLD.copy_id,OLD.epoch_id,OLD.destination_id,OLD.principal_ref,OLD.policy_decision_ref,
      OLD.operation_intent_json,OLD.key_generation,OLD.expires_at,OLD.primary_failure_domain,
      OLD.destination_policy_json,OLD.intent_digest,OLD.policy_digest,OLD.descriptor_digest,
      OLD.authority_authorized_at,OLD.created_at)
    OR OLD.state<>'INTENT' OR NEW.state<>'COMMITTED'
    OR NOT EXISTS (SELECT 1 FROM backup_offsite_copy_receipt r
      WHERE r.copy_id=NEW.copy_id AND r.epoch_id=NEW.epoch_id AND r.destination_id=NEW.destination_id
        AND r.key_generation=NEW.key_generation AND r.expires_at=NEW.expires_at
        AND r.intent_digest=NEW.intent_digest AND r.policy_digest=NEW.policy_digest
        AND r.descriptor_digest=NEW.descriptor_digest AND r.authority_authorized_at=NEW.authority_authorized_at)
    THEN RAISE(ABORT,'BACKUP_COPY_REPLAY_IDENTITY_CONFLICT') END);
END;
CREATE TRIGGER backup_copy_replay_no_delete
BEFORE DELETE ON backup_offsite_copy_replay_authority
BEGIN SELECT RAISE(ABORT,'BACKUP_COPY_REPLAY_IMMUTABLE'); END;

CREATE TRIGGER backup_erasure_replay_insert_guard
BEFORE INSERT ON backup_erasure_replay_obligation
BEGIN
  SELECT (CASE WHEN NEW.state<>'PENDING' OR NOT EXISTS (
    SELECT 1 FROM erasure_target t JOIN erasure_execution e
      ON e.erasure_id=t.erasure_id AND e.revision=t.erasure_revision
    JOIN backup_offsite_copy_replay_authority c ON c.copy_id=NEW.copy_id
    WHERE t.erasure_id=NEW.erasure_id AND t.erasure_revision=NEW.erasure_revision
      AND t.target_id=NEW.target_id AND t.location='BackupRestorePath' AND t.target_kind='OBJECT'
      AND t.canonical_ref='backup:'||NEW.backup_epoch_id AND c.epoch_id=NEW.backup_epoch_id
      AND e.state NOT IN ('COMPLETE','BLOCKED','FAILED') AND e.lease_owner IS NOT NULL
  ) THEN RAISE(ABORT,'BACKUP_ERASURE_REPLAY_TARGET_INVALID') END);
END;
CREATE TRIGGER backup_erasure_replay_transition_guard
BEFORE UPDATE ON backup_erasure_replay_obligation
WHEN
  (NEW.erasure_id,NEW.erasure_revision,NEW.backup_epoch_id,NEW.copy_id,NEW.target_id,
    NEW.expiry_intent_key,NEW.created_at)
  IS NOT
  (OLD.erasure_id,OLD.erasure_revision,OLD.backup_epoch_id,OLD.copy_id,OLD.target_id,
    OLD.expiry_intent_key,OLD.created_at)
  OR OLD.state<>'PENDING' OR NEW.state NOT IN ('BLOCKED','DELETED')
BEGIN SELECT RAISE(ABORT,'BACKUP_ERASURE_REPLAY_IDENTITY_CONFLICT'); END;
CREATE TRIGGER backup_erasure_replay_no_delete
BEFORE DELETE ON backup_erasure_replay_obligation
BEGIN SELECT RAISE(ABORT,'BACKUP_ERASURE_REPLAY_IMMUTABLE'); END;
