-- Allow a provider-key model-use stage to retain an authoritative BLOCKED
-- failure before a pricing observation exists. All other staged receipt
-- requirements and immutable history rules remain unchanged.
--
-- SQLite cannot alter a table CHECK in place. Keep the canonical table name
-- stable for the populated price-observation and Native-preparation tables
-- that reference its composite primary key. The temporary FK gap is deferred
-- only for this migration; D1 checks the restored references at commit.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE research_provider_key_model_use_stage_operation_0113_copy (
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 256),
  operation_id TEXT NOT NULL CHECK (length(operation_id) = 36),
  sequence_number INTEGER NOT NULL CHECK (sequence_number BETWEEN 0 AND 3),
  stage TEXT NOT NULL CHECK (stage IN ('ANALYZE_BRANCHES','COUNTER_SEARCH','SYNTHESIZE','AUDIT_CLAIMS')),
  route_ref TEXT NOT NULL CHECK (route_ref IN (
    'dynamic/eliotr-economy','dynamic/eliotr-balanced','dynamic/eliotr-strong','dynamic/eliotr-frontier',
    'dynamic/eliotr-audit-writer','dynamic/eliotr-audit-verifier','dynamic/eliotr-vision',
    'dynamic/eliotr-extract','dynamic/eliotr-report-section','dynamic/eliotr-report-integrator'
  )),
  route_version TEXT NOT NULL CHECK (length(route_version) BETWEEN 1 AND 256),
  prompt_sha256 TEXT NOT NULL CHECK (length(prompt_sha256) = 64 AND prompt_sha256 NOT GLOB '*[^0-9a-f]*'),
  schema_sha256 TEXT NOT NULL CHECK (length(schema_sha256) = 64 AND schema_sha256 NOT GLOB '*[^0-9a-f]*'),
  parameters_sha256 TEXT NOT NULL CHECK (length(parameters_sha256) = 64 AND parameters_sha256 NOT GLOB '*[^0-9a-f]*'),
  probe_prompt_sha256 TEXT NOT NULL CHECK (length(probe_prompt_sha256) = 64 AND probe_prompt_sha256 NOT GLOB '*[^0-9a-f]*'),
  probe_schema_sha256 TEXT NOT NULL CHECK (length(probe_schema_sha256) = 64 AND probe_schema_sha256 NOT GLOB '*[^0-9a-f]*'),
  probe_parameters_sha256 TEXT NOT NULL CHECK (length(probe_parameters_sha256) = 64 AND probe_parameters_sha256 NOT GLOB '*[^0-9a-f]*'),
  pricing_snapshot_ref TEXT CHECK (pricing_snapshot_ref IS NULL OR length(pricing_snapshot_ref) BETWEEN 1 AND 256),
  pricing_snapshot_sha256 TEXT CHECK (pricing_snapshot_sha256 IS NULL OR
    (length(pricing_snapshot_sha256) = 64 AND pricing_snapshot_sha256 NOT GLOB '*[^0-9a-f]*')),
  preparation_ref TEXT CHECK (preparation_ref IS NULL OR length(preparation_ref) BETWEEN 1 AND 256),
  preparation_sha256 TEXT CHECK (preparation_sha256 IS NULL OR
    (length(preparation_sha256) = 64 AND preparation_sha256 NOT GLOB '*[^0-9a-f]*')),
  candidate_ref TEXT CHECK (candidate_ref IS NULL OR length(candidate_ref) BETWEEN 1 AND 256),
  candidate_sha256 TEXT CHECK (candidate_sha256 IS NULL OR
    (length(candidate_sha256) = 64 AND candidate_sha256 NOT GLOB '*[^0-9a-f]*')),
  qualification_ref TEXT CHECK (qualification_ref IS NULL OR length(qualification_ref) BETWEEN 1 AND 256),
  qualification_sha256 TEXT CHECK (qualification_sha256 IS NULL OR
    (length(qualification_sha256) = 64 AND qualification_sha256 NOT GLOB '*[^0-9a-f]*')),
  state TEXT NOT NULL CHECK (state IN ('PENDING','PREPARED','QUALIFYING','QUALIFIED','BLOCKED','UNCERTAIN')),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code IN (
    'NO_SELECTED_CONFIGURATION','FREE_PRICE_NOT_PROVEN','FREE_PRICE_NOT_ZERO',
    'SERVER_POLICY_UNAVAILABLE','PREPARATION_REJECTED','QUALIFICATION_NO_EFFECT',
    'QUALIFICATION_OUTCOME_UNCERTAIN','NATIVE_RECEIPT_INVALID','SELECTION_CAS_CONFLICT',
    'AUTHORITY_CHANGED','STORAGE_UNAVAILABLE'
  )),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
  PRIMARY KEY (owner_id, project_id, operation_id, stage),
  UNIQUE (owner_id, project_id, operation_id, sequence_number),
  FOREIGN KEY (owner_id, project_id, operation_id)
    REFERENCES research_provider_key_model_use_operation(owner_id, project_id, operation_id),
  CHECK ((pricing_snapshot_ref IS NULL) = (pricing_snapshot_sha256 IS NULL)),
  CHECK ((preparation_ref IS NULL) = (preparation_sha256 IS NULL)),
  CHECK ((candidate_ref IS NULL) = (candidate_sha256 IS NULL)),
  CHECK ((qualification_ref IS NULL) = (qualification_sha256 IS NULL)),
  CHECK ((candidate_ref IS NULL) = (qualification_ref IS NULL)),
  CHECK (state IN ('PENDING','BLOCKED') OR pricing_snapshot_ref IS NOT NULL),
  CHECK (state NOT IN ('PREPARED','QUALIFYING','QUALIFIED','UNCERTAIN') OR preparation_ref IS NOT NULL),
  CHECK (state <> 'QUALIFIED' OR (candidate_ref IS NOT NULL AND qualification_ref IS NOT NULL)),
  CHECK ((state IN ('BLOCKED','UNCERTAIN')) = (failure_code IS NOT NULL)),
  CHECK (state <> 'UNCERTAIN' OR failure_code = 'QUALIFICATION_OUTCOME_UNCERTAIN')
) STRICT;

INSERT INTO research_provider_key_model_use_stage_operation_0113_copy
SELECT * FROM research_provider_key_model_use_stage_operation;

CREATE TABLE research_provider_key_model_use_stage_operation_0113_copy_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
) STRICT;
INSERT INTO research_provider_key_model_use_stage_operation_0113_copy_guard
SELECT CASE WHEN
  (SELECT COUNT(*) FROM research_provider_key_model_use_stage_operation_0113_copy) =
    (SELECT COUNT(*) FROM research_provider_key_model_use_stage_operation)
  AND NOT EXISTS (
    SELECT * FROM research_provider_key_model_use_stage_operation
    EXCEPT SELECT * FROM research_provider_key_model_use_stage_operation_0113_copy
  )
  AND NOT EXISTS (
    SELECT * FROM research_provider_key_model_use_stage_operation_0113_copy
    EXCEPT SELECT * FROM research_provider_key_model_use_stage_operation
  )
  THEN 1 ELSE 0 END;
DROP TABLE research_provider_key_model_use_stage_operation_0113_copy_guard;

DROP TRIGGER research_provider_key_model_price_observation_owner_insert;
DROP TRIGGER provider_native_model_preparation_guard;
DROP TRIGGER provider_native_model_qualification_attempt_guard;
DROP TRIGGER provider_native_model_observation_guard;
DROP TRIGGER provider_native_model_candidate_guard;
DROP TRIGGER provider_native_model_qualification_proof_guard;
DROP TRIGGER provider_native_model_qualification_complete_guard;
DROP TRIGGER research_provider_key_model_use_stage_transition;
DROP TRIGGER research_provider_key_model_use_stage_no_delete;
DROP TABLE research_provider_key_model_use_stage_operation;
ALTER TABLE research_provider_key_model_use_stage_operation_0113_copy
  RENAME TO research_provider_key_model_use_stage_operation;

CREATE TRIGGER research_provider_key_model_use_stage_transition
BEFORE UPDATE ON research_provider_key_model_use_stage_operation
WHEN NEW.owner_id <> OLD.owner_id
  OR NEW.project_id <> OLD.project_id
  OR NEW.operation_id <> OLD.operation_id
  OR NEW.sequence_number <> OLD.sequence_number
  OR NEW.stage <> OLD.stage
  OR NEW.route_ref <> OLD.route_ref
  OR NEW.route_version <> OLD.route_version
  OR NEW.prompt_sha256 <> OLD.prompt_sha256
  OR NEW.schema_sha256 <> OLD.schema_sha256
  OR NEW.parameters_sha256 <> OLD.parameters_sha256
  OR NEW.probe_prompt_sha256 <> OLD.probe_prompt_sha256
  OR NEW.probe_schema_sha256 <> OLD.probe_schema_sha256
  OR NEW.probe_parameters_sha256 <> OLD.probe_parameters_sha256
  OR NEW.created_at <> OLD.created_at
  OR (OLD.pricing_snapshot_ref IS NOT NULL AND NEW.pricing_snapshot_ref IS NOT OLD.pricing_snapshot_ref)
  OR (OLD.pricing_snapshot_sha256 IS NOT NULL AND NEW.pricing_snapshot_sha256 IS NOT OLD.pricing_snapshot_sha256)
  OR (OLD.preparation_ref IS NOT NULL AND NEW.preparation_ref IS NOT OLD.preparation_ref)
  OR (OLD.preparation_sha256 IS NOT NULL AND NEW.preparation_sha256 IS NOT OLD.preparation_sha256)
  OR (OLD.candidate_ref IS NOT NULL AND NEW.candidate_ref IS NOT OLD.candidate_ref)
  OR (OLD.candidate_sha256 IS NOT NULL AND NEW.candidate_sha256 IS NOT OLD.candidate_sha256)
  OR (OLD.qualification_ref IS NOT NULL AND NEW.qualification_ref IS NOT OLD.qualification_ref)
  OR (OLD.qualification_sha256 IS NOT NULL AND NEW.qualification_sha256 IS NOT OLD.qualification_sha256)
  OR NOT (
    (OLD.state='PENDING' AND NEW.state IN ('PENDING','PREPARED','BLOCKED'))
    OR (OLD.state='PREPARED' AND NEW.state IN ('QUALIFYING','BLOCKED'))
    OR (OLD.state='QUALIFYING' AND NEW.state IN ('QUALIFIED','BLOCKED','UNCERTAIN'))
  )
BEGIN
  SELECT RAISE(ABORT, 'model-use stage identity is immutable and state transitions are monotone');
END;

CREATE TRIGGER research_provider_key_model_use_stage_no_delete
BEFORE DELETE ON research_provider_key_model_use_stage_operation
BEGIN
  SELECT RAISE(ABORT, 'provider-key model-use stage history is immutable');
END;


-- Restore child-table authority guards byte-for-byte after the canonical stage table exists.
CREATE TRIGGER research_provider_key_model_price_observation_owner_insert
BEFORE INSERT ON research_provider_key_model_price_observation
WHEN NOT EXISTS (
  SELECT 1 FROM research_provider_key_model_use_operation u
  JOIN research_provider_key_model_use_stage_operation s
    ON s.owner_id=u.owner_id AND s.project_id=u.project_id AND s.operation_id=u.operation_id
  JOIN research_provider_key_configuration_operation k
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

CREATE TRIGGER provider_native_model_preparation_guard
BEFORE INSERT ON provider_native_model_preparation
BEGIN
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1 FROM research_provider_key_model_use_operation u
    JOIN research_provider_key_model_use_stage_operation s
      ON s.owner_id=u.owner_id AND s.project_id=u.project_id AND s.operation_id=u.operation_id
    JOIN research_provider_key_configuration_operation k
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
    JOIN research_provider_key_configuration_operation k
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
    JOIN research_provider_key_configuration_operation k
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

CREATE TRIGGER provider_native_model_observation_guard BEFORE INSERT ON provider_native_model_qualification_observation
BEGIN
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_OBSERVATION_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_native_model_qualification_attempt a
    JOIN provider_native_model_preparation prep ON prep.preparation_ref=a.preparation_ref AND prep.preparation_sha256=a.preparation_sha256
    JOIN research_provider_key_model_use_operation u ON u.owner_id=prep.owner_ref AND u.project_id=prep.project_id AND u.operation_id=prep.owner_operation_id
    JOIN research_provider_key_model_use_stage_operation s ON s.owner_id=u.owner_id AND s.project_id=u.project_id AND s.operation_id=u.operation_id AND s.stage=prep.stage
    JOIN research_provider_key_configuration_operation k ON k.owner_id=u.owner_id AND k.project_id=u.project_id AND k.provider_id=u.provider_id AND k.operation_id=u.key_operation_id
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
    JOIN research_provider_key_configuration_operation k ON k.owner_id=u.owner_id AND k.project_id=u.project_id AND k.provider_id=u.provider_id AND k.operation_id=u.key_operation_id
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

CREATE TRIGGER provider_native_model_qualification_proof_guard BEFORE INSERT ON provider_native_model_qualification_proof
BEGIN
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_PROOF_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_native_model_candidate c
    JOIN provider_native_model_qualification_attempt a ON a.candidate_ref=c.candidate_ref AND a.candidate_sha256=c.candidate_sha256
    WHERE c.candidate_ref=NEW.candidate_ref AND c.candidate_sha256=NEW.candidate_sha256
      AND c.owner_ref=NEW.owner_ref AND c.project_id=NEW.project_id AND c.stage=NEW.stage
      AND c.route_ref=NEW.route_ref AND c.route_version=NEW.route_version
      AND c.observation_ref=NEW.observation_ref AND c.observation_sha256=NEW.observation_sha256
      AND a.owner_ref=c.owner_ref AND a.project_id=c.project_id
      AND a.owner_operation_id=json_extract(c.candidate_json,'$.preparation.owner_operation_id') AND a.stage=c.stage
      AND a.preparation_ref=c.preparation_ref AND a.preparation_sha256=c.preparation_sha256
      AND a.observation_ref=NEW.observation_ref AND a.observation_sha256=NEW.observation_sha256
      AND a.state='OBSERVED' AND a.qualification_ref IS NULL AND a.qualification_sha256 IS NULL
      AND NEW.qualification_ref IS ('provider-native-model-qualification-' || NEW.qualification_sha256)
  );
  SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_PROOF_INVALID')
  WHERE NOT EXISTS (
    SELECT 1 FROM provider_native_model_candidate c
    JOIN provider_native_model_qualification_attempt a ON a.candidate_ref=c.candidate_ref AND a.candidate_sha256=c.candidate_sha256
    JOIN research_provider_key_model_use_operation u ON u.owner_id=c.owner_ref AND u.project_id=c.project_id AND u.operation_id=a.owner_operation_id
    JOIN research_provider_key_model_use_stage_operation s ON s.owner_id=u.owner_id AND s.project_id=u.project_id AND s.operation_id=u.operation_id AND s.stage=c.stage
    JOIN research_provider_key_configuration_operation k ON k.owner_id=u.owner_id AND k.project_id=u.project_id AND k.provider_id=u.provider_id AND k.operation_id=u.key_operation_id
    JOIN project p ON p.project_id=u.project_id JOIN project_owner o ON o.project_id=p.project_id
    WHERE c.candidate_ref=NEW.candidate_ref AND c.candidate_sha256=NEW.candidate_sha256
      AND a.state='OBSERVED' AND a.observation_ref=c.observation_ref AND a.observation_sha256=c.observation_sha256
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

-- DROP/rename of a referenced parent can leave SQLite's deferred-FK counter
-- nonzero even after the original keys have been restored. Check actual global
-- FK integrity before resetting that transaction-local counter.
CREATE TABLE research_provider_key_model_use_stage_fk_guard_0113 (
  valid INTEGER NOT NULL CHECK (valid = 1)
) STRICT;
INSERT INTO research_provider_key_model_use_stage_fk_guard_0113 (valid)
SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check) THEN 1 ELSE 0 END;
DROP TABLE research_provider_key_model_use_stage_fk_guard_0113;
PRAGMA defer_foreign_keys = OFF;
