-- ER-34 O2 durable producer fence. Every new producer attempt is claimed before
-- source capture, then pins its exact immutable output plan before the first
-- backup-parts write. Uncertain WRITING attempts remain blocking for operator
-- reconciliation; this migration intentionally defines no lease or reaper.
-- D1 native parser compatibility: parenthesize trigger CASE guards (workers-sdk#4727).
PRAGMA foreign_keys = ON;

CREATE TABLE backup_epoch_producer_claim (
  idempotency_key TEXT PRIMARY KEY,
  base_intent_digest TEXT NOT NULL CHECK (
    length(base_intent_digest) = 64 AND base_intent_digest NOT GLOB '*[^0-9a-f]*'
  ),
  attempt_nonce TEXT NOT NULL UNIQUE CHECK (
    length(attempt_nonce) = 36 AND
    substr(attempt_nonce, 9, 1) = '-' AND substr(attempt_nonce, 14, 1) = '-' AND
    substr(attempt_nonce, 19, 1) = '-' AND substr(attempt_nonce, 24, 1) = '-' AND
    substr(attempt_nonce, 1, 8) NOT GLOB '*[^0-9a-f]*' AND
    substr(attempt_nonce, 10, 4) NOT GLOB '*[^0-9a-f]*' AND
    substr(attempt_nonce, 15, 4) NOT GLOB '*[^0-9a-f]*' AND
    substr(attempt_nonce, 20, 4) NOT GLOB '*[^0-9a-f]*' AND
    substr(attempt_nonce, 25, 12) NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN (
    'CAPTURING','WRITING','UNKNOWN','COMMITTED','ABANDONED_NO_WRITES'
  )),
  epoch_id TEXT UNIQUE,
  part_prefix TEXT,
  cut_id TEXT,
  cut_digest TEXT CHECK (
    cut_digest IS NULL OR (
      length(cut_digest) = 64 AND cut_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  vector_digest TEXT CHECK (
    vector_digest IS NULL OR (
      length(vector_digest) = 64 AND vector_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  manifest_digest TEXT CHECK (
    manifest_digest IS NULL OR (
      length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  intent_digest TEXT CHECK (
    intent_digest IS NULL OR (
      length(intent_digest) = 64 AND intent_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  receipt_digest TEXT CHECK (
    receipt_digest IS NULL OR (
      length(receipt_digest) = 64 AND receipt_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (state IN ('CAPTURING','ABANDONED_NO_WRITES') AND
      epoch_id IS NULL AND part_prefix IS NULL AND cut_id IS NULL AND cut_digest IS NULL AND
      vector_digest IS NULL AND manifest_digest IS NULL AND intent_digest IS NULL AND receipt_digest IS NULL)
    OR
    (state IN ('WRITING','UNKNOWN') AND
      epoch_id IS NOT NULL AND part_prefix IS NOT NULL AND part_prefix = 'backup-parts/' || epoch_id || '/' AND
      cut_id IS NOT NULL AND cut_digest IS NOT NULL AND cut_id = 'cut-' || substr(cut_digest, 1, 32) AND
      vector_digest IS NOT NULL AND manifest_digest IS NOT NULL AND intent_digest IS NOT NULL AND
      receipt_digest IS NULL)
    OR
    (state = 'COMMITTED' AND
      epoch_id IS NOT NULL AND part_prefix IS NOT NULL AND part_prefix = 'backup-parts/' || epoch_id || '/' AND
      cut_id IS NOT NULL AND cut_digest IS NOT NULL AND cut_id = 'cut-' || substr(cut_digest, 1, 32) AND
      vector_digest IS NOT NULL AND manifest_digest IS NOT NULL AND intent_digest IS NOT NULL AND
      receipt_digest IS NOT NULL)
  )
) STRICT;

CREATE INDEX backup_epoch_producer_claim_state_idx
  ON backup_epoch_producer_claim(state, idempotency_key);

-- Admission and the pre-write transition repeat the erasure check at the
-- database boundary. An unknown erasure state is non-COMPLETE and therefore
-- blocks. Existing WRITING attempts may settle after an erasure is requested;
-- the erasure consumer must wait for their terminal producer receipts.
CREATE TRIGGER backup_epoch_producer_claim_admission_guard
BEFORE INSERT ON backup_epoch_producer_claim
WHEN EXISTS (SELECT 1 FROM erasure_case WHERE state <> 'COMPLETE')
  OR EXISTS (SELECT 1 FROM erasure_execution WHERE state <> 'COMPLETE')
BEGIN
  SELECT RAISE(ABORT, 'backup producer admission blocked by active erasure');
END;

CREATE TRIGGER backup_epoch_producer_claim_transition_guard
BEFORE UPDATE ON backup_epoch_producer_claim
BEGIN
  SELECT (CASE WHEN
    NEW.idempotency_key IS NOT OLD.idempotency_key OR
    NEW.base_intent_digest IS NOT OLD.base_intent_digest OR
    NEW.attempt_nonce IS NOT OLD.attempt_nonce OR
    NEW.created_at IS NOT OLD.created_at
    THEN RAISE(ABORT, 'backup producer claim identity is immutable') END);

  SELECT (CASE WHEN NOT (
    (OLD.state = 'CAPTURING' AND NEW.state IN ('WRITING','ABANDONED_NO_WRITES')) OR
    (OLD.state = 'WRITING' AND NEW.state IN ('UNKNOWN','COMMITTED'))
  ) THEN RAISE(ABORT, 'invalid backup producer claim transition') END);

  SELECT (CASE WHEN OLD.state = 'CAPTURING' AND NEW.state = 'WRITING' AND (
    EXISTS (SELECT 1 FROM erasure_case WHERE state <> 'COMPLETE') OR
    EXISTS (SELECT 1 FROM erasure_execution WHERE state <> 'COMPLETE')
  ) THEN RAISE(ABORT, 'backup producer write blocked by active erasure') END);

  SELECT (CASE WHEN OLD.state = 'WRITING' AND (
    NEW.epoch_id IS NOT OLD.epoch_id OR NEW.part_prefix IS NOT OLD.part_prefix OR
    NEW.cut_id IS NOT OLD.cut_id OR NEW.cut_digest IS NOT OLD.cut_digest OR
    NEW.vector_digest IS NOT OLD.vector_digest OR NEW.manifest_digest IS NOT OLD.manifest_digest OR
    NEW.intent_digest IS NOT OLD.intent_digest
  ) THEN RAISE(ABORT, 'backup producer pins are immutable after WRITING') END);
END;

CREATE TRIGGER backup_epoch_producer_claim_insert_state_guard
BEFORE INSERT ON backup_epoch_producer_claim
WHEN NEW.state <> 'CAPTURING'
BEGIN
  SELECT RAISE(ABORT, 'backup producer claims must begin in CAPTURING');
END;

CREATE TRIGGER backup_epoch_producer_claim_delete_guard
BEFORE DELETE ON backup_epoch_producer_claim
BEGIN
  SELECT RAISE(ABORT, 'backup producer claim history is immutable');
END;
