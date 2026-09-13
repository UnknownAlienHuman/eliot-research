-- ER-09 W3: immutable server-authorized model spend admission.
-- The admission is created from an explicit trusted decision before the W3
-- reservation exists.  W2 currentness, scope and route checks happen in this
-- transaction; the application performs the matching W3 readback later.
PRAGMA foreign_keys = ON;

CREATE TABLE research_model_spend_admission (
  authorization_ref TEXT NOT NULL UNIQUE CHECK(length(authorization_ref) BETWEEN 1 AND 256),
  -- operation_id is the intended W3 model operation. W2 has its own
  -- workflow_operation_id because preparation runs before W3 reserve.
  operation_id TEXT NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 128),
  workflow_operation_id TEXT NOT NULL CHECK(length(workflow_operation_id) BETWEEN 1 AND 128),
  stage_index INTEGER NOT NULL CHECK(stage_index IN (12, 13, 14)),
  stage_attempt_ref TEXT NOT NULL CHECK(length(stage_attempt_ref) BETWEEN 1 AND 128),
  stage_request_sha256 TEXT NOT NULL CHECK(
    length(stage_request_sha256) = 64 AND stage_request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  stage_request_json TEXT NOT NULL CHECK(
    json_valid(stage_request_json) AND length(CAST(stage_request_json AS BLOB)) <= 65536
  ),
  workflow_budget_receipt_ref TEXT NOT NULL CHECK(length(workflow_budget_receipt_ref) BETWEEN 1 AND 256),
  intent_id TEXT NOT NULL CHECK(length(intent_id) BETWEEN 1 AND 256),
  intent_revision INTEGER NOT NULL CHECK(intent_revision > 0),
  intent_json TEXT NOT NULL CHECK(
    json_valid(intent_json) AND length(CAST(intent_json AS BLOB)) <= 65536
  ),
  reservation_id TEXT NOT NULL CHECK(length(reservation_id) BETWEEN 1 AND 256),
  quote_ref TEXT NOT NULL CHECK(length(quote_ref) BETWEEN 1 AND 256),
  quote_json TEXT NOT NULL CHECK(
    json_valid(quote_json) AND length(CAST(quote_json AS BLOB)) <= 65536
  ),
  authority_json TEXT NOT NULL CHECK(
    json_valid(authority_json) AND length(CAST(authority_json AS BLOB)) <= 65536
  ),
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  client_class TEXT NOT NULL CHECK(client_class IN (
    'owner_pwa','named_api_client','trusted_agent','federation_client'
  )),
  credential_generation TEXT NOT NULL CHECK(length(credential_generation) BETWEEN 1 AND 256),
  deployment_generation TEXT NOT NULL CHECK(length(deployment_generation) BETWEEN 1 AND 256),
  policy_decision_ref TEXT NOT NULL CHECK(length(policy_decision_ref) BETWEEN 1 AND 256),
  policy_generation TEXT NOT NULL CHECK(length(policy_generation) BETWEEN 1 AND 256),
  currentness_digest TEXT NOT NULL CHECK(
    length(currentness_digest) = 64 AND currentness_digest NOT GLOB '*[^0-9a-f]*'
  ),
  scope_snapshot_id TEXT NOT NULL CHECK(length(scope_snapshot_id) BETWEEN 1 AND 256),
  scope_snapshot_revision INTEGER NOT NULL CHECK(scope_snapshot_revision > 0),
  workflow_authorization_receipt_ref TEXT NOT NULL CHECK(length(workflow_authorization_receipt_ref) BETWEEN 1 AND 256),
  route_ref TEXT NOT NULL CHECK(length(route_ref) BETWEEN 1 AND 256),
  expected_deployment_json TEXT NOT NULL CHECK(
    json_valid(expected_deployment_json) AND length(CAST(expected_deployment_json AS BLOB)) <= 65536
  ),
  approval_json TEXT NOT NULL CHECK(
    json_valid(approval_json) AND length(CAST(approval_json AS BLOB)) <= 65536
  ),
  admission_revision INTEGER NOT NULL CHECK(admission_revision = 1),
  admission_sha256 TEXT NOT NULL CHECK(
    length(admission_sha256) = 64 AND admission_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  decision_digest TEXT NOT NULL CHECK(
    length(decision_digest) = 64 AND decision_digest NOT GLOB '*[^0-9a-f]*'
  ),
  max_input_bytes INTEGER NOT NULL CHECK(max_input_bytes BETWEEN 1 AND 262144),
  max_output_bytes INTEGER NOT NULL CHECK(max_output_bytes BETWEEN 1 AND 262144),
  expires_at TEXT NOT NULL CHECK(
    expires_at GLOB '????-??-??T??:??:??.???Z'
    AND julianday(expires_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at
  ),
  created_at TEXT NOT NULL CHECK(
    created_at GLOB '????-??-??T??:??:??.???Z'
    AND julianday(created_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at
  ),
  PRIMARY KEY(operation_id, stage_index),
  FOREIGN KEY(workflow_operation_id, stage_index)
    REFERENCES research_workflow_attempt(operation_id, stage_index),
  FOREIGN KEY(stage_attempt_ref)
    REFERENCES research_workflow_attempt(attempt_ref),
  FOREIGN KEY(scope_snapshot_id, scope_snapshot_revision)
    REFERENCES scope_snapshot(snapshot_id, revision),
  CHECK(julianday(expires_at) > julianday(created_at)),
  CHECK(json_type(quote_json, '$.expires_at') = 'text'
    AND julianday(json_extract(quote_json, '$.expires_at')) IS NOT NULL
    AND julianday(expires_at) <= julianday(json_extract(quote_json, '$.expires_at'))),
  CHECK(json_type(authority_json, '$.expires_at') = 'text'
    AND julianday(json_extract(authority_json, '$.expires_at')) IS NOT NULL
    AND julianday(expires_at) <= julianday(json_extract(authority_json, '$.expires_at')))
) STRICT;

CREATE INDEX research_model_spend_admission_lookup_idx
  ON research_model_spend_admission(
    principal_ref, operation_id, stage_attempt_ref, stage_request_sha256
  );

-- Every admission is an explicit approved decision.  The application binds
-- decision_digest to these canonical bytes before this trigger is reached.
CREATE TRIGGER research_model_spend_admission_shape_guard
BEFORE INSERT ON research_model_spend_admission
BEGIN
  SELECT RAISE(ABORT, 'MODEL_SPEND_ADMISSION_INPUT_INVALID')
  WHERE json_extract(NEW.intent_json, '$.intent_ref.id') IS NOT NEW.intent_id
    OR json_extract(NEW.intent_json, '$.intent_ref.revision') IS NOT NEW.intent_revision
    OR json_extract(NEW.intent_json, '$.principal_ref') IS NOT NEW.principal_ref
    OR json_extract(NEW.intent_json, '$.policy_decision_ref') IS NOT NEW.policy_decision_ref
    OR json_extract(NEW.intent_json, '$.budget_reservation_ref') IS NOT NEW.reservation_id
    OR json_extract(NEW.quote_json, '$.quote_ref') IS NOT NEW.quote_ref
    OR json_extract(NEW.quote_json, '$.reservation_id') IS NOT NEW.reservation_id
    OR json_extract(NEW.quote_json, '$.operation_kind') IS NOT json_extract(NEW.intent_json, '$.operation_kind')
    OR json_extract(NEW.authority_json, '$.principal_ref') IS NOT NEW.principal_ref
    OR json_extract(NEW.authority_json, '$.client_class') IS NOT NEW.client_class
    OR json_extract(NEW.authority_json, '$.credential_generation') IS NOT NEW.credential_generation
    OR json_extract(NEW.authority_json, '$.deployment_generation') IS NOT NEW.deployment_generation
    OR json_extract(NEW.authority_json, '$.policy_decision_ref') IS NOT NEW.policy_decision_ref
    OR json_extract(NEW.authority_json, '$.policy_generation') IS NOT NEW.policy_generation
    OR json_extract(NEW.authority_json, '$.currentness_digest') IS NOT NEW.currentness_digest
    OR json_extract(NEW.authority_json, '$.scope_snapshot_ref.id') IS NOT NEW.scope_snapshot_id
    OR json_extract(NEW.authority_json, '$.scope_snapshot_ref.revision') IS NOT NEW.scope_snapshot_revision
    OR json_extract(NEW.expected_deployment_json, '$.route_ref') IS NOT NEW.route_ref
    OR json_extract(NEW.approval_json, '$.protocol') IS NOT 'eliotr.research-model-spend-approval.v1'
    OR json_extract(NEW.approval_json, '$.approved') IS NOT 1
    OR json_extract(NEW.approval_json, '$.authorization_ref') IS NOT NEW.authorization_ref
    OR json_extract(NEW.approval_json, '$.decision_digest') IS NOT NEW.decision_digest
    OR json_extract(NEW.approval_json, '$.policy_decision_ref') IS NOT NEW.policy_decision_ref
    OR json_extract(NEW.approval_json, '$.policy_generation') IS NOT NEW.policy_generation
    OR json_extract(NEW.approval_json, '$.currentness_digest') IS NOT NEW.currentness_digest
    OR json_extract(NEW.approval_json, '$.expires_at') IS NOT NEW.expires_at
    OR json_extract(NEW.approval_json, '$.expected_deployment.route_ref') IS NOT json_extract(NEW.expected_deployment_json, '$.route_ref')
    OR json_extract(NEW.approval_json, '$.expected_deployment.route_version') IS NOT json_extract(NEW.expected_deployment_json, '$.route_version')
    OR json_extract(NEW.approval_json, '$.expected_deployment.prompt_generation') IS NOT json_extract(NEW.expected_deployment_json, '$.prompt_generation')
    OR json_extract(NEW.approval_json, '$.expected_deployment.schema_generation') IS NOT json_extract(NEW.expected_deployment_json, '$.schema_generation')
    OR json_extract(NEW.approval_json, '$.expected_deployment.parameters_digest') IS NOT json_extract(NEW.expected_deployment_json, '$.parameters_digest')
    OR json_extract(NEW.approval_json, '$.expected_deployment.pricing_snapshot_ref') IS NOT json_extract(NEW.expected_deployment_json, '$.pricing_snapshot_ref');
END;

-- Admission is allowed before W3 reserve/intent rows exist, but only for the
-- exact STARTED W2 stage and its current owner grant.  The current view also
-- enforces current policy, deployment, scope, purge and research allowed_use.
CREATE TRIGGER research_model_spend_admission_w2_guard
BEFORE INSERT ON research_model_spend_admission
BEGIN
  SELECT RAISE(ABORT, 'MODEL_SPEND_ADMISSION_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1
    FROM research_workflow_current r
    JOIN research_workflow_attempt a
      ON a.operation_id = r.operation_id AND a.stage_index = NEW.stage_index
    JOIN scope_access_grant g
      ON g.snapshot_id = r.scope_snapshot_id
      AND g.snapshot_revision = r.scope_snapshot_revision
      AND g.principal_ref = r.principal_ref
    WHERE r.operation_id = NEW.workflow_operation_id
      AND r.state = 'ACTIVE'
      AND r.next_stage_index = NEW.stage_index
      AND r.current_revision = a.expected_revision
      AND r.ledger_revision = a.expected_revision
      AND a.state = 'STARTED'
      AND a.output_json IS NULL
      AND a.attempt_ref = NEW.stage_attempt_ref
      AND a.request_sha256 = NEW.stage_request_sha256
      AND a.budget_receipt_ref = NEW.workflow_budget_receipt_ref
      AND json_extract(a.request_json, '$.protocol') IS 'eliotr.workflow-stage.v1'
      AND json_extract(a.request_json, '$.operation_id') IS r.operation_id
      AND json_extract(a.request_json, '$.stage') IS CASE NEW.stage_index
        WHEN 12 THEN 'SYNTHESIZE' WHEN 13 THEN 'VERIFY' WHEN 14 THEN 'AUDIT_CLAIMS' END
      AND json_extract(a.request_json, '$.investigation_ref.id') IS r.investigation_id
      AND json_extract(a.request_json, '$.investigation_ref.revision') IS r.current_revision
      AND json_extract(a.request_json, '$.idempotency_key') IS r.idempotency_key
      AND json_extract(a.request_json, '$.handler_generation') IS r.handler_generation
      AND r.principal_ref = NEW.principal_ref
      AND r.credential_generation = NEW.credential_generation
      AND r.deployment_generation = NEW.deployment_generation
      AND r.policy_generation = NEW.policy_generation
      AND r.scope_snapshot_id = NEW.scope_snapshot_id
      AND r.scope_snapshot_revision = NEW.scope_snapshot_revision
      AND r.authorization_receipt_ref = NEW.workflow_authorization_receipt_ref
      AND g.client_class = NEW.client_class
      AND g.credential_generation = NEW.credential_generation
      AND g.policy_authority_ref = r.policy_authority_ref
      AND g.authorization_receipt_ref = NEW.workflow_authorization_receipt_ref
      AND g.state = 'ACTIVE'
      AND julianday(g.expires_at) > julianday('now')
      AND json_type(g.allowed_use_json) = 'array'
      AND EXISTS (
        SELECT 1 FROM json_each(g.allowed_use_json) u
        WHERE u.type = 'text' AND u.value = 'research'
      )
  );
END;

-- Bind the six-field deployment to the active, qualified route candidate.  A
-- TEST/LIVE qualification tier decision remains an explicit server callback;
-- this SQL guard still rejects an inactive or expired candidate.
CREATE TRIGGER research_model_spend_admission_deployment_guard
BEFORE INSERT ON research_model_spend_admission
BEGIN
  SELECT RAISE(ABORT, 'MODEL_SPEND_ADMISSION_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1
    FROM dynamic_route_active_generation active
    JOIN dynamic_route_candidate candidate
      ON candidate.candidate_ref = active.candidate_ref
      AND candidate.candidate_sha256 = active.candidate_sha256
    WHERE active.route_ref = NEW.route_ref
      AND active.route_version = json_extract(NEW.expected_deployment_json, '$.route_version')
      AND json_extract(candidate.candidate_json, '$.deployment.route_ref') IS NEW.route_ref
      AND json_extract(candidate.candidate_json, '$.deployment.route_version') IS json_extract(NEW.expected_deployment_json, '$.route_version')
      AND json_extract(candidate.candidate_json, '$.deployment.prompt_generation') IS json_extract(NEW.expected_deployment_json, '$.prompt_generation')
      AND json_extract(candidate.candidate_json, '$.deployment.schema_generation') IS json_extract(NEW.expected_deployment_json, '$.schema_generation')
      AND json_extract(candidate.candidate_json, '$.deployment.parameters_digest') IS json_extract(NEW.expected_deployment_json, '$.parameters_digest')
      AND json_extract(candidate.candidate_json, '$.deployment.pricing_snapshot_ref') IS json_extract(NEW.expected_deployment_json, '$.pricing_snapshot_ref')
      AND json_extract(candidate.candidate_json, '$.qualification_expires_at') IS NOT NULL
      AND julianday(json_extract(candidate.candidate_json, '$.qualification_expires_at')) > julianday('now')
  );
END;

CREATE TRIGGER research_model_spend_admission_immutable
BEFORE UPDATE ON research_model_spend_admission
BEGIN
  SELECT RAISE(ABORT, 'MODEL_SPEND_ADMISSION_IMMUTABLE');
END;

CREATE TRIGGER research_model_spend_admission_no_delete
BEFORE DELETE ON research_model_spend_admission
BEGIN
  SELECT RAISE(ABORT, 'MODEL_SPEND_ADMISSION_IMMUTABLE');
END;

-- This additive storage/readback capability does not authorize a provider by
-- itself and does not promote the public Worker generation.
