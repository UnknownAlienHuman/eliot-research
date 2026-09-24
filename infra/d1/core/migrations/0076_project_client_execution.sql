-- S11: bind service execution to one immutable project delegation and approved sponsor.
-- Historical rows are copied exactly; no snapshot, budget, result or receipt is renewed.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE orientation_request_s11_copy AS SELECT "operation_id","principal_ref","client_class","credential_generation","idempotency_key","request_digest","state","snapshot_id","snapshot_revision","result_json","result_digest","created_at","expires_at","execution_operation_id" FROM orientation_request;

DROP TRIGGER orientation_request_identity_immutable;

DROP TRIGGER orientation_execution_scope_insert;

DROP TRIGGER orientation_execution_identity_immutable;

DROP TRIGGER orientation_execution_scope_bind;

DROP TRIGGER orientation_execution_scope_complete;

DROP TRIGGER orientation_execution_scope_no_delete;

DROP TABLE orientation_request;

CREATE TABLE orientation_request (
  operation_id TEXT PRIMARY KEY,
  principal_ref TEXT NOT NULL,
  client_class TEXT NOT NULL CHECK (client_class IN ('owner_pwa','trusted_agent','named_api_client')),
  credential_generation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  state TEXT NOT NULL CHECK (state IN ('PREPARED','COMPLETE','INVALIDATED')),
  snapshot_id TEXT,
  snapshot_revision INTEGER,
  result_json TEXT CHECK (result_json IS NULL OR (json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 450000)),
  result_digest TEXT CHECK (result_digest IS NULL OR length(result_digest) = 64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, execution_operation_id TEXT,
  execution_client_grant_id TEXT, execution_client_grant_revision INTEGER,
  UNIQUE(principal_ref, client_class, credential_generation, idempotency_key),
  FOREIGN KEY(snapshot_id, snapshot_revision) REFERENCES scope_snapshot(snapshot_id, revision),
  CHECK ((snapshot_id IS NULL) = (snapshot_revision IS NULL)),
  CHECK ((result_json IS NULL) = (result_digest IS NULL)),
  CHECK (state <> 'COMPLETE' OR (snapshot_id IS NOT NULL AND result_json IS NOT NULL))
) STRICT;

INSERT INTO orientation_request("operation_id","principal_ref","client_class","credential_generation","idempotency_key","request_digest","state","snapshot_id","snapshot_revision","result_json","result_digest","created_at","expires_at","execution_operation_id") SELECT "operation_id","principal_ref","client_class","credential_generation","idempotency_key","request_digest","state","snapshot_id","snapshot_revision","result_json","result_digest","created_at","expires_at","execution_operation_id" FROM orientation_request_s11_copy;

CREATE TABLE orientation_request_s11_guard(valid INTEGER NOT NULL CHECK(valid=1));

INSERT INTO orientation_request_s11_guard SELECT CASE WHEN
 (SELECT COUNT(*) FROM orientation_request_s11_copy)=(SELECT COUNT(*) FROM orientation_request)
 AND NOT EXISTS(SELECT "operation_id","principal_ref","client_class","credential_generation","idempotency_key","request_digest","state","snapshot_id","snapshot_revision","result_json","result_digest","created_at","expires_at","execution_operation_id" FROM orientation_request_s11_copy EXCEPT SELECT "operation_id","principal_ref","client_class","credential_generation","idempotency_key","request_digest","state","snapshot_id","snapshot_revision","result_json","result_digest","created_at","expires_at","execution_operation_id" FROM orientation_request)
 AND NOT EXISTS(SELECT "operation_id","principal_ref","client_class","credential_generation","idempotency_key","request_digest","state","snapshot_id","snapshot_revision","result_json","result_digest","created_at","expires_at","execution_operation_id" FROM orientation_request EXCEPT SELECT "operation_id","principal_ref","client_class","credential_generation","idempotency_key","request_digest","state","snapshot_id","snapshot_revision","result_json","result_digest","created_at","expires_at","execution_operation_id" FROM orientation_request_s11_copy) THEN 1 ELSE 0 END;

DROP TABLE orientation_request_s11_guard;

DROP TABLE orientation_request_s11_copy;

CREATE INDEX orientation_scope_idx ON orientation_request(snapshot_id, snapshot_revision);

CREATE TRIGGER orientation_request_identity_immutable
BEFORE UPDATE ON orientation_request
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.principal_ref IS NOT OLD.principal_ref
 OR NEW.client_class IS NOT OLD.client_class OR NEW.credential_generation IS NOT OLD.credential_generation
 OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.request_digest IS NOT OLD.request_digest
 OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
 OR (OLD.snapshot_id IS NOT NULL AND (NEW.snapshot_id IS NOT OLD.snapshot_id OR NEW.snapshot_revision IS NOT OLD.snapshot_revision))
 OR (OLD.state <> 'PREPARED' AND NEW.state <> 'INVALIDATED')
 OR (NEW.state = 'INVALIDATED' AND (NEW.result_json IS NOT NULL OR NEW.result_digest IS NOT NULL))
BEGIN
 SELECT RAISE(ABORT, 'orientation identity/result is immutable');
END;

CREATE UNIQUE INDEX orientation_execution_operation_idx
  ON orientation_request(execution_operation_id) WHERE execution_operation_id IS NOT NULL;

CREATE TRIGGER orientation_execution_scope_insert BEFORE INSERT ON orientation_request
WHEN NEW.execution_operation_id IS NOT NULL AND (
  length(NEW.execution_operation_id)<>52 OR substr(NEW.execution_operation_id,1,4)<>'run-'
  OR substr(NEW.execution_operation_id,5) GLOB '*[^0-9a-f]*'
  OR NEW.idempotency_key IS NOT ('research-execution:' || NEW.execution_operation_id)
  OR NEW.client_class NOT IN ('owner_pwa','trusted_agent','named_api_client') OR NEW.state<>'PREPARED' OR NEW.snapshot_id IS NOT NULL
  OR NEW.result_json IS NOT NULL
  OR julianday(NEW.created_at) IS NULL OR julianday(NEW.expires_at) IS NULL
  OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NOT NEW.created_at
  OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.expires_at) IS NOT NEW.expires_at
  OR julianday(NEW.expires_at)<=julianday(NEW.created_at)
  OR julianday(NEW.expires_at)>julianday(NEW.created_at)+1
)
BEGIN SELECT RAISE(ABORT,'RESEARCH_EXECUTION_SCOPE_INVALID'); END;

CREATE TRIGGER orientation_execution_identity_immutable BEFORE UPDATE ON orientation_request
WHEN NEW.execution_operation_id IS NOT OLD.execution_operation_id
BEGIN SELECT RAISE(ABORT,'RESEARCH_EXECUTION_SCOPE_IMMUTABLE'); END;

CREATE TRIGGER orientation_execution_scope_bind BEFORE UPDATE ON orientation_request
WHEN NEW.execution_operation_id IS NOT NULL AND NEW.snapshot_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM scope_snapshot s WHERE s.snapshot_id=NEW.snapshot_id AND s.revision=NEW.snapshot_revision
    AND s.created_at=NEW.created_at AND s.client_fence_ref=NEW.credential_generation
    AND julianday(s.expires_at)<=julianday(NEW.expires_at)
    AND julianday(s.expires_at)>julianday(s.created_at)
)
BEGIN SELECT RAISE(ABORT,'RESEARCH_EXECUTION_SCOPE_CONFLICT'); END;

CREATE TRIGGER orientation_execution_scope_complete BEFORE UPDATE ON orientation_request
WHEN NEW.execution_operation_id IS NOT NULL AND NEW.state='COMPLETE' AND (
  json_extract(NEW.result_json,'$.execution.operation_id') IS NOT NEW.execution_operation_id
  OR json_extract(NEW.result_json,'$.execution.deadline') IS NOT NEW.expires_at
  OR json_type(NEW.result_json,'$.execution.request_digest') IS NOT 'text'
  OR length(json_extract(NEW.result_json,'$.execution.request_digest'))<>64
  OR json_extract(NEW.result_json,'$.execution.request_digest') GLOB '*[^0-9a-f]*'
  OR json_extract(NEW.result_json,'$.result.evidence_pack.scope_snapshot_ref.id') IS NOT NEW.snapshot_id
  OR json_extract(NEW.result_json,'$.result.evidence_pack.scope_snapshot_ref.revision') IS NOT NEW.snapshot_revision
)
BEGIN SELECT RAISE(ABORT,'RESEARCH_EXECUTION_SCOPE_UNCONFIRMED'); END;

CREATE TRIGGER orientation_execution_scope_no_delete BEFORE DELETE ON orientation_request
WHEN OLD.execution_operation_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'RESEARCH_EXECUTION_SCOPE_IMMUTABLE'); END;

CREATE TRIGGER client_execution_reservation_insert BEFORE INSERT ON orientation_request
WHEN (NEW.client_class='owner_pwa' AND (NEW.execution_client_grant_id IS NOT NULL OR NEW.execution_client_grant_revision IS NOT NULL))
 OR (NEW.client_class<>'owner_pwa' AND (NEW.execution_operation_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM project_client_grant_current d JOIN project p ON p.project_id=d.project_id
  JOIN project_owner po ON po.project_id=d.project_id AND po.principal_ref=d.grantor_principal_ref
  WHERE d.grant_id=NEW.execution_client_grant_id AND d.revision=NEW.execution_client_grant_revision
   AND d.grantee_subject=NEW.principal_ref AND d.grantee_method='service_token' AND d.state='ACTIVE'
   AND EXISTS(SELECT 1 FROM json_each(d.record_json,'$.allowed_operations') WHERE value='run')
   AND d.spend_policy_sha256 IS NOT NULL AND d.spend_deployment_generation IS NOT NULL
   AND julianday(d.expires_at)>julianday('now') AND julianday(d.spend_expires_at)>julianday('now')
  )))
BEGIN SELECT RAISE(ABORT,'CLIENT_RUN_AUTHORITY_STALE'); END;

CREATE TRIGGER client_execution_reservation_immutable BEFORE UPDATE ON orientation_request
WHEN NEW.execution_client_grant_id IS NOT OLD.execution_client_grant_id
 OR NEW.execution_client_grant_revision IS NOT OLD.execution_client_grant_revision
BEGIN SELECT RAISE(ABORT,'RESEARCH_EXECUTION_SCOPE_IMMUTABLE'); END;

ALTER TABLE scope_access_grant ADD COLUMN project_client_run_operation_id TEXT;

CREATE UNIQUE INDEX client_execution_scope_idx ON scope_access_grant(project_client_run_operation_id) WHERE project_client_run_operation_id IS NOT NULL;

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
          SELECT 1 FROM artifact_draft_binding b
          JOIN artifact_revision a ON a.artifact_id=b.artifact_id AND a.revision=b.revision
          JOIN scope_snapshot original ON original.snapshot_id=b.scope_snapshot_id AND original.revision=b.scope_snapshot_revision
          WHERE b.artifact_id=g.project_client_artifact_id AND b.revision=g.project_client_artifact_revision
            AND b.principal_ref=d.grantor_principal_ref AND a.status='DRAFT'
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
            AND EXISTS (SELECT 1 FROM scope_access_grant og WHERE og.snapshot_id=original.snapshot_id
              AND og.snapshot_revision=original.revision AND og.principal_ref=b.principal_ref
              AND og.client_class='owner_pwa' AND og.project_client_grant_id IS NULL
              AND og.policy_authority_ref=original.policy_authority_ref AND og.state IN ('ACTIVE','EXPIRED'))
            AND NOT EXISTS (SELECT 1 FROM scope_access_grant og WHERE og.snapshot_id=original.snapshot_id
              AND og.snapshot_revision=original.revision AND og.principal_ref=b.principal_ref
              AND og.client_class='owner_pwa' AND og.state='REVOKED')
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

DROP VIEW research_workflow_current;

CREATE VIEW research_workflow_current AS
SELECT r.*, h.revision AS ledger_revision, h.checkpoint_head, h.event_head
FROM research_workflow_run r JOIN investigation_ledger_head h ON h.investigation_id = r.investigation_id
JOIN scope_snapshot s ON s.snapshot_id = r.scope_snapshot_id AND s.revision = r.scope_snapshot_revision
WHERE h.status = 'OPEN' AND h.principal_ref = r.principal_ref
  AND h.scope_snapshot_id = r.scope_snapshot_id AND h.scope_snapshot_revision = r.scope_snapshot_revision
  AND h.policy_generation = r.policy_generation AND h.policy_authority_ref = r.policy_authority_ref
  AND h.deployment_generation = r.deployment_generation
  AND s.invalidated_at IS NULL AND julianday(s.expires_at) > julianday('now')
  AND s.policy_authority_ref = r.policy_authority_ref AND s.purge_ledger_revision = r.purge_revision
  AND r.purge_revision = COALESCE((SELECT MAX(ledger_revision) FROM purge_ledger), 0)
  AND EXISTS (SELECT 1 FROM investigation_current_policy p WHERE p.state = 'ACTIVE'
    AND p.policy_generation = r.policy_generation AND p.policy_authority_ref = r.policy_authority_ref)
  AND EXISTS (SELECT 1 FROM research_deployment_compatible c
    WHERE c.origin_deployment_generation = r.deployment_generation)
  AND EXISTS (SELECT 1 FROM scope_access_grant_effective g WHERE g.snapshot_id = r.scope_snapshot_id
    AND g.snapshot_revision = r.scope_snapshot_revision AND g.principal_ref = r.principal_ref
    AND g.credential_generation = r.credential_generation AND g.policy_authority_ref = r.policy_authority_ref
    AND g.authorization_receipt_ref = r.authorization_receipt_ref
    AND g.state = 'ACTIVE' AND julianday(g.expires_at) > julianday('now')
    AND json_type(g.allowed_use_json) = 'array'
    AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) u WHERE u.type = 'text' AND u.value = 'research'))
  -- A long-lived scope is usable only by its originally admitted operation.
  -- Existing short-lived snapshots keep their original grant/expiry behavior.
  AND (
    NOT EXISTS (SELECT 1 FROM orientation_request e
      WHERE e.snapshot_id=r.scope_snapshot_id AND e.snapshot_revision=r.scope_snapshot_revision
        AND e.execution_operation_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM orientation_request e
      WHERE e.execution_operation_id=r.operation_id
        AND e.snapshot_id=r.scope_snapshot_id AND e.snapshot_revision=r.scope_snapshot_revision
        AND e.principal_ref=r.principal_ref AND (e.client_class='owner_pwa' OR EXISTS (
          SELECT 1 FROM scope_access_grant_effective eg JOIN project_client_grant_current d
            ON d.grant_id=eg.project_client_grant_id AND d.revision=eg.project_client_grant_revision
          WHERE eg.snapshot_id=r.scope_snapshot_id AND eg.snapshot_revision=r.scope_snapshot_revision
            AND eg.project_client_operation='run' AND eg.project_client_run_operation_id=r.operation_id
            AND eg.client_class=e.client_class AND eg.principal_ref=r.principal_ref
            AND eg.credential_generation=r.credential_generation
            AND e.execution_client_grant_id=d.grant_id AND e.execution_client_grant_revision=d.revision
            AND d.spend_deployment_generation=r.deployment_generation))
        AND e.credential_generation=r.credential_generation AND e.state='COMPLETE'
        AND julianday(e.expires_at)>julianday('now')
        AND julianday(e.expires_at)<=julianday(e.created_at)+1
        AND json_extract(e.result_json,'$.execution.operation_id')=r.operation_id
        AND json_extract(e.result_json,'$.execution.deadline')=e.expires_at)
  );

DROP TRIGGER client_scope_query_result_guard;

CREATE TRIGGER client_scope_query_result_guard BEFORE INSERT ON retrieval_query_result
WHEN EXISTS (SELECT 1 FROM scope_access_grant g WHERE g.snapshot_id=NEW.scope_snapshot_id
  AND g.snapshot_revision=NEW.scope_snapshot_revision AND g.project_client_grant_id IS NOT NULL)
 AND NOT EXISTS (SELECT 1 FROM scope_access_grant_effective g WHERE g.snapshot_id=NEW.scope_snapshot_id
  AND g.snapshot_revision=NEW.scope_snapshot_revision AND g.principal_ref=NEW.principal_ref
  AND g.client_class=NEW.client_class AND g.credential_generation=NEW.credential_generation AND g.project_client_operation IN ('query','run'))
BEGIN SELECT RAISE(ABORT,'RETRIEVAL_AUTHORITY_STALE'); END;

DROP TRIGGER client_scope_query_trace_guard;

CREATE TRIGGER client_scope_query_trace_guard BEFORE INSERT ON retrieval_query_trace
WHEN EXISTS (SELECT 1 FROM scope_access_grant g WHERE g.snapshot_id=NEW.scope_snapshot_id
  AND g.snapshot_revision=NEW.scope_snapshot_revision AND g.project_client_grant_id IS NOT NULL)
 AND NOT EXISTS (SELECT 1 FROM scope_access_grant_effective g WHERE g.snapshot_id=NEW.scope_snapshot_id
  AND g.snapshot_revision=NEW.scope_snapshot_revision AND g.project_client_operation IN ('query','run'))
BEGIN SELECT RAISE(ABORT,'RETRIEVAL_AUTHORITY_STALE'); END;

DROP TRIGGER client_scope_origin_insert;

CREATE TRIGGER client_scope_origin_insert BEFORE INSERT ON scope_access_grant
WHEN (NEW.project_client_grant_id IS NULL AND (NEW.project_client_grant_revision IS NOT NULL
  OR NEW.project_client_operation IS NOT NULL OR NEW.project_client_project_generation IS NOT NULL OR NEW.project_client_authority_epoch IS NOT NULL))
 OR (NEW.project_client_grant_id IS NOT NULL AND (
  NEW.project_client_grant_revision IS NULL OR NEW.project_client_grant_revision<1
  OR NEW.project_client_operation IS NULL OR NEW.project_client_operation NOT IN ('query','report','evidence','run') OR NEW.project_client_project_generation IS NULL OR NEW.project_client_project_generation<1
  OR NEW.project_client_authority_epoch IS NULL OR NEW.project_client_authority_epoch<1
  OR NEW.project_client_authority_epoch IS NOT (SELECT generation FROM orientation_authority_epoch WHERE singleton=1)
  OR NEW.client_class NOT IN ('trusted_agent','named_api_client') OR NEW.state<>'ACTIVE'
  OR NOT json_valid(NEW.allowed_use_json) OR json_type(NEW.allowed_use_json)<>'array'
  OR json_array_length(NEW.allowed_use_json) NOT BETWEEN 1 AND 512
  OR NOT EXISTS (SELECT 1 FROM json_each(NEW.allowed_use_json) WHERE value='research')))
BEGIN SELECT RAISE(ABORT,'CLIENT_SCOPE_AUTHORITY_STALE'); END;

DROP TRIGGER client_artifact_origin_insert;

CREATE TRIGGER client_artifact_origin_insert BEFORE INSERT ON scope_access_grant
WHEN ((NEW.project_client_grant_id IS NULL OR NEW.project_client_operation IN ('query','run')) AND
  (NEW.project_client_artifact_id IS NOT NULL OR NEW.project_client_artifact_revision IS NOT NULL))
 OR (NEW.project_client_operation IN ('report','evidence') AND
  (NEW.project_client_artifact_id IS NULL OR typeof(NEW.project_client_artifact_id)<>'text'
   OR length(NEW.project_client_artifact_id) NOT BETWEEN 1 AND 256
   OR NEW.project_client_artifact_revision IS NULL OR typeof(NEW.project_client_artifact_revision)<>'integer'
   OR NEW.project_client_artifact_revision<1))
BEGIN SELECT RAISE(ABORT,'CLIENT_ARTIFACT_ORIGIN_INVALID'); END;

DROP TRIGGER client_scope_resolution_guard;

CREATE TRIGGER client_scope_resolution_guard BEFORE INSERT ON evidence_resolution_receipt
WHEN EXISTS (SELECT 1 FROM scope_access_grant WHERE authorization_receipt_ref=NEW.authorization_receipt_ref
  AND project_client_grant_id IS NOT NULL)
 AND NOT EXISTS (SELECT 1 FROM scope_access_grant_effective WHERE authorization_receipt_ref=NEW.authorization_receipt_ref
  AND project_client_operation IN ('query','evidence','run'))
BEGIN SELECT RAISE(ABORT,'EVIDENCE_AUTHORIZATION_DENIED'); END;

DROP TRIGGER client_scope_handle_guard;

CREATE TRIGGER client_scope_handle_guard BEFORE INSERT ON evidence_handle
WHEN EXISTS (SELECT 1 FROM scope_access_grant g WHERE g.snapshot_id=NEW.scope_snapshot_id
  AND g.snapshot_revision=NEW.scope_snapshot_revision AND g.project_client_grant_id IS NOT NULL)
 AND NOT EXISTS (SELECT 1 FROM scope_access_grant_effective g WHERE g.snapshot_id=NEW.scope_snapshot_id
  AND g.snapshot_revision=NEW.scope_snapshot_revision AND g.project_client_operation IN ('query','evidence','run'))
BEGIN SELECT RAISE(ABORT,'EVIDENCE_AUTHORIZATION_DENIED'); END;

DROP TRIGGER client_scope_scope_read_policy_insert;

CREATE TRIGGER client_scope_scope_read_policy_insert AFTER INSERT ON scope_read_policy
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE grantor_principal_ref IN (NEW.principal_ref));
END;

DROP TRIGGER client_scope_scope_read_policy_update;

CREATE TRIGGER client_scope_scope_read_policy_update AFTER UPDATE ON scope_read_policy
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE grantor_principal_ref IN (OLD.principal_ref,NEW.principal_ref));
END;

DROP TRIGGER client_scope_scope_read_policy_delete;

CREATE TRIGGER client_scope_scope_read_policy_delete AFTER DELETE ON scope_read_policy
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE grantor_principal_ref IN (OLD.principal_ref));
END;

DROP TRIGGER client_scope_project_owner_insert;

CREATE TRIGGER client_scope_project_owner_insert AFTER INSERT ON project_owner
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE project_id IN (NEW.project_id));
END;

DROP TRIGGER client_scope_project_owner_update;

CREATE TRIGGER client_scope_project_owner_update AFTER UPDATE ON project_owner
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE project_id IN (OLD.project_id,NEW.project_id));
END;

DROP TRIGGER client_scope_project_owner_delete;

CREATE TRIGGER client_scope_project_owner_delete AFTER DELETE ON project_owner
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE project_id IN (OLD.project_id));
END;

DROP TRIGGER client_scope_project_source_membership_insert;

CREATE TRIGGER client_scope_project_source_membership_insert AFTER INSERT ON project_source_membership
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE project_id IN (NEW.project_id));
END;

DROP TRIGGER client_scope_project_source_membership_update;

CREATE TRIGGER client_scope_project_source_membership_update AFTER UPDATE ON project_source_membership
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE project_id IN (OLD.project_id,NEW.project_id));
END;

DROP TRIGGER client_scope_project_source_membership_delete;

CREATE TRIGGER client_scope_project_source_membership_delete AFTER DELETE ON project_source_membership
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE project_id IN (OLD.project_id));
END;

DROP TRIGGER client_scope_project_insert;

CREATE TRIGGER client_scope_project_insert AFTER INSERT ON project
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE project_id IN (NEW.project_id));
END;

DROP TRIGGER client_scope_project_update;

CREATE TRIGGER client_scope_project_update AFTER UPDATE ON project
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE project_id IN (OLD.project_id,NEW.project_id));
END;

DROP TRIGGER client_scope_project_delete;

CREATE TRIGGER client_scope_project_delete AFTER DELETE ON project
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE' AND project_client_grant_id IN (SELECT grant_id FROM project_client_grant WHERE project_id IN (OLD.project_id));
END;

DROP TRIGGER client_scope_source_insert;

CREATE TRIGGER client_scope_source_insert AFTER INSERT ON source
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE';
END;

DROP TRIGGER client_scope_source_update;

CREATE TRIGGER client_scope_source_update AFTER UPDATE ON source
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE';
END;

DROP TRIGGER client_scope_source_delete;

CREATE TRIGGER client_scope_source_delete AFTER DELETE ON source
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE';
END;

DROP TRIGGER client_scope_source_revision_insert;

CREATE TRIGGER client_scope_source_revision_insert AFTER INSERT ON source_revision
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE';
END;

DROP TRIGGER client_scope_source_revision_update;

CREATE TRIGGER client_scope_source_revision_update AFTER UPDATE ON source_revision
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE';
END;

DROP TRIGGER client_scope_source_revision_delete;

CREATE TRIGGER client_scope_source_revision_delete AFTER DELETE ON source_revision
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE';
END;

DROP TRIGGER client_scope_source_tag_insert;

CREATE TRIGGER client_scope_source_tag_insert AFTER INSERT ON source_tag
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE';
END;

DROP TRIGGER client_scope_source_tag_update;

CREATE TRIGGER client_scope_source_tag_update AFTER UPDATE ON source_tag
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE';
END;

DROP TRIGGER client_scope_source_tag_delete;

CREATE TRIGGER client_scope_source_tag_delete AFTER DELETE ON source_tag
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE';
END;

DROP TRIGGER client_scope_source_namespace_ownership_insert;

CREATE TRIGGER client_scope_source_namespace_ownership_insert AFTER INSERT ON source_namespace_ownership
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE';
END;

DROP TRIGGER client_scope_source_namespace_ownership_update;

CREATE TRIGGER client_scope_source_namespace_ownership_update AFTER UPDATE ON source_namespace_ownership
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE';
END;

DROP TRIGGER client_scope_source_namespace_ownership_delete;

CREATE TRIGGER client_scope_source_namespace_ownership_delete AFTER DELETE ON source_namespace_ownership
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE';
END;

DROP TRIGGER client_scope_source_admission_decision_insert;

CREATE TRIGGER client_scope_source_admission_decision_insert AFTER INSERT ON source_admission_decision
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE';
END;

DROP TRIGGER client_scope_source_admission_decision_update;

CREATE TRIGGER client_scope_source_admission_decision_update AFTER UPDATE ON source_admission_decision
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE';
END;

DROP TRIGGER client_scope_source_admission_decision_delete;

CREATE TRIGGER client_scope_source_admission_decision_delete AFTER DELETE ON source_admission_decision
BEGIN
  UPDATE scope_access_grant SET state='REVOKED' WHERE project_client_grant_id IS NOT NULL
    AND project_client_operation IN ('query','report','evidence','run') AND state='ACTIVE';
END;

CREATE TRIGGER client_execution_origin_insert BEFORE INSERT ON scope_access_grant
WHEN (NEW.project_client_operation IS NOT 'run' AND NEW.project_client_run_operation_id IS NOT NULL)
 OR (NEW.project_client_operation='run' AND (NEW.project_client_run_operation_id IS NULL
   OR length(NEW.project_client_run_operation_id)<>52 OR substr(NEW.project_client_run_operation_id,1,4)<>'run-'
   OR substr(NEW.project_client_run_operation_id,5) GLOB '*[^0-9a-f]*'))
BEGIN SELECT RAISE(ABORT,'CLIENT_RUN_AUTHORITY_STALE'); END;

CREATE TRIGGER client_execution_origin_immutable BEFORE UPDATE ON scope_access_grant
WHEN NEW.project_client_run_operation_id IS NOT OLD.project_client_run_operation_id
BEGIN SELECT RAISE(ABORT,'CLIENT_SCOPE_IMMUTABLE'); END;

CREATE TRIGGER client_execution_investigation_ledger_head_guard BEFORE INSERT ON investigation_ledger_head
WHEN EXISTS(SELECT 1 FROM scope_access_grant WHERE snapshot_id=NEW.scope_snapshot_id
 AND snapshot_revision=NEW.scope_snapshot_revision AND project_client_grant_id IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM scope_access_grant_effective g JOIN orientation_request e
 ON e.execution_operation_id=g.project_client_run_operation_id
 JOIN project_client_grant_current d ON d.grant_id=g.project_client_grant_id AND d.revision=g.project_client_grant_revision
 WHERE g.snapshot_id=NEW.scope_snapshot_id AND g.snapshot_revision=NEW.scope_snapshot_revision
 AND g.principal_ref=NEW.principal_ref AND g.project_client_operation='run'
 AND g.policy_authority_ref=NEW.policy_authority_ref AND d.spend_deployment_generation=NEW.deployment_generation
 AND e.state='COMPLETE' AND e.snapshot_id=g.snapshot_id AND e.snapshot_revision=g.snapshot_revision)
BEGIN SELECT RAISE(ABORT,'CLIENT_RUN_AUTHORITY_STALE'); END;

CREATE TRIGGER client_execution_research_workflow_run_guard BEFORE INSERT ON research_workflow_run
WHEN EXISTS(SELECT 1 FROM scope_access_grant WHERE snapshot_id=NEW.scope_snapshot_id
 AND snapshot_revision=NEW.scope_snapshot_revision AND project_client_grant_id IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM scope_access_grant_effective g JOIN orientation_request e
 ON e.execution_operation_id=g.project_client_run_operation_id
 JOIN project_client_grant_current d ON d.grant_id=g.project_client_grant_id AND d.revision=g.project_client_grant_revision
 WHERE g.snapshot_id=NEW.scope_snapshot_id AND g.snapshot_revision=NEW.scope_snapshot_revision
 AND g.principal_ref=NEW.principal_ref AND g.project_client_operation='run' AND g.project_client_run_operation_id=NEW.operation_id AND g.credential_generation=NEW.credential_generation
 AND g.policy_authority_ref=NEW.policy_authority_ref AND d.spend_deployment_generation=NEW.deployment_generation
 AND e.state='COMPLETE' AND e.snapshot_id=g.snapshot_id AND e.snapshot_revision=g.snapshot_revision)
BEGIN SELECT RAISE(ABORT,'CLIENT_RUN_AUTHORITY_STALE'); END;

CREATE TABLE research_report_admission_s11_copy AS SELECT "decision_id","decision_revision","decision","decision_json","decision_sha256","input_json","input_sha256","policy_json","policy_ref","policy_revision","policy_generation","policy_authority_ref","policy_expires_at","operation_id","intent_id","intent_revision","outbox_id","principal_ref","client_class","credential_generation","idempotency_key","scope_snapshot_id","scope_snapshot_revision","scope_snapshot_digest","authorization_receipt_ref","deployment_generation","source_revision_refs_json","requested_output_class","purpose","disclosure_ceiling","expires_at","created_at" FROM research_report_admission;

DROP TRIGGER research_report_admission_current_guard;

DROP TRIGGER research_report_admission_intent_guard;

DROP TRIGGER research_report_admission_immutable;

DROP TRIGGER research_report_admission_no_delete;

DROP TABLE research_report_admission;

CREATE TABLE research_report_admission (
  decision_id TEXT PRIMARY KEY CHECK(length(decision_id) BETWEEN 1 AND 256),
  decision_revision INTEGER NOT NULL CHECK(decision_revision = 1),
  decision TEXT NOT NULL CHECK(decision IN ('ALLOW','ALLOW_WITH_MINIMIZATION')),
  decision_json TEXT NOT NULL CHECK(json_valid(decision_json) AND length(CAST(decision_json AS BLOB)) <= 65536),
  decision_sha256 TEXT NOT NULL CHECK(length(decision_sha256) = 64 AND decision_sha256 NOT GLOB '*[^0-9a-f]*'),
  input_json TEXT NOT NULL CHECK(json_valid(input_json) AND length(CAST(input_json AS BLOB)) <= 65536),
  input_sha256 TEXT NOT NULL CHECK(length(input_sha256) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
  policy_json TEXT NOT NULL CHECK(json_valid(policy_json) AND length(CAST(policy_json AS BLOB)) <= 65536),
  policy_ref TEXT NOT NULL CHECK(length(policy_ref) BETWEEN 1 AND 256),
  policy_revision INTEGER NOT NULL CHECK(policy_revision > 0),
  policy_generation TEXT NOT NULL CHECK(length(policy_generation) BETWEEN 1 AND 256),
  policy_authority_ref TEXT NOT NULL CHECK(length(policy_authority_ref) BETWEEN 1 AND 256),
  policy_expires_at TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 128),
  intent_id TEXT NOT NULL CHECK(length(intent_id) BETWEEN 1 AND 256),
  intent_revision INTEGER NOT NULL CHECK(intent_revision = 1),
  outbox_id TEXT NOT NULL CHECK(length(outbox_id) BETWEEN 1 AND 256),
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  client_class TEXT NOT NULL CHECK(client_class IN ('owner_pwa','trusted_agent','named_api_client')),
  credential_generation TEXT NOT NULL CHECK(length(credential_generation) BETWEEN 1 AND 256),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  scope_snapshot_id TEXT NOT NULL CHECK(length(scope_snapshot_id) BETWEEN 1 AND 256),
  scope_snapshot_revision INTEGER NOT NULL CHECK(scope_snapshot_revision > 0),
  scope_snapshot_digest TEXT NOT NULL CHECK(length(scope_snapshot_digest) = 64 AND scope_snapshot_digest NOT GLOB '*[^0-9a-f]*'),
  authorization_receipt_ref TEXT NOT NULL CHECK(length(authorization_receipt_ref) BETWEEN 1 AND 256),
  deployment_generation TEXT NOT NULL CHECK(length(deployment_generation) BETWEEN 1 AND 256),
  source_revision_refs_json TEXT NOT NULL CHECK(json_valid(source_revision_refs_json) AND json_type(source_revision_refs_json) = 'array'),
  requested_output_class TEXT NOT NULL CHECK(requested_output_class = 'private-draft'),
  purpose TEXT NOT NULL CHECK(length(purpose) BETWEEN 1 AND 256),
  disclosure_ceiling TEXT NOT NULL CHECK(length(disclosure_ceiling) BETWEEN 1 AND 256),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(operation_id, principal_ref, idempotency_key),
  FOREIGN KEY(intent_id, intent_revision) REFERENCES operation_intent(intent_id, revision),
  FOREIGN KEY(outbox_id) REFERENCES outbox(outbox_id)
) STRICT;

INSERT INTO research_report_admission("decision_id","decision_revision","decision","decision_json","decision_sha256","input_json","input_sha256","policy_json","policy_ref","policy_revision","policy_generation","policy_authority_ref","policy_expires_at","operation_id","intent_id","intent_revision","outbox_id","principal_ref","client_class","credential_generation","idempotency_key","scope_snapshot_id","scope_snapshot_revision","scope_snapshot_digest","authorization_receipt_ref","deployment_generation","source_revision_refs_json","requested_output_class","purpose","disclosure_ceiling","expires_at","created_at") SELECT "decision_id","decision_revision","decision","decision_json","decision_sha256","input_json","input_sha256","policy_json","policy_ref","policy_revision","policy_generation","policy_authority_ref","policy_expires_at","operation_id","intent_id","intent_revision","outbox_id","principal_ref","client_class","credential_generation","idempotency_key","scope_snapshot_id","scope_snapshot_revision","scope_snapshot_digest","authorization_receipt_ref","deployment_generation","source_revision_refs_json","requested_output_class","purpose","disclosure_ceiling","expires_at","created_at" FROM research_report_admission_s11_copy;

CREATE TABLE research_report_admission_s11_guard(valid INTEGER NOT NULL CHECK(valid=1));

INSERT INTO research_report_admission_s11_guard SELECT CASE WHEN
 (SELECT COUNT(*) FROM research_report_admission_s11_copy)=(SELECT COUNT(*) FROM research_report_admission)
 AND NOT EXISTS(SELECT "decision_id","decision_revision","decision","decision_json","decision_sha256","input_json","input_sha256","policy_json","policy_ref","policy_revision","policy_generation","policy_authority_ref","policy_expires_at","operation_id","intent_id","intent_revision","outbox_id","principal_ref","client_class","credential_generation","idempotency_key","scope_snapshot_id","scope_snapshot_revision","scope_snapshot_digest","authorization_receipt_ref","deployment_generation","source_revision_refs_json","requested_output_class","purpose","disclosure_ceiling","expires_at","created_at" FROM research_report_admission_s11_copy EXCEPT SELECT "decision_id","decision_revision","decision","decision_json","decision_sha256","input_json","input_sha256","policy_json","policy_ref","policy_revision","policy_generation","policy_authority_ref","policy_expires_at","operation_id","intent_id","intent_revision","outbox_id","principal_ref","client_class","credential_generation","idempotency_key","scope_snapshot_id","scope_snapshot_revision","scope_snapshot_digest","authorization_receipt_ref","deployment_generation","source_revision_refs_json","requested_output_class","purpose","disclosure_ceiling","expires_at","created_at" FROM research_report_admission)
 AND NOT EXISTS(SELECT "decision_id","decision_revision","decision","decision_json","decision_sha256","input_json","input_sha256","policy_json","policy_ref","policy_revision","policy_generation","policy_authority_ref","policy_expires_at","operation_id","intent_id","intent_revision","outbox_id","principal_ref","client_class","credential_generation","idempotency_key","scope_snapshot_id","scope_snapshot_revision","scope_snapshot_digest","authorization_receipt_ref","deployment_generation","source_revision_refs_json","requested_output_class","purpose","disclosure_ceiling","expires_at","created_at" FROM research_report_admission EXCEPT SELECT "decision_id","decision_revision","decision","decision_json","decision_sha256","input_json","input_sha256","policy_json","policy_ref","policy_revision","policy_generation","policy_authority_ref","policy_expires_at","operation_id","intent_id","intent_revision","outbox_id","principal_ref","client_class","credential_generation","idempotency_key","scope_snapshot_id","scope_snapshot_revision","scope_snapshot_digest","authorization_receipt_ref","deployment_generation","source_revision_refs_json","requested_output_class","purpose","disclosure_ceiling","expires_at","created_at" FROM research_report_admission_s11_copy) THEN 1 ELSE 0 END;

DROP TABLE research_report_admission_s11_guard;

DROP TABLE research_report_admission_s11_copy;

CREATE INDEX research_report_admission_run_idx
  ON research_report_admission(operation_id, principal_ref, idempotency_key);

CREATE TRIGGER research_report_admission_current_guard
BEFORE INSERT ON research_report_admission
WHEN NOT EXISTS (
  SELECT 1
  FROM research_workflow_current r
  JOIN scope_snapshot s ON s.snapshot_id = r.scope_snapshot_id
    AND s.revision = r.scope_snapshot_revision
  WHERE r.operation_id = NEW.operation_id
    AND r.state = 'ACTIVE' AND r.next_stage_index = 17
    AND r.principal_ref = NEW.principal_ref
    AND r.credential_generation = NEW.credential_generation
    AND r.policy_generation = NEW.policy_generation
    AND r.policy_authority_ref = NEW.policy_authority_ref
    AND r.deployment_generation = NEW.deployment_generation
    AND r.scope_snapshot_id = NEW.scope_snapshot_id
    AND r.scope_snapshot_revision = NEW.scope_snapshot_revision
    AND s.snapshot_digest = NEW.scope_snapshot_digest
    AND julianday(s.expires_at) > julianday('now')
    AND julianday(NEW.expires_at) > julianday('now')
    AND julianday(NEW.policy_expires_at) > julianday('now')
    AND CAST(json_extract(NEW.input_json, '$.workflow_revision') AS INTEGER) = r.current_revision
    AND NEW.client_class IN ('owner_pwa','trusted_agent','named_api_client')
    AND EXISTS (
      SELECT 1
      FROM scope_access_grant_effective g
      WHERE g.snapshot_id = r.scope_snapshot_id
        AND g.snapshot_revision = r.scope_snapshot_revision
        AND g.principal_ref = r.principal_ref
        AND g.client_class = NEW.client_class
        AND ((NEW.client_class='owner_pwa' AND g.project_client_grant_id IS NULL)
          OR (g.project_client_operation='run' AND g.project_client_run_operation_id=NEW.operation_id
            AND json_extract(NEW.policy_json,'$.schema')='eliotr.research.delegated-report-admission.v1'))
        AND g.credential_generation = r.credential_generation
        AND g.policy_authority_ref = r.policy_authority_ref
        AND g.authorization_receipt_ref = NEW.authorization_receipt_ref
        AND g.disclosure_ceiling = NEW.disclosure_ceiling
        AND g.state = 'ACTIVE'
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
          ON own.source_namespace_id = src.source_namespace_id
          AND own.status = 'ACTIVE'
          AND own.source_owner_generation = sr.source_owner_generation
        JOIN json_each(s.source_owner_generations_json) gen
          ON gen.key = sr.source_revision_ref
          AND gen.value = sr.source_owner_generation
        JOIN source_admission_decision sad
          ON sad.source_revision_ref = sr.source_revision_ref
          AND sad.decision = 'ADMITTED'
        WHERE sr.source_revision_ref = wanted.value
          AND sr.purge_state = 'LIVE'
          AND json_type(sad.allowed_use_json) = 'array'
          AND EXISTS (SELECT 1 FROM json_each(sad.allowed_use_json) u WHERE u.type = 'text' AND u.value = 'research')
          AND sad.disclosure_ceiling = NEW.disclosure_ceiling
          AND (sad.expires_at IS NULL OR julianday(sad.expires_at) > julianday('now'))
      )
    )
)
BEGIN SELECT RAISE(ABORT, 'REPORT_ADMISSION_AUTHORITY_STALE'); END;

CREATE TRIGGER research_report_admission_intent_guard
AFTER INSERT ON research_report_admission
WHEN NOT EXISTS (
  SELECT 1 FROM operation_intent i JOIN outbox o
    ON o.intent_id = i.intent_id AND o.intent_revision = i.revision
  WHERE i.intent_id = NEW.intent_id AND i.revision = NEW.intent_revision
    AND i.operation_kind = 'REPORT' AND i.principal_ref = NEW.principal_ref
    AND i.idempotency_key = NEW.idempotency_key
    AND i.policy_decision_ref = NEW.decision_id
    AND o.outbox_id = NEW.outbox_id
    AND o.topic = 'research.artifact-draft'
    AND o.payload_ref = i.payload_ref
)
BEGIN SELECT RAISE(ABORT, 'REPORT_ADMISSION_INTENT_GUARD'); END;

CREATE TRIGGER research_report_admission_immutable
BEFORE UPDATE ON research_report_admission
BEGIN SELECT RAISE(ABORT, 'REPORT_ADMISSION_CONFLICT'); END;

CREATE TRIGGER research_report_admission_no_delete
BEFORE DELETE ON research_report_admission
BEGIN SELECT RAISE(ABORT, 'REPORT_ADMISSION_CONFLICT'); END;

CREATE TRIGGER client_execution_artifact_intent_guard BEFORE INSERT ON artifact_draft_reservation
WHEN EXISTS(SELECT 1 FROM scope_access_grant WHERE snapshot_id=NEW.scope_snapshot_id
 AND snapshot_revision=NEW.scope_snapshot_revision AND project_client_grant_id IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM scope_access_grant_effective g JOIN research_report_admission a
 ON a.operation_id=g.project_client_run_operation_id AND a.intent_id=NEW.intent_id AND a.intent_revision=NEW.intent_revision
 WHERE g.snapshot_id=NEW.scope_snapshot_id AND g.snapshot_revision=NEW.scope_snapshot_revision
 AND g.principal_ref=NEW.principal_ref AND g.project_client_operation='run' AND a.principal_ref=NEW.principal_ref
 AND julianday(a.expires_at)>julianday('now'))
BEGIN SELECT RAISE(ABORT,'REPORT_ADMISSION_AUTHORITY_STALE'); END;

INSERT INTO schema_state(key,value,updated_at) VALUES('project_client_execution_generation','project-client-execution-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));

PRAGMA defer_foreign_keys = OFF;
