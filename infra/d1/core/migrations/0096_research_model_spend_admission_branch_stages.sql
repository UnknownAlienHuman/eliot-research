-- S37 follow-up: admit branch stages 8/9 in research_model_spend_admission.
--
-- Defect repaired: migration 0046 constrained stage_index to (12, 13, 14), so
-- the role column added by 0095 for branch stages (8 = ANALYZE_BRANCHES,
-- 9 = COUNTER_SEARCH) could never be stored -- any stage 8/9 insert aborted
-- on the 0046 CHECK, and the w2 guard trigger only mapped stages 12/13/14.
-- The F2 durable role binding was dead at the DB layer.
--
-- This migration rebuilds the table (SQLite cannot ALTER a CHECK):
--   1. widen the stage_index CHECK to (8, 9, 12, 13, 14);
--   2. keep the 0095 role column and its CHECK verbatim (branch stages always
--      carry a role; every other stage never does), as the physical last
--      column so fresh and upgraded databases converge to identical schema;
--   3. copy every existing row verbatim, verified by a copy guard
--      (row count + EXCEPT in both directions) before the old table is
--      dropped -- any mismatch aborts the migration with canonical data
--      untouched;
--   4. extend the w2 guard stage-name CASE with 8 -> ANALYZE_BRANCHES and
--      9 -> COUNTER_SEARCH (mapping mirrors STAGES in
--      packages/cloudflare-research/src/research-model-spend-admission.ts);
--      shape, deployment, immutable and no-delete triggers are recreated
--      verbatim, as is the lookup index.
--
-- No stage 8/9 rows can predate this migration (0046 rejected them), so no
-- backfill is needed and the strict role CHECK is safe on copied rows.
-- Follows the rebuild precedents of 0019 (staging + rename/copy/drop,
-- PRAGMA foreign_keys OFF around the swap) and 0071 (copy guard).
-- Forward-only; D1 applies each migration as its own batch and rolls a
-- failed migration back. No explicit BEGIN/COMMIT: D1 rejects transaction
-- control inside migration SQL.
PRAGMA foreign_keys = OFF;

-- A previous raw-exec attempt must not leave the staging name behind.
DROP TABLE IF EXISTS _research_model_spend_admission_0095;

ALTER TABLE research_model_spend_admission
  RENAME TO _research_model_spend_admission_0095;

CREATE TABLE research_model_spend_admission (
  authorization_ref TEXT NOT NULL UNIQUE CHECK(length(authorization_ref) BETWEEN 1 AND 256),
  -- operation_id is the intended W3 model operation. W2 has its own
  -- workflow_operation_id because preparation runs before W3 reserve.
  operation_id TEXT NOT NULL CHECK(length(operation_id) BETWEEN 1 AND 128),
  workflow_operation_id TEXT NOT NULL CHECK(length(workflow_operation_id) BETWEEN 1 AND 128),
  stage_index INTEGER NOT NULL CHECK(stage_index IN (8, 9, 12, 13, 14)),
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
  -- S37 F2 (from 0095, verbatim): branch stages always carry the admitted
  -- role; every other stage never does.
  role TEXT CHECK (
    (stage_index IN (8, 9) AND role IS NOT NULL)
    OR (stage_index NOT IN (8, 9) AND role IS NULL)
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

INSERT INTO research_model_spend_admission (
  authorization_ref, operation_id, workflow_operation_id, stage_index,
  stage_attempt_ref, stage_request_sha256, stage_request_json,
  workflow_budget_receipt_ref, intent_id, intent_revision, intent_json,
  reservation_id, quote_ref, quote_json, authority_json, principal_ref,
  client_class, credential_generation, deployment_generation,
  policy_decision_ref, policy_generation, currentness_digest,
  scope_snapshot_id, scope_snapshot_revision,
  workflow_authorization_receipt_ref, route_ref, expected_deployment_json,
  approval_json, admission_revision, admission_sha256, decision_digest,
  max_input_bytes, max_output_bytes, expires_at, created_at, role
)
SELECT
  authorization_ref, operation_id, workflow_operation_id, stage_index,
  stage_attempt_ref, stage_request_sha256, stage_request_json,
  workflow_budget_receipt_ref, intent_id, intent_revision, intent_json,
  reservation_id, quote_ref, quote_json, authority_json, principal_ref,
  client_class, credential_generation, deployment_generation,
  policy_decision_ref, policy_generation, currentness_digest,
  scope_snapshot_id, scope_snapshot_revision,
  workflow_authorization_receipt_ref, route_ref, expected_deployment_json,
  approval_json, admission_revision, admission_sha256, decision_digest,
  max_input_bytes, max_output_bytes, expires_at, created_at, role
FROM _research_model_spend_admission_0095;

-- Copy guard (0071 precedent): stop before replacement if any copied
-- identity/value differs. The CHECK aborts the migration; the old table is
-- still present under its staging name and no canonical data was dropped.
CREATE TABLE _0096_admission_copy_guard (valid INTEGER NOT NULL CHECK (valid = 1));
INSERT INTO _0096_admission_copy_guard SELECT CASE WHEN
  (SELECT COUNT(*) FROM research_model_spend_admission)
    = (SELECT COUNT(*) FROM _research_model_spend_admission_0095)
  AND NOT EXISTS (
    SELECT * FROM _research_model_spend_admission_0095
    EXCEPT
    SELECT * FROM research_model_spend_admission)
  AND NOT EXISTS (
    SELECT * FROM research_model_spend_admission
    EXCEPT
    SELECT * FROM _research_model_spend_admission_0095)
  THEN 1 ELSE 0 END;
DROP TABLE _0096_admission_copy_guard;

-- The old table's triggers and index moved with the rename; drop them
-- explicitly before dropping the staging table (0071 precedent).
DROP TRIGGER research_model_spend_admission_shape_guard;
DROP TRIGGER research_model_spend_admission_w2_guard;
DROP TRIGGER research_model_spend_admission_deployment_guard;
DROP TRIGGER research_model_spend_admission_immutable;
DROP TRIGGER research_model_spend_admission_no_delete;
DROP INDEX research_model_spend_admission_lookup_idx;
DROP TABLE _research_model_spend_admission_0095;

CREATE INDEX research_model_spend_admission_lookup_idx
  ON research_model_spend_admission(
    principal_ref, operation_id, stage_attempt_ref, stage_request_sha256
  );

-- Every admission is an explicit approved decision.  The application binds
-- decision_digest to these canonical bytes before this trigger is reached.
-- (Verbatim from 0046; stage-agnostic.)
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
-- (0084 composite-equality form, extended with the branch stage names 8/9.)
CREATE TRIGGER research_model_spend_admission_w2_guard
BEFORE INSERT ON research_model_spend_admission
BEGIN
  SELECT RAISE(ABORT, 'MODEL_SPEND_ADMISSION_AUTHORITY_STALE')
  WHERE NOT EXISTS (
    SELECT 1
    FROM research_workflow_current r
    JOIN research_workflow_attempt a
      ON (a.operation_id, a.stage_index)
      = (r.operation_id, NEW.stage_index)
    JOIN scope_access_grant g
      ON (g.snapshot_id, g.snapshot_revision, g.principal_ref)
      = (r.scope_snapshot_id, r.scope_snapshot_revision, r.principal_ref)
    WHERE (r.operation_id, r.state, r.next_stage_index, r.current_revision, r.ledger_revision, a.state)
      = (NEW.workflow_operation_id, 'ACTIVE', NEW.stage_index, a.expected_revision, a.expected_revision, 'STARTED')
      AND a.output_json IS NULL
      AND (a.attempt_ref, a.request_sha256, a.budget_receipt_ref)
      = (NEW.stage_attempt_ref, NEW.stage_request_sha256, NEW.workflow_budget_receipt_ref)
      AND json_extract(a.request_json, '$.protocol') IS 'eliotr.workflow-stage.v1'
      AND json_extract(a.request_json, '$.operation_id') IS r.operation_id
      AND json_extract(a.request_json, '$.stage') IS CASE NEW.stage_index
        WHEN 8 THEN 'ANALYZE_BRANCHES' WHEN 9 THEN 'COUNTER_SEARCH'
        WHEN 12 THEN 'SYNTHESIZE' WHEN 13 THEN 'VERIFY' WHEN 14 THEN 'AUDIT_CLAIMS' END
      AND json_extract(a.request_json, '$.investigation_ref.id') IS r.investigation_id
      AND json_extract(a.request_json, '$.investigation_ref.revision') IS r.current_revision
      AND json_extract(a.request_json, '$.idempotency_key') IS r.idempotency_key
      AND json_extract(a.request_json, '$.handler_generation') IS r.handler_generation
      AND (r.principal_ref, r.credential_generation, r.deployment_generation, r.policy_generation, r.scope_snapshot_id, r.scope_snapshot_revision,
        r.authorization_receipt_ref, g.client_class, g.credential_generation, g.policy_authority_ref, g.authorization_receipt_ref, g.state)
      = (NEW.principal_ref, NEW.credential_generation, NEW.deployment_generation, NEW.policy_generation, NEW.scope_snapshot_id,
        NEW.scope_snapshot_revision, NEW.workflow_authorization_receipt_ref, NEW.client_class, NEW.credential_generation, r.policy_authority_ref,
        NEW.workflow_authorization_receipt_ref, 'ACTIVE')
      AND julianday(g.expires_at) > julianday('now')
      AND json_type(g.allowed_use_json) = 'array'
      AND EXISTS (
        SELECT 1 FROM json_each(g.allowed_use_json) u
        WHERE (u.type, u.value)
      = ('text', 'research')
      )
  );
END;

-- Bind the six-field deployment to the active, qualified route candidate.  A
-- TEST/LIVE qualification tier decision remains an explicit server callback;
-- this SQL guard still rejects an inactive or expired candidate.
-- (Verbatim from 0057; stage-agnostic.)
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
    LEFT JOIN dynamic_route_active_qualification latest
      ON latest.route_ref = active.route_ref
      AND latest.route_version = active.route_version
    LEFT JOIN dynamic_route_qualification_proof proof
      ON proof.qualification_ref = latest.qualification_ref
      AND proof.proof_sha256 = latest.qualification_sha256
      AND proof.route_ref = latest.route_ref
      AND proof.route_version = latest.route_version
      AND proof.candidate_ref = latest.candidate_ref
      AND proof.candidate_sha256 = latest.candidate_sha256
    WHERE active.route_ref = NEW.route_ref
      AND active.route_version = json_extract(NEW.expected_deployment_json, '$.route_version')
      AND json_extract(candidate.candidate_json, '$.deployment.route_ref') IS NEW.route_ref
      AND json_extract(candidate.candidate_json, '$.deployment.route_version') IS json_extract(NEW.expected_deployment_json, '$.route_version')
      AND json_extract(candidate.candidate_json, '$.deployment.prompt_generation') IS json_extract(NEW.expected_deployment_json, '$.prompt_generation')
      AND json_extract(candidate.candidate_json, '$.deployment.schema_generation') IS json_extract(NEW.expected_deployment_json, '$.schema_generation')
      AND json_extract(candidate.candidate_json, '$.deployment.parameters_digest') IS json_extract(NEW.expected_deployment_json, '$.parameters_digest')
      AND json_extract(candidate.candidate_json, '$.deployment.pricing_snapshot_ref') IS json_extract(NEW.expected_deployment_json, '$.pricing_snapshot_ref')
      AND (
        (
          latest.route_ref IS NULL
          AND json_extract(candidate.candidate_json, '$.qualification_expires_at') IS NOT NULL
          AND julianday(json_extract(candidate.candidate_json, '$.qualification_expires_at')) > julianday('now')
        )
        OR
        (
          latest.route_ref IS NOT NULL
          AND latest.candidate_ref IS active.candidate_ref
          AND latest.candidate_sha256 IS active.candidate_sha256
          AND proof.qualification_ref IS NOT NULL
          AND json_extract(proof.qualification_json, '$.qualification.tier') IS 'LIVE'
          AND json_extract(proof.qualification_json, '$.qualification.expires_at') IS NOT NULL
          AND julianday(json_extract(proof.qualification_json, '$.qualification.expires_at')) > julianday('now')
        )
      )
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

PRAGMA foreign_keys = ON;

-- This additive storage/readback capability does not authorize a provider by
-- itself and does not promote the public Worker generation.
