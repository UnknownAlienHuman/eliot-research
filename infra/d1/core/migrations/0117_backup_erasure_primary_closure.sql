-- ER-34 binds backup deletion to one immutable primary-part inventory and a
-- separately verified owner/controller retirement qualification. O4 receipts
-- remain independently required; this migration never makes provider absence
-- or a caller-supplied flag stand in for local primary R2 evidence.
-- D1 native parser compatibility: parenthesize trigger CASE guards (workers-sdk#4727).
PRAGMA foreign_keys = ON;

ALTER TABLE backup_purge_obligation ADD COLUMN primary_delete_intent_ref TEXT;
ALTER TABLE backup_purge_obligation ADD COLUMN primary_delete_intent_digest TEXT CHECK (
  primary_delete_intent_digest IS NULL OR (
    length(primary_delete_intent_digest) = 64 AND primary_delete_intent_digest NOT GLOB '*[^0-9a-f]*'
  )
);
ALTER TABLE backup_purge_obligation ADD COLUMN primary_delete_receipt_ref TEXT;
ALTER TABLE backup_purge_obligation ADD COLUMN primary_absence_receipt_ref TEXT;
ALTER TABLE backup_purge_obligation ADD COLUMN offsite_delete_receipt_ref TEXT;
ALTER TABLE backup_purge_obligation ADD COLUMN offsite_absence_receipt_ref TEXT;
ALTER TABLE erasure_terminal_guard ADD COLUMN lease_owner TEXT;
ALTER TABLE erasure_terminal_guard ADD COLUMN lease_generation INTEGER CHECK (lease_generation IS NULL OR lease_generation > 0);
ALTER TABLE erasure_terminal_guard ADD COLUMN lease_until INTEGER CHECK (lease_until IS NULL OR lease_until > 0);

CREATE TABLE backup_erasure_primary_closure (
  erasure_id TEXT NOT NULL,
  erasure_revision INTEGER NOT NULL CHECK (erasure_revision > 0),
  lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
  lease_owner TEXT NOT NULL,
  lease_until INTEGER NOT NULL CHECK (lease_until > 0),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  erasure_closure_digest TEXT NOT NULL CHECK (
    length(erasure_closure_digest) = 64 AND erasure_closure_digest NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('BUILDING','SEALED')),
  producer_claim_count INTEGER NOT NULL CHECK (producer_claim_count BETWEEN 0 AND 100000),
  producer_claims_digest TEXT NOT NULL CHECK (
    length(producer_claims_digest) = 64 AND producer_claims_digest NOT GLOB '*[^0-9a-f]*'
  ),
  canonical_epoch_count INTEGER NOT NULL CHECK (canonical_epoch_count BETWEEN 0 AND 100000),
  canonical_epochs_digest TEXT NOT NULL CHECK (
    length(canonical_epochs_digest) = 64 AND canonical_epochs_digest NOT GLOB '*[^0-9a-f]*'
  ),
  export_cut_count INTEGER NOT NULL CHECK (export_cut_count BETWEEN 0 AND 100000),
  export_cut_inventory_digest TEXT NOT NULL CHECK (
    length(export_cut_inventory_digest) = 64 AND export_cut_inventory_digest NOT GLOB '*[^0-9a-f]*'
  ),
  qualification_mode TEXT NOT NULL CHECK (qualification_mode IN ('ISOLATED_NEW_BUCKET','LEGACY_WRITERS_DRAINED')),
  qualification_receipt_ref TEXT NOT NULL,
  operation_receipt_digest TEXT NOT NULL CHECK (
    length(operation_receipt_digest) = 64 AND operation_receipt_digest NOT GLOB '*[^0-9a-f]*'
  ),
  qualification_receipt_digest TEXT NOT NULL CHECK (
    length(qualification_receipt_digest) = 64 AND qualification_receipt_digest NOT GLOB '*[^0-9a-f]*'
  ),
  admission_binding_ref TEXT NOT NULL,
  admission_binding_digest TEXT NOT NULL CHECK (
    length(admission_binding_digest) = 64 AND admission_binding_digest NOT GLOB '*[^0-9a-f]*'
  ),
  cloudflare_account_ref TEXT NOT NULL,
  primary_bucket_binding_ref TEXT NOT NULL,
  worker_version_ref TEXT NOT NULL,
  controller_generation TEXT NOT NULL,
  controller_fingerprint TEXT NOT NULL CHECK (
    length(controller_fingerprint) = 64 AND controller_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  configuration_sha256 TEXT NOT NULL CHECK (
    length(configuration_sha256) = 64 AND configuration_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  artifact_sha256 TEXT NOT NULL CHECK (length(artifact_sha256) = 64 AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'),
  bootstrap_zero_state_receipt_ref TEXT NOT NULL,
  bootstrap_zero_state_digest TEXT NOT NULL CHECK (
    length(bootstrap_zero_state_digest) = 64 AND bootstrap_zero_state_digest NOT GLOB '*[^0-9a-f]*'
  ),
  qualification_evidence_digest TEXT NOT NULL CHECK (
    length(qualification_evidence_digest) = 64 AND qualification_evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  primary_prefix_object_count INTEGER NOT NULL CHECK (primary_prefix_object_count BETWEEN 0 AND 100000),
  primary_prefix_inventory_digest TEXT NOT NULL CHECK (
    length(primary_prefix_inventory_digest) = 64 AND primary_prefix_inventory_digest NOT GLOB '*[^0-9a-f]*'
  ),
  target_count INTEGER NOT NULL CHECK (target_count BETWEEN 1 AND 100000),
  target_digest TEXT NOT NULL CHECK (length(target_digest) = 64 AND target_digest NOT GLOB '*[^0-9a-f]*'),
  target_part_count INTEGER NOT NULL CHECK (target_part_count BETWEEN 1 AND 100000),
  target_part_digest TEXT NOT NULL CHECK (length(target_part_digest) = 64 AND target_part_digest NOT GLOB '*[^0-9a-f]*'),
  plan_digest TEXT NOT NULL CHECK (length(plan_digest) = 64 AND plan_digest NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (erasure_id, erasure_revision, lease_generation),
  FOREIGN KEY (erasure_id, erasure_revision)
    REFERENCES erasure_execution(erasure_id, revision)
) STRICT;

CREATE TABLE backup_erasure_primary_claim_pin (
  erasure_id TEXT NOT NULL,
  erasure_revision INTEGER NOT NULL,
  lease_generation INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  base_intent_digest TEXT NOT NULL CHECK (length(base_intent_digest) = 64 AND base_intent_digest NOT GLOB '*[^0-9a-f]*'),
  attempt_nonce TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('COMMITTED','ABANDONED_NO_WRITES')),
  epoch_id TEXT,
  part_prefix TEXT,
  cut_id TEXT,
  cut_digest TEXT CHECK (cut_digest IS NULL OR (length(cut_digest) = 64 AND cut_digest NOT GLOB '*[^0-9a-f]*')),
  vector_digest TEXT CHECK (vector_digest IS NULL OR (length(vector_digest) = 64 AND vector_digest NOT GLOB '*[^0-9a-f]*')),
  manifest_digest TEXT CHECK (manifest_digest IS NULL OR (length(manifest_digest) = 64 AND manifest_digest NOT GLOB '*[^0-9a-f]*')),
  intent_digest TEXT CHECK (intent_digest IS NULL OR (length(intent_digest) = 64 AND intent_digest NOT GLOB '*[^0-9a-f]*')),
  receipt_digest TEXT CHECK (receipt_digest IS NULL OR (length(receipt_digest) = 64 AND receipt_digest NOT GLOB '*[^0-9a-f]*')),
  PRIMARY KEY (erasure_id, erasure_revision, lease_generation, idempotency_key),
  FOREIGN KEY (erasure_id, erasure_revision, lease_generation)
    REFERENCES backup_erasure_primary_closure(erasure_id, erasure_revision, lease_generation),
  CHECK (
    (state = 'ABANDONED_NO_WRITES' AND epoch_id IS NULL AND part_prefix IS NULL AND cut_id IS NULL AND
      cut_digest IS NULL AND vector_digest IS NULL AND manifest_digest IS NULL AND intent_digest IS NULL AND receipt_digest IS NULL)
    OR
    (state = 'COMMITTED' AND epoch_id IS NOT NULL AND part_prefix IS NOT NULL AND part_prefix = 'backup-parts/' || epoch_id || '/' AND
      cut_id IS NOT NULL AND cut_digest IS NOT NULL AND vector_digest IS NOT NULL AND manifest_digest IS NOT NULL AND
      intent_digest IS NOT NULL AND receipt_digest IS NOT NULL)
  )
) STRICT;

CREATE TABLE backup_erasure_primary_cut_pin (
  erasure_id TEXT NOT NULL,
  erasure_revision INTEGER NOT NULL,
  lease_generation INTEGER NOT NULL,
  cut_id TEXT NOT NULL,
  cut_digest TEXT NOT NULL CHECK (length(cut_digest) = 64 AND cut_digest NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('OPEN','ACCEPTED','REJECTED')),
  classification TEXT NOT NULL CHECK (classification IN ('COMMITTED_CLAIM','LEGACY_RETIRED')),
  idempotency_key TEXT,
  PRIMARY KEY (erasure_id, erasure_revision, lease_generation, cut_id),
  FOREIGN KEY (erasure_id, erasure_revision, lease_generation)
    REFERENCES backup_erasure_primary_closure(erasure_id, erasure_revision, lease_generation),
  CHECK (
    (classification = 'COMMITTED_CLAIM' AND idempotency_key IS NOT NULL AND state = 'ACCEPTED') OR
    (classification = 'LEGACY_RETIRED' AND idempotency_key IS NULL)
  )
) STRICT;

CREATE TABLE backup_erasure_primary_target_pin (
  erasure_id TEXT NOT NULL,
  erasure_revision INTEGER NOT NULL,
  lease_generation INTEGER NOT NULL,
  target_id TEXT NOT NULL,
  backup_epoch_id TEXT NOT NULL,
  target_json TEXT NOT NULL CHECK (json_valid(target_json)),
  identity_digest TEXT NOT NULL CHECK (length(identity_digest) = 64 AND identity_digest NOT GLOB '*[^0-9a-f]*'),
  target_digest TEXT NOT NULL CHECK (length(target_digest) = 64 AND target_digest NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (erasure_id, erasure_revision, lease_generation, target_id),
  UNIQUE (erasure_id, erasure_revision, lease_generation, backup_epoch_id),
  FOREIGN KEY (erasure_id, erasure_revision, lease_generation)
    REFERENCES backup_erasure_primary_closure(erasure_id, erasure_revision, lease_generation)
) STRICT;

CREATE TABLE backup_erasure_primary_part_pin (
  erasure_id TEXT NOT NULL,
  erasure_revision INTEGER NOT NULL,
  lease_generation INTEGER NOT NULL,
  part_key TEXT NOT NULL,
  backup_epoch_id TEXT NOT NULL,
  manifest TEXT NOT NULL,
  part_index INTEGER NOT NULL CHECK (part_index > 0),
  part_sha256 TEXT NOT NULL CHECK (length(part_sha256) = 64 AND part_sha256 NOT GLOB '*[^0-9a-f]*'),
  payload_identity_digest TEXT CHECK (
    payload_identity_digest IS NULL OR (length(payload_identity_digest) = 64 AND payload_identity_digest NOT GLOB '*[^0-9a-f]*')
  ),
  payload_part_count INTEGER CHECK (payload_part_count IS NULL OR payload_part_count > 0),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  etag TEXT NOT NULL,
  custom_metadata_json TEXT NOT NULL CHECK (json_valid(custom_metadata_json)),
  object_digest TEXT NOT NULL CHECK (length(object_digest) = 64 AND object_digest NOT GLOB '*[^0-9a-f]*'),
  is_target_part INTEGER NOT NULL CHECK (is_target_part IN (0,1)),
  PRIMARY KEY (erasure_id, erasure_revision, lease_generation, part_key),
  FOREIGN KEY (erasure_id, erasure_revision, lease_generation)
    REFERENCES backup_erasure_primary_closure(erasure_id, erasure_revision, lease_generation),
  CHECK ((payload_identity_digest IS NULL AND payload_part_count IS NULL) OR
    (payload_identity_digest IS NOT NULL AND payload_part_count IS NOT NULL))
) STRICT;

CREATE TABLE backup_erasure_primary_delete_item (
  erasure_id TEXT NOT NULL,
  erasure_revision INTEGER NOT NULL,
  lease_generation INTEGER NOT NULL,
  target_id TEXT NOT NULL,
  part_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PINNED','DELETE_INTENT','UNKNOWN','DELETED','ABSENT')),
  delete_intent_ref TEXT,
  delete_intent_digest TEXT CHECK (
    delete_intent_digest IS NULL OR (length(delete_intent_digest) = 64 AND delete_intent_digest NOT GLOB '*[^0-9a-f]*')
  ),
  delete_receipt_ref TEXT,
  absence_receipt_ref TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (erasure_id, erasure_revision, lease_generation, target_id, part_key),
  FOREIGN KEY (erasure_id, erasure_revision, lease_generation, target_id)
    REFERENCES backup_erasure_primary_target_pin(erasure_id, erasure_revision, lease_generation, target_id),
  FOREIGN KEY (erasure_id, erasure_revision, lease_generation, part_key)
    REFERENCES backup_erasure_primary_part_pin(erasure_id, erasure_revision, lease_generation, part_key),
  CHECK (
    (state = 'PINNED' AND delete_intent_ref IS NULL AND delete_intent_digest IS NULL AND delete_receipt_ref IS NULL AND absence_receipt_ref IS NULL) OR
    (state IN ('DELETE_INTENT','UNKNOWN') AND delete_intent_ref IS NOT NULL AND delete_intent_digest IS NOT NULL AND delete_receipt_ref IS NULL AND absence_receipt_ref IS NULL) OR
    (state = 'DELETED' AND delete_intent_ref IS NOT NULL AND delete_intent_digest IS NOT NULL AND delete_receipt_ref IS NOT NULL AND absence_receipt_ref IS NULL) OR
    (state = 'ABSENT' AND delete_intent_ref IS NOT NULL AND delete_intent_digest IS NOT NULL AND delete_receipt_ref IS NOT NULL AND absence_receipt_ref IS NOT NULL)
  )
) STRICT;

CREATE INDEX backup_erasure_primary_target_epoch_idx
  ON backup_erasure_primary_target_pin(erasure_id, erasure_revision, lease_generation, backup_epoch_id);
CREATE INDEX backup_erasure_primary_delete_state_idx
  ON backup_erasure_primary_delete_item(erasure_id, erasure_revision, lease_generation, state);

CREATE TRIGGER backup_erasure_primary_closure_insert_guard
BEFORE INSERT ON backup_erasure_primary_closure
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM erasure_case c JOIN erasure_execution e
      ON e.erasure_id=c.erasure_id AND e.revision=c.revision
    WHERE c.erasure_id=NEW.erasure_id AND c.revision=NEW.erasure_revision
      AND c.state=e.state AND e.state IN ('QUARANTINE_AND_REVOKE','ENUMERATE_DEPENDENCY_CLOSURE')
      AND e.request_sha256=NEW.request_sha256 AND e.lease_owner=NEW.lease_owner
      AND e.lease_generation=NEW.lease_generation AND e.lease_until=NEW.lease_until
  ) THEN RAISE(ABORT, 'backup primary closure requires the exact live erasure fence') END);
END;

CREATE TRIGGER backup_erasure_primary_closure_transition_guard
BEFORE UPDATE ON backup_erasure_primary_closure
BEGIN
  SELECT (CASE WHEN
    NEW.erasure_id IS NOT OLD.erasure_id OR NEW.erasure_revision IS NOT OLD.erasure_revision OR
    NEW.lease_generation IS NOT OLD.lease_generation OR NEW.lease_owner IS NOT OLD.lease_owner OR
    NEW.lease_until IS NOT OLD.lease_until OR NEW.request_sha256 IS NOT OLD.request_sha256 OR
    NEW.erasure_closure_digest IS NOT OLD.erasure_closure_digest OR
    NEW.producer_claim_count IS NOT OLD.producer_claim_count OR NEW.producer_claims_digest IS NOT OLD.producer_claims_digest OR
    NEW.canonical_epoch_count IS NOT OLD.canonical_epoch_count OR NEW.canonical_epochs_digest IS NOT OLD.canonical_epochs_digest OR
    NEW.export_cut_count IS NOT OLD.export_cut_count OR NEW.export_cut_inventory_digest IS NOT OLD.export_cut_inventory_digest OR
    NEW.qualification_mode IS NOT OLD.qualification_mode OR NEW.qualification_receipt_ref IS NOT OLD.qualification_receipt_ref OR
    NEW.operation_receipt_digest IS NOT OLD.operation_receipt_digest OR
    NEW.qualification_receipt_digest IS NOT OLD.qualification_receipt_digest OR NEW.admission_binding_ref IS NOT OLD.admission_binding_ref OR
    NEW.admission_binding_digest IS NOT OLD.admission_binding_digest OR NEW.cloudflare_account_ref IS NOT OLD.cloudflare_account_ref OR
    NEW.primary_bucket_binding_ref IS NOT OLD.primary_bucket_binding_ref OR NEW.worker_version_ref IS NOT OLD.worker_version_ref OR
    NEW.controller_generation IS NOT OLD.controller_generation OR NEW.controller_fingerprint IS NOT OLD.controller_fingerprint OR
    NEW.source_sha256 IS NOT OLD.source_sha256 OR NEW.configuration_sha256 IS NOT OLD.configuration_sha256 OR
    NEW.artifact_sha256 IS NOT OLD.artifact_sha256 OR NEW.bootstrap_zero_state_receipt_ref IS NOT OLD.bootstrap_zero_state_receipt_ref OR
    NEW.bootstrap_zero_state_digest IS NOT OLD.bootstrap_zero_state_digest OR
    NEW.qualification_evidence_digest IS NOT OLD.qualification_evidence_digest OR NEW.primary_prefix_object_count IS NOT OLD.primary_prefix_object_count OR
    NEW.primary_prefix_inventory_digest IS NOT OLD.primary_prefix_inventory_digest OR NEW.target_count IS NOT OLD.target_count OR
    NEW.target_digest IS NOT OLD.target_digest OR NEW.target_part_count IS NOT OLD.target_part_count OR
    NEW.target_part_digest IS NOT OLD.target_part_digest OR NEW.plan_digest IS NOT OLD.plan_digest OR NEW.created_at IS NOT OLD.created_at
    THEN RAISE(ABORT, 'backup primary closure pins are immutable') END);
  SELECT (CASE WHEN NOT (OLD.state='BUILDING' AND NEW.state='SEALED')
    THEN RAISE(ABORT, 'backup primary closure may only seal once') END);
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM erasure_case c JOIN erasure_execution e
      ON e.erasure_id=c.erasure_id AND e.revision=c.revision
    WHERE c.erasure_id=OLD.erasure_id AND c.revision=OLD.erasure_revision
      AND c.state=e.state AND e.state IN ('QUARANTINE_AND_REVOKE','ENUMERATE_DEPENDENCY_CLOSURE')
      AND e.request_sha256=OLD.request_sha256 AND e.lease_owner=OLD.lease_owner
      AND e.lease_generation=OLD.lease_generation AND e.lease_until=OLD.lease_until
      AND e.lease_until > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  ) THEN RAISE(ABORT, 'backup primary closure must seal under its live erasure fence') END);
  SELECT (CASE WHEN
    (SELECT COUNT(*) FROM backup_erasure_primary_claim_pin p WHERE p.erasure_id=OLD.erasure_id AND p.erasure_revision=OLD.erasure_revision AND p.lease_generation=OLD.lease_generation) <> OLD.producer_claim_count OR
    (SELECT COUNT(*) FROM backup_erasure_primary_claim_pin p WHERE p.erasure_id=OLD.erasure_id AND p.erasure_revision=OLD.erasure_revision AND p.lease_generation=OLD.lease_generation AND p.state='COMMITTED') <> OLD.canonical_epoch_count OR
    (SELECT COUNT(*) FROM backup_erasure_primary_cut_pin p WHERE p.erasure_id=OLD.erasure_id AND p.erasure_revision=OLD.erasure_revision AND p.lease_generation=OLD.lease_generation) <> OLD.export_cut_count OR
    (SELECT COUNT(*) FROM backup_erasure_primary_part_pin p WHERE p.erasure_id=OLD.erasure_id AND p.erasure_revision=OLD.erasure_revision AND p.lease_generation=OLD.lease_generation) <> OLD.primary_prefix_object_count OR
    (SELECT COUNT(*) FROM backup_erasure_primary_target_pin p WHERE p.erasure_id=OLD.erasure_id AND p.erasure_revision=OLD.erasure_revision AND p.lease_generation=OLD.lease_generation) <> OLD.target_count OR
    (SELECT COUNT(*) FROM backup_erasure_primary_part_pin p WHERE p.erasure_id=OLD.erasure_id AND p.erasure_revision=OLD.erasure_revision AND p.lease_generation=OLD.lease_generation AND p.is_target_part=1) <> OLD.target_part_count OR
    (SELECT COUNT(*) FROM backup_erasure_primary_delete_item p WHERE p.erasure_id=OLD.erasure_id AND p.erasure_revision=OLD.erasure_revision AND p.lease_generation=OLD.lease_generation) <> OLD.target_part_count
    THEN RAISE(ABORT, 'backup primary closure child pins are incomplete') END);
END;

CREATE TRIGGER backup_erasure_primary_closure_delete_guard
BEFORE DELETE ON backup_erasure_primary_closure
BEGIN
  SELECT RAISE(ABORT, 'backup primary closure history is immutable');
END;

-- A new erasure lease may resume only the exact old SEALED backup plan after
-- a durable primary delete intent exists. The original closure remains
-- immutable; this row grants the new live fence permission to reconcile it.
CREATE TABLE backup_erasure_primary_handoff (
  erasure_id TEXT NOT NULL,
  erasure_revision INTEGER NOT NULL,
  current_lease_generation INTEGER NOT NULL CHECK (current_lease_generation > 0),
  current_lease_owner TEXT NOT NULL,
  current_lease_until INTEGER NOT NULL CHECK (current_lease_until > 0),
  plan_lease_generation INTEGER NOT NULL CHECK (plan_lease_generation > 0),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  erasure_closure_digest TEXT NOT NULL CHECK (length(erasure_closure_digest) = 64 AND erasure_closure_digest NOT GLOB '*[^0-9a-f]*'),
  original_plan_digest TEXT NOT NULL CHECK (length(original_plan_digest) = 64 AND original_plan_digest NOT GLOB '*[^0-9a-f]*'),
  original_target_digest TEXT NOT NULL CHECK (length(original_target_digest) = 64 AND original_target_digest NOT GLOB '*[^0-9a-f]*'),
  original_target_part_digest TEXT NOT NULL CHECK (length(original_target_part_digest) = 64 AND original_target_part_digest NOT GLOB '*[^0-9a-f]*'),
  original_primary_prefix_object_count INTEGER NOT NULL CHECK (original_primary_prefix_object_count >= 0),
  original_primary_prefix_inventory_digest TEXT NOT NULL CHECK (length(original_primary_prefix_inventory_digest) = 64 AND original_primary_prefix_inventory_digest NOT GLOB '*[^0-9a-f]*'),
  original_qualification_receipt_ref TEXT NOT NULL,
  original_qualification_receipt_digest TEXT NOT NULL CHECK (length(original_qualification_receipt_digest) = 64 AND original_qualification_receipt_digest NOT GLOB '*[^0-9a-f]*'),
  current_primary_prefix_object_count INTEGER,
  current_primary_prefix_inventory_digest TEXT CHECK (current_primary_prefix_inventory_digest IS NULL OR
    (length(current_primary_prefix_inventory_digest) = 64 AND current_primary_prefix_inventory_digest NOT GLOB '*[^0-9a-f]*')),
  current_qualification_json TEXT CHECK (current_qualification_json IS NULL OR json_valid(current_qualification_json)),
  current_qualification_digest TEXT CHECK (current_qualification_digest IS NULL OR
    (length(current_qualification_digest) = 64 AND current_qualification_digest NOT GLOB '*[^0-9a-f]*')),
  handoff_digest TEXT CHECK (handoff_digest IS NULL OR (length(handoff_digest) = 64 AND handoff_digest NOT GLOB '*[^0-9a-f]*')),
  state TEXT NOT NULL CHECK (state IN ('PENDING','SEALED')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (erasure_id, erasure_revision, current_lease_generation),
  FOREIGN KEY (erasure_id, erasure_revision, plan_lease_generation)
    REFERENCES backup_erasure_primary_closure(erasure_id, erasure_revision, lease_generation),
  CHECK (plan_lease_generation < current_lease_generation),
  CHECK ((state='PENDING' AND current_primary_prefix_object_count IS NULL AND
      current_primary_prefix_inventory_digest IS NULL AND current_qualification_json IS NULL AND
      current_qualification_digest IS NULL AND handoff_digest IS NULL) OR
    (state='SEALED' AND current_primary_prefix_object_count IS NOT NULL AND current_primary_prefix_object_count >= 0 AND
      current_primary_prefix_inventory_digest IS NOT NULL AND current_qualification_json IS NOT NULL AND
      current_qualification_digest IS NOT NULL AND handoff_digest IS NOT NULL))
) STRICT;

CREATE TRIGGER backup_erasure_primary_handoff_insert_guard
BEFORE INSERT ON backup_erasure_primary_handoff
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM erasure_case c JOIN erasure_execution e
      ON e.erasure_id=c.erasure_id AND e.revision=c.revision
    WHERE c.erasure_id=NEW.erasure_id AND c.revision=NEW.erasure_revision
      AND c.state NOT IN ('COMPLETE','BLOCKED') AND e.state='REQUESTED'
      AND e.request_sha256=NEW.request_sha256 AND e.lease_owner=NEW.current_lease_owner
      AND e.lease_generation=NEW.current_lease_generation AND e.lease_until=NEW.current_lease_until
      AND e.lease_until > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  ) THEN RAISE(ABORT, 'backup plan handoff requires the exact current erasure fence') END);
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM backup_erasure_primary_closure p WHERE p.erasure_id=NEW.erasure_id
      AND p.erasure_revision=NEW.erasure_revision AND p.lease_generation=NEW.plan_lease_generation
      AND p.state='SEALED' AND p.request_sha256=NEW.request_sha256
      AND p.erasure_closure_digest=NEW.erasure_closure_digest AND p.plan_digest=NEW.original_plan_digest
      AND p.target_digest=NEW.original_target_digest AND p.target_part_digest=NEW.original_target_part_digest
      AND p.primary_prefix_object_count=NEW.original_primary_prefix_object_count
      AND p.primary_prefix_inventory_digest=NEW.original_primary_prefix_inventory_digest
      AND p.qualification_receipt_ref=NEW.original_qualification_receipt_ref
      AND p.qualification_receipt_digest=NEW.original_qualification_receipt_digest
  ) THEN RAISE(ABORT, 'backup plan handoff must pin the exact historical sealed closure') END);
  SELECT (CASE WHEN NOT (
    EXISTS (SELECT 1 FROM backup_purge_obligation o
      JOIN backup_erasure_primary_target_pin t ON t.erasure_id=o.erasure_id
        AND t.erasure_revision=o.erasure_revision AND t.target_id=o.target_id
        AND t.lease_generation=NEW.plan_lease_generation AND t.backup_epoch_id=o.backup_epoch_id
      WHERE o.erasure_id=NEW.erasure_id AND o.erasure_revision=NEW.erasure_revision
        AND o.primary_delete_intent_ref IS NOT NULL AND o.primary_delete_intent_digest IS NOT NULL) OR
    EXISTS (SELECT 1 FROM backup_erasure_primary_delete_item d
      WHERE d.erasure_id=NEW.erasure_id AND d.erasure_revision=NEW.erasure_revision
        AND d.lease_generation=NEW.plan_lease_generation AND d.state<>'PINNED'
        AND d.delete_intent_ref IS NOT NULL AND d.delete_intent_digest IS NOT NULL)
  ) THEN RAISE(ABORT, 'backup plan handoff requires a durable exact delete intent') END);
END;

CREATE TRIGGER backup_erasure_primary_handoff_transition_guard
BEFORE UPDATE ON backup_erasure_primary_handoff
BEGIN
  SELECT (CASE WHEN
    NEW.erasure_id IS NOT OLD.erasure_id OR NEW.erasure_revision IS NOT OLD.erasure_revision OR
    NEW.current_lease_generation IS NOT OLD.current_lease_generation OR NEW.current_lease_owner IS NOT OLD.current_lease_owner OR
    NEW.current_lease_until IS NOT OLD.current_lease_until OR NEW.plan_lease_generation IS NOT OLD.plan_lease_generation OR
    NEW.request_sha256 IS NOT OLD.request_sha256 OR NEW.erasure_closure_digest IS NOT OLD.erasure_closure_digest OR
    NEW.original_plan_digest IS NOT OLD.original_plan_digest OR NEW.original_target_digest IS NOT OLD.original_target_digest OR
    NEW.original_target_part_digest IS NOT OLD.original_target_part_digest OR
    NEW.original_primary_prefix_object_count IS NOT OLD.original_primary_prefix_object_count OR
    NEW.original_primary_prefix_inventory_digest IS NOT OLD.original_primary_prefix_inventory_digest OR
    NEW.original_qualification_receipt_ref IS NOT OLD.original_qualification_receipt_ref OR
    NEW.original_qualification_receipt_digest IS NOT OLD.original_qualification_receipt_digest OR
    NEW.created_at IS NOT OLD.created_at OR OLD.state<>'PENDING' OR NEW.state<>'SEALED' OR
    OLD.current_primary_prefix_object_count IS NOT NULL OR OLD.current_primary_prefix_inventory_digest IS NOT NULL OR
    OLD.current_qualification_json IS NOT NULL OR OLD.current_qualification_digest IS NOT NULL OR OLD.handoff_digest IS NOT NULL OR
    NEW.current_primary_prefix_object_count IS NULL OR NEW.current_primary_prefix_inventory_digest IS NULL OR
    NEW.current_qualification_json IS NULL OR NEW.current_qualification_digest IS NULL OR NEW.handoff_digest IS NULL
    THEN RAISE(ABORT, 'backup plan handoff may only seal its current qualification once') END);
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM erasure_execution e WHERE e.erasure_id=NEW.erasure_id AND e.revision=NEW.erasure_revision
      AND e.state='QUARANTINE_AND_REVOKE' AND e.request_sha256=NEW.request_sha256
      AND e.lease_owner=NEW.current_lease_owner AND e.lease_generation=NEW.current_lease_generation
      AND e.lease_until=NEW.current_lease_until
      AND e.lease_until > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  ) THEN RAISE(ABORT, 'backup plan handoff qualification requires the live current erasure fence') END);
END;

CREATE TRIGGER backup_erasure_primary_handoff_delete_guard
BEFORE DELETE ON backup_erasure_primary_handoff
BEGIN
  SELECT RAISE(ABORT, 'backup plan handoff history is immutable');
END;

CREATE VIEW backup_erasure_primary_active_plan AS
SELECT e.erasure_id,e.revision AS erasure_revision,e.state AS execution_state,
  e.lease_owner AS current_lease_owner,e.lease_generation AS current_lease_generation,
  e.lease_until AS current_lease_until,c.lease_generation AS plan_lease_generation,
  c.request_sha256,c.erasure_closure_digest,c.plan_digest
FROM erasure_execution e JOIN backup_erasure_primary_closure c
  ON c.erasure_id=e.erasure_id AND c.erasure_revision=e.revision AND c.lease_generation=e.lease_generation
WHERE c.state='SEALED' AND e.request_sha256=c.request_sha256 AND e.closure_digest=c.erasure_closure_digest
  AND e.lease_owner=c.lease_owner AND e.lease_until=c.lease_until
  AND e.state IN ('PURGE_EACH_LOCATION','VERIFY_ABSENCE_OR_BLOCK','INVALIDATE_DEPENDENTS')
  AND e.lease_until>CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
UNION ALL
SELECT e.erasure_id,e.revision,e.state,e.lease_owner,e.lease_generation,e.lease_until,
  c.lease_generation,c.request_sha256,c.erasure_closure_digest,c.plan_digest
FROM erasure_execution e JOIN backup_erasure_primary_handoff h
  ON h.erasure_id=e.erasure_id AND h.erasure_revision=e.revision
  AND h.current_lease_generation=e.lease_generation AND h.current_lease_owner=e.lease_owner
  AND h.current_lease_until=e.lease_until
JOIN backup_erasure_primary_closure c
  ON c.erasure_id=h.erasure_id AND c.erasure_revision=h.erasure_revision
  AND c.lease_generation=h.plan_lease_generation
WHERE h.state='SEALED' AND h.request_sha256=e.request_sha256
  AND h.erasure_closure_digest=e.closure_digest AND c.state='SEALED'
  AND c.request_sha256=h.request_sha256 AND c.erasure_closure_digest=h.erasure_closure_digest
  AND c.plan_digest=h.original_plan_digest AND c.target_digest=h.original_target_digest
  AND c.target_part_digest=h.original_target_part_digest
  AND c.primary_prefix_object_count=h.original_primary_prefix_object_count
  AND c.primary_prefix_inventory_digest=h.original_primary_prefix_inventory_digest
  AND c.qualification_receipt_ref=h.original_qualification_receipt_ref
  AND c.qualification_receipt_digest=h.original_qualification_receipt_digest
  AND e.state IN ('PURGE_EACH_LOCATION','VERIFY_ABSENCE_OR_BLOCK','INVALIDATE_DEPENDENTS')
  AND e.lease_until>CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);

CREATE TRIGGER backup_erasure_primary_claim_pin_insert_guard
BEFORE INSERT ON backup_erasure_primary_claim_pin
WHEN NOT EXISTS (
  SELECT 1 FROM backup_erasure_primary_closure c WHERE c.erasure_id=NEW.erasure_id
    AND c.erasure_revision=NEW.erasure_revision AND c.lease_generation=NEW.lease_generation AND c.state='BUILDING'
)
BEGIN SELECT RAISE(ABORT, 'backup claim pins require a building closure'); END;
CREATE TRIGGER backup_erasure_primary_claim_pin_update_guard
BEFORE UPDATE ON backup_erasure_primary_claim_pin
BEGIN SELECT RAISE(ABORT, 'backup claim pins are immutable'); END;
CREATE TRIGGER backup_erasure_primary_claim_pin_delete_guard
BEFORE DELETE ON backup_erasure_primary_claim_pin
BEGIN SELECT RAISE(ABORT, 'backup claim pins are immutable'); END;

CREATE TRIGGER backup_erasure_primary_cut_pin_insert_guard
BEFORE INSERT ON backup_erasure_primary_cut_pin
WHEN NOT EXISTS (
  SELECT 1 FROM backup_erasure_primary_closure c WHERE c.erasure_id=NEW.erasure_id
    AND c.erasure_revision=NEW.erasure_revision AND c.lease_generation=NEW.lease_generation AND c.state='BUILDING'
)
BEGIN SELECT RAISE(ABORT, 'backup cut pins require a building closure'); END;
CREATE TRIGGER backup_erasure_primary_cut_pin_update_guard
BEFORE UPDATE ON backup_erasure_primary_cut_pin
BEGIN SELECT RAISE(ABORT, 'backup cut pins are immutable'); END;
CREATE TRIGGER backup_erasure_primary_cut_pin_delete_guard
BEFORE DELETE ON backup_erasure_primary_cut_pin
BEGIN SELECT RAISE(ABORT, 'backup cut pins are immutable'); END;

CREATE TRIGGER backup_erasure_primary_target_pin_insert_guard
BEFORE INSERT ON backup_erasure_primary_target_pin
WHEN NOT EXISTS (
  SELECT 1 FROM backup_erasure_primary_closure c WHERE c.erasure_id=NEW.erasure_id
    AND c.erasure_revision=NEW.erasure_revision AND c.lease_generation=NEW.lease_generation AND c.state='BUILDING'
)
BEGIN SELECT RAISE(ABORT, 'backup target pins require a building closure'); END;
CREATE TRIGGER backup_erasure_primary_target_pin_update_guard
BEFORE UPDATE ON backup_erasure_primary_target_pin
BEGIN SELECT RAISE(ABORT, 'backup target pins are immutable'); END;
CREATE TRIGGER backup_erasure_primary_target_pin_delete_guard
BEFORE DELETE ON backup_erasure_primary_target_pin
BEGIN SELECT RAISE(ABORT, 'backup target pins are immutable'); END;

CREATE TRIGGER backup_erasure_primary_part_pin_insert_guard
BEFORE INSERT ON backup_erasure_primary_part_pin
WHEN NOT EXISTS (
  SELECT 1 FROM backup_erasure_primary_closure c WHERE c.erasure_id=NEW.erasure_id
    AND c.erasure_revision=NEW.erasure_revision AND c.lease_generation=NEW.lease_generation AND c.state='BUILDING'
)
BEGIN SELECT RAISE(ABORT, 'backup part pins require a building closure'); END;
CREATE TRIGGER backup_erasure_primary_part_pin_update_guard
BEFORE UPDATE ON backup_erasure_primary_part_pin
BEGIN SELECT RAISE(ABORT, 'backup part pins are immutable'); END;
CREATE TRIGGER backup_erasure_primary_part_pin_delete_guard
BEFORE DELETE ON backup_erasure_primary_part_pin
BEGIN SELECT RAISE(ABORT, 'backup part pins are immutable'); END;

CREATE TRIGGER backup_erasure_primary_delete_item_insert_guard
BEFORE INSERT ON backup_erasure_primary_delete_item
WHEN NOT EXISTS (
  SELECT 1 FROM backup_erasure_primary_closure c WHERE c.erasure_id=NEW.erasure_id
    AND c.erasure_revision=NEW.erasure_revision AND c.lease_generation=NEW.lease_generation AND c.state='BUILDING'
)
BEGIN SELECT RAISE(ABORT, 'backup delete items require a building closure'); END;
CREATE TRIGGER backup_erasure_primary_delete_item_transition_guard
BEFORE UPDATE ON backup_erasure_primary_delete_item
BEGIN
  SELECT (CASE WHEN
    NEW.erasure_id IS NOT OLD.erasure_id OR NEW.erasure_revision IS NOT OLD.erasure_revision OR
    NEW.lease_generation IS NOT OLD.lease_generation OR NEW.target_id IS NOT OLD.target_id OR
    NEW.part_key IS NOT OLD.part_key OR NEW.updated_at < OLD.updated_at OR
    NEW.delete_intent_ref IS NOT OLD.delete_intent_ref AND OLD.delete_intent_ref IS NOT NULL OR
    NEW.delete_intent_digest IS NOT OLD.delete_intent_digest AND OLD.delete_intent_digest IS NOT NULL OR
    NEW.delete_receipt_ref IS NOT OLD.delete_receipt_ref AND OLD.delete_receipt_ref IS NOT NULL OR
    NEW.absence_receipt_ref IS NOT OLD.absence_receipt_ref AND OLD.absence_receipt_ref IS NOT NULL
    THEN RAISE(ABORT, 'backup primary delete identity is immutable') END);
  SELECT (CASE WHEN NOT (
    (OLD.state='PINNED' AND NEW.state='DELETE_INTENT') OR
    (OLD.state='DELETE_INTENT' AND NEW.state IN ('UNKNOWN','DELETED')) OR
    (OLD.state='UNKNOWN' AND NEW.state IN ('DELETE_INTENT','DELETED')) OR
    (OLD.state='DELETED' AND NEW.state='ABSENT')
  ) THEN RAISE(ABORT, 'invalid backup primary delete transition') END);
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM backup_erasure_primary_active_plan a WHERE a.erasure_id=OLD.erasure_id
      AND a.erasure_revision=OLD.erasure_revision AND a.plan_lease_generation=OLD.lease_generation
      AND a.execution_state IN ('PURGE_EACH_LOCATION','VERIFY_ABSENCE_OR_BLOCK')
  ) THEN RAISE(ABORT, 'backup primary delete transition requires the exact live plan handoff') END);
END;
CREATE TRIGGER backup_erasure_primary_delete_item_delete_guard
BEFORE DELETE ON backup_erasure_primary_delete_item
BEGIN SELECT RAISE(ABORT, 'backup primary delete obligations are immutable'); END;

CREATE TRIGGER backup_purge_primary_receipt_guard
BEFORE UPDATE ON backup_purge_obligation
BEGIN
  SELECT (CASE WHEN
    (NEW.primary_delete_intent_ref IS NULL) <> (NEW.primary_delete_intent_digest IS NULL)
    THEN RAISE(ABORT, 'backup primary intent reference and digest must be paired') END);
  SELECT (CASE WHEN
    NEW.primary_delete_intent_ref IS NOT OLD.primary_delete_intent_ref AND OLD.primary_delete_intent_ref IS NOT NULL OR
    NEW.primary_delete_intent_digest IS NOT OLD.primary_delete_intent_digest AND OLD.primary_delete_intent_digest IS NOT NULL OR
    NEW.primary_delete_receipt_ref IS NOT OLD.primary_delete_receipt_ref AND OLD.primary_delete_receipt_ref IS NOT NULL OR
    NEW.primary_absence_receipt_ref IS NOT OLD.primary_absence_receipt_ref AND OLD.primary_absence_receipt_ref IS NOT NULL OR
    NEW.offsite_delete_receipt_ref IS NOT OLD.offsite_delete_receipt_ref AND OLD.offsite_delete_receipt_ref IS NOT NULL OR
    NEW.offsite_absence_receipt_ref IS NOT OLD.offsite_absence_receipt_ref AND OLD.offsite_absence_receipt_ref IS NOT NULL
    THEN RAISE(ABORT, 'backup purge component receipts are immutable') END);
END;

CREATE TRIGGER backup_purge_primary_obligation_delete_guard
BEFORE DELETE ON backup_purge_obligation
WHEN OLD.primary_delete_intent_ref IS NOT NULL OR EXISTS (
  SELECT 1 FROM backup_erasure_primary_delete_item d
  WHERE d.erasure_id=OLD.erasure_id AND d.erasure_revision=OLD.erasure_revision
    AND d.target_id=OLD.target_id AND d.state<>'PINNED'
)
BEGIN
  SELECT RAISE(ABORT, 'backup purge intent cannot be removed after a primary delete attempt');
END;

CREATE TRIGGER erasure_terminal_guard_exact_fence_insert_guard
BEFORE INSERT ON erasure_terminal_guard
BEGIN
  SELECT (CASE WHEN NEW.lease_owner IS NULL OR NEW.lease_generation IS NULL OR NEW.lease_until IS NULL OR
    NOT EXISTS (
      SELECT 1 FROM erasure_execution e WHERE e.erasure_id=NEW.erasure_id
        AND e.revision=NEW.erasure_revision AND e.state='INVALIDATE_DEPENDENTS'
        AND e.closure_digest=NEW.closure_digest AND e.lease_owner=NEW.lease_owner
        AND e.lease_generation=NEW.lease_generation AND e.lease_until=NEW.lease_until
        AND e.lease_until > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    )
  THEN RAISE(ABORT, 'terminal guard requires the exact unexpired invalidation fence') END);
END;

CREATE TRIGGER erasure_execution_backup_primary_complete_guard
BEFORE UPDATE OF state ON erasure_execution
WHEN NEW.state='COMPLETE' AND EXISTS (
  SELECT 1 FROM erasure_target t WHERE t.erasure_id=NEW.erasure_id AND t.erasure_revision=NEW.revision
    AND t.location='BackupRestorePath'
)
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM backup_erasure_primary_active_plan a JOIN backup_erasure_primary_closure c
      ON c.erasure_id=a.erasure_id AND c.erasure_revision=a.erasure_revision
      AND c.lease_generation=a.plan_lease_generation
    WHERE a.erasure_id=NEW.erasure_id AND a.erasure_revision=NEW.revision
      AND a.current_lease_generation=OLD.lease_generation AND a.current_lease_owner=OLD.lease_owner
      AND a.current_lease_until=OLD.lease_until AND a.execution_state='INVALIDATE_DEPENDENTS'
      AND c.request_sha256=NEW.request_sha256 AND c.erasure_closure_digest=NEW.closure_digest AND c.state='SEALED'
  ) THEN RAISE(ABORT, 'backup completion requires a sealed primary closure under the current lease') END);
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM erasure_terminal_guard g WHERE g.erasure_id=NEW.erasure_id
      AND g.erasure_revision=NEW.revision AND g.closure_digest=NEW.closure_digest
      AND g.receipt_sha256=NEW.terminal_receipt_sha256 AND g.terminal_state='COMPLETE'
      AND g.lease_owner=OLD.lease_owner AND g.lease_generation=OLD.lease_generation
      AND g.lease_until=OLD.lease_until
  ) THEN RAISE(ABORT, 'backup completion requires a terminal guard bound to the current lease') END);
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM erasure_target t
    LEFT JOIN backup_erasure_primary_active_plan a ON a.erasure_id=t.erasure_id
      AND a.erasure_revision=t.erasure_revision AND a.current_lease_generation=NEW.lease_generation
    LEFT JOIN backup_erasure_primary_target_pin p ON p.erasure_id=t.erasure_id
      AND p.erasure_revision=t.erasure_revision AND p.lease_generation=a.plan_lease_generation AND p.target_id=t.target_id
    LEFT JOIN backup_purge_obligation o ON o.erasure_id=t.erasure_id
      AND o.erasure_revision=t.erasure_revision AND o.target_id=t.target_id AND o.backup_epoch_id=p.backup_epoch_id
    WHERE t.erasure_id=NEW.erasure_id AND t.erasure_revision=NEW.revision AND t.location='BackupRestorePath'
      AND (p.target_id IS NULL OR p.identity_digest<>t.identity_digest OR t.canonical_ref<>'backup:'||p.backup_epoch_id
        OR o.state<>'ABSENT' OR o.delete_receipt_ref IS NULL OR o.absence_receipt_ref IS NULL
        OR o.primary_delete_intent_ref IS NULL OR o.primary_delete_intent_digest IS NULL
        OR o.primary_delete_receipt_ref IS NULL OR o.primary_absence_receipt_ref IS NULL
        OR o.offsite_delete_receipt_ref IS NULL OR o.offsite_absence_receipt_ref IS NULL)
  ) THEN RAISE(ABORT, 'backup completion requires exact primary and offsite absence receipts') END);
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM backup_erasure_primary_delete_item d WHERE d.erasure_id=NEW.erasure_id
      AND d.erasure_revision=NEW.revision AND d.lease_generation=(SELECT a.plan_lease_generation
        FROM backup_erasure_primary_active_plan a WHERE a.erasure_id=NEW.erasure_id
          AND a.erasure_revision=NEW.revision AND a.current_lease_generation=NEW.lease_generation LIMIT 1)
      AND d.state<>'ABSENT'
  ) THEN RAISE(ABORT, 'backup completion requires absence for every pinned primary part') END);
  SELECT (CASE WHEN (SELECT COUNT(*) FROM backup_erasure_primary_target_pin p
      WHERE p.erasure_id=NEW.erasure_id AND p.erasure_revision=NEW.revision AND p.lease_generation=(
        SELECT a.plan_lease_generation FROM backup_erasure_primary_active_plan a WHERE a.erasure_id=NEW.erasure_id
          AND a.erasure_revision=NEW.revision AND a.current_lease_generation=NEW.lease_generation LIMIT 1))
    <> (SELECT COUNT(*) FROM erasure_target t WHERE t.erasure_id=NEW.erasure_id
      AND t.erasure_revision=NEW.revision AND t.location='BackupRestorePath')
    THEN RAISE(ABORT, 'backup completion requires exact target coverage') END);
END;

CREATE TRIGGER erasure_terminal_guard_backup_primary_insert_guard
BEFORE INSERT ON erasure_terminal_guard
WHEN NEW.terminal_state='COMPLETE' AND EXISTS (
  SELECT 1 FROM erasure_target t WHERE t.erasure_id=NEW.erasure_id AND t.erasure_revision=NEW.erasure_revision
    AND t.location='BackupRestorePath'
)
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1 FROM backup_erasure_primary_active_plan a JOIN backup_erasure_primary_closure c
      ON c.erasure_id=a.erasure_id AND c.erasure_revision=a.erasure_revision
      AND c.lease_generation=a.plan_lease_generation
    WHERE a.erasure_id=NEW.erasure_id AND a.erasure_revision=NEW.erasure_revision
      AND a.execution_state='INVALIDATE_DEPENDENTS' AND a.request_sha256=c.request_sha256
      AND c.state='SEALED' AND c.erasure_closure_digest=NEW.closure_digest
      AND NEW.closure_digest=a.erasure_closure_digest AND NEW.lease_owner=a.current_lease_owner
      AND NEW.lease_generation=a.current_lease_generation AND NEW.lease_until=a.current_lease_until
  ) THEN RAISE(ABORT, 'backup terminal guard requires the sealed current primary closure and lease') END);
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM erasure_target t
    LEFT JOIN backup_purge_obligation o ON o.erasure_id=t.erasure_id
      AND o.erasure_revision=t.erasure_revision AND o.target_id=t.target_id
    LEFT JOIN backup_erasure_primary_active_plan a ON a.erasure_id=t.erasure_id
      AND a.erasure_revision=t.erasure_revision AND a.current_lease_generation=NEW.lease_generation
    LEFT JOIN backup_erasure_primary_target_pin p ON p.erasure_id=t.erasure_id
      AND p.erasure_revision=t.erasure_revision AND p.lease_generation=a.plan_lease_generation AND p.target_id=t.target_id
    WHERE t.erasure_id=NEW.erasure_id AND t.erasure_revision=NEW.erasure_revision
      AND t.location='BackupRestorePath' AND (o.target_id IS NULL OR o.state<>'ABSENT' OR o.primary_delete_receipt_ref IS NULL
        OR o.primary_absence_receipt_ref IS NULL OR o.offsite_delete_receipt_ref IS NULL
        OR o.offsite_absence_receipt_ref IS NULL OR p.target_id IS NULL OR p.identity_digest<>t.identity_digest
        OR t.canonical_ref<>'backup:'||p.backup_epoch_id)
  ) THEN RAISE(ABORT, 'backup terminal guard requires component absence receipts') END);
  SELECT (CASE WHEN EXISTS (
    SELECT 1 FROM backup_erasure_primary_delete_item d WHERE d.erasure_id=NEW.erasure_id
      AND d.erasure_revision=NEW.erasure_revision AND d.lease_generation=(SELECT a.plan_lease_generation
        FROM backup_erasure_primary_active_plan a WHERE a.erasure_id=NEW.erasure_id
          AND a.erasure_revision=NEW.erasure_revision AND a.current_lease_generation=NEW.lease_generation LIMIT 1)
      AND d.state<>'ABSENT'
  ) THEN RAISE(ABORT, 'backup terminal guard requires absence for every pinned primary part') END);
  SELECT (CASE WHEN (SELECT COUNT(*) FROM backup_erasure_primary_target_pin p
      WHERE p.erasure_id=NEW.erasure_id AND p.erasure_revision=NEW.erasure_revision AND p.lease_generation=(
        SELECT a.plan_lease_generation FROM backup_erasure_primary_active_plan a WHERE a.erasure_id=NEW.erasure_id
          AND a.erasure_revision=NEW.erasure_revision AND a.current_lease_generation=NEW.lease_generation LIMIT 1))
    <> (SELECT COUNT(*) FROM erasure_target t WHERE t.erasure_id=NEW.erasure_id
      AND t.erasure_revision=NEW.erasure_revision AND t.location='BackupRestorePath')
    THEN RAISE(ABORT, 'backup terminal guard requires exact target coverage') END);
END;
