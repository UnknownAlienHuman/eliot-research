-- ER-09 / W2: durable single-attempt checkpoints. W1 remains the Investigation authority.
-- No network, R2 or model work occurs in these transactions. Runtime composition remains gated.
PRAGMA foreign_keys = ON;

CREATE TABLE research_workflow_run (
  operation_id TEXT PRIMARY KEY CHECK(length(operation_id) BETWEEN 1 AND 128),
  investigation_id TEXT NOT NULL REFERENCES investigation_ledger_head(investigation_id),
  initial_revision INTEGER NOT NULL CHECK(initial_revision BETWEEN 1 AND 999999),
  current_revision INTEGER NOT NULL CHECK(current_revision BETWEEN 1 AND 1000000),
  principal_ref TEXT NOT NULL,
  credential_generation TEXT NOT NULL,
  deployment_generation TEXT NOT NULL,
  policy_generation TEXT NOT NULL,
  policy_authority_ref TEXT NOT NULL,
  authorization_receipt_ref TEXT NOT NULL,
  scope_snapshot_id TEXT NOT NULL,
  scope_snapshot_revision INTEGER NOT NULL,
  purge_revision INTEGER NOT NULL CHECK(purge_revision >= 0),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(length(idempotency_key) BETWEEN 1 AND 256),
  handler_generation TEXT NOT NULL CHECK(length(handler_generation) BETWEEN 1 AND 256),
  initial_manifest_json TEXT NOT NULL CHECK(json_valid(initial_manifest_json) AND length(CAST(initial_manifest_json AS BLOB)) <= 65536),
  next_stage_index INTEGER NOT NULL DEFAULT 0 CHECK(next_stage_index BETWEEN 0 AND 18),
  state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','CANCELLED','ENGINE_COMPLETED')),
  cancellation_receipt_ref TEXT,
  created_at TEXT NOT NULL,
  CHECK((state = 'CANCELLED') = (cancellation_receipt_ref IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX research_workflow_one_active_run ON research_workflow_run(investigation_id) WHERE state = 'ACTIVE';

-- Same canonical policy/scope/purge sources as the W1 command; also pin the authenticated credential.
CREATE VIEW research_workflow_current AS
SELECT r.*, h.revision AS ledger_revision, h.checkpoint_head, h.event_head
FROM research_workflow_run r JOIN investigation_ledger_head h ON h.investigation_id = r.investigation_id
JOIN scope_snapshot s ON s.snapshot_id = r.scope_snapshot_id AND s.revision = r.scope_snapshot_revision
WHERE h.status = 'OPEN' AND h.principal_ref = r.principal_ref
  AND h.scope_snapshot_id = r.scope_snapshot_id AND h.scope_snapshot_revision = r.scope_snapshot_revision
  AND h.policy_generation = r.policy_generation AND h.policy_authority_ref = r.policy_authority_ref
  AND h.deployment_generation = r.deployment_generation
  AND s.invalidated_at IS NULL AND julianday(s.expires_at) > julianday('now')
  AND s.policy_authority_ref = r.policy_authority_ref AND s.purge_ledger_revision = r.purge_revision
  AND r.purge_revision = COALESCE((SELECT MAX(ledger_revision) FROM purge_ledger), 0)
  AND EXISTS (SELECT 1 FROM investigation_current_policy p WHERE p.state = 'ACTIVE'
    AND p.policy_generation = r.policy_generation AND p.policy_authority_ref = r.policy_authority_ref)
  AND EXISTS (SELECT 1 FROM investigation_current_deployment d WHERE d.state = 'ACTIVE'
    AND d.deployment_generation = r.deployment_generation)
  AND EXISTS (SELECT 1 FROM scope_access_grant g WHERE g.snapshot_id = r.scope_snapshot_id
    AND g.snapshot_revision = r.scope_snapshot_revision AND g.principal_ref = r.principal_ref
    AND g.credential_generation = r.credential_generation AND g.policy_authority_ref = r.policy_authority_ref
    AND g.authorization_receipt_ref = r.authorization_receipt_ref
    AND g.state = 'ACTIVE' AND julianday(g.expires_at) > julianday('now')
    AND json_type(g.allowed_use_json) = 'array'
    AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) u WHERE u.type = 'text' AND u.value = 'research'));

CREATE TRIGGER research_workflow_run_initial_shape BEFORE INSERT ON research_workflow_run
WHEN NEW.state <> 'ACTIVE' OR NEW.next_stage_index <> 0 OR NEW.current_revision <> NEW.initial_revision
  OR NOT EXISTS (SELECT 1 FROM investigation_ledger_head h WHERE h.investigation_id = NEW.investigation_id
    AND h.revision = NEW.initial_revision
    AND h.portfolio_ref = json_extract(NEW.initial_manifest_json, '$.object_ref')
    AND h.input_digest = json_extract(NEW.initial_manifest_json, '$.sha256'))
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_CONFLICT'); END;
CREATE TRIGGER research_workflow_run_authority AFTER INSERT ON research_workflow_run
WHEN NOT EXISTS (SELECT 1 FROM research_workflow_current WHERE operation_id = NEW.operation_id)
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTHORITY_STALE'); END;

CREATE TABLE research_workflow_attempt (
  operation_id TEXT NOT NULL REFERENCES research_workflow_run(operation_id),
  stage_index INTEGER NOT NULL CHECK(stage_index BETWEEN 0 AND 17),
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(CAST(request_json AS BLOB)) <= 65536),
  request_sha256 TEXT NOT NULL UNIQUE CHECK(length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  attempt_ref TEXT NOT NULL UNIQUE CHECK(length(attempt_ref) BETWEEN 1 AND 128),
  expected_revision INTEGER NOT NULL CHECK(expected_revision BETWEEN 1 AND 999999),
  budget_receipt_ref TEXT NOT NULL CHECK(length(budget_receipt_ref) BETWEEN 1 AND 256),
  budget_expires_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('STARTED','OUTPUT_RECORDED','COMMITTED')),
  output_json TEXT CHECK(output_json IS NULL OR (json_valid(output_json) AND length(CAST(output_json AS BLOB)) <= 65536)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(operation_id, stage_index),
  CHECK((state = 'STARTED') = (output_json IS NULL))
) STRICT;

CREATE TABLE research_workflow_checkpoint (
  operation_id TEXT NOT NULL,
  stage_index INTEGER NOT NULL,
  request_sha256 TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json) AND length(CAST(receipt_json AS BLOB)) <= 65536),
  receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256) = 64 AND receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
  ledger_event_id TEXT NOT NULL UNIQUE REFERENCES investigation_ledger_event(event_id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(operation_id, stage_index),
  FOREIGN KEY(operation_id, stage_index) REFERENCES research_workflow_attempt(operation_id, stage_index)
) STRICT;

CREATE TRIGGER research_workflow_attempt_reserve BEFORE INSERT ON research_workflow_attempt
WHEN NEW.state <> 'STARTED' OR NEW.output_json IS NOT NULL
 OR NEW.budget_expires_at_ms <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
 OR NEW.budget_expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER) + 600000
 OR json_extract(NEW.request_json, '$.protocol') IS NOT 'eliotr.workflow-stage.v1'
 OR json_extract(NEW.request_json, '$.operation_id') IS NOT NEW.operation_id
 OR json_extract(NEW.request_json, '$.stage') IS NOT CASE NEW.stage_index WHEN 0 THEN 'FREEZE_PROTOCOL_AND_SCOPE' WHEN 1 THEN 'ORIENT' WHEN 2 THEN 'INTERPRET' WHEN 3 THEN 'COMPILE_OBLIGATIONS' WHEN 4 THEN 'PLAN' WHEN 5 THEN 'RETRIEVE_BRANCHES' WHEN 6 THEN 'ACQUIRE_AND_CAPTURE' WHEN 7 THEN 'READ_AND_EXTRACT' WHEN 8 THEN 'ANALYZE_BRANCHES' WHEN 9 THEN 'COUNTER_SEARCH' WHEN 10 THEN 'RECONCILE' WHEN 11 THEN 'FREEZE_EVIDENCE' WHEN 12 THEN 'SYNTHESIZE' WHEN 13 THEN 'VERIFY' WHEN 14 THEN 'AUDIT_CLAIMS' WHEN 15 THEN 'RESOLVE_CITATIONS' WHEN 16 THEN 'CALCULATE_COVERAGE' WHEN 17 THEN 'MATERIALIZE' END
 OR NOT EXISTS (SELECT 1 FROM research_workflow_current r WHERE r.operation_id = NEW.operation_id
   AND r.state = 'ACTIVE' AND r.next_stage_index = NEW.stage_index
   AND r.current_revision = NEW.expected_revision AND r.ledger_revision = NEW.expected_revision
   AND r.investigation_id = json_extract(NEW.request_json, '$.investigation_ref.id')
   AND r.current_revision = json_extract(NEW.request_json, '$.investigation_ref.revision')
   AND r.idempotency_key = json_extract(NEW.request_json, '$.idempotency_key')
   AND r.handler_generation = json_extract(NEW.request_json, '$.handler_generation')
   AND json_extract(NEW.request_json, '$.input_manifest') = CASE WHEN NEW.stage_index = 0 THEN r.initial_manifest_json
     ELSE (SELECT a.output_json FROM research_workflow_attempt a WHERE a.operation_id = NEW.operation_id
       AND a.stage_index = NEW.stage_index - 1 AND a.state = 'COMMITTED') END)
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_STAGE_OUT_OF_ORDER'); END;

CREATE TRIGGER research_workflow_attempt_transition BEFORE UPDATE ON research_workflow_attempt
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.stage_index IS NOT OLD.stage_index
 OR NEW.request_json IS NOT OLD.request_json OR NEW.request_sha256 IS NOT OLD.request_sha256
 OR NEW.attempt_ref IS NOT OLD.attempt_ref OR NEW.expected_revision IS NOT OLD.expected_revision
 OR NEW.budget_receipt_ref IS NOT OLD.budget_receipt_ref OR NEW.budget_expires_at_ms IS NOT OLD.budget_expires_at_ms
 OR NEW.created_at IS NOT OLD.created_at
 OR NOT ((OLD.state = 'STARTED' AND NEW.state = 'OUTPUT_RECORDED' AND NEW.output_json IS NOT NULL)
   OR (OLD.state = 'OUTPUT_RECORDED' AND NEW.state = 'COMMITTED' AND NEW.output_json IS OLD.output_json
     AND EXISTS (SELECT 1 FROM research_workflow_checkpoint c WHERE c.operation_id = NEW.operation_id
       AND c.stage_index = NEW.stage_index AND c.request_sha256 = NEW.request_sha256)))
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_CONFLICT'); END;

CREATE TRIGGER research_workflow_output_authority BEFORE UPDATE ON research_workflow_attempt
WHEN NEW.state = 'OUTPUT_RECORDED' AND (
 NEW.budget_expires_at_ms <= CAST(unixepoch('subsec') * 1000 AS INTEGER)
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

-- A completed stage must join the exact W1 event written in the SAME D1 batch.
CREATE TRIGGER research_workflow_checkpoint_guard BEFORE INSERT ON research_workflow_checkpoint
WHEN NOT EXISTS (
 SELECT 1 FROM research_workflow_current r
 JOIN research_workflow_attempt a ON a.operation_id = r.operation_id AND a.stage_index = NEW.stage_index
 JOIN investigation_ledger_event e ON e.event_id = NEW.ledger_event_id
 WHERE r.operation_id = NEW.operation_id AND r.state = 'ACTIVE' AND r.next_stage_index = NEW.stage_index
 AND a.state = 'OUTPUT_RECORDED' AND a.request_sha256 = NEW.request_sha256
 AND a.budget_expires_at_ms > CAST(unixepoch('subsec') * 1000 AS INTEGER)
 AND r.current_revision = a.expected_revision AND r.ledger_revision = a.expected_revision + 1
 AND e.investigation_id = r.investigation_id AND e.sequence = r.event_head AND e.kind = 'CHECKPOINT'
 AND e.actor_ref = r.principal_ref AND e.verifier_ref IS NULL
 AND e.payload_handle_ref = json_extract(a.output_json, '$.object_ref')
 AND e.payload_digest = json_extract(a.output_json, '$.sha256')
 AND NEW.ledger_event_id = 'wcp:' || NEW.request_sha256
 AND json_extract(NEW.receipt_json, '$.protocol') = 'eliotr.workflow-checkpoint.v1'
 AND json_extract(NEW.receipt_json, '$.operation_id') = r.operation_id
 AND json_extract(NEW.receipt_json, '$.request_sha256') = a.request_sha256
 AND json_extract(NEW.receipt_json, '$.stage') = json_extract(a.request_json, '$.stage')
 AND json_extract(NEW.receipt_json, '$.attempt_ref') = a.attempt_ref
 AND json_extract(NEW.receipt_json, '$.receipt_ref') = 'wcp:' || NEW.request_sha256
 AND json_extract(NEW.receipt_json, '$.investigation_ref.id') = r.investigation_id
 AND json_extract(NEW.receipt_json, '$.investigation_ref.revision') = r.ledger_revision
 AND json_extract(NEW.receipt_json, '$.input_manifest_ref') = json_extract(a.request_json, '$.input_manifest.object_ref')
 AND json_extract(NEW.receipt_json, '$.output_manifest') = a.output_json
 AND json_extract(NEW.receipt_json, '$.budget_receipt_ref') = a.budget_receipt_ref
 AND json_extract(NEW.receipt_json, '$.cancellation_checked_at') = NEW.created_at
 AND json_extract(NEW.receipt_json, '$.engine_state') = CASE WHEN NEW.stage_index = 17 THEN 'ENGINE_COMPLETED' ELSE 'CHECKPOINTED' END
)
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTHORITY_STALE'); END;

CREATE TRIGGER research_workflow_checkpoint_commit AFTER INSERT ON research_workflow_checkpoint
BEGIN
 UPDATE research_workflow_attempt SET state = 'COMMITTED' WHERE operation_id = NEW.operation_id AND stage_index = NEW.stage_index;
 UPDATE research_workflow_run SET next_stage_index = NEW.stage_index + 1, current_revision = current_revision + 1,
   state = CASE WHEN NEW.stage_index = 17 THEN 'ENGINE_COMPLETED' ELSE 'ACTIVE' END
   WHERE operation_id = NEW.operation_id;
 INSERT INTO operation_intent (intent_id, revision, operation_kind, principal_ref, idempotency_key, payload_ref,
   policy_decision_ref, budget_reservation_ref, cancellation_ref, created_at)
 SELECT 'wcp:' || NEW.request_sha256, 1, 'research.workflow.checkpoint.v1', r.principal_ref,
   'wcp:' || NEW.request_sha256, 'wcp:' || NEW.request_sha256, r.authorization_receipt_ref,
   json_extract(NEW.receipt_json, '$.budget_receipt_ref'), 'workflow:' || NEW.operation_id, NEW.created_at
 FROM research_workflow_run r WHERE r.operation_id = NEW.operation_id;
 INSERT INTO outbox (outbox_id, intent_id, intent_revision, topic, payload_ref, payload_sha256,
   state, next_attempt_at, created_at, updated_at)
 VALUES ('wcp-outbox:' || NEW.request_sha256, 'wcp:' || NEW.request_sha256, 1,
   'research.workflow.checkpoint.v1', 'wcp:' || NEW.request_sha256, NEW.receipt_sha256,
   'PENDING', CAST(unixepoch('subsec') * 1000 AS INTEGER), NEW.created_at, NEW.created_at);
END;

CREATE TRIGGER research_workflow_checkpoint_immutable BEFORE UPDATE ON research_workflow_checkpoint
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_CONFLICT'); END;
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
 OR NOT (OLD.state = 'ACTIVE' AND (
   (NEW.state = 'CANCELLED' AND NEW.next_stage_index = OLD.next_stage_index AND NEW.current_revision = OLD.current_revision
     AND NEW.cancellation_receipt_ref = 'workflow-cancelled:' || OLD.operation_id)
   OR (NEW.next_stage_index = OLD.next_stage_index + 1 AND NEW.current_revision = OLD.current_revision + 1
     AND NEW.cancellation_receipt_ref IS NULL
     AND NEW.state = CASE WHEN NEW.next_stage_index = 18 THEN 'ENGINE_COMPLETED' ELSE 'ACTIVE' END
     AND EXISTS (SELECT 1 FROM research_workflow_checkpoint c WHERE c.operation_id = OLD.operation_id AND c.stage_index = OLD.next_stage_index))
 ))
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_CONFLICT'); END;

-- An uncertain attempt must not disappear and become eligible for an automatic paid retry.
-- Retention/erasure integration must explicitly govern these metadata rows before live composition.
CREATE TRIGGER research_workflow_attempt_no_delete BEFORE DELETE ON research_workflow_attempt
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_CONFLICT'); END;
CREATE TRIGGER research_workflow_checkpoint_no_delete BEFORE DELETE ON research_workflow_checkpoint
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_CONFLICT'); END;
CREATE TRIGGER research_workflow_run_no_delete BEFORE DELETE ON research_workflow_run
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_CONFLICT'); END;

-- This additive, uncomposed capability does not promote the public Worker readiness generation.
-- Follow the W1 migrations: runtime generation changes belong to the later composition/release gate.
