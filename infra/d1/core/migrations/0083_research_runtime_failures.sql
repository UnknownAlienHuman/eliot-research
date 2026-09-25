-- S17: bounded first/latest diagnostic metadata, not execution or retry authority.
-- Existing source rows, attempts, checkpoint hashes and state transitions are retained.
ALTER TABLE research_workflow_run ADD COLUMN first_failure_json TEXT;
ALTER TABLE research_workflow_run ADD COLUMN latest_failure_json TEXT;
ALTER TABLE research_workflow_attempt ADD COLUMN first_failure_json TEXT;

CREATE TRIGGER research_workflow_failure_initial BEFORE INSERT ON research_workflow_run
WHEN NEW.first_failure_json IS NOT NULL OR NEW.latest_failure_json IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_CONFLICT'); END;

CREATE TRIGGER research_workflow_first_failure_json_shape BEFORE UPDATE OF first_failure_json ON research_workflow_run
WHEN NEW.first_failure_json IS NOT NULL
BEGIN
 SELECT CASE WHEN COALESCE((json_valid(NEW.first_failure_json) AND length(CAST(NEW.first_failure_json AS BLOB))<=1024
 AND json_type(NEW.first_failure_json)='object'
 AND json_extract(NEW.first_failure_json,'$.code') IN (
   'WORKFLOW_INPUT_INVALID',
   'WORKFLOW_CONFLICT',
   'WORKFLOW_AUTHORITY_STALE',
   'WORKFLOW_STAGE_OUT_OF_ORDER',
   'WORKFLOW_CANCELLED',
   'WORKFLOW_BUDGET_STOP',
   'WORKFLOW_EFFECT_UNCERTAIN',
   'WORKFLOW_OUTPUT_UNAVAILABLE',
   'WORKFLOW_OUTPUT_CORRUPT',
   'WORKFLOW_CONFIGURATION_MISSING',
   'WORKFLOW_CONFIGURATION_INVALID',
   'WORKFLOW_CREDENTIALS_MISSING',
   'WORKFLOW_CREDENTIALS_INVALID',
   'WORKFLOW_STORAGE_UNAVAILABLE',
   'WORKFLOW_QUALIFICATION_STALE',
   'WORKFLOW_PREPARATION_FAILED',
   'RESEARCH_QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED',
   'RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE',
   'RESEARCH_QUALIFICATION_RENEWAL_UNAVAILABLE',
   'RESEARCH_QUALIFICATION_RENEWAL_ROUTE_UNAVAILABLE',
   'MODEL_ATTEMPT_INPUT_INVALID',
   'MODEL_ATTEMPT_AUTHORITY_STALE',
   'MODEL_ATTEMPT_IDENTITY_CONFLICT',
   'MODEL_ATTEMPT_BUDGET_EXPIRED',
   'MODEL_ATTEMPT_CONFLICT',
   'MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN',
   'MODEL_ATTEMPT_READBACK_CORRUPT',
   'MODEL_GATEWAY_DEPLOYMENT_MISSING',
   'MODEL_GATEWAY_PROMPT_COMPILE_FAILED',
   'MODEL_GATEWAY_REQUEST_INVALID',
   'MODEL_GATEWAY_CREDENTIAL_INVALID',
   'MODEL_GATEWAY_TRANSPORT_FAILED',
   'MODEL_GATEWAY_AUTH_REJECTED',
   'MODEL_GATEWAY_LIMIT_REJECTED',
   'MODEL_GATEWAY_POLICY_REJECTED',
   'MODEL_GATEWAY_UPSTREAM_REJECTED',
   'MODEL_GATEWAY_RESPONSE_INVALID',
   'MODEL_GATEWAY_OUTPUT_TRUNCATED',
   'MODEL_GATEWAY_OUTPUT_PERSIST_FAILED',
   'MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED',
   'MODEL_GATEWAY_PRICING_FAILED'
 )
 AND json_extract(NEW.first_failure_json,'$.phase') IN ('PREPARATION','STAGE','RECOVERY')
 AND json_type(NEW.first_failure_json,'$.retryable') IN ('true','false')
 AND (json_extract(NEW.first_failure_json,'$.phase')='PREPARATION' AND json_type(NEW.first_failure_json,'$.stage') IS NULL
   OR json_extract(NEW.first_failure_json,'$.phase') IN ('STAGE','RECOVERY') AND json_extract(NEW.first_failure_json,'$.stage') IN (
   'FREEZE_PROTOCOL_AND_SCOPE',
   'ORIENT',
   'INTERPRET',
   'COMPILE_OBLIGATIONS',
   'PLAN',
   'RETRIEVE_BRANCHES',
   'ACQUIRE_AND_CAPTURE',
   'READ_AND_EXTRACT',
   'ANALYZE_BRANCHES',
   'COUNTER_SEARCH',
   'RECONCILE',
   'FREEZE_EVIDENCE',
   'SYNTHESIZE',
   'VERIFY',
   'AUDIT_CLAIMS',
   'RESOLVE_CITATIONS',
   'CALCULATE_COVERAGE',
   'MATERIALIZE'
 ))
 AND (json_extract(NEW.first_failure_json,'$.retryable')=0 OR
   json_extract(NEW.first_failure_json,'$.phase')='PREPARATION' AND json_extract(NEW.first_failure_json,'$.code')='WORKFLOW_STORAGE_UNAVAILABLE')),0)<>1 THEN RAISE(ABORT,'WORKFLOW_CONFLICT') END;
 SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.first_failure_json) WHERE key NOT IN ('code','phase','stage','retryable'))
   OR (SELECT COUNT(*) FROM json_each(NEW.first_failure_json)) <> CASE json_extract(NEW.first_failure_json,'$.phase') WHEN 'PREPARATION' THEN 3 ELSE 4 END
   THEN RAISE(ABORT,'WORKFLOW_CONFLICT') END;
END;

CREATE TRIGGER research_workflow_latest_failure_json_shape BEFORE UPDATE OF latest_failure_json ON research_workflow_run
WHEN NEW.latest_failure_json IS NOT NULL
BEGIN
 SELECT CASE WHEN COALESCE((json_valid(NEW.latest_failure_json) AND length(CAST(NEW.latest_failure_json AS BLOB))<=1024
 AND json_type(NEW.latest_failure_json)='object'
 AND json_extract(NEW.latest_failure_json,'$.code') IN (
   'WORKFLOW_INPUT_INVALID',
   'WORKFLOW_CONFLICT',
   'WORKFLOW_AUTHORITY_STALE',
   'WORKFLOW_STAGE_OUT_OF_ORDER',
   'WORKFLOW_CANCELLED',
   'WORKFLOW_BUDGET_STOP',
   'WORKFLOW_EFFECT_UNCERTAIN',
   'WORKFLOW_OUTPUT_UNAVAILABLE',
   'WORKFLOW_OUTPUT_CORRUPT',
   'WORKFLOW_CONFIGURATION_MISSING',
   'WORKFLOW_CONFIGURATION_INVALID',
   'WORKFLOW_CREDENTIALS_MISSING',
   'WORKFLOW_CREDENTIALS_INVALID',
   'WORKFLOW_STORAGE_UNAVAILABLE',
   'WORKFLOW_QUALIFICATION_STALE',
   'WORKFLOW_PREPARATION_FAILED',
   'RESEARCH_QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED',
   'RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE',
   'RESEARCH_QUALIFICATION_RENEWAL_UNAVAILABLE',
   'RESEARCH_QUALIFICATION_RENEWAL_ROUTE_UNAVAILABLE',
   'MODEL_ATTEMPT_INPUT_INVALID',
   'MODEL_ATTEMPT_AUTHORITY_STALE',
   'MODEL_ATTEMPT_IDENTITY_CONFLICT',
   'MODEL_ATTEMPT_BUDGET_EXPIRED',
   'MODEL_ATTEMPT_CONFLICT',
   'MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN',
   'MODEL_ATTEMPT_READBACK_CORRUPT',
   'MODEL_GATEWAY_DEPLOYMENT_MISSING',
   'MODEL_GATEWAY_PROMPT_COMPILE_FAILED',
   'MODEL_GATEWAY_REQUEST_INVALID',
   'MODEL_GATEWAY_CREDENTIAL_INVALID',
   'MODEL_GATEWAY_TRANSPORT_FAILED',
   'MODEL_GATEWAY_AUTH_REJECTED',
   'MODEL_GATEWAY_LIMIT_REJECTED',
   'MODEL_GATEWAY_POLICY_REJECTED',
   'MODEL_GATEWAY_UPSTREAM_REJECTED',
   'MODEL_GATEWAY_RESPONSE_INVALID',
   'MODEL_GATEWAY_OUTPUT_TRUNCATED',
   'MODEL_GATEWAY_OUTPUT_PERSIST_FAILED',
   'MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED',
   'MODEL_GATEWAY_PRICING_FAILED'
 )
 AND json_extract(NEW.latest_failure_json,'$.phase') IN ('PREPARATION','STAGE','RECOVERY')
 AND json_type(NEW.latest_failure_json,'$.retryable') IN ('true','false')
 AND (json_extract(NEW.latest_failure_json,'$.phase')='PREPARATION' AND json_type(NEW.latest_failure_json,'$.stage') IS NULL
   OR json_extract(NEW.latest_failure_json,'$.phase') IN ('STAGE','RECOVERY') AND json_extract(NEW.latest_failure_json,'$.stage') IN (
   'FREEZE_PROTOCOL_AND_SCOPE',
   'ORIENT',
   'INTERPRET',
   'COMPILE_OBLIGATIONS',
   'PLAN',
   'RETRIEVE_BRANCHES',
   'ACQUIRE_AND_CAPTURE',
   'READ_AND_EXTRACT',
   'ANALYZE_BRANCHES',
   'COUNTER_SEARCH',
   'RECONCILE',
   'FREEZE_EVIDENCE',
   'SYNTHESIZE',
   'VERIFY',
   'AUDIT_CLAIMS',
   'RESOLVE_CITATIONS',
   'CALCULATE_COVERAGE',
   'MATERIALIZE'
 ))
 AND (json_extract(NEW.latest_failure_json,'$.retryable')=0 OR
   json_extract(NEW.latest_failure_json,'$.phase')='PREPARATION' AND json_extract(NEW.latest_failure_json,'$.code')='WORKFLOW_STORAGE_UNAVAILABLE')),0)<>1 THEN RAISE(ABORT,'WORKFLOW_CONFLICT') END;
 SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.latest_failure_json) WHERE key NOT IN ('code','phase','stage','retryable'))
   OR (SELECT COUNT(*) FROM json_each(NEW.latest_failure_json)) <> CASE json_extract(NEW.latest_failure_json,'$.phase') WHEN 'PREPARATION' THEN 3 ELSE 4 END
   THEN RAISE(ABORT,'WORKFLOW_CONFLICT') END;
END;

DROP TRIGGER research_workflow_run_transition;
CREATE TRIGGER research_workflow_run_transition BEFORE UPDATE ON research_workflow_run
WHEN NEW.operation_id IS NOT OLD.operation_id
 OR NEW.investigation_id IS NOT OLD.investigation_id
 OR NEW.initial_revision IS NOT OLD.initial_revision
 OR NEW.principal_ref IS NOT OLD.principal_ref
 OR NEW.credential_generation IS NOT OLD.credential_generation
 OR NEW.deployment_generation IS NOT OLD.deployment_generation
 OR NEW.policy_generation IS NOT OLD.policy_generation
 OR NEW.policy_authority_ref IS NOT OLD.policy_authority_ref
 OR NEW.authorization_receipt_ref IS NOT OLD.authorization_receipt_ref
 OR NEW.scope_snapshot_id IS NOT OLD.scope_snapshot_id
 OR NEW.scope_snapshot_revision IS NOT OLD.scope_snapshot_revision
 OR NEW.purge_revision IS NOT OLD.purge_revision
 OR NEW.idempotency_key IS NOT OLD.idempotency_key
 OR NEW.handler_generation IS NOT OLD.handler_generation
 OR NEW.initial_manifest_json IS NOT OLD.initial_manifest_json
 OR NEW.created_at IS NOT OLD.created_at

 OR NOT (
   (OLD.state = 'ACTIVE' AND ((NEW.state = 'CANCELLED' AND NEW.next_stage_index = OLD.next_stage_index AND NEW.current_revision = OLD.current_revision
     AND NEW.cancellation_receipt_ref = 'workflow-cancelled:' || OLD.operation_id)
   OR (NEW.next_stage_index = OLD.next_stage_index + 1 AND NEW.current_revision = OLD.current_revision + 1
     AND NEW.cancellation_receipt_ref IS NULL
     AND NEW.state = CASE WHEN NEW.next_stage_index = 18 THEN 'ENGINE_COMPLETED' ELSE 'ACTIVE' END
     AND EXISTS (SELECT 1 FROM research_workflow_checkpoint c WHERE c.operation_id = OLD.operation_id AND c.stage_index = OLD.next_stage_index))
 ) AND NEW.first_failure_json IS OLD.first_failure_json
     AND NEW.latest_failure_json IS OLD.latest_failure_json)
   OR (OLD.state='ACTIVE' AND NEW.state IS OLD.state AND NEW.current_revision IS OLD.current_revision
   AND NEW.next_stage_index IS OLD.next_stage_index
   AND NEW.cancellation_receipt_ref IS OLD.cancellation_receipt_ref
   AND NEW.first_failure_json IS NOT NULL AND NEW.latest_failure_json IS NOT NULL
   AND (OLD.first_failure_json IS NULL OR NEW.first_failure_json IS OLD.first_failure_json))
 )
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_CONFLICT'); END;

CREATE TRIGGER research_workflow_attempt_failure_initial BEFORE INSERT ON research_workflow_attempt
WHEN NEW.first_failure_json IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_CONFLICT'); END;

CREATE TRIGGER research_workflow_attempt_failure_shape BEFORE UPDATE OF first_failure_json ON research_workflow_attempt
WHEN NEW.first_failure_json IS NOT NULL
BEGIN
 SELECT CASE WHEN COALESCE((json_valid(NEW.first_failure_json) AND length(CAST(NEW.first_failure_json AS BLOB))<=1024
 AND json_type(NEW.first_failure_json)='object'
 AND json_extract(NEW.first_failure_json,'$.code') IN (
   'WORKFLOW_INPUT_INVALID',
   'WORKFLOW_CONFLICT',
   'WORKFLOW_AUTHORITY_STALE',
   'WORKFLOW_STAGE_OUT_OF_ORDER',
   'WORKFLOW_CANCELLED',
   'WORKFLOW_BUDGET_STOP',
   'WORKFLOW_EFFECT_UNCERTAIN',
   'WORKFLOW_OUTPUT_UNAVAILABLE',
   'WORKFLOW_OUTPUT_CORRUPT',
   'WORKFLOW_CONFIGURATION_MISSING',
   'WORKFLOW_CONFIGURATION_INVALID',
   'WORKFLOW_CREDENTIALS_MISSING',
   'WORKFLOW_CREDENTIALS_INVALID',
   'WORKFLOW_STORAGE_UNAVAILABLE',
   'WORKFLOW_QUALIFICATION_STALE',
   'WORKFLOW_PREPARATION_FAILED',
   'RESEARCH_QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED',
   'RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE',
   'RESEARCH_QUALIFICATION_RENEWAL_UNAVAILABLE',
   'RESEARCH_QUALIFICATION_RENEWAL_ROUTE_UNAVAILABLE',
   'MODEL_ATTEMPT_INPUT_INVALID',
   'MODEL_ATTEMPT_AUTHORITY_STALE',
   'MODEL_ATTEMPT_IDENTITY_CONFLICT',
   'MODEL_ATTEMPT_BUDGET_EXPIRED',
   'MODEL_ATTEMPT_CONFLICT',
   'MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN',
   'MODEL_ATTEMPT_READBACK_CORRUPT',
   'MODEL_GATEWAY_DEPLOYMENT_MISSING',
   'MODEL_GATEWAY_PROMPT_COMPILE_FAILED',
   'MODEL_GATEWAY_REQUEST_INVALID',
   'MODEL_GATEWAY_CREDENTIAL_INVALID',
   'MODEL_GATEWAY_TRANSPORT_FAILED',
   'MODEL_GATEWAY_AUTH_REJECTED',
   'MODEL_GATEWAY_LIMIT_REJECTED',
   'MODEL_GATEWAY_POLICY_REJECTED',
   'MODEL_GATEWAY_UPSTREAM_REJECTED',
   'MODEL_GATEWAY_RESPONSE_INVALID',
   'MODEL_GATEWAY_OUTPUT_TRUNCATED',
   'MODEL_GATEWAY_OUTPUT_PERSIST_FAILED',
   'MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED',
   'MODEL_GATEWAY_PRICING_FAILED'
 )
 AND json_extract(NEW.first_failure_json,'$.phase') IN ('PREPARATION','STAGE','RECOVERY')
 AND json_type(NEW.first_failure_json,'$.retryable') IN ('true','false')
 AND (json_extract(NEW.first_failure_json,'$.phase')='PREPARATION' AND json_type(NEW.first_failure_json,'$.stage') IS NULL
   OR json_extract(NEW.first_failure_json,'$.phase') IN ('STAGE','RECOVERY') AND json_extract(NEW.first_failure_json,'$.stage') IN (
   'FREEZE_PROTOCOL_AND_SCOPE',
   'ORIENT',
   'INTERPRET',
   'COMPILE_OBLIGATIONS',
   'PLAN',
   'RETRIEVE_BRANCHES',
   'ACQUIRE_AND_CAPTURE',
   'READ_AND_EXTRACT',
   'ANALYZE_BRANCHES',
   'COUNTER_SEARCH',
   'RECONCILE',
   'FREEZE_EVIDENCE',
   'SYNTHESIZE',
   'VERIFY',
   'AUDIT_CLAIMS',
   'RESOLVE_CITATIONS',
   'CALCULATE_COVERAGE',
   'MATERIALIZE'
 ))
 AND (json_extract(NEW.first_failure_json,'$.retryable')=0 OR
   json_extract(NEW.first_failure_json,'$.phase')='PREPARATION' AND json_extract(NEW.first_failure_json,'$.code')='WORKFLOW_STORAGE_UNAVAILABLE')),0)<>1 THEN RAISE(ABORT,'WORKFLOW_CONFLICT') END;
 SELECT CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.first_failure_json) WHERE key NOT IN ('code','phase','stage','retryable'))
   OR (SELECT COUNT(*) FROM json_each(NEW.first_failure_json)) <> CASE json_extract(NEW.first_failure_json,'$.phase') WHEN 'PREPARATION' THEN 3 ELSE 4 END
   THEN RAISE(ABORT,'WORKFLOW_CONFLICT') END; SELECT CASE WHEN json_extract(NEW.first_failure_json,'$.phase') NOT IN ('STAGE','RECOVERY')
   OR json_extract(NEW.first_failure_json,'$.stage') IS NOT json_extract(NEW.request_json,'$.stage')
   THEN RAISE(ABORT,'WORKFLOW_CONFLICT') END;
END;

DROP TRIGGER research_workflow_attempt_transition;
CREATE TRIGGER research_workflow_attempt_transition BEFORE UPDATE ON research_workflow_attempt
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.stage_index IS NOT OLD.stage_index
 OR NEW.request_json IS NOT OLD.request_json OR NEW.request_sha256 IS NOT OLD.request_sha256
 OR NEW.attempt_ref IS NOT OLD.attempt_ref OR NEW.expected_revision IS NOT OLD.expected_revision
 OR NEW.budget_receipt_ref IS NOT OLD.budget_receipt_ref OR NEW.budget_expires_at_ms IS NOT OLD.budget_expires_at_ms
 OR NEW.created_at IS NOT OLD.created_at
 OR NOT (
   (((OLD.state = 'STARTED' AND NEW.state = 'OUTPUT_RECORDED' AND NEW.output_json IS NOT NULL)
     OR (OLD.state = 'OUTPUT_RECORDED' AND NEW.state = 'COMMITTED' AND NEW.output_json IS OLD.output_json
       AND EXISTS (SELECT 1 FROM research_workflow_checkpoint c WHERE c.operation_id = NEW.operation_id
         AND c.stage_index = NEW.stage_index AND c.request_sha256 = NEW.request_sha256)))
     AND NEW.first_failure_json IS OLD.first_failure_json)
   OR (NEW.state IS OLD.state AND NEW.output_json IS OLD.output_json
     AND NEW.first_failure_json IS NOT NULL
     AND (OLD.first_failure_json IS NULL OR NEW.first_failure_json IS OLD.first_failure_json))
 )
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_CONFLICT'); END;

DROP TRIGGER research_workflow_output_authority;
CREATE TRIGGER research_workflow_output_authority BEFORE UPDATE ON research_workflow_attempt
WHEN NEW.state = 'OUTPUT_RECORDED' AND (NEW.state IS NOT OLD.state OR NEW.output_json IS NOT OLD.output_json) AND (
 (NEW.budget_expires_at_ms <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
   AND NOT EXISTS (
     SELECT 1 FROM research_workflow_recovery_authorized a
     WHERE a.operation_id=NEW.operation_id AND a.stage_index=NEW.stage_index
   ))
 OR NOT EXISTS (SELECT 1 FROM research_workflow_current r WHERE r.operation_id = NEW.operation_id
   AND r.state = 'ACTIVE' AND r.next_stage_index = NEW.stage_index
   AND r.current_revision = NEW.expected_revision AND r.ledger_revision = NEW.expected_revision)
 OR json_extract(NEW.output_json, '$.object_ref') IS NOT ('workflow/' || NEW.request_sha256 || '/' || NEW.attempt_ref)
 OR json_extract(NEW.output_json, '$.byte_length') NOT BETWEEN 0 AND 8388608
 OR length(json_extract(NEW.output_json, '$.sha256')) IS NOT 64
 OR json_extract(NEW.output_json, '$.sha256') GLOB '*[^0-9a-f]*'
 OR json_extract(NEW.output_json, '$.residency.content_digest.digest') IS NOT json_extract(NEW.output_json, '$.sha256')
 OR json_extract(NEW.output_json, '$.residency.content_digest.algorithm') IS NOT 'sha256'
 OR json_extract(NEW.output_json, '$.residency.scope_domain_id') IS NOT json_extract(NEW.request_json, '$.input_manifest.residency.scope_domain_id')
 OR json_extract(NEW.output_json, '$.residency.access_domain_id') IS NOT json_extract(NEW.request_json, '$.input_manifest.residency.access_domain_id')
 OR json_extract(NEW.output_json, '$.residency.confidentiality_domain_id') IS NOT json_extract(NEW.request_json, '$.input_manifest.residency.confidentiality_domain_id')
 OR json_extract(NEW.output_json, '$.residency.encryption_key_domain_id') IS NOT json_extract(NEW.request_json, '$.input_manifest.residency.encryption_key_domain_id')
 OR json_extract(NEW.output_json, '$.residency.retention_domain_id') IS NOT json_extract(NEW.request_json, '$.input_manifest.residency.retention_domain_id')
 OR json_extract(NEW.output_json, '$.residency.erasure_domain_id') IS NOT json_extract(NEW.request_json, '$.input_manifest.residency.erasure_domain_id')
)
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTHORITY_STALE'); END;

INSERT INTO schema_state(key,value,updated_at)
VALUES ('research_failure_generation','research-failure-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
