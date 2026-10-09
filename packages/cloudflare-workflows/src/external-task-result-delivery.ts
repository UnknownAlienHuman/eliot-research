import {
  decodeDeliveryMessage, DeliveryRuntimeError, type DeliveryHandler, type DeliveryMessage,
} from "@eliotr/platform-cloudflare";
import { ExternalAgentTaskStore } from "./external-agent-task-store.js";
import {
  EXTERNAL_AGENT_RESULT_WAKE_TOPIC, prepareExternalAgentResultOutbox,
  type ExternalAgentResultOutboxIdentity,
} from "./external-agent-result-outbox.js";
import { externalTaskWakeEventType, parseExternalTaskWakeEvent } from "./external-task-wake-event.js";

interface DeliveryAuthority extends ExternalAgentResultOutboxIdentity {
  readonly outbox_id: string;
  readonly topic: string;
  readonly payload_ref: string;
  readonly payload_sha256: string;
  readonly attempts: number;
  readonly idempotency_key: string;
  readonly created_at: string;
  readonly workflow_state: string;
  readonly next_stage_index: number;
}

export interface ExternalTaskResultDeliveryInput {
  readonly database: D1Database;
  readonly get_instance: (operationId: string) => Promise<Pick<WorkflowInstance, "id" | "sendEvent">>;
}

function invalid(): never {
  throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "External result delivery authority is invalid");
}
function uncertain(): never {
  throw new DeliveryRuntimeError("DELIVERY_SETTLEMENT_UNCERTAIN", "External result delivery is uncertain", true);
}

async function loadAuthority(database: D1Database, message: DeliveryMessage): Promise<DeliveryAuthority> {
  const row = await database.prepare(
    "SELECT o.outbox_id,o.topic,o.payload_ref,o.payload_sha256,o.attempts,o.created_at,i.idempotency_key," +
    "t.task_id,t.operation_id,t.stage_index,t.attempt_ref,t.request_sha256,t.request_json,t.grantee_subject," +
    "r.state AS workflow_state,r.next_stage_index FROM outbox o " +
    "JOIN operation_intent i ON (i.intent_id,i.revision)=(o.intent_id,o.intent_revision) " +
    "JOIN research_external_agent_task_binding t ON t.task_id=i.payload_ref " +
    "JOIN research_workflow_run r ON r.operation_id=t.operation_id WHERE o.outbox_id=?1 LIMIT 1",
  ).bind(message.outbox_id).first<DeliveryAuthority>();
  if (row === null) return uncertain();
  if (row.outbox_id !== message.outbox_id || row.topic !== message.topic ||
      row.topic !== EXTERNAL_AGENT_RESULT_WAKE_TOPIC || row.payload_ref !== message.payload_ref ||
      row.payload_sha256 !== message.payload_sha256 || row.idempotency_key !== message.idempotency_key ||
      !Number.isSafeInteger(row.attempts) || row.attempts < message.outbox_attempt || row.attempts > 10_000 ||
      Date.parse(row.created_at) !== message.created_at_ms ||
      !Number.isSafeInteger(row.next_stage_index) || row.next_stage_index < 0 || row.next_stage_index > 18 ||
      (row.workflow_state !== "ACTIVE" && row.workflow_state !== "CANCELLED" && row.workflow_state !== "ENGINE_COMPLETED")) {
    return invalid();
  }
  return row;
}

/** Unimported R05 composition seam. Inbox owns delivery ACK; the event conveys no business authority. */
export function createExternalTaskResultDeliveryHandler(input: ExternalTaskResultDeliveryInput): DeliveryHandler {
  const { database, get_instance: getInstance } = input;
  const store = new ExternalAgentTaskStore(database);
  return async (rawMessage) => {
    try {
      const message = decodeDeliveryMessage(rawMessage);
      const row = await loadAuthority(database, message);
      const wake = parseExternalTaskWakeEvent({ protocol: "eliotr.external-task-wake.v1",
        task_id: row.task_id, operation_id: row.operation_id, stage_index: row.stage_index,
        attempt_ref: row.attempt_ref, request_sha256: row.request_sha256, result_digest: message.payload_sha256 });
      if (wake.stage_index !== 8) return invalid();
      const recorded = await store.readRecordedResultReadback(wake);
      if (recorded === null) return uncertain();
      if (recorded.result.task_id !== wake.task_id || recorded.result_sha256 !== wake.result_digest) return invalid();
      const plan = await prepareExternalAgentResultOutbox(database, row, recorded.result_sha256, recorded.result.submitted_at);
      if (plan === null || plan.outbox_id !== message.outbox_id) return invalid();
      if (await plan.readback() === null) return uncertain();
      const obsolete = { receipt_ref: `${plan.intent_ref.id}:obsolete` };
      if (row.workflow_state !== "ACTIVE" || row.next_stage_index > wake.stage_index) return obsolete;
      if (row.next_stage_index !== wake.stage_index) return invalid();
      const type = await externalTaskWakeEventType(wake);
      const instance = await getInstance(wake.operation_id);
      if (instance.id !== wake.operation_id) return invalid();
      // Recheck after canonical reads and native instance lookup. This is known-result
      // settlement, not the fresh-effect view that requires an unexpired W2 budget.
      const current = await database.prepare(
        "SELECT operation_id,stage_index,principal_ref,intent_id FROM research_external_agent_result_settlement_authorized " +
        "WHERE operation_id=?1 AND stage_index=?2 AND principal_ref=?3 AND intent_id=?4 LIMIT 1",
      ).bind(wake.operation_id, wake.stage_index, row.grantee_subject, wake.task_id)
        .first<{ operation_id: string; stage_index: number; principal_ref: string; intent_id: string }>();
      if (current === null) return obsolete;
      if (current.operation_id !== wake.operation_id || current.stage_index !== wake.stage_index ||
          current.principal_ref !== row.grantee_subject || current.intent_id !== wake.task_id) return invalid();
      // Lost send ACK may retry only this identical locator. W2 rechecks authority before consuming it.
      await instance.sendEvent({ type, payload: wake });
      return { receipt_ref: `${plan.intent_ref.id}:sent` };
    } catch (error) {
      if (error instanceof DeliveryRuntimeError) throw error;
      return uncertain();
    }
  };
}
