-- Provider-native model qualification is a separate authority class from
-- Dynamic Routes. This migration stores exact native preparations, one-shot
-- prompt-only observations, immutable candidate/proof pairs, and revocations.
-- No Dynamic Route candidate, deployment, or active pointer is created.
PRAGMA foreign_keys = ON;

CREATE TABLE provider_native_model_preparation (
  preparation_ref TEXT PRIMARY KEY CHECK(length(preparation_ref) BETWEEN 1 AND 256),
  preparation_sha256 TEXT NOT NULL CHECK(length(preparation_sha256)=64 AND preparation_sha256 NOT GLOB '*[^0-9a-f]*'),
  preparation_json TEXT NOT NULL CHECK(json_valid(preparation_json) AND length(CAST(preparation_json AS BLOB)) BETWEEN 2 AND 65536),
  owner_ref TEXT NOT NULL CHECK(length(owner_ref) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 256),
  owner_operation_id TEXT NOT NULL CHECK(length(owner_operation_id)=36),
  stage TEXT NOT NULL CHECK(stage IN ('ANALYZE_BRANCHES','COUNTER_SEARCH','SYNTHESIZE','AUDIT_CLAIMS')),
  route_ref TEXT NOT NULL CHECK(length(route_ref) BETWEEN 1 AND 256),
  route_version TEXT NOT NULL CHECK(length(route_version) BETWEEN 1 AND 256),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z' AND julianday(created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),
  UNIQUE(owner_ref,project_id,owner_operation_id,stage),
  UNIQUE(preparation_ref,preparation_sha256),
  UNIQUE(owner_ref,project_id,owner_operation_id,stage,preparation_ref,preparation_sha256),
  FOREIGN KEY(owner_ref,project_id,owner_operation_id,stage)
    REFERENCES research_provider_key_model_use_stage_operation(owner_id,project_id,operation_id,stage)
) STRICT;

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

CREATE TRIGGER provider_native_model_preparation_immutable_update BEFORE UPDATE ON provider_native_model_preparation
BEGIN SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_IMMUTABLE'); END;
CREATE TRIGGER provider_native_model_preparation_immutable_delete BEFORE DELETE ON provider_native_model_preparation
BEGIN SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_IMMUTABLE'); END;

CREATE TABLE provider_native_model_qualification_attempt (
  owner_ref TEXT NOT NULL,
  project_id TEXT NOT NULL,
  owner_operation_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  preparation_ref TEXT NOT NULL,
  preparation_sha256 TEXT NOT NULL CHECK(length(preparation_sha256)=64 AND preparation_sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('STARTED','OBSERVED','COMPLETED')),
  observation_ref TEXT CHECK(observation_ref IS NULL OR length(observation_ref) BETWEEN 1 AND 256),
  observation_sha256 TEXT CHECK(observation_sha256 IS NULL OR (length(observation_sha256)=64 AND observation_sha256 NOT GLOB '*[^0-9a-f]*')),
  candidate_ref TEXT CHECK(candidate_ref IS NULL OR length(candidate_ref) BETWEEN 1 AND 256),
  candidate_sha256 TEXT CHECK(candidate_sha256 IS NULL OR (length(candidate_sha256)=64 AND candidate_sha256 NOT GLOB '*[^0-9a-f]*')),
  qualification_ref TEXT CHECK(qualification_ref IS NULL OR length(qualification_ref) BETWEEN 1 AND 256),
  qualification_sha256 TEXT CHECK(qualification_sha256 IS NULL OR (length(qualification_sha256)=64 AND qualification_sha256 NOT GLOB '*[^0-9a-f]*')),
  started_at TEXT NOT NULL CHECK(started_at GLOB '????-??-??T??:??:??.???Z' AND julianday(started_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',started_at) IS started_at),
  completed_at TEXT CHECK(completed_at IS NULL OR (completed_at GLOB '????-??-??T??:??:??.???Z' AND julianday(completed_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',completed_at) IS completed_at)),
  PRIMARY KEY(owner_ref,project_id,owner_operation_id,stage),
  UNIQUE(owner_ref,project_id,owner_operation_id,stage,preparation_ref,preparation_sha256),
  FOREIGN KEY(owner_ref,project_id,owner_operation_id,stage,preparation_ref,preparation_sha256)
    REFERENCES provider_native_model_preparation(owner_ref,project_id,owner_operation_id,stage,preparation_ref,preparation_sha256),
  CHECK((state='STARTED' AND observation_ref IS NULL AND observation_sha256 IS NULL AND candidate_ref IS NULL AND candidate_sha256 IS NULL AND qualification_ref IS NULL AND qualification_sha256 IS NULL AND completed_at IS NULL)
    OR (state='OBSERVED' AND observation_ref IS NOT NULL AND observation_sha256 IS NOT NULL AND candidate_ref IS NULL AND candidate_sha256 IS NULL AND qualification_ref IS NULL AND qualification_sha256 IS NULL AND completed_at IS NULL)
    OR (state='COMPLETED' AND observation_ref IS NOT NULL AND observation_sha256 IS NOT NULL AND candidate_ref IS NOT NULL AND candidate_sha256 IS NOT NULL AND qualification_ref IS NOT NULL AND qualification_sha256 IS NOT NULL AND completed_at IS NOT NULL))
) STRICT;

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

CREATE TRIGGER provider_native_model_qualification_attempt_transition
BEFORE UPDATE ON provider_native_model_qualification_attempt
WHEN NEW.owner_ref IS NOT OLD.owner_ref OR NEW.project_id IS NOT OLD.project_id
  OR NEW.owner_operation_id IS NOT OLD.owner_operation_id OR NEW.stage IS NOT OLD.stage
  OR NEW.preparation_ref IS NOT OLD.preparation_ref OR NEW.preparation_sha256 IS NOT OLD.preparation_sha256
  OR NEW.started_at IS NOT OLD.started_at OR OLD.state='COMPLETED'
  OR NOT ((OLD.state='STARTED' AND NEW.state='OBSERVED') OR (OLD.state='OBSERVED' AND NEW.state='COMPLETED'))
BEGIN SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_QUALIFICATION_IMMUTABLE'); END;
CREATE TRIGGER provider_native_model_qualification_attempt_no_delete BEFORE DELETE ON provider_native_model_qualification_attempt
BEGIN SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_QUALIFICATION_IMMUTABLE'); END;

-- Actual raw request/response bytes are stored losslessly as canonical padded
-- RFC 4648 standard Base64 TEXT. Native readers decode and verify the canonical
-- spelling, decoded byte bound, and the immutable SHA-256 metadata on every read.
CREATE TABLE provider_native_model_qualification_observation (
  observation_ref TEXT PRIMARY KEY CHECK(length(observation_ref) BETWEEN 1 AND 256),
  observation_sha256 TEXT NOT NULL UNIQUE CHECK(length(observation_sha256)=64 AND observation_sha256 NOT GLOB '*[^0-9a-f]*'),
  observation_json TEXT NOT NULL CHECK(json_valid(observation_json) AND length(CAST(observation_json AS BLOB)) BETWEEN 2 AND 65536),
  request_body_base64 TEXT NOT NULL CHECK(length(request_body_base64) BETWEEN 4 AND 43692 AND length(request_body_base64)%4=0 AND request_body_base64 NOT GLOB '*[^A-Za-z0-9+/=]*' AND (length(request_body_base64)<43692 OR substr(request_body_base64,-1,1)='=') AND ((substr(request_body_base64,-2,2)='==' AND substr(request_body_base64,1,length(request_body_base64)-2) NOT GLOB '*=*') OR (substr(request_body_base64,-1,1)='=' AND substr(request_body_base64,1,length(request_body_base64)-1) NOT GLOB '*=*') OR request_body_base64 NOT GLOB '*=*')),
  response_body_base64 TEXT NOT NULL CHECK(length(response_body_base64) BETWEEN 4 AND 43692 AND length(response_body_base64)%4=0 AND response_body_base64 NOT GLOB '*[^A-Za-z0-9+/=]*' AND (length(response_body_base64)<43692 OR substr(response_body_base64,-1,1)='=') AND ((substr(response_body_base64,-2,2)='==' AND substr(response_body_base64,1,length(response_body_base64)-2) NOT GLOB '*=*') OR (substr(response_body_base64,-1,1)='=' AND substr(response_body_base64,1,length(response_body_base64)-1) NOT GLOB '*=*') OR response_body_base64 NOT GLOB '*=*')),
  owner_ref TEXT NOT NULL, project_id TEXT NOT NULL, owner_operation_id TEXT NOT NULL,
  stage TEXT NOT NULL, preparation_ref TEXT NOT NULL, preparation_sha256 TEXT NOT NULL CHECK(length(preparation_sha256)=64 AND preparation_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z' AND julianday(created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),
  UNIQUE(observation_ref,observation_sha256),
  UNIQUE(owner_ref,project_id,owner_operation_id,stage,preparation_ref,preparation_sha256,observation_ref,observation_sha256),
  FOREIGN KEY(owner_ref,project_id,owner_operation_id,stage,preparation_ref,preparation_sha256)
    REFERENCES provider_native_model_qualification_attempt(owner_ref,project_id,owner_operation_id,stage,preparation_ref,preparation_sha256),
  CHECK(json_extract(observation_json,'$.protocol') IS 'eliotr.provider-native-model-observation.v1'),
  CHECK(json_extract(observation_json,'$.preparation_ref') IS preparation_ref),
  CHECK(json_extract(observation_json,'$.preparation_sha256') IS preparation_sha256),
  CHECK(json_extract(observation_json,'$.execution.protocol') IS 'eliotr.provider-native-model-probe-execution.v1'),
  CHECK(json_extract(observation_json,'$.execution.qualification_purpose') IS 'structured-output-connectivity'),
  CHECK(json_extract(observation_json,'$.execution.api') IS 'openrouter-chat-completions'),
  CHECK(json_extract(observation_json,'$.execution.provider') IS 'openrouter'),
  CHECK(json_extract(observation_json,'$.execution.billed_usd') IS 0),
  CHECK(json_extract(observation_json,'$.execution.request_body_sha256') IS NOT NULL),
  CHECK(json_extract(observation_json,'$.execution.probe_prompt_sha256') IS NOT NULL),
  CHECK(json_extract(observation_json,'$.execution.probe_schema_sha256') IS NOT NULL),
  CHECK(json_extract(observation_json,'$.execution.probe_parameters_sha256') IS NOT NULL),
  CHECK(json_extract(observation_json,'$.execution.response_body_byte_length') BETWEEN 1 AND 32768),
  CHECK(json_extract(observation_json,'$.execution.response_body_byte_length') IS
    (length(response_body_base64)/4*3 - CASE WHEN substr(response_body_base64,-2,2)='==' THEN 2 WHEN substr(response_body_base64,-1,1)='=' THEN 1 ELSE 0 END))
) STRICT;

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
CREATE TRIGGER provider_native_model_observation_immutable_update BEFORE UPDATE ON provider_native_model_qualification_observation
BEGIN SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_IMMUTABLE'); END;
CREATE TRIGGER provider_native_model_observation_immutable_delete BEFORE DELETE ON provider_native_model_qualification_observation
BEGIN SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_IMMUTABLE'); END;

CREATE TABLE provider_native_model_candidate (
  candidate_ref TEXT PRIMARY KEY CHECK(length(candidate_ref) BETWEEN 1 AND 256),
  candidate_sha256 TEXT NOT NULL UNIQUE CHECK(length(candidate_sha256)=64 AND candidate_sha256 NOT GLOB '*[^0-9a-f]*'),
  candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json) AND length(CAST(candidate_json AS BLOB)) BETWEEN 2 AND 65536),
  owner_ref TEXT NOT NULL, project_id TEXT NOT NULL, stage TEXT NOT NULL,
  route_ref TEXT NOT NULL, route_version TEXT NOT NULL, preparation_ref TEXT NOT NULL, preparation_sha256 TEXT NOT NULL CHECK(length(preparation_sha256)=64 AND preparation_sha256 NOT GLOB '*[^0-9a-f]*'),
  observation_ref TEXT NOT NULL, observation_sha256 TEXT NOT NULL CHECK(length(observation_sha256)=64 AND observation_sha256 NOT GLOB '*[^0-9a-f]*'),
  qualification_tier TEXT NOT NULL CHECK(qualification_tier='LIVE'),
  verified_at TEXT NOT NULL CHECK(verified_at GLOB '????-??-??T??:??:??.???Z' AND julianday(verified_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',verified_at) IS verified_at),
  qualification_expires_at TEXT NOT NULL CHECK(qualification_expires_at GLOB '????-??-??T??:??:??.???Z' AND julianday(qualification_expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',qualification_expires_at) IS qualification_expires_at),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z' AND julianday(created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),
  UNIQUE(candidate_ref,candidate_sha256),
  UNIQUE(candidate_ref,candidate_sha256,owner_ref,project_id,stage,route_ref,route_version,observation_ref,observation_sha256),
  FOREIGN KEY(preparation_ref,preparation_sha256) REFERENCES provider_native_model_preparation(preparation_ref,preparation_sha256),
  FOREIGN KEY(observation_ref,observation_sha256) REFERENCES provider_native_model_qualification_observation(observation_ref,observation_sha256),
  CHECK(julianday(qualification_expires_at)>julianday(verified_at)),
  CHECK(json_extract(candidate_json,'$.protocol') IS 'eliotr.provider-native-model-candidate.v1'),
  CHECK(json_extract(candidate_json,'$.candidate_kind') IS 'provider-native-v1'),
  CHECK(json_extract(candidate_json,'$.qualification_tier') IS 'LIVE')
) STRICT;

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
CREATE TRIGGER provider_native_model_candidate_immutable_update BEFORE UPDATE ON provider_native_model_candidate
BEGIN SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_IMMUTABLE'); END;
CREATE TRIGGER provider_native_model_candidate_immutable_delete BEFORE DELETE ON provider_native_model_candidate
BEGIN SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_IMMUTABLE'); END;

CREATE TABLE provider_native_model_qualification_proof (
  qualification_ref TEXT PRIMARY KEY CHECK(length(qualification_ref) BETWEEN 1 AND 256),
  qualification_sha256 TEXT NOT NULL UNIQUE CHECK(length(qualification_sha256)=64 AND qualification_sha256 NOT GLOB '*[^0-9a-f]*'),
  qualification_json TEXT NOT NULL CHECK(json_valid(qualification_json) AND length(CAST(qualification_json AS BLOB)) BETWEEN 2 AND 65536),
  owner_ref TEXT NOT NULL, project_id TEXT NOT NULL, stage TEXT NOT NULL,
  route_ref TEXT NOT NULL, route_version TEXT NOT NULL, candidate_ref TEXT NOT NULL, candidate_sha256 TEXT NOT NULL CHECK(length(candidate_sha256)=64 AND candidate_sha256 NOT GLOB '*[^0-9a-f]*'),
  observation_ref TEXT NOT NULL, observation_sha256 TEXT NOT NULL CHECK(length(observation_sha256)=64 AND observation_sha256 NOT GLOB '*[^0-9a-f]*'),
  qualification_tier TEXT NOT NULL CHECK(qualification_tier='LIVE'),
  verified_at TEXT NOT NULL CHECK(verified_at GLOB '????-??-??T??:??:??.???Z' AND julianday(verified_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',verified_at) IS verified_at),
  expires_at TEXT NOT NULL CHECK(expires_at GLOB '????-??-??T??:??:??.???Z' AND julianday(expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS expires_at),
  created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z' AND julianday(created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),
  UNIQUE(qualification_ref,qualification_sha256,owner_ref,project_id),
  FOREIGN KEY(candidate_ref,candidate_sha256,owner_ref,project_id,stage,route_ref,route_version,observation_ref,observation_sha256)
    REFERENCES provider_native_model_candidate(candidate_ref,candidate_sha256,owner_ref,project_id,stage,route_ref,route_version,observation_ref,observation_sha256),
  CHECK(julianday(expires_at)>julianday(verified_at)),
  CHECK(json_extract(qualification_json,'$.protocol') IS 'eliotr.provider-native-model-qualification.v1'),
  CHECK(json_extract(qualification_json,'$.candidate_kind') IS 'provider-native-v1'),
  CHECK(json_extract(qualification_json,'$.qualification.tier') IS 'LIVE'),
  CHECK(json_extract(qualification_json,'$.qualification.qualification_purpose') IS 'structured-output-connectivity')
) STRICT;

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
CREATE TRIGGER provider_native_model_qualification_proof_immutable_update BEFORE UPDATE ON provider_native_model_qualification_proof
BEGIN SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_IMMUTABLE'); END;
CREATE TRIGGER provider_native_model_qualification_proof_immutable_delete BEFORE DELETE ON provider_native_model_qualification_proof
BEGIN SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_IMMUTABLE'); END;

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

CREATE TABLE provider_native_model_qualification_revocation (
  qualification_ref TEXT NOT NULL,
  qualification_sha256 TEXT NOT NULL CHECK(length(qualification_sha256)=64 AND qualification_sha256 NOT GLOB '*[^0-9a-f]*'),
  owner_ref TEXT NOT NULL CHECK(length(owner_ref) BETWEEN 1 AND 256),
  project_id TEXT NOT NULL CHECK(length(project_id) BETWEEN 1 AND 256),
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1024),
  revoked_by TEXT NOT NULL CHECK(length(revoked_by) BETWEEN 1 AND 256),
  revoked_at TEXT NOT NULL CHECK(revoked_at GLOB '????-??-??T??:??:??.???Z' AND julianday(revoked_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',revoked_at) IS revoked_at),
  PRIMARY KEY(qualification_ref,qualification_sha256),
  FOREIGN KEY(qualification_ref,qualification_sha256,owner_ref,project_id)
    REFERENCES provider_native_model_qualification_proof(qualification_ref,qualification_sha256,owner_ref,project_id),
  CHECK(revoked_by=owner_ref)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER provider_native_model_qualification_revocation_guard BEFORE INSERT ON provider_native_model_qualification_revocation
WHEN NOT EXISTS (
  SELECT 1 FROM provider_native_model_qualification_proof q
  JOIN project p ON p.project_id=NEW.project_id JOIN project_owner o ON o.project_id=p.project_id
  WHERE q.qualification_ref=NEW.qualification_ref AND q.qualification_sha256=NEW.qualification_sha256
    AND q.owner_ref=NEW.owner_ref AND q.project_id=NEW.project_id
    AND q.qualification_tier='LIVE' AND o.principal_ref=NEW.owner_ref
)
BEGIN SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_REVOCATION_INVALID'); END;
CREATE TRIGGER provider_native_model_qualification_revocation_immutable_update BEFORE UPDATE ON provider_native_model_qualification_revocation
BEGIN SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_REVOCATION_IMMUTABLE'); END;
CREATE TRIGGER provider_native_model_qualification_revocation_immutable_delete BEFORE DELETE ON provider_native_model_qualification_revocation
BEGIN SELECT RAISE(ABORT,'PROVIDER_NATIVE_MODEL_REVOCATION_IMMUTABLE'); END;

CREATE INDEX provider_native_model_candidate_stage_idx ON provider_native_model_candidate(owner_ref,project_id,stage,route_ref,route_version);
CREATE INDEX provider_native_model_proof_candidate_idx ON provider_native_model_qualification_proof(candidate_ref,candidate_sha256,qualification_ref);
CREATE INDEX provider_native_model_revocation_lookup_idx ON provider_native_model_qualification_revocation(qualification_ref,qualification_sha256);
