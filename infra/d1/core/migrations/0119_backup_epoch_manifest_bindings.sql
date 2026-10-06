-- Canonical, content-addressed references for the portable backup epoch.
-- PENDING is publication only; this migration contains no writer that can
-- claim restore verification or authorize erasure closure.
-- D1 native parser compatibility: parenthesize trigger CASE guards (workers-sdk#4727).
PRAGMA foreign_keys = ON;

CREATE TABLE backup_epoch_manifest_binding (
  backup_epoch_id TEXT NOT NULL REFERENCES backup_epoch(backup_epoch_id),
  role TEXT NOT NULL CHECK (role IN (
    'CORE_EXPORT','SEARCH_REBUILD_PLAN','EVIDENCE_R2_SUBSET','WORK_R2_SUBSET'
  )),
  binding_ref TEXT NOT NULL UNIQUE,
  descriptor_sha256 TEXT NOT NULL CHECK (
    length(descriptor_sha256) = 64 AND descriptor_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  descriptor_json TEXT NOT NULL CHECK (json_valid(descriptor_json)),
  source_draft_sha256 TEXT NOT NULL CHECK (
    length(source_draft_sha256) = 64 AND source_draft_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  offsite_copy_id TEXT NOT NULL REFERENCES backup_offsite_copy_receipt(copy_id),
  offsite_readback_digest TEXT NOT NULL CHECK (
    length(offsite_readback_digest) = 64 AND offsite_readback_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (backup_epoch_id, role),
  CHECK (binding_ref = 'sha256:' || descriptor_sha256),
  CHECK (json_extract(descriptor_json, '$.protocol') = 'eliotr.backup-epoch-manifest-binding.v1'),
  CHECK (json_extract(descriptor_json, '$.backup_epoch_id') = backup_epoch_id),
  CHECK (json_extract(descriptor_json, '$.role') = role),
  CHECK (json_extract(descriptor_json, '$.source.draft_sha256') = source_draft_sha256),
  CHECK (json_extract(descriptor_json, '$.offsite.copy_id') = offsite_copy_id),
  CHECK (json_extract(descriptor_json, '$.offsite.readback_digest') = offsite_readback_digest)
) STRICT;

CREATE INDEX backup_epoch_manifest_binding_source
  ON backup_epoch_manifest_binding(backup_epoch_id, source_draft_sha256, offsite_copy_id);

CREATE TABLE backup_epoch_verification_receipt (
  receipt_ref TEXT PRIMARY KEY,
  receipt_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(receipt_sha256) = 64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  backup_epoch_id TEXT NOT NULL UNIQUE REFERENCES backup_epoch(backup_epoch_id),
  outcome TEXT NOT NULL CHECK (outcome IN ('VERIFIED','FAILED')),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  binding_set_sha256 TEXT NOT NULL CHECK (
    length(binding_set_sha256) = 64 AND binding_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  core_export_ref TEXT NOT NULL,
  search_projection_manifest_ref TEXT NOT NULL,
  evidence_manifest_ref TEXT NOT NULL,
  work_manifest_ref TEXT NOT NULL,
  source_draft_sha256 TEXT NOT NULL CHECK (
    length(source_draft_sha256) = 64 AND source_draft_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  offsite_copy_id TEXT NOT NULL REFERENCES backup_offsite_copy_receipt(copy_id),
  offsite_copy_ref TEXT NOT NULL,
  offsite_readback_digest TEXT NOT NULL CHECK (
    length(offsite_readback_digest) = 64 AND offsite_readback_digest NOT GLOB '*[^0-9a-f]*'
  ),
  destination_id TEXT NOT NULL,
  key_generation TEXT NOT NULL,
  policy_digest TEXT NOT NULL CHECK (
    length(policy_digest) = 64 AND policy_digest NOT GLOB '*[^0-9a-f]*'
  ),
  purge_ledger_revision INTEGER NOT NULL CHECK (purge_ledger_revision >= 0),
  purge_ledger_digest TEXT NOT NULL CHECK (
    length(purge_ledger_digest) = 64 AND purge_ledger_digest NOT GLOB '*[^0-9a-f]*'
  ),
  primary_inventory_object_count INTEGER NOT NULL CHECK (primary_inventory_object_count >= 0),
  primary_inventory_digest TEXT NOT NULL CHECK (
    length(primary_inventory_digest) = 64 AND primary_inventory_digest NOT GLOB '*[^0-9a-f]*'
  ),
  producer_claim_count INTEGER NOT NULL CHECK (producer_claim_count >= 0),
  producer_claims_digest TEXT NOT NULL CHECK (
    length(producer_claims_digest) = 64 AND producer_claims_digest NOT GLOB '*[^0-9a-f]*'
  ),
  canonical_epoch_count INTEGER NOT NULL CHECK (canonical_epoch_count >= 0),
  canonical_epochs_digest TEXT NOT NULL CHECK (
    length(canonical_epochs_digest) = 64 AND canonical_epochs_digest NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  CHECK (receipt_ref = 'sha256:' || receipt_sha256),
  CHECK (json_extract(receipt_json, '$.protocol') = 'eliotr.backup-epoch-verification-receipt.v1'),
  CHECK (json_extract(receipt_json, '$.receipt_ref') = receipt_ref),
  CHECK (json_extract(receipt_json, '$.outcome') = outcome),
  CHECK (json_extract(receipt_json, '$.backup_epoch_id') = backup_epoch_id),
  CHECK (json_extract(receipt_json, '$.binding_set_sha256') = binding_set_sha256),
  CHECK (json_extract(receipt_json, '$.source.draft_sha256') = source_draft_sha256),
  CHECK (json_extract(receipt_json, '$.offsite.copy_id') = offsite_copy_id),
  CHECK (json_extract(receipt_json, '$.offsite.copy_ref') = offsite_copy_ref),
  CHECK (json_extract(receipt_json, '$.offsite.readback_digest') = offsite_readback_digest),
  CHECK (json_extract(receipt_json, '$.offsite.destination_id') = destination_id),
  CHECK (json_extract(receipt_json, '$.offsite.key_generation') = key_generation),
  CHECK (json_extract(receipt_json, '$.offsite.policy_digest') = policy_digest),
  CHECK (json_extract(receipt_json, '$.bindings.core_export_ref') = core_export_ref),
  CHECK (json_extract(receipt_json, '$.bindings.search_projection_manifest_ref') = search_projection_manifest_ref),
  CHECK (json_extract(receipt_json, '$.bindings.evidence_manifest_ref') = evidence_manifest_ref),
  CHECK (json_extract(receipt_json, '$.bindings.work_manifest_ref') = work_manifest_ref),
  CHECK (json_extract(receipt_json, '$.purge.ledger_revision') = purge_ledger_revision),
  CHECK (json_extract(receipt_json, '$.purge.ledger_digest') = purge_ledger_digest),
  CHECK (json_extract(receipt_json, '$.primary_inventory.object_count') = primary_inventory_object_count),
  CHECK (json_extract(receipt_json, '$.primary_inventory.inventory_digest') = primary_inventory_digest),
  CHECK (json_extract(receipt_json, '$.producer.claim_count') = producer_claim_count),
  CHECK (json_extract(receipt_json, '$.producer.claims_digest') = producer_claims_digest),
  CHECK (json_extract(receipt_json, '$.producer.canonical_epoch_count') = canonical_epoch_count),
  CHECK (json_extract(receipt_json, '$.producer.canonical_epochs_digest') = canonical_epochs_digest)
) STRICT;

CREATE TRIGGER backup_epoch_manifest_binding_insert_guard
BEFORE INSERT ON backup_epoch_manifest_binding
WHEN NOT EXISTS (
  SELECT 1 FROM backup_epoch AS e
  JOIN backup_offsite_copy_receipt AS c
    ON c.copy_id = NEW.offsite_copy_id
   AND c.epoch_id = e.backup_epoch_id
   AND c.readback_digest = NEW.offsite_readback_digest
   AND json_extract(c.epoch_json, '$.offsite_copy_ref') = e.offsite_copy_ref
  WHERE e.backup_epoch_id = NEW.backup_epoch_id
    AND e.verification_state = 'PENDING'
    AND NEW.binding_ref = CASE NEW.role
      WHEN 'CORE_EXPORT' THEN e.core_export_ref
      WHEN 'SEARCH_REBUILD_PLAN' THEN e.search_projection_manifest_ref
      WHEN 'EVIDENCE_R2_SUBSET' THEN e.evidence_manifest_ref
      WHEN 'WORK_R2_SUBSET' THEN e.work_manifest_ref
    END
    AND json_extract(NEW.descriptor_json, '$.offsite.copy_ref') = e.offsite_copy_ref
    AND json_extract(NEW.descriptor_json, '$.purge.ledger_revision') = e.purge_ledger_revision
    AND (NEW.role <> 'SEARCH_REBUILD_PLAN' OR (
      json_extract(NEW.descriptor_json, '$.coverage.status') = 'REBUILD_REQUIRED' AND
      json_extract(NEW.descriptor_json, '$.coverage.snapshot_present') = 0
    ))
    AND (NEW.role <> 'EVIDENCE_R2_SUBSET' OR json_extract(NEW.descriptor_json, '$.coverage.bucket') = 'evidence')
    AND (NEW.role <> 'WORK_R2_SUBSET' OR json_extract(NEW.descriptor_json, '$.coverage.bucket') = 'work')
)
BEGIN
  SELECT RAISE(ABORT, 'backup manifest binding does not match its pending epoch and persisted copy');
END;

CREATE TRIGGER backup_epoch_manifest_binding_immutable_update
BEFORE UPDATE ON backup_epoch_manifest_binding
BEGIN SELECT RAISE(ABORT, 'backup epoch manifest bindings are immutable'); END;

CREATE TRIGGER backup_epoch_manifest_binding_immutable_delete
BEFORE DELETE ON backup_epoch_manifest_binding
BEGIN SELECT RAISE(ABORT, 'backup epoch manifest bindings are immutable'); END;

CREATE TRIGGER backup_epoch_verification_receipt_insert_guard
BEFORE INSERT ON backup_epoch_verification_receipt
WHEN NOT EXISTS (
  SELECT 1 FROM backup_epoch AS e
  JOIN backup_offsite_copy_receipt AS c
    ON c.copy_id = NEW.offsite_copy_id
   AND c.epoch_id = e.backup_epoch_id
   AND c.readback_digest = NEW.offsite_readback_digest
   AND c.destination_id = NEW.destination_id
   AND c.key_generation = NEW.key_generation
   AND c.policy_digest = NEW.policy_digest
   AND json_extract(c.epoch_json, '$.offsite_copy_ref') = e.offsite_copy_ref
  WHERE e.backup_epoch_id = NEW.backup_epoch_id
    AND e.verification_state = 'PENDING'
    AND e.core_export_ref = NEW.core_export_ref
    AND e.search_projection_manifest_ref = NEW.search_projection_manifest_ref
    AND e.evidence_manifest_ref = NEW.evidence_manifest_ref
    AND e.work_manifest_ref = NEW.work_manifest_ref
    AND e.offsite_copy_ref = NEW.offsite_copy_ref
    AND e.purge_ledger_revision = NEW.purge_ledger_revision
    AND (SELECT COUNT(*) FROM backup_epoch_manifest_binding AS b WHERE b.backup_epoch_id = e.backup_epoch_id) = 4
    AND NOT EXISTS (
      SELECT 1 FROM backup_epoch_manifest_binding AS b
      WHERE b.backup_epoch_id = e.backup_epoch_id
        AND (b.source_draft_sha256 <> NEW.source_draft_sha256 OR
             b.offsite_copy_id <> NEW.offsite_copy_id OR
             b.offsite_readback_digest <> NEW.offsite_readback_digest)
    )
    AND NEW.offsite_copy_ref = json_extract(c.epoch_json, '$.offsite_copy_ref')
)
BEGIN
  SELECT RAISE(ABORT, 'backup verification receipt does not bind the exact pending epoch, descriptors and copy');
END;

CREATE TRIGGER backup_epoch_verification_receipt_immutable_update
BEFORE UPDATE ON backup_epoch_verification_receipt
BEGIN SELECT RAISE(ABORT, 'backup verification receipts are immutable'); END;

CREATE TRIGGER backup_epoch_verification_receipt_immutable_delete
BEFORE DELETE ON backup_epoch_verification_receipt
BEGIN SELECT RAISE(ABORT, 'backup verification receipts are immutable'); END;

CREATE TRIGGER backup_epoch_manifest_publication_guard
BEFORE INSERT ON backup_epoch
WHEN NEW.verification_state <> 'PENDING'
  OR NEW.verified_at IS NOT NULL
  OR length(NEW.core_export_ref) <> 71 OR substr(NEW.core_export_ref, 1, 7) <> 'sha256:' OR substr(NEW.core_export_ref, 8) GLOB '*[^0-9a-f]*'
  OR length(NEW.search_projection_manifest_ref) <> 71 OR substr(NEW.search_projection_manifest_ref, 1, 7) <> 'sha256:' OR substr(NEW.search_projection_manifest_ref, 8) GLOB '*[^0-9a-f]*'
  OR length(NEW.evidence_manifest_ref) <> 71 OR substr(NEW.evidence_manifest_ref, 1, 7) <> 'sha256:' OR substr(NEW.evidence_manifest_ref, 8) GLOB '*[^0-9a-f]*'
  OR length(NEW.work_manifest_ref) <> 71 OR substr(NEW.work_manifest_ref, 1, 7) <> 'sha256:' OR substr(NEW.work_manifest_ref, 8) GLOB '*[^0-9a-f]*'
  OR NOT EXISTS (
    SELECT 1 FROM backup_offsite_copy_receipt AS c
    WHERE c.epoch_id = NEW.backup_epoch_id
      AND json_extract(c.epoch_json, '$.offsite_copy_ref') = NEW.offsite_copy_ref
  )
BEGIN
  SELECT RAISE(ABORT, 'canonical backup epochs must begin PENDING with four content-addressed references and a persisted offsite receipt');
END;

CREATE TRIGGER backup_epoch_manifest_identity_guard
BEFORE UPDATE ON backup_epoch
BEGIN
  SELECT (CASE WHEN
    NEW.backup_epoch_id IS NOT OLD.backup_epoch_id OR
    NEW.core_export_ref IS NOT OLD.core_export_ref OR
    NEW.search_projection_manifest_ref IS NOT OLD.search_projection_manifest_ref OR
    NEW.evidence_manifest_ref IS NOT OLD.evidence_manifest_ref OR
    NEW.work_manifest_ref IS NOT OLD.work_manifest_ref OR
    NEW.offsite_copy_ref IS NOT OLD.offsite_copy_ref OR
    NEW.purge_ledger_revision IS NOT OLD.purge_ledger_revision OR
    NEW.created_at IS NOT OLD.created_at
    THEN RAISE(ABORT, 'canonical backup epoch identity is immutable') END);

  SELECT (CASE WHEN NOT (
    (OLD.verification_state = 'PENDING' AND NEW.verification_state IN ('VERIFIED','FAILED')) OR
    (OLD.verification_state = NEW.verification_state AND OLD.verified_at IS NEW.verified_at)
  ) THEN RAISE(ABORT, 'invalid canonical backup epoch verification transition') END);

  SELECT (CASE WHEN OLD.verification_state = 'PENDING' AND NEW.verification_state IN ('VERIFIED','FAILED') AND NOT EXISTS (
    SELECT 1 FROM backup_epoch_verification_receipt AS r
    WHERE r.backup_epoch_id = OLD.backup_epoch_id
      AND r.outcome = NEW.verification_state
      AND r.core_export_ref = OLD.core_export_ref
      AND r.search_projection_manifest_ref = OLD.search_projection_manifest_ref
      AND r.evidence_manifest_ref = OLD.evidence_manifest_ref
      AND r.work_manifest_ref = OLD.work_manifest_ref
      AND r.offsite_copy_ref = OLD.offsite_copy_ref
      AND r.purge_ledger_revision = OLD.purge_ledger_revision
      AND r.created_at = CASE WHEN NEW.verification_state = 'VERIFIED' THEN NEW.verified_at ELSE r.created_at END
      AND (NEW.verification_state <> 'FAILED' OR NEW.verified_at IS NULL)
  ) THEN RAISE(ABORT, 'canonical backup epoch transition requires its exact immutable verification receipt') END);
END;

CREATE TRIGGER backup_epoch_immutable_delete
BEFORE DELETE ON backup_epoch
BEGIN SELECT RAISE(ABORT, 'canonical backup epoch history is immutable'); END;
