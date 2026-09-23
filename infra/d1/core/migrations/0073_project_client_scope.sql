-- Delegated queries reuse scope_access_grant. Origin is an immutable grant revision, not a new permissions store.
-- Existing owner/federation grants retain their original rows and behavior.
PRAGMA foreign_keys = ON;
ALTER TABLE scope_access_grant ADD COLUMN project_client_grant_id TEXT;
ALTER TABLE scope_access_grant ADD COLUMN project_client_grant_revision INTEGER;
ALTER TABLE scope_access_grant ADD COLUMN project_client_operation TEXT;
ALTER TABLE scope_access_grant ADD COLUMN project_client_project_generation INTEGER;
ALTER TABLE scope_access_grant ADD COLUMN project_client_authority_epoch INTEGER;
CREATE INDEX client_scope_origin_idx ON scope_access_grant(project_client_grant_id,project_client_grant_revision)
  WHERE project_client_grant_id IS NOT NULL;
CREATE INDEX client_scope_active_query_idx ON scope_access_grant(project_client_grant_id,state)
  WHERE project_client_grant_id IS NOT NULL AND project_client_operation='query' AND state='ACTIVE';

-- One read boundary shared by retrieval and the exact evidence resolver. Wall-clock expiry also applies
-- when no mutation fires. Legacy grants remain subject to their existing callers' currentness checks.
CREATE VIEW scope_access_grant_effective AS
SELECT g.* FROM scope_access_grant g WHERE g.project_client_grant_id IS NULL OR EXISTS (
  SELECT 1 FROM project_client_grant_current d
  JOIN project p ON p.project_id=d.project_id
  JOIN project_owner po ON po.project_id=p.project_id AND po.principal_ref=d.grantor_principal_ref
  JOIN scope_snapshot s ON s.snapshot_id=g.snapshot_id AND s.revision=g.snapshot_revision
  WHERE d.grant_id=g.project_client_grant_id AND d.revision=g.project_client_grant_revision
    AND d.state='ACTIVE' AND g.state='ACTIVE' AND g.project_client_operation='query'
    AND d.grantee_method='service_token' AND d.grantee_subject=g.principal_ref
    AND g.client_class IN ('trusted_agent','named_api_client')
    AND p.generation=g.project_client_project_generation
    AND EXISTS (SELECT 1 FROM json_each(d.record_json,'$.allowed_operations') WHERE value='query')
    AND julianday(d.expires_at)>julianday('now') AND julianday(g.expires_at)>julianday('now')
    AND julianday(g.expires_at)<=julianday(d.expires_at)
    AND json_valid(g.allowed_use_json) AND json_type(g.allowed_use_json)='array'
    AND json_array_length(g.allowed_use_json) BETWEEN 1 AND 512
    AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) WHERE value='research')
    AND NOT EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) u WHERE u.type<>'text' OR NOT (
      (u.value='research' AND json_array_length(s.member_source_revision_refs_json)=0) OR EXISTS (
        SELECT 1 FROM json_each(s.member_source_revision_refs_json) m
        JOIN source_admission_decision a ON a.source_revision_ref=m.value AND a.decision='ADMITTED'
        JOIN source_revision r ON r.source_revision_ref=m.value JOIN source src ON src.source_id=r.source_id
        JOIN scope_read_policy rp ON rp.source_namespace_id=src.source_namespace_id
          AND rp.principal_ref=d.grantor_principal_ref AND rp.client_class='owner_pwa' AND rp.state='ACTIVE'
        WHERE EXISTS (SELECT 1 FROM json_each(a.allowed_use_json) WHERE value=u.value)
          AND EXISTS (SELECT 1 FROM json_each(rp.allowed_use_json) WHERE value=u.value)
      )
    ))
    AND s.invalidated_at IS NULL AND s.policy_authority_ref=g.policy_authority_ref
    AND s.client_fence_ref=g.credential_generation AND julianday(s.expires_at)>julianday('now')
    AND s.purge_ledger_revision=COALESCE((SELECT MAX(ledger_revision) FROM purge_ledger),0)
    AND NOT EXISTS (
      SELECT 1 FROM json_each(s.member_source_revision_refs_json) member WHERE NOT EXISTS (
        SELECT 1 FROM source_revision sr JOIN source src ON src.source_id=sr.source_id
        JOIN source_namespace_ownership o ON o.source_namespace_id=src.source_namespace_id AND o.status='ACTIVE'
        JOIN scope_read_policy rp ON rp.source_namespace_id=src.source_namespace_id
          AND rp.principal_ref=d.grantor_principal_ref AND rp.client_class='owner_pwa'
        JOIN json_each(s.source_owner_generations_json) gen ON gen.key=member.value
        WHERE sr.source_revision_ref=member.value AND sr.source_revision_ref=src.head_rev AND sr.purge_state='LIVE'
          AND sr.source_owner_generation=o.source_owner_generation AND gen.value=sr.source_owner_generation
          AND rp.state='ACTIVE' AND rp.disclosure_ceiling=g.disclosure_ceiling
          AND julianday(rp.expires_at)>julianday('now')
          AND EXISTS (SELECT 1 FROM json_each(rp.allowed_use_json) WHERE value='research')
          AND EXISTS (SELECT 1 FROM project_source_membership m WHERE m.project_id=d.project_id AND m.source_id=sr.source_id
            AND julianday(m.valid_from)<=julianday('now') AND (m.valid_to IS NULL OR julianday(m.valid_to)>julianday('now')))
          AND EXISTS (SELECT 1 FROM source_admission_decision a WHERE a.source_revision_ref=sr.source_revision_ref
            AND a.decision='ADMITTED' AND a.source_owner_generation=sr.source_owner_generation
            AND a.disclosure_ceiling=g.disclosure_ceiling AND (a.expires_at IS NULL OR julianday(a.expires_at)>julianday('now'))
            AND EXISTS (SELECT 1 FROM json_each(a.allowed_use_json) WHERE value='research')
            AND NOT EXISTS (SELECT 1 FROM json_each(a.allowed_use_json) use WHERE
              NOT EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) WHERE value=use.value)))
      )
    )
);

CREATE TRIGGER client_scope_origin_insert BEFORE INSERT ON scope_access_grant
WHEN (NEW.project_client_grant_id IS NULL AND (NEW.project_client_grant_revision IS NOT NULL
  OR NEW.project_client_operation IS NOT NULL OR NEW.project_client_project_generation IS NOT NULL OR NEW.project_client_authority_epoch IS NOT NULL))
 OR (NEW.project_client_grant_id IS NOT NULL AND (
  NEW.project_client_grant_revision IS NULL OR NEW.project_client_grant_revision<1
  OR NEW.project_client_operation IS NOT 'query' OR NEW.project_client_project_generation IS NULL OR NEW.project_client_project_generation<1
  OR NEW.project_client_authority_epoch IS NULL OR NEW.project_client_authority_epoch<1
  OR NEW.project_client_authority_epoch IS NOT (SELECT generation FROM orientation_authority_epoch WHERE singleton=1)
  OR NEW.client_class NOT IN ('trusted_agent','named_api_client') OR NEW.state<>'ACTIVE'
  OR NOT json_valid(NEW.allowed_use_json) OR json_type(NEW.allowed_use_json)<>'array'
  OR json_array_length(NEW.allowed_use_json) NOT BETWEEN 1 AND 512
  OR NOT EXISTS (SELECT 1 FROM json_each(NEW.allowed_use_json) WHERE value='research')))
BEGIN SELECT RAISE(ABORT,'CLIENT_SCOPE_AUTHORITY_STALE'); END;
CREATE TRIGGER client_scope_origin_authorized AFTER INSERT ON scope_access_grant
WHEN NEW.project_client_grant_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM scope_access_grant_effective WHERE authorization_receipt_ref=NEW.authorization_receipt_ref)
BEGIN SELECT RAISE(ABORT,'CLIENT_SCOPE_AUTHORITY_STALE'); END;
CREATE TRIGGER client_scope_origin_immutable BEFORE UPDATE ON scope_access_grant
WHEN NEW.project_client_grant_id IS NOT OLD.project_client_grant_id
 OR NEW.project_client_grant_revision IS NOT OLD.project_client_grant_revision
 OR NEW.project_client_operation IS NOT OLD.project_client_operation
 OR NEW.project_client_project_generation IS NOT OLD.project_client_project_generation
 OR NEW.project_client_authority_epoch IS NOT OLD.project_client_authority_epoch
 OR (OLD.project_client_grant_id IS NOT NULL AND (
  NEW.snapshot_id IS NOT OLD.snapshot_id OR NEW.snapshot_revision IS NOT OLD.snapshot_revision
  OR NEW.principal_ref IS NOT OLD.principal_ref OR NEW.client_class IS NOT OLD.client_class
  OR NEW.credential_generation IS NOT OLD.credential_generation OR NEW.policy_authority_ref IS NOT OLD.policy_authority_ref
  OR NEW.allowed_use_json IS NOT OLD.allowed_use_json OR NEW.disclosure_ceiling IS NOT OLD.disclosure_ceiling
  OR NEW.authorization_receipt_ref IS NOT OLD.authorization_receipt_ref OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.created_at IS NOT OLD.created_at OR (OLD.state<>'ACTIVE' AND NEW.state='ACTIVE')))
BEGIN SELECT RAISE(ABORT,'CLIENT_SCOPE_IMMUTABLE'); END;
CREATE TRIGGER client_scope_origin_no_delete BEFORE DELETE ON scope_access_grant
WHEN OLD.project_client_grant_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'CLIENT_SCOPE_IMMUTABLE'); END;
CREATE TRIGGER client_scope_revoke_snapshot AFTER UPDATE OF state ON scope_access_grant
WHEN NEW.project_client_grant_id IS NOT NULL AND NEW.state<>'ACTIVE'
BEGIN
  UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    invalidation_reason='CLIENT_DELEGATION_STALE'
  WHERE snapshot_id=NEW.snapshot_id AND revision=NEW.snapshot_revision AND invalidated_at IS NULL;
END;
CREATE TRIGGER client_scope_delegation_changed AFTER INSERT ON project_client_grant
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id=NEW.grant_id
    AND project_client_grant_revision<>NEW.revision AND state='ACTIVE';
END;

-- Supplement existing canonical write guards. A read check before an asynchronous effect is not enough.
CREATE TRIGGER client_scope_query_result_guard BEFORE INSERT ON retrieval_query_result
WHEN EXISTS (SELECT 1 FROM scope_access_grant g WHERE g.snapshot_id=NEW.scope_snapshot_id
  AND g.snapshot_revision=NEW.scope_snapshot_revision AND g.project_client_grant_id IS NOT NULL)
 AND NOT EXISTS (SELECT 1 FROM scope_access_grant_effective g WHERE g.snapshot_id=NEW.scope_snapshot_id
  AND g.snapshot_revision=NEW.scope_snapshot_revision AND g.principal_ref=NEW.principal_ref
  AND g.client_class=NEW.client_class AND g.credential_generation=NEW.credential_generation AND g.project_client_operation='query')
BEGIN SELECT RAISE(ABORT,'RETRIEVAL_AUTHORITY_STALE'); END;
CREATE TRIGGER client_scope_query_trace_guard BEFORE INSERT ON retrieval_query_trace
WHEN EXISTS (SELECT 1 FROM scope_access_grant g WHERE g.snapshot_id=NEW.scope_snapshot_id
  AND g.snapshot_revision=NEW.scope_snapshot_revision AND g.project_client_grant_id IS NOT NULL)
 AND NOT EXISTS (SELECT 1 FROM scope_access_grant_effective g WHERE g.snapshot_id=NEW.scope_snapshot_id
  AND g.snapshot_revision=NEW.scope_snapshot_revision AND g.project_client_operation='query')
BEGIN SELECT RAISE(ABORT,'RETRIEVAL_AUTHORITY_STALE'); END;
CREATE TRIGGER client_scope_resolution_guard BEFORE INSERT ON evidence_resolution_receipt
WHEN EXISTS (SELECT 1 FROM scope_access_grant WHERE authorization_receipt_ref=NEW.authorization_receipt_ref
  AND project_client_grant_id IS NOT NULL)
 AND NOT EXISTS (SELECT 1 FROM scope_access_grant_effective WHERE authorization_receipt_ref=NEW.authorization_receipt_ref)
BEGIN SELECT RAISE(ABORT,'EVIDENCE_AUTHORIZATION_DENIED'); END;
CREATE TRIGGER client_scope_handle_guard BEFORE INSERT ON evidence_handle
WHEN EXISTS (SELECT 1 FROM scope_access_grant g WHERE g.snapshot_id=NEW.scope_snapshot_id
  AND g.snapshot_revision=NEW.scope_snapshot_revision AND g.project_client_grant_id IS NOT NULL)
 AND NOT EXISTS (SELECT 1 FROM scope_access_grant_effective g WHERE g.snapshot_id=NEW.scope_snapshot_id
  AND g.snapshot_revision=NEW.scope_snapshot_revision AND g.project_client_operation='query')
BEGIN SELECT RAISE(ABORT,'EVIDENCE_AUTHORIZATION_DENIED'); END;

-- Conservative query-only invalidation follows the existing orientation epoch model. Metadata writes
-- performed by the query itself (snapshot, profile, card, handle, trace) are deliberately not upstream.
-- Revoked derivatives never become live again when an owner restores a source/policy or regrants access.
CREATE TRIGGER client_scope_scope_read_policy_insert AFTER INSERT ON scope_read_policy
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE grantor_principal_ref IN (NEW.principal_ref));
END;
CREATE TRIGGER client_scope_scope_read_policy_update AFTER UPDATE ON scope_read_policy
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE grantor_principal_ref IN (OLD.principal_ref,NEW.principal_ref));
END;
CREATE TRIGGER client_scope_scope_read_policy_delete AFTER DELETE ON scope_read_policy
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE grantor_principal_ref IN (OLD.principal_ref));
END;
CREATE TRIGGER client_scope_project_owner_insert AFTER INSERT ON project_owner
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE project_id IN (NEW.project_id));
END;
CREATE TRIGGER client_scope_project_owner_update AFTER UPDATE ON project_owner
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE project_id IN (OLD.project_id,NEW.project_id));
END;
CREATE TRIGGER client_scope_project_owner_delete AFTER DELETE ON project_owner
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE project_id IN (OLD.project_id));
END;
CREATE TRIGGER client_scope_project_source_membership_insert AFTER INSERT ON project_source_membership
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE project_id IN (NEW.project_id));
END;
CREATE TRIGGER client_scope_project_source_membership_update AFTER UPDATE ON project_source_membership
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE project_id IN (OLD.project_id,NEW.project_id));
END;
CREATE TRIGGER client_scope_project_source_membership_delete AFTER DELETE ON project_source_membership
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE project_id IN (OLD.project_id));
END;
CREATE TRIGGER client_scope_project_insert AFTER INSERT ON project
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE project_id IN (NEW.project_id));
END;
CREATE TRIGGER client_scope_project_update AFTER UPDATE ON project
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE project_id IN (OLD.project_id,NEW.project_id));
END;
CREATE TRIGGER client_scope_project_delete AFTER DELETE ON project
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE project_id IN (OLD.project_id));
END;
CREATE TRIGGER client_scope_source_insert AFTER INSERT ON source
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE';
END;
CREATE TRIGGER client_scope_source_update AFTER UPDATE ON source
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE';
END;
CREATE TRIGGER client_scope_source_delete AFTER DELETE ON source
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE';
END;
CREATE TRIGGER client_scope_source_revision_insert AFTER INSERT ON source_revision
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE';
END;
CREATE TRIGGER client_scope_source_revision_update AFTER UPDATE ON source_revision
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE';
END;
CREATE TRIGGER client_scope_source_revision_delete AFTER DELETE ON source_revision
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE';
END;
CREATE TRIGGER client_scope_source_tag_insert AFTER INSERT ON source_tag
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE';
END;
CREATE TRIGGER client_scope_source_tag_update AFTER UPDATE ON source_tag
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE';
END;
CREATE TRIGGER client_scope_source_tag_delete AFTER DELETE ON source_tag
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE';
END;
CREATE TRIGGER client_scope_source_namespace_ownership_insert AFTER INSERT ON source_namespace_ownership
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE';
END;
CREATE TRIGGER client_scope_source_namespace_ownership_update AFTER UPDATE ON source_namespace_ownership
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE';
END;
CREATE TRIGGER client_scope_source_namespace_ownership_delete AFTER DELETE ON source_namespace_ownership
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE';
END;
CREATE TRIGGER client_scope_source_admission_decision_insert AFTER INSERT ON source_admission_decision
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE';
END;
CREATE TRIGGER client_scope_source_admission_decision_update AFTER UPDATE ON source_admission_decision
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE';
END;
CREATE TRIGGER client_scope_source_admission_decision_delete AFTER DELETE ON source_admission_decision
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation='query' AND state='ACTIVE';
END;

INSERT INTO schema_state(key,value,updated_at)
VALUES('project_client_scope_generation','project-client-scope-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
