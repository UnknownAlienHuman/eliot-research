-- S11/S12: fresh reads of exact saved machine reports, without renewed execution.
-- The origin view is shared by admission, effective grants and independent artifact reads.
-- Original machine delegation revisions are immutable. Token refresh is not regrant.
CREATE VIEW project_client_artifact_read_origin AS
SELECT b.artifact_id, b.revision AS artifact_revision, b.principal_ref,
  b.scope_snapshot_id, b.scope_snapshot_revision, d.grant_id AS client_grant_id,
  d.revision AS client_grant_revision, p.generation AS project_generation,
  'owner_pwa' AS origin_client_class
FROM artifact_draft_binding b
JOIN artifact_revision a ON a.artifact_id=b.artifact_id AND a.revision=b.revision AND a.status='DRAFT'
JOIN scope_snapshot s ON s.snapshot_id=b.scope_snapshot_id AND s.revision=b.scope_snapshot_revision
JOIN project_client_grant_current d ON d.project_id=json_extract(s.resolved_scope_expression_json,'$.project_id')
JOIN project p ON p.project_id=d.project_id
JOIN project_owner po ON po.project_id=p.project_id AND po.principal_ref=d.grantor_principal_ref
WHERE json_extract(s.resolved_scope_expression_json,'$.kind')='PROJECT'
  AND d.state='ACTIVE' AND d.grantee_method='service_token' AND julianday(d.expires_at)>julianday('now')
  AND b.principal_ref=d.grantor_principal_ref
  AND EXISTS (SELECT 1 FROM scope_access_grant og WHERE og.snapshot_id=s.snapshot_id
    AND og.snapshot_revision=s.revision AND og.principal_ref=b.principal_ref
    AND og.client_class='owner_pwa' AND og.project_client_grant_id IS NULL
    AND og.policy_authority_ref=s.policy_authority_ref AND og.state IN ('ACTIVE','EXPIRED'))
  AND NOT EXISTS (SELECT 1 FROM scope_access_grant og WHERE og.snapshot_id=s.snapshot_id
    AND og.snapshot_revision=s.revision AND og.principal_ref=b.principal_ref
    AND og.client_class='owner_pwa' AND og.state='REVOKED')
UNION ALL
SELECT b.artifact_id, b.revision, b.principal_ref, b.scope_snapshot_id, b.scope_snapshot_revision,
  r.client_grant_id, r.client_grant_revision, r.project_generation, r.origin_client_class
FROM artifact_draft_binding b
JOIN artifact_revision a ON a.artifact_id=b.artifact_id AND a.revision=b.revision AND a.status='DRAFT'
JOIN project_client_run_control_origin r ON r.scope_snapshot_id=b.scope_snapshot_id
  AND r.scope_snapshot_revision=b.scope_snapshot_revision AND r.principal_ref=b.principal_ref
JOIN research_report_admission admission ON admission.operation_id=r.operation_id
  AND admission.intent_id=b.intent_id AND admission.intent_revision=b.intent_revision
  AND admission.principal_ref=b.principal_ref AND admission.client_class=r.origin_client_class
  AND admission.credential_generation=r.credential_generation
  AND admission.scope_snapshot_id=r.scope_snapshot_id AND admission.scope_snapshot_revision=r.scope_snapshot_revision
  AND admission.policy_authority_ref=r.policy_authority_ref
  AND admission.authorization_receipt_ref=r.authorization_receipt_ref
  AND admission.deployment_generation=r.deployment_generation
WHERE r.origin_client_class IN ('trusted_agent','named_api_client')
  AND EXISTS (SELECT 1 FROM research_workflow_run saved WHERE saved.operation_id=r.operation_id
    AND saved.state IN ('ACTIVE','ENGINE_COMPLETED'))
  AND NOT EXISTS (SELECT 1 FROM scope_access_grant og WHERE og.snapshot_id=b.scope_snapshot_id
    AND og.snapshot_revision=b.scope_snapshot_revision AND og.principal_ref=b.principal_ref
    AND og.client_class=r.origin_client_class AND og.state='REVOKED');

-- Query/execution/source/time predicates stay unchanged; only saved-artifact origin is generalized.
DROP VIEW scope_access_grant_effective;
CREATE VIEW scope_access_grant_effective AS
SELECT g.* FROM scope_access_grant g WHERE g.project_client_grant_id IS NULL OR EXISTS (
  SELECT 1 FROM project_client_grant_current d
  JOIN project p ON p.project_id=d.project_id
  JOIN project_owner po ON po.project_id=p.project_id AND po.principal_ref=d.grantor_principal_ref
  JOIN scope_snapshot s ON s.snapshot_id=g.snapshot_id AND s.revision=g.snapshot_revision
  WHERE d.grant_id=g.project_client_grant_id AND d.revision=g.project_client_grant_revision
    AND d.state='ACTIVE' AND g.state='ACTIVE' AND g.project_client_operation IN ('query','report','evidence','run')
    AND d.grantee_method='service_token' AND d.grantee_subject=g.principal_ref
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
        JOIN source_admission_decision a ON a.source_revision_ref=m.value AND a.decision='ADMITTED'
        JOIN source_revision r ON r.source_revision_ref=m.value JOIN source src ON src.source_id=r.source_id
        JOIN scope_read_policy rp ON rp.source_namespace_id=src.source_namespace_id
          AND rp.principal_ref=d.grantor_principal_ref AND rp.client_class='owner_pwa' AND rp.state='ACTIVE'
        WHERE EXISTS (SELECT 1 FROM json_each(a.allowed_use_json) WHERE value=u.value)
          AND EXISTS (SELECT 1 FROM json_each(rp.allowed_use_json) WHERE value=u.value)
      )
    ))
    AND ((g.project_client_operation='query' AND g.project_client_run_operation_id IS NULL
      AND g.project_client_artifact_id IS NULL AND g.project_client_artifact_revision IS NULL)
      OR (g.project_client_operation='run' AND g.project_client_artifact_id IS NULL AND g.project_client_artifact_revision IS NULL
        AND d.spend_policy_sha256 IS NOT NULL AND d.spend_deployment_generation IS NOT NULL
        AND julianday(d.spend_expires_at)>julianday('now') AND julianday(g.expires_at)<=julianday(d.spend_expires_at)
        AND json_extract(s.resolved_scope_expression_json,'$.kind')='PROJECT'
        AND json_extract(s.resolved_scope_expression_json,'$.project_id')=d.project_id
        AND EXISTS(SELECT 1 FROM orientation_request e WHERE e.execution_operation_id=g.project_client_run_operation_id
          AND e.execution_client_grant_id=d.grant_id AND e.execution_client_grant_revision=d.revision
          AND e.snapshot_id=g.snapshot_id AND e.snapshot_revision=g.snapshot_revision
          AND e.principal_ref=g.principal_ref AND e.client_class=g.client_class AND e.credential_generation=g.credential_generation
          AND e.state IN ('PREPARED','COMPLETE') AND julianday(e.expires_at)>julianday('now')
          AND julianday(e.expires_at)<=julianday(e.created_at)+1 AND julianday(g.expires_at)<=julianday(e.expires_at)))
      OR (g.project_client_operation IN ('report','evidence') AND g.project_client_run_operation_id IS NULL
        AND EXISTS (SELECT 1 FROM json_each(d.record_json,'$.allowed_operations') WHERE value='report')
        AND EXISTS (
          SELECT 1 FROM project_client_artifact_read_origin b
          JOIN scope_snapshot original ON original.snapshot_id=b.scope_snapshot_id AND original.revision=b.scope_snapshot_revision
          WHERE b.artifact_id=g.project_client_artifact_id AND b.artifact_revision=g.project_client_artifact_revision
            AND b.client_grant_id=d.grant_id AND b.client_grant_revision=d.revision
            AND b.project_generation=p.generation
            AND (b.origin_client_class='owner_pwa' OR b.origin_client_class=g.client_class)
            AND json_extract(original.resolved_scope_expression_json,'$.kind')='PROJECT'
            AND json_extract(original.resolved_scope_expression_json,'$.project_id')=d.project_id
            AND original.resolved_scope_expression_json=s.resolved_scope_expression_json
            AND original.member_source_revision_refs_json=s.member_source_revision_refs_json
            AND original.participant_generations_json=s.participant_generations_json
            AND original.source_owner_generations_json=s.source_owner_generations_json
            AND original.disclosure_closure_digest=s.disclosure_closure_digest
            AND original.purge_ledger_revision<=s.purge_ledger_revision
            AND (original.invalidated_at IS NULL OR (original.invalidation_reason='SCOPE_INPUT_CHANGED' AND EXISTS (
              SELECT 1 FROM json_each(original.member_source_revision_refs_json) m
              JOIN source_revision r ON r.source_revision_ref=m.value JOIN source src ON src.source_id=r.source_id
              WHERE src.head_rev<>r.source_revision_ref AND r.purge_state='LIVE')))
        )))
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
        WHERE sr.source_revision_ref=member.value AND (g.project_client_operation NOT IN ('query','run') OR sr.source_revision_ref=src.head_rev)
          AND sr.purge_state='LIVE'
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

UPDATE schema_state SET value='project-client-artifact-scope-v2',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE key='project_client_artifact_scope_generation';
