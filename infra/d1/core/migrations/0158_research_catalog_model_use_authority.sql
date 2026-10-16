-- Persist the exact catalog choice separately from the legacy OpenRouter allowlist.
-- 0156 remains unchanged. This versioned owner operation authorizes one exact selected
-- provider/model tuple against the saved connection, including legacy explicit registrations.
PRAGMA foreign_keys=ON;

CREATE TABLE research_catalog_model_use_authorization (
  owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 256),
  operation_id TEXT NOT NULL CHECK(
    length(operation_id)=36 AND substr(operation_id,9,1)='-' AND substr(operation_id,14,1)='-' AND
    substr(operation_id,19,1)='-' AND substr(operation_id,24,1)='-' AND operation_id=lower(operation_id) AND
    substr(operation_id,1,8) NOT GLOB '*[^0-9a-f]*' AND substr(operation_id,10,4) NOT GLOB '*[^0-9a-f]*' AND
    substr(operation_id,15,4) NOT GLOB '*[^0-9a-f]*' AND substr(operation_id,20,4) NOT GLOB '*[^0-9a-f]*' AND
    substr(operation_id,25,12) NOT GLOB '*[^0-9a-f]*'
  ),
  provider_id TEXT NOT NULL CHECK(length(provider_id) BETWEEN 1 AND 64 AND provider_id NOT GLOB '*[^A-Za-z0-9._/-]*'),
  provider_operation_id TEXT CHECK(provider_operation_id IS NULL OR (
    length(provider_operation_id)=36 AND substr(provider_operation_id,9,1)='-' AND
    substr(provider_operation_id,14,1)='-' AND substr(provider_operation_id,19,1)='-' AND
    substr(provider_operation_id,24,1)='-' AND provider_operation_id=lower(provider_operation_id) AND
    substr(provider_operation_id,1,8) NOT GLOB '*[^0-9a-f]*' AND substr(provider_operation_id,10,4) NOT GLOB '*[^0-9a-f]*' AND
    substr(provider_operation_id,15,4) NOT GLOB '*[^0-9a-f]*' AND substr(provider_operation_id,20,4) NOT GLOB '*[^0-9a-f]*' AND
    substr(provider_operation_id,25,12) NOT GLOB '*[^0-9a-f]*'
  )),
  route_provider_id TEXT NOT NULL CHECK(length(route_provider_id) BETWEEN 1 AND 128 AND route_provider_id NOT GLOB '*[^A-Za-z0-9._:@/-]*'),
  model_id TEXT NOT NULL CHECK(length(model_id) BETWEEN 1 AND 256 AND model_id NOT GLOB '*[^A-Za-z0-9._:@/-]*'),
  account_id TEXT CHECK(account_id IS NULL OR (length(account_id)=32 AND account_id NOT GLOB '*[^A-Fa-f0-9]*')),
  gateway_id TEXT CHECK(gateway_id IS NULL OR (length(gateway_id) BETWEEN 1 AND 64 AND gateway_id NOT GLOB '*[^A-Za-z0-9._-]*')),
  alias TEXT CHECK(alias IS NULL OR (length(alias)=55 AND substr(alias,1,7)='eliotr-' AND substr(alias,8) NOT GLOB '*[^0-9a-f]*')),
  provider_config_id TEXT CHECK(provider_config_id IS NULL OR (length(provider_config_id) BETWEEN 1 AND 128 AND provider_config_id NOT GLOB '*[^A-Za-z0-9._:-]*')),
  configuration_metadata_sha256 TEXT CHECK(configuration_metadata_sha256 IS NULL OR
    (length(configuration_metadata_sha256)=64 AND configuration_metadata_sha256 NOT GLOB '*[^0-9a-f]*')),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  owner_credential_generation TEXT NOT NULL CHECK(length(owner_credential_generation) BETWEEN 1 AND 256),
  project_generation INTEGER NOT NULL CHECK(project_generation BETWEEN 1 AND 2147483647),
  deployment_generation TEXT NOT NULL CHECK(length(deployment_generation) BETWEEN 1 AND 256),
  expected_selection_revision INTEGER CHECK(expected_selection_revision IS NULL OR expected_selection_revision BETWEEN 1 AND 999999),
  source_configuration_ref TEXT CHECK(source_configuration_ref IS NULL OR
    (length(source_configuration_ref)=69 AND substr(source_configuration_ref,1,5)='rpmc-' AND substr(source_configuration_ref,6) NOT GLOB '*[^0-9a-f]*')),
  source_configuration_sha256 TEXT CHECK(source_configuration_sha256 IS NULL OR
    (length(source_configuration_sha256)=64 AND source_configuration_sha256 NOT GLOB '*[^0-9a-f]*')),
  state TEXT NOT NULL CHECK(state IN ('ACCEPTED','PREPARING','QUALIFYING','IMPORTING','SELECTED','BLOCKED','UNCERTAIN','CONFLICT')),
  phase TEXT NOT NULL CHECK(phase IN ('INTENT','PROVIDER_RESOLUTION','NATIVE_PREPARE','QUALIFICATION','CONFIGURATION_IMPORT','SELECTION_READBACK','COMPLETE')),
  selected_configuration_ref TEXT CHECK(selected_configuration_ref IS NULL OR
    (length(selected_configuration_ref)=69 AND substr(selected_configuration_ref,1,5)='rpmc-' AND substr(selected_configuration_ref,6) NOT GLOB '*[^0-9a-f]*')),
  selected_configuration_sha256 TEXT CHECK(selected_configuration_sha256 IS NULL OR
    (length(selected_configuration_sha256)=64 AND selected_configuration_sha256 NOT GLOB '*[^0-9a-f]*')),
  selection_revision INTEGER CHECK(selection_revision IS NULL OR selection_revision BETWEEN 1 AND 999999),
  failure_code TEXT CHECK(failure_code IS NULL OR failure_code IN (
    'PROVIDER_NOT_CONFIGURED','MODEL_NOT_SUPPORTED','SERVER_POLICY_UNAVAILABLE','PREPARATION_REJECTED',
    'QUALIFICATION_NO_EFFECT','QUALIFICATION_OUTCOME_UNCERTAIN','NATIVE_RECEIPT_INVALID',
    'SELECTION_CAS_CONFLICT','AUTHORITY_CHANGED','STORAGE_UNAVAILABLE'
  )),
  created_at TEXT NOT NULL CHECK(length(created_at) BETWEEN 1 AND 64),
  updated_at TEXT NOT NULL CHECK(length(updated_at) BETWEEN 1 AND 64),
  PRIMARY KEY(owner_id,project_id,operation_id),
  FOREIGN KEY(owner_id,provider_operation_id) REFERENCES service_model_provider_operation(owner_id,operation_id),
  CHECK((provider_id='cloudflare-workers-ai')=(provider_operation_id IS NULL)),
  CHECK((provider_operation_id IS NULL)=(account_id IS NULL)),
  CHECK((provider_operation_id IS NULL)=(gateway_id IS NULL)),
  CHECK((provider_operation_id IS NULL)=(alias IS NULL)),
  CHECK((provider_operation_id IS NULL)=(provider_config_id IS NULL)),
  CHECK((provider_operation_id IS NULL)=(configuration_metadata_sha256 IS NULL)),
  CHECK((source_configuration_ref IS NULL)=(source_configuration_sha256 IS NULL)),
  CHECK((source_configuration_ref IS NULL)=(expected_selection_revision IS NULL)),
  CHECK((selected_configuration_ref IS NULL)=(selected_configuration_sha256 IS NULL)),
  CHECK((selected_configuration_ref IS NULL)=(selection_revision IS NULL)),
  CHECK(selected_configuration_ref IS NULL OR selected_configuration_ref='rpmc-'||selected_configuration_sha256),
  CHECK(
    (state='SELECTED' AND phase='COMPLETE' AND selected_configuration_ref IS NOT NULL AND selection_revision IS NOT NULL AND failure_code IS NULL)
    OR (state IN ('ACCEPTED','PREPARING','QUALIFYING','IMPORTING') AND selected_configuration_ref IS NULL AND failure_code IS NULL)
    OR (state='BLOCKED' AND selected_configuration_ref IS NULL AND failure_code IS NOT NULL)
    OR (state='UNCERTAIN' AND selected_configuration_ref IS NULL AND failure_code='QUALIFICATION_OUTCOME_UNCERTAIN')
    OR (state='CONFLICT' AND selected_configuration_ref IS NULL AND failure_code='SELECTION_CAS_CONFLICT')
  )
) STRICT;

CREATE UNIQUE INDEX research_catalog_model_use_unresolved
  ON research_catalog_model_use_authorization(owner_id,project_id)
  WHERE state IN ('ACCEPTED','PREPARING','QUALIFYING','IMPORTING','UNCERTAIN');

CREATE INDEX research_catalog_model_use_history
  ON research_catalog_model_use_authorization(owner_id,project_id,created_at DESC,operation_id DESC);

CREATE TRIGGER research_catalog_model_use_authorization_insert
BEFORE INSERT ON research_catalog_model_use_authorization
WHEN NOT EXISTS (
  SELECT 1 FROM project p JOIN project_owner o ON o.project_id=p.project_id
  WHERE p.project_id=NEW.project_id AND p.generation=NEW.project_generation AND o.principal_ref=NEW.owner_id
)
OR (NEW.provider_operation_id IS NULL AND
  (NEW.provider_id IS NOT 'cloudflare-workers-ai' OR NEW.route_provider_id IS NOT 'workers-ai' OR
   substr(NEW.model_id,1,4) IS NOT '@cf/'))
OR (NEW.provider_operation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM service_model_provider_operation g
  WHERE g.owner_id=NEW.owner_id AND g.operation_id=NEW.provider_operation_id AND g.provider_id=NEW.provider_id
    AND g.provider_slug=NEW.route_provider_id AND g.state='CONFIGURED' AND g.failure_code IS NULL
    AND g.provider_http_status IS NULL AND g.alias=NEW.alias AND g.provider_config_id=NEW.provider_config_id
    AND g.metadata_sha256=NEW.configuration_metadata_sha256
    AND NEW.account_id IS NOT NULL AND NEW.gateway_id IS NOT NULL
    AND ((g.model_registration_mode='catalog_managed' AND json_valid(g.model_ids_json) AND
          json_type(g.model_ids_json)='array' AND json_array_length(g.model_ids_json)=0)
      OR (g.model_registration_mode='explicit_allowlist' AND json_valid(g.model_ids_json) AND
          json_type(g.model_ids_json)='array' AND json_array_length(g.model_ids_json) BETWEEN 1 AND 64))
))
BEGIN SELECT RAISE(ABORT,'exact current catalog model provider authority is required'); END;

CREATE TRIGGER research_catalog_model_use_authorization_no_delete
BEFORE DELETE ON research_catalog_model_use_authorization
BEGIN SELECT RAISE(ABORT,'catalog model-use authorization history is immutable'); END;

CREATE TRIGGER research_catalog_model_use_authorization_transition
BEFORE UPDATE ON research_catalog_model_use_authorization
WHEN NEW.owner_id IS NOT OLD.owner_id OR NEW.project_id IS NOT OLD.project_id OR
  NEW.operation_id IS NOT OLD.operation_id OR NEW.provider_id IS NOT OLD.provider_id OR
  NEW.provider_operation_id IS NOT OLD.provider_operation_id OR NEW.route_provider_id IS NOT OLD.route_provider_id OR
  NEW.model_id IS NOT OLD.model_id OR NEW.account_id IS NOT OLD.account_id OR NEW.gateway_id IS NOT OLD.gateway_id OR
  NEW.alias IS NOT OLD.alias OR NEW.provider_config_id IS NOT OLD.provider_config_id OR
  NEW.configuration_metadata_sha256 IS NOT OLD.configuration_metadata_sha256 OR NEW.request_sha256 IS NOT OLD.request_sha256 OR
  NEW.owner_credential_generation IS NOT OLD.owner_credential_generation OR NEW.project_generation IS NOT OLD.project_generation OR
  NEW.deployment_generation IS NOT OLD.deployment_generation OR
  NEW.expected_selection_revision IS NOT OLD.expected_selection_revision OR
  NEW.source_configuration_ref IS NOT OLD.source_configuration_ref OR
  NEW.source_configuration_sha256 IS NOT OLD.source_configuration_sha256 OR NEW.created_at IS NOT OLD.created_at OR
  (OLD.selected_configuration_ref IS NOT NULL AND NEW.selected_configuration_ref IS NOT OLD.selected_configuration_ref) OR
  (OLD.selected_configuration_sha256 IS NOT NULL AND NEW.selected_configuration_sha256 IS NOT OLD.selected_configuration_sha256) OR
  (OLD.selection_revision IS NOT NULL AND NEW.selection_revision IS NOT OLD.selection_revision) OR
  NOT ((OLD.state='ACCEPTED' AND NEW.state IN ('PREPARING','BLOCKED','CONFLICT')) OR
       (OLD.state='PREPARING' AND NEW.state IN ('PREPARING','QUALIFYING','BLOCKED','CONFLICT')) OR
       (OLD.state='QUALIFYING' AND NEW.state IN ('QUALIFYING','IMPORTING','BLOCKED','UNCERTAIN','CONFLICT')) OR
       (OLD.state='IMPORTING' AND NEW.state IN ('IMPORTING','SELECTED','BLOCKED','CONFLICT')))
BEGIN SELECT RAISE(ABORT,'catalog model-use identity is immutable and state transitions are monotone'); END;

CREATE TRIGGER research_catalog_model_use_authorization_selected_readback
BEFORE UPDATE OF state ON research_catalog_model_use_authorization
WHEN NEW.state='SELECTED' AND NEW.provider_operation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM research_project_model_configuration_selection s
  JOIN research_project_model_configuration_revision r ON r.owner_id=s.owner_id AND r.project_id=s.project_id
    AND r.configuration_ref=s.configuration_ref AND r.configuration_sha256=s.configuration_sha256
  WHERE s.owner_id=NEW.owner_id AND s.project_id=NEW.project_id AND s.configuration_ref=NEW.selected_configuration_ref
    AND s.configuration_sha256=NEW.selected_configuration_sha256 AND s.selection_revision=NEW.selection_revision
    AND json_valid(r.configuration_json)
    AND EXISTS (SELECT 1 FROM json_each(r.configuration_json,'$.model_selections') m
      WHERE json_extract(m.value,'$.stage')='SYNTHESIZE'
        AND json_extract(m.value,'$.candidate_kind')='provider-native-v1'
        AND json_extract(m.value,'$.transport_policy.provider')=NEW.route_provider_id
        AND json_extract(m.value,'$.transport_policy.model')=NEW.model_id
        AND EXISTS (SELECT 1 FROM provider_native_model_candidate c
          JOIN provider_native_model_qualification_proof q
            ON q.qualification_ref=json_extract(m.value,'$.qualification_ref')
            AND q.qualification_sha256=json_extract(m.value,'$.qualification_sha256')
          WHERE c.candidate_ref=json_extract(m.value,'$.candidate_ref')
            AND c.candidate_sha256=json_extract(m.value,'$.candidate_sha256')
            AND c.owner_ref=NEW.owner_id AND c.project_id=NEW.project_id AND c.stage='SYNTHESIZE'
            AND c.route_ref=json_extract(m.value,'$.route_ref') AND c.route_version=json_extract(m.value,'$.route_version')
            AND q.owner_ref=NEW.owner_id AND q.project_id=NEW.project_id AND q.stage='SYNTHESIZE'
            AND q.route_ref=json_extract(m.value,'$.route_ref') AND q.route_version=json_extract(m.value,'$.route_version')
            AND c.qualification_tier='LIVE' AND q.qualification_tier='LIVE'
            AND json_extract(c.candidate_json,'$.preparation.transport_policy.provider')=NEW.route_provider_id
            AND json_extract(c.candidate_json,'$.preparation.transport_policy.model')=NEW.model_id))
)
BEGIN SELECT RAISE(ABORT,'selected catalog model must match qualified project configuration readback'); END;

CREATE TRIGGER research_catalog_model_use_builtin_selected_readback
BEFORE UPDATE OF state ON research_catalog_model_use_authorization
WHEN NEW.state='SELECTED' AND NEW.provider_operation_id IS NULL AND NOT EXISTS (
  SELECT 1 FROM research_project_model_configuration_selection s
  JOIN research_project_model_configuration_revision r ON r.owner_id=s.owner_id AND r.project_id=s.project_id
    AND r.configuration_ref=s.configuration_ref AND r.configuration_sha256=s.configuration_sha256
  WHERE s.owner_id=NEW.owner_id AND s.project_id=NEW.project_id AND s.configuration_ref=NEW.selected_configuration_ref
    AND s.configuration_sha256=NEW.selected_configuration_sha256 AND s.selection_revision=NEW.selection_revision
    AND NEW.provider_id='cloudflare-workers-ai' AND NEW.route_provider_id='workers-ai'
    AND json_valid(r.configuration_json)
    AND EXISTS (SELECT 1 FROM json_each(r.configuration_json,'$.model_selections') m
      WHERE json_extract(m.value,'$.stage')='SYNTHESIZE'
        AND json_extract(m.value,'$.transport_policy.provider')=NEW.route_provider_id
        AND json_extract(m.value,'$.transport_policy.model')=NEW.model_id
        AND json_extract(m.value,'$.transport_policy.api')='compat-chat-completions'
        AND json_extract(m.value,'$.transport_policy.billing.mode')='unified'
        AND EXISTS (SELECT 1 FROM dynamic_route_candidate c
          JOIN dynamic_route_qualification_proof q ON q.candidate_ref=c.candidate_ref
            AND q.candidate_sha256=c.candidate_sha256 AND q.route_ref=c.route_ref AND q.route_version=c.route_version
          WHERE c.route_ref=json_extract(m.value,'$.route_ref')
            AND c.route_version=json_extract(m.value,'$.route_version')
            AND c.candidate_ref=json_extract(m.value,'$.candidate_ref')
            AND c.candidate_sha256=json_extract(m.value,'$.candidate_sha256')
            AND q.qualification_ref=json_extract(m.value,'$.qualification_ref')
            AND q.proof_sha256=json_extract(m.value,'$.qualification_sha256')
            AND json_extract(q.qualification_json,'$.qualification.tier')='LIVE'
            AND julianday(json_extract(q.qualification_json,'$.qualification.expires_at'))>julianday('now')
            AND NOT EXISTS (SELECT 1 FROM dynamic_route_qualification_revocation revoked
              WHERE revoked.qualification_ref=q.qualification_ref AND revoked.qualification_sha256=q.proof_sha256)))
)
BEGIN SELECT RAISE(ABORT,'selected Workers AI catalog model must match a qualified project model'); END;

CREATE TRIGGER research_catalog_model_use_provider_delete
BEFORE DELETE ON service_model_provider_operation
WHEN EXISTS (SELECT 1 FROM research_catalog_model_use_authorization a
  WHERE a.owner_id=OLD.owner_id AND a.provider_operation_id=OLD.operation_id)
BEGIN SELECT RAISE(ABORT,'catalog model-use provider identity is immutable'); END;

CREATE TRIGGER research_catalog_model_use_provider_identity
BEFORE UPDATE ON service_model_provider_operation
WHEN (NEW.owner_id IS NOT OLD.owner_id OR NEW.operation_id IS NOT OLD.operation_id OR NEW.provider_id IS NOT OLD.provider_id OR
      NEW.provider_slug IS NOT OLD.provider_slug OR NEW.base_url IS NOT OLD.base_url OR NEW.request_sha256 IS NOT OLD.request_sha256 OR
      NEW.alias IS NOT OLD.alias OR NEW.provider_config_id IS NOT OLD.provider_config_id OR
      NEW.metadata_sha256 IS NOT OLD.metadata_sha256 OR NEW.model_ids_json IS NOT OLD.model_ids_json OR
      NEW.model_registration_mode IS NOT OLD.model_registration_mode OR NEW.state IS NOT OLD.state)
  AND EXISTS (SELECT 1 FROM research_catalog_model_use_authorization a
    WHERE a.owner_id=OLD.owner_id AND a.provider_operation_id=OLD.operation_id)
BEGIN SELECT RAISE(ABORT,'catalog model-use provider identity and registration mode are immutable'); END;

-- Preserve 0156's explicit registry branch and add a catalog-managed branch that is authorized
-- only by the exact operation/model tuple above.
DROP VIEW research_provider_key_model_use_key_authority;
CREATE VIEW research_provider_key_model_use_key_authority AS
SELECT k.owner_id,k.project_id,k.provider_id,k.operation_id,k.account_id,k.gateway_id,k.alias,k.state,
  k.provider_config_id,k.metadata_sha256,k.failure_code,k.provider_http_status,k.created_at,
  NULL AS model_registration_mode,NULL AS model_ids_json
FROM research_provider_key_configuration_operation k
UNION ALL
SELECT g.owner_id,u.project_id,g.provider_id,g.operation_id,u.account_id,u.gateway_id,g.alias,g.state,
  g.provider_config_id,g.metadata_sha256,g.failure_code,g.provider_http_status,g.created_at,
  g.model_registration_mode,g.model_ids_json
FROM service_model_provider_operation g JOIN research_provider_key_model_use_operation u
  ON g.owner_id=u.owner_id AND g.operation_id=u.key_operation_id AND g.provider_id=u.provider_id
LEFT JOIN research_catalog_model_use_authorization a ON a.owner_id=u.owner_id AND a.project_id=u.project_id
  AND a.operation_id=u.operation_id AND a.provider_id=g.provider_id AND a.provider_operation_id=g.operation_id
WHERE g.provider_id='openrouter' AND g.provider_slug='openrouter' AND g.state='CONFIGURED'
  AND g.failure_code IS NULL AND g.provider_http_status IS NULL AND g.alias=u.alias
  AND g.provider_config_id=u.provider_config_id AND g.metadata_sha256=u.configuration_metadata_sha256
  AND u.gateway_id='eliotr-reasoning'
  AND json_valid(u.configuration_basis_json)
  AND json_extract(u.configuration_basis_json,'$.protocol') IS 'eliotr.research.provider-key-model-use-basis.v1'
  AND json_type(u.configuration_basis_json,'$.stages')='array'
  AND json_array_length(u.configuration_basis_json,'$.stages') BETWEEN 2 AND 4
  AND ((g.model_registration_mode='explicit_allowlist' AND json_array_length(g.model_ids_json) BETWEEN 1 AND 64
    AND NOT EXISTS (SELECT 1 FROM json_each(g.model_ids_json) registered
      WHERE registered.type<>'text' OR length(registered.value) NOT BETWEEN 1 AND 256 OR
        registered.value GLOB '*[^A-Za-z0-9._:@/-]*' OR (substr(registered.value,1,1) NOT GLOB '[A-Za-z0-9]'
          AND NOT (substr(registered.value,1,1)='@' AND substr(registered.value,2,1) GLOB '[A-Za-z0-9]')))
    AND NOT EXISTS (SELECT 1 FROM json_each(u.configuration_basis_json,'$.stages') pinned
      WHERE json_extract(pinned.value,'$.transport_policy.provider') IS NOT 'openrouter'
        OR json_extract(pinned.value,'$.transport_policy.api') IS NOT 'openrouter-chat-completions'
        OR json_extract(pinned.value,'$.transport_policy.billing.mode') IS NOT 'byok'
        OR json_extract(pinned.value,'$.transport_policy.billing.alias') IS NOT u.alias
        OR json_extract(pinned.value,'$.transport_policy.billing.free_only') IS NOT 1
        OR NOT EXISTS (SELECT 1 FROM json_each(g.model_ids_json) registered
          WHERE registered.type='text' AND registered.value IS json_extract(pinned.value,'$.transport_policy.model'))))
    OR (g.model_registration_mode='catalog_managed' AND a.operation_id IS NOT NULL
      AND a.provider_operation_id=g.operation_id AND a.provider_id=g.provider_id
      AND a.state IN ('ACCEPTED','PREPARING','QUALIFYING','IMPORTING','SELECTED')
      AND a.route_provider_id='openrouter' AND a.model_id IS NOT NULL AND json_valid(g.model_ids_json)
      AND a.alias=u.alias AND a.provider_config_id=u.provider_config_id
      AND a.configuration_metadata_sha256=u.configuration_metadata_sha256
      AND a.owner_credential_generation=u.owner_credential_generation
      AND a.project_generation=u.project_generation AND a.deployment_generation=u.deployment_generation
      AND a.expected_selection_revision IS u.expected_selection_revision
      AND a.source_configuration_ref IS u.source_configuration_ref
      AND a.source_configuration_sha256 IS u.source_configuration_sha256
      AND json_type(g.model_ids_json)='array' AND json_array_length(g.model_ids_json)=0
      AND NOT EXISTS (SELECT 1 FROM json_each(u.configuration_basis_json,'$.stages') pinned
        WHERE json_extract(pinned.value,'$.transport_policy.provider') IS NOT a.route_provider_id
          OR json_extract(pinned.value,'$.transport_policy.api') IS NOT 'openrouter-chat-completions'
          OR json_extract(pinned.value,'$.transport_policy.billing.mode') IS NOT 'byok'
          OR json_extract(pinned.value,'$.transport_policy.billing.alias') IS NOT u.alias
          OR json_extract(pinned.value,'$.transport_policy.billing.free_only') IS NOT 1
        OR json_extract(pinned.value,'$.transport_policy.model') IS NOT a.model_id))
    OR (g.model_registration_mode='explicit_allowlist' AND a.operation_id IS NOT NULL
      AND a.state IN ('ACCEPTED','PREPARING','QUALIFYING','IMPORTING','SELECTED')
      AND a.provider_operation_id=g.operation_id AND a.provider_id=g.provider_id
      AND a.route_provider_id='openrouter' AND a.model_id IS NOT NULL
      AND a.alias=u.alias AND a.provider_config_id=u.provider_config_id
      AND a.configuration_metadata_sha256=u.configuration_metadata_sha256
      AND a.owner_credential_generation=u.owner_credential_generation
      AND a.project_generation=u.project_generation AND a.deployment_generation=u.deployment_generation
      AND a.expected_selection_revision IS u.expected_selection_revision
      AND a.source_configuration_ref IS u.source_configuration_ref
      AND a.source_configuration_sha256 IS u.source_configuration_sha256
      AND json_valid(g.model_ids_json) AND json_type(g.model_ids_json)='array'
      AND json_array_length(g.model_ids_json) BETWEEN 1 AND 64
      AND NOT EXISTS (SELECT 1 FROM json_each(u.configuration_basis_json,'$.stages') pinned
        WHERE json_extract(pinned.value,'$.transport_policy.provider') IS NOT a.route_provider_id
          OR json_extract(pinned.value,'$.transport_policy.api') IS NOT 'openrouter-chat-completions'
          OR json_extract(pinned.value,'$.transport_policy.billing.mode') IS NOT 'byok'
          OR json_extract(pinned.value,'$.transport_policy.billing.alias') IS NOT u.alias
          OR json_extract(pinned.value,'$.transport_policy.billing.free_only') IS NOT 1
          OR json_extract(pinned.value,'$.transport_policy.model') IS NOT a.model_id)))
AND NOT EXISTS (SELECT 1 FROM research_provider_key_configuration_operation k
  WHERE k.owner_id=u.owner_id AND k.project_id=u.project_id AND k.provider_id=u.provider_id AND k.operation_id=u.key_operation_id);

DROP TRIGGER research_provider_key_model_use_key_insert;
CREATE TRIGGER research_provider_key_model_use_key_insert
BEFORE INSERT ON research_provider_key_model_use_operation
WHEN NOT (
  EXISTS (SELECT 1 FROM research_provider_key_configuration_operation k
    WHERE k.owner_id=NEW.owner_id AND k.project_id=NEW.project_id AND k.provider_id=NEW.provider_id AND k.operation_id=NEW.key_operation_id
      AND k.state='CONFIGURED' AND k.account_id=NEW.account_id AND k.gateway_id=NEW.gateway_id
      AND k.alias=NEW.alias AND k.provider_config_id=NEW.provider_config_id AND k.metadata_sha256=NEW.configuration_metadata_sha256)
  OR EXISTS (
    SELECT 1 FROM service_model_provider_operation g
    WHERE g.owner_id=NEW.owner_id AND g.operation_id=NEW.key_operation_id AND g.provider_id='openrouter'
      AND g.provider_slug='openrouter' AND g.state='CONFIGURED' AND g.failure_code IS NULL AND g.provider_http_status IS NULL
      AND g.alias=NEW.alias AND g.provider_config_id=NEW.provider_config_id
      AND g.metadata_sha256=NEW.configuration_metadata_sha256 AND NEW.provider_id='openrouter'
      AND NEW.gateway_id='eliotr-reasoning'
      AND NOT EXISTS (SELECT 1 FROM research_provider_key_configuration_operation k
        WHERE k.owner_id=NEW.owner_id AND k.project_id=NEW.project_id AND k.provider_id=NEW.provider_id
          AND k.operation_id=NEW.key_operation_id)
      AND json_valid(NEW.configuration_basis_json)
      AND json_extract(NEW.configuration_basis_json,'$.protocol') IS 'eliotr.research.provider-key-model-use-basis.v1'
      AND json_type(NEW.configuration_basis_json,'$.stages')='array'
      AND json_array_length(NEW.configuration_basis_json,'$.stages') BETWEEN 2 AND 4
      AND g.model_registration_mode='explicit_allowlist' AND json_valid(g.model_ids_json)
      AND json_type(g.model_ids_json)='array' AND json_array_length(g.model_ids_json) BETWEEN 1 AND 64
      AND NOT EXISTS (SELECT 1 FROM json_each(g.model_ids_json) registered
        WHERE registered.type<>'text' OR length(registered.value) NOT BETWEEN 1 AND 256
          OR registered.value GLOB '*[^A-Za-z0-9._:@/-]*'
          OR (substr(registered.value,1,1) NOT GLOB '[A-Za-z0-9]'
            AND NOT (substr(registered.value,1,1)='@' AND substr(registered.value,2,1) GLOB '[A-Za-z0-9]')))
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.configuration_basis_json,'$.stages') pinned
        WHERE json_extract(pinned.value,'$.transport_policy.provider') IS NOT 'openrouter'
          OR json_extract(pinned.value,'$.transport_policy.api') IS NOT 'openrouter-chat-completions'
          OR json_extract(pinned.value,'$.transport_policy.billing.mode') IS NOT 'byok'
          OR json_extract(pinned.value,'$.transport_policy.billing.alias') IS NOT NEW.alias
          OR json_extract(pinned.value,'$.transport_policy.billing.free_only') IS NOT 1
          OR NOT EXISTS (SELECT 1 FROM json_each(g.model_ids_json) registered
            WHERE registered.type='text' AND registered.value IS json_extract(pinned.value,'$.transport_policy.model')))
  )
  OR EXISTS (
    SELECT 1 FROM service_model_provider_operation g
    JOIN research_catalog_model_use_authorization a ON a.owner_id=g.owner_id
      AND a.project_id=NEW.project_id AND a.operation_id=NEW.operation_id
      AND a.provider_operation_id=g.operation_id AND a.provider_id=g.provider_id
    WHERE g.owner_id=NEW.owner_id AND g.operation_id=NEW.key_operation_id AND g.provider_id='openrouter'
      AND g.provider_slug='openrouter' AND g.state='CONFIGURED' AND g.failure_code IS NULL AND g.provider_http_status IS NULL
      AND g.alias=NEW.alias AND g.provider_config_id=NEW.provider_config_id
      AND g.metadata_sha256=NEW.configuration_metadata_sha256 AND NEW.provider_id='openrouter'
      AND NEW.gateway_id='eliotr-reasoning'
      AND NOT EXISTS (SELECT 1 FROM research_provider_key_configuration_operation k
        WHERE k.owner_id=NEW.owner_id AND k.project_id=NEW.project_id AND k.provider_id=NEW.provider_id
          AND k.operation_id=NEW.key_operation_id)
      AND a.alias=NEW.alias AND a.provider_config_id=NEW.provider_config_id
      AND a.configuration_metadata_sha256=NEW.configuration_metadata_sha256
      AND a.owner_credential_generation=NEW.owner_credential_generation
      AND a.project_generation=NEW.project_generation AND a.deployment_generation=NEW.deployment_generation
      AND a.expected_selection_revision IS NEW.expected_selection_revision
      AND a.source_configuration_ref IS NEW.source_configuration_ref
      AND a.source_configuration_sha256 IS NEW.source_configuration_sha256
      AND a.route_provider_id='openrouter' AND a.model_id IS NOT NULL AND a.state IN ('ACCEPTED','PREPARING')
      AND json_valid(NEW.configuration_basis_json)
      AND json_extract(NEW.configuration_basis_json,'$.protocol') IS 'eliotr.research.provider-key-model-use-basis.v1'
      AND json_type(NEW.configuration_basis_json,'$.stages')='array'
      AND json_array_length(NEW.configuration_basis_json,'$.stages') BETWEEN 2 AND 4
      AND ((g.model_registration_mode='catalog_managed' AND json_valid(g.model_ids_json)
            AND json_type(g.model_ids_json)='array' AND json_array_length(g.model_ids_json)=0)
        OR (g.model_registration_mode='explicit_allowlist' AND json_valid(g.model_ids_json)
            AND json_type(g.model_ids_json)='array' AND json_array_length(g.model_ids_json) BETWEEN 1 AND 64))
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.configuration_basis_json,'$.stages') pinned
        WHERE json_extract(pinned.value,'$.transport_policy.provider') IS NOT a.route_provider_id
          OR json_extract(pinned.value,'$.transport_policy.api') IS NOT 'openrouter-chat-completions'
          OR json_extract(pinned.value,'$.transport_policy.billing.mode') IS NOT 'byok'
          OR json_extract(pinned.value,'$.transport_policy.billing.alias') IS NOT NEW.alias
          OR json_extract(pinned.value,'$.transport_policy.billing.free_only') IS NOT 1
          OR json_extract(pinned.value,'$.transport_policy.model') IS NOT a.model_id)
  )
)
BEGIN SELECT RAISE(ABORT,'current configured project or exact catalog model authorization is required'); END;
