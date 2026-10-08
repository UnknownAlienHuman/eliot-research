-- Versioned owner sponsorship and immutable qualification revocation.
-- Historical NULL sponsorship protocol means v1; existing records are not rewritten.
ALTER TABLE project_client_grant ADD COLUMN spend_policy_protocol TEXT;

-- Keep ADD COLUMN metadata-only for ADR9. Preserve NULL as the historical v1
-- encoding and permit only the two versioned sponsorship contracts on inserts.
CREATE TRIGGER project_client_grant_spend_protocol_insert_guard
BEFORE INSERT ON project_client_grant
WHEN NEW.spend_policy_protocol IS NOT NULL AND NEW.spend_policy_protocol NOT IN (
  'eliotr.research-owner-spend-template.v1','eliotr.research-owner-spend-template.v2')
BEGIN SELECT RAISE(ABORT,'CLIENT_GRANT_SPEND_DENIED'); END;

-- project_client_grant is append-only; make the newly-added authority field's
-- immutability explicit as well as retaining the table-wide legacy guard.
CREATE TRIGGER project_client_grant_spend_protocol_update_guard
BEFORE UPDATE OF spend_policy_protocol ON project_client_grant
BEGIN SELECT RAISE(ABORT,'CLIENT_GRANT_IMMUTABLE'); END;

CREATE TABLE dynamic_route_qualification_revocation (
  qualification_ref TEXT NOT NULL CHECK(length(qualification_ref) BETWEEN 1 AND 256),
  qualification_sha256 TEXT NOT NULL CHECK(length(qualification_sha256)=64 AND qualification_sha256 NOT GLOB '*[^0-9a-f]*'),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1024),
  revoked_by TEXT NOT NULL CHECK(length(revoked_by) BETWEEN 1 AND 256),
  revoked_at TEXT NOT NULL CHECK(julianday(revoked_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',revoked_at) IS revoked_at),
  PRIMARY KEY(qualification_ref,qualification_sha256)
) STRICT, WITHOUT ROWID;
CREATE INDEX dynamic_route_qualification_revocation_sha_idx
  ON dynamic_route_qualification_revocation(qualification_ref,qualification_sha256);
CREATE TRIGGER dynamic_route_qualification_revocation_guard BEFORE INSERT ON dynamic_route_qualification_revocation
WHEN NOT EXISTS (SELECT 1 FROM dynamic_route_qualification_proof p
  WHERE p.qualification_ref=NEW.qualification_ref AND p.proof_sha256=NEW.qualification_sha256
    AND json_extract(p.qualification_json,'$.qualification.tier')='LIVE')
BEGIN SELECT RAISE(ABORT,'DYNAMIC_ROUTE_QUALIFICATION_INVALID'); END;
CREATE TRIGGER dynamic_route_qualification_revocation_immutable BEFORE UPDATE ON dynamic_route_qualification_revocation
BEGIN SELECT RAISE(ABORT,'DYNAMIC_ROUTE_QUALIFICATION_IMMUTABLE'); END;
CREATE TRIGGER dynamic_route_qualification_revocation_no_delete BEFORE DELETE ON dynamic_route_qualification_revocation
BEGIN SELECT RAISE(ABORT,'DYNAMIC_ROUTE_QUALIFICATION_IMMUTABLE'); END;

DROP TRIGGER project_client_grant_spend_guard;
CREATE TRIGGER project_client_grant_spend_guard BEFORE INSERT ON project_client_grant
BEGIN
  SELECT RAISE(ABORT,'CLIENT_GRANT_SPEND_DENIED') WHERE NOT (
    (json_type(NEW.record_json,'$.spend_policy_ref') IS NULL AND NEW.spend_policy_protocol IS NULL
      AND NEW.spend_policy_sha256 IS NULL AND NEW.spend_deployment_generation IS NULL AND NEW.spend_expires_at IS NULL)
    OR (json_type(NEW.record_json,'$.spend_policy_ref') IS 'text'
      AND length(json_extract(NEW.record_json,'$.spend_policy_ref')) BETWEEN 1 AND 256
      AND NEW.spend_policy_sha256 IS NOT NULL AND NEW.spend_expires_at IS NOT NULL
      AND julianday(NEW.expires_at)<=julianday(NEW.spend_expires_at)
      AND EXISTS (SELECT 1 FROM json_each(NEW.record_json,'$.allowed_operations') WHERE value IN ('run','recover'))
      AND ((COALESCE(NEW.spend_policy_protocol,'eliotr.research-owner-spend-template.v1')='eliotr.research-owner-spend-template.v1'
            AND NEW.spend_deployment_generation IS NOT NULL)
        OR (NEW.spend_policy_protocol='eliotr.research-owner-spend-template.v2'
            AND NEW.spend_deployment_generation IS NULL))));
  SELECT RAISE(ABORT,'CLIENT_GRANT_SPEND_DENIED') WHERE NEW.state='ACTIVE' AND NEW.spend_expires_at IS NOT NULL
    AND julianday(NEW.spend_expires_at)<=julianday('now');
  SELECT RAISE(ABORT,'CLIENT_GRANT_SPEND_DENIED') WHERE NEW.state='REVOKED' AND NOT EXISTS (
    SELECT 1 FROM project_client_grant p WHERE p.grant_id=NEW.grant_id AND p.revision=NEW.revision-1
      AND p.spend_policy_sha256 IS NEW.spend_policy_sha256
      AND p.spend_deployment_generation IS NEW.spend_deployment_generation
      AND p.spend_expires_at IS NEW.spend_expires_at
      AND COALESCE(p.spend_policy_protocol,'eliotr.research-owner-spend-template.v1')
        IS COALESCE(NEW.spend_policy_protocol,'eliotr.research-owner-spend-template.v1')
      AND json_extract(p.record_json,'$.spend_policy_ref') IS json_extract(NEW.record_json,'$.spend_policy_ref'));
END;

UPDATE schema_state SET value='project-client-spend-v2',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE key='project_client_spend_generation';

DROP TRIGGER client_execution_reservation_insert;
CREATE TRIGGER client_execution_reservation_insert BEFORE INSERT ON orientation_request
WHEN (NEW.client_class='owner_pwa' AND (NEW.execution_client_grant_id IS NOT NULL OR NEW.execution_client_grant_revision IS NOT NULL))
 OR (NEW.client_class<>'owner_pwa' AND (NEW.execution_operation_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM project_client_grant_current d JOIN project p ON p.project_id=d.project_id
  JOIN project_owner po ON po.project_id=d.project_id AND po.principal_ref=d.grantor_principal_ref
  WHERE d.grant_id=NEW.execution_client_grant_id AND d.revision=NEW.execution_client_grant_revision
   AND d.grantee_subject=NEW.principal_ref AND d.grantee_method='service_token' AND d.state='ACTIVE'
   AND EXISTS(SELECT 1 FROM json_each(d.record_json,'$.allowed_operations') WHERE value='run')
   AND d.spend_policy_sha256 IS NOT NULL
   AND ((COALESCE(d.spend_policy_protocol,'eliotr.research-owner-spend-template.v1')='eliotr.research-owner-spend-template.v1'
         AND d.spend_deployment_generation IS NOT NULL)
     OR (d.spend_policy_protocol='eliotr.research-owner-spend-template.v2' AND d.spend_deployment_generation IS NULL))
   AND julianday(d.expires_at)>julianday('now') AND julianday(d.spend_expires_at)>julianday('now')
  )))
BEGIN SELECT RAISE(ABORT,'CLIENT_RUN_AUTHORITY_STALE'); END;

DROP TRIGGER client_execution_investigation_ledger_head_guard;
CREATE TRIGGER client_execution_investigation_ledger_head_guard BEFORE INSERT ON investigation_ledger_head
WHEN EXISTS(SELECT 1 FROM scope_access_grant WHERE snapshot_id=NEW.scope_snapshot_id
 AND snapshot_revision=NEW.scope_snapshot_revision AND project_client_grant_id IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM scope_access_grant_effective g JOIN orientation_request e
 ON e.execution_operation_id=g.project_client_run_operation_id
 JOIN project_client_grant_current d ON d.grant_id=g.project_client_grant_id AND d.revision=g.project_client_grant_revision
 WHERE g.snapshot_id=NEW.scope_snapshot_id AND g.snapshot_revision=NEW.scope_snapshot_revision
 AND g.principal_ref=NEW.principal_ref AND g.project_client_operation='run'
 AND g.policy_authority_ref=NEW.policy_authority_ref
 AND ((COALESCE(d.spend_policy_protocol,'eliotr.research-owner-spend-template.v1')='eliotr.research-owner-spend-template.v1'
       AND d.spend_deployment_generation=NEW.deployment_generation)
   OR (d.spend_policy_protocol='eliotr.research-owner-spend-template.v2' AND d.spend_deployment_generation IS NULL))
 AND e.state='COMPLETE' AND e.snapshot_id=g.snapshot_id AND e.snapshot_revision=g.snapshot_revision)
BEGIN SELECT RAISE(ABORT,'CLIENT_RUN_AUTHORITY_STALE'); END;

DROP TRIGGER client_execution_research_workflow_run_guard;
CREATE TRIGGER client_execution_research_workflow_run_guard BEFORE INSERT ON research_workflow_run
WHEN EXISTS(SELECT 1 FROM scope_access_grant WHERE snapshot_id=NEW.scope_snapshot_id
 AND snapshot_revision=NEW.scope_snapshot_revision AND project_client_grant_id IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM scope_access_grant_effective g JOIN orientation_request e
 ON e.execution_operation_id=g.project_client_run_operation_id
 JOIN project_client_grant_current d ON d.grant_id=g.project_client_grant_id AND d.revision=g.project_client_grant_revision
 WHERE g.snapshot_id=NEW.scope_snapshot_id AND g.snapshot_revision=NEW.scope_snapshot_revision
 AND g.principal_ref=NEW.principal_ref AND g.project_client_operation='run'
 AND g.project_client_run_operation_id=NEW.operation_id AND g.credential_generation=NEW.credential_generation
 AND g.policy_authority_ref=NEW.policy_authority_ref
 AND ((COALESCE(d.spend_policy_protocol,'eliotr.research-owner-spend-template.v1')='eliotr.research-owner-spend-template.v1'
       AND d.spend_deployment_generation=NEW.deployment_generation)
   OR (d.spend_policy_protocol='eliotr.research-owner-spend-template.v2' AND d.spend_deployment_generation IS NULL))
 AND e.state='COMPLETE' AND e.snapshot_id=g.snapshot_id AND e.snapshot_revision=g.snapshot_revision)
BEGIN SELECT RAISE(ABORT,'CLIENT_RUN_AUTHORITY_STALE'); END;

DROP VIEW research_workflow_recovery_authorized;
DROP VIEW project_client_run_control_origin;
DROP VIEW owner_machine_run_origin;
DROP VIEW research_workflow_current;
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
LEFT JOIN project_client_grant_current d ON (d.grant_id, d.revision, e.execution_client_grant_id, e.execution_client_grant_revision)
      = (eg.project_client_grant_id, eg.project_client_grant_revision, d.grant_id, d.revision)
  AND ((COALESCE(d.spend_policy_protocol,'eliotr.research-owner-spend-template.v1')='eliotr.research-owner-spend-template.v1' AND d.spend_deployment_generation=r.deployment_generation)
    OR (d.spend_policy_protocol='eliotr.research-owner-spend-template.v2' AND d.spend_deployment_generation IS NULL))
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

CREATE VIEW project_client_run_control_origin AS
SELECT r.operation_id, r.investigation_id, r.principal_ref, r.credential_generation,
  r.deployment_generation, r.handler_generation, r.scope_snapshot_id, r.scope_snapshot_revision,
  r.policy_authority_ref, r.authorization_receipt_ref, g.client_class AS origin_client_class,
  c.grant_id AS client_grant_id, c.revision AS client_grant_revision, c.project_id,
  p.generation AS project_generation, c.grantor_principal_ref,
  c.grantee_issuer, c.grantee_method, c.grantee_subject, c.record_json AS grant_record_json,
  c.record_sha256 AS grant_record_sha256, c.spend_policy_protocol, c.spend_policy_sha256,
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

CREATE VIEW owner_machine_run_origin AS
SELECT w.operation_id, w.investigation_id, w.principal_ref, w.credential_generation,
  w.deployment_generation, w.handler_generation, w.scope_snapshot_id, w.scope_snapshot_revision,
  w.policy_authority_ref, w.authorization_receipt_ref, g.client_class AS origin_client_class,
  d.grantor_principal_ref AS reader_principal_ref, d.project_id, p.generation AS project_generation,
  d.grant_id AS client_grant_id, d.revision AS client_grant_revision,
  d.record_sha256 AS grant_record_sha256, d.spend_policy_protocol, d.spend_policy_sha256,
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
      AND ((COALESCE(c.spend_policy_protocol,'eliotr.research-owner-spend-template.v1')='eliotr.research-owner-spend-template.v1' AND c.spend_deployment_generation=r.deployment_generation) OR (c.spend_policy_protocol='eliotr.research-owner-spend-template.v2' AND c.spend_deployment_generation IS NULL))
      AND json_type(c.grant_record_json,'$.spend_policy_ref')='text'
      AND EXISTS (SELECT 1 FROM json_each(c.grant_record_json,'$.allowed_operations') WHERE value='recover')
      AND i.policy_decision_ref='research-client-recovery:' || c.grant_record_sha256 || ':' || c.project_generation || ':' || c.spend_policy_sha256
      AND i.budget_reservation_ref IS NULL
      AND current_run.operation_id IS NOT NULL)
 OR (o.operation_id IS NOT NULL AND (o.operation_id, o.reader_principal_ref)
      = (r.operation_id, i.principal_ref)
      AND o.spend_policy_sha256 IS NOT NULL AND julianday(o.spend_expires_at)>julianday('now')
      AND ((COALESCE(o.spend_policy_protocol,'eliotr.research-owner-spend-template.v1')='eliotr.research-owner-spend-template.v1' AND o.spend_deployment_generation=r.deployment_generation) OR (o.spend_policy_protocol='eliotr.research-owner-spend-template.v2' AND o.spend_deployment_generation IS NULL))
      AND julianday(o.execution_deadline)>julianday('now')
      AND i.budget_reservation_ref IS NULL
      AND i.policy_decision_ref='research-owner-machine-recovery:' || o.grant_record_sha256 || ':' || o.project_generation || ':' || o.spend_policy_sha256
      AND current_run.operation_id IS NOT NULL);


-- New snapshot runs resolve the exact deployment tuple persisted before Workflow.create.
-- Legacy rows retain the pre-0104 active-candidate/latest-proof path and expiry check.
DROP TRIGGER research_model_spend_admission_deployment_guard;
CREATE TRIGGER research_model_spend_admission_deployment_guard
BEFORE INSERT ON research_model_spend_admission
BEGIN
  SELECT RAISE(ABORT,'MODEL_SPEND_ADMISSION_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1 FROM research_workflow_run run
    LEFT JOIN research_run_configuration cfg ON cfg.operation_id=run.operation_id
      AND cfg.configuration_ref=run.configuration_ref
    WHERE run.operation_id=NEW.workflow_operation_id
      AND (
        (run.configuration_required=0 AND EXISTS (
          SELECT 1 FROM dynamic_route_active_generation active
          JOIN dynamic_route_candidate candidate ON candidate.candidate_ref=active.candidate_ref
            AND candidate.candidate_sha256=active.candidate_sha256
          LEFT JOIN dynamic_route_active_qualification latest ON latest.route_ref=active.route_ref
            AND latest.route_version=active.route_version
          LEFT JOIN dynamic_route_qualification_proof proof ON proof.qualification_ref=latest.qualification_ref
            AND proof.proof_sha256=latest.qualification_sha256 AND proof.route_ref=latest.route_ref
            AND proof.route_version=latest.route_version AND proof.candidate_ref=latest.candidate_ref
            AND proof.candidate_sha256=latest.candidate_sha256
          WHERE active.route_ref=NEW.route_ref
            AND active.route_version=json_extract(NEW.expected_deployment_json,'$.route_version')
            AND json_extract(candidate.candidate_json,'$.deployment.route_ref') IS NEW.route_ref
            AND json_extract(candidate.candidate_json,'$.deployment.route_version') IS json_extract(NEW.expected_deployment_json,'$.route_version')
            AND json_extract(candidate.candidate_json,'$.deployment.prompt_generation') IS json_extract(NEW.expected_deployment_json,'$.prompt_generation')
            AND json_extract(candidate.candidate_json,'$.deployment.schema_generation') IS json_extract(NEW.expected_deployment_json,'$.schema_generation')
            AND json_extract(candidate.candidate_json,'$.deployment.parameters_digest') IS json_extract(NEW.expected_deployment_json,'$.parameters_digest')
            AND json_extract(candidate.candidate_json,'$.deployment.pricing_snapshot_ref') IS json_extract(NEW.expected_deployment_json,'$.pricing_snapshot_ref')
            AND ((latest.route_ref IS NULL AND json_extract(candidate.candidate_json,'$.qualification_expires_at') IS NOT NULL
                  AND julianday(json_extract(candidate.candidate_json,'$.qualification_expires_at'))>julianday('now'))
              OR (latest.route_ref IS NOT NULL AND latest.candidate_ref IS active.candidate_ref
                  AND latest.candidate_sha256 IS active.candidate_sha256 AND proof.qualification_ref IS NOT NULL
                  AND json_extract(proof.qualification_json,'$.qualification.tier') IS 'LIVE'
                  AND json_extract(proof.qualification_json,'$.qualification.expires_at') IS NOT NULL
                  AND julianday(json_extract(proof.qualification_json,'$.qualification.expires_at'))>julianday('now')))
        ))
        OR (run.configuration_required=1 AND run.configuration_ref IS NOT NULL AND cfg.operation_id IS NOT NULL
          AND cfg.investigation_id=run.investigation_id AND cfg.principal_ref=run.principal_ref
          AND cfg.deployment_generation=run.deployment_generation
          AND EXISTS (
            SELECT 1 FROM json_each(cfg.configuration_json,'$.model_selections') selected
            JOIN dynamic_route_candidate candidate ON candidate.candidate_ref=json_extract(selected.value,'$.candidate_ref')
              AND candidate.candidate_sha256=json_extract(selected.value,'$.candidate_sha256')
              AND candidate.route_ref=json_extract(selected.value,'$.route_ref')
              AND candidate.route_version=json_extract(selected.value,'$.route_version')
            JOIN dynamic_route_qualification_proof proof ON proof.qualification_ref=json_extract(selected.value,'$.qualification_ref')
              AND proof.proof_sha256=json_extract(selected.value,'$.qualification_sha256')
              AND proof.route_ref=json_extract(selected.value,'$.route_ref')
              AND proof.route_version=json_extract(selected.value,'$.route_version')
              AND proof.candidate_ref=json_extract(selected.value,'$.candidate_ref')
              AND proof.candidate_sha256=json_extract(selected.value,'$.candidate_sha256')
            WHERE json_extract(selected.value,'$.stage')=json_extract(NEW.stage_request_json,'$.stage')
              AND json_extract(selected.value,'$.route_ref')=NEW.route_ref
              AND json_extract(selected.value,'$.route_version')=json_extract(NEW.expected_deployment_json,'$.route_version')
              AND json_extract(candidate.candidate_json,'$.deployment.route_ref') IS NEW.route_ref
              AND json_extract(candidate.candidate_json,'$.deployment.route_version') IS json_extract(NEW.expected_deployment_json,'$.route_version')
              AND json_extract(candidate.candidate_json,'$.deployment.prompt_generation') IS json_extract(NEW.expected_deployment_json,'$.prompt_generation')
              AND json_extract(candidate.candidate_json,'$.deployment.schema_generation') IS json_extract(NEW.expected_deployment_json,'$.schema_generation')
              AND json_extract(candidate.candidate_json,'$.deployment.parameters_digest') IS json_extract(NEW.expected_deployment_json,'$.parameters_digest')
              AND json_extract(candidate.candidate_json,'$.deployment.pricing_snapshot_ref') IS json_extract(NEW.expected_deployment_json,'$.pricing_snapshot_ref')
              AND json_extract(candidate.candidate_json,'$.qualification_tier') IS 'LIVE'
              AND json_extract(proof.qualification_json,'$.qualification.tier') IS 'LIVE'
              AND NOT EXISTS (SELECT 1 FROM dynamic_route_qualification_revocation revoked
                WHERE revoked.qualification_ref=json_extract(selected.value,'$.qualification_ref')
                  AND revoked.qualification_sha256=json_extract(selected.value,'$.qualification_sha256'))
              AND (cfg.mode='snapshot-v2' OR (cfg.mode='snapshot-v1'
                AND julianday(json_extract(proof.qualification_json,'$.qualification.expires_at'))>julianday('now')))
          ))
      )
  );
END;

-- Keep guard expressions individually below D1's expression-depth cap. These
-- independent checks preserve the legacy route path while snapshot pins use
-- only the immutable W2/W3 lineage and exact candidate/proof tuple.
DROP TRIGGER artifact_section_revise_spend_deployment_guard;

CREATE TRIGGER artifact_section_revise_spend_pin_shape_guard
BEFORE INSERT ON artifact_section_revise_spend_admission
WHEN json_type(NEW.request_json,'$.run_configuration') IS NOT NULL
 AND json_type(NEW.request_json,'$.run_configuration') IS NOT 'null'
 AND json_type(NEW.request_json,'$.run_configuration') IS NOT 'object'
BEGIN SELECT RAISE(ABORT,'ARTIFACT_COW_AUTHORITY_STALE'); END;

CREATE TRIGGER artifact_section_revise_spend_pin_witness_guard
BEFORE INSERT ON artifact_section_revise_spend_admission
BEGIN
  SELECT RAISE(ABORT,'ARTIFACT_COW_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1 FROM artifact_section_revise_run cow
    WHERE cow.operation_id=NEW.workflow_operation_id
      AND json_extract(NEW.request_json,'$.run_configuration') IS
          json_extract(cow.request_json,'$.report_admission_witness.material.run_configuration')
  );
END;

CREATE TRIGGER artifact_section_revise_spend_deployment_guard
BEFORE INSERT ON artifact_section_revise_spend_admission
WHEN json_type(NEW.request_json,'$.run_configuration') IS NULL
  OR json_type(NEW.request_json,'$.run_configuration')='null'
BEGIN
  SELECT RAISE(ABORT,'ARTIFACT_COW_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1 FROM dynamic_route_active_generation active
    JOIN dynamic_route_candidate candidate ON candidate.candidate_ref=active.candidate_ref
      AND candidate.candidate_sha256=active.candidate_sha256
    LEFT JOIN dynamic_route_active_qualification latest ON latest.route_ref=active.route_ref
      AND latest.route_version=active.route_version
    LEFT JOIN dynamic_route_qualification_proof proof ON proof.qualification_ref=latest.qualification_ref
      AND proof.proof_sha256=latest.qualification_sha256 AND proof.route_ref=latest.route_ref
      AND proof.route_version=latest.route_version AND proof.candidate_ref=latest.candidate_ref
      AND proof.candidate_sha256=latest.candidate_sha256
    WHERE active.route_ref=NEW.route_ref
      AND active.route_version=json_extract(NEW.expected_deployment_json,'$.route_version')
      AND json_extract(candidate.candidate_json,'$.deployment.route_ref') IS NEW.route_ref
      AND json_extract(candidate.candidate_json,'$.deployment.route_version') IS json_extract(NEW.expected_deployment_json,'$.route_version')
      AND json_extract(candidate.candidate_json,'$.deployment.prompt_generation') IS json_extract(NEW.expected_deployment_json,'$.prompt_generation')
      AND json_extract(candidate.candidate_json,'$.deployment.schema_generation') IS json_extract(NEW.expected_deployment_json,'$.schema_generation')
      AND json_extract(candidate.candidate_json,'$.deployment.parameters_digest') IS json_extract(NEW.expected_deployment_json,'$.parameters_digest')
      AND json_extract(candidate.candidate_json,'$.deployment.pricing_snapshot_ref') IS json_extract(NEW.expected_deployment_json,'$.pricing_snapshot_ref')
      AND ((latest.route_ref IS NULL AND json_extract(candidate.candidate_json,'$.qualification_expires_at') IS NOT NULL
          AND julianday(json_extract(candidate.candidate_json,'$.qualification_expires_at'))>julianday('now'))
        OR (latest.route_ref IS NOT NULL AND latest.candidate_ref IS active.candidate_ref
          AND latest.candidate_sha256 IS active.candidate_sha256 AND proof.qualification_ref IS NOT NULL
          AND json_extract(proof.qualification_json,'$.qualification.tier') IS 'LIVE'
          AND julianday(json_extract(proof.qualification_json,'$.qualification.expires_at'))>julianday('now')))
  );
END;

CREATE TRIGGER artifact_section_revise_spend_snapshot_association_guard
BEFORE INSERT ON artifact_section_revise_spend_admission
WHEN json_type(NEW.request_json,'$.run_configuration')='object'
BEGIN
  SELECT RAISE(ABORT,'ARTIFACT_COW_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1 FROM research_run_configuration cfg
    JOIN research_workflow_run run ON run.operation_id=cfg.operation_id
      AND run.configuration_ref=cfg.configuration_ref
    WHERE cfg.configuration_ref=json_extract(NEW.request_json,'$.run_configuration.configuration_ref')
      AND cfg.configuration_sha256=json_extract(NEW.request_json,'$.run_configuration.configuration_sha256')
      AND cfg.mode=json_extract(NEW.request_json,'$.run_configuration.mode')
      AND cfg.operation_id=json_extract(NEW.request_json,'$.run_configuration.operation_id')
      AND cfg.investigation_id=json_extract(NEW.request_json,'$.run_configuration.investigation_id')
      AND cfg.principal_ref=json_extract(NEW.request_json,'$.run_configuration.principal_ref')
      AND cfg.deployment_generation=json_extract(NEW.request_json,'$.run_configuration.deployment_generation')
      AND json_extract(cfg.configuration_json,'$.model_selections')=json_extract(NEW.request_json,'$.run_configuration.model_selections')
      AND json_extract(cfg.configuration_json,'$.project_configuration.configuration_ref') IS NOT NULL
      AND run.investigation_id=cfg.investigation_id AND run.principal_ref=cfg.principal_ref
      AND run.deployment_generation=cfg.deployment_generation AND run.principal_ref=(
        SELECT cow.principal_ref FROM artifact_section_revise_run cow
        WHERE cow.operation_id=NEW.workflow_operation_id)
  );
END;

CREATE TRIGGER artifact_section_revise_spend_snapshot_tuple_guard
BEFORE INSERT ON artifact_section_revise_spend_admission
WHEN json_type(NEW.request_json,'$.run_configuration')='object'
BEGIN
  SELECT RAISE(ABORT,'ARTIFACT_COW_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1 FROM research_run_configuration cfg
    JOIN json_each(cfg.configuration_json,'$.model_selections') selected
    JOIN dynamic_route_candidate candidate ON candidate.candidate_ref=json_extract(selected.value,'$.candidate_ref')
      AND candidate.candidate_sha256=json_extract(selected.value,'$.candidate_sha256')
      AND candidate.route_ref=json_extract(selected.value,'$.route_ref')
      AND candidate.route_version=json_extract(selected.value,'$.route_version')
    JOIN dynamic_route_qualification_proof proof ON proof.qualification_ref=json_extract(selected.value,'$.qualification_ref')
      AND proof.proof_sha256=json_extract(selected.value,'$.qualification_sha256')
      AND proof.route_ref=json_extract(selected.value,'$.route_ref') AND proof.route_version=json_extract(selected.value,'$.route_version')
      AND proof.candidate_ref=json_extract(selected.value,'$.candidate_ref')
      AND proof.candidate_sha256=json_extract(selected.value,'$.candidate_sha256')
    WHERE cfg.configuration_ref=json_extract(NEW.request_json,'$.run_configuration.configuration_ref')
      AND cfg.configuration_sha256=json_extract(NEW.request_json,'$.run_configuration.configuration_sha256')
      AND cfg.mode=json_extract(NEW.request_json,'$.run_configuration.mode')
      AND ((NEW.call_slot='SYNTHESIZE' AND json_extract(selected.value,'$.stage')='SYNTHESIZE')
        OR (NEW.call_slot IS NOT 'SYNTHESIZE' AND json_extract(selected.value,'$.stage')='AUDIT_CLAIMS'))
      AND json_extract(selected.value,'$.route_ref')=NEW.route_ref
      AND json_extract(selected.value,'$.route_version')=json_extract(NEW.expected_deployment_json,'$.route_version')
      AND json_extract(candidate.candidate_json,'$.deployment.route_ref') IS NEW.route_ref
      AND json_extract(candidate.candidate_json,'$.deployment.route_version') IS json_extract(NEW.expected_deployment_json,'$.route_version')
      AND json_extract(candidate.candidate_json,'$.deployment.prompt_generation') IS json_extract(NEW.expected_deployment_json,'$.prompt_generation')
      AND json_extract(candidate.candidate_json,'$.deployment.schema_generation') IS json_extract(NEW.expected_deployment_json,'$.schema_generation')
      AND json_extract(candidate.candidate_json,'$.deployment.parameters_digest') IS json_extract(NEW.expected_deployment_json,'$.parameters_digest')
      AND json_extract(candidate.candidate_json,'$.deployment.pricing_snapshot_ref') IS json_extract(NEW.expected_deployment_json,'$.pricing_snapshot_ref')
  );
END;

CREATE TRIGGER artifact_section_revise_spend_snapshot_currentness_guard
BEFORE INSERT ON artifact_section_revise_spend_admission
WHEN json_type(NEW.request_json,'$.run_configuration')='object'
BEGIN
  SELECT RAISE(ABORT,'ARTIFACT_COW_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1 FROM research_run_configuration cfg
    JOIN json_each(cfg.configuration_json,'$.model_selections') selected
    JOIN dynamic_route_candidate candidate ON candidate.candidate_ref=json_extract(selected.value,'$.candidate_ref')
      AND candidate.candidate_sha256=json_extract(selected.value,'$.candidate_sha256')
    JOIN dynamic_route_qualification_proof proof ON proof.qualification_ref=json_extract(selected.value,'$.qualification_ref')
      AND proof.proof_sha256=json_extract(selected.value,'$.qualification_sha256')
      AND proof.candidate_ref=json_extract(selected.value,'$.candidate_ref')
      AND proof.candidate_sha256=json_extract(selected.value,'$.candidate_sha256')
    WHERE cfg.configuration_ref=json_extract(NEW.request_json,'$.run_configuration.configuration_ref')
      AND cfg.configuration_sha256=json_extract(NEW.request_json,'$.run_configuration.configuration_sha256')
      AND cfg.mode=json_extract(NEW.request_json,'$.run_configuration.mode')
      AND ((NEW.call_slot='SYNTHESIZE' AND json_extract(selected.value,'$.stage')='SYNTHESIZE')
        OR (NEW.call_slot IS NOT 'SYNTHESIZE' AND json_extract(selected.value,'$.stage')='AUDIT_CLAIMS'))
      AND json_extract(selected.value,'$.route_ref')=NEW.route_ref
      AND json_extract(selected.value,'$.route_version')=json_extract(NEW.expected_deployment_json,'$.route_version')
      AND json_extract(candidate.candidate_json,'$.qualification_tier') IS 'LIVE'
      AND json_extract(proof.qualification_json,'$.qualification.tier') IS 'LIVE'
      AND NOT EXISTS (SELECT 1 FROM dynamic_route_qualification_revocation revoked
        WHERE revoked.qualification_ref=json_extract(selected.value,'$.qualification_ref')
          AND revoked.qualification_sha256=json_extract(selected.value,'$.qualification_sha256'))
      AND (cfg.mode='snapshot-v2' OR (cfg.mode='snapshot-v1'
        AND julianday(json_extract(proof.qualification_json,'$.qualification.expires_at'))>julianday('now')))
  );
END;
