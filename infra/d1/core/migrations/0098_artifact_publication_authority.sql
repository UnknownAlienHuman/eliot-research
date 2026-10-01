-- ER-11 immutable publication authority for an exact verified DRAFT revision.
-- Keep artifact_draft_* rows and their DRAFT manifest objects immutable.
-- Intent/attempt/receipt/outbox use canonical operation_* tables; this stores publication authority only.
PRAGMA foreign_keys = ON;

CREATE TABLE artifact_publication_receipt (
  publication_ref TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  draft_revision INTEGER NOT NULL CHECK(draft_revision>0),
  intent_id TEXT NOT NULL,
  intent_revision INTEGER NOT NULL CHECK(intent_revision>0),
  attempt_id TEXT NOT NULL REFERENCES operation_attempt(attempt_id),
  operation_receipt_id TEXT NOT NULL,
  operation_receipt_revision INTEGER NOT NULL CHECK(operation_receipt_revision>0),
  outbox_id TEXT NOT NULL REFERENCES outbox(outbox_id),
  principal_ref TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  authorization_scope_id TEXT NOT NULL,
  authorization_scope_revision INTEGER NOT NULL CHECK(authorization_scope_revision>0),
  authorization_receipt_ref TEXT NOT NULL,
  policy_authority_ref TEXT NOT NULL,
  credential_generation TEXT NOT NULL,
  authorization_expires_at TEXT NOT NULL,
  deployment_generation TEXT NOT NULL,
  expected_publication_revision INTEGER CHECK(expected_publication_revision IS NULL OR expected_publication_revision>0),
  publication_revision INTEGER NOT NULL CHECK(publication_revision>0),
  expected_draft_head_revision INTEGER NOT NULL CHECK(expected_draft_head_revision>0),
  manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  verification_set_json TEXT NOT NULL CHECK(json_valid(verification_set_json) AND json_type(verification_set_json)='array' AND json_array_length(verification_set_json)>0 AND length(verification_set_json)<=524288),
  verification_set_sha256 TEXT NOT NULL CHECK(length(verification_set_sha256)=64 AND verification_set_sha256 NOT GLOB '*[^0-9a-f]*'),
  evidence_currentness_json TEXT NOT NULL CHECK(json_valid(evidence_currentness_json) AND json_type(evidence_currentness_json)='array' AND json_array_length(evidence_currentness_json)>0 AND length(evidence_currentness_json)<=262144),
  evidence_currentness_sha256 TEXT NOT NULL CHECK(length(evidence_currentness_sha256)=64 AND evidence_currentness_sha256 NOT GLOB '*[^0-9a-f]*'),
  purge_ledger_revision INTEGER NOT NULL CHECK(purge_ledger_revision>=0),
  created_at TEXT NOT NULL,
  UNIQUE(intent_id,intent_revision),
  UNIQUE(artifact_id,draft_revision),
  UNIQUE(artifact_id,publication_revision),
  FOREIGN KEY(intent_id,intent_revision) REFERENCES operation_intent(intent_id,revision),
  FOREIGN KEY(operation_receipt_id,operation_receipt_revision) REFERENCES operation_receipt(receipt_id,revision),
  FOREIGN KEY(artifact_id,draft_revision) REFERENCES artifact_revision(artifact_id,revision)
) STRICT;

CREATE TRIGGER artifact_publication_receipt_guard
BEFORE INSERT ON artifact_publication_receipt
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM operation_intent i JOIN outbox o ON o.intent_id=i.intent_id AND o.intent_revision=i.revision
    JOIN operation_attempt a ON a.intent_id=i.intent_id AND a.intent_revision=i.revision AND a.attempt_id=NEW.attempt_id
    JOIN operation_receipt r ON r.intent_id=i.intent_id AND r.intent_revision=i.revision
      AND r.receipt_id=NEW.operation_receipt_id AND r.revision=NEW.operation_receipt_revision AND r.attempt_id=a.attempt_id
    WHERE i.intent_id=NEW.intent_id AND i.revision=NEW.intent_revision
      AND i.operation_kind='ARTIFACT_PUBLISH' AND i.principal_ref=NEW.principal_ref
      AND i.idempotency_key=NEW.idempotency_key AND o.outbox_id=NEW.outbox_id
      AND r.outcome='ACCEPTED' AND r.reconciliation_required=1
      AND EXISTS(SELECT 1 FROM json_each(r.output_refs_json) WHERE value=NEW.publication_ref)
      AND julianday(NEW.authorization_expires_at)>julianday(NEW.created_at)
  ) THEN RAISE(ABORT,'ARTIFACT_PUBLICATION_OPERATION_GUARD') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM artifact_revision r JOIN artifact_draft_binding b ON b.artifact_id=r.artifact_id AND b.revision=r.revision
    JOIN artifact_draft_head h ON h.artifact_id=r.artifact_id
    JOIN artifact_draft_object m ON m.artifact_id=r.artifact_id AND m.revision=r.revision AND m.object_kind='MANIFEST'
    JOIN owner_artifact_read_origin owner ON owner.artifact_id=r.artifact_id AND owner.artifact_revision=r.revision
      AND owner.reader_principal_ref=NEW.principal_ref AND owner.scope_snapshot_id=b.scope_snapshot_id
      AND owner.scope_snapshot_revision=b.scope_snapshot_revision
    WHERE r.artifact_id=NEW.artifact_id AND r.revision=NEW.draft_revision AND r.status='DRAFT'
      AND h.head_revision=NEW.expected_draft_head_revision AND h.head_revision=NEW.draft_revision
      AND json_extract(m.receipt_json,'$.expected_sha256')=NEW.manifest_sha256
      AND json_extract(m.receipt_json,'$.readback_sha256')=NEW.manifest_sha256
  ) THEN RAISE(ABORT,'ARTIFACT_PUBLICATION_DRAFT_OR_OWNER_GUARD') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM scope_access_grant g JOIN scope_snapshot s
      ON s.snapshot_id=g.snapshot_id AND s.revision=g.snapshot_revision
    WHERE g.snapshot_id=NEW.authorization_scope_id AND g.snapshot_revision=NEW.authorization_scope_revision
      AND g.principal_ref=NEW.principal_ref AND g.client_class='owner_pwa'
      AND g.credential_generation=NEW.credential_generation
      AND g.authorization_receipt_ref=NEW.authorization_receipt_ref
      AND g.policy_authority_ref=NEW.policy_authority_ref AND g.state='ACTIVE'
      AND julianday(g.expires_at)>julianday(NEW.created_at)
      AND s.invalidated_at IS NULL AND s.snapshot_digest IS NOT NULL
      AND julianday(s.expires_at)>julianday(NEW.created_at)
      AND EXISTS(SELECT 1 FROM investigation_current_policy p
        WHERE p.policy_authority_ref=NEW.policy_authority_ref AND p.state='ACTIVE')
      AND EXISTS(SELECT 1 FROM research_deployment_compatible d
        WHERE d.origin_deployment_generation=NEW.deployment_generation)
      AND EXISTS(SELECT 1 FROM json_each(g.allowed_use_json) WHERE value='research')
  ) THEN RAISE(ABORT,'ARTIFACT_PUBLICATION_OWNER_GRANT_GUARD') END;
  SELECT CASE WHEN NEW.purge_ledger_revision<>coalesce((SELECT max(ledger_revision) FROM purge_ledger),0)
    THEN RAISE(ABORT,'ARTIFACT_PUBLICATION_PURGE_FENCE') END;
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM json_each(NEW.verification_set_json) s
    WHERE json_type(s.value,'$.section_ref.id') IS NOT 'text'
       OR json_type(s.value,'$.verification_receipt_ref') IS NOT 'text'
       OR json_type(s.value,'$.verification_sha256') IS NOT 'text'
       OR json_type(s.value,'$.cited_handle_refs') IS NOT 'array'
       OR json_array_length(s.value,'$.cited_handle_refs')=0
       OR EXISTS(SELECT 1 FROM json_each(s.value,'$.cited_handle_refs') h
          WHERE NOT EXISTS(SELECT 1 FROM json_each(NEW.evidence_currentness_json) c
             WHERE json_extract(c.value,'$.handle_id')=json_extract(h.value,'$.id')
               AND json_extract(c.value,'$.handle_revision')=json_extract(h.value,'$.revision')))
  ) THEN RAISE(ABORT,'ARTIFACT_PUBLICATION_VERIFICATION_COVERAGE_GUARD') END;
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM json_each(NEW.evidence_currentness_json) e
    WHERE json_type(e.value,'$.handle_id') IS NOT 'text' OR json_type(e.value,'$.handle_revision') IS NOT 'integer'
       OR json_type(e.value,'$.source_revision_ref') IS NOT 'text' OR json_type(e.value,'$.source_namespace_id') IS NOT 'text'
       OR json_type(e.value,'$.source_owner_generation') IS NOT 'text'
       OR NOT EXISTS (
         SELECT 1 FROM evidence_handle eh
         JOIN source_revision sr ON sr.source_revision_ref=eh.source_revision_ref
         JOIN source s ON s.source_id=sr.source_id
         JOIN source_namespace_ownership own ON own.source_namespace_id=eh.source_namespace_id AND own.status='ACTIVE'
         WHERE eh.handle_id=json_extract(e.value,'$.handle_id') AND eh.revision=json_extract(e.value,'$.handle_revision')
           AND eh.source_revision_ref=json_extract(e.value,'$.source_revision_ref')
           AND eh.source_namespace_id=json_extract(e.value,'$.source_namespace_id')
           AND eh.source_owner_generation=json_extract(e.value,'$.source_owner_generation')
           AND eh.terminal_state='LIVE' AND sr.purge_state='LIVE'
           AND sr.source_owner_generation=eh.source_owner_generation
           AND s.source_namespace_id=eh.source_namespace_id AND s.source_owner_generation=eh.source_owner_generation
           AND own.source_owner_generation=eh.source_owner_generation
           AND NOT EXISTS(SELECT 1 FROM evidence_handle_invalidation inv WHERE inv.handle_id=eh.handle_id AND inv.handle_revision=eh.revision)
       )
  ) THEN RAISE(ABORT,'ARTIFACT_PUBLICATION_EVIDENCE_STALE') END;
END;
CREATE TRIGGER artifact_publication_receipt_no_update BEFORE UPDATE ON artifact_publication_receipt
BEGIN SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_RECEIPT_IMMUTABLE'); END;
CREATE TRIGGER artifact_publication_receipt_no_delete BEFORE DELETE ON artifact_publication_receipt
BEGIN SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_RECEIPT_IMMUTABLE'); END;

CREATE TABLE artifact_publication_head (
  artifact_id TEXT PRIMARY KEY,
  publication_revision INTEGER NOT NULL CHECK(publication_revision>0),
  draft_revision INTEGER NOT NULL CHECK(draft_revision>0),
  publication_ref TEXT NOT NULL UNIQUE REFERENCES artifact_publication_receipt(publication_ref),
  disposition TEXT NOT NULL CHECK(disposition IN('ACCEPTED','PENDING_REVALIDATION','REDACTED_DEPENDENCY')),
  updated_at TEXT NOT NULL,
  FOREIGN KEY(artifact_id,publication_revision) REFERENCES artifact_publication_receipt(artifact_id,publication_revision),
  FOREIGN KEY(artifact_id,draft_revision) REFERENCES artifact_publication_receipt(artifact_id,draft_revision)
) STRICT;
CREATE TRIGGER artifact_publication_head_insert_guard BEFORE INSERT ON artifact_publication_head
WHEN NEW.disposition='ACCEPTED'
  AND NOT EXISTS(SELECT 1 FROM artifact_publication_head WHERE artifact_id=NEW.artifact_id)
BEGIN
  SELECT CASE WHEN NEW.publication_revision<>1 OR NOT EXISTS(
    SELECT 1 FROM artifact_publication_receipt p JOIN artifact_draft_head d
      ON d.artifact_id=p.artifact_id AND d.head_revision=p.draft_revision
    WHERE p.publication_ref=NEW.publication_ref AND p.artifact_id=NEW.artifact_id
      AND p.publication_revision=NEW.publication_revision AND p.draft_revision=NEW.draft_revision
  ) THEN RAISE(ABORT,'ARTIFACT_PUBLICATION_HEAD_CAS') END;
END;
CREATE TRIGGER artifact_publication_head_update_guard BEFORE UPDATE ON artifact_publication_head
WHEN NEW.disposition='ACCEPTED'
BEGIN
  SELECT CASE WHEN NEW.publication_revision<>OLD.publication_revision+1 OR NOT EXISTS(
    SELECT 1 FROM artifact_publication_receipt p JOIN artifact_draft_head d
      ON d.artifact_id=p.artifact_id AND d.head_revision=p.draft_revision
    WHERE p.publication_ref=NEW.publication_ref AND p.artifact_id=NEW.artifact_id
      AND p.publication_revision=NEW.publication_revision AND p.draft_revision=NEW.draft_revision
      AND p.expected_publication_revision=OLD.publication_revision
  ) THEN RAISE(ABORT,'ARTIFACT_PUBLICATION_HEAD_CAS') END;
END;
CREATE TRIGGER artifact_publication_head_identity_guard BEFORE UPDATE ON artifact_publication_head
WHEN NEW.artifact_id IS NOT OLD.artifact_id
  OR (NEW.disposition<>'ACCEPTED' AND (
    (NEW.publication_revision,NEW.draft_revision,NEW.publication_ref)
    IS NOT (OLD.publication_revision,OLD.draft_revision,OLD.publication_ref)
    OR NEW.disposition NOT IN ('PENDING_REVALIDATION','REDACTED_DEPENDENCY')))
BEGIN SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_HEAD_IDENTITY_CONFLICT'); END;
CREATE TRIGGER artifact_publication_head_no_delete BEFORE DELETE ON artifact_publication_head
BEGIN SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_HEAD_IMMUTABLE'); END;
CREATE INDEX artifact_publication_disposition_idx ON artifact_publication_head(disposition,updated_at);

-- Insert/update appends immutable receipt, then exact-head UPSERT, followed immediately by a mutation-guard
-- sentinel whose trigger requires changes()=1 (so a stale expected publication revision rolls back the batch).
-- Erasure invalidation appends erasure_dependent_invalidation before setting head PENDING_REVALIDATION or
-- REDACTED_DEPENDENCY; readers independently re-resolve exact current evidence on every read.

-- This sentinel must be the very next statement after the conditional head CAS
-- in the same D1 batch. A zero-row CAS aborts the entire canonical mutation.
CREATE TABLE artifact_publication_mutation_guard (
  publication_ref TEXT PRIMARY KEY REFERENCES artifact_publication_receipt(publication_ref),
  created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER artifact_publication_mutation_requires_cas
BEFORE INSERT ON artifact_publication_mutation_guard
WHEN changes()<>1 OR NOT EXISTS (
  SELECT 1 FROM artifact_publication_head h
  WHERE h.publication_ref=NEW.publication_ref AND h.disposition='ACCEPTED'
)
BEGIN SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_HEAD_CAS'); END;
CREATE TRIGGER artifact_publication_mutation_no_update
BEFORE UPDATE ON artifact_publication_mutation_guard
BEGIN SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_RECEIPT_IMMUTABLE'); END;
CREATE TRIGGER artifact_publication_mutation_no_delete
BEFORE DELETE ON artifact_publication_mutation_guard
BEGIN SELECT RAISE(ABORT,'ARTIFACT_PUBLICATION_RECEIPT_IMMUTABLE'); END;
