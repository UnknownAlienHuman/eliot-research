-- S98: bind namespace-delegated uploads to the original client and grant without changing ownership.
PRAGMA foreign_keys=ON;
ALTER TABLE bundle_ingest_operation ADD COLUMN client_origin_json TEXT CHECK (
  client_origin_json IS NULL OR (json_valid(client_origin_json) AND
    json_type(client_origin_json,'$.grant') IS 'object'));

-- Stable origin plus current authority; token refresh is checked separately for each request.
CREATE VIEW bundle_ingest_client_authorized AS
SELECT b.operation_id,project.generation AS project_generation FROM bundle_ingest_operation b
JOIN project_client_grant_current g ON g.grant_id=json_extract(b.client_origin_json,'$.grant.grant_id')
  AND g.revision=json_extract(b.client_origin_json,'$.grant.revision')
  AND json(g.record_json)=json_extract(b.client_origin_json,'$.grant')
JOIN project project ON project.project_id=g.project_id
JOIN project_owner owner ON owner.project_id=g.project_id AND owner.principal_ref=g.grantor_principal_ref
JOIN source_namespace_ownership o ON o.source_namespace_id=b.source_namespace_id AND o.status='ACTIVE'
  AND o.owner_system_id=b.owner_system_id AND o.source_owner_generation=b.source_owner_generation
  AND o.source_admission_policy_revision=b.policy_revision
JOIN source_admission_policy p ON p.source_namespace_id=o.source_namespace_id AND p.revision=b.policy_revision
WHERE b.client_origin_json IS NOT NULL AND g.state='ACTIVE' AND g.grantee_method='service_token'
  AND g.grantee_subject=b.principal_ref AND julianday(g.expires_at)>julianday('now')
  AND julianday(b.expires_at)<=julianday(g.expires_at)
  AND EXISTS (SELECT 1 FROM json_each(g.record_json,'$.allowed_operations') WHERE value='ingest.bundle')
  AND EXISTS (SELECT 1 FROM json_each(g.record_json,'$.ingest_namespace_ids') WHERE value=b.source_namespace_id)
  AND EXISTS (SELECT 1 FROM json_each(p.authorized_principal_refs_json) WHERE value=g.grantor_principal_ref)
  AND EXISTS (SELECT 1 FROM json_each(p.allowed_ownership_modes_json) WHERE value='immutable_import')
  AND json_extract(b.manifest_json,'$.origin.ownership_mode')='immutable_import'
  AND json_extract(b.manifest_json,'$.origin.owner_system_id')=b.owner_system_id
  AND json_extract(b.manifest_json,'$.origin.source_namespace_id')=b.source_namespace_id
  AND json_extract(b.manifest_json,'$.origin.source_owner_generation')=b.source_owner_generation
  AND json_extract(b.manifest_json,'$.origin.source_revision_ref')=b.source_revision_ref
  AND json_extract(b.manifest_json,'$.source.logical_id')=b.source_id
  AND json_extract(b.manifest_json,'$.origin.source_view_ref') NOT LIKE 'snapshot-view:v1:%'
  AND json_extract(b.manifest_json,'$.residency_and_disclosure.disclosure_ceiling')=p.disclosure_ceiling
  AND NOT EXISTS (SELECT 1 FROM json_each(b.manifest_json,'$.residency_and_disclosure.allowed_use') u
    WHERE NOT EXISTS (SELECT 1 FROM json_each(p.allowed_use_json) a WHERE a.value=u.value))
  AND p.source_namespace_id=json_extract(b.policy_snapshot_json,'$.source_namespace_id')
  AND p.source_class=json_extract(b.policy_snapshot_json,'$.source_class')
  AND p.assurance_ceiling=json_extract(b.policy_snapshot_json,'$.assurance_ceiling')
  AND p.instruction_taint=json_extract(b.policy_snapshot_json,'$.instruction_taint')
  AND p.allowed_effects=json_extract(b.policy_snapshot_json,'$.allowed_effects')
  AND p.disclosure_ceiling=json_extract(b.policy_snapshot_json,'$.disclosure_ceiling')
  AND p.license_policy_ref=json_extract(b.policy_snapshot_json,'$.license_policy_ref')
  AND p.default_storage_policy=json_extract(b.policy_snapshot_json,'$.default_storage_policy')
  AND p.default_residency_profile_id=json_extract(b.policy_snapshot_json,'$.default_residency_profile_id')
  AND p.default_retention_policy_id=json_extract(b.policy_snapshot_json,'$.default_retention_policy_id')
  AND p.minimum_quality_state=json_extract(b.policy_snapshot_json,'$.minimum_quality_state')
  AND p.created_at=json_extract(b.policy_snapshot_json,'$.created_at')
  AND p.revision=json_extract(b.policy_snapshot_json,'$.revision')
  AND json(p.authorized_principal_refs_json)=json_extract(b.policy_snapshot_json,'$.authorized_principal_refs')
  AND json(p.allowed_ownership_modes_json)=json_extract(b.policy_snapshot_json,'$.allowed_ownership_modes')
  AND json(p.allowed_use_json)=json_extract(b.policy_snapshot_json,'$.allowed_use');

CREATE TRIGGER bundle_ingest_client_origin_insert AFTER INSERT ON bundle_ingest_operation
WHEN NEW.client_origin_json IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'INGEST_CLIENT_ORIGIN_DENIED') WHERE
    (SELECT COUNT(*) FROM json_each(NEW.client_origin_json))<>1 OR
    NOT EXISTS (SELECT 1 FROM bundle_ingest_client_authorized WHERE operation_id=NEW.operation_id) OR
    julianday(NEW.expires_at)<=julianday('now');
END;
CREATE TRIGGER bundle_ingest_client_origin_immutable BEFORE UPDATE ON bundle_ingest_operation
WHEN OLD.client_origin_json IS NOT NEW.client_origin_json OR (OLD.client_origin_json IS NOT NULL AND (
  OLD.principal_ref IS NOT NEW.principal_ref OR OLD.origin_authentication_receipt_ref IS NOT NEW.origin_authentication_receipt_ref OR
  OLD.idempotency_key IS NOT NEW.idempotency_key OR OLD.input_fingerprint IS NOT NEW.input_fingerprint OR
  OLD.manifest_json IS NOT NEW.manifest_json OR OLD.manifest_sha256 IS NOT NEW.manifest_sha256 OR
  OLD.file_hashes_json IS NOT NEW.file_hashes_json OR OLD.total_bytes IS NOT NEW.total_bytes OR
  OLD.source_namespace_id IS NOT NEW.source_namespace_id OR OLD.owner_system_id IS NOT NEW.owner_system_id OR
  OLD.source_owner_generation IS NOT NEW.source_owner_generation OR OLD.source_revision_ref IS NOT NEW.source_revision_ref OR
  OLD.source_id IS NOT NEW.source_id OR OLD.expected_head_revision_ref IS NOT NEW.expected_head_revision_ref OR
  OLD.residency_key_json IS NOT NEW.residency_key_json OR OLD.residency_key_digest IS NOT NEW.residency_key_digest OR
  OLD.policy_revision IS NOT NEW.policy_revision OR OLD.policy_snapshot_json IS NOT NEW.policy_snapshot_json OR
  OLD.policy_snapshot_sha256 IS NOT NEW.policy_snapshot_sha256 OR OLD.candidate_id IS NOT NEW.candidate_id OR
  OLD.created_at IS NOT NEW.created_at OR OLD.expires_at IS NOT NEW.expires_at))
BEGIN SELECT RAISE(ABORT,'INGEST_CLIENT_ORIGIN_IMMUTABLE'); END;

-- No data is stored in this assertion view; the existing canonical transaction rolls back on denial.
CREATE VIEW bundle_ingest_client_write_fence AS
SELECT CAST(NULL AS TEXT) AS operation_id, CAST(NULL AS TEXT) AS origin_json,
  CAST(NULL AS TEXT) AS credential_expires_at,CAST(NULL AS INTEGER) AS project_generation WHERE 0;
CREATE TRIGGER bundle_ingest_client_write_assert INSTEAD OF INSERT ON bundle_ingest_client_write_fence
BEGIN
  SELECT RAISE(ABORT,'INGEST_CLIENT_WRITE_DENIED') WHERE NOT EXISTS (
    SELECT 1 FROM bundle_ingest_operation b JOIN bundle_ingest_client_authorized a ON a.operation_id=b.operation_id
    WHERE b.operation_id=NEW.operation_id AND b.client_origin_json=NEW.origin_json
      AND a.project_generation=NEW.project_generation
      AND julianday(NEW.credential_expires_at)>julianday('now')
      AND julianday(b.expires_at)>julianday('now')
  );
END;

CREATE TRIGGER bundle_ingest_client_update_guard BEFORE UPDATE ON bundle_ingest_operation
WHEN OLD.client_origin_json IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'INGEST_CLIENT_WRITE_DENIED') WHERE NOT EXISTS (
    SELECT 1 FROM bundle_ingest_client_authorized WHERE operation_id=OLD.operation_id)
    OR julianday(OLD.expires_at)<=julianday('now');
END;

CREATE TRIGGER source_acquisition_candidate_client_insert BEFORE INSERT ON source_acquisition_candidate
WHEN EXISTS (SELECT 1 FROM bundle_ingest_operation b WHERE b.operation_id=NEW.operation_id AND b.client_origin_json IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT,'INGEST_CLIENT_WRITE_DENIED') WHERE NOT EXISTS (
    SELECT 1 FROM bundle_ingest_client_authorized a JOIN bundle_ingest_operation b ON b.operation_id=a.operation_id
    WHERE a.operation_id=NEW.operation_id AND julianday(b.expires_at)>julianday('now'));
END;

CREATE TRIGGER source_acquisition_candidate_client_update BEFORE UPDATE ON source_acquisition_candidate
WHEN EXISTS (SELECT 1 FROM bundle_ingest_operation b WHERE b.operation_id=NEW.operation_id AND b.client_origin_json IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT,'INGEST_CLIENT_WRITE_DENIED') WHERE NOT EXISTS (
    SELECT 1 FROM bundle_ingest_client_authorized a JOIN bundle_ingest_operation b ON b.operation_id=a.operation_id
    WHERE a.operation_id=NEW.operation_id AND julianday(b.expires_at)>julianday('now'));
END;

CREATE TRIGGER qualification_report_client_insert BEFORE INSERT ON qualification_report
WHEN EXISTS (SELECT 1 FROM bundle_ingest_operation b WHERE b.operation_id=NEW.operation_id AND b.client_origin_json IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT,'INGEST_CLIENT_WRITE_DENIED') WHERE NOT EXISTS (
    SELECT 1 FROM bundle_ingest_client_authorized a JOIN bundle_ingest_operation b ON b.operation_id=a.operation_id
    WHERE a.operation_id=NEW.operation_id AND julianday(b.expires_at)>julianday('now'));
END;

CREATE TRIGGER source_admission_decision_client_insert BEFORE INSERT ON source_admission_decision
WHEN EXISTS (SELECT 1 FROM bundle_ingest_operation b WHERE b.operation_id=NEW.operation_id AND b.client_origin_json IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT,'INGEST_CLIENT_WRITE_DENIED') WHERE NOT EXISTS (
    SELECT 1 FROM bundle_ingest_client_authorized a JOIN bundle_ingest_operation b ON b.operation_id=a.operation_id
    WHERE a.operation_id=NEW.operation_id AND julianday(b.expires_at)>julianday('now'));
END;

CREATE TRIGGER bundle_ingest_commit_guard_client_insert BEFORE INSERT ON bundle_ingest_commit_guard
WHEN EXISTS (SELECT 1 FROM bundle_ingest_operation b WHERE b.operation_id=NEW.operation_id AND b.client_origin_json IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT,'INGEST_CLIENT_WRITE_DENIED') WHERE NOT EXISTS (
    SELECT 1 FROM bundle_ingest_client_authorized a JOIN bundle_ingest_operation b ON b.operation_id=a.operation_id
    WHERE a.operation_id=NEW.operation_id AND julianday(b.expires_at)>julianday('now'));
END;

INSERT INTO schema_state(key,value,updated_at) VALUES
  ('bundle_ingest_client_generation','bundle-ingest-client-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- The same explicit namespace ceiling also authorizes attachment without granting ingestion.
DROP TRIGGER project_client_grant_insert_guard;
CREATE TRIGGER project_client_grant_insert_guard BEFORE INSERT ON project_client_grant
BEGIN
  SELECT RAISE(ABORT,'CLIENT_GRANT_REVISION_CONFLICT')
  WHERE NEW.revision <> COALESCE((SELECT MAX(revision) FROM project_client_grant WHERE grant_id=NEW.grant_id),0)+1;
  SELECT RAISE(ABORT,'CLIENT_GRANT_OWNER_REQUIRED') WHERE NOT EXISTS
    (SELECT 1 FROM project_owner o WHERE o.project_id=NEW.project_id AND o.principal_ref=NEW.grantor_principal_ref);
  SELECT RAISE(ABORT,'CLIENT_GRANT_IDENTITY_CONFLICT') WHERE EXISTS (
    SELECT 1 FROM project_client_grant g WHERE g.grant_id=NEW.grant_id AND
      (g.project_id IS NOT NEW.project_id OR g.grantor_principal_ref IS NOT NEW.grantor_principal_ref OR
       g.grantee_issuer IS NOT NEW.grantee_issuer OR g.grantee_method IS NOT NEW.grantee_method OR
       g.grantee_subject IS NOT NEW.grantee_subject OR
       json_extract(g.record_json,'$.created_at') IS NOT json_extract(NEW.record_json,'$.created_at')));
  SELECT RAISE(ABORT,'CLIENT_GRANT_IDENTITY_CONFLICT') WHERE EXISTS (
    SELECT 1 FROM project_client_grant g WHERE g.project_id=NEW.project_id AND g.grantee_issuer=NEW.grantee_issuer
      AND g.grantee_method=NEW.grantee_method AND g.grantee_subject=NEW.grantee_subject AND g.grant_id<>NEW.grant_id);
  SELECT RAISE(ABORT,'CLIENT_GRANT_INITIAL_STATE_INVALID') WHERE NEW.revision=1 AND NEW.state<>'ACTIVE';
  SELECT RAISE(ABORT,'CLIENT_GRANT_EXPIRED') WHERE NEW.state='ACTIVE' AND julianday(NEW.expires_at)<=julianday('now');
  SELECT RAISE(ABORT,'CLIENT_GRANT_TIME_INVALID') WHERE EXISTS (
    SELECT 1 FROM project_client_grant g WHERE g.grant_id=NEW.grant_id AND g.revision=NEW.revision-1
      AND julianday(json_extract(g.record_json,'$.updated_at'))>julianday(json_extract(NEW.record_json,'$.updated_at')));
  SELECT RAISE(ABORT,'CLIENT_GRANT_OPERATION_INVALID') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.record_json,'$.allowed_operations') WHERE type<>'text' OR value NOT IN
      ('catalog','query','run','status','report','evidence','cancel','recover','ingest.bundle','workspace.admit','project.attach'));
  SELECT RAISE(ABORT,'CLIENT_GRANT_OPERATION_INVALID') WHERE
    (SELECT COUNT(DISTINCT value) FROM json_each(NEW.record_json,'$.allowed_operations'))
      <>json_array_length(NEW.record_json,'$.allowed_operations');
  SELECT RAISE(ABORT,'CLIENT_GRANT_NAMESPACE_INVALID') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.record_json,'$.ingest_namespace_ids') WHERE type<>'text' OR length(value) NOT BETWEEN 1 AND 256);
  SELECT RAISE(ABORT,'CLIENT_GRANT_NAMESPACE_INVALID') WHERE
    (SELECT COUNT(DISTINCT value) FROM json_each(NEW.record_json,'$.ingest_namespace_ids'))
      <>json_array_length(NEW.record_json,'$.ingest_namespace_ids');
  SELECT RAISE(ABORT,'CLIENT_GRANT_NAMESPACE_INVALID') WHERE NEW.state='ACTIVE' AND
    (EXISTS (SELECT 1 FROM json_each(NEW.record_json,'$.allowed_operations') WHERE value IN ('ingest.bundle','workspace.admit','project.attach')))
      <> (json_array_length(NEW.record_json,'$.ingest_namespace_ids')>0);
END;

CREATE TRIGGER project_attachment_namespace_receipt BEFORE INSERT ON project_mutation_receipt
WHEN NEW.project_client_grant_id IS NOT NULL
BEGIN
  -- Previous membership versions distinguish retained sources from this command's additions.
  SELECT RAISE(ABORT,'PROJECT_ATTACHMENT_NAMESPACE_DENIED') WHERE EXISTS (
    SELECT 1 FROM json_each(NEW.response_json,'$.source_ids') q JOIN source s ON s.source_id=q.value
    WHERE NOT EXISTS (SELECT 1 FROM project_source_membership old
      WHERE old.project_id=NEW.project_id AND old.source_id=q.value
        AND old.membership_generation=NEW.project_revision-1 AND old.valid_to=NEW.created_at)
    AND NOT EXISTS (SELECT 1 FROM project_attachment_authority a,json_each(a.record_json,'$.ingest_namespace_ids') n
      WHERE a.grant_id=NEW.project_client_grant_id AND a.revision=NEW.project_client_grant_revision
        AND n.value=s.source_namespace_id)
  );
END;
UPDATE schema_state SET value='project-client-attachment-v2',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE key='project_client_attachment_generation';
