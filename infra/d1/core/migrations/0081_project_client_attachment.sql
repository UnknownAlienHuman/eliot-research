-- Attribute delegated attachment to its actual service actor in the existing project journal.
-- Legacy owner receipts and project/source identities are unchanged.
PRAGMA foreign_keys = ON;

CREATE VIEW project_attachment_authority AS
SELECT g.* FROM project_client_grant_current g
JOIN project_owner o ON o.project_id=g.project_id AND o.principal_ref=g.grantor_principal_ref
WHERE g.state='ACTIVE' AND g.grantee_method='service_token' AND julianday(g.expires_at)>julianday('now')
  AND EXISTS (SELECT 1 FROM json_each(g.record_json,'$.allowed_operations') op WHERE op.value='project.attach');

ALTER TABLE project_mutation_guard ADD COLUMN project_client_grant_id TEXT;
ALTER TABLE project_mutation_guard ADD COLUMN project_client_grant_revision INTEGER;
ALTER TABLE project_mutation_guard ADD COLUMN client_authority_expires_at TEXT CHECK (
  (project_client_grant_id IS NULL AND project_client_grant_revision IS NULL AND client_authority_expires_at IS NULL)
  OR (project_client_grant_id IS NOT NULL AND length(project_client_grant_id) BETWEEN 1 AND 256
    AND project_client_grant_revision IS NOT NULL AND project_client_grant_revision BETWEEN 1 AND 2147483647
    AND client_authority_expires_at IS NOT NULL AND julianday(client_authority_expires_at) IS NOT NULL AND operation='UPDATE')
);
ALTER TABLE project_mutation_receipt ADD COLUMN project_client_grant_id TEXT;
ALTER TABLE project_mutation_receipt ADD COLUMN project_client_grant_revision INTEGER;
ALTER TABLE project_mutation_receipt ADD COLUMN client_authority_expires_at TEXT CHECK (
  (project_client_grant_id IS NULL AND project_client_grant_revision IS NULL AND client_authority_expires_at IS NULL)
  OR (project_client_grant_id IS NOT NULL AND length(project_client_grant_id) BETWEEN 1 AND 256
    AND project_client_grant_revision IS NOT NULL AND project_client_grant_revision BETWEEN 1 AND 2147483647
    AND client_authority_expires_at IS NOT NULL AND julianday(client_authority_expires_at) IS NOT NULL AND operation='UPDATE')
);

CREATE TRIGGER project_attachment_guard_authority BEFORE INSERT ON project_mutation_guard
WHEN NEW.project_client_grant_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'PROJECT_ATTACHMENT_DENIED') WHERE NOT EXISTS (
    SELECT 1 FROM project_attachment_authority a JOIN project p ON p.project_id=a.project_id
    WHERE a.grant_id=NEW.project_client_grant_id AND a.revision=NEW.project_client_grant_revision
      AND a.project_id=NEW.project_id AND a.grantee_subject=NEW.principal_ref
      AND p.generation=NEW.next_revision AND NEW.next_revision=NEW.expected_revision+1
      AND julianday(NEW.client_authority_expires_at)>julianday('now')
      AND julianday(NEW.client_authority_expires_at)<=julianday(a.expires_at)
  );
END;

-- Owner identity in the response remains the real project owner. Receipt principal is the caller.
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
    OR (SELECT COUNT(*) FROM project_source_membership m WHERE m.project_id=NEW.project_id AND m.valid_to IS NULL)
      <> json_array_length(NEW.response_json,'$.source_ids')
    OR EXISTS (SELECT 1 FROM project_source_membership m WHERE m.project_id=NEW.project_id AND m.valid_to IS NULL
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.response_json,'$.source_ids') s WHERE s.type='text' AND s.value=m.source_id));
  SELECT RAISE(ABORT,'PROJECT_ATTACHMENT_RECEIPT_DENIED')
  WHERE NEW.project_client_grant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM project_mutation_guard g WHERE g.project_id=NEW.project_id AND g.principal_ref=NEW.principal_ref
      AND g.idempotency_key=NEW.idempotency_key AND g.operation=NEW.operation AND g.next_revision=NEW.project_revision
      AND g.project_client_grant_id=NEW.project_client_grant_id AND g.project_client_grant_revision=NEW.project_client_grant_revision
      AND g.client_authority_expires_at=NEW.client_authority_expires_at AND g.created_at=NEW.created_at
  );
  -- The shared updater versions existing memberships. A delegated receipt cannot conceal a removal.
  SELECT RAISE(ABORT,'PROJECT_ATTACHMENT_MEMBERSHIP_DENIED') WHERE NEW.project_client_grant_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM project_source_membership old WHERE old.project_id=NEW.project_id
      AND old.membership_generation=NEW.project_revision-1 AND old.valid_to=NEW.created_at
      AND NOT EXISTS (SELECT 1 FROM project_source_membership current
        WHERE current.project_id=old.project_id AND current.source_id=old.source_id AND current.role=old.role AND current.valid_to IS NULL)
  );
END;

INSERT INTO schema_state(key,value,updated_at) VALUES
  ('project_client_attachment_generation','project-client-attachment-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
