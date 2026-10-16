-- Extend the existing owner check/use authority to exact global Settings model pins. No credential/project-key rows are copied.

-- Existing child FKs are NO ACTION. Keep foreign_keys enabled and defer those checks only during the canonical parent swap;

-- never rename the old parent (which would rewrite child references), disable FKs, or drop/copy/delete any child table.

-- Only the exclusive project-key FK is replaced by dual-source insert and source-side identity/delete guards.
-- Child FKs and every existing receipt/intent/attempt byte are retained. Do not add a new FK to historical project rows.

PRAGMA defer_foreign_keys=ON;

CREATE TABLE research_provider_key_model_use_operation_0156_copy (
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 256),
  provider_id TEXT NOT NULL CHECK (provider_id = 'openrouter'),
  operation_id TEXT NOT NULL CHECK (
    length(operation_id) = 36
    AND substr(operation_id, 9, 1) = '-'
    AND substr(operation_id, 14, 1) = '-'
    AND substr(operation_id, 19, 1) = '-'
    AND substr(operation_id, 24, 1) = '-'
    AND operation_id = lower(operation_id)
    AND substr(operation_id, 1, 8) NOT GLOB '*[^0-9a-f]*'
    AND substr(operation_id, 10, 4) NOT GLOB '*[^0-9a-f]*'
    AND substr(operation_id, 15, 4) NOT GLOB '*[^0-9a-f]*'
    AND substr(operation_id, 20, 4) NOT GLOB '*[^0-9a-f]*'
    AND substr(operation_id, 25, 12) NOT GLOB '*[^0-9a-f]*'
  ),
  key_operation_id TEXT NOT NULL CHECK (
    length(key_operation_id) = 36
    AND substr(key_operation_id, 9, 1) = '-'
    AND substr(key_operation_id, 14, 1) = '-'
    AND substr(key_operation_id, 19, 1) = '-'
    AND substr(key_operation_id, 24, 1) = '-'
    AND key_operation_id = lower(key_operation_id)
    AND substr(key_operation_id, 1, 8) NOT GLOB '*[^0-9a-f]*'
    AND substr(key_operation_id, 10, 4) NOT GLOB '*[^0-9a-f]*'
    AND substr(key_operation_id, 15, 4) NOT GLOB '*[^0-9a-f]*'
    AND substr(key_operation_id, 20, 4) NOT GLOB '*[^0-9a-f]*'
    AND substr(key_operation_id, 25, 12) NOT GLOB '*[^0-9a-f]*'
  ),
  account_id TEXT NOT NULL CHECK (length(account_id) = 32 AND account_id NOT GLOB '*[^A-Fa-f0-9]*'),
  gateway_id TEXT NOT NULL CHECK (
    length(gateway_id) BETWEEN 1 AND 64 AND substr(gateway_id, 1, 1) GLOB '[A-Za-z0-9]' AND
    gateway_id NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  alias TEXT NOT NULL CHECK (
    length(alias) = 55 AND substr(alias, 1, 7) = 'eliotr-' AND substr(alias, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  provider_config_id TEXT NOT NULL CHECK (
    length(provider_config_id) BETWEEN 1 AND 128 AND provider_config_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  configuration_metadata_sha256 TEXT NOT NULL CHECK (
    length(configuration_metadata_sha256) = 64 AND configuration_metadata_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  configuration_basis_json TEXT NOT NULL CHECK (length(configuration_basis_json) BETWEEN 2 AND 524288),
  owner_credential_generation TEXT NOT NULL CHECK (length(owner_credential_generation) BETWEEN 1 AND 256),
  project_generation INTEGER NOT NULL CHECK (project_generation BETWEEN 1 AND 2147483647),
  deployment_generation TEXT NOT NULL CHECK (length(deployment_generation) BETWEEN 1 AND 256),
  deadline_at TEXT NOT NULL CHECK (length(deadline_at) BETWEEN 1 AND 64),
  expected_selection_revision INTEGER CHECK (expected_selection_revision IS NULL OR expected_selection_revision BETWEEN 1 AND 999999),
  source_configuration_ref TEXT CHECK (
    source_configuration_ref IS NULL OR
    (length(source_configuration_ref) = 69 AND substr(source_configuration_ref, 1, 5) = 'rpmc-' AND
      substr(source_configuration_ref, 6) NOT GLOB '*[^0-9a-f]*')
  ),
  source_configuration_sha256 TEXT CHECK (
    source_configuration_sha256 IS NULL OR
    (length(source_configuration_sha256) = 64 AND source_configuration_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  planned_stage_set_sha256 TEXT NOT NULL CHECK (length(planned_stage_set_sha256) = 64 AND planned_stage_set_sha256 NOT GLOB '*[^0-9a-f]*'),
  plan_sha256 TEXT NOT NULL CHECK (length(plan_sha256) = 64 AND plan_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('ACCEPTED','PREPARING','QUALIFYING','IMPORTING','SELECTED','BLOCKED','UNCERTAIN','CONFLICT')),
  phase TEXT NOT NULL CHECK (phase IN ('INTENT','FREE_PRICE_CHECK','NATIVE_PREPARE','NATIVE_QUALIFY','CONFIGURATION_IMPORT','SELECTION_READBACK','COMPLETE')),
  active_stage TEXT CHECK (active_stage IS NULL OR active_stage IN ('ANALYZE_BRANCHES','COUNTER_SEARCH','SYNTHESIZE','AUDIT_CLAIMS')),
  target_configuration_ref TEXT CHECK (
    target_configuration_ref IS NULL OR
    (length(target_configuration_ref) = 69 AND substr(target_configuration_ref, 1, 5) = 'rpmc-' AND
      substr(target_configuration_ref, 6) NOT GLOB '*[^0-9a-f]*')
  ),
  target_configuration_sha256 TEXT CHECK (
    target_configuration_sha256 IS NULL OR
    (length(target_configuration_sha256) = 64 AND target_configuration_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  target_configuration_json TEXT CHECK (
    target_configuration_json IS NULL OR length(target_configuration_json) BETWEEN 2 AND 262144
  ),
  selected_configuration_ref TEXT CHECK (
    selected_configuration_ref IS NULL OR
    (length(selected_configuration_ref) = 69 AND substr(selected_configuration_ref, 1, 5) = 'rpmc-' AND
      substr(selected_configuration_ref, 6) NOT GLOB '*[^0-9a-f]*')
  ),
  selection_revision INTEGER CHECK (selection_revision IS NULL OR selection_revision BETWEEN 1 AND 999999),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'NO_SELECTED_CONFIGURATION','FREE_PRICE_NOT_PROVEN','FREE_PRICE_NOT_ZERO',
    'SERVER_POLICY_UNAVAILABLE','PREPARATION_REJECTED','QUALIFICATION_NO_EFFECT',
    'QUALIFICATION_OUTCOME_UNCERTAIN','NATIVE_RECEIPT_INVALID',
    'SELECTION_CAS_CONFLICT','AUTHORITY_CHANGED','STORAGE_UNAVAILABLE'
  )),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
  PRIMARY KEY (owner_id, project_id, operation_id),
  CHECK ((source_configuration_ref IS NULL) = (source_configuration_sha256 IS NULL)),
  CHECK ((source_configuration_ref IS NULL) = (expected_selection_revision IS NULL)),
  CHECK ((target_configuration_ref IS NULL) = (target_configuration_sha256 IS NULL)),
  CHECK ((target_configuration_ref IS NULL) = (target_configuration_json IS NULL)),
  CHECK (target_configuration_ref IS NULL OR target_configuration_ref = 'rpmc-' || target_configuration_sha256),
  CHECK ((selected_configuration_ref IS NULL) = (selection_revision IS NULL)),
  CHECK (selected_configuration_ref IS NULL OR selected_configuration_ref = target_configuration_ref),
  CHECK (
    (state = 'SELECTED' AND phase = 'COMPLETE' AND target_configuration_ref IS NOT NULL AND
      selected_configuration_ref IS NOT NULL AND selection_revision IS NOT NULL AND failure_code IS NULL) OR
    (state IN ('ACCEPTED','PREPARING','QUALIFYING','IMPORTING') AND selected_configuration_ref IS NULL AND
      selection_revision IS NULL AND failure_code IS NULL) OR
    (state = 'BLOCKED' AND selected_configuration_ref IS NULL AND selection_revision IS NULL AND failure_code IS NOT NULL) OR
    (state = 'UNCERTAIN' AND selected_configuration_ref IS NULL AND selection_revision IS NULL AND
      failure_code = 'QUALIFICATION_OUTCOME_UNCERTAIN' AND phase = 'NATIVE_QUALIFY') OR
    (state = 'CONFLICT' AND selected_configuration_ref IS NULL AND selection_revision IS NULL AND
      failure_code = 'SELECTION_CAS_CONFLICT')
  ),
  CHECK (
    (state = 'ACCEPTED' AND phase = 'INTENT') OR
    (state = 'PREPARING' AND phase IN ('FREE_PRICE_CHECK','NATIVE_PREPARE')) OR
    (state = 'QUALIFYING' AND phase = 'NATIVE_QUALIFY') OR
    (state = 'IMPORTING' AND phase IN ('CONFIGURATION_IMPORT','SELECTION_READBACK')) OR
    (state = 'SELECTED' AND phase = 'COMPLETE') OR
    (state = 'BLOCKED' AND phase IN ('INTENT','FREE_PRICE_CHECK','NATIVE_PREPARE','NATIVE_QUALIFY','CONFIGURATION_IMPORT')) OR
    (state = 'UNCERTAIN' AND phase = 'NATIVE_QUALIFY') OR
    (state = 'CONFLICT' AND phase IN ('INTENT','FREE_PRICE_CHECK','NATIVE_PREPARE','NATIVE_QUALIFY','SELECTION_READBACK'))
  )
) STRICT;

INSERT INTO research_provider_key_model_use_operation_0156_copy SELECT * FROM research_provider_key_model_use_operation;

CREATE TABLE research_provider_key_model_price_observation_0156_copy (
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 256),
  operation_id TEXT NOT NULL CHECK (length(operation_id) = 36),
  stage TEXT NOT NULL CHECK (stage IN ('ANALYZE_BRANCHES','COUNTER_SEARCH','SYNTHESIZE','AUDIT_CLAIMS')),
  key_operation_id TEXT NOT NULL CHECK (length(key_operation_id) = 36),
  account_id TEXT NOT NULL CHECK (length(account_id) = 32 AND account_id NOT GLOB '*[^A-Fa-f0-9]*'),
  gateway_id TEXT NOT NULL CHECK (
    length(gateway_id) BETWEEN 1 AND 64 AND substr(gateway_id, 1, 1) GLOB '[A-Za-z0-9]' AND
    gateway_id NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  alias TEXT NOT NULL CHECK (
    length(alias) = 55 AND substr(alias, 1, 7) = 'eliotr-' AND substr(alias, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  provider_config_id TEXT NOT NULL CHECK (
    length(provider_config_id) BETWEEN 1 AND 128 AND provider_config_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  configuration_metadata_sha256 TEXT NOT NULL CHECK (
    length(configuration_metadata_sha256) = 64 AND configuration_metadata_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  owner_credential_generation TEXT NOT NULL CHECK (length(owner_credential_generation) BETWEEN 1 AND 256),
  project_generation INTEGER NOT NULL CHECK (project_generation BETWEEN 1 AND 2147483647),
  deployment_generation TEXT NOT NULL CHECK (length(deployment_generation) BETWEEN 1 AND 256),
  route_ref TEXT NOT NULL CHECK (route_ref IN (
    'dynamic/eliotr-economy','dynamic/eliotr-balanced','dynamic/eliotr-strong','dynamic/eliotr-frontier',
    'dynamic/eliotr-audit-writer','dynamic/eliotr-audit-verifier','dynamic/eliotr-vision',
    'dynamic/eliotr-extract','dynamic/eliotr-report-section','dynamic/eliotr-report-integrator'
  )),
  route_version TEXT NOT NULL CHECK (length(route_version) BETWEEN 1 AND 256),
  provider_id TEXT NOT NULL CHECK (provider_id = 'openrouter'),
  exact_model_id TEXT NOT NULL CHECK (length(exact_model_id) BETWEEN 1 AND 256 AND exact_model_id NOT GLOB '*[^A-Za-z0-9._:@/-]*'),
  source_url TEXT NOT NULL CHECK (length(source_url) BETWEEN 1 AND 2048),
  observation_ref TEXT NOT NULL UNIQUE CHECK (length(observation_ref) BETWEEN 1 AND 256),
  source_response_sha256 TEXT NOT NULL CHECK (length(source_response_sha256) = 64 AND source_response_sha256 NOT GLOB '*[^0-9a-f]*'),
  response_base64 TEXT NOT NULL CHECK (
    length(response_base64) BETWEEN 4 AND 43692 AND response_base64 NOT GLOB '*[^A-Za-z0-9+/=]*'
  ),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 32768),
  readback_sha256 TEXT NOT NULL CHECK (length(readback_sha256) = 64 AND readback_sha256 NOT GLOB '*[^0-9a-f]*'),
  observed_at TEXT NOT NULL CHECK (length(observed_at) BETWEEN 1 AND 64),
  expires_at TEXT NOT NULL CHECK (length(expires_at) BETWEEN 1 AND 64),
  approval_receipt_ref TEXT NOT NULL CHECK (length(approval_receipt_ref) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
  PRIMARY KEY (owner_id, project_id, operation_id, stage),
  FOREIGN KEY (owner_id, project_id, operation_id, stage)
    REFERENCES research_provider_key_model_use_stage_operation(owner_id, project_id, operation_id, stage),
  CHECK (length(response_base64) = 4 * ((byte_length + 2) / 3)),
  CHECK (source_response_sha256 = readback_sha256),
  CHECK (approval_receipt_ref = operation_id)
) STRICT;

INSERT INTO research_provider_key_model_price_observation_0156_copy SELECT * FROM research_provider_key_model_price_observation;

CREATE TABLE global_model_use_0156_copy_guard (ok INTEGER NOT NULL CHECK(ok=1));

-- An unexpected cascading/restricting child must abort before either parent is dropped.
INSERT INTO global_model_use_0156_copy_guard
SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM sqlite_schema t JOIN pragma_foreign_key_list(t.name) fk
  WHERE t.type='table' AND fk."table" IN ('research_provider_key_model_use_operation','research_provider_key_model_price_observation')
    AND fk.on_delete<>'NO ACTION'
) THEN 1 ELSE 0 END;

INSERT INTO global_model_use_0156_copy_guard SELECT CASE WHEN
    NOT EXISTS (SELECT * FROM research_provider_key_model_use_operation EXCEPT SELECT * FROM research_provider_key_model_use_operation_0156_copy)
    AND NOT EXISTS (SELECT * FROM research_provider_key_model_use_operation_0156_copy EXCEPT SELECT * FROM research_provider_key_model_use_operation) THEN 1 ELSE 0 END;

INSERT INTO global_model_use_0156_copy_guard SELECT CASE WHEN
    NOT EXISTS (SELECT * FROM research_provider_key_model_price_observation EXCEPT SELECT * FROM research_provider_key_model_price_observation_0156_copy)
    AND NOT EXISTS (SELECT * FROM research_provider_key_model_price_observation_0156_copy EXCEPT SELECT * FROM research_provider_key_model_price_observation) THEN 1 ELSE 0 END;

DROP TRIGGER provider_native_model_candidate_guard;

DROP TRIGGER provider_native_model_observation_guard;

DROP TRIGGER provider_native_model_preparation_guard;

DROP TRIGGER provider_native_model_qualification_attempt_guard;

DROP TRIGGER provider_native_model_qualification_complete_guard;

DROP TRIGGER provider_native_model_qualification_proof_guard;

DROP TRIGGER research_provider_key_model_price_observation_immutable_delete;

DROP TRIGGER research_provider_key_model_price_observation_immutable_update;

DROP TRIGGER research_provider_key_model_price_observation_owner_insert;

DROP TRIGGER research_provider_key_model_use_no_delete;

DROP TRIGGER research_provider_key_model_use_owner_insert;

DROP TRIGGER research_provider_key_model_use_transition;

DROP TABLE research_provider_key_model_price_observation;

DROP TABLE research_provider_key_model_use_operation;

ALTER TABLE research_provider_key_model_use_operation_0156_copy RENAME TO research_provider_key_model_use_operation;

ALTER TABLE research_provider_key_model_price_observation_0156_copy RENAME TO research_provider_key_model_price_observation;

CREATE INDEX research_provider_key_model_use_history
  ON research_provider_key_model_use_operation(owner_id, project_id, created_at DESC, operation_id DESC);

CREATE UNIQUE INDEX research_provider_key_model_use_unresolved
  ON research_provider_key_model_use_operation(owner_id, project_id)
  WHERE state IN ('ACCEPTED','PREPARING','QUALIFYING','IMPORTING','UNCERTAIN');

-- Read-through authority projection over existing canonical rows; this view has no independent state.
CREATE VIEW research_provider_key_model_use_key_authority AS
SELECT k.owner_id,k.project_id,k.provider_id,k.operation_id,k.account_id,k.gateway_id,k.alias,k.state,
  k.provider_config_id,k.metadata_sha256,k.failure_code,k.provider_http_status,k.created_at,NULL AS model_ids_json
FROM research_provider_key_configuration_operation k
UNION ALL
SELECT g.owner_id,u.project_id,g.provider_id,g.operation_id,u.account_id,u.gateway_id,g.alias,g.state,
  g.provider_config_id,g.metadata_sha256,g.failure_code,g.provider_http_status,g.created_at,g.model_ids_json
FROM service_model_provider_operation g JOIN research_provider_key_model_use_operation u ON g.owner_id=u.owner_id AND g.operation_id=u.key_operation_id AND g.provider_id=u.provider_id
    AND g.provider_id='openrouter' AND g.provider_slug='openrouter' AND g.state='CONFIGURED'
    AND g.failure_code IS NULL AND g.provider_http_status IS NULL
    AND g.alias=u.alias AND g.provider_config_id=u.provider_config_id AND g.metadata_sha256=u.configuration_metadata_sha256
    AND u.gateway_id='eliotr-reasoning' AND json_valid(u.configuration_basis_json)
    AND json_extract(u.configuration_basis_json,'$.protocol') IS 'eliotr.research.provider-key-model-use-basis.v1'
    AND json_type(u.configuration_basis_json,'$.stages')='array'
    AND json_array_length(u.configuration_basis_json,'$.stages') BETWEEN 2 AND 4
    AND json_array_length(g.model_ids_json) BETWEEN 1 AND 64
    AND NOT EXISTS (SELECT 1 FROM json_each(g.model_ids_json) registered
      WHERE registered.type<>'text' OR length(registered.value) NOT BETWEEN 1 AND 256
        OR registered.value GLOB '*[^A-Za-z0-9._:@/-]*'
        OR (substr(registered.value,1,1) NOT GLOB '[A-Za-z0-9]'
          AND NOT (substr(registered.value,1,1)='@' AND substr(registered.value,2,1) GLOB '[A-Za-z0-9]')))
    AND NOT EXISTS (SELECT 1 FROM json_each(u.configuration_basis_json,'$.stages') pinned
      WHERE json_extract(pinned.value,'$.transport_policy.provider') IS NOT 'openrouter'
        OR json_extract(pinned.value,'$.transport_policy.api') IS NOT 'openrouter-chat-completions'
        OR json_extract(pinned.value,'$.transport_policy.billing.mode') IS NOT 'byok'
        OR json_extract(pinned.value,'$.transport_policy.billing.alias') IS NOT u.alias
        OR json_extract(pinned.value,'$.transport_policy.billing.free_only') IS NOT 1
        OR NOT EXISTS (SELECT 1 FROM json_each(g.model_ids_json) registered
          WHERE registered.type='text' AND registered.value IS json_extract(pinned.value,'$.transport_policy.model')))
WHERE NOT EXISTS (SELECT 1 FROM research_provider_key_configuration_operation k
  WHERE k.owner_id=u.owner_id AND k.project_id=u.project_id AND k.provider_id=u.provider_id AND k.operation_id=u.key_operation_id);

CREATE TRIGGER provider_native_model_candidate_guard BEFORE INSERT ON provider_native_model_candidate
BEGIN
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_CANDIDATE_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_native_model_preparation prep
    JOIN provider_native_model_qualification_attempt a ON a.owner_ref=prep.owner_ref AND a.project_id=prep.project_id AND a.owner_operation_id=prep.owner_operation_id AND a.stage=prep.stage
      AND a.preparation_ref=prep.preparation_ref AND a.preparation_sha256=prep.preparation_sha256
    JOIN provider_native_model_qualification_observation obs ON obs.observation_ref=NEW.observation_ref AND obs.observation_sha256=NEW.observation_sha256
      AND obs.owner_ref=prep.owner_ref AND obs.project_id=prep.project_id AND obs.owner_operation_id=prep.owner_operation_id AND obs.stage=prep.stage
      AND obs.preparation_ref=prep.preparation_ref AND obs.preparation_sha256=prep.preparation_sha256
    JOIN research_provider_key_model_use_operation u ON u.owner_id=prep.owner_ref AND u.project_id=prep.project_id AND u.operation_id=prep.owner_operation_id
    JOIN research_provider_key_model_use_stage_operation s ON s.owner_id=u.owner_id AND s.project_id=u.project_id AND s.operation_id=u.operation_id AND s.stage=prep.stage
    JOIN research_provider_key_model_use_key_authority k ON k.owner_id=u.owner_id AND k.project_id=u.project_id AND k.provider_id=u.provider_id AND k.operation_id=u.key_operation_id
    JOIN project p ON p.project_id=u.project_id JOIN project_owner o ON o.project_id=p.project_id
    WHERE prep.preparation_ref=NEW.preparation_ref AND prep.preparation_sha256=NEW.preparation_sha256
      AND prep.owner_ref=NEW.owner_ref AND prep.project_id=NEW.project_id AND prep.stage=NEW.stage
      AND prep.route_ref=NEW.route_ref AND prep.route_version=NEW.route_version
      AND a.state='OBSERVED' AND a.observation_ref=NEW.observation_ref AND a.observation_sha256=NEW.observation_sha256
      AND s.state='QUALIFYING' AND s.preparation_ref=NEW.preparation_ref AND s.preparation_sha256=NEW.preparation_sha256
      AND u.state='QUALIFYING' AND u.phase='NATIVE_QUALIFY' AND u.active_stage=NEW.stage
      AND k.state='CONFIGURED' AND k.account_id=u.account_id AND k.gateway_id=u.gateway_id AND k.alias=u.alias
      AND k.provider_config_id=u.provider_config_id AND k.metadata_sha256=u.configuration_metadata_sha256
      AND p.generation=u.project_generation AND o.principal_ref=u.owner_id
      AND NEW.candidate_ref IS ('provider-native-model-candidate-' || NEW.candidate_sha256)
      AND json_extract(NEW.candidate_json,'$.preparation_ref') IS NEW.preparation_ref
      AND json_extract(NEW.candidate_json,'$.preparation_sha256') IS NEW.preparation_sha256
      AND json_extract(NEW.candidate_json,'$.preparation') IS prep.preparation_json
      AND json_extract(NEW.candidate_json,'$.observation_ref') IS NEW.observation_ref
      AND json_extract(NEW.candidate_json,'$.observation_sha256') IS NEW.observation_sha256
      AND json_extract(NEW.candidate_json,'$.preparation.owner_ref') IS NEW.owner_ref
      AND json_extract(NEW.candidate_json,'$.preparation.project_id') IS NEW.project_id
      AND json_extract(NEW.candidate_json,'$.preparation.stage') IS NEW.stage
      AND json_extract(NEW.candidate_json,'$.preparation.deployment.route_ref') IS NEW.route_ref
      AND json_extract(NEW.candidate_json,'$.preparation.deployment.route_version') IS NEW.route_version
      AND json_extract(NEW.candidate_json,'$.verified_at') IS NEW.verified_at
      AND json_extract(NEW.candidate_json,'$.qualification_expires_at') IS NEW.qualification_expires_at
      AND NEW.verified_at IS json_extract(obs.observation_json,'$.verified_at')
      AND NEW.qualification_expires_at IS json_extract(obs.observation_json,'$.expires_at')
      AND julianday(NEW.qualification_expires_at)>julianday(NEW.created_at)
      AND julianday(NEW.qualification_expires_at)<=julianday(u.deadline_at)
  );
END;

CREATE TRIGGER provider_native_model_observation_guard BEFORE INSERT ON provider_native_model_qualification_observation
BEGIN
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_OBSERVATION_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_native_model_qualification_attempt a
    JOIN provider_native_model_preparation prep ON prep.preparation_ref=a.preparation_ref AND prep.preparation_sha256=a.preparation_sha256
    JOIN research_provider_key_model_use_operation u ON u.owner_id=prep.owner_ref AND u.project_id=prep.project_id AND u.operation_id=prep.owner_operation_id
    JOIN research_provider_key_model_use_stage_operation s ON s.owner_id=u.owner_id AND s.project_id=u.project_id AND s.operation_id=u.operation_id AND s.stage=prep.stage
    JOIN research_provider_key_model_use_key_authority k ON k.owner_id=u.owner_id AND k.project_id=u.project_id AND k.provider_id=u.provider_id AND k.operation_id=u.key_operation_id
    JOIN project p ON p.project_id=u.project_id JOIN project_owner o ON o.project_id=p.project_id
    WHERE a.owner_ref=NEW.owner_ref AND a.project_id=NEW.project_id AND a.owner_operation_id=NEW.owner_operation_id AND a.stage=NEW.stage
      AND a.preparation_ref=NEW.preparation_ref AND a.preparation_sha256=NEW.preparation_sha256 AND a.state='STARTED'
      AND u.state='QUALIFYING' AND u.phase='NATIVE_QUALIFY' AND u.active_stage=NEW.stage
      AND s.state='QUALIFYING' AND s.preparation_ref=NEW.preparation_ref AND s.preparation_sha256=NEW.preparation_sha256
      AND k.state='CONFIGURED' AND k.account_id=u.account_id AND k.gateway_id=u.gateway_id AND k.alias=u.alias
      AND k.provider_config_id=u.provider_config_id AND k.metadata_sha256=u.configuration_metadata_sha256
      AND p.generation=u.project_generation AND o.principal_ref=u.owner_id
      AND json_extract(NEW.observation_json,'$.execution.gateway_log_id') IS NOT NULL
      AND json_extract(NEW.observation_json,'$.execution.response_body_sha256') IS NOT NULL
      AND json_extract(NEW.observation_json,'$.execution.request_body_sha256') IS NOT NULL
      AND json_extract(NEW.observation_json,'$.execution.probe_prompt_sha256') IS json_extract(prep.preparation_json,'$.probe_prompt_sha256')
      AND json_extract(NEW.observation_json,'$.execution.probe_schema_sha256') IS json_extract(prep.preparation_json,'$.probe_schema_sha256')
      AND json_extract(NEW.observation_json,'$.execution.probe_parameters_sha256') IS json_extract(prep.preparation_json,'$.probe_parameters_sha256')
      AND json_extract(NEW.observation_json,'$.execution.response_model') IS json_extract(prep.preparation_json,'$.transport_policy.model')
      AND json_extract(NEW.observation_json,'$.execution.input_tokens') >= 0
      AND json_extract(NEW.observation_json,'$.execution.output_tokens') >= 0
      AND json_extract(NEW.observation_json,'$.execution.pricing_quote_ref') IS NOT NULL
  );
END;

CREATE TRIGGER provider_native_model_preparation_guard
BEFORE INSERT ON provider_native_model_preparation
BEGIN
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1 FROM research_provider_key_model_use_operation u
    JOIN research_provider_key_model_use_stage_operation s
      ON s.owner_id=u.owner_id AND s.project_id=u.project_id AND s.operation_id=u.operation_id
    JOIN research_provider_key_model_use_key_authority k
      ON k.owner_id=u.owner_id AND k.project_id=u.project_id AND k.provider_id=u.provider_id AND k.operation_id=u.key_operation_id
    JOIN project p ON p.project_id=u.project_id
    JOIN project_owner o ON o.project_id=p.project_id
    JOIN research_model_pricing_snapshot price
      ON price.pricing_snapshot_ref=s.pricing_snapshot_ref
    WHERE u.owner_id=NEW.owner_ref AND u.project_id=NEW.project_id AND u.operation_id=NEW.owner_operation_id
      AND s.stage=NEW.stage AND s.route_ref=NEW.route_ref AND s.route_version=NEW.route_version
      AND s.state='PENDING' AND s.pricing_snapshot_sha256 IS NOT NULL
      AND s.sequence_number BETWEEN 0 AND 3
      AND u.state='PREPARING' AND u.phase='NATIVE_PREPARE' AND u.active_stage=NEW.stage
      AND p.generation=u.project_generation AND o.principal_ref=u.owner_id
      AND k.state='CONFIGURED' AND k.account_id=u.account_id AND k.gateway_id=u.gateway_id AND k.alias=u.alias
      AND k.provider_config_id=u.provider_config_id AND k.metadata_sha256=u.configuration_metadata_sha256
  );
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1 FROM research_provider_key_model_use_operation u
    JOIN research_provider_key_model_use_stage_operation s
      ON s.owner_id=u.owner_id AND s.project_id=u.project_id AND s.operation_id=u.operation_id
    WHERE u.owner_id=NEW.owner_ref AND u.project_id=NEW.project_id AND u.operation_id=NEW.owner_operation_id
      AND u.state='PREPARING' AND u.phase='NATIVE_PREPARE' AND u.active_stage=NEW.stage
      AND s.stage=NEW.stage AND s.state='PENDING' AND s.route_ref=NEW.route_ref AND s.route_version=NEW.route_version
      AND json_extract(NEW.preparation_json,'$.protocol') IS 'eliotr.provider-native-model-preparation.v1'
      AND json_extract(NEW.preparation_json,'$.owner_ref') IS NEW.owner_ref
      AND json_extract(NEW.preparation_json,'$.project_id') IS NEW.project_id
      AND json_extract(NEW.preparation_json,'$.owner_operation_id') IS NEW.owner_operation_id
      AND json_extract(NEW.preparation_json,'$.stage') IS NEW.stage
      AND json_extract(NEW.preparation_json,'$.deployment.route_ref') IS NEW.route_ref
      AND json_extract(NEW.preparation_json,'$.deployment.route_version') IS NEW.route_version
      AND json_extract(NEW.preparation_json,'$.deployment.prompt_generation') IS ('eliotr.research.owner-prompt-' || s.prompt_sha256)
      AND json_extract(NEW.preparation_json,'$.deployment.schema_generation') IS ('eliotr.research.owner-schema-' || s.schema_sha256)
      AND json_extract(NEW.preparation_json,'$.deployment.parameters_digest') IS s.parameters_sha256
      AND json_extract(NEW.preparation_json,'$.prompt_sha256') IS s.prompt_sha256
      AND json_extract(NEW.preparation_json,'$.schema_sha256') IS s.schema_sha256
      AND json_extract(NEW.preparation_json,'$.parameters_sha256') IS s.parameters_sha256
  );
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1 FROM research_provider_key_model_use_operation u
    JOIN research_provider_key_model_use_stage_operation s
      ON s.owner_id=u.owner_id AND s.project_id=u.project_id AND s.operation_id=u.operation_id
    WHERE u.owner_id=NEW.owner_ref AND u.project_id=NEW.project_id AND u.operation_id=NEW.owner_operation_id
      AND u.state='PREPARING' AND u.phase='NATIVE_PREPARE' AND u.active_stage=NEW.stage
      AND s.stage=NEW.stage AND s.state='PENDING' AND s.route_ref=NEW.route_ref AND s.route_version=NEW.route_version
      AND json_extract(NEW.preparation_json,'$.probe_deployment.route_ref') IS s.route_ref
      AND json_extract(NEW.preparation_json,'$.probe_deployment.route_version') IS s.route_version
      AND json_extract(NEW.preparation_json,'$.probe_deployment.pricing_snapshot_ref') IS s.pricing_snapshot_ref
      AND json_extract(NEW.preparation_json,'$.probe_prompt_sha256') IS s.probe_prompt_sha256
      AND json_extract(NEW.preparation_json,'$.probe_schema_sha256') IS s.probe_schema_sha256
      AND json_extract(NEW.preparation_json,'$.probe_parameters_sha256') IS s.probe_parameters_sha256
      AND json_extract(NEW.preparation_json,'$.probe_deployment.prompt_generation') IS ('eliotr.research.provider-native-probe-prompt-' || s.probe_prompt_sha256)
      AND json_extract(NEW.preparation_json,'$.probe_deployment.schema_generation') IS ('eliotr.research.provider-native-probe-schema-' || s.probe_schema_sha256)
      AND json_extract(NEW.preparation_json,'$.probe_deployment.parameters_digest') IS json_extract(NEW.preparation_json,'$.probe_parameters_sha256')
  );
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1 FROM research_provider_key_model_use_operation u
    JOIN research_provider_key_model_use_stage_operation s
      ON s.owner_id=u.owner_id AND s.project_id=u.project_id AND s.operation_id=u.operation_id
    JOIN research_provider_key_model_use_key_authority k
      ON k.owner_id=u.owner_id AND k.project_id=u.project_id AND k.provider_id=u.provider_id AND k.operation_id=u.key_operation_id
    JOIN research_model_pricing_snapshot price ON price.pricing_snapshot_ref=s.pricing_snapshot_ref
    WHERE u.owner_id=NEW.owner_ref AND u.project_id=NEW.project_id AND u.operation_id=NEW.owner_operation_id
      AND s.stage=NEW.stage AND s.state='PENDING' AND s.route_ref=NEW.route_ref AND s.route_version=NEW.route_version
      AND u.state='PREPARING' AND u.phase='NATIVE_PREPARE' AND u.active_stage=NEW.stage
      AND k.state='CONFIGURED' AND k.account_id=u.account_id AND k.gateway_id=u.gateway_id AND k.alias=u.alias
      AND k.provider_config_id=u.provider_config_id AND k.metadata_sha256=u.configuration_metadata_sha256
      AND json_extract(NEW.preparation_json,'$.key_binding.operation_id') IS u.key_operation_id
      AND json_extract(NEW.preparation_json,'$.key_binding.owner_ref') IS u.owner_id
      AND json_extract(NEW.preparation_json,'$.key_binding.project_id') IS u.project_id
      AND json_extract(NEW.preparation_json,'$.key_binding.provider_id') IS 'openrouter'
      AND json_extract(NEW.preparation_json,'$.key_binding.account_id') IS u.account_id
      AND json_extract(NEW.preparation_json,'$.key_binding.gateway_id') IS u.gateway_id
      AND json_extract(NEW.preparation_json,'$.key_binding.alias') IS u.alias
      AND json_extract(NEW.preparation_json,'$.key_binding.provider_config_id') IS u.provider_config_id
      AND json_extract(NEW.preparation_json,'$.key_binding.configuration_metadata_sha256') IS u.configuration_metadata_sha256
  );
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1 FROM research_provider_key_model_use_operation u
    JOIN research_provider_key_model_use_stage_operation s
      ON s.owner_id=u.owner_id AND s.project_id=u.project_id AND s.operation_id=u.operation_id
    JOIN research_model_pricing_snapshot price ON price.pricing_snapshot_ref=s.pricing_snapshot_ref
    WHERE u.owner_id=NEW.owner_ref AND u.project_id=NEW.project_id AND u.operation_id=NEW.owner_operation_id
      AND s.stage=NEW.stage AND s.state='PENDING' AND s.route_ref=NEW.route_ref AND s.route_version=NEW.route_version
      AND u.state='PREPARING' AND u.phase='NATIVE_PREPARE' AND u.active_stage=NEW.stage
      AND json_extract(NEW.preparation_json,'$.transport_policy.api') IS 'openrouter-chat-completions'
      AND json_extract(NEW.preparation_json,'$.transport_policy.provider') IS 'openrouter'
      AND json_extract(NEW.preparation_json,'$.transport_policy.model') IS price.exact_model_id
      AND json_extract(NEW.preparation_json,'$.transport_policy.billing.mode') IS 'byok'
      AND json_extract(NEW.preparation_json,'$.transport_policy.billing.alias') IS u.alias
      AND json_extract(NEW.preparation_json,'$.transport_policy.billing.free_only') IS 1
      AND json_extract(NEW.preparation_json,'$.transport_policy') IS
        json_extract(u.configuration_basis_json, '$.stages[' || s.sequence_number || '].transport_policy')
      AND price.route_ref=s.route_ref AND price.route_version=s.route_version
      AND price.provider='openrouter' AND price.pricing_basis='EXACT_TOKEN_RATES_V1'
      AND price.snapshot_sha256=s.pricing_snapshot_sha256
      AND price.input_rate_usd_per_1k_tokens='0' AND price.output_rate_usd_per_1k_tokens='0'
  );
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1 FROM research_provider_key_model_use_operation u
    JOIN research_provider_key_model_use_stage_operation s
      ON s.owner_id=u.owner_id AND s.project_id=u.project_id AND s.operation_id=u.operation_id
    JOIN research_model_pricing_snapshot price ON price.pricing_snapshot_ref=s.pricing_snapshot_ref
    WHERE u.owner_id=NEW.owner_ref AND u.project_id=NEW.project_id AND u.operation_id=NEW.owner_operation_id
      AND s.stage=NEW.stage AND s.state='PENDING' AND s.route_ref=NEW.route_ref AND s.route_version=NEW.route_version
      AND price.route_ref=s.route_ref AND price.route_version=s.route_version
      AND price.snapshot_sha256=s.pricing_snapshot_sha256
      AND julianday(price.effective_at)<=julianday(NEW.created_at)
      AND julianday(price.expires_at)>julianday(NEW.created_at)
      AND julianday(json_extract(NEW.preparation_json,'$.preparation_expires_at'))>julianday(NEW.created_at)
      AND julianday(json_extract(NEW.preparation_json,'$.preparation_expires_at'))<=julianday(u.deadline_at)
      AND json_extract(NEW.preparation_json,'$.pricing_snapshot_ref') IS s.pricing_snapshot_ref
      AND json_extract(NEW.preparation_json,'$.pricing_snapshot_sha256') IS s.pricing_snapshot_sha256
      AND json_extract(NEW.preparation_json,'$.request_sha256') IS NEW.request_sha256
  );
END;

CREATE TRIGGER provider_native_model_qualification_attempt_guard
BEFORE INSERT ON provider_native_model_qualification_attempt
BEGIN
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_QUALIFICATION_CLAIM_INVALID')
  WHERE NEW.state IS NOT 'STARTED' OR NOT EXISTS (
    SELECT 1 FROM provider_native_model_preparation prep
    JOIN research_provider_key_model_use_operation u
      ON u.owner_id=prep.owner_ref AND u.project_id=prep.project_id AND u.operation_id=prep.owner_operation_id
    JOIN research_provider_key_model_use_stage_operation s
      ON s.owner_id=u.owner_id AND s.project_id=u.project_id AND s.operation_id=u.operation_id AND s.stage=prep.stage
    JOIN research_provider_key_model_use_key_authority k
      ON k.owner_id=u.owner_id AND k.project_id=u.project_id AND k.provider_id=u.provider_id AND k.operation_id=u.key_operation_id
    JOIN project p ON p.project_id=u.project_id JOIN project_owner o ON o.project_id=p.project_id
    WHERE prep.preparation_ref=NEW.preparation_ref AND prep.preparation_sha256=NEW.preparation_sha256
      AND prep.owner_ref=NEW.owner_ref AND prep.project_id=NEW.project_id
      AND prep.owner_operation_id=NEW.owner_operation_id AND prep.stage=NEW.stage
      AND u.state='QUALIFYING' AND u.phase='NATIVE_QUALIFY' AND u.active_stage=NEW.stage
      AND s.state='QUALIFYING' AND s.preparation_ref=NEW.preparation_ref AND s.preparation_sha256=NEW.preparation_sha256
      AND k.state='CONFIGURED' AND k.account_id=u.account_id AND k.gateway_id=u.gateway_id AND k.alias=u.alias
      AND k.provider_config_id=u.provider_config_id AND k.metadata_sha256=u.configuration_metadata_sha256
      AND p.generation=u.project_generation AND o.principal_ref=u.owner_id
      AND julianday(json_extract(prep.preparation_json,'$.preparation_expires_at'))>julianday(NEW.started_at)
  );
END;

CREATE TRIGGER provider_native_model_qualification_complete_guard
BEFORE UPDATE OF state ON provider_native_model_qualification_attempt
WHEN NEW.state='COMPLETED'
BEGIN
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_COMPLETION_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_native_model_candidate c
    JOIN provider_native_model_qualification_proof q ON q.qualification_ref=NEW.qualification_ref AND q.qualification_sha256=NEW.qualification_sha256
      AND q.candidate_ref=c.candidate_ref AND q.candidate_sha256=c.candidate_sha256
    JOIN research_provider_key_model_use_operation u ON u.owner_id=c.owner_ref AND u.project_id=c.project_id AND u.operation_id=NEW.owner_operation_id
    JOIN research_provider_key_model_use_stage_operation s ON s.owner_id=u.owner_id AND s.project_id=u.project_id AND s.operation_id=u.operation_id AND s.stage=c.stage
    WHERE c.candidate_ref=NEW.candidate_ref AND c.candidate_sha256=NEW.candidate_sha256
      AND c.observation_ref=NEW.observation_ref AND c.observation_sha256=NEW.observation_sha256
      AND u.state='QUALIFYING' AND u.phase='NATIVE_QUALIFY' AND u.active_stage=NEW.stage
      AND s.state='QUALIFYING' AND s.preparation_ref=NEW.preparation_ref AND s.preparation_sha256=NEW.preparation_sha256
      AND s.candidate_ref IS NULL AND s.qualification_ref IS NULL
  );
END;

CREATE TRIGGER provider_native_model_qualification_proof_guard BEFORE INSERT ON provider_native_model_qualification_proof
BEGIN
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_PROOF_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_native_model_candidate c
    JOIN provider_native_model_qualification_attempt a
      ON a.owner_ref=c.owner_ref AND a.project_id=c.project_id
      AND a.owner_operation_id=json_extract(c.candidate_json,'$.preparation.owner_operation_id')
      AND a.stage=c.stage AND a.preparation_ref=c.preparation_ref
      AND a.preparation_sha256=c.preparation_sha256
      AND a.observation_ref=c.observation_ref AND a.observation_sha256=c.observation_sha256
    WHERE c.candidate_ref=NEW.candidate_ref AND c.candidate_sha256=NEW.candidate_sha256
      AND c.owner_ref=NEW.owner_ref AND c.project_id=NEW.project_id AND c.stage=NEW.stage
      AND c.route_ref=NEW.route_ref AND c.route_version=NEW.route_version
      AND c.observation_ref=NEW.observation_ref AND c.observation_sha256=NEW.observation_sha256
      AND a.owner_ref=c.owner_ref AND a.project_id=c.project_id
      AND a.owner_operation_id=json_extract(c.candidate_json,'$.preparation.owner_operation_id') AND a.stage=c.stage
      AND a.preparation_ref=c.preparation_ref AND a.preparation_sha256=c.preparation_sha256
      AND a.observation_ref=NEW.observation_ref AND a.observation_sha256=NEW.observation_sha256
      AND a.state='OBSERVED' AND a.candidate_ref IS NULL AND a.candidate_sha256 IS NULL
      AND a.qualification_ref IS NULL AND a.qualification_sha256 IS NULL
      AND NEW.qualification_ref IS ('provider-native-model-qualification-' || NEW.qualification_sha256)
  );
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_PROOF_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_native_model_candidate c
    JOIN provider_native_model_qualification_attempt a
      ON a.owner_ref=c.owner_ref AND a.project_id=c.project_id
      AND a.owner_operation_id=json_extract(c.candidate_json,'$.preparation.owner_operation_id')
      AND a.stage=c.stage AND a.preparation_ref=c.preparation_ref
      AND a.preparation_sha256=c.preparation_sha256
      AND a.observation_ref=c.observation_ref AND a.observation_sha256=c.observation_sha256
    JOIN research_provider_key_model_use_operation u ON u.owner_id=c.owner_ref AND u.project_id=c.project_id AND u.operation_id=a.owner_operation_id
    JOIN research_provider_key_model_use_stage_operation s ON s.owner_id=u.owner_id AND s.project_id=u.project_id AND s.operation_id=u.operation_id AND s.stage=c.stage
    JOIN research_provider_key_model_use_key_authority k ON k.owner_id=u.owner_id AND k.project_id=u.project_id AND k.provider_id=u.provider_id AND k.operation_id=u.key_operation_id
    JOIN project p ON p.project_id=u.project_id JOIN project_owner o ON o.project_id=p.project_id
    WHERE c.candidate_ref=NEW.candidate_ref AND c.candidate_sha256=NEW.candidate_sha256
      AND a.state='OBSERVED' AND a.candidate_ref IS NULL AND a.candidate_sha256 IS NULL
      AND a.qualification_ref IS NULL AND a.qualification_sha256 IS NULL
      AND a.observation_ref=c.observation_ref AND a.observation_sha256=c.observation_sha256
      AND u.state='QUALIFYING' AND u.phase='NATIVE_QUALIFY' AND u.active_stage=NEW.stage
      AND s.state='QUALIFYING' AND s.candidate_ref IS NULL AND s.qualification_ref IS NULL
      AND s.preparation_ref=c.preparation_ref AND s.preparation_sha256=c.preparation_sha256
      AND p.generation=u.project_generation AND o.principal_ref=u.owner_id
      AND k.state='CONFIGURED' AND k.account_id=u.account_id AND k.gateway_id=u.gateway_id AND k.alias=u.alias
      AND k.provider_config_id=u.provider_config_id AND k.metadata_sha256=u.configuration_metadata_sha256
      AND julianday(NEW.expires_at)<=julianday(u.deadline_at)
  );
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_PROOF_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_native_model_candidate c
    JOIN provider_native_model_qualification_observation obs
      ON obs.observation_ref=c.observation_ref AND obs.observation_sha256=c.observation_sha256
    WHERE c.candidate_ref=NEW.candidate_ref AND c.candidate_sha256=NEW.candidate_sha256
      AND json_extract(NEW.qualification_json,'$.candidate_ref') IS NEW.candidate_ref
      AND json_extract(NEW.qualification_json,'$.candidate_sha256') IS NEW.candidate_sha256
      AND json_extract(NEW.qualification_json,'$.stage') IS NEW.stage
      AND json_extract(NEW.qualification_json,'$.route_ref') IS NEW.route_ref
      AND json_extract(NEW.qualification_json,'$.route_version') IS NEW.route_version
      AND json_extract(NEW.qualification_json,'$.qualification.observation_ref') IS NEW.observation_ref
      AND json_extract(NEW.qualification_json,'$.qualification.observation_sha256') IS NEW.observation_sha256
  );
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_PROOF_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_native_model_candidate c
    JOIN provider_native_model_qualification_observation obs
      ON obs.observation_ref=c.observation_ref AND obs.observation_sha256=c.observation_sha256
    WHERE c.candidate_ref=NEW.candidate_ref AND c.candidate_sha256=NEW.candidate_sha256
      AND json_extract(NEW.qualification_json,'$.qualification.request_body_sha256') IS json_extract(obs.observation_json,'$.execution.request_body_sha256')
      AND json_extract(NEW.qualification_json,'$.qualification.response_body_sha256') IS json_extract(obs.observation_json,'$.execution.response_body_sha256')
      AND json_extract(NEW.qualification_json,'$.qualification.response_body_byte_length') IS json_extract(obs.observation_json,'$.execution.response_body_byte_length')
      AND json_extract(NEW.qualification_json,'$.qualification.response_model') IS json_extract(obs.observation_json,'$.execution.response_model')
      AND json_extract(NEW.qualification_json,'$.qualification.gateway_log_id') IS json_extract(obs.observation_json,'$.execution.gateway_log_id')
      AND json_extract(NEW.qualification_json,'$.qualification.input_tokens') IS json_extract(obs.observation_json,'$.execution.input_tokens')
      AND json_extract(NEW.qualification_json,'$.qualification.output_tokens') IS json_extract(obs.observation_json,'$.execution.output_tokens')
      AND json_extract(NEW.qualification_json,'$.qualification.pricing_quote_ref') IS json_extract(obs.observation_json,'$.execution.pricing_quote_ref')
  );
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_PROOF_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_native_model_candidate c
    WHERE c.candidate_ref=NEW.candidate_ref AND c.candidate_sha256=NEW.candidate_sha256
      AND json_extract(NEW.qualification_json,'$.qualification.probe_prompt_sha256') IS json_extract(c.candidate_json,'$.preparation.probe_prompt_sha256')
      AND json_extract(NEW.qualification_json,'$.qualification.probe_schema_sha256') IS json_extract(c.candidate_json,'$.preparation.probe_schema_sha256')
      AND json_extract(NEW.qualification_json,'$.qualification.probe_parameters_sha256') IS json_extract(c.candidate_json,'$.preparation.probe_parameters_sha256')
      AND json_extract(NEW.qualification_json,'$.qualification.installed_prompt_sha256') IS json_extract(c.candidate_json,'$.preparation.prompt_sha256')
      AND json_extract(NEW.qualification_json,'$.qualification.installed_schema_sha256') IS json_extract(c.candidate_json,'$.preparation.schema_sha256')
      AND json_extract(NEW.qualification_json,'$.qualification.installed_parameters_sha256') IS json_extract(c.candidate_json,'$.preparation.parameters_sha256')
      AND json_extract(NEW.qualification_json,'$.qualification.installed_deployment.route_ref') IS json_extract(c.candidate_json,'$.preparation.deployment.route_ref')
      AND json_extract(NEW.qualification_json,'$.qualification.installed_deployment.route_version') IS json_extract(c.candidate_json,'$.preparation.deployment.route_version')
      AND json_extract(NEW.qualification_json,'$.qualification.probe_deployment.route_ref') IS json_extract(c.candidate_json,'$.preparation.probe_deployment.route_ref')
      AND json_extract(NEW.qualification_json,'$.qualification.probe_deployment.route_version') IS json_extract(c.candidate_json,'$.preparation.probe_deployment.route_version')
      AND json_extract(NEW.qualification_json,'$.qualification.installed_deployment') IS json_extract(c.candidate_json,'$.preparation.deployment')
      AND json_extract(NEW.qualification_json,'$.qualification.probe_deployment') IS json_extract(c.candidate_json,'$.preparation.probe_deployment')
  );
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_PROOF_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_native_model_candidate c
    WHERE c.candidate_ref=NEW.candidate_ref AND c.candidate_sha256=NEW.candidate_sha256
      AND json_extract(NEW.qualification_json,'$.qualification.provider') IS 'openrouter'
      AND json_extract(NEW.qualification_json,'$.qualification.api') IS 'openrouter-chat-completions'
      AND json_extract(NEW.qualification_json,'$.qualification.exact_model_id') IS json_extract(c.candidate_json,'$.preparation.transport_policy.model')
      AND json_extract(NEW.qualification_json,'$.qualification.account_id') IS json_extract(c.candidate_json,'$.preparation.key_binding.account_id')
      AND json_extract(NEW.qualification_json,'$.qualification.gateway_id') IS json_extract(c.candidate_json,'$.preparation.key_binding.gateway_id')
      AND json_extract(NEW.qualification_json,'$.qualification.provider_config_id') IS json_extract(c.candidate_json,'$.preparation.key_binding.provider_config_id')
      AND json_extract(NEW.qualification_json,'$.qualification.provider_key_operation_id') IS json_extract(c.candidate_json,'$.preparation.key_binding.operation_id')
      AND json_extract(NEW.qualification_json,'$.qualification.provider_key_metadata_sha256') IS json_extract(c.candidate_json,'$.preparation.key_binding.configuration_metadata_sha256')
      AND json_extract(NEW.qualification_json,'$.qualification.alias') IS json_extract(c.candidate_json,'$.preparation.key_binding.alias')
      AND json_extract(NEW.qualification_json,'$.qualification.pricing_snapshot_ref') IS json_extract(c.candidate_json,'$.preparation.pricing_snapshot_ref')
      AND json_extract(NEW.qualification_json,'$.qualification.pricing_snapshot_sha256') IS json_extract(c.candidate_json,'$.preparation.pricing_snapshot_sha256')
  );
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_PROOF_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_native_model_candidate c
    WHERE c.candidate_ref=NEW.candidate_ref AND c.candidate_sha256=NEW.candidate_sha256
      AND json_extract(NEW.qualification_json,'$.qualification.billed_usd') IS 0
      AND json_extract(NEW.qualification_json,'$.qualification.zero_price_enforcement.protocol') IS 'eliotr.provider-native-zero-price.v1'
      AND json_extract(NEW.qualification_json,'$.qualification.zero_price_enforcement.allow_fallbacks') IS 0
      AND json_extract(NEW.qualification_json,'$.qualification.zero_price_enforcement.max_price.prompt') IS 0
      AND json_extract(NEW.qualification_json,'$.qualification.zero_price_enforcement.max_price.completion') IS 0
      AND json_extract(NEW.qualification_json,'$.qualification.zero_price_enforcement.max_price.request') IS 0
      AND json_extract(NEW.qualification_json,'$.qualification.zero_price_enforcement.max_price.image') IS 0
  );
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_PROOF_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_native_model_candidate c
    WHERE c.candidate_ref=NEW.candidate_ref AND c.candidate_sha256=NEW.candidate_sha256
      AND json_extract(NEW.qualification_json,'$.qualification.verified_at') IS NEW.verified_at
      AND json_extract(NEW.qualification_json,'$.qualification.expires_at') IS NEW.expires_at
      AND NEW.verified_at IS json_extract(c.candidate_json,'$.verified_at')
      AND NEW.expires_at IS json_extract(c.candidate_json,'$.qualification_expires_at')
      AND julianday(NEW.expires_at)>julianday(NEW.created_at)
  );
END;

CREATE TRIGGER research_provider_key_model_price_observation_immutable_delete
BEFORE DELETE ON research_provider_key_model_price_observation
BEGIN
  SELECT RAISE(ABORT, 'provider-key model price observations are immutable');
END;

CREATE TRIGGER research_provider_key_model_price_observation_immutable_update
BEFORE UPDATE ON research_provider_key_model_price_observation
BEGIN
  SELECT RAISE(ABORT, 'provider-key model price observations are immutable');
END;

CREATE TRIGGER research_provider_key_model_price_observation_owner_insert
BEFORE INSERT ON research_provider_key_model_price_observation
WHEN NOT EXISTS (
  SELECT 1 FROM research_provider_key_model_use_operation u
  JOIN research_provider_key_model_use_stage_operation s
    ON s.owner_id=u.owner_id AND s.project_id=u.project_id AND s.operation_id=u.operation_id
  JOIN research_provider_key_model_use_key_authority k
    ON k.owner_id=u.owner_id AND k.project_id=u.project_id AND k.provider_id=u.provider_id
      AND k.operation_id=u.key_operation_id
  JOIN project p ON p.project_id=u.project_id
  JOIN project_owner o ON o.project_id=p.project_id
  WHERE u.owner_id=NEW.owner_id AND u.project_id=NEW.project_id AND u.operation_id=NEW.operation_id
    AND u.key_operation_id=NEW.key_operation_id AND u.request_sha256=NEW.request_sha256
    AND u.account_id=NEW.account_id AND u.gateway_id=NEW.gateway_id AND u.alias=NEW.alias
    AND u.provider_config_id=NEW.provider_config_id
    AND u.configuration_metadata_sha256=NEW.configuration_metadata_sha256
    AND u.owner_credential_generation=NEW.owner_credential_generation
    AND u.project_generation=NEW.project_generation AND u.deployment_generation=NEW.deployment_generation
    AND u.deadline_at=NEW.expires_at
    AND u.state='PREPARING' AND u.phase='FREE_PRICE_CHECK' AND u.active_stage=NEW.stage
    AND s.stage=NEW.stage AND s.route_ref=NEW.route_ref AND s.route_version=NEW.route_version
    AND k.state='CONFIGURED' AND k.account_id=NEW.account_id AND k.gateway_id=NEW.gateway_id
    AND k.alias=NEW.alias AND k.provider_config_id=NEW.provider_config_id
    AND k.metadata_sha256=NEW.configuration_metadata_sha256
    AND p.generation=NEW.project_generation AND o.principal_ref=NEW.owner_id
)
BEGIN
  SELECT RAISE(ABORT, 'current owner check/use operation and exact stage are required');
END;

CREATE TRIGGER research_provider_key_model_use_no_delete
BEFORE DELETE ON research_provider_key_model_use_operation
BEGIN
  SELECT RAISE(ABORT, 'provider-key model-use history is immutable');
END;

CREATE TRIGGER research_provider_key_model_use_owner_insert
BEFORE INSERT ON research_provider_key_model_use_operation
WHEN NOT EXISTS (
  SELECT 1 FROM project p JOIN project_owner o ON o.project_id=p.project_id
  WHERE p.project_id=NEW.project_id AND o.principal_ref=NEW.owner_id AND p.generation=NEW.project_generation
)
BEGIN
  SELECT RAISE(ABORT, 'current project owner authority is required');
END;

CREATE TRIGGER research_provider_key_model_use_transition
BEFORE UPDATE ON research_provider_key_model_use_operation
WHEN NEW.owner_id <> OLD.owner_id
  OR NEW.project_id <> OLD.project_id
  OR NEW.provider_id <> OLD.provider_id
  OR NEW.operation_id <> OLD.operation_id
  OR NEW.key_operation_id <> OLD.key_operation_id
  OR NEW.account_id <> OLD.account_id
  OR NEW.gateway_id <> OLD.gateway_id
  OR NEW.alias <> OLD.alias
  OR NEW.provider_config_id <> OLD.provider_config_id
  OR NEW.configuration_metadata_sha256 <> OLD.configuration_metadata_sha256
  OR NEW.request_sha256 <> OLD.request_sha256
  OR NEW.configuration_basis_json <> OLD.configuration_basis_json
  OR NEW.owner_credential_generation <> OLD.owner_credential_generation
  OR NEW.project_generation <> OLD.project_generation
  OR NEW.deployment_generation <> OLD.deployment_generation
  OR NEW.deadline_at <> OLD.deadline_at
  OR NEW.expected_selection_revision IS NOT OLD.expected_selection_revision
  OR NEW.source_configuration_ref IS NOT OLD.source_configuration_ref
  OR NEW.source_configuration_sha256 IS NOT OLD.source_configuration_sha256
  OR NEW.planned_stage_set_sha256 <> OLD.planned_stage_set_sha256
  OR NEW.plan_sha256 <> OLD.plan_sha256
  OR NEW.created_at <> OLD.created_at
  OR (OLD.target_configuration_ref IS NOT NULL AND NEW.target_configuration_ref IS NOT OLD.target_configuration_ref)
  OR (OLD.target_configuration_sha256 IS NOT NULL AND NEW.target_configuration_sha256 IS NOT OLD.target_configuration_sha256)
  OR (OLD.target_configuration_json IS NOT NULL AND NEW.target_configuration_json IS NOT OLD.target_configuration_json)
  OR (OLD.selected_configuration_ref IS NOT NULL AND NEW.selected_configuration_ref IS NOT OLD.selected_configuration_ref)
  OR (OLD.selection_revision IS NOT NULL AND NEW.selection_revision IS NOT OLD.selection_revision)
  OR NOT (
    (OLD.state='ACCEPTED' AND NEW.state IN ('PREPARING','BLOCKED','CONFLICT'))
    OR (OLD.state='PREPARING' AND NEW.state IN ('PREPARING','QUALIFYING','BLOCKED','CONFLICT'))
    OR (OLD.state='QUALIFYING' AND NEW.state IN ('QUALIFYING','IMPORTING','BLOCKED','UNCERTAIN','CONFLICT'))
    OR (OLD.state='IMPORTING' AND NEW.state IN ('IMPORTING','SELECTED','BLOCKED','CONFLICT'))
  )
BEGIN
  SELECT RAISE(ABORT, 'model-use operation identity is immutable and state transitions are monotone');
END;

CREATE TRIGGER research_provider_key_model_use_key_insert
BEFORE INSERT ON research_provider_key_model_use_operation
WHEN NOT (
  EXISTS (SELECT 1 FROM research_provider_key_configuration_operation k
    WHERE k.owner_id=NEW.owner_id AND k.project_id=NEW.project_id AND k.provider_id=NEW.provider_id AND k.operation_id=NEW.key_operation_id
      AND k.state='CONFIGURED' AND k.account_id=NEW.account_id AND k.gateway_id=NEW.gateway_id
      AND k.alias=NEW.alias AND k.provider_config_id=NEW.provider_config_id AND k.metadata_sha256=NEW.configuration_metadata_sha256)
  OR (NOT EXISTS (SELECT 1 FROM research_provider_key_configuration_operation k
        WHERE k.owner_id=NEW.owner_id AND k.project_id=NEW.project_id AND k.provider_id=NEW.provider_id AND k.operation_id=NEW.key_operation_id)
    AND EXISTS (SELECT 1 FROM service_model_provider_operation g WHERE g.owner_id=NEW.owner_id AND g.operation_id=NEW.key_operation_id AND g.provider_id=NEW.provider_id
    AND g.provider_id='openrouter' AND g.provider_slug='openrouter' AND g.state='CONFIGURED'
    AND g.failure_code IS NULL AND g.provider_http_status IS NULL
    AND g.alias=NEW.alias AND g.provider_config_id=NEW.provider_config_id AND g.metadata_sha256=NEW.configuration_metadata_sha256
    AND NEW.gateway_id='eliotr-reasoning' AND json_valid(NEW.configuration_basis_json)
    AND json_extract(NEW.configuration_basis_json,'$.protocol') IS 'eliotr.research.provider-key-model-use-basis.v1'
    AND json_type(NEW.configuration_basis_json,'$.stages')='array'
    AND json_array_length(NEW.configuration_basis_json,'$.stages') BETWEEN 2 AND 4
    AND json_array_length(g.model_ids_json) BETWEEN 1 AND 64
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
          WHERE registered.type='text' AND registered.value IS json_extract(pinned.value,'$.transport_policy.model')))))
)
BEGIN SELECT RAISE(ABORT,'current configured project or global registered provider authority is required'); END;

CREATE TRIGGER research_provider_key_model_price_exact_pin_insert
BEFORE INSERT ON research_provider_key_model_price_observation
WHEN NOT EXISTS (
  SELECT 1 FROM research_provider_key_model_use_operation u JOIN research_provider_key_model_use_stage_operation s
    ON s.owner_id=u.owner_id AND s.project_id=u.project_id AND s.operation_id=u.operation_id
  WHERE u.owner_id=NEW.owner_id AND u.project_id=NEW.project_id AND u.operation_id=NEW.operation_id AND s.stage=NEW.stage
    AND json_extract(u.configuration_basis_json,'$.stages[' || s.sequence_number || '].transport_policy.model') IS NEW.exact_model_id
    AND json_extract(u.configuration_basis_json,'$.stages[' || s.sequence_number || '].transport_policy.provider') IS NEW.provider_id
    AND NEW.source_url IS ('https://openrouter.ai/api/v1/models/' || replace(replace(NEW.exact_model_id,':','%3A'),'@','%40') || '/endpoints')
)
BEGIN SELECT RAISE(ABORT,'price observation must match its immutable exact model and source'); END;

-- Replace the exclusive project-key FK with equivalent source-side deletion/identity fences.
CREATE TRIGGER research_provider_key_model_use_legacy_key_delete
BEFORE DELETE ON research_provider_key_configuration_operation
WHEN EXISTS (SELECT 1 FROM research_provider_key_model_use_operation u WHERE u.owner_id=OLD.owner_id AND u.project_id=OLD.project_id
  AND u.provider_id=OLD.provider_id AND u.key_operation_id=OLD.operation_id)
BEGIN SELECT RAISE(ABORT,'model-use key reference is immutable'); END;
CREATE TRIGGER research_provider_key_model_use_legacy_key_identity
BEFORE UPDATE ON research_provider_key_configuration_operation
WHEN (NEW.owner_id IS NOT OLD.owner_id OR NEW.project_id IS NOT OLD.project_id OR NEW.provider_id IS NOT OLD.provider_id OR NEW.operation_id IS NOT OLD.operation_id)
  AND EXISTS (SELECT 1 FROM research_provider_key_model_use_operation u WHERE u.owner_id=OLD.owner_id AND u.project_id=OLD.project_id
    AND u.provider_id=OLD.provider_id AND u.key_operation_id=OLD.operation_id)
BEGIN SELECT RAISE(ABORT,'model-use key reference is immutable'); END;
CREATE TRIGGER research_provider_key_model_use_global_key_delete
BEFORE DELETE ON service_model_provider_operation
WHEN EXISTS (SELECT 1 FROM research_provider_key_model_use_operation u WHERE u.owner_id=OLD.owner_id AND u.provider_id=OLD.provider_id AND u.key_operation_id=OLD.operation_id)
BEGIN SELECT RAISE(ABORT,'model-use global provider reference is immutable'); END;
CREATE TRIGGER research_provider_key_model_use_global_key_identity
BEFORE UPDATE ON service_model_provider_operation
WHEN (NEW.owner_id IS NOT OLD.owner_id OR NEW.operation_id IS NOT OLD.operation_id OR NEW.provider_id IS NOT OLD.provider_id
  OR NEW.base_url IS NOT OLD.base_url OR NEW.request_sha256 IS NOT OLD.request_sha256
  OR NEW.provider_slug IS NOT OLD.provider_slug OR NEW.alias IS NOT OLD.alias OR NEW.provider_config_id IS NOT OLD.provider_config_id
  OR NEW.metadata_sha256 IS NOT OLD.metadata_sha256 OR NEW.model_ids_json IS NOT OLD.model_ids_json OR NEW.state IS NOT OLD.state)
  AND EXISTS (SELECT 1 FROM research_provider_key_model_use_operation u WHERE u.owner_id=OLD.owner_id AND u.provider_id=OLD.provider_id AND u.key_operation_id=OLD.operation_id)
BEGIN SELECT RAISE(ABORT,'model-use global provider identity and registered targets are immutable'); END;

INSERT INTO global_model_use_0156_copy_guard SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END;

DROP TABLE global_model_use_0156_copy_guard;

PRAGMA defer_foreign_keys=OFF;
