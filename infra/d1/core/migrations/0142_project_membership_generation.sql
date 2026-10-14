PRAGMA foreign_keys = ON;

-- Project generation remains the presentation/optimistic revision. Membership
-- authority has its own head, including while the project has no members.
DROP TRIGGER orientation_project_update;
DROP TRIGGER orientation_epoch_project_update;
DROP TRIGGER client_scope_project_update;
DROP TRIGGER client_scope_project_owner_update;

ALTER TABLE project
  ADD COLUMN membership_generation INTEGER NOT NULL DEFAULT 1
  CHECK (membership_generation > 0);

UPDATE project SET membership_generation = generation;

-- Presentation edits still advance the global UI/cache epoch once.
CREATE TRIGGER orientation_epoch_project_update
AFTER UPDATE ON project
BEGIN
  UPDATE orientation_authority_epoch
  SET generation = generation + 1
  WHERE singleton = 1;
END;

-- Scope snapshots depend on project policy and membership authority, not title
-- or the optimistic presentation revision.
CREATE TRIGGER orientation_project_update
AFTER UPDATE ON project
WHEN NEW.project_id IS NOT OLD.project_id
  OR NEW.default_disclosure IS NOT OLD.default_disclosure
  OR NEW.retention_policy_ref IS NOT OLD.retention_policy_ref
  OR NEW.default_source_policy_ref IS NOT OLD.default_source_policy_ref
  OR NEW.default_model_profile_ref IS NOT OLD.default_model_profile_ref
  OR NEW.default_depth_profile_ref IS NOT OLD.default_depth_profile_ref
  OR NEW.membership_generation IS NOT OLD.membership_generation
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  UPDATE scope_snapshot
  SET invalidated_at = COALESCE(invalidated_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      invalidation_reason = 'SCOPE_INPUT_CHANGED'
  WHERE invalidated_at IS NULL
    AND EXISTS (
      SELECT 1 FROM orientation_request o
      WHERE o.snapshot_id = scope_snapshot.snapshot_id
        AND o.snapshot_revision = scope_snapshot.revision
    );
END;

-- Revoke delegated scopes for project authority changes. A title revision
-- advances project.generation and the global epoch without revoking source scope.
CREATE TRIGGER client_scope_project_update
AFTER UPDATE ON project
WHEN NEW.project_id IS NOT OLD.project_id
  OR NEW.default_disclosure IS NOT OLD.default_disclosure
  OR NEW.retention_policy_ref IS NOT OLD.retention_policy_ref
  OR NEW.default_source_policy_ref IS NOT OLD.default_source_policy_ref
  OR NEW.default_model_profile_ref IS NOT OLD.default_model_profile_ref
  OR NEW.default_depth_profile_ref IS NOT OLD.default_depth_profile_ref
  OR NEW.membership_generation IS NOT OLD.membership_generation
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  UPDATE scope_access_grant SET state = 'REVOKED'
  WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query', 'report', 'evidence', 'run')
    AND state = 'ACTIVE'
    AND project_client_grant_id IN (
      SELECT grant_id FROM project_client_grant
      WHERE project_id IN (OLD.project_id, NEW.project_id)
    );
END;

-- project_owner.updated_at follows metadata writes. Revoke delegated scopes
-- only when the durable project owner/deployment authority itself changes.
CREATE TRIGGER client_scope_project_owner_update
AFTER UPDATE ON project_owner
WHEN NEW.project_id IS NOT OLD.project_id
  OR NEW.principal_ref IS NOT OLD.principal_ref
  OR NEW.deployment_generation IS NOT OLD.deployment_generation
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  UPDATE scope_access_grant SET state = 'REVOKED'
  WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query', 'report', 'evidence', 'run')
    AND state = 'ACTIVE'
    AND project_client_grant_id IN (
      SELECT grant_id FROM project_client_grant
      WHERE project_id IN (OLD.project_id, NEW.project_id)
    );
END;

-- Delegated receipt membership checks follow the membership generation rather
-- than assuming it equals the preceding project metadata revision.
DROP TRIGGER project_mutation_receipt_owner_guard;
CREATE TRIGGER project_mutation_receipt_owner_guard BEFORE INSERT ON project_mutation_receipt
BEGIN
  SELECT RAISE(ABORT,'project mutation receipt owner mismatch') WHERE NOT EXISTS (
    SELECT 1 FROM project_owner o WHERE o.project_id=NEW.project_id
      AND o.principal_ref=json_extract(NEW.response_json,'$.owner_principal_ref')
      AND o.deployment_generation=NEW.deployment_generation
      AND ((NEW.project_client_grant_id IS NULL AND o.principal_ref=NEW.principal_ref)
        OR EXISTS (SELECT 1 FROM project_attachment_authority a
          WHERE a.grant_id=NEW.project_client_grant_id AND a.revision=NEW.project_client_grant_revision
            AND a.project_id=o.project_id AND a.grantor_principal_ref=o.principal_ref
            AND a.grantee_subject=NEW.principal_ref AND NEW.operation='UPDATE'
            AND julianday(NEW.client_authority_expires_at)>julianday('now')
            AND julianday(NEW.client_authority_expires_at)<=julianday(a.expires_at)))
  );
  SELECT RAISE(ABORT,'project mutation receipt revision mismatch') WHERE NOT EXISTS (
    SELECT 1 FROM project p WHERE p.project_id=NEW.project_id AND p.generation=NEW.project_revision
      AND json_extract(NEW.response_json,'$.project_ref.id') IS p.project_id
      AND json_extract(NEW.response_json,'$.project_ref.revision') IS p.generation
      AND json_extract(NEW.response_json,'$.revision') IS p.generation
      AND json_extract(NEW.response_json,'$.title') IS p.title
      AND json_extract(NEW.response_json,'$.deployment_generation') IS NEW.deployment_generation
      AND json_extract(NEW.response_json,'$.protocol') IS 'eliotr.project-owner.v1'
  );
  SELECT RAISE(ABORT,'project mutation receipt membership mismatch')
  WHERE json_type(NEW.response_json,'$.source_ids') IS NOT 'array'
    OR EXISTS (SELECT 1 FROM project_source_membership m
      JOIN project p ON p.project_id=m.project_id
      WHERE m.project_id=NEW.project_id AND m.valid_to IS NULL
        AND m.membership_generation<>p.membership_generation)
    OR (SELECT COUNT(*) FROM project_source_membership m
      JOIN project p ON p.project_id=m.project_id AND p.membership_generation=m.membership_generation
      WHERE m.project_id=NEW.project_id AND m.valid_to IS NULL)
      <> json_array_length(NEW.response_json,'$.source_ids')
    OR EXISTS (SELECT 1 FROM project_source_membership m
      JOIN project p ON p.project_id=m.project_id AND p.membership_generation=m.membership_generation
      WHERE m.project_id=NEW.project_id AND m.valid_to IS NULL
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.response_json,'$.source_ids') s WHERE s.type='text' AND s.value=m.source_id));
  SELECT RAISE(ABORT,'PROJECT_ATTACHMENT_RECEIPT_DENIED')
  WHERE NEW.project_client_grant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM project_mutation_guard g WHERE g.project_id=NEW.project_id AND g.principal_ref=NEW.principal_ref
      AND g.idempotency_key=NEW.idempotency_key AND g.operation=NEW.operation AND g.next_revision=NEW.project_revision
      AND g.project_client_grant_id=NEW.project_client_grant_id AND g.project_client_grant_revision=NEW.project_client_grant_revision
      AND g.client_authority_expires_at=NEW.client_authority_expires_at AND g.created_at=NEW.created_at
  );
  SELECT RAISE(ABORT,'PROJECT_ATTACHMENT_MEMBERSHIP_DENIED') WHERE NEW.project_client_grant_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM project_source_membership old
    JOIN project p ON p.project_id=old.project_id
    WHERE old.project_id=NEW.project_id
      AND old.membership_generation=p.membership_generation-1
      AND old.valid_to=NEW.created_at
      AND NOT EXISTS (SELECT 1 FROM project_source_membership current
        WHERE current.project_id=old.project_id AND current.source_id=old.source_id
          AND current.role=old.role AND current.valid_to IS NULL)
  );
END;

DROP TRIGGER project_attachment_namespace_receipt;
CREATE TRIGGER project_attachment_namespace_receipt BEFORE INSERT ON project_mutation_receipt
WHEN NEW.project_client_grant_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'PROJECT_ATTACHMENT_NAMESPACE_DENIED') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.response_json,'$.source_ids') q
    JOIN source s ON s.source_id=q.value
    WHERE NOT EXISTS (
      SELECT 1 FROM project_source_membership old
      JOIN project p ON p.project_id=old.project_id
      WHERE old.project_id=NEW.project_id AND old.source_id=q.value
        AND ((old.valid_to IS NULL AND old.membership_generation=p.membership_generation) OR
          (old.membership_generation=p.membership_generation-1 AND old.valid_to=NEW.created_at))
    )
    AND NOT EXISTS (
      SELECT 1 FROM project_attachment_authority a,
        json_each(a.record_json,'$.ingest_namespace_ids') n
      WHERE a.grant_id=NEW.project_client_grant_id
        AND a.revision=NEW.project_client_grant_revision
        AND n.value=s.source_namespace_id
    )
  );
END;
