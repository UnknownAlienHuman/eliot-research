-- Repair expression-depth expansion without weakening effective authority (#293).
-- No table data, stored grants, historical receipts or migration is rewritten.
-- Disjoint legacy/delegated UNION ALL replaces the scope semijoin; joined keys
-- are unique. DISTINCT on workflow/recovery preserves EXISTS cardinality when
-- more than one matching grant/origin is present. All original predicates remain.
-- Composite equality keeps per-field SQL equality/NULL semantics while bounding
-- identity-predicate height without replacing final atomic SQL checks.
-- The checkpoint trigger checks the same unique run/stage/event in three SELECTs
-- of one atomic trigger invocation, never through a cached or TS-only preflight.

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
        AND d.spend_policy_sha256 IS NOT NULL AND d.spend_deployment_generation IS NOT NULL
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
            AND (original.invalidated_at IS NULL OR (original.invalidation_reason='SCOPE_INPUT_CHANGED' AND EXISTS (
              SELECT 1 FROM json_each(original.member_source_revision_refs_json) m
              JOIN source_revision r ON r.source_revision_ref=m.value JOIN source src ON src.source_id=r.source_id
              WHERE src.head_rev<>r.source_revision_ref AND r.purge_state='LIVE')))
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

DROP VIEW research_workflow_current;
CREATE VIEW research_workflow_current AS
SELECT DISTINCT r.*, h.revision AS ledger_revision, h.checkpoint_head, h.event_head
FROM research_workflow_run r JOIN investigation_ledger_head h ON h.investigation_id = r.investigation_id
JOIN scope_snapshot s ON (s.snapshot_id, s.revision)
      = (r.scope_snapshot_id, r.scope_snapshot_revision)
JOIN scope_access_grant_effective g ON (g.snapshot_id, g.snapshot_revision, g.principal_ref, g.credential_generation, g.policy_authority_ref,
  g.authorization_receipt_ref, g.state)
      = (r.scope_snapshot_id, r.scope_snapshot_revision, r.principal_ref, r.credential_generation, r.policy_authority_ref,
        r.authorization_receipt_ref, 'ACTIVE') AND julianday(g.expires_at) > julianday('now')
    AND json_type(g.allowed_use_json) = 'array'
    AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) u WHERE (u.type, u.value)
      = ('text', 'research'))
LEFT JOIN orientation_request e ON e.execution_operation_id=r.operation_id
LEFT JOIN scope_access_grant_effective eg ON (eg.snapshot_id, eg.snapshot_revision, eg.project_client_operation, eg.project_client_run_operation_id,
  eg.client_class, eg.principal_ref, eg.credential_generation)
      = (r.scope_snapshot_id, r.scope_snapshot_revision, 'run', r.operation_id, e.client_class, r.principal_ref, r.credential_generation)
LEFT JOIN project_client_grant_current d ON (d.grant_id, d.revision, e.execution_client_grant_id, e.execution_client_grant_revision,
  d.spend_deployment_generation)
      = (eg.project_client_grant_id, eg.project_client_grant_revision, d.grant_id, d.revision, r.deployment_generation)
WHERE (h.status, h.principal_ref, h.scope_snapshot_id, h.scope_snapshot_revision, h.policy_generation, h.policy_authority_ref,
  h.deployment_generation)
      = ('OPEN', r.principal_ref, r.scope_snapshot_id, r.scope_snapshot_revision, r.policy_generation, r.policy_authority_ref,
        r.deployment_generation)
  AND s.invalidated_at IS NULL AND julianday(s.expires_at) > julianday('now')
  AND (s.policy_authority_ref, s.purge_ledger_revision)
      = (r.policy_authority_ref, r.purge_revision)
  AND r.purge_revision = COALESCE((SELECT MAX(ledger_revision) FROM purge_ledger), 0)
  AND EXISTS (SELECT 1 FROM investigation_current_policy p WHERE (p.state, p.policy_generation, p.policy_authority_ref)
      = ('ACTIVE', r.policy_generation, r.policy_authority_ref))
  AND EXISTS (SELECT 1 FROM research_deployment_compatible c
    WHERE c.origin_deployment_generation = r.deployment_generation)
  -- A long-lived scope is usable only by its originally admitted operation.
  -- Existing short-lived snapshots keep their original grant/expiry behavior.
  AND (
    NOT EXISTS (SELECT 1 FROM orientation_request e
      WHERE (e.snapshot_id, e.snapshot_revision)
      = (r.scope_snapshot_id, r.scope_snapshot_revision)
        AND e.execution_operation_id IS NOT NULL)
    OR (e.execution_operation_id IS NOT NULL AND (e.execution_operation_id, e.snapshot_id, e.snapshot_revision, e.principal_ref)
      = (r.operation_id, r.scope_snapshot_id, r.scope_snapshot_revision, r.principal_ref) AND (e.client_class='owner_pwa' OR d.grant_id IS NOT NULL)
        AND (e.credential_generation, e.state)
      = (r.credential_generation, 'COMPLETE')
        AND julianday(e.expires_at)>julianday('now')
        AND julianday(e.expires_at)<=julianday(e.created_at)+1
        AND json_extract(e.result_json,'$.execution.operation_id')=r.operation_id
        AND json_extract(e.result_json,'$.execution.deadline')=e.expires_at )
  );

DROP VIEW research_workflow_recovery_authorized;
CREATE VIEW research_workflow_recovery_authorized AS
SELECT DISTINCT r.operation_id, wa.stage_index, r.principal_ref, i.intent_id
FROM research_workflow_run r
JOIN research_workflow_attempt wa ON wa.operation_id=r.operation_id
JOIN operation_intent i ON i.intent_id='research-recover:' || r.operation_id || ':' || wa.stage_index
  AND (i.revision, i.operation_kind)
      = (1, 'research.run.recover.v1')
  AND i.payload_ref='research-run:' || r.operation_id || ':' || wa.stage_index
  AND i.cancellation_ref='workflow:' || r.operation_id
JOIN operation_attempt oa ON (oa.intent_id, oa.intent_revision)
      = (i.intent_id, i.revision)
  AND oa.attempt_id='research-recover-attempt:' || r.operation_id || ':' || wa.stage_index
  AND oa.attempt_number=1 AND oa.state IN ('CHECKPOINTED','SUCCEEDED')
  AND oa.checkpoint_ref IN ('resume:' || i.intent_id, 'restart:' || i.intent_id)
LEFT JOIN project_client_run_control_origin c ON c.operation_id=r.operation_id
LEFT JOIN owner_machine_run_origin o ON o.operation_id=r.operation_id
LEFT JOIN research_workflow_current current_run ON current_run.operation_id=r.operation_id
  AND current_run.state IN ('ACTIVE','ENGINE_COMPLETED')
WHERE (i.principal_ref=r.principal_ref AND i.budget_reservation_ref IS NULL
    AND i.policy_decision_ref='research-recovery-authorized:' || r.operation_id || ':' || wa.stage_index
    AND EXISTS (SELECT 1 FROM scope_access_grant owner_grant
      WHERE (owner_grant.snapshot_id, owner_grant.snapshot_revision, owner_grant.principal_ref, owner_grant.credential_generation,
        owner_grant.authorization_receipt_ref, owner_grant.policy_authority_ref, owner_grant.client_class)
      = (r.scope_snapshot_id, r.scope_snapshot_revision, r.principal_ref, r.credential_generation, r.authorization_receipt_ref,
        r.policy_authority_ref, 'owner_pwa') AND owner_grant.project_client_grant_id IS NULL))
 OR (c.operation_id IS NOT NULL AND (c.operation_id, c.grantee_subject)
      = (r.operation_id, i.principal_ref)
      AND c.spend_policy_sha256 IS NOT NULL AND julianday(c.spend_expires_at)>julianday('now')
      AND c.spend_deployment_generation=r.deployment_generation
      AND json_type(c.grant_record_json,'$.spend_policy_ref')='text'
      AND EXISTS (SELECT 1 FROM json_each(c.grant_record_json,'$.allowed_operations') WHERE value='recover')
      AND i.policy_decision_ref='research-client-recovery:' || c.grant_record_sha256 || ':' || c.project_generation || ':' || c.spend_policy_sha256
      AND i.budget_reservation_ref IS NULL
      AND current_run.operation_id IS NOT NULL)
 OR (o.operation_id IS NOT NULL AND (o.operation_id, o.reader_principal_ref)
      = (r.operation_id, i.principal_ref)
      AND o.spend_policy_sha256 IS NOT NULL AND julianday(o.spend_expires_at)>julianday('now')
      AND o.spend_deployment_generation=r.deployment_generation
      AND julianday(o.execution_deadline)>julianday('now')
      AND i.budget_reservation_ref IS NULL
      AND i.policy_decision_ref='research-owner-machine-recovery:' || o.grant_record_sha256 || ':' || o.project_generation || ':' || o.spend_policy_sha256
      AND current_run.operation_id IS NOT NULL);

DROP VIEW project_client_run_control_origin;
CREATE VIEW project_client_run_control_origin AS
SELECT r.operation_id, r.investigation_id, r.principal_ref, r.credential_generation,
  r.deployment_generation, r.handler_generation, r.scope_snapshot_id, r.scope_snapshot_revision,
  r.policy_authority_ref, r.authorization_receipt_ref, g.client_class AS origin_client_class,
  c.grant_id AS client_grant_id, c.revision AS client_grant_revision, c.project_id,
  p.generation AS project_generation, c.grantor_principal_ref,
  c.grantee_issuer, c.grantee_method, c.grantee_subject, c.record_json AS grant_record_json,
  c.record_sha256 AS grant_record_sha256, c.spend_policy_sha256,
  c.spend_deployment_generation, c.spend_expires_at
FROM research_workflow_run r
JOIN scope_snapshot s ON (s.snapshot_id, s.revision, s.policy_authority_ref, s.client_fence_ref)
      = (r.scope_snapshot_id, r.scope_snapshot_revision, r.policy_authority_ref, r.credential_generation)
JOIN scope_access_grant g ON (g.snapshot_id, g.snapshot_revision, g.principal_ref, g.credential_generation, g.authorization_receipt_ref,
  g.policy_authority_ref)
      = (s.snapshot_id, s.revision, r.principal_ref, r.credential_generation, r.authorization_receipt_ref, r.policy_authority_ref)
JOIN project_client_grant_current c ON c.project_id=json_extract(s.resolved_scope_expression_json,'$.project_id')
JOIN project p ON p.project_id=c.project_id
JOIN project_owner o ON (o.project_id, o.principal_ref)
      = (p.project_id, c.grantor_principal_ref)
WHERE json_extract(s.resolved_scope_expression_json,'$.kind')='PROJECT'
  AND (c.grantee_method, c.state)
      = ('service_token', 'ACTIVE') AND julianday(c.expires_at)>julianday('now')
  AND g.state IN ('ACTIVE','EXPIRED')
  AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) WHERE value='research')
  AND (
    (g.client_class='owner_pwa' AND g.project_client_grant_id IS NULL
      AND r.principal_ref=c.grantor_principal_ref
      AND NOT EXISTS (SELECT 1 FROM scope_access_grant revoked
        WHERE (revoked.snapshot_id, revoked.snapshot_revision, revoked.principal_ref, revoked.client_class, revoked.state)
      = (s.snapshot_id, s.revision, r.principal_ref, 'owner_pwa', 'REVOKED')))
    OR (g.client_class IN ('trusted_agent','named_api_client') AND (r.principal_ref, g.project_client_grant_id, g.project_client_grant_revision,
      g.project_client_project_generation, g.project_client_operation, g.project_client_run_operation_id)
      = (c.grantee_subject, c.grant_id, c.revision, p.generation, 'run', r.operation_id)
      AND EXISTS (SELECT 1 FROM json_each(c.record_json,'$.allowed_operations') WHERE value='run')
      AND EXISTS (SELECT 1 FROM orientation_request e
        WHERE (e.execution_operation_id, e.state, e.execution_client_grant_id, e.execution_client_grant_revision, e.principal_ref, e.client_class,
          e.credential_generation, e.snapshot_id, e.snapshot_revision)
      = (r.operation_id, 'COMPLETE', c.grant_id, c.revision, r.principal_ref, g.client_class, r.credential_generation, s.snapshot_id, s.revision)
          AND julianday(e.expires_at)<=julianday(e.created_at)+1
          AND julianday(g.expires_at)<=julianday(e.expires_at)
          AND json_extract(e.result_json,'$.execution.operation_id')=r.operation_id
          AND json_extract(e.result_json,'$.execution.deadline')=e.expires_at))
  );

DROP VIEW project_client_artifact_read_origin;
CREATE VIEW project_client_artifact_read_origin AS
SELECT b.artifact_id, b.revision AS artifact_revision, b.principal_ref,
  b.scope_snapshot_id, b.scope_snapshot_revision, d.grant_id AS client_grant_id,
  d.revision AS client_grant_revision, p.generation AS project_generation,
  'owner_pwa' AS origin_client_class
FROM artifact_draft_binding b
JOIN artifact_revision a ON (a.artifact_id, a.revision, a.status)
      = (b.artifact_id, b.revision, 'DRAFT')
JOIN scope_snapshot s ON (s.snapshot_id, s.revision)
      = (b.scope_snapshot_id, b.scope_snapshot_revision)
JOIN project_client_grant_current d ON d.project_id=json_extract(s.resolved_scope_expression_json,'$.project_id')
JOIN project p ON p.project_id=d.project_id
JOIN project_owner po ON (po.project_id, po.principal_ref)
      = (p.project_id, d.grantor_principal_ref)
WHERE json_extract(s.resolved_scope_expression_json,'$.kind')='PROJECT'
  AND (d.state, d.grantee_method)
      = ('ACTIVE', 'service_token') AND julianday(d.expires_at)>julianday('now')
  AND b.principal_ref=d.grantor_principal_ref
  AND EXISTS (SELECT 1 FROM scope_access_grant og WHERE (og.snapshot_id, og.snapshot_revision, og.principal_ref, og.client_class)
      = (s.snapshot_id, s.revision, b.principal_ref, 'owner_pwa') AND og.project_client_grant_id IS NULL
    AND og.policy_authority_ref=s.policy_authority_ref AND og.state IN ('ACTIVE','EXPIRED'))
  AND NOT EXISTS (SELECT 1 FROM scope_access_grant og WHERE (og.snapshot_id, og.snapshot_revision, og.principal_ref, og.client_class, og.state)
      = (s.snapshot_id, s.revision, b.principal_ref, 'owner_pwa', 'REVOKED'))
UNION ALL
SELECT b.artifact_id, b.revision, b.principal_ref, b.scope_snapshot_id, b.scope_snapshot_revision,
  r.client_grant_id, r.client_grant_revision, r.project_generation, r.origin_client_class
FROM artifact_draft_binding b
JOIN artifact_revision a ON (a.artifact_id, a.revision, a.status)
      = (b.artifact_id, b.revision, 'DRAFT')
JOIN project_client_run_control_origin r ON (r.scope_snapshot_id, r.scope_snapshot_revision, r.principal_ref)
      = (b.scope_snapshot_id, b.scope_snapshot_revision, b.principal_ref)
JOIN research_report_admission admission ON (admission.operation_id, admission.intent_id, admission.intent_revision, admission.principal_ref,
  admission.client_class, admission.credential_generation, admission.scope_snapshot_id, admission.scope_snapshot_revision,
  admission.policy_authority_ref, admission.authorization_receipt_ref, admission.deployment_generation)
      = (r.operation_id, b.intent_id, b.intent_revision, b.principal_ref, r.origin_client_class, r.credential_generation, r.scope_snapshot_id,
        r.scope_snapshot_revision, r.policy_authority_ref, r.authorization_receipt_ref, r.deployment_generation)
WHERE r.origin_client_class IN ('trusted_agent','named_api_client')
  AND EXISTS (SELECT 1 FROM research_workflow_run saved WHERE saved.operation_id=r.operation_id
    AND saved.state IN ('ACTIVE','ENGINE_COMPLETED'))
  AND NOT EXISTS (SELECT 1 FROM scope_access_grant og WHERE (og.snapshot_id, og.snapshot_revision, og.principal_ref, og.client_class, og.state)
      = (b.scope_snapshot_id, b.scope_snapshot_revision, b.principal_ref, r.origin_client_class, 'REVOKED'));

DROP VIEW owner_machine_run_origin;
CREATE VIEW owner_machine_run_origin AS
SELECT w.operation_id, w.investigation_id, w.principal_ref, w.credential_generation,
  w.deployment_generation, w.handler_generation, w.scope_snapshot_id, w.scope_snapshot_revision,
  w.policy_authority_ref, w.authorization_receipt_ref, g.client_class AS origin_client_class,
  d.grantor_principal_ref AS reader_principal_ref, d.project_id, p.generation AS project_generation,
  d.grant_id AS client_grant_id, d.revision AS client_grant_revision,
  d.record_sha256 AS grant_record_sha256, d.spend_policy_sha256,
  d.spend_deployment_generation, d.spend_expires_at, e.expires_at AS execution_deadline
FROM research_workflow_run w
JOIN scope_snapshot s ON (s.snapshot_id, s.revision, s.client_fence_ref, s.policy_authority_ref)
      = (w.scope_snapshot_id, w.scope_snapshot_revision, w.credential_generation, w.policy_authority_ref)
JOIN scope_access_grant g ON (g.project_client_run_operation_id, g.project_client_operation, g.snapshot_id, g.snapshot_revision, g.principal_ref,
  g.credential_generation, g.policy_authority_ref, g.authorization_receipt_ref)
      = (w.operation_id, 'run', s.snapshot_id, s.revision, w.principal_ref, w.credential_generation, w.policy_authority_ref,
        w.authorization_receipt_ref)
JOIN project_client_grant d ON (d.grant_id, d.revision, d.grantee_subject, d.grantee_method, d.state)
      = (g.project_client_grant_id, g.project_client_grant_revision, g.principal_ref, 'service_token', 'ACTIVE')
JOIN project p ON p.project_id=d.project_id
JOIN project_owner po ON (po.project_id, po.principal_ref)
      = (p.project_id, d.grantor_principal_ref)
JOIN orientation_request e ON (e.execution_operation_id, e.state, e.execution_client_grant_id, e.execution_client_grant_revision, e.principal_ref,
  e.client_class, e.credential_generation, e.snapshot_id, e.snapshot_revision)
      = (w.operation_id, 'COMPLETE', d.grant_id, d.revision, w.principal_ref, g.client_class, w.credential_generation, s.snapshot_id, s.revision)
WHERE g.client_class IN ('trusted_agent','named_api_client') AND w.state IN ('ACTIVE','ENGINE_COMPLETED','CANCELLED')
  AND (s.invalidated_at IS NULL OR s.invalidation_reason IN ('SCOPE_INPUT_CHANGED','CLIENT_DELEGATION_STALE'))
  AND json_extract(s.resolved_scope_expression_json,'$.kind')='PROJECT'
  AND json_extract(s.resolved_scope_expression_json,'$.project_id')=d.project_id
  AND EXISTS (SELECT 1 FROM json_each(d.record_json,'$.allowed_operations') WHERE value='run')
  AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) WHERE value='research')
  AND julianday(e.expires_at)>julianday(e.created_at) AND julianday(e.expires_at)<=julianday(e.created_at)+1
  AND julianday(g.expires_at)<=julianday(e.expires_at)
  AND json_extract(e.result_json,'$.execution.operation_id')=w.operation_id
  AND json_extract(e.result_json,'$.execution.deadline')=e.expires_at
  AND NOT EXISTS (SELECT 1 FROM json_each(s.member_source_revision_refs_json) member WHERE NOT EXISTS (
    SELECT 1 FROM source_revision sr JOIN project_source_membership m ON m.source_id=sr.source_id
    WHERE (sr.source_revision_ref, m.project_id)
      = (member.value, p.project_id)
      AND julianday(m.valid_from)<=julianday('now') AND (m.valid_to IS NULL OR julianday(m.valid_to)>julianday('now'))));

DROP TRIGGER research_model_spend_admission_w2_guard;
CREATE TRIGGER research_model_spend_admission_w2_guard
BEFORE INSERT ON research_model_spend_admission
BEGIN
  SELECT RAISE(ABORT, 'MODEL_SPEND_ADMISSION_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1
    FROM research_workflow_current r
    JOIN research_workflow_attempt a
      ON (a.operation_id, a.stage_index)
      = (r.operation_id, NEW.stage_index)
    JOIN scope_access_grant g
      ON (g.snapshot_id, g.snapshot_revision, g.principal_ref)
      = (r.scope_snapshot_id, r.scope_snapshot_revision, r.principal_ref)
    WHERE (r.operation_id, r.state, r.next_stage_index, r.current_revision, r.ledger_revision, a.state)
      = (NEW.workflow_operation_id, 'ACTIVE', NEW.stage_index, a.expected_revision, a.expected_revision, 'STARTED')
      AND a.output_json IS NULL
      AND (a.attempt_ref, a.request_sha256, a.budget_receipt_ref)
      = (NEW.stage_attempt_ref, NEW.stage_request_sha256, NEW.workflow_budget_receipt_ref)
      AND json_extract(a.request_json, '$.protocol') IS 'eliotr.workflow-stage.v1'
      AND json_extract(a.request_json, '$.operation_id') IS r.operation_id
      AND json_extract(a.request_json, '$.stage') IS CASE NEW.stage_index
        WHEN 12 THEN 'SYNTHESIZE' WHEN 13 THEN 'VERIFY' WHEN 14 THEN 'AUDIT_CLAIMS' END
      AND json_extract(a.request_json, '$.investigation_ref.id') IS r.investigation_id
      AND json_extract(a.request_json, '$.investigation_ref.revision') IS r.current_revision
      AND json_extract(a.request_json, '$.idempotency_key') IS r.idempotency_key
      AND json_extract(a.request_json, '$.handler_generation') IS r.handler_generation
      AND (r.principal_ref, r.credential_generation, r.deployment_generation, r.policy_generation, r.scope_snapshot_id, r.scope_snapshot_revision,
        r.authorization_receipt_ref, g.client_class, g.credential_generation, g.policy_authority_ref, g.authorization_receipt_ref, g.state)
      = (NEW.principal_ref, NEW.credential_generation, NEW.deployment_generation, NEW.policy_generation, NEW.scope_snapshot_id,
        NEW.scope_snapshot_revision, NEW.workflow_authorization_receipt_ref, NEW.client_class, NEW.credential_generation, r.policy_authority_ref,
        NEW.workflow_authorization_receipt_ref, 'ACTIVE')
      AND julianday(g.expires_at) > julianday('now')
      AND json_type(g.allowed_use_json) = 'array'
      AND EXISTS (
        SELECT 1 FROM json_each(g.allowed_use_json) u
        WHERE (u.type, u.value)
      = ('text', 'research')
      )
  );
END;

DROP TRIGGER research_report_admission_current_guard;
CREATE TRIGGER research_report_admission_current_guard
BEFORE INSERT ON research_report_admission
WHEN NOT EXISTS (
  SELECT 1
  FROM research_workflow_current r
  JOIN scope_snapshot s ON (s.snapshot_id, s.revision)
      = (r.scope_snapshot_id, r.scope_snapshot_revision)
  WHERE (r.operation_id, r.state, r.next_stage_index, r.principal_ref, r.credential_generation, r.policy_generation, r.policy_authority_ref,
    r.deployment_generation, r.scope_snapshot_id, r.scope_snapshot_revision, s.snapshot_digest)
      = (NEW.operation_id, 'ACTIVE', 17, NEW.principal_ref, NEW.credential_generation, NEW.policy_generation, NEW.policy_authority_ref,
        NEW.deployment_generation, NEW.scope_snapshot_id, NEW.scope_snapshot_revision, NEW.scope_snapshot_digest)
    AND julianday(s.expires_at) > julianday('now')
    AND julianday(NEW.expires_at) > julianday('now')
    AND julianday(NEW.policy_expires_at) > julianday('now')
    AND CAST(json_extract(NEW.input_json, '$.workflow_revision') AS INTEGER) = r.current_revision
    AND NEW.client_class IN ('owner_pwa','trusted_agent','named_api_client')
    AND EXISTS (
      SELECT 1
      FROM scope_access_grant_effective g
      WHERE (g.snapshot_id, g.snapshot_revision, g.principal_ref, g.client_class)
      = (r.scope_snapshot_id, r.scope_snapshot_revision, r.principal_ref, NEW.client_class)
        AND ((NEW.client_class='owner_pwa' AND g.project_client_grant_id IS NULL)
          OR ((g.project_client_operation, g.project_client_run_operation_id)
      = ('run', NEW.operation_id)
            AND json_extract(NEW.policy_json,'$.schema')='eliotr.research.delegated-report-admission.v1'))
        AND (g.credential_generation, g.policy_authority_ref, g.authorization_receipt_ref, g.disclosure_ceiling, g.state)
      = (r.credential_generation, r.policy_authority_ref, NEW.authorization_receipt_ref, NEW.disclosure_ceiling, 'ACTIVE')
        AND julianday(g.expires_at) > julianday('now')
    )
    AND json(s.member_source_revision_refs_json) = json(NEW.source_revision_refs_json)
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(NEW.source_revision_refs_json) wanted
      WHERE NOT EXISTS (
        SELECT 1
        FROM source_revision sr
        JOIN source src ON src.source_id = sr.source_id
        JOIN source_namespace_ownership own
          ON (own.source_namespace_id, own.status, own.source_owner_generation)
      = (src.source_namespace_id, 'ACTIVE', sr.source_owner_generation)
        JOIN json_each(s.source_owner_generations_json) gen
          ON (gen.key, gen.value)
      = (sr.source_revision_ref, sr.source_owner_generation)
        JOIN source_admission_decision sad
          ON (sad.source_revision_ref, sad.decision)
      = (sr.source_revision_ref, 'ADMITTED')
        WHERE (sr.source_revision_ref, sr.purge_state)
      = (wanted.value, 'LIVE')
          AND json_type(sad.allowed_use_json) = 'array'
          AND EXISTS (SELECT 1 FROM json_each(sad.allowed_use_json) u WHERE (u.type, u.value)
      = ('text', 'research'))
          AND sad.disclosure_ceiling = NEW.disclosure_ceiling
          AND (sad.expires_at IS NULL OR julianday(sad.expires_at) > julianday('now'))
      )
    )
)
BEGIN SELECT RAISE(ABORT, 'REPORT_ADMISSION_AUTHORITY_STALE'); END;

DROP TRIGGER research_workflow_checkpoint_guard;
CREATE TRIGGER research_workflow_checkpoint_guard BEFORE INSERT ON research_workflow_checkpoint
BEGIN
 -- These lookups bind the same unique operation/stage/event rows in one atomic statement.
 -- Check current authority separately so receipt predicates do not deepen its expression tree.
 SELECT RAISE(ABORT, 'WORKFLOW_AUTHORITY_STALE') WHERE NOT EXISTS (
   SELECT 1 FROM research_workflow_current WHERE operation_id=NEW.operation_id
 );
 SELECT RAISE(ABORT, 'WORKFLOW_AUTHORITY_STALE') WHERE NOT EXISTS (
   SELECT 1 FROM research_workflow_run r JOIN research_workflow_attempt a
     ON a.operation_id=r.operation_id AND a.stage_index=NEW.stage_index
   WHERE r.operation_id=NEW.operation_id AND (a.budget_expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
   OR EXISTS (
     SELECT 1 FROM research_workflow_recovery_authorized recovery
     WHERE recovery.operation_id=NEW.operation_id AND recovery.stage_index=NEW.stage_index
       AND recovery.principal_ref=r.principal_ref
   ))
 );
 SELECT RAISE(ABORT, 'WORKFLOW_AUTHORITY_STALE') WHERE NOT EXISTS (
 SELECT 1 FROM research_workflow_run r
 JOIN investigation_ledger_head h ON h.investigation_id=r.investigation_id
 JOIN research_workflow_attempt a ON a.operation_id = r.operation_id AND a.stage_index = NEW.stage_index
 JOIN investigation_ledger_event e ON e.event_id = NEW.ledger_event_id
 WHERE r.operation_id = NEW.operation_id AND r.state = 'ACTIVE' AND r.next_stage_index = NEW.stage_index
 AND a.state = 'OUTPUT_RECORDED' AND a.request_sha256 = NEW.request_sha256
 AND r.current_revision = a.expected_revision AND h.revision = a.expected_revision + 1
 AND e.investigation_id = r.investigation_id AND e.sequence = h.event_head AND e.kind = 'CHECKPOINT'
 AND e.actor_ref = r.principal_ref AND e.verifier_ref IS NULL
 AND e.payload_handle_ref = json_extract(a.output_json, '$.object_ref')
 AND e.payload_digest = json_extract(a.output_json, '$.sha256')
 AND NEW.ledger_event_id = 'wcp:' || NEW.request_sha256
 AND json_extract(NEW.receipt_json, '$.protocol') = 'eliotr.workflow-checkpoint.v1'
 AND json_extract(NEW.receipt_json, '$.operation_id') = r.operation_id
 AND json_extract(NEW.receipt_json, '$.request_sha256') = a.request_sha256
 AND json_extract(NEW.receipt_json, '$.stage') = json_extract(a.request_json, '$.stage')
 AND json_extract(NEW.receipt_json, '$.attempt_ref') = a.attempt_ref
 AND json_extract(NEW.receipt_json, '$.receipt_ref') = 'wcp:' || NEW.request_sha256
 AND json_extract(NEW.receipt_json, '$.investigation_ref.id') = r.investigation_id
 AND json_extract(NEW.receipt_json, '$.investigation_ref.revision') = h.revision
 AND json_extract(NEW.receipt_json, '$.input_manifest_ref') = json_extract(a.request_json, '$.input_manifest.object_ref')
 AND json_extract(NEW.receipt_json, '$.output_manifest') = a.output_json
 AND json_extract(NEW.receipt_json, '$.budget_receipt_ref') = a.budget_receipt_ref
 AND json_extract(NEW.receipt_json, '$.cancellation_checked_at') = NEW.created_at
 AND json_extract(NEW.receipt_json, '$.engine_state') = CASE WHEN NEW.stage_index = 17 THEN 'ENGINE_COMPLETED' ELSE 'CHECKPOINTED' END
 );
END;
