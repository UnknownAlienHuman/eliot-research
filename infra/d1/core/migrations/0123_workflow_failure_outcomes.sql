-- Add bounded first-cause/consequence history beside the persisted V1 fields.
-- Existing rows and their legacy JSON bytes are intentionally not rewritten.
PRAGMA foreign_keys = ON;
ALTER TABLE research_workflow_run ADD COLUMN failure_history_json TEXT;
DROP TRIGGER IF EXISTS research_workflow_first_failure_json_shape;
CREATE TRIGGER research_workflow_first_failure_json_shape BEFORE UPDATE OF first_failure_json ON research_workflow_run
WHEN NEW.first_failure_json IS NOT NULL
BEGIN
 SELECT (CASE WHEN COALESCE((json_valid(NEW.first_failure_json) AND length(CAST(NEW.first_failure_json AS BLOB))<=1024
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
   'MODEL_GATEWAY_PRICING_FAILED',
   'MODEL_PROFILE_BINDING_INPUT_INVALID',
   'MODEL_PROFILE_BINDING_CONFIG_MISSING',
   'MODEL_PROFILE_BINDING_CONFIG_INVALID',
   'MODEL_PROFILE_BINDING_AUTHORITY_STALE',
   'MODEL_PROFILE_BINDING_DEPLOYMENT_MISSING',
   'MODEL_PROFILE_BINDING_DEPLOYMENT_MISMATCH',
   'MODEL_PROFILE_BINDING_EXPIRED',
   'REFERENCE_MANIFEST_INPUT_INVALID',
   'REFERENCE_MANIFEST_SCOPE_STALE',
   'REFERENCE_MANIFEST_EVIDENCE_INVALID',
   'REFERENCE_MANIFEST_POLICY_INVALID',
   'REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN',
   'EVIDENCE_INPUT_INVALID',
   'EVIDENCE_SCOPE_NOT_FOUND',
   'EVIDENCE_SCOPE_INVALIDATED',
   'EVIDENCE_SCOPE_EXPIRED',
   'EVIDENCE_AUTHORIZATION_DENIED',
   'EVIDENCE_SOURCE_NOT_FOUND',
   'EVIDENCE_SOURCE_NOT_LIVE',
   'EVIDENCE_OWNER_GENERATION_MISMATCH',
   'EVIDENCE_SCOPE_MISMATCH',
   'EVIDENCE_LOCATOR_NOT_RESOLVABLE',
   'EVIDENCE_PRECISION_UNSUPPORTED',
   'EVIDENCE_OBJECT_NOT_FOUND',
   'EVIDENCE_OBJECT_INTEGRITY',
   'EVIDENCE_RANGE_INVALID',
   'EVIDENCE_HANDLE_NOT_FOUND',
   'EVIDENCE_HANDLE_NOT_LIVE',
   'EVIDENCE_IDENTITY_CONFLICT',
   'EVIDENCE_SETTLEMENT_UNCERTAIN',
   'CITATION_SET_INVALID',
   'EVIDENCE_FREEZE_INPUT_INVALID',
   'EVIDENCE_FREEZE_SCOPE_STALE',
   'EVIDENCE_FREEZE_EVIDENCE_INVALID',
   'EVIDENCE_FREEZE_AUTHORITY_INVALID',
   'EVIDENCE_FREEZE_SETTLEMENT_UNCERTAIN'
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
   json_extract(NEW.first_failure_json,'$.phase')='PREPARATION' AND json_extract(NEW.first_failure_json,'$.code')='WORKFLOW_STORAGE_UNAVAILABLE')),0)<>1 THEN RAISE(ABORT,'WORKFLOW_CONFLICT') END);
 SELECT (CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.first_failure_json) WHERE key NOT IN ('code','phase','stage','retryable'))
   OR (SELECT COUNT(*) FROM json_each(NEW.first_failure_json)) <> (CASE json_extract(NEW.first_failure_json,'$.phase') WHEN 'PREPARATION' THEN 3 ELSE 4 END)
   THEN RAISE(ABORT,'WORKFLOW_CONFLICT') END);
END;

DROP TRIGGER IF EXISTS research_workflow_latest_failure_json_shape;
CREATE TRIGGER research_workflow_latest_failure_json_shape BEFORE UPDATE OF latest_failure_json ON research_workflow_run
WHEN NEW.latest_failure_json IS NOT NULL
BEGIN
 SELECT (CASE WHEN COALESCE((json_valid(NEW.latest_failure_json) AND length(CAST(NEW.latest_failure_json AS BLOB))<=1024
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
   'MODEL_GATEWAY_PRICING_FAILED',
   'MODEL_PROFILE_BINDING_INPUT_INVALID',
   'MODEL_PROFILE_BINDING_CONFIG_MISSING',
   'MODEL_PROFILE_BINDING_CONFIG_INVALID',
   'MODEL_PROFILE_BINDING_AUTHORITY_STALE',
   'MODEL_PROFILE_BINDING_DEPLOYMENT_MISSING',
   'MODEL_PROFILE_BINDING_DEPLOYMENT_MISMATCH',
   'MODEL_PROFILE_BINDING_EXPIRED',
   'REFERENCE_MANIFEST_INPUT_INVALID',
   'REFERENCE_MANIFEST_SCOPE_STALE',
   'REFERENCE_MANIFEST_EVIDENCE_INVALID',
   'REFERENCE_MANIFEST_POLICY_INVALID',
   'REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN',
   'EVIDENCE_INPUT_INVALID',
   'EVIDENCE_SCOPE_NOT_FOUND',
   'EVIDENCE_SCOPE_INVALIDATED',
   'EVIDENCE_SCOPE_EXPIRED',
   'EVIDENCE_AUTHORIZATION_DENIED',
   'EVIDENCE_SOURCE_NOT_FOUND',
   'EVIDENCE_SOURCE_NOT_LIVE',
   'EVIDENCE_OWNER_GENERATION_MISMATCH',
   'EVIDENCE_SCOPE_MISMATCH',
   'EVIDENCE_LOCATOR_NOT_RESOLVABLE',
   'EVIDENCE_PRECISION_UNSUPPORTED',
   'EVIDENCE_OBJECT_NOT_FOUND',
   'EVIDENCE_OBJECT_INTEGRITY',
   'EVIDENCE_RANGE_INVALID',
   'EVIDENCE_HANDLE_NOT_FOUND',
   'EVIDENCE_HANDLE_NOT_LIVE',
   'EVIDENCE_IDENTITY_CONFLICT',
   'EVIDENCE_SETTLEMENT_UNCERTAIN',
   'CITATION_SET_INVALID',
   'EVIDENCE_FREEZE_INPUT_INVALID',
   'EVIDENCE_FREEZE_SCOPE_STALE',
   'EVIDENCE_FREEZE_EVIDENCE_INVALID',
   'EVIDENCE_FREEZE_AUTHORITY_INVALID',
   'EVIDENCE_FREEZE_SETTLEMENT_UNCERTAIN'
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
   json_extract(NEW.latest_failure_json,'$.phase')='PREPARATION' AND json_extract(NEW.latest_failure_json,'$.code')='WORKFLOW_STORAGE_UNAVAILABLE')),0)<>1 THEN RAISE(ABORT,'WORKFLOW_CONFLICT') END);
 SELECT (CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.latest_failure_json) WHERE key NOT IN ('code','phase','stage','retryable'))
   OR (SELECT COUNT(*) FROM json_each(NEW.latest_failure_json)) <> (CASE json_extract(NEW.latest_failure_json,'$.phase') WHEN 'PREPARATION' THEN 3 ELSE 4 END)
   THEN RAISE(ABORT,'WORKFLOW_CONFLICT') END);
END;

DROP TRIGGER IF EXISTS research_workflow_attempt_failure_shape;
CREATE TRIGGER research_workflow_attempt_failure_shape BEFORE UPDATE OF first_failure_json ON research_workflow_attempt
WHEN NEW.first_failure_json IS NOT NULL
BEGIN
 SELECT (CASE WHEN COALESCE((json_valid(NEW.first_failure_json) AND length(CAST(NEW.first_failure_json AS BLOB))<=1024
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
   'MODEL_GATEWAY_PRICING_FAILED',
   'MODEL_PROFILE_BINDING_INPUT_INVALID',
   'MODEL_PROFILE_BINDING_CONFIG_MISSING',
   'MODEL_PROFILE_BINDING_CONFIG_INVALID',
   'MODEL_PROFILE_BINDING_AUTHORITY_STALE',
   'MODEL_PROFILE_BINDING_DEPLOYMENT_MISSING',
   'MODEL_PROFILE_BINDING_DEPLOYMENT_MISMATCH',
   'MODEL_PROFILE_BINDING_EXPIRED',
   'REFERENCE_MANIFEST_INPUT_INVALID',
   'REFERENCE_MANIFEST_SCOPE_STALE',
   'REFERENCE_MANIFEST_EVIDENCE_INVALID',
   'REFERENCE_MANIFEST_POLICY_INVALID',
   'REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN',
   'EVIDENCE_INPUT_INVALID',
   'EVIDENCE_SCOPE_NOT_FOUND',
   'EVIDENCE_SCOPE_INVALIDATED',
   'EVIDENCE_SCOPE_EXPIRED',
   'EVIDENCE_AUTHORIZATION_DENIED',
   'EVIDENCE_SOURCE_NOT_FOUND',
   'EVIDENCE_SOURCE_NOT_LIVE',
   'EVIDENCE_OWNER_GENERATION_MISMATCH',
   'EVIDENCE_SCOPE_MISMATCH',
   'EVIDENCE_LOCATOR_NOT_RESOLVABLE',
   'EVIDENCE_PRECISION_UNSUPPORTED',
   'EVIDENCE_OBJECT_NOT_FOUND',
   'EVIDENCE_OBJECT_INTEGRITY',
   'EVIDENCE_RANGE_INVALID',
   'EVIDENCE_HANDLE_NOT_FOUND',
   'EVIDENCE_HANDLE_NOT_LIVE',
   'EVIDENCE_IDENTITY_CONFLICT',
   'EVIDENCE_SETTLEMENT_UNCERTAIN',
   'CITATION_SET_INVALID',
   'EVIDENCE_FREEZE_INPUT_INVALID',
   'EVIDENCE_FREEZE_SCOPE_STALE',
   'EVIDENCE_FREEZE_EVIDENCE_INVALID',
   'EVIDENCE_FREEZE_AUTHORITY_INVALID',
   'EVIDENCE_FREEZE_SETTLEMENT_UNCERTAIN'
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
   json_extract(NEW.first_failure_json,'$.phase')='PREPARATION' AND json_extract(NEW.first_failure_json,'$.code')='WORKFLOW_STORAGE_UNAVAILABLE')),0)<>1 THEN RAISE(ABORT,'WORKFLOW_CONFLICT') END);
 SELECT (CASE WHEN EXISTS (SELECT 1 FROM json_each(NEW.first_failure_json) WHERE key NOT IN ('code','phase','stage','retryable'))
   OR (SELECT COUNT(*) FROM json_each(NEW.first_failure_json)) <> (CASE json_extract(NEW.first_failure_json,'$.phase') WHEN 'PREPARATION' THEN 3 ELSE 4 END)
   THEN RAISE(ABORT,'WORKFLOW_CONFLICT') END); SELECT (CASE WHEN json_extract(NEW.first_failure_json,'$.phase') NOT IN ('STAGE','RECOVERY')
   OR json_extract(NEW.first_failure_json,'$.stage') IS NOT json_extract(NEW.request_json,'$.stage')
   THEN RAISE(ABORT,'WORKFLOW_CONFLICT') END);
END;

CREATE TRIGGER research_workflow_failure_history_shape
BEFORE UPDATE OF failure_history_json ON research_workflow_run
WHEN NEW.failure_history_json IS NOT NULL
BEGIN
  SELECT CASE WHEN COALESCE((
    json_valid(NEW.failure_history_json)
    AND length(CAST(NEW.failure_history_json AS BLOB)) <= 24576
    AND json_type(NEW.failure_history_json) = 'object'
    AND json_extract(NEW.failure_history_json, '$.protocol') = 'eliotr.workflow-failure-history.v1'
    AND json_type(NEW.failure_history_json, '$.first_cause') IN ('object', 'null')
    AND json_type(NEW.failure_history_json, '$.consequences') = 'array'
    AND json_array_length(NEW.failure_history_json, '$.consequences') <= 16
    AND (SELECT COUNT(*) FROM json_each(NEW.failure_history_json)) = 3
    AND NOT EXISTS (
      SELECT 1 FROM json_each(NEW.failure_history_json)
      WHERE key NOT IN ('protocol', 'first_cause', 'consequences')
    )
    AND (json_type(NEW.failure_history_json, '$.first_cause') <> 'null'
      OR json_array_length(NEW.failure_history_json, '$.consequences') = 0)
  ), 0) <> 1 THEN RAISE(ABORT, 'WORKFLOW_CONFLICT') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM (
      SELECT json_extract(NEW.failure_history_json, '$.first_cause') AS value
      WHERE json_type(NEW.failure_history_json, '$.first_cause') = 'object'
      UNION ALL
      SELECT item.value AS value
      FROM json_each(NEW.failure_history_json, '$.consequences') AS item
    ) AS outcome
    WHERE COALESCE((
      json_valid(outcome.value)
      AND json_type(outcome.value) = 'object'
      AND json_extract(outcome.value, '$.protocol') = 'eliotr.workflow-failure-outcome.v1'
      AND json_extract(outcome.value, '$.code') IN (
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
    'MODEL_GATEWAY_PRICING_FAILED',
    'MODEL_PROFILE_BINDING_INPUT_INVALID',
    'MODEL_PROFILE_BINDING_CONFIG_MISSING',
    'MODEL_PROFILE_BINDING_CONFIG_INVALID',
    'MODEL_PROFILE_BINDING_AUTHORITY_STALE',
    'MODEL_PROFILE_BINDING_DEPLOYMENT_MISSING',
    'MODEL_PROFILE_BINDING_DEPLOYMENT_MISMATCH',
    'MODEL_PROFILE_BINDING_EXPIRED',
    'REFERENCE_MANIFEST_INPUT_INVALID',
    'REFERENCE_MANIFEST_SCOPE_STALE',
    'REFERENCE_MANIFEST_EVIDENCE_INVALID',
    'REFERENCE_MANIFEST_POLICY_INVALID',
    'REFERENCE_MANIFEST_PERSISTENCE_UNCERTAIN',
    'EVIDENCE_INPUT_INVALID',
    'EVIDENCE_SCOPE_NOT_FOUND',
    'EVIDENCE_SCOPE_INVALIDATED',
    'EVIDENCE_SCOPE_EXPIRED',
    'EVIDENCE_AUTHORIZATION_DENIED',
    'EVIDENCE_SOURCE_NOT_FOUND',
    'EVIDENCE_SOURCE_NOT_LIVE',
    'EVIDENCE_OWNER_GENERATION_MISMATCH',
    'EVIDENCE_SCOPE_MISMATCH',
    'EVIDENCE_LOCATOR_NOT_RESOLVABLE',
    'EVIDENCE_PRECISION_UNSUPPORTED',
    'EVIDENCE_OBJECT_NOT_FOUND',
    'EVIDENCE_OBJECT_INTEGRITY',
    'EVIDENCE_RANGE_INVALID',
    'EVIDENCE_HANDLE_NOT_FOUND',
    'EVIDENCE_HANDLE_NOT_LIVE',
    'EVIDENCE_IDENTITY_CONFLICT',
    'EVIDENCE_SETTLEMENT_UNCERTAIN',
    'CITATION_SET_INVALID',
    'EVIDENCE_FREEZE_INPUT_INVALID',
    'EVIDENCE_FREEZE_SCOPE_STALE',
    'EVIDENCE_FREEZE_EVIDENCE_INVALID',
    'EVIDENCE_FREEZE_AUTHORITY_INVALID',
    'EVIDENCE_FREEZE_SETTLEMENT_UNCERTAIN'
      )
      AND json_extract(outcome.value, '$.phase') IN ('PREPARATION', 'STAGE', 'RECOVERY')
      AND json_type(outcome.value, '$.retryable') IN ('true', 'false')
      AND json_extract(outcome.value, '$.dispatch_state') IN ('NOT_STARTED', 'OUTCOME_UNKNOWN', 'RESPONSE_RECEIVED')
      AND json_extract(outcome.value, '$.references_intact') IN ('INTACT', 'UNKNOWN')
      AND json_extract(outcome.value, '$.recovery_action') IN ('NONE', 'READBACK', 'RECONCILE')
      AND (
        (json_extract(outcome.value, '$.phase') = 'PREPARATION' AND json_type(outcome.value, '$.stage') IS NULL)
        OR (json_extract(outcome.value, '$.phase') IN ('STAGE', 'RECOVERY')
          AND json_extract(outcome.value, '$.stage') IN (
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
      )
      AND (
        json_extract(outcome.value, '$.dispatch_state') <> 'OUTCOME_UNKNOWN'
        OR (json_extract(outcome.value, '$.references_intact') = 'UNKNOWN'
          AND json_extract(outcome.value, '$.recovery_action') <> 'NONE')
      )
      AND (SELECT COUNT(*) FROM json_each(outcome.value)) =
        CASE json_extract(outcome.value, '$.phase') WHEN 'PREPARATION' THEN 7 ELSE 8 END
      AND NOT EXISTS (
        SELECT 1 FROM json_each(outcome.value)
        WHERE key NOT IN ('protocol', 'code', 'phase', 'stage', 'retryable',
          'dispatch_state', 'references_intact', 'recovery_action')
      )
    ), 0) <> 1
  ) THEN RAISE(ABORT, 'WORKFLOW_CONFLICT') END;
END;

CREATE TRIGGER research_workflow_failure_history_alignment
BEFORE UPDATE OF failure_history_json, first_failure_json, latest_failure_json ON research_workflow_run
WHEN NEW.failure_history_json IS NOT NULL
BEGIN
  SELECT CASE WHEN
    (json_type(NEW.failure_history_json, '$.first_cause') = 'null'
      AND (NEW.first_failure_json IS NOT NULL OR NEW.latest_failure_json IS NOT NULL))
    OR
    (json_type(NEW.failure_history_json, '$.first_cause') = 'object'
      AND (
        NEW.first_failure_json IS NULL OR NEW.latest_failure_json IS NULL
        OR json_extract(NEW.first_failure_json, '$.code') IS NOT json_extract(NEW.failure_history_json, '$.first_cause.code')
        OR json_extract(NEW.first_failure_json, '$.phase') IS NOT json_extract(NEW.failure_history_json, '$.first_cause.phase')
        OR json_extract(NEW.first_failure_json, '$.stage') IS NOT json_extract(NEW.failure_history_json, '$.first_cause.stage')
        OR json_extract(NEW.first_failure_json, '$.retryable') IS NOT CASE
          WHEN json_extract(NEW.failure_history_json, '$.first_cause.retryable') = 1
            AND json_extract(NEW.failure_history_json, '$.first_cause.phase') = 'PREPARATION'
            AND json_extract(NEW.failure_history_json, '$.first_cause.code') = 'WORKFLOW_STORAGE_UNAVAILABLE'
          THEN 1 ELSE 0 END
        OR json_extract(NEW.latest_failure_json, '$.code') IS NOT COALESCE(
          json_extract(NEW.failure_history_json, '$.consequences[#-1].code'),
          json_extract(NEW.failure_history_json, '$.first_cause.code'))
        OR json_extract(NEW.latest_failure_json, '$.phase') IS NOT COALESCE(
          json_extract(NEW.failure_history_json, '$.consequences[#-1].phase'),
          json_extract(NEW.failure_history_json, '$.first_cause.phase'))
        OR json_extract(NEW.latest_failure_json, '$.stage') IS NOT COALESCE(
          json_extract(NEW.failure_history_json, '$.consequences[#-1].stage'),
          json_extract(NEW.failure_history_json, '$.first_cause.stage'))
        OR json_extract(NEW.latest_failure_json, '$.retryable') IS NOT CASE
          WHEN COALESCE(
            json_extract(NEW.failure_history_json, '$.consequences[#-1].retryable'),
            json_extract(NEW.failure_history_json, '$.first_cause.retryable')) = 1
            AND COALESCE(
              json_extract(NEW.failure_history_json, '$.consequences[#-1].phase'),
              json_extract(NEW.failure_history_json, '$.first_cause.phase')) = 'PREPARATION'
            AND COALESCE(
              json_extract(NEW.failure_history_json, '$.consequences[#-1].code'),
              json_extract(NEW.failure_history_json, '$.first_cause.code')) = 'WORKFLOW_STORAGE_UNAVAILABLE'
          THEN 1 ELSE 0 END
      ))
  THEN RAISE(ABORT, 'WORKFLOW_CONFLICT') END;
END;

CREATE TRIGGER research_workflow_failure_history_append_only
BEFORE UPDATE OF failure_history_json ON research_workflow_run
WHEN OLD.failure_history_json IS NOT NULL
BEGIN
  SELECT CASE WHEN NEW.failure_history_json IS NULL OR NOT (
    json(NEW.failure_history_json) = json(OLD.failure_history_json)
    OR (
      json_extract(NEW.failure_history_json, '$.first_cause') IS
        json_extract(OLD.failure_history_json, '$.first_cause')
      AND json_array_length(NEW.failure_history_json, '$.consequences') =
        json_array_length(OLD.failure_history_json, '$.consequences') + 1
      AND json(json_remove(NEW.failure_history_json, '$.consequences[#-1]')) =
        json(OLD.failure_history_json)
    )
  ) THEN RAISE(ABORT, 'WORKFLOW_CONFLICT') END;
END;
