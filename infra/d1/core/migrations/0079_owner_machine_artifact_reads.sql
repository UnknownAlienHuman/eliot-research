-- S12: report authorship is immutable; owner reading is independent authority.
-- Historical machine grants establish the original grantor, not continuing service
-- permission. Revoking an agent does not transfer or destroy the owner's report.
-- Current project ownership/membership and fresh owner source grants are required.
CREATE VIEW owner_artifact_read_origin AS
SELECT b.artifact_id, b.revision AS artifact_revision, b.principal_ref,
  b.scope_snapshot_id, b.scope_snapshot_revision, b.principal_ref AS reader_principal_ref,
  'owner_pwa' AS origin_client_class, NULL AS project_id, NULL AS project_generation
FROM artifact_draft_binding b
JOIN artifact_revision a ON a.artifact_id=b.artifact_id AND a.revision=b.revision AND a.status='DRAFT'
JOIN scope_snapshot s ON s.snapshot_id=b.scope_snapshot_id AND s.revision=b.scope_snapshot_revision
WHERE (s.invalidated_at IS NULL OR s.invalidation_reason='SCOPE_INPUT_CHANGED')
  AND EXISTS (SELECT 1 FROM scope_access_grant g
  WHERE g.snapshot_id=s.snapshot_id AND g.snapshot_revision=s.revision
    AND g.principal_ref=b.principal_ref AND g.client_class='owner_pwa'
    AND g.project_client_grant_id IS NULL AND g.credential_generation=s.client_fence_ref
    AND g.policy_authority_ref=s.policy_authority_ref AND g.state IN ('ACTIVE','EXPIRED'))
  AND NOT EXISTS (SELECT 1 FROM scope_access_grant revoked
    WHERE revoked.snapshot_id=s.snapshot_id AND revoked.snapshot_revision=s.revision
      AND revoked.principal_ref=b.principal_ref AND revoked.client_class='owner_pwa' AND revoked.state='REVOKED')
UNION ALL
SELECT b.artifact_id, b.revision, b.principal_ref, b.scope_snapshot_id, b.scope_snapshot_revision,
  d.grantor_principal_ref, g.client_class, d.project_id, p.generation
FROM artifact_draft_binding b
JOIN artifact_revision a ON a.artifact_id=b.artifact_id AND a.revision=b.revision AND a.status='DRAFT'
JOIN research_report_admission admission ON admission.intent_id=b.intent_id
  AND admission.intent_revision=b.intent_revision AND admission.principal_ref=b.principal_ref
  AND admission.scope_snapshot_id=b.scope_snapshot_id AND admission.scope_snapshot_revision=b.scope_snapshot_revision
JOIN research_workflow_run w ON w.operation_id=admission.operation_id AND w.principal_ref=b.principal_ref
  AND w.scope_snapshot_id=b.scope_snapshot_id AND w.scope_snapshot_revision=b.scope_snapshot_revision
  AND w.credential_generation=admission.credential_generation AND w.deployment_generation=admission.deployment_generation
  AND w.policy_authority_ref=admission.policy_authority_ref AND w.authorization_receipt_ref=admission.authorization_receipt_ref
JOIN scope_snapshot s ON s.snapshot_id=w.scope_snapshot_id AND s.revision=w.scope_snapshot_revision
  AND s.client_fence_ref=w.credential_generation AND s.policy_authority_ref=w.policy_authority_ref
JOIN scope_access_grant g ON g.project_client_run_operation_id=w.operation_id AND g.project_client_operation='run'
  AND g.snapshot_id=s.snapshot_id AND g.snapshot_revision=s.revision AND g.principal_ref=w.principal_ref
  AND g.credential_generation=w.credential_generation AND g.policy_authority_ref=w.policy_authority_ref
  AND g.authorization_receipt_ref=w.authorization_receipt_ref AND g.client_class=admission.client_class
JOIN project_client_grant d ON d.grant_id=g.project_client_grant_id AND d.revision=g.project_client_grant_revision
  AND d.grantee_subject=g.principal_ref AND d.grantee_method='service_token' AND d.state='ACTIVE'
JOIN project p ON p.project_id=d.project_id
JOIN project_owner po ON po.project_id=p.project_id AND po.principal_ref=d.grantor_principal_ref
JOIN orientation_request e ON e.execution_operation_id=w.operation_id AND e.state='COMPLETE'
  AND e.execution_client_grant_id=d.grant_id AND e.execution_client_grant_revision=d.revision
  AND e.principal_ref=w.principal_ref AND e.client_class=g.client_class AND e.credential_generation=w.credential_generation
  AND e.snapshot_id=s.snapshot_id AND e.snapshot_revision=s.revision
WHERE g.client_class IN ('trusted_agent','named_api_client') AND w.state IN ('ACTIVE','ENGINE_COMPLETED')
  AND (s.invalidated_at IS NULL OR s.invalidation_reason IN ('SCOPE_INPUT_CHANGED','CLIENT_DELEGATION_STALE'))
  AND json_extract(s.resolved_scope_expression_json,'$.kind')='PROJECT'
  AND json_extract(s.resolved_scope_expression_json,'$.project_id')=d.project_id
  AND EXISTS (SELECT 1 FROM json_each(d.record_json,'$.allowed_operations') WHERE value='run')
  AND julianday(e.expires_at)>julianday(e.created_at) AND julianday(e.expires_at)<=julianday(e.created_at)+1
  AND julianday(g.expires_at)<=julianday(e.expires_at)
  AND json_extract(e.result_json,'$.execution.operation_id')=w.operation_id
  AND json_extract(e.result_json,'$.execution.deadline')=e.expires_at
  AND NOT EXISTS (SELECT 1 FROM json_each(s.member_source_revision_refs_json) member WHERE NOT EXISTS (
    SELECT 1 FROM source_revision sr JOIN project_source_membership m ON m.source_id=sr.source_id
    WHERE sr.source_revision_ref=member.value AND m.project_id=p.project_id
      AND julianday(m.valid_from)<=julianday('now') AND (m.valid_to IS NULL OR julianday(m.valid_to)>julianday('now'))));

INSERT INTO schema_state(key,value,updated_at)
VALUES('owner_artifact_read_generation','owner-artifact-read-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
