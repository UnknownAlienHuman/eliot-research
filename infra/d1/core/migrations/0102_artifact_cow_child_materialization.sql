-- Link the existing draft reservation to one admitted COW attempt. The original
-- REPORT intent/outbox and W2 request bytes are never updated or repurposed.
ALTER TABLE artifact_draft_reservation ADD COLUMN cow_operation_id TEXT
  REFERENCES artifact_section_revise_run(operation_id);
ALTER TABLE artifact_draft_reservation ADD COLUMN cow_attempt_ref TEXT
  REFERENCES artifact_section_revise_attempt(attempt_ref);
ALTER TABLE artifact_draft_reservation ADD COLUMN cow_request_sha256 TEXT
  CHECK ((cow_operation_id IS NULL AND cow_attempt_ref IS NULL AND cow_request_sha256 IS NULL)
    OR (cow_operation_id IS NOT NULL AND cow_attempt_ref IS NOT NULL AND cow_request_sha256 IS NOT NULL
      AND length(cow_request_sha256)=64 AND cow_request_sha256 NOT GLOB '*[^0-9a-f]*'));
CREATE UNIQUE INDEX artifact_draft_reservation_cow_attempt
  ON artifact_draft_reservation(cow_operation_id,cow_attempt_ref)
  WHERE cow_operation_id IS NOT NULL;

CREATE TRIGGER artifact_draft_reservation_cow_insert_guard
BEFORE INSERT ON artifact_draft_reservation
WHEN NEW.cow_operation_id IS NOT NULL OR NEW.cow_attempt_ref IS NOT NULL OR NEW.cow_request_sha256 IS NOT NULL
BEGIN SELECT RAISE(ABORT,'ARTIFACT_COW_CHILD_BINDING_INVALID'); END;

-- The existing writer appends this binding through its admission bridge, after
-- child intent/outbox insert and before child artifact/head CAS in one batch.
CREATE TRIGGER artifact_draft_reservation_cow_binding_guard
BEFORE UPDATE OF cow_operation_id,cow_attempt_ref,cow_request_sha256 ON artifact_draft_reservation
BEGIN
  SELECT RAISE(ABORT,'ARTIFACT_COW_CHILD_BINDING_INVALID')
  WHERE OLD.cow_operation_id IS NOT NULL
    OR OLD.state IS NOT 'RESERVED' OR NEW.state IS NOT 'RESERVED'
    OR NEW.cow_operation_id IS NULL OR NEW.cow_attempt_ref IS NULL OR NEW.cow_request_sha256 IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM artifact_section_revise_current c
      JOIN artifact_section_revise_attempt attempt
        ON attempt.operation_id=c.operation_id AND attempt.attempt_ref=c.current_attempt_ref
      JOIN artifact_draft_binding parent
        ON (parent.artifact_id,parent.revision)=(c.artifact_id,c.parent_revision)
      JOIN operation_intent original
        ON (original.intent_id,original.revision)=(c.report_intent_id,c.report_intent_revision)
      JOIN operation_intent child
        ON (child.intent_id,child.revision)=(NEW.intent_id,NEW.intent_revision)
      JOIN outbox child_outbox
        ON (child_outbox.intent_id,child_outbox.intent_revision)=(child.intent_id,child.revision)
      WHERE c.operation_id=NEW.cow_operation_id AND attempt.attempt_ref=NEW.cow_attempt_ref
        AND attempt.request_sha256=NEW.cow_request_sha256 AND attempt.state='OUTPUT_RECORDED'
        AND attempt.output_json IS NOT NULL AND unixepoch('now')*1000<attempt.budget_expires_at_ms
        AND NEW.artifact_id=c.artifact_id AND NEW.artifact_revision=c.parent_revision+1
        AND NEW.expected_head_revision=c.parent_revision AND NEW.spec_digest=c.spec_digest
        AND (NEW.spec_ref_id,NEW.spec_ref_revision)=(parent.spec_ref_id,parent.spec_ref_revision)
        AND (NEW.scope_snapshot_id,NEW.scope_snapshot_revision)=(parent.scope_snapshot_id,parent.scope_snapshot_revision)
        AND NEW.principal_ref=c.principal_ref AND child.principal_ref=c.principal_ref
        AND child.operation_kind='REPORT' AND child.intent_id<>original.intent_id
        AND child.policy_decision_ref=original.policy_decision_ref
        AND child_outbox.topic=NEW.topic
        AND (SELECT COUNT(*) FROM json_each(NEW.planned_objects_json) item
             WHERE json_extract(item.value,'$.object_kind')='MANIFEST')=1
        AND child_outbox.payload_sha256=(SELECT json_extract(item.value,'$.sha256')
          FROM json_each(NEW.planned_objects_json) item WHERE json_extract(item.value,'$.object_kind')='MANIFEST')
    );
END;

-- The manifest assembled by the unchanged writer must retain historical
-- spec/freeze/scope, while execution permission belongs to the separate COW run.
CREATE TRIGGER artifact_draft_binding_cow_child_guard
BEFORE INSERT ON artifact_draft_binding
WHEN EXISTS (SELECT 1 FROM artifact_draft_reservation reservation
  WHERE (reservation.intent_id,reservation.intent_revision)=(NEW.intent_id,NEW.intent_revision)
    AND reservation.cow_operation_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT,'ARTIFACT_COW_CHILD_BINDING_INVALID') WHERE NOT EXISTS (
    SELECT 1 FROM artifact_draft_reservation reservation
    JOIN artifact_section_revise_run run ON run.operation_id=reservation.cow_operation_id
    JOIN artifact_section_revise_attempt attempt ON attempt.operation_id=run.operation_id
      AND attempt.attempt_ref=reservation.cow_attempt_ref AND attempt.request_sha256=reservation.cow_request_sha256
    JOIN artifact_draft_binding parent ON (parent.artifact_id,parent.revision)=(run.artifact_id,run.parent_revision)
    JOIN artifact_revision child ON (child.artifact_id,child.revision)=(NEW.artifact_id,NEW.revision)
    JOIN outbox child_outbox ON (child_outbox.intent_id,child_outbox.intent_revision)=(NEW.intent_id,NEW.intent_revision)
    WHERE (reservation.intent_id,reservation.intent_revision)=(NEW.intent_id,NEW.intent_revision)
      AND reservation.state='RESERVED' AND attempt.state='OUTPUT_RECORDED'
      AND (NEW.artifact_id,NEW.revision,NEW.expected_head_revision)=(run.artifact_id,run.parent_revision+1,run.parent_revision)
      AND (NEW.scope_snapshot_id,NEW.scope_snapshot_revision)=(parent.scope_snapshot_id,parent.scope_snapshot_revision)
      AND (NEW.spec_ref_id,NEW.spec_ref_revision)=(parent.spec_ref_id,parent.spec_ref_revision)
      AND child.status='DRAFT' AND child.spec_digest=reservation.spec_digest
      AND child.evidence_freeze_id=json_extract(run.request_json,'$.evidence_freeze_ref.id')
      AND child.evidence_freeze_revision=json_extract(run.request_json,'$.evidence_freeze_ref.revision')
      AND NEW.principal_ref=run.principal_ref AND NEW.manifest_sha256=child_outbox.payload_sha256
      AND NEW.manifest_r2_key=reservation.manifest_r2_key
  );
END;

-- Forward-only replacement of 0100's readback guard: a finalized child remains
-- the exact effect of this W2 even after another writer advances the head.
-- No new draft/model effect is admitted by this reconciliation transition.
DROP TRIGGER artifact_section_revise_attempt_commit_readback;
CREATE TRIGGER artifact_section_revise_attempt_commit_readback
BEFORE UPDATE OF state ON artifact_section_revise_attempt
WHEN NEW.state='COMMITTED'
BEGIN
  SELECT RAISE(ABORT,'ARTIFACT_COW_DRAFT_READBACK_INVALID') WHERE NOT EXISTS (
    SELECT 1 FROM artifact_section_revise_run run
    JOIN artifact_revision child ON child.artifact_id=run.artifact_id AND child.revision=run.parent_revision+1 AND child.status='DRAFT'
    JOIN artifact_draft_head head ON head.artifact_id=child.artifact_id AND head.head_revision>=child.revision
    JOIN artifact_draft_binding parent_binding ON parent_binding.artifact_id=run.artifact_id AND parent_binding.revision=run.parent_revision
    JOIN artifact_draft_binding child_binding ON child_binding.artifact_id=child.artifact_id AND child_binding.revision=child.revision
    JOIN artifact_draft_reservation reservation
      ON (reservation.intent_id,reservation.intent_revision)=(child_binding.intent_id,child_binding.intent_revision)
      AND reservation.cow_operation_id=NEW.operation_id AND reservation.cow_attempt_ref=NEW.attempt_ref
      AND reservation.cow_request_sha256=NEW.request_sha256 AND reservation.state='FINALIZED'
    JOIN artifact_draft_object manifest ON manifest.artifact_id=child.artifact_id AND manifest.revision=child.revision AND manifest.object_kind='MANIFEST'
    WHERE run.operation_id=NEW.operation_id AND run.current_attempt_ref=NEW.attempt_ref
      AND json_extract(NEW.output_json,'$.draft.artifact_ref.id')=child.artifact_id
      AND json_extract(NEW.output_json,'$.draft.artifact_ref.revision')=child.revision
      AND child.spec_digest=json_extract(run.request_json,'$.spec_digest')
      AND child.evidence_freeze_id=json_extract(run.request_json,'$.evidence_freeze_ref.id')
      AND child.evidence_freeze_revision=json_extract(run.request_json,'$.evidence_freeze_ref.revision')
      AND child_binding.scope_snapshot_id=parent_binding.scope_snapshot_id
      AND child_binding.scope_snapshot_revision=parent_binding.scope_snapshot_revision
      AND child_binding.principal_ref=run.principal_ref
      AND child_binding.manifest_sha256=json_extract(NEW.output_json,'$.draft.manifest_sha256')
      AND json_extract(manifest.receipt_json,'$.expected_sha256')=json_extract(NEW.output_json,'$.draft.manifest_sha256')
      AND json_extract(manifest.receipt_json,'$.readback_sha256')=json_extract(NEW.output_json,'$.draft.manifest_sha256')
  );
END;
