-- Native Workflow completion for deterministic early Research stages.
-- W2 attempt/checkpoint rows and their historical readers remain unchanged.
ALTER TABLE research_workflow_run ADD COLUMN stage_effect_policy_generation TEXT
  CHECK(stage_effect_policy_generation IS NULL OR
    stage_effect_policy_generation = 'eliotr.workflow-stage-effects.v1');

CREATE TABLE research_workflow_native_stage_completion (
  operation_id TEXT NOT NULL REFERENCES research_workflow_run(operation_id),
  stage_index INTEGER NOT NULL CHECK(stage_index BETWEEN 1 AND 4),
  stage TEXT NOT NULL CHECK(stage IN ('ORIENT','INTERPRET','COMPILE_OBLIGATIONS','PLAN')),
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(CAST(request_json AS BLOB)) <= 65536),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  handler_generation TEXT NOT NULL CHECK(handler_generation IN (
    'research-handlers.exploratory.v1','research-handlers.exploratory.v2',
    'research-handlers.exploratory.v3','research-handlers.exploratory.v4',
    'research-handlers.exploratory.v5','research-handlers.exploratory.v6',
    'research-handlers.exploratory.v7','research-handlers.exploratory.v8')),
  effect_policy_generation TEXT NOT NULL CHECK(effect_policy_generation = 'eliotr.workflow-stage-effects.v1'),
  effect_class TEXT NOT NULL CHECK(effect_class = 'PURE_COMPUTE'),
  authority_policy_generation TEXT NOT NULL,
  policy_authority_ref TEXT NOT NULL,
  principal_ref TEXT NOT NULL,
  credential_generation TEXT NOT NULL,
  deployment_generation TEXT NOT NULL,
  scope_snapshot_id TEXT NOT NULL,
  scope_snapshot_revision INTEGER NOT NULL CHECK(scope_snapshot_revision BETWEEN 1 AND 999999),
  authorization_receipt_ref TEXT NOT NULL,
  purge_revision INTEGER NOT NULL CHECK(purge_revision >= 0),
  expected_revision INTEGER NOT NULL CHECK(expected_revision BETWEEN 1 AND 999999),
  input_manifest_json TEXT NOT NULL CHECK(json_valid(input_manifest_json) AND length(CAST(input_manifest_json AS BLOB)) <= 65536),
  output_manifest_json TEXT NOT NULL CHECK(json_valid(output_manifest_json) AND length(CAST(output_manifest_json AS BLOB)) <= 65536),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) <= 65536),
  receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256) = 64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
  ledger_event_id TEXT NOT NULL UNIQUE REFERENCES investigation_ledger_event(event_id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(operation_id, stage_index)
) STRICT;

-- W2 stages may follow an already committed native stage. The previous exact
-- manifest must still come from one canonical committed lineage, never an attempt guess.
DROP TRIGGER research_workflow_attempt_reserve;
CREATE TRIGGER research_workflow_attempt_reserve BEFORE INSERT ON research_workflow_attempt
WHEN NEW.state <> 'STARTED' OR NEW.output_json IS NOT NULL
 OR NEW.budget_expires_at_ms <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
 OR NEW.budget_expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER) + 600000
 OR json_extract(NEW.request_json, '$.protocol') IS NOT 'eliotr.workflow-stage.v1'
 OR json_extract(NEW.request_json, '$.operation_id') IS NOT NEW.operation_id
 OR json_extract(NEW.request_json, '$.stage') IS NOT CASE NEW.stage_index
   WHEN 0 THEN 'FREEZE_PROTOCOL_AND_SCOPE' WHEN 1 THEN 'ORIENT' WHEN 2 THEN 'INTERPRET'
   WHEN 3 THEN 'COMPILE_OBLIGATIONS' WHEN 4 THEN 'PLAN' WHEN 5 THEN 'RETRIEVE_BRANCHES'
   WHEN 6 THEN 'ACQUIRE_AND_CAPTURE' WHEN 7 THEN 'READ_AND_EXTRACT' WHEN 8 THEN 'ANALYZE_BRANCHES'
   WHEN 9 THEN 'COUNTER_SEARCH' WHEN 10 THEN 'RECONCILE' WHEN 11 THEN 'FREEZE_EVIDENCE'
   WHEN 12 THEN 'SYNTHESIZE' WHEN 13 THEN 'VERIFY' WHEN 14 THEN 'AUDIT_CLAIMS'
   WHEN 15 THEN 'RESOLVE_CITATIONS' WHEN 16 THEN 'CALCULATE_COVERAGE' WHEN 17 THEN 'MATERIALIZE' END
 OR NOT EXISTS (SELECT 1 FROM research_workflow_current r WHERE r.operation_id = NEW.operation_id
   AND r.state = 'ACTIVE' AND r.next_stage_index = NEW.stage_index
   AND r.current_revision = NEW.expected_revision AND r.ledger_revision = NEW.expected_revision
   AND r.investigation_id = json_extract(NEW.request_json, '$.investigation_ref.id')
   AND r.current_revision = json_extract(NEW.request_json, '$.investigation_ref.revision')
   AND r.idempotency_key = json_extract(NEW.request_json, '$.idempotency_key')
   AND r.handler_generation = json_extract(NEW.request_json, '$.handler_generation')
   AND json_extract(NEW.request_json, '$.input_manifest') = CASE WHEN NEW.stage_index = 0 THEN r.initial_manifest_json
     ELSE COALESCE(
       (SELECT a.output_json FROM research_workflow_attempt a WHERE a.operation_id = NEW.operation_id
         AND a.stage_index = NEW.stage_index - 1 AND a.state = 'COMMITTED'),
       (SELECT n.output_manifest_json FROM research_workflow_native_stage_completion n
         WHERE n.operation_id = NEW.operation_id AND n.stage_index = NEW.stage_index - 1)) END)
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_STAGE_OUT_OF_ORDER'); END;

-- Keep each fail-closed predicate shallow enough for D1's depth-100 compiler.
-- Splitting these BEFORE guards does not split or weaken the atomic completion.
CREATE TRIGGER research_workflow_native_stage_completion_shape_guard
BEFORE INSERT ON research_workflow_native_stage_completion
WHEN NEW.stage_index NOT BETWEEN 1 AND 4
 OR NEW.stage IS NOT CASE NEW.stage_index WHEN 1 THEN 'ORIENT' WHEN 2 THEN 'INTERPRET'
   WHEN 3 THEN 'COMPILE_OBLIGATIONS' WHEN 4 THEN 'PLAN' END
 OR NEW.effect_policy_generation IS NOT 'eliotr.workflow-stage-effects.v1'
 OR NEW.effect_class IS NOT 'PURE_COMPUTE'
 OR NEW.handler_generation NOT IN (
   'research-handlers.exploratory.v1','research-handlers.exploratory.v2',
   'research-handlers.exploratory.v3','research-handlers.exploratory.v4',
   'research-handlers.exploratory.v5','research-handlers.exploratory.v6',
   'research-handlers.exploratory.v7','research-handlers.exploratory.v8')
 OR NEW.ledger_event_id IS NOT ('wnc:' || NEW.request_sha256)
 OR NEW.input_manifest_json IS NOT json_extract(NEW.request_json, '$.input_manifest')
 OR json_extract(NEW.output_manifest_json, '$.object_ref') IS NOT
   ('workflow-native/' || NEW.request_sha256 || '/' || json_extract(NEW.output_manifest_json, '$.sha256'))
 OR json_extract(NEW.output_manifest_json, '$.byte_length') NOT BETWEEN 0 AND 8388608
 OR length(json_extract(NEW.output_manifest_json, '$.sha256')) IS NOT 64
 OR json_extract(NEW.output_manifest_json, '$.sha256') GLOB '*[^0-9a-f]*'
 OR json_extract(NEW.output_manifest_json, '$.residency.content_digest.digest') IS NOT json_extract(NEW.output_manifest_json, '$.sha256')
 OR json_extract(NEW.output_manifest_json, '$.residency.content_digest.algorithm') IS NOT 'sha256'
 OR json_extract(NEW.output_manifest_json, '$.residency.scope_domain_id') IS NOT json_extract(NEW.input_manifest_json, '$.residency.scope_domain_id')
 OR json_extract(NEW.output_manifest_json, '$.residency.access_domain_id') IS NOT json_extract(NEW.input_manifest_json, '$.residency.access_domain_id')
 OR json_extract(NEW.output_manifest_json, '$.residency.confidentiality_domain_id') IS NOT json_extract(NEW.input_manifest_json, '$.residency.confidentiality_domain_id')
 OR json_extract(NEW.output_manifest_json, '$.residency.encryption_key_domain_id') IS NOT json_extract(NEW.input_manifest_json, '$.residency.encryption_key_domain_id')
 OR json_extract(NEW.output_manifest_json, '$.residency.retention_domain_id') IS NOT json_extract(NEW.input_manifest_json, '$.residency.retention_domain_id')
 OR json_extract(NEW.output_manifest_json, '$.residency.erasure_domain_id') IS NOT json_extract(NEW.input_manifest_json, '$.residency.erasure_domain_id')
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTHORITY_STALE'); END;

CREATE TRIGGER research_workflow_native_stage_completion_request_guard
BEFORE INSERT ON research_workflow_native_stage_completion
WHEN json_extract(NEW.request_json, '$.protocol') IS NOT 'eliotr.workflow-stage.v1'
 OR json_extract(NEW.request_json, '$.operation_id') IS NOT NEW.operation_id
 OR json_extract(NEW.request_json, '$.stage') IS NOT NEW.stage
 OR json_extract(NEW.request_json, '$.handler_generation') IS NOT NEW.handler_generation
 OR json_extract(NEW.request_json, '$.input_manifest') IS NOT NEW.input_manifest_json
 OR json_extract(NEW.request_json, '$.stage_index') IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTHORITY_STALE'); END;

CREATE TRIGGER research_workflow_native_stage_completion_current_guard
BEFORE INSERT ON research_workflow_native_stage_completion
WHEN NOT EXISTS (
  SELECT 1 FROM research_workflow_current r
  WHERE r.operation_id = NEW.operation_id AND r.state = 'ACTIVE'
    AND r.stage_effect_policy_generation = NEW.effect_policy_generation
    AND r.next_stage_index = NEW.stage_index AND r.current_revision = NEW.expected_revision
    AND r.ledger_revision = NEW.expected_revision + 1
    AND r.investigation_id = json_extract(NEW.request_json, '$.investigation_ref.id')
    AND r.current_revision = json_extract(NEW.request_json, '$.investigation_ref.revision')
    AND r.idempotency_key = json_extract(NEW.request_json, '$.idempotency_key')
    AND r.handler_generation = NEW.handler_generation
    AND r.policy_generation = NEW.authority_policy_generation
    AND r.policy_authority_ref = NEW.policy_authority_ref
    AND r.principal_ref = NEW.principal_ref
    AND r.credential_generation = NEW.credential_generation
    AND r.deployment_generation = NEW.deployment_generation
    AND r.scope_snapshot_id = NEW.scope_snapshot_id
    AND r.scope_snapshot_revision = NEW.scope_snapshot_revision
    AND r.authorization_receipt_ref = NEW.authorization_receipt_ref
    AND r.purge_revision = NEW.purge_revision)
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTHORITY_STALE'); END;

CREATE TRIGGER research_workflow_native_stage_completion_receipt_guard
BEFORE INSERT ON research_workflow_native_stage_completion
WHEN json_extract(NEW.receipt_json, '$.protocol') IS NOT 'eliotr.workflow-native-stage.v1'
 OR json_extract(NEW.receipt_json, '$.operation_id') IS NOT NEW.operation_id
 OR json_extract(NEW.receipt_json, '$.stage') IS NOT NEW.stage
 OR json_extract(NEW.receipt_json, '$.stage_index') IS NOT NEW.stage_index
 OR json_extract(NEW.receipt_json, '$.request_sha256') IS NOT NEW.request_sha256
 OR json_extract(NEW.receipt_json, '$.receipt_ref') IS NOT ('wnc:' || NEW.request_sha256)
 OR json_extract(NEW.receipt_json, '$.handler_generation') IS NOT NEW.handler_generation
 OR json_extract(NEW.receipt_json, '$.effect_policy_generation') IS NOT NEW.effect_policy_generation
 OR json_extract(NEW.receipt_json, '$.effect_class') IS NOT NEW.effect_class
 OR json_extract(NEW.receipt_json, '$.authority.policy_generation') IS NOT NEW.authority_policy_generation
 OR json_extract(NEW.receipt_json, '$.authority.policy_authority_ref') IS NOT NEW.policy_authority_ref
 OR json_extract(NEW.receipt_json, '$.authority.principal_ref') IS NOT NEW.principal_ref
 OR json_extract(NEW.receipt_json, '$.authority.credential_generation') IS NOT NEW.credential_generation
 OR json_extract(NEW.receipt_json, '$.authority.deployment_generation') IS NOT NEW.deployment_generation
 OR json_extract(NEW.receipt_json, '$.authority.scope_snapshot_id') IS NOT NEW.scope_snapshot_id
 OR json_extract(NEW.receipt_json, '$.authority.scope_snapshot_revision') IS NOT NEW.scope_snapshot_revision
 OR json_extract(NEW.receipt_json, '$.authority.authorization_receipt_ref') IS NOT NEW.authorization_receipt_ref
 OR json_extract(NEW.receipt_json, '$.authority.purge_revision') IS NOT NEW.purge_revision
 OR json_extract(NEW.receipt_json, '$.expected_revision') IS NOT NEW.expected_revision
 OR json_extract(NEW.receipt_json, '$.investigation_ref.id') IS NOT json_extract(NEW.request_json, '$.investigation_ref.id')
 OR json_extract(NEW.receipt_json, '$.investigation_ref.revision') IS NOT (NEW.expected_revision + 1)
 OR json_extract(NEW.receipt_json, '$.input_manifest_ref') IS NOT json_extract(NEW.request_json, '$.input_manifest.object_ref')
 OR json_extract(NEW.receipt_json, '$.output_manifest') IS NOT NEW.output_manifest_json
 OR json_extract(NEW.receipt_json, '$.engine_state') IS NOT 'CHECKPOINTED'
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTHORITY_STALE'); END;

CREATE TRIGGER research_workflow_native_stage_completion_attempt_guard
BEFORE INSERT ON research_workflow_native_stage_completion
WHEN EXISTS (SELECT 1 FROM research_workflow_attempt a
  WHERE a.operation_id = NEW.operation_id AND a.stage_index = NEW.stage_index)
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTHORITY_STALE'); END;

CREATE TRIGGER research_workflow_native_stage_completion_intent_guard
BEFORE INSERT ON research_workflow_native_stage_completion
WHEN NOT EXISTS (
  SELECT 1 FROM operation_intent i
  WHERE i.intent_id = 'wni:' || NEW.request_sha256 AND i.revision = 1
    AND i.operation_kind = 'research.workflow.native-stage.intent.v1'
    AND i.idempotency_key = NEW.request_sha256
    AND i.payload_ref = json_extract(NEW.output_manifest_json, '$.object_ref')
    AND i.policy_decision_ref = NEW.authorization_receipt_ref AND i.budget_reservation_ref IS NULL)
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTHORITY_STALE'); END;

CREATE TRIGGER research_workflow_native_stage_completion_ledger_guard
BEFORE INSERT ON research_workflow_native_stage_completion
WHEN NOT EXISTS (
  SELECT 1 FROM research_workflow_current r
  JOIN investigation_ledger_event e ON e.event_id = NEW.ledger_event_id
  WHERE r.operation_id = NEW.operation_id
    AND e.investigation_id = r.investigation_id AND e.sequence = r.event_head
    AND e.kind = 'CHECKPOINT' AND e.actor_ref = r.principal_ref AND e.verifier_ref IS NULL
    AND e.payload_handle_ref = json_extract(NEW.output_manifest_json, '$.object_ref')
    AND e.payload_digest = json_extract(NEW.output_manifest_json, '$.sha256'))
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTHORITY_STALE'); END;

CREATE TRIGGER research_workflow_native_stage_completion_commit
AFTER INSERT ON research_workflow_native_stage_completion
BEGIN
  INSERT INTO outbox (outbox_id, intent_id, intent_revision, topic, payload_ref, payload_sha256,
    state, next_attempt_at, created_at, updated_at)
  VALUES ('wnc-outbox:' || NEW.request_sha256, 'wni:' || NEW.request_sha256, 1,
    'research.workflow.native-stage.v1', 'wnc:' || NEW.request_sha256, NEW.receipt_sha256,
    'PENDING', CAST(unixepoch('subsec') * 1000 AS INTEGER), NEW.created_at, NEW.created_at);
  UPDATE research_workflow_run SET next_stage_index = NEW.stage_index + 1,
    current_revision = current_revision + 1, state = 'ACTIVE'
    WHERE operation_id = NEW.operation_id;
END;

CREATE TRIGGER research_workflow_native_stage_completion_immutable
BEFORE UPDATE ON research_workflow_native_stage_completion
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_CONFLICT'); END;
CREATE TRIGGER research_workflow_native_stage_completion_no_delete
BEFORE DELETE ON research_workflow_native_stage_completion
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_CONFLICT'); END;

-- Extend the latest installed run transition guard without weakening its
-- configuration, cancellation, failure-history, or immutable authority rules.
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
 OR NEW.stage_effect_policy_generation IS NOT OLD.stage_effect_policy_generation
 OR NEW.created_at IS NOT OLD.created_at
 OR NOT (
   (OLD.configuration_required=0 AND NEW.configuration_required=1
    AND OLD.configuration_ref IS NULL AND NEW.configuration_ref IS NULL
    AND OLD.state='ACTIVE' AND NEW.state IS OLD.state
    AND NEW.next_stage_index IS OLD.next_stage_index AND NEW.current_revision IS OLD.current_revision
    AND NEW.cancellation_receipt_ref IS OLD.cancellation_receipt_ref
    AND NEW.first_failure_json IS OLD.first_failure_json AND NEW.latest_failure_json IS OLD.latest_failure_json)
   OR (OLD.configuration_required=1 AND NEW.configuration_required=1
    AND OLD.configuration_ref IS NULL AND NEW.configuration_ref IS NOT NULL
    AND OLD.state='ACTIVE' AND NEW.state IS OLD.state
    AND NEW.next_stage_index IS OLD.next_stage_index AND NEW.current_revision IS OLD.current_revision
    AND NEW.cancellation_receipt_ref IS OLD.cancellation_receipt_ref
    AND NEW.first_failure_json IS OLD.first_failure_json AND NEW.latest_failure_json IS OLD.latest_failure_json)
   OR (OLD.configuration_required IS NEW.configuration_required AND OLD.configuration_ref IS NEW.configuration_ref
    AND OLD.state = 'ACTIVE' AND (
     (NEW.state = 'CANCELLED' AND NEW.next_stage_index = OLD.next_stage_index AND NEW.current_revision = OLD.current_revision
       AND NEW.cancellation_receipt_ref = 'workflow-cancelled:' || OLD.operation_id)
     OR (NEW.next_stage_index = OLD.next_stage_index + 1 AND NEW.current_revision = OLD.current_revision + 1
       AND NEW.cancellation_receipt_ref IS NULL
       AND NEW.state = CASE WHEN NEW.next_stage_index = 18 THEN 'ENGINE_COMPLETED' ELSE 'ACTIVE' END
       AND (EXISTS (SELECT 1 FROM research_workflow_checkpoint c
          WHERE c.operation_id = OLD.operation_id AND c.stage_index = OLD.next_stage_index)
         OR EXISTS (SELECT 1 FROM research_workflow_native_stage_completion n
          WHERE n.operation_id = OLD.operation_id AND n.stage_index = OLD.next_stage_index)))
    ) AND NEW.first_failure_json IS OLD.first_failure_json AND NEW.latest_failure_json IS OLD.latest_failure_json)
   OR (OLD.configuration_required IS NEW.configuration_required AND OLD.configuration_ref IS NEW.configuration_ref
     AND OLD.state='ACTIVE' AND NEW.state IS OLD.state
     AND NEW.current_revision IS OLD.current_revision AND NEW.next_stage_index IS OLD.next_stage_index
     AND NEW.cancellation_receipt_ref IS OLD.cancellation_receipt_ref
     AND NEW.first_failure_json IS NOT NULL AND NEW.latest_failure_json IS NOT NULL
     AND (OLD.first_failure_json IS NULL OR NEW.first_failure_json IS OLD.first_failure_json))
 )
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_CONFLICT'); END;
