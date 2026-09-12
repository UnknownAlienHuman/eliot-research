-- ER-13 / W2: immutable Stage15 citation-receipt binding for recovery.
-- This is schema preparation only.  R2 excerpt readback and the application
-- reconciliation remain outside this D1 transaction.
PRAGMA foreign_keys = ON;

CREATE TABLE research_workflow_citation_binding (
  operation_id TEXT NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 128),
  stage_index INTEGER NOT NULL CHECK(stage_index = 15),
  attempt_ref TEXT NOT NULL CHECK(length(attempt_ref) BETWEEN 1 AND 128),
  request_sha256 TEXT NOT NULL CHECK(
    length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  receipt_id TEXT NOT NULL CHECK(length(receipt_id) BETWEEN 1 AND 256),
  receipt_revision INTEGER NOT NULL CHECK(receipt_revision > 0),
  receipt_sha256 TEXT NOT NULL CHECK(
    length(receipt_sha256) = 64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  bound_at TEXT NOT NULL CHECK(
    bound_at GLOB '????-??-??T??:??:??.???Z'
    AND julianday(bound_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', bound_at) IS bound_at
  ),
  PRIMARY KEY(operation_id, stage_index),
  FOREIGN KEY(operation_id, stage_index)
    REFERENCES research_workflow_attempt(operation_id, stage_index),
  FOREIGN KEY(attempt_ref)
    REFERENCES research_workflow_attempt(attempt_ref),
  FOREIGN KEY(receipt_id, receipt_revision)
    REFERENCES citation_resolution_receipt(receipt_id, revision)
) STRICT;

CREATE INDEX research_workflow_citation_binding_receipt_idx
  ON research_workflow_citation_binding(receipt_id, receipt_revision);

-- The binding is a one-time recovery identity.  A duplicate primary key is
-- also rejected explicitly so INSERT OR REPLACE cannot rewrite the history.
CREATE TRIGGER research_workflow_citation_binding_conflict
BEFORE INSERT ON research_workflow_citation_binding
WHEN EXISTS (
  SELECT 1 FROM research_workflow_citation_binding b
  WHERE b.operation_id = NEW.operation_id AND b.stage_index = NEW.stage_index
)
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_CITATION_BINDING_CONFLICT');
END;

-- The row may only bind a currently STARTED Stage15 attempt whose input is
-- the exact committed Stage14 output under the current W1/W2 revision.
CREATE TRIGGER research_workflow_citation_binding_attempt_guard
BEFORE INSERT ON research_workflow_citation_binding
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1
    FROM research_workflow_current r
    JOIN research_workflow_attempt a
      ON a.operation_id = r.operation_id AND a.stage_index = 15
    JOIN research_workflow_attempt predecessor
      ON predecessor.operation_id = r.operation_id AND predecessor.stage_index = 14
    JOIN research_workflow_checkpoint predecessor_checkpoint
      ON predecessor_checkpoint.operation_id = predecessor.operation_id
      AND predecessor_checkpoint.stage_index = predecessor.stage_index
    WHERE r.operation_id = NEW.operation_id
      AND r.state = 'ACTIVE'
      AND r.next_stage_index = 15
      AND r.current_revision = a.expected_revision
      AND r.ledger_revision = a.expected_revision
      AND a.state = 'STARTED'
      AND a.output_json IS NULL
      AND a.attempt_ref = NEW.attempt_ref
      AND a.request_sha256 = NEW.request_sha256
      AND json_extract(a.request_json, '$.protocol') IS 'eliotr.workflow-stage.v1'
      AND json_extract(a.request_json, '$.operation_id') IS r.operation_id
      AND json_extract(a.request_json, '$.stage') IS 'RESOLVE_CITATIONS'
      AND json_extract(a.request_json, '$.investigation_ref.id') IS r.investigation_id
      AND json_extract(a.request_json, '$.investigation_ref.revision') IS r.current_revision
      AND json_extract(a.request_json, '$.idempotency_key') IS r.idempotency_key
      AND json_extract(a.request_json, '$.handler_generation') IS r.handler_generation
      AND json_extract(a.request_json, '$.input_manifest') IS predecessor.output_json
      AND predecessor.state = 'COMMITTED'
      AND predecessor.output_json IS NOT NULL
      AND json_extract(predecessor.request_json, '$.protocol') IS 'eliotr.workflow-stage.v1'
      AND json_extract(predecessor.request_json, '$.operation_id') IS r.operation_id
      AND json_extract(predecessor.request_json, '$.stage') IS 'AUDIT_CLAIMS'
      AND json_extract(predecessor_checkpoint.receipt_json, '$.protocol') IS 'eliotr.workflow-checkpoint.v1'
      AND json_extract(predecessor_checkpoint.receipt_json, '$.operation_id') IS r.operation_id
      AND json_extract(predecessor_checkpoint.receipt_json, '$.stage') IS 'AUDIT_CLAIMS'
      AND json_extract(predecessor_checkpoint.receipt_json, '$.attempt_ref') IS predecessor.attempt_ref
      AND json_extract(predecessor_checkpoint.receipt_json, '$.request_sha256') IS predecessor.request_sha256
      AND json_extract(predecessor_checkpoint.receipt_json, '$.input_manifest_ref') IS
        json_extract(predecessor.request_json, '$.input_manifest.object_ref')
      AND json_extract(predecessor_checkpoint.receipt_json, '$.output_manifest') IS predecessor.output_json
      AND json_extract(predecessor_checkpoint.receipt_json, '$.investigation_ref.id') IS r.investigation_id
      AND json_extract(predecessor_checkpoint.receipt_json, '$.investigation_ref.revision') IS r.current_revision
      AND json_extract(predecessor_checkpoint.receipt_json, '$.engine_state') IS 'CHECKPOINTED'
      AND predecessor_checkpoint.request_sha256 IS predecessor.request_sha256
  );
END;

-- Citation receipt identity, exact current grant, and the verified resolver
-- guard must all agree with the current workflow authority.  The grant's
-- client class is compared; no client class is selected by this migration.
CREATE TRIGGER research_workflow_citation_binding_receipt_guard
BEFORE INSERT ON research_workflow_citation_binding
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1
    FROM research_workflow_current r
    JOIN citation_resolution_receipt receipt
      ON receipt.receipt_id = NEW.receipt_id AND receipt.revision = NEW.receipt_revision
    JOIN citation_resolution_guard guard
      ON guard.receipt_id = receipt.receipt_id
      AND guard.receipt_revision = receipt.revision
      AND guard.verified = 1
    JOIN scope_access_grant grant_row
      ON grant_row.snapshot_id = receipt.scope_snapshot_id
      AND grant_row.snapshot_revision = receipt.scope_snapshot_revision
      AND grant_row.principal_ref = receipt.principal_ref
      AND grant_row.credential_generation = receipt.credential_generation
      AND grant_row.authorization_receipt_ref = receipt.authorization_receipt_ref
    WHERE r.operation_id = NEW.operation_id
      AND r.state = 'ACTIVE'
      AND receipt.receipt_sha256 = NEW.receipt_sha256
      AND receipt.scope_snapshot_id = r.scope_snapshot_id
      AND receipt.scope_snapshot_revision = r.scope_snapshot_revision
      AND receipt.principal_ref = r.principal_ref
      AND receipt.credential_generation = r.credential_generation
      AND receipt.authorization_receipt_ref = r.authorization_receipt_ref
      AND receipt.client_class = grant_row.client_class
      AND grant_row.policy_authority_ref = r.policy_authority_ref
      AND grant_row.state = 'ACTIVE'
      AND julianday(grant_row.expires_at) > julianday('now')
      AND json_type(grant_row.allowed_use_json) = 'array'
      AND EXISTS (
        SELECT 1 FROM json_each(grant_row.allowed_use_json) u
        WHERE u.type = 'text' AND u.value = 'research'
      )
  );
END;

-- Every resolved member must still be a live, guarded evidence resolution
-- under the current source owner/admission and research grant.  An empty
-- resolved array has no members and therefore remains a valid receipt.
CREATE TRIGGER research_workflow_citation_binding_resolved_guard
BEFORE INSERT ON research_workflow_citation_binding
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_AUTHORITY_STALE')
  WHERE EXISTS (
    SELECT 1
    FROM research_workflow_current r
    JOIN citation_resolution_receipt receipt
      ON receipt.receipt_id = NEW.receipt_id AND receipt.revision = NEW.receipt_revision
    JOIN scope_snapshot scope
      ON scope.snapshot_id = receipt.scope_snapshot_id
      AND scope.revision = receipt.scope_snapshot_revision
    CROSS JOIN json_each(receipt.resolved_json) member
    WHERE r.operation_id = NEW.operation_id
      AND receipt.receipt_sha256 = NEW.receipt_sha256
      AND scope.invalidated_at IS NULL
      AND julianday(scope.expires_at) > julianday('now')
      AND NOT EXISTS (
        SELECT 1
        FROM evidence_handle h
        JOIN evidence_resolution_receipt evidence_receipt
          ON evidence_receipt.handle_id = h.handle_id
          AND evidence_receipt.handle_revision = h.revision
        JOIN evidence_resolution_guard evidence_guard
          ON evidence_guard.handle_id = h.handle_id
          AND evidence_guard.handle_revision = h.revision
          AND evidence_guard.receipt_id = evidence_receipt.receipt_id
          AND evidence_guard.receipt_revision = evidence_receipt.revision
          AND evidence_guard.verified = 1
        JOIN evidence_handle_identity evidence_identity
          ON evidence_identity.identity_digest = evidence_guard.identity_digest
          AND evidence_identity.handle_id = h.handle_id
          AND evidence_identity.handle_revision = h.revision
        JOIN source_revision source_revision
          ON source_revision.source_revision_ref = h.source_revision_ref
        JOIN source source_row
          ON source_row.source_id = source_revision.source_id
        JOIN source_namespace_ownership owner_row
          ON owner_row.source_namespace_id = source_row.source_namespace_id
          AND owner_row.owner_system_id = source_row.source_owner_system_id
          AND owner_row.source_owner_generation = source_revision.source_owner_generation
          AND owner_row.status = 'ACTIVE'
        JOIN source_admission_decision admission
          ON admission.source_revision_ref = source_revision.source_revision_ref
          AND admission.decision = 'ADMITTED'
        WHERE h.handle_id = json_extract(member.value, '$.handle_ref.id')
          AND h.revision = json_extract(member.value, '$.handle_ref.revision')
          AND h.scope_snapshot_id = receipt.scope_snapshot_id
          AND h.scope_snapshot_revision = receipt.scope_snapshot_revision
          AND h.terminal_state = 'LIVE'
          AND evidence_receipt.terminal_state = 'LIVE'
          AND evidence_receipt.purge_state = 'LIVE'
          AND evidence_receipt.scope_snapshot_id = receipt.scope_snapshot_id
          AND evidence_receipt.scope_snapshot_revision = receipt.scope_snapshot_revision
          AND evidence_receipt.authorization_receipt_ref = receipt.authorization_receipt_ref
          AND evidence_receipt.source_revision_ref = source_revision.source_revision_ref
          AND evidence_receipt.source_owner_generation = source_revision.source_owner_generation
          AND evidence_receipt.source_revision_content_sha256 = source_revision.content_sha256
          AND h.source_revision_ref = source_revision.source_revision_ref
          AND h.source_owner_generation = source_revision.source_owner_generation
          AND h.object_residency_key_digest = source_revision.object_residency_key_digest
          AND source_row.source_owner_generation = source_revision.source_owner_generation
          AND source_revision.purge_state = 'LIVE'
          AND admission.decision_receipt_ref = (
            SELECT chosen.decision_receipt_ref
            FROM source_admission_decision chosen
            WHERE chosen.source_revision_ref = source_revision.source_revision_ref
              AND chosen.decision = 'ADMITTED'
            ORDER BY chosen.created_at DESC, chosen.decision_receipt_ref DESC
            LIMIT 1
          )
          AND admission.source_namespace_id = source_row.source_namespace_id
          AND admission.owner_system_id = source_row.source_owner_system_id
          AND admission.source_owner_generation = source_revision.source_owner_generation
          AND admission.object_residency_key_digest = source_revision.object_residency_key_digest
          AND (admission.expires_at IS NULL OR julianday(admission.expires_at) > julianday('now'))
          AND json_type(admission.allowed_use_json) = 'array'
          AND EXISTS (
            SELECT 1 FROM json_each(admission.allowed_use_json) u
            WHERE u.type = 'text' AND u.value = 'research'
          )
          AND EXISTS (
            SELECT 1 FROM json_each(scope.member_source_revision_refs_json) scope_member
            WHERE scope_member.value = source_revision.source_revision_ref
          )
          AND EXISTS (
            SELECT 1 FROM json_each(scope.source_owner_generations_json) scope_generation
            WHERE scope_generation.key = source_revision.source_revision_ref
              AND scope_generation.value = source_revision.source_owner_generation
          )
          AND evidence_receipt.excerpt_sha256 = json_extract(member.value, '$.excerpt_sha256')
          AND h.excerpt_sha256 = json_extract(member.value, '$.excerpt_sha256')
          AND (evidence_receipt.receipt_id || ':' || evidence_receipt.revision) =
            json_extract(member.value, '$.verification_receipt_ref')
      )
  );
END;

CREATE TRIGGER research_workflow_citation_binding_immutable
BEFORE UPDATE ON research_workflow_citation_binding
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_CITATION_BINDING_IMMUTABLE');
END;

CREATE TRIGGER research_workflow_citation_binding_no_delete
BEFORE DELETE ON research_workflow_citation_binding
BEGIN
  SELECT RAISE(ABORT, 'WORKFLOW_CITATION_BINDING_IMMUTABLE');
END;

-- This additive, uncomposed capability does not advance schema_state or the
-- public Worker readiness generation.  Application readback must still compare
-- its server-owned context and bounded R2 evidence bytes.
