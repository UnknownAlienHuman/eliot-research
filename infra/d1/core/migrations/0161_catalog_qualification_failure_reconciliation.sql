-- Append authenticated metadata-only Gateway failure receipts. Preserve every
-- original native UNCERTAIN row: a failed qualification makes no no-effect claim.
PRAGMA foreign_keys=ON;

CREATE TABLE provider_native_model_catalog_v2_failure (
  owner_ref TEXT NOT NULL,
  project_id TEXT NOT NULL,
  consent_operation_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('ANALYZE_BRANCHES','COUNTER_SEARCH','SYNTHESIZE','AUDIT_CLAIMS')),
  preparation_ref TEXT NOT NULL,
  preparation_sha256 TEXT NOT NULL CHECK(length(preparation_sha256)=64 AND preparation_sha256 NOT GLOB '*[^0-9a-f]*'),
  account_id TEXT NOT NULL CHECK(length(account_id)=32 AND account_id NOT GLOB '*[^0-9a-f]*'),
  gateway_id TEXT NOT NULL CHECK(length(gateway_id) BETWEEN 1 AND 64),
  gateway_log_id TEXT NOT NULL CHECK(length(gateway_log_id) BETWEEN 1 AND 256),
  http_status INTEGER NOT NULL CHECK(http_status IN (400,401,403,404,405,406,410,413,415,422)),
  logged_at TEXT NOT NULL CHECK(logged_at GLOB '????-??-??T??:??:??.???Z' AND julianday(logged_at) IS NOT NULL),
  observed_at TEXT NOT NULL CHECK(observed_at GLOB '????-??-??T??:??:??.???Z' AND julianday(observed_at)>=julianday(logged_at)),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) BETWEEN 2 AND 16384),
  receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256)=64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY(owner_ref,project_id,consent_operation_id),
  UNIQUE(account_id,gateway_id,gateway_log_id),
  FOREIGN KEY(owner_ref,project_id,consent_operation_id,stage)
    REFERENCES provider_native_model_catalog_v2_evidence(owner_ref,project_id,consent_operation_id,stage)
) STRICT;

CREATE TRIGGER provider_native_model_catalog_v2_failure_guard
BEFORE INSERT ON provider_native_model_catalog_v2_failure
WHEN NOT EXISTS (
  SELECT 1 FROM provider_native_model_catalog_v2_evidence e
  JOIN research_catalog_model_use_authorization a ON a.owner_id=e.owner_ref AND a.project_id=e.project_id
    AND a.operation_id=e.consent_operation_id
  JOIN project p ON p.project_id=a.project_id JOIN project_owner o ON o.project_id=p.project_id
  JOIN service_model_provider_operation g ON g.owner_id=a.owner_id AND g.operation_id=a.provider_operation_id
  WHERE e.owner_ref=NEW.owner_ref AND e.project_id=NEW.project_id AND e.consent_operation_id=NEW.consent_operation_id
    AND e.stage=NEW.stage AND e.state='UNCERTAIN' AND a.state='UNCERTAIN' AND a.phase='QUALIFICATION'
    AND e.preparation_ref=NEW.preparation_ref AND e.preparation_sha256=NEW.preparation_sha256
    AND a.account_id=NEW.account_id AND a.gateway_id=NEW.gateway_id
    AND a.provider_id=e.provider_id AND a.provider_operation_id=e.provider_operation_id AND a.route_provider_id=e.provider_slug
    AND a.model_id=e.model_id AND a.alias=e.alias AND a.provider_config_id=e.provider_config_id
    AND a.configuration_metadata_sha256=e.configuration_metadata_sha256 AND a.request_sha256=e.request_sha256
    AND p.generation=a.project_generation AND o.principal_ref=a.owner_id
    AND g.state='CONFIGURED' AND g.failure_code IS NULL AND g.provider_http_status IS NULL
    AND g.provider_id=e.provider_id AND g.provider_slug=e.provider_slug AND g.alias=e.alias
    AND g.provider_config_id=e.provider_config_id AND g.metadata_sha256=e.configuration_metadata_sha256
    AND julianday(NEW.logged_at)>=julianday(json_extract(e.preparation_json,'$.prepared_at'))
    AND julianday(NEW.logged_at)<julianday(json_extract(e.preparation_json,'$.preparation_expires_at'))
)
BEGIN SELECT RAISE(ABORT,'exact current uncertain qualification and authenticated Gateway failure receipt are required'); END;

CREATE TRIGGER provider_native_model_catalog_v2_failure_identity_guard
BEFORE INSERT ON provider_native_model_catalog_v2_failure
WHEN NOT EXISTS (
  SELECT 1 FROM provider_native_model_catalog_v2_evidence e
  JOIN research_catalog_model_use_authorization a ON a.owner_id=e.owner_ref AND a.project_id=e.project_id
    AND a.operation_id=e.consent_operation_id
  WHERE e.owner_ref=NEW.owner_ref AND e.project_id=NEW.project_id AND e.consent_operation_id=NEW.consent_operation_id
    AND e.stage=NEW.stage
    AND json_extract(NEW.receipt_json,'$.protocol') IS 'eliotr.catalog-model-qualification-failure.v1'
    AND json_extract(NEW.receipt_json,'$.owner_ref') IS NEW.owner_ref
    AND json_extract(NEW.receipt_json,'$.project_id') IS NEW.project_id
    AND json_extract(NEW.receipt_json,'$.operation_id') IS NEW.consent_operation_id
    AND json_extract(NEW.receipt_json,'$.stage') IS NEW.stage
    AND json_extract(NEW.receipt_json,'$.account_id') IS NEW.account_id
    AND json_extract(NEW.receipt_json,'$.gateway_id') IS NEW.gateway_id
    AND json_extract(NEW.receipt_json,'$.gateway_log_id') IS NEW.gateway_log_id
    AND json_extract(NEW.receipt_json,'$.http_status') IS NEW.http_status
    AND json_extract(NEW.receipt_json,'$.logged_at') IS NEW.logged_at
    AND json_extract(NEW.receipt_json,'$.observed_at') IS NEW.observed_at
    AND json_extract(NEW.receipt_json,'$.preparation_ref') IS NEW.preparation_ref
    AND json_extract(NEW.receipt_json,'$.preparation_sha256') IS NEW.preparation_sha256
    AND json_extract(NEW.receipt_json,'$.provider_id') IS e.provider_id
    AND json_extract(NEW.receipt_json,'$.provider_slug') IS e.provider_slug
    AND json_extract(NEW.receipt_json,'$.provider_operation_id') IS e.provider_operation_id
    AND json_extract(NEW.receipt_json,'$.model_id') IS e.model_id
    AND json_extract(NEW.receipt_json,'$.request_sha256') IS e.request_sha256
    AND json_extract(NEW.receipt_json,'$.owner_credential_generation') IS a.owner_credential_generation
    AND json_extract(NEW.receipt_json,'$.deployment_generation') IS a.deployment_generation
    AND json_extract(NEW.receipt_json,'$.original_failure_code') IS a.failure_code
    AND json_extract(NEW.receipt_json,'$.original_updated_at') IS a.updated_at
    AND json_extract(NEW.receipt_json,'$.pricing_snapshot_sha256') IS e.pricing_snapshot_sha256
)
BEGIN SELECT RAISE(ABORT,'Gateway failure receipt must preserve exact consent and preparation identity'); END;

CREATE TRIGGER provider_native_model_catalog_v2_failure_metadata_guard
BEFORE INSERT ON provider_native_model_catalog_v2_failure
WHEN NOT EXISTS (
  SELECT 1 FROM provider_native_model_catalog_v2_evidence e
  WHERE e.owner_ref=NEW.owner_ref AND e.project_id=NEW.project_id AND e.consent_operation_id=NEW.consent_operation_id
    AND e.stage=NEW.stage
    AND json_extract(NEW.receipt_json,'$.gateway_authenticated') IS 1
    AND json_extract(NEW.receipt_json,'$.success') IS 0
    AND json_extract(NEW.receipt_json,'$.original_state') IS 'UNCERTAIN'
    AND json_extract(NEW.receipt_json,'$.provider_effects') IS 'UNKNOWN'
    AND json_extract(NEW.receipt_json,'$.classification') IS 'GATEWAY_HTTP_REJECTED'
    AND json_extract(NEW.receipt_json,'$.gateway_metadata.operation_id') IS e.consent_operation_id
    AND json_extract(NEW.receipt_json,'$.gateway_metadata.pricing_snapshot_ref') IS e.pricing_snapshot_ref
    AND json_extract(NEW.receipt_json,'$.gateway_metadata.parameters_digest') IS json_extract(e.preparation_json,'$.probe_parameters_sha256')
    AND json_extract(NEW.receipt_json,'$.gateway_metadata.prompt_generation') IS json_extract(e.preparation_json,'$.probe_deployment.prompt_generation')
    AND json_extract(NEW.receipt_json,'$.gateway_metadata.route_ref') IS json_extract(e.preparation_json,'$.probe_deployment.route_ref')
)
BEGIN SELECT RAISE(ABORT,'exact current uncertain qualification and authenticated Gateway failure receipt are required'); END;

CREATE TRIGGER provider_native_model_catalog_v2_failure_no_update
BEFORE UPDATE ON provider_native_model_catalog_v2_failure
BEGIN SELECT RAISE(ABORT,'Gateway qualification failure receipts are immutable'); END;
CREATE TRIGGER provider_native_model_catalog_v2_failure_no_delete
BEFORE DELETE ON provider_native_model_catalog_v2_failure
BEGIN SELECT RAISE(ABORT,'Gateway qualification failure receipts are immutable'); END;

-- An operation-level failure bars completion of any remaining stage candidate.
CREATE TRIGGER provider_native_model_catalog_v2_failed_promotion_guard
BEFORE UPDATE OF state ON provider_native_model_catalog_v2_evidence
WHEN NEW.state='COMPLETED' AND EXISTS (
  SELECT 1 FROM provider_native_model_catalog_v2_failure f WHERE f.owner_ref=NEW.owner_ref
    AND f.project_id=NEW.project_id AND f.consent_operation_id=NEW.consent_operation_id
)
BEGIN SELECT RAISE(ABORT,'failed catalog qualification cannot promote a candidate'); END;

DROP TRIGGER research_catalog_model_use_authorization_transition;
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
       (OLD.state='IMPORTING' AND NEW.state IN ('IMPORTING','SELECTED','BLOCKED','CONFLICT')) OR
       (OLD.state='UNCERTAIN' AND OLD.phase='QUALIFICATION' AND NEW.state='BLOCKED' AND NEW.phase='QUALIFICATION'
        AND NEW.failure_code='NATIVE_RECEIPT_INVALID' AND EXISTS (
          SELECT 1 FROM provider_native_model_catalog_v2_failure f WHERE f.owner_ref=OLD.owner_id
            AND f.project_id=OLD.project_id AND f.consent_operation_id=OLD.operation_id
            AND f.account_id=OLD.account_id AND f.gateway_id=OLD.gateway_id
            AND json_extract(f.receipt_json,'$.request_sha256') IS OLD.request_sha256
            AND json_extract(f.receipt_json,'$.owner_credential_generation') IS OLD.owner_credential_generation
        )))
BEGIN SELECT RAISE(ABORT,'catalog model-use identity is immutable and state transitions are monotone'); END;
