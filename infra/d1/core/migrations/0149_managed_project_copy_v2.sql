-- PROJECT_COPY_V2 keeps canonical source bytes shared while persisting exact
-- membership identity and one source-scoped provider-copy map index receipt.
-- Existing V1/flat rows remain nullable and retain their original semantics.
PRAGMA foreign_keys = ON;

-- Rebalance the current delegated grant view before ALTER TABLE asks SQLite
-- to re-resolve unrelated triggers at D1's expression-depth limit. Only
-- associative top-level AND grouping changes; every predicate is retained.
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
  WHERE
((((((d.grant_id, d.revision, d.state, g.state)
      = (g.project_client_grant_id, g.project_client_grant_revision, 'ACTIVE', 'ACTIVE')
 AND g.project_client_operation IN ('query','report',
        'evidence','run'))
 AND (d.grantee_method, d.grantee_subject)
      = ('service_token', g.principal_ref))
 AND (g.client_class IN ('trusted_agent','named_api_client')
 AND ((g.project_client_provenance_version=1 AND p.generation=g.project_client_project_generation)
      OR (g.project_client_provenance_version=2
        AND p.membership_generation=g.project_client_membership_generation
        AND po.deployment_generation=g.project_client_owner_deployment_generation))))
 AND (((EXISTS (SELECT 1 FROM json_each(d.record_json,'$.allowed_operations') WHERE value=g.project_client_operation)
 AND julianday(d.expires_at)>julianday('now'))
 AND julianday(g.expires_at)>julianday('now'))
 AND (julianday(g.expires_at)<=julianday(d.expires_at)
 AND json_valid(g.allowed_use_json))))
 AND ((((json_type(g.allowed_use_json)='array'
 AND json_array_length(g.allowed_use_json) BETWEEN 1 AND 512)
 AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) WHERE value='research'))
 AND (NOT EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) u WHERE u.type<>'text' OR NOT (
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
          WHERE (b.artifact_id, b.artifact_revision, b.client_grant_id, b.client_grant_revision)
      = (g.project_client_artifact_id, g.project_client_artifact_revision, d.grant_id, d.revision)
            AND (
              (g.project_client_provenance_version=1
                AND p.generation=g.project_client_project_generation
                AND b.project_generation=p.generation)
              OR (g.project_client_provenance_version=2
                AND p.membership_generation=g.project_client_membership_generation
                AND po.deployment_generation=g.project_client_owner_deployment_generation
                AND (
                  (b.project_client_provenance_version=2
                    AND b.project_client_membership_generation=g.project_client_membership_generation
                    AND b.project_client_owner_deployment_generation=g.project_client_owner_deployment_generation)
                  OR (b.project_client_provenance_version=1 AND b.project_generation=p.generation)
                  OR (b.origin_client_class='owner_pwa'
                    AND b.project_client_membership_generation=p.membership_generation
                    AND b.project_client_owner_deployment_generation=po.deployment_generation)
                ))
            )
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
        )))))
 AND (((s.invalidated_at IS NULL
 AND (s.policy_authority_ref, s.client_fence_ref)
      = (g.policy_authority_ref, g.credential_generation))
 AND julianday(s.expires_at)>julianday('now'))
 AND (s.purge_ledger_revision=COALESCE((SELECT MAX(ledger_revision) FROM purge_ledger),0)
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
    )))));



ALTER TABLE projection_generation ADD COLUMN project_copy_map_index_protocol TEXT
  CHECK (project_copy_map_index_protocol IS NULL OR
    project_copy_map_index_protocol = 'eliotr.managed-project-copy-map-index.v2');
ALTER TABLE projection_generation ADD COLUMN project_copy_map_index_ref TEXT
  CHECK (project_copy_map_index_ref IS NULL OR
    length(project_copy_map_index_ref) BETWEEN 1 AND 2048);
ALTER TABLE projection_generation ADD COLUMN project_copy_map_index_sha256 TEXT
  CHECK (project_copy_map_index_sha256 IS NULL OR (
    length(project_copy_map_index_sha256) = 64
    AND project_copy_map_index_sha256 NOT GLOB '*[^0-9a-f]*'
  ));
ALTER TABLE projection_generation ADD COLUMN project_copy_scope_snapshot_id TEXT
  CHECK (project_copy_scope_snapshot_id IS NULL OR
    length(project_copy_scope_snapshot_id) BETWEEN 1 AND 256);
ALTER TABLE projection_generation ADD COLUMN project_copy_scope_snapshot_revision INTEGER
  CHECK (project_copy_scope_snapshot_revision IS NULL OR project_copy_scope_snapshot_revision > 0);
ALTER TABLE projection_generation ADD COLUMN project_copy_scope_snapshot_digest TEXT
  CHECK (project_copy_scope_snapshot_digest IS NULL OR (
    length(project_copy_scope_snapshot_digest) = 64
    AND project_copy_scope_snapshot_digest NOT GLOB '*[^0-9a-f]*'
  ));

-- Generations are born without an index receipt. The exact six-field tuple is
-- bound only on PREPARING -> MATERIALIZED, alongside the existing five-field
-- canonical/provider copy identity and the original immutable Work receipt.
CREATE TRIGGER projection_generation_copy_map_index_insert_guard
BEFORE INSERT ON projection_generation
WHEN NEW.project_copy_map_index_protocol IS NOT NULL
  OR NEW.project_copy_map_index_ref IS NOT NULL
  OR NEW.project_copy_map_index_sha256 IS NOT NULL
  OR NEW.project_copy_scope_snapshot_id IS NOT NULL
  OR NEW.project_copy_scope_snapshot_revision IS NOT NULL
  OR NEW.project_copy_scope_snapshot_digest IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_COPY_MAP_INDEX_INSERT_DENIED');
END;

CREATE TRIGGER projection_generation_copy_map_index_complete
BEFORE UPDATE OF project_copy_map_index_protocol, project_copy_map_index_ref,
  project_copy_map_index_sha256, project_copy_scope_snapshot_id,
  project_copy_scope_snapshot_revision, project_copy_scope_snapshot_digest
ON projection_generation
WHEN NOT (
  (NEW.project_copy_map_index_protocol IS NULL
    AND NEW.project_copy_map_index_ref IS NULL
    AND NEW.project_copy_map_index_sha256 IS NULL
    AND NEW.project_copy_scope_snapshot_id IS NULL
    AND NEW.project_copy_scope_snapshot_revision IS NULL
    AND NEW.project_copy_scope_snapshot_digest IS NULL)
  OR
  (NEW.project_copy_map_index_protocol IS NOT NULL
    AND NEW.project_copy_map_index_ref IS NOT NULL
    AND NEW.project_copy_map_index_sha256 IS NOT NULL
    AND NEW.project_copy_scope_snapshot_id IS NOT NULL
    AND NEW.project_copy_scope_snapshot_revision IS NOT NULL
    AND NEW.project_copy_scope_snapshot_digest IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_COPY_MAP_INDEX_INCOMPLETE');
END;

CREATE TRIGGER projection_generation_copy_map_index_phase_guard
BEFORE UPDATE OF project_copy_map_index_protocol, project_copy_map_index_ref,
  project_copy_map_index_sha256, project_copy_scope_snapshot_id,
  project_copy_scope_snapshot_revision, project_copy_scope_snapshot_digest
ON projection_generation
WHEN (
  NEW.project_copy_map_index_protocol IS NOT OLD.project_copy_map_index_protocol
  OR NEW.project_copy_map_index_ref IS NOT OLD.project_copy_map_index_ref
  OR NEW.project_copy_map_index_sha256 IS NOT OLD.project_copy_map_index_sha256
  OR NEW.project_copy_scope_snapshot_id IS NOT OLD.project_copy_scope_snapshot_id
  OR NEW.project_copy_scope_snapshot_revision IS NOT OLD.project_copy_scope_snapshot_revision
  OR NEW.project_copy_scope_snapshot_digest IS NOT OLD.project_copy_scope_snapshot_digest
)
AND NOT (
  OLD.state IS 'PREPARING'
  AND NEW.state IS 'MATERIALIZED'
  AND OLD.project_copy_map_index_protocol IS NULL
  AND OLD.project_copy_map_index_ref IS NULL
  AND OLD.project_copy_map_index_sha256 IS NULL
  AND OLD.project_copy_scope_snapshot_id IS NULL
  AND OLD.project_copy_scope_snapshot_revision IS NULL
  AND OLD.project_copy_scope_snapshot_digest IS NULL
  AND NEW.project_copy_map_index_protocol IS 'eliotr.managed-project-copy-map-index.v2'
  AND length(NEW.project_copy_map_index_ref) BETWEEN 1 AND 2048
  AND instr(NEW.project_copy_map_index_ref, '/copy-maps/index/') > 1
  AND length(NEW.project_copy_map_index_sha256) = 64
  AND NEW.project_copy_map_index_sha256 NOT GLOB '*[^0-9a-f]*'
  AND length(NEW.project_copy_scope_snapshot_id) BETWEEN 1 AND 256
  AND NEW.project_copy_scope_snapshot_revision > 0
  AND length(NEW.project_copy_scope_snapshot_digest) = 64
  AND NEW.project_copy_scope_snapshot_digest NOT GLOB '*[^0-9a-f]*'
  AND NEW.managed_item_protocol IS 'eliotr.managed-item-effects.v1'
  AND NEW.managed_target_instance_id IS NOT NULL
  AND NEW.managed_target_generation IS NOT NULL
  AND NEW.managed_target_metadata_generation_digest IS NOT NULL
  AND NEW.canonical_projection_generation IS NOT NULL
  AND NEW.canonical_item_count IS NEW.item_count
  AND NEW.canonical_item_set_digest IS NEW.item_set_digest
  AND NEW.provider_copy_count BETWEEN 0 AND 256
  AND NEW.provider_copy_set_digest IS NOT NULL
  AND NEW.item_count IS NOT NULL
  AND NEW.item_set_digest IS NOT NULL
  AND NEW.work_manifest_ref IS NOT NULL
  AND NEW.work_manifest_sha256 IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_COPY_MAP_INDEX_PHASE_DENIED');
END;

CREATE TRIGGER projection_generation_copy_map_index_immutable
BEFORE UPDATE OF project_copy_map_index_protocol, project_copy_map_index_ref,
  project_copy_map_index_sha256, project_copy_scope_snapshot_id,
  project_copy_scope_snapshot_revision, project_copy_scope_snapshot_digest
ON projection_generation
WHEN OLD.project_copy_map_index_protocol IS NOT NULL AND (
  NEW.project_copy_map_index_protocol IS NOT OLD.project_copy_map_index_protocol
  OR NEW.project_copy_map_index_ref IS NOT OLD.project_copy_map_index_ref
  OR NEW.project_copy_map_index_sha256 IS NOT OLD.project_copy_map_index_sha256
  OR NEW.project_copy_scope_snapshot_id IS NOT OLD.project_copy_scope_snapshot_id
  OR NEW.project_copy_scope_snapshot_revision IS NOT OLD.project_copy_scope_snapshot_revision
  OR NEW.project_copy_scope_snapshot_digest IS NOT OLD.project_copy_scope_snapshot_digest
)
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_COPY_MAP_INDEX_IMMUTABLE');
END;
-- The existing effect table remains the exact provider intent/readback record.
-- Rebuild only to add PROJECT_COPY_V2 identity while preserving the historical
-- keys, foreign keys, readback shape and V1/flat semantics.
DROP TRIGGER projection_managed_item_effect_insert_guard;
DROP TRIGGER projection_managed_item_effect_update_guard;
DROP TRIGGER projection_managed_item_effect_no_delete;
DROP TRIGGER projection_managed_item_effect_target_pin_insert_guard;
DROP INDEX projection_managed_item_effect_state_idx;
ALTER TABLE projection_managed_item_effect
  RENAME TO projection_managed_item_effect_legacy_0149;

CREATE TABLE projection_managed_item_effect (
  source_revision_ref TEXT NOT NULL,
  projection_generation TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES job(job_id),
  item_key TEXT NOT NULL,
  canonical_projection_generation TEXT,
  canonical_item_key TEXT,
  project_id TEXT,
  project_membership_id TEXT,
  membership_generation INTEGER CHECK (membership_generation IS NULL OR membership_generation > 0),
  membership_identity_version INTEGER CHECK (
    membership_identity_version IS NULL OR membership_identity_version IN (1, 2)
  ),
  legacy_project_membership_id TEXT CHECK (legacy_project_membership_id IS NULL OR
    length(legacy_project_membership_id) BETWEEN 1 AND 256),
  stable_project_membership_id TEXT CHECK (stable_project_membership_id IS NULL OR (
    length(stable_project_membership_id) = 67
    AND substr(stable_project_membership_id, 1, 19) = 'project-membership-'
    AND substr(stable_project_membership_id, 20) NOT GLOB '*[^0-9a-f]*'
  )),
  membership_revision INTEGER CHECK (membership_revision IS NULL OR membership_revision > 0),
  project_membership_generation INTEGER CHECK (
    project_membership_generation IS NULL OR project_membership_generation > 0
  ),
  copy_layout TEXT CHECK (
    copy_layout IS NULL OR copy_layout IN ('PROJECT_COPY_V1', 'PROJECT_COPY_V2')
  ),
  metadata_generation_digest TEXT CHECK (metadata_generation_digest IS NULL OR (
    length(metadata_generation_digest) = 64
    AND metadata_generation_digest NOT GLOB '*[^0-9a-f]*'
  )),
  canonical_body_ref TEXT,
  canonical_body_sha256 TEXT CHECK (canonical_body_sha256 IS NULL OR (
    length(canonical_body_sha256) = 64
    AND canonical_body_sha256 NOT GLOB '*[^0-9a-f]*'
  )),
  desired_index INTEGER NOT NULL CHECK (desired_index >= 0),
  normalized_start_byte INTEGER NOT NULL CHECK (normalized_start_byte >= 0),
  normalized_end_byte INTEGER NOT NULL CHECK (normalized_end_byte > normalized_start_byte),
  intent_id TEXT NOT NULL,
  intent_revision INTEGER NOT NULL CHECK (intent_revision > 0),
  attempt_id TEXT NOT NULL REFERENCES operation_attempt(attempt_id),
  execution_operation_id TEXT NOT NULL REFERENCES operation_execution_lease(operation_id),
  dispatch_lease_generation INTEGER CHECK (
    dispatch_lease_generation IS NULL OR dispatch_lease_generation >= 1
  ),
  managed_instance_id TEXT NOT NULL,
  managed_generation TEXT NOT NULL,
  provider_source TEXT NOT NULL CHECK (provider_source = 'builtin'),
  provider_key TEXT NOT NULL,
  section_content_sha256 TEXT NOT NULL CHECK (
    length(section_content_sha256) = 64 AND section_content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  document_sha256 TEXT NOT NULL CHECK (
    length(document_sha256) = 64 AND document_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  document_size_bytes INTEGER NOT NULL CHECK (document_size_bytes BETWEEN 1 AND 4194304),
  metadata_json TEXT NOT NULL CHECK (
    json_valid(metadata_json) AND json_type(metadata_json) IS 'object'
    AND json_type(metadata_json, '$.canonical_section_id') IS 'text'
    AND json_type(metadata_json, '$.content_sha256') IS 'text'
    AND json_type(metadata_json, '$.instruction_taint') IS 'text'
    AND json_type(metadata_json, '$.projection_generation') IS 'text'
    AND json_type(metadata_json, '$.source_revision_ref') IS 'text'
    AND json_remove(metadata_json, '$.canonical_section_id', '$.content_sha256',
      '$.instruction_taint', '$.projection_generation', '$.source_revision_ref') IS '{}'
  ),
  state TEXT NOT NULL CHECK (state IN (
    'INTENT', 'DISPATCHED', 'UNKNOWN', 'READBACK_VERIFIED'
  )),
  provider_item_id TEXT,
  readback_receipt_json TEXT CHECK (
    readback_receipt_json IS NULL OR (
      json_valid(readback_receipt_json) AND json_type(readback_receipt_json) IS 'object'
      AND json_type(readback_receipt_json, '$.item_key') IS 'text'
      AND json_extract(readback_receipt_json, '$.item_key') IS item_key
      AND json_type(readback_receipt_json, '$.provider_item_id') IS 'text'
      AND json_extract(readback_receipt_json, '$.provider_item_id') IS provider_item_id
      AND json_type(readback_receipt_json, '$.provider_key') IS 'text'
      AND json_extract(readback_receipt_json, '$.provider_key') IS provider_key
      AND json_type(readback_receipt_json, '$.file_size') IS 'integer'
      AND json_extract(readback_receipt_json, '$.file_size') IS document_size_bytes
      AND json_type(readback_receipt_json, '$.chunks_count') IS 'integer'
      AND json_extract(readback_receipt_json, '$.chunks_count') > 0
      AND json_type(readback_receipt_json, '$.content_sha256') IS 'text'
      AND json_extract(readback_receipt_json, '$.content_sha256') IS document_sha256
      AND json_type(readback_receipt_json, '$.readback_sha256') IS 'text'
      AND json_extract(readback_receipt_json, '$.readback_sha256') IS readback_sha256
      AND json_remove(readback_receipt_json, '$.chunks_count', '$.content_sha256',
        '$.file_size', '$.item_key', '$.provider_item_id', '$.provider_key',
        '$.readback_sha256') IS '{}'
    )
  ),
  readback_sha256 TEXT CHECK (
    readback_sha256 IS NULL OR (
      length(readback_sha256) = 64 AND readback_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source_revision_ref, projection_generation, item_key),
  UNIQUE (job_id, projection_generation, item_key),
  UNIQUE (source_revision_ref, projection_generation, desired_index),
  FOREIGN KEY (source_revision_ref, projection_generation)
    REFERENCES projection_generation(source_revision_ref, projection_generation),
  FOREIGN KEY (intent_id, intent_revision)
    REFERENCES operation_intent(intent_id, revision),
  CHECK (
    (copy_layout IS NULL
      AND canonical_projection_generation IS NULL
      AND canonical_item_key IS NULL
      AND project_id IS NULL
      AND project_membership_id IS NULL
      AND membership_generation IS NULL
      AND membership_identity_version IS NULL
      AND legacy_project_membership_id IS NULL
      AND stable_project_membership_id IS NULL
      AND membership_revision IS NULL
      AND project_membership_generation IS NULL
      AND metadata_generation_digest IS NULL
      AND canonical_body_ref IS NULL
      AND canonical_body_sha256 IS NULL
      AND provider_key = item_key || '.md')
    OR
    (copy_layout = 'PROJECT_COPY_V1'
      AND canonical_projection_generation IS NOT NULL
      AND length(canonical_projection_generation) BETWEEN 1 AND 256
      AND canonical_item_key IS NOT NULL
      AND length(canonical_item_key) BETWEEN 1 AND 256
      AND project_id IS NOT NULL
      AND length(project_id) BETWEEN 1 AND 256
      AND project_membership_id IS NOT NULL
      AND length(project_membership_id) BETWEEN 1 AND 256
      AND membership_generation IS NOT NULL
      AND membership_generation > 0
      AND project_membership_id = 'project:' || project_id || ':generation:' || membership_generation
      AND membership_identity_version IS NULL
      AND legacy_project_membership_id IS NULL
      AND stable_project_membership_id IS NULL
      AND membership_revision IS NULL
      AND project_membership_generation IS NULL
      AND metadata_generation_digest IS NOT NULL
      AND canonical_body_ref IS NOT NULL
      AND length(canonical_body_ref) BETWEEN 1 AND 2048
      AND canonical_body_sha256 IS section_content_sha256
      AND length(provider_key) BETWEEN 12 AND 128
      AND substr(provider_key, 1, 11) = 'projection/'
      AND substr(provider_key, -3) = '.md'
      AND instr(provider_key, '//') = 0
      AND instr('/' || provider_key || '/', '/../') = 0
      AND instr('/' || provider_key || '/', '/./') = 0
      AND substr(provider_key, 1, 1) <> '/'
      AND substr(provider_key, -1) <> '/')
    OR
    (copy_layout = 'PROJECT_COPY_V2'
      AND canonical_projection_generation IS NOT NULL
      AND length(canonical_projection_generation) BETWEEN 1 AND 256
      AND canonical_item_key IS NOT NULL
      AND length(canonical_item_key) BETWEEN 1 AND 256
      AND project_id IS NOT NULL
      AND length(project_id) BETWEEN 1 AND 256
      AND project_membership_id IS NOT NULL
      AND length(project_membership_id) BETWEEN 1 AND 256
      AND membership_generation IS NOT NULL
      AND membership_generation > 0
      AND membership_identity_version IN (1, 2)
      AND project_membership_generation IS NOT NULL
      AND project_membership_generation >= membership_generation
      AND metadata_generation_digest IS NOT NULL
      AND canonical_body_ref IS NOT NULL
      AND length(canonical_body_ref) BETWEEN 1 AND 2048
      AND canonical_body_sha256 IS section_content_sha256
      AND length(provider_key) BETWEEN 12 AND 128
      AND substr(provider_key, 1, 11) = 'projection/'
      AND substr(provider_key, -3) = '.md'
      AND instr(provider_key, '//') = 0
      AND instr('/' || provider_key || '/', '/../') = 0
      AND instr('/' || provider_key || '/', '/./') = 0
      AND substr(provider_key, 1, 1) <> '/'
      AND substr(provider_key, -1) <> '/'
      AND (
        (membership_identity_version = 1
          AND legacy_project_membership_id IS NOT NULL
          AND project_membership_id = legacy_project_membership_id
          AND legacy_project_membership_id = 'project:' || project_id || ':generation:' || membership_generation
          AND stable_project_membership_id IS NULL
          AND membership_revision IS NULL)
        OR
        (membership_identity_version = 2
          AND legacy_project_membership_id IS NULL
          AND stable_project_membership_id IS NOT NULL
          AND project_membership_id = stable_project_membership_id
          AND membership_revision IS NOT NULL
          AND membership_revision > 0)
      ))),
  CHECK (
    (state = 'INTENT' AND dispatch_lease_generation IS NULL)
    OR (state <> 'INTENT' AND dispatch_lease_generation IS NOT NULL)
  ),
  CHECK (
    (state = 'READBACK_VERIFIED' AND provider_item_id IS NOT NULL
      AND readback_receipt_json IS NOT NULL AND readback_sha256 IS NOT NULL)
    OR (state <> 'READBACK_VERIFIED' AND readback_receipt_json IS NULL
      AND readback_sha256 IS NULL)
  ),
  CHECK (json_extract(metadata_json, '$.source_revision_ref') IS source_revision_ref),
  CHECK (json_extract(metadata_json, '$.canonical_section_id') IS NOT NULL
    AND json_extract(metadata_json, '$.canonical_section_id') <> ''),
  CHECK (json_extract(metadata_json, '$.content_sha256') IS section_content_sha256),
  CHECK (
    (copy_layout IS NULL
      AND json_extract(metadata_json, '$.projection_generation') IS managed_generation)
    OR
    (copy_layout = 'PROJECT_COPY_V1'
      AND json_extract(metadata_json, '$.projection_generation') IS metadata_generation_digest)
    OR
    (copy_layout = 'PROJECT_COPY_V2'
      AND json_extract(metadata_json, '$.projection_generation') IS metadata_generation_digest)
  )
) STRICT;

INSERT INTO projection_managed_item_effect (
  source_revision_ref, projection_generation, job_id, item_key,
  canonical_projection_generation, canonical_item_key, project_id, project_membership_id,
  membership_generation, membership_identity_version, legacy_project_membership_id,
  stable_project_membership_id, membership_revision, project_membership_generation,
  copy_layout, metadata_generation_digest, canonical_body_ref,
  canonical_body_sha256,
  desired_index, normalized_start_byte, normalized_end_byte, intent_id, intent_revision,
  attempt_id, execution_operation_id, dispatch_lease_generation, managed_instance_id,
  managed_generation, provider_source, provider_key, section_content_sha256, document_sha256,
  document_size_bytes, metadata_json, state, provider_item_id, readback_receipt_json,
  readback_sha256, created_at, updated_at
)
SELECT
  source_revision_ref, projection_generation, job_id, item_key,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  desired_index, normalized_start_byte, normalized_end_byte, intent_id, intent_revision,
  attempt_id, execution_operation_id, dispatch_lease_generation, managed_instance_id,
  managed_generation, provider_source, provider_key, section_content_sha256, document_sha256,
  document_size_bytes, metadata_json, state, provider_item_id, readback_receipt_json,
  readback_sha256, created_at, updated_at
FROM projection_managed_item_effect_legacy_0149;

DROP TABLE projection_managed_item_effect_legacy_0149;

CREATE INDEX projection_managed_item_effect_state_idx
  ON projection_managed_item_effect(job_id, projection_generation, state, item_key);
CREATE INDEX projection_managed_item_effect_copy_lookup_idx
  ON projection_managed_item_effect(
    source_revision_ref, canonical_projection_generation, project_membership_id,
    canonical_item_key, managed_instance_id, managed_generation
  ) WHERE copy_layout = 'PROJECT_COPY_V1';
CREATE INDEX projection_managed_item_effect_copy_v2_lookup_idx
  ON projection_managed_item_effect(
    source_revision_ref, canonical_projection_generation, project_id,
    membership_identity_version, project_membership_id, membership_revision,
    canonical_item_key, managed_instance_id, managed_generation
  ) WHERE copy_layout = 'PROJECT_COPY_V2';

CREATE TRIGGER projection_managed_item_effect_insert_guard
BEFORE INSERT ON projection_managed_item_effect
WHEN NOT EXISTS (
  SELECT 1 FROM projection_generation g
  JOIN operation_attempt a ON a.attempt_id = NEW.attempt_id
  WHERE g.source_revision_ref = NEW.source_revision_ref
    AND g.projection_generation = NEW.projection_generation
    AND g.job_id = NEW.job_id
    AND a.intent_id = NEW.intent_id
    AND a.intent_revision = NEW.intent_revision
    AND (
      NEW.copy_layout IS NULL
      OR (
        NEW.copy_layout = 'PROJECT_COPY_V1'
        AND
        g.canonical_projection_generation IS NEW.canonical_projection_generation
        AND g.canonical_item_count IS g.item_count
        AND g.canonical_item_set_digest IS g.item_set_digest
        AND g.provider_copy_count BETWEEN 1 AND 256
        AND g.managed_target_metadata_generation_digest IS NEW.metadata_generation_digest
        AND NEW.metadata_generation_digest IS g.managed_target_metadata_generation_digest
        AND EXISTS (
          SELECT 1 FROM source_revision sr
          JOIN project_source_membership m ON m.source_id = sr.source_id
          JOIN project p ON p.project_id = m.project_id
          WHERE sr.source_revision_ref = NEW.source_revision_ref
            AND m.project_id = NEW.project_id
            AND m.valid_to IS NULL
            AND m.membership_generation = NEW.membership_generation
            AND p.membership_generation = NEW.membership_generation
        )
      )
      OR (
        NEW.copy_layout = 'PROJECT_COPY_V2'
        AND g.canonical_projection_generation IS NEW.canonical_projection_generation
        AND g.canonical_item_count IS g.item_count
        AND g.canonical_item_set_digest IS g.item_set_digest
        AND g.provider_copy_count BETWEEN 1 AND 256
        AND g.project_copy_map_index_protocol IS 'eliotr.managed-project-copy-map-index.v2'
        AND g.project_copy_map_index_ref IS NOT NULL
        AND g.project_copy_map_index_sha256 IS NOT NULL
        AND g.project_copy_scope_snapshot_id IS NOT NULL
        AND g.project_copy_scope_snapshot_revision IS NOT NULL
        AND g.project_copy_scope_snapshot_digest IS NOT NULL
        AND g.managed_target_metadata_generation_digest IS NEW.metadata_generation_digest
        AND NEW.metadata_generation_digest IS g.managed_target_metadata_generation_digest
        AND EXISTS (
          SELECT 1 FROM source_revision sr
          JOIN project_source_membership m ON m.source_id = sr.source_id
          JOIN project p ON p.project_id = m.project_id
          WHERE sr.source_revision_ref = NEW.source_revision_ref
            AND m.project_id = NEW.project_id
            AND m.valid_to IS NULL
            AND m.membership_generation = NEW.membership_generation
            AND m.membership_id IS json_array(NEW.project_id, sr.source_id)
            AND typeof(m.membership_revision) = 'integer'
            AND m.membership_revision > 0
            AND p.membership_generation = NEW.project_membership_generation
            AND (
              (NEW.membership_identity_version = 1)
              OR
              (NEW.membership_identity_version = 2
                AND m.membership_revision = NEW.membership_revision)
            )
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_MANAGED_ITEM_IDENTITY_INVALID');
END;

CREATE TRIGGER projection_managed_item_effect_update_guard
BEFORE UPDATE ON projection_managed_item_effect
WHEN NEW.source_revision_ref <> OLD.source_revision_ref
  OR NEW.projection_generation <> OLD.projection_generation
  OR NEW.job_id <> OLD.job_id
  OR NEW.item_key <> OLD.item_key
  OR NEW.canonical_projection_generation IS NOT OLD.canonical_projection_generation
  OR NEW.canonical_item_key IS NOT OLD.canonical_item_key
  OR NEW.project_id IS NOT OLD.project_id
  OR NEW.project_membership_id IS NOT OLD.project_membership_id
  OR NEW.membership_generation IS NOT OLD.membership_generation
  OR NEW.membership_identity_version IS NOT OLD.membership_identity_version
  OR NEW.legacy_project_membership_id IS NOT OLD.legacy_project_membership_id
  OR NEW.stable_project_membership_id IS NOT OLD.stable_project_membership_id
  OR NEW.membership_revision IS NOT OLD.membership_revision
  OR NEW.project_membership_generation IS NOT OLD.project_membership_generation
  OR NEW.copy_layout IS NOT OLD.copy_layout
  OR NEW.metadata_generation_digest IS NOT OLD.metadata_generation_digest
  OR NEW.canonical_body_ref IS NOT OLD.canonical_body_ref
  OR NEW.canonical_body_sha256 IS NOT OLD.canonical_body_sha256
  OR NEW.desired_index <> OLD.desired_index
  OR NEW.normalized_start_byte <> OLD.normalized_start_byte
  OR NEW.normalized_end_byte <> OLD.normalized_end_byte
  OR NEW.intent_id <> OLD.intent_id
  OR NEW.intent_revision <> OLD.intent_revision
  OR NEW.attempt_id <> OLD.attempt_id
  OR NEW.execution_operation_id <> OLD.execution_operation_id
  OR NEW.managed_instance_id <> OLD.managed_instance_id
  OR NEW.managed_generation <> OLD.managed_generation
  OR NEW.provider_source <> OLD.provider_source
  OR NEW.provider_key <> OLD.provider_key
  OR NEW.section_content_sha256 <> OLD.section_content_sha256
  OR NEW.document_sha256 <> OLD.document_sha256
  OR NEW.document_size_bytes <> OLD.document_size_bytes
  OR NEW.metadata_json <> OLD.metadata_json
  OR (OLD.provider_item_id IS NOT NULL AND NEW.provider_item_id IS NOT OLD.provider_item_id)
  OR (OLD.readback_receipt_json IS NOT NULL
    AND (NEW.readback_receipt_json IS NOT OLD.readback_receipt_json
      OR NEW.readback_sha256 IS NOT OLD.readback_sha256))
  OR (OLD.state = 'READBACK_VERIFIED' AND NEW.state <> OLD.state)
  OR (OLD.state = 'INTENT' AND NEW.state NOT IN ('INTENT', 'DISPATCHED'))
  OR (OLD.state = 'DISPATCHED' AND NEW.state NOT IN ('DISPATCHED', 'UNKNOWN', 'READBACK_VERIFIED'))
  OR (OLD.state = 'UNKNOWN' AND NEW.state NOT IN ('UNKNOWN', 'READBACK_VERIFIED'))
  OR (OLD.dispatch_lease_generation IS NOT NULL
    AND NEW.dispatch_lease_generation IS NOT OLD.dispatch_lease_generation)
  OR NEW.updated_at < OLD.updated_at
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_MANAGED_ITEM_IMMUTABLE');
END;

CREATE TRIGGER projection_managed_item_effect_no_delete
BEFORE DELETE ON projection_managed_item_effect
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_MANAGED_ITEM_IMMUTABLE');
END;

CREATE TRIGGER projection_managed_item_effect_target_pin_insert_guard
BEFORE INSERT ON projection_managed_item_effect
WHEN NOT EXISTS (
  SELECT 1 FROM projection_generation g
  WHERE g.source_revision_ref = NEW.source_revision_ref
    AND g.projection_generation = NEW.projection_generation
    AND g.job_id = NEW.job_id
    AND g.managed_item_protocol IS 'eliotr.managed-item-effects.v1'
    AND g.managed_target_instance_id IS NEW.managed_instance_id
    AND g.managed_target_generation IS NEW.managed_generation
    AND (NEW.copy_layout IS NULL
      OR g.managed_target_metadata_generation_digest IS NEW.metadata_generation_digest)
)
BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_MANAGED_ITEM_TARGET_MISMATCH');
END;
