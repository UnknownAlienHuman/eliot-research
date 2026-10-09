-- Locator delivery only; no new attempt, budget, checkpoint or Workflow authority.
-- The result UPDATE and these existing intent/outbox inserts share one D1 batch.
PRAGMA foreign_keys = ON;

CREATE TRIGGER research_external_agent_result_intent_guard
BEFORE INSERT ON operation_intent
WHEN NEW.intent_id GLOB 'external-task-wake:*' AND NOT EXISTS (
  SELECT 1 FROM research_external_agent_task t
  JOIN research_workflow_run r ON r.operation_id=t.operation_id
  JOIN research_external_agent_result_settlement_authorized s
    ON (s.operation_id,s.stage_index,s.principal_ref,s.intent_id)
      = (t.operation_id,t.stage_index,r.principal_ref,t.task_id)
  WHERE NEW.intent_id='external-task-wake:' || t.request_sha256
    AND NEW.revision=1 AND NEW.operation_kind='RESEARCH'
    AND NEW.principal_ref=r.principal_ref AND NEW.idempotency_key=NEW.intent_id
    AND NEW.payload_ref=t.task_id AND NEW.policy_decision_ref=r.authorization_receipt_ref
    AND NEW.budget_reservation_ref IS NULL AND NEW.cancellation_ref='workflow:' || t.operation_id
    AND NEW.created_at=t.updated_at
)
BEGIN SELECT RAISE(ABORT,'EXTERNAL_AGENT_TASK_AUTHORITY_STALE'); END;

CREATE TRIGGER research_external_agent_result_outbox_guard
BEFORE INSERT ON outbox
WHEN (NEW.topic='research.external-task.result-recorded.v1' OR NEW.intent_id GLOB 'external-task-wake:*')
  AND NOT EXISTS (
    SELECT 1 FROM operation_intent i
    JOIN research_external_agent_task t ON t.task_id=i.payload_ref
    JOIN research_workflow_run r ON r.operation_id=t.operation_id
    JOIN research_external_agent_result_settlement_authorized s
      ON (s.operation_id,s.stage_index,s.principal_ref,s.intent_id)
        = (t.operation_id,t.stage_index,r.principal_ref,t.task_id)
    WHERE (i.intent_id,i.revision)=(NEW.intent_id,NEW.intent_revision)
      AND i.intent_id='external-task-wake:' || t.request_sha256
      AND i.revision=1 AND i.operation_kind='RESEARCH'
      AND i.principal_ref=r.principal_ref AND i.idempotency_key=i.intent_id
      AND i.policy_decision_ref=r.authorization_receipt_ref AND i.budget_reservation_ref IS NULL
      AND i.cancellation_ref='workflow:' || t.operation_id AND i.created_at=t.updated_at
      AND NEW.topic='research.external-task.result-recorded.v1'
      AND NEW.payload_ref=t.task_id AND NEW.payload_sha256=t.result_sha256
      AND NEW.created_at=t.updated_at AND NEW.updated_at=t.updated_at
      AND NEW.state='PENDING' AND NEW.attempts=0 AND NEW.lease_generation=0
      AND NEW.next_attempt_at=CAST(unixepoch(t.updated_at,'subsec')*1000 AS INTEGER)
      AND NEW.lease_owner IS NULL AND NEW.lease_until IS NULL AND NEW.queue_message_id IS NULL
      AND NEW.last_error_code IS NULL
  )
BEGIN SELECT RAISE(ABORT,'EXTERNAL_AGENT_TASK_CONFLICT'); END;

-- Delivery leases/attempts can change; locator authority cannot.
CREATE TRIGGER research_external_agent_result_outbox_identity_guard
BEFORE UPDATE ON outbox
WHEN (OLD.topic='research.external-task.result-recorded.v1' OR OLD.intent_id GLOB 'external-task-wake:*'
    OR NEW.topic='research.external-task.result-recorded.v1' OR NEW.intent_id GLOB 'external-task-wake:*')
  AND (NEW.outbox_id IS NOT OLD.outbox_id OR NEW.intent_id IS NOT OLD.intent_id
    OR NEW.intent_revision IS NOT OLD.intent_revision OR NEW.topic IS NOT OLD.topic
    OR NEW.payload_ref IS NOT OLD.payload_ref OR NEW.payload_sha256 IS NOT OLD.payload_sha256
    OR NEW.created_at IS NOT OLD.created_at)
BEGIN SELECT RAISE(ABORT,'EXTERNAL_AGENT_TASK_CONFLICT'); END;

CREATE TRIGGER research_external_agent_result_intent_identity_guard
BEFORE UPDATE ON operation_intent
WHEN OLD.intent_id GLOB 'external-task-wake:*' OR NEW.intent_id GLOB 'external-task-wake:*'
BEGIN SELECT RAISE(ABORT,'EXTERNAL_AGENT_TASK_CONFLICT'); END;

INSERT INTO schema_state(key,value,updated_at)
VALUES ('external_agent_result_outbox_generation','external-agent-result-outbox-v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
