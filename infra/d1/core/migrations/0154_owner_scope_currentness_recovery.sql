-- 0154: Scope input invalidation follows the source/project atom that changed.
-- Existing invalidation rows remain immutable; exact current reauthorization is
-- performed by the owner readers before a fresh grant is issued.
DROP TRIGGER orientation_project_source_membership_insert;
DROP TRIGGER orientation_project_source_membership_update;
DROP TRIGGER orientation_project_source_membership_delete;
DROP TRIGGER orientation_source_tag_insert;
DROP TRIGGER orientation_source_tag_update;
DROP TRIGGER orientation_source_tag_delete;
DROP TRIGGER orientation_project_update;
DROP TRIGGER orientation_project_delete;
DROP TRIGGER orientation_source_insert;
DROP TRIGGER orientation_source_update;
DROP TRIGGER orientation_source_delete;
DROP TRIGGER orientation_source_namespace_ownership_update;
DROP TRIGGER orientation_source_namespace_ownership_delete;

CREATE TRIGGER orientation_project_source_membership_insert
AFTER INSERT ON project_source_membership
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL
   AND EXISTS (SELECT 1 FROM orientation_request o WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision)
   AND EXISTS (SELECT 1 FROM json_tree(scope_snapshot.resolved_scope_expression_json) atom
     WHERE atom.key='project_id' AND atom.value=NEW.project_id);
END;

CREATE TRIGGER orientation_project_source_membership_update
AFTER UPDATE ON project_source_membership
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL
   AND EXISTS (SELECT 1 FROM orientation_request o WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision)
   AND EXISTS (SELECT 1 FROM json_tree(scope_snapshot.resolved_scope_expression_json) atom
     WHERE atom.key='project_id' AND atom.value IN (OLD.project_id,NEW.project_id));
END;

CREATE TRIGGER orientation_project_source_membership_delete
AFTER DELETE ON project_source_membership
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL
   AND EXISTS (SELECT 1 FROM orientation_request o WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision)
   AND EXISTS (SELECT 1 FROM json_tree(scope_snapshot.resolved_scope_expression_json) atom
     WHERE atom.key='project_id' AND atom.value=OLD.project_id);
END;

CREATE TRIGGER orientation_source_tag_insert
AFTER INSERT ON source_tag
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL
   AND EXISTS (SELECT 1 FROM orientation_request o WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision)
   AND EXISTS (SELECT 1 FROM json_tree(scope_snapshot.resolved_scope_expression_json) atom
     WHERE atom.key='tag' AND atom.value=NEW.tag);
END;

CREATE TRIGGER orientation_source_tag_update
AFTER UPDATE ON source_tag
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL
   AND EXISTS (SELECT 1 FROM orientation_request o WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision)
   AND EXISTS (SELECT 1 FROM json_tree(scope_snapshot.resolved_scope_expression_json) atom
     WHERE atom.key='tag' AND atom.value IN (OLD.tag,NEW.tag));
END;

CREATE TRIGGER orientation_source_tag_delete
AFTER DELETE ON source_tag
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL
   AND EXISTS (SELECT 1 FROM orientation_request o WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision)
   AND EXISTS (SELECT 1 FROM json_tree(scope_snapshot.resolved_scope_expression_json) atom
     WHERE atom.key='tag' AND atom.value=OLD.tag);
END;

CREATE TRIGGER orientation_project_update
AFTER UPDATE OF project_id,default_disclosure,retention_policy_ref,default_source_policy_ref,
  default_model_profile_ref,default_depth_profile_ref ON project
WHEN OLD.project_id IS NOT NEW.project_id OR OLD.default_disclosure IS NOT NEW.default_disclosure
  OR OLD.retention_policy_ref IS NOT NEW.retention_policy_ref
  OR OLD.default_source_policy_ref IS NOT NEW.default_source_policy_ref
  OR OLD.default_model_profile_ref IS NOT NEW.default_model_profile_ref
  OR OLD.default_depth_profile_ref IS NOT NEW.default_depth_profile_ref
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL
   AND EXISTS (SELECT 1 FROM orientation_request o WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision)
   AND EXISTS (SELECT 1 FROM json_tree(scope_snapshot.resolved_scope_expression_json) atom
     WHERE atom.key='project_id' AND atom.value IN (OLD.project_id,NEW.project_id));
END;

CREATE TRIGGER orientation_project_delete
AFTER DELETE ON project
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL
   AND EXISTS (SELECT 1 FROM orientation_request o WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision)
   AND EXISTS (SELECT 1 FROM json_tree(scope_snapshot.resolved_scope_expression_json) atom
     WHERE atom.key='project_id' AND atom.value=OLD.project_id);
END;

CREATE TRIGGER orientation_source_insert
AFTER INSERT ON source
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL
   AND EXISTS (SELECT 1 FROM orientation_request o WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision)
   AND (EXISTS (SELECT 1 FROM json_tree(scope_snapshot.resolved_scope_expression_json) atom
        WHERE atom.key='kind' AND atom.value='GLOBAL_LIBRARY')
     OR EXISTS (SELECT 1 FROM json_tree(scope_snapshot.resolved_scope_expression_json) selected
        WHERE selected.value=NEW.source_id AND selected.fullkey LIKE '%source_ids[%')
     OR EXISTS (SELECT 1 FROM json_tree(scope_snapshot.resolved_scope_expression_json) atom
        WHERE atom.key='source_class' AND atom.value=NEW.source_class));
END;

CREATE TRIGGER orientation_source_update
AFTER UPDATE ON source
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL
   AND EXISTS (SELECT 1 FROM orientation_request o WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision)
   AND (EXISTS (SELECT 1 FROM json_each(scope_snapshot.member_source_revision_refs_json) member
       JOIN source_revision sr ON sr.source_revision_ref=member.value WHERE sr.source_id=NEW.source_id)
     OR (OLD.source_class IS NOT NEW.source_class AND EXISTS (
       SELECT 1 FROM json_tree(scope_snapshot.resolved_scope_expression_json) atom
       WHERE atom.key='source_class' AND atom.value IN (OLD.source_class,NEW.source_class))));
END;

CREATE TRIGGER orientation_source_delete
AFTER DELETE ON source
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL
   AND EXISTS (SELECT 1 FROM orientation_request o WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision)
   AND (EXISTS (SELECT 1 FROM json_tree(scope_snapshot.resolved_scope_expression_json) atom
        WHERE atom.key='kind' AND atom.value='GLOBAL_LIBRARY')
     OR EXISTS (SELECT 1 FROM json_tree(scope_snapshot.resolved_scope_expression_json) selected
        WHERE selected.value=OLD.source_id AND selected.fullkey LIKE '%source_ids[%')
     OR EXISTS (SELECT 1 FROM json_tree(scope_snapshot.resolved_scope_expression_json) atom
        WHERE atom.key='source_class' AND atom.value=OLD.source_class)
     OR EXISTS (SELECT 1 FROM json_each(scope_snapshot.member_source_revision_refs_json) member
        JOIN source_revision sr ON sr.source_revision_ref=member.value WHERE sr.source_id=OLD.source_id));
END;

CREATE TRIGGER orientation_source_namespace_ownership_update
AFTER UPDATE ON source_namespace_ownership
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL
   AND EXISTS (SELECT 1 FROM orientation_request o WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision)
   AND EXISTS (SELECT 1 FROM json_each(scope_snapshot.member_source_revision_refs_json) member
     JOIN source_revision sr ON sr.source_revision_ref=member.value JOIN source src ON src.source_id=sr.source_id
     WHERE src.source_namespace_id IN (OLD.source_namespace_id,NEW.source_namespace_id));
END;

CREATE TRIGGER orientation_source_namespace_ownership_delete
AFTER DELETE ON source_namespace_ownership
BEGIN
 UPDATE scope_snapshot SET invalidated_at=COALESCE(invalidated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
   invalidation_reason='SCOPE_INPUT_CHANGED'
 WHERE invalidated_at IS NULL
   AND EXISTS (SELECT 1 FROM orientation_request o WHERE o.snapshot_id=scope_snapshot.snapshot_id AND o.snapshot_revision=scope_snapshot.revision)
   AND EXISTS (SELECT 1 FROM json_each(scope_snapshot.member_source_revision_refs_json) member
     JOIN source_revision sr ON sr.source_revision_ref=member.value JOIN source src ON src.source_id=sr.source_id
     WHERE src.source_namespace_id=OLD.source_namespace_id);
END;

DROP VIEW scope_access_grant_effective;
CREATE VIEW scope_access_grant_effective AS
SELECT g.* FROM scope_access_grant g WHERE g.project_client_grant_id IS NULL
UNION ALL
SELECT g.* FROM scope_access_grant g
 JOIN project_client_grant_current d ON (d.grant_id, d.revision)
      = (g.project_client_grant_id, g.project_client_grant_revision)
  JOIN project p ON p.project_id=d.project_id
  JOIN project_owner po ON (po.project_id, po.principal_ref)
      = (p.project_id, d.grantor_principal_ref)
  JOIN scope_snapshot s ON (s.snapshot_id, s.revision)
      = (g.snapshot_id, g.snapshot_revision)
  WHERE (d.grant_id, d.revision, d.state, g.state)
      = (g.project_client_grant_id, g.project_client_grant_revision, 'ACTIVE', 'ACTIVE') AND g.project_client_operation IN ('query','report',
        'evidence','run')
    AND (d.grantee_method, d.grantee_subject)
      = ('service_token', g.principal_ref)
    AND g.client_class IN ('trusted_agent','named_api_client')
    AND p.generation=g.project_client_project_generation
    AND EXISTS (SELECT 1 FROM json_each(d.record_json,'$.allowed_operations') WHERE value=g.project_client_operation)
    AND julianday(d.expires_at)>julianday('now') AND julianday(g.expires_at)>julianday('now')
    AND julianday(g.expires_at)<=julianday(d.expires_at)
    AND json_valid(g.allowed_use_json) AND json_type(g.allowed_use_json)='array'
    AND json_array_length(g.allowed_use_json) BETWEEN 1 AND 512
    AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) WHERE value='research')
    AND NOT EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) u WHERE u.type<>'text' OR NOT (
      (u.value='research' AND json_array_length(s.member_source_revision_refs_json)=0) OR EXISTS (
        SELECT 1 FROM json_each(s.member_source_revision_refs_json) m
        JOIN source_admission_decision a ON (a.source_revision_ref, a.decision)
      = (m.value, 'ADMITTED')
        JOIN source_revision r ON r.source_revision_ref=m.value JOIN source src ON src.source_id=r.source_id
        JOIN scope_read_policy rp ON (rp.source_namespace_id, rp.principal_ref, rp.client_class, rp.state)
      = (src.source_namespace_id, d.grantor_principal_ref, 'owner_pwa', 'ACTIVE')
        WHERE EXISTS (SELECT 1 FROM json_each(a.allowed_use_json) WHERE value=u.value)
          AND EXISTS (SELECT 1 FROM json_each(rp.allowed_use_json) WHERE value=u.value)
      )
    ))
    AND ((g.project_client_operation='query' AND g.project_client_run_operation_id IS NULL
      AND g.project_client_artifact_id IS NULL AND g.project_client_artifact_revision IS NULL)
      OR (g.project_client_operation='run' AND g.project_client_artifact_id IS NULL AND g.project_client_artifact_revision IS NULL
        AND d.spend_policy_sha256 IS NOT NULL AND ((COALESCE(d.spend_policy_protocol,'eliotr.research-owner-spend-template.v1')='eliotr.research-owner-spend-template.v1' AND d.spend_deployment_generation IS NOT NULL) OR (d.spend_policy_protocol='eliotr.research-owner-spend-template.v2' AND d.spend_deployment_generation IS NULL))
        AND julianday(d.spend_expires_at)>julianday('now') AND julianday(g.expires_at)<=julianday(d.spend_expires_at)
        AND json_extract(s.resolved_scope_expression_json,'$.kind')='PROJECT'
        AND json_extract(s.resolved_scope_expression_json,'$.project_id')=d.project_id
        AND EXISTS(SELECT 1 FROM orientation_request e WHERE (e.execution_operation_id, e.execution_client_grant_id,
          e.execution_client_grant_revision, e.snapshot_id, e.snapshot_revision, e.principal_ref, e.client_class, e.credential_generation)
      = (g.project_client_run_operation_id, d.grant_id, d.revision, g.snapshot_id, g.snapshot_revision, g.principal_ref, g.client_class,
        g.credential_generation)
          AND e.state IN ('PREPARED','COMPLETE') AND julianday(e.expires_at)>julianday('now')
          AND julianday(e.expires_at)<=julianday(e.created_at)+1 AND julianday(g.expires_at)<=julianday(e.expires_at)))
      OR (g.project_client_operation IN ('report','evidence') AND g.project_client_run_operation_id IS NULL
        AND EXISTS (SELECT 1 FROM json_each(d.record_json,'$.allowed_operations') WHERE value='report')
        AND EXISTS (
          SELECT 1 FROM project_client_artifact_read_origin b
          JOIN scope_snapshot original ON (original.snapshot_id, original.revision)
      = (b.scope_snapshot_id, b.scope_snapshot_revision)
          WHERE (b.artifact_id, b.artifact_revision, b.client_grant_id, b.client_grant_revision, b.project_generation)
      = (g.project_client_artifact_id, g.project_client_artifact_revision, d.grant_id, d.revision, p.generation)
            AND (b.origin_client_class='owner_pwa' OR b.origin_client_class=g.client_class)
            AND json_extract(original.resolved_scope_expression_json,'$.kind')='PROJECT'
            AND json_extract(original.resolved_scope_expression_json,'$.project_id')=d.project_id
            AND (original.resolved_scope_expression_json, original.member_source_revision_refs_json, original.participant_generations_json,
              original.source_owner_generations_json, original.disclosure_closure_digest)
      = (s.resolved_scope_expression_json, s.member_source_revision_refs_json, s.participant_generations_json, s.source_owner_generations_json,
        s.disclosure_closure_digest)
            AND original.purge_ledger_revision<=s.purge_ledger_revision
            AND (original.invalidated_at IS NULL OR (original.invalidation_reason='SCOPE_INPUT_CHANGED' AND NOT EXISTS (
              SELECT 1 FROM json_each(original.member_source_revision_refs_json) m
              JOIN source_revision r ON r.source_revision_ref=m.value JOIN source src ON src.source_id=r.source_id
              WHERE src.head_rev<>r.source_revision_ref
            )))
        )))
    AND s.invalidated_at IS NULL AND (s.policy_authority_ref, s.client_fence_ref)
      = (g.policy_authority_ref, g.credential_generation) AND julianday(s.expires_at)>julianday('now')
    AND s.purge_ledger_revision=COALESCE((SELECT MAX(ledger_revision) FROM purge_ledger),0)
    AND NOT EXISTS (
      SELECT 1 FROM json_each(s.member_source_revision_refs_json) member WHERE NOT EXISTS (
        SELECT 1 FROM source_revision sr JOIN source src ON src.source_id=sr.source_id
        JOIN source_namespace_ownership o ON (o.source_namespace_id, o.status)
      = (src.source_namespace_id, 'ACTIVE')
        JOIN scope_read_policy rp ON (rp.source_namespace_id, rp.principal_ref, rp.client_class)
      = (src.source_namespace_id, d.grantor_principal_ref, 'owner_pwa')
        JOIN json_each(s.source_owner_generations_json) gen ON gen.key=member.value
        WHERE sr.source_revision_ref=member.value AND (g.project_client_operation NOT IN ('query','run') OR sr.source_revision_ref=src.head_rev)
          AND (sr.purge_state, sr.source_owner_generation, gen.value, rp.state, rp.disclosure_ceiling)
      = ('LIVE', o.source_owner_generation, sr.source_owner_generation, 'ACTIVE', g.disclosure_ceiling)
          AND julianday(rp.expires_at)>julianday('now')
          AND EXISTS (SELECT 1 FROM json_each(rp.allowed_use_json) WHERE value='research')
          AND EXISTS (SELECT 1 FROM project_source_membership m WHERE (m.project_id, m.source_id)
      = (d.project_id, sr.source_id)
            AND julianday(m.valid_from)<=julianday('now') AND (m.valid_to IS NULL OR julianday(m.valid_to)>julianday('now')))
          AND EXISTS (SELECT 1 FROM source_admission_decision a WHERE (a.source_revision_ref, a.decision, a.source_owner_generation,
            a.disclosure_ceiling)
      = (sr.source_revision_ref, 'ADMITTED', sr.source_owner_generation,
        g.disclosure_ceiling) AND (a.expires_at IS NULL OR julianday(a.expires_at)>julianday('now'))
            AND EXISTS (SELECT 1 FROM json_each(a.allowed_use_json) WHERE value='research')
            AND NOT EXISTS (SELECT 1 FROM json_each(a.allowed_use_json) use WHERE
              NOT EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) WHERE value=use.value)))
      )
    );
