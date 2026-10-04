-- Immutable model/config selection captured before a new run reaches Workflow.create.
-- Existing run rows retain NULL configuration_ref and use the explicit legacy-installed path.
ALTER TABLE research_workflow_run ADD COLUMN configuration_ref TEXT;
ALTER TABLE research_workflow_run ADD COLUMN configuration_required INTEGER NOT NULL DEFAULT 0;

-- Keep ADD COLUMN metadata-only for ADR9. Reapply the former CHECK constraints
-- to every new/updated row without scanning the pre-existing run table.
CREATE TRIGGER research_workflow_run_configuration_ref_insert_guard
BEFORE INSERT ON research_workflow_run
WHEN NEW.configuration_ref IS NOT NULL AND NOT (
  length(NEW.configuration_ref)=28 AND substr(NEW.configuration_ref,1,4)='rrc-'
  AND substr(NEW.configuration_ref,5) NOT GLOB '*[^0-9a-f]*')
BEGIN SELECT RAISE(ABORT,'RESEARCH_RUN_CONFIGURATION_CONFLICT'); END;

CREATE TRIGGER research_workflow_run_configuration_ref_update_guard
BEFORE UPDATE OF configuration_ref ON research_workflow_run
WHEN NEW.configuration_ref IS NOT NULL AND NOT (
  length(NEW.configuration_ref)=28 AND substr(NEW.configuration_ref,1,4)='rrc-'
  AND substr(NEW.configuration_ref,5) NOT GLOB '*[^0-9a-f]*')
BEGIN SELECT RAISE(ABORT,'RESEARCH_RUN_CONFIGURATION_CONFLICT'); END;

CREATE TRIGGER research_workflow_run_configuration_required_insert_guard
BEFORE INSERT ON research_workflow_run
WHEN NEW.configuration_required IS NULL OR NEW.configuration_required NOT IN (0,1)
BEGIN SELECT RAISE(ABORT,'RESEARCH_RUN_CONFIGURATION_CONFLICT'); END;

CREATE TRIGGER research_workflow_run_configuration_required_update_guard
BEFORE UPDATE OF configuration_required ON research_workflow_run
WHEN NEW.configuration_required IS NULL OR NEW.configuration_required NOT IN (0,1)
BEGIN SELECT RAISE(ABORT,'RESEARCH_RUN_CONFIGURATION_CONFLICT'); END;

CREATE TABLE research_run_configuration (
  operation_id TEXT PRIMARY KEY CHECK(length(operation_id) BETWEEN 1 AND 128),
  investigation_id TEXT NOT NULL CHECK(length(investigation_id) BETWEEN 1 AND 256),
  principal_ref TEXT NOT NULL CHECK(length(principal_ref) BETWEEN 1 AND 256),
  deployment_generation TEXT NOT NULL CHECK(length(deployment_generation) BETWEEN 1 AND 256),
  protocol TEXT NOT NULL CHECK(protocol='eliotr.research-run-configuration.v1'),
  mode TEXT NOT NULL CHECK(mode IN ('snapshot-v1','snapshot-v2')),
  configuration_ref TEXT NOT NULL UNIQUE CHECK(
    length(configuration_ref)=28 AND substr(configuration_ref,1,4)='rrc-' AND
    substr(configuration_ref,5) NOT GLOB '*[^0-9a-f]*'),
  configuration_sha256 TEXT NOT NULL CHECK(length(configuration_sha256)=64 AND configuration_sha256 NOT GLOB '*[^0-9a-f]*'),
  configuration_json TEXT NOT NULL CHECK(
    json_valid(configuration_json) AND length(CAST(configuration_json AS BLOB)) BETWEEN 1 AND 524288 AND
    json_extract(configuration_json,'$.protocol')='eliotr.research-run-configuration.v1' AND
    json_extract(configuration_json,'$.mode')=mode AND
    json_type(configuration_json,'$.model_selections')='array' AND
    json_extract(configuration_json,'$.association.operation_id')=operation_id AND
    json_extract(configuration_json,'$.association.investigation_id')=investigation_id AND
    json_extract(configuration_json,'$.association.principal_ref')=principal_ref AND
    json_extract(configuration_json,'$.association.deployment_generation')=deployment_generation),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 524288),
  created_at TEXT NOT NULL CHECK(
    created_at GLOB '????-??-??T??:??:??.???Z' AND julianday(created_at) IS NOT NULL AND
    strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),
  CHECK(byte_length=length(CAST(configuration_json AS BLOB))),
  CHECK(configuration_ref='rrc-' || substr(configuration_sha256,1,24))
) STRICT, WITHOUT ROWID;

CREATE INDEX research_run_configuration_investigation_idx
  ON research_run_configuration(investigation_id,operation_id);

CREATE TRIGGER research_run_configuration_no_update BEFORE UPDATE ON research_run_configuration
BEGIN SELECT RAISE(ABORT,'RESEARCH_RUN_CONFIGURATION_IMMUTABLE'); END;
CREATE TRIGGER research_run_configuration_no_delete BEFORE DELETE ON research_run_configuration
BEGIN SELECT RAISE(ABORT,'RESEARCH_RUN_CONFIGURATION_IMMUTABLE'); END;

CREATE TRIGGER research_workflow_run_configuration_binding_guard BEFORE UPDATE OF configuration_ref ON research_workflow_run
WHEN OLD.configuration_ref IS NOT NULL OR NEW.configuration_ref IS NULL OR NOT EXISTS (
  SELECT 1 FROM research_run_configuration c WHERE c.operation_id=NEW.operation_id
    AND c.investigation_id=NEW.investigation_id AND c.principal_ref=NEW.principal_ref
    AND c.deployment_generation=NEW.deployment_generation AND c.configuration_ref=NEW.configuration_ref)
BEGIN SELECT RAISE(ABORT,'RESEARCH_RUN_CONFIGURATION_CONFLICT'); END;

-- Rows present at migration time remain the explicit legacy-installed cohort;
-- every run admitted after migration requires a snapshot before dispatch.
CREATE TRIGGER research_workflow_run_configuration_required AFTER INSERT ON research_workflow_run
WHEN NEW.configuration_required=0
BEGIN UPDATE research_workflow_run SET configuration_required=1 WHERE operation_id=NEW.operation_id; END;

-- Permit one immutable configuration pointer attach without weakening the W2 run transition guard.
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
       AND EXISTS (SELECT 1 FROM research_workflow_checkpoint c
         WHERE c.operation_id = OLD.operation_id AND c.stage_index = OLD.next_stage_index))
   ) AND NEW.first_failure_json IS OLD.first_failure_json AND NEW.latest_failure_json IS OLD.latest_failure_json)
   OR (OLD.configuration_required IS NEW.configuration_required AND OLD.configuration_ref IS NEW.configuration_ref
     AND OLD.state='ACTIVE' AND NEW.state IS OLD.state
     AND NEW.current_revision IS OLD.current_revision AND NEW.next_stage_index IS OLD.next_stage_index
     AND NEW.cancellation_receipt_ref IS OLD.cancellation_receipt_ref
     AND NEW.first_failure_json IS NOT NULL AND NEW.latest_failure_json IS NOT NULL
     AND (OLD.first_failure_json IS NULL OR NEW.first_failure_json IS OLD.first_failure_json))
 )
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_CONFLICT'); END;
