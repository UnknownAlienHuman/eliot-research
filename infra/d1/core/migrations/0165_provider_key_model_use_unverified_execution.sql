-- Preserve authenticated successful legacy provider-key probes for which no
-- native qualification observation was retained. The receipt never promotes
-- a candidate and keeps provider effects explicitly unknown.
PRAGMA foreign_keys=ON;

CREATE TABLE research_provider_key_model_use_unverified_execution (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('ANALYZE_BRANCHES','COUNTER_SEARCH','SYNTHESIZE','AUDIT_CLAIMS')),
  preparation_ref TEXT NOT NULL,
  preparation_sha256 TEXT NOT NULL CHECK(length(preparation_sha256)=64 AND preparation_sha256 NOT GLOB '*[^0-9a-f]*'),
  account_id TEXT NOT NULL CHECK(length(account_id)=32 AND account_id NOT GLOB '*[^0-9a-f]*'),
  gateway_id TEXT NOT NULL CHECK(length(gateway_id) BETWEEN 1 AND 64),
  gateway_log_id TEXT NOT NULL CHECK(length(gateway_log_id) BETWEEN 1 AND 256),
  http_status INTEGER NOT NULL CHECK(http_status=200),
  logged_at TEXT NOT NULL CHECK(logged_at GLOB '????-??-??T??:??:??.???Z' AND julianday(logged_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ',logged_at) IS logged_at),
  observed_at TEXT NOT NULL CHECK(observed_at GLOB '????-??-??T??:??:??.???Z' AND julianday(observed_at)>=julianday(logged_at)
    AND strftime('%Y-%m-%dT%H:%M:%fZ',observed_at) IS observed_at),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 16384),
  receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256)=64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(owner_id,project_id,operation_id),
  UNIQUE(account_id,gateway_id,gateway_log_id),
  FOREIGN KEY(owner_id,project_id,operation_id,stage)
    REFERENCES research_provider_key_model_use_stage_operation(owner_id,project_id,operation_id,stage),
  FOREIGN KEY(owner_id,project_id,operation_id,stage,preparation_ref,preparation_sha256)
    REFERENCES provider_native_model_preparation(owner_ref,project_id,owner_operation_id,stage,preparation_ref,preparation_sha256)
) STRICT;

CREATE TRIGGER research_provider_key_model_use_unverified_execution_guard
BEFORE INSERT ON research_provider_key_model_use_unverified_execution
WHEN NOT EXISTS (
  SELECT 1 FROM research_provider_key_model_use_operation u
  JOIN research_provider_key_model_use_stage_operation s
    ON s.owner_id=u.owner_id AND s.project_id=u.project_id AND s.operation_id=u.operation_id
  JOIN provider_native_model_preparation prep
    ON prep.owner_ref=u.owner_id AND prep.project_id=u.project_id AND prep.owner_operation_id=u.operation_id AND prep.stage=s.stage
  JOIN provider_native_model_qualification_attempt a
    ON a.owner_ref=u.owner_id AND a.project_id=u.project_id AND a.owner_operation_id=u.operation_id AND a.stage=s.stage
      AND a.preparation_ref=prep.preparation_ref AND a.preparation_sha256=prep.preparation_sha256
  JOIN project p ON p.project_id=u.project_id
  JOIN project_owner o ON o.project_id=p.project_id
  WHERE u.owner_id=NEW.owner_id AND u.project_id=NEW.project_id AND u.operation_id=NEW.operation_id
    AND u.state='UNCERTAIN' AND u.phase='NATIVE_QUALIFY' AND u.active_stage=NEW.stage
    AND u.failure_code='QUALIFICATION_OUTCOME_UNCERTAIN'
    AND s.stage=NEW.stage AND s.state='UNCERTAIN' AND s.failure_code='QUALIFICATION_OUTCOME_UNCERTAIN'
    AND s.preparation_ref=NEW.preparation_ref AND s.preparation_sha256=NEW.preparation_sha256
    AND s.candidate_ref IS NULL AND s.qualification_ref IS NULL
    AND a.state='STARTED' AND a.observation_ref IS NULL AND a.candidate_ref IS NULL AND a.qualification_ref IS NULL
    AND a.completed_at IS NULL
    AND julianday(NEW.logged_at)>=julianday(a.started_at)
    AND prep.preparation_ref=NEW.preparation_ref AND prep.preparation_sha256=NEW.preparation_sha256
    AND p.generation=u.project_generation AND o.principal_ref=u.owner_id
    AND NEW.account_id=u.account_id AND NEW.gateway_id=u.gateway_id
    AND julianday(NEW.logged_at)>=julianday(json_extract(prep.preparation_json,'$.prepared_at'))
    AND julianday(NEW.logged_at)<julianday(json_extract(prep.preparation_json,'$.preparation_expires_at'))
)
BEGIN SELECT RAISE(ABORT,'exact current uncertain legacy qualification and preparation are required'); END;

CREATE TRIGGER research_provider_key_model_use_unverified_execution_key_authority_guard
BEFORE INSERT ON research_provider_key_model_use_unverified_execution
WHEN NOT EXISTS (
  SELECT 1 FROM research_provider_key_model_use_key_authority k
  WHERE k.owner_id=NEW.owner_id AND k.project_id=NEW.project_id AND k.provider_id='openrouter'
    AND k.operation_id=json_extract(NEW.receipt_json,'$.key_operation_id')
    AND k.state='CONFIGURED' AND k.account_id=NEW.account_id AND k.gateway_id=NEW.gateway_id
    AND k.alias=json_extract(NEW.receipt_json,'$.alias')
    AND k.provider_config_id=json_extract(NEW.receipt_json,'$.provider_config_id')
    AND k.metadata_sha256=json_extract(NEW.receipt_json,'$.configuration_metadata_sha256')
)
BEGIN SELECT RAISE(ABORT,'current project or global model-key authority is required'); END;

CREATE TRIGGER research_provider_key_model_use_unverified_execution_identity_guard
BEFORE INSERT ON research_provider_key_model_use_unverified_execution
WHEN NOT EXISTS (
  SELECT 1 FROM research_provider_key_model_use_operation u
  WHERE u.owner_id=NEW.owner_id AND u.project_id=NEW.project_id AND u.operation_id=NEW.operation_id
    AND u.state='UNCERTAIN' AND u.phase='NATIVE_QUALIFY' AND u.active_stage=NEW.stage
    AND json_extract(NEW.receipt_json,'$.request_sha256') IS u.request_sha256
    AND json_extract(NEW.receipt_json,'$.owner_credential_generation') IS u.owner_credential_generation
    AND json_extract(NEW.receipt_json,'$.project_generation') IS u.project_generation
    AND json_extract(NEW.receipt_json,'$.deployment_generation') IS u.deployment_generation
    AND json_extract(NEW.receipt_json,'$.key_operation_id') IS u.key_operation_id
    AND json_extract(NEW.receipt_json,'$.alias') IS u.alias
    AND json_extract(NEW.receipt_json,'$.provider_config_id') IS u.provider_config_id
    AND json_extract(NEW.receipt_json,'$.configuration_metadata_sha256') IS u.configuration_metadata_sha256
    AND json_extract(NEW.receipt_json,'$.original_state') IS u.state
    AND json_extract(NEW.receipt_json,'$.original_phase') IS u.phase
    AND json_extract(NEW.receipt_json,'$.original_failure_code') IS u.failure_code
    AND json_extract(NEW.receipt_json,'$.original_updated_at') IS u.updated_at
)
BEGIN SELECT RAISE(ABORT,'unverified execution receipt must preserve original operation provenance'); END;

CREATE TRIGGER research_provider_key_model_use_unverified_execution_stage_guard
BEFORE INSERT ON research_provider_key_model_use_unverified_execution
WHEN NOT EXISTS (
  SELECT 1 FROM research_provider_key_model_use_stage_operation s
  WHERE s.owner_id=NEW.owner_id AND s.project_id=NEW.project_id AND s.operation_id=NEW.operation_id AND s.stage=NEW.stage
    AND s.state='UNCERTAIN' AND s.failure_code='QUALIFICATION_OUTCOME_UNCERTAIN'
    AND s.preparation_ref=NEW.preparation_ref AND s.preparation_sha256=NEW.preparation_sha256
    AND json_extract(NEW.receipt_json,'$.pricing_snapshot_ref') IS s.pricing_snapshot_ref
    AND json_extract(NEW.receipt_json,'$.pricing_snapshot_sha256') IS s.pricing_snapshot_sha256
    AND json_extract(NEW.receipt_json,'$.original_active_stage') IS s.stage
)
BEGIN SELECT RAISE(ABORT,'unverified execution receipt must preserve exact uncertain stage provenance'); END;

CREATE TRIGGER research_provider_key_model_use_unverified_execution_identity_values_guard
BEFORE INSERT ON research_provider_key_model_use_unverified_execution
WHEN NOT (
    json_extract(NEW.receipt_json,'$.protocol') IS 'eliotr.provider-key-model-use-unverified-execution.v1'
    AND json_extract(NEW.receipt_json,'$.owner_id') IS NEW.owner_id
    AND json_extract(NEW.receipt_json,'$.project_id') IS NEW.project_id
    AND json_extract(NEW.receipt_json,'$.operation_id') IS NEW.operation_id
    AND json_extract(NEW.receipt_json,'$.stage') IS NEW.stage
)
BEGIN SELECT RAISE(ABORT,'unverified execution receipt protocol and operation keys must match its row'); END;

CREATE TRIGGER research_provider_key_model_use_unverified_execution_transport_identity_guard
BEFORE INSERT ON research_provider_key_model_use_unverified_execution
WHEN NOT (
    json_extract(NEW.receipt_json,'$.account_id') IS NEW.account_id
    AND json_extract(NEW.receipt_json,'$.gateway_id') IS NEW.gateway_id
    AND json_extract(NEW.receipt_json,'$.gateway_log_id') IS NEW.gateway_log_id
    AND json_extract(NEW.receipt_json,'$.http_status') IS 200
    AND json_extract(NEW.receipt_json,'$.logged_at') IS NEW.logged_at
    AND json_extract(NEW.receipt_json,'$.observed_at') IS NEW.observed_at
    AND json_extract(NEW.receipt_json,'$.preparation_ref') IS NEW.preparation_ref
    AND json_extract(NEW.receipt_json,'$.preparation_sha256') IS NEW.preparation_sha256
)
BEGIN SELECT RAISE(ABORT,'unverified execution receipt gateway and preparation columns must match its row'); END;

CREATE TRIGGER research_provider_key_model_use_unverified_execution_provider_identity_guard
BEFORE INSERT ON research_provider_key_model_use_unverified_execution
WHEN NOT (
    json_extract(NEW.receipt_json,'$.provider_id') IS 'openrouter'
    AND json_extract(NEW.receipt_json,'$.provider_operation_id') IS json_extract(NEW.receipt_json,'$.key_operation_id')
    AND json_extract(NEW.receipt_json,'$.provider_slug') IS 'openrouter'
)
BEGIN SELECT RAISE(ABORT,'unverified execution receipt identity columns must match its JSON'); END;

CREATE TRIGGER research_provider_key_model_use_unverified_execution_outcome_guard
BEFORE INSERT ON research_provider_key_model_use_unverified_execution
WHEN NOT (
  json_extract(NEW.receipt_json,'$.gateway_authenticated') IS 1
  AND json_extract(NEW.receipt_json,'$.gateway_page.complete') IS 1
  AND json_extract(NEW.receipt_json,'$.gateway_page.page') IS 1
  AND json_extract(NEW.receipt_json,'$.gateway_page.per_page') IS 50
  AND json_extract(NEW.receipt_json,'$.gateway_page.result_count') BETWEEN 1 AND 50
  AND json_extract(NEW.receipt_json,'$.gateway_page.result_count') IS json_extract(NEW.receipt_json,'$.gateway_page.total_count')
  AND json_extract(NEW.receipt_json,'$.gateway_page.matched_stage_log_count') IS 1
  AND json_extract(NEW.receipt_json,'$.gateway_success') IS 1
  AND json_extract(NEW.receipt_json,'$.cached') IS 0
  AND json_extract(NEW.receipt_json,'$.provider_effects') IS 'UNKNOWN'
  AND json_extract(NEW.receipt_json,'$.qualification') IS 'UNVERIFIED'
  AND json_extract(NEW.receipt_json,'$.native_observation_retained') IS 0
  AND json_type(NEW.receipt_json,'$.response_body') IS NULL
  AND json_extract(NEW.receipt_json,'$.classification') IS 'EXECUTION_COMPLETED_QUALIFICATION_UNVERIFIED'
  AND json_type(NEW.receipt_json,'$.reader_credential_generation') IS 'text'
  AND length(json_extract(NEW.receipt_json,'$.reader_credential_generation')) BETWEEN 1 AND 256
)
BEGIN SELECT RAISE(ABORT,'unverified execution requires a complete authenticated successful Gateway read and UNKNOWN effects'); END;

CREATE TRIGGER research_provider_key_model_use_unverified_execution_metadata_guard
BEFORE INSERT ON research_provider_key_model_use_unverified_execution
WHEN NOT EXISTS (
  SELECT 1 FROM provider_native_model_preparation prep
  WHERE prep.owner_ref=NEW.owner_id AND prep.project_id=NEW.project_id AND prep.owner_operation_id=NEW.operation_id
    AND prep.stage=NEW.stage AND prep.preparation_ref=NEW.preparation_ref AND prep.preparation_sha256=NEW.preparation_sha256
    AND json_extract(NEW.receipt_json,'$.model_id') IS json_extract(prep.preparation_json,'$.transport_policy.model')
    AND json_extract(NEW.receipt_json,'$.gateway_metadata.operation_id') IS NEW.operation_id
    AND json_extract(NEW.receipt_json,'$.gateway_metadata.parameters_digest') IS json_extract(prep.preparation_json,'$.probe_parameters_sha256')
    AND json_extract(NEW.receipt_json,'$.gateway_metadata.pricing_snapshot_ref') IS json_extract(prep.preparation_json,'$.pricing_snapshot_ref')
    AND json_extract(NEW.receipt_json,'$.gateway_metadata.prompt_generation') IS json_extract(prep.preparation_json,'$.probe_deployment.prompt_generation')
    AND json_extract(NEW.receipt_json,'$.gateway_metadata.route_ref') IS json_extract(prep.preparation_json,'$.probe_deployment.route_ref')
    AND (SELECT count(*) FROM json_each(NEW.receipt_json,'$.gateway_metadata')) IS 5
    AND json_extract(NEW.receipt_json,'$.gateway_log.provider') IS 'openrouter'
    AND json_extract(NEW.receipt_json,'$.gateway_log.id') IS NEW.gateway_log_id
    AND json_extract(NEW.receipt_json,'$.gateway_log.model') IS json_extract(prep.preparation_json,'$.transport_policy.model')
    AND json_extract(NEW.receipt_json,'$.gateway_log.status_code') IS 200
    AND json_extract(NEW.receipt_json,'$.gateway_log.success') IS 1
    AND json_extract(NEW.receipt_json,'$.gateway_log.cached') IS 0
    AND json_extract(NEW.receipt_json,'$.logged_at') IS NEW.logged_at
)
BEGIN SELECT RAISE(ABORT,'unverified execution must match the exact prepared five-field Gateway metadata'); END;

CREATE TRIGGER research_provider_key_model_use_unverified_execution_no_update
BEFORE UPDATE ON research_provider_key_model_use_unverified_execution
BEGIN SELECT RAISE(ABORT,'legacy unverified execution receipts are immutable'); END;
CREATE TRIGGER research_provider_key_model_use_unverified_execution_no_delete
BEFORE DELETE ON research_provider_key_model_use_unverified_execution
BEGIN SELECT RAISE(ABORT,'legacy unverified execution receipts are immutable'); END;

DROP TRIGGER research_provider_key_model_use_transition;
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
    OR (OLD.state='UNCERTAIN' AND OLD.phase='NATIVE_QUALIFY' AND NEW.state='BLOCKED' AND NEW.phase='NATIVE_QUALIFY'
      AND NEW.active_stage IS OLD.active_stage AND OLD.active_stage IS NOT NULL
      AND NEW.failure_code='NATIVE_RECEIPT_INVALID')
  )
BEGIN SELECT RAISE(ABORT,'model-use identity is immutable and state transitions are monotone'); END;

CREATE TRIGGER research_provider_key_model_use_unverified_execution_transition_guard
BEFORE UPDATE ON research_provider_key_model_use_operation
WHEN OLD.state='UNCERTAIN' AND NEW.state='BLOCKED' AND NOT EXISTS (
  SELECT 1 FROM research_provider_key_model_use_stage_operation s
  JOIN research_provider_key_model_use_unverified_execution x
    ON x.owner_id=s.owner_id AND x.project_id=s.project_id AND x.operation_id=s.operation_id AND x.stage=s.stage
      AND x.preparation_ref=s.preparation_ref AND x.preparation_sha256=s.preparation_sha256
  WHERE s.owner_id=OLD.owner_id AND s.project_id=OLD.project_id AND s.operation_id=OLD.operation_id
    AND s.stage=OLD.active_stage AND s.state='UNCERTAIN'
    AND x.account_id=OLD.account_id AND x.gateway_id=OLD.gateway_id
    AND json_extract(x.receipt_json,'$.request_sha256') IS OLD.request_sha256
    AND json_extract(x.receipt_json,'$.owner_credential_generation') IS OLD.owner_credential_generation
    AND json_extract(x.receipt_json,'$.project_generation') IS OLD.project_generation
    AND json_extract(x.receipt_json,'$.deployment_generation') IS OLD.deployment_generation
    AND json_extract(x.receipt_json,'$.original_state') IS OLD.state
    AND json_extract(x.receipt_json,'$.original_phase') IS OLD.phase
    AND json_extract(x.receipt_json,'$.original_active_stage') IS OLD.active_stage
    AND json_extract(x.receipt_json,'$.original_failure_code') IS OLD.failure_code
    AND json_extract(x.receipt_json,'$.original_updated_at') IS OLD.updated_at
    AND json_extract(x.receipt_json,'$.provider_effects') IS 'UNKNOWN'
    AND json_extract(x.receipt_json,'$.qualification') IS 'UNVERIFIED'
    AND json_extract(x.receipt_json,'$.native_observation_retained') IS 0
    AND json_extract(x.receipt_json,'$.classification') IS 'EXECUTION_COMPLETED_QUALIFICATION_UNVERIFIED'
)
BEGIN SELECT RAISE(ABORT,'legacy uncertain closure requires its exact immutable unverified execution receipt'); END;
