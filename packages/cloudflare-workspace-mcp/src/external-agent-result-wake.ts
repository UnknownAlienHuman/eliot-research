import { ExternalAgentTaskError } from "@eliotr/cloudflare-workflows";
import { ResearchWorkflowStageSchema } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";

const SHA256 = /^[a-f0-9]{64}$/u;
const TASK_ID = /^external-task:[a-f0-9]{64}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const RECEIPT_FIELDS = new Set([
  "protocol", "task_id", "operation_id", "stage_index", "stage", "attempt_ref",
  "request_sha256", "lease_id", "idempotency_key", "disposition", "worker_slot",
  "result_sha256", "submitted_at", "delivery_state", "workflow_state",
  "workflow_next_stage_index", "workflow_settled",
]);

interface ExternalAgentResultReceipt {
  readonly [key: string]: unknown;
  readonly protocol: "eliotr.external-agent-result-receipt.v1";
  readonly task_id: string;
  readonly operation_id: string;
  readonly stage_index: number;
  readonly stage: string;
  readonly attempt_ref: string;
  readonly request_sha256: string;
  readonly lease_id: string;
  readonly idempotency_key: string;
  readonly disposition: "SUCCEEDED" | "PARTIAL" | "FAILED";
  readonly worker_slot: string | null;
  readonly result_sha256: string;
  readonly submitted_at: string;
  readonly delivery_state: "RESULT_RECORDED";
  readonly workflow_state: "ACTIVE" | "CANCELLED" | "ENGINE_COMPLETED";
  readonly workflow_next_stage_index: number;
  readonly workflow_settled: boolean;
}

function corrupt(message: string): never {
  throw new ExternalAgentTaskError("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500, message);
}
function plain(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return corrupt("External-agent result receipt is not an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return corrupt("External-agent result receipt is not a plain object");
  }
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    return corrupt(`${label} is corrupt`);
  }
  return value;
}

export function externalAgentRecoveryKey(requestSha256: string): string {
  if (!SHA256.test(requestSha256)) return corrupt("External-agent request digest is corrupt");
  return `agent-recover-${requestSha256.slice(0, 24)}`;
}

export function parseExternalAgentResultReceipt(value: unknown): ExternalAgentResultReceipt {
  const receipt = plain(value);
  if (Object.keys(receipt).some((field) => !RECEIPT_FIELDS.has(field)) ||
      [...RECEIPT_FIELDS].some((field) => !Object.hasOwn(receipt, field))) {
    return corrupt("External-agent result receipt has unknown or missing fields");
  }
  const taskId = string(receipt.task_id, "task_id", 128);
  const operationId = string(receipt.operation_id, "operation_id", 128);
  const requestSha = string(receipt.request_sha256, "request_sha256", 64);
  const resultSha = string(receipt.result_sha256, "result_sha256", 64);
  const stage = string(receipt.stage, "stage", 64);
  const attemptRef = string(receipt.attempt_ref, "attempt_ref", 128);
  const leaseId = string(receipt.lease_id, "lease_id", 128);
  const idempotencyKey = string(receipt.idempotency_key, "idempotency_key", 256);
  const submittedAt = string(receipt.submitted_at, "submitted_at", 64);
  if (receipt.protocol !== "eliotr.external-agent-result-receipt.v1" ||
      !TASK_ID.test(taskId) || !OPERATION_ID.test(operationId) || !SHA256.test(requestSha) ||
      taskId !== `external-task:${requestSha}` || !SHA256.test(resultSha) ||
      !Number.isSafeInteger(receipt.stage_index) || (receipt.stage_index as number) < 0 ||
      (receipt.stage_index as number) > 17 || !Number.isFinite(Date.parse(submittedAt)) ||
      receipt.delivery_state !== "RESULT_RECORDED" ||
      (receipt.workflow_state !== "ACTIVE" && receipt.workflow_state !== "CANCELLED" &&
        receipt.workflow_state !== "ENGINE_COMPLETED") ||
      !Number.isSafeInteger(receipt.workflow_next_stage_index) ||
      (receipt.workflow_next_stage_index as number) < 0 ||
      (receipt.workflow_next_stage_index as number) > 18 ||
      typeof receipt.workflow_settled !== "boolean" ||
      (receipt.disposition !== "SUCCEEDED" && receipt.disposition !== "PARTIAL" &&
        receipt.disposition !== "FAILED") ||
      (receipt.worker_slot !== null && typeof receipt.worker_slot !== "string")) {
    return corrupt("External-agent result receipt identity is corrupt");
  }
  const stageIndex = receipt.stage_index as number;
  if (ResearchWorkflowStageSchema.options[stageIndex] !== stage) {
    return corrupt("External-agent result stage binding is corrupt");
  }
  const nextStage = receipt.workflow_next_stage_index as number;
  const expectedSettlement = receipt.workflow_state === "ENGINE_COMPLETED" || nextStage > stageIndex;
  if (receipt.workflow_settled !== expectedSettlement ||
      (receipt.workflow_state === "ACTIVE" && nextStage < stageIndex)) {
    return corrupt("External-agent workflow settlement is inconsistent");
  }
  return Object.freeze({
    protocol: "eliotr.external-agent-result-receipt.v1",
    task_id: taskId,
    operation_id: operationId,
    stage_index: stageIndex,
    stage,
    attempt_ref: attemptRef,
    request_sha256: requestSha,
    lease_id: leaseId,
    idempotency_key: idempotencyKey,
    disposition: receipt.disposition,
    worker_slot: receipt.worker_slot,
    result_sha256: resultSha,
    submitted_at: submittedAt,
    delivery_state: "RESULT_RECORDED",
    workflow_state: receipt.workflow_state,
    workflow_next_stage_index: nextStage,
    workflow_settled: receipt.workflow_settled,
  });
}

/**
 * Wake the same canonical Workflow after durable callback readback. The existing
 * recovery journal owns idempotency; this helper creates no scheduler or stage
 * authority. A retry reuses the digest-derived recovery key.
 */
export async function wakeExternalAgentResultWorkflow(
  context: AuthenticatedRequestContext,
  rawReceipt: unknown,
  recoverRun: (context: AuthenticatedRequestContext, operationId: string) => Promise<{
    readonly workflow_instance_id: string;
    readonly next_stage_index: number;
    readonly execution_state: "ACTIVE" | "CANCELLED" | "ENGINE_COMPLETED";
    readonly investigation_ref: unknown;
    readonly engine_status?: string;
  }>,
): Promise<Readonly<Record<string, unknown>>> {
  const receipt = parseExternalAgentResultReceipt(rawReceipt);
  if (receipt.workflow_settled) return receipt;
  if (receipt.workflow_state !== "ACTIVE" ||
      receipt.workflow_next_stage_index !== receipt.stage_index) {
    return corrupt("External-agent result cannot wake this workflow state");
  }
  const recoveryKey = externalAgentRecoveryKey(receipt.request_sha256);
  const headers = new Headers(context.request.headers);
  headers.set("Idempotency-Key", recoveryKey);
  headers.set("Content-Type", "application/json");
  const wakeContext: AuthenticatedRequestContext = {
    ...context,
    request: new Request(context.request.url, {
      method: "POST",
      headers,
      signal: context.request.signal,
    }),
  };
  const status = await recoverRun(wakeContext, receipt.operation_id);
  if (status.workflow_instance_id !== receipt.operation_id ||
      !Number.isSafeInteger(status.next_stage_index) ||
      status.next_stage_index < receipt.stage_index || status.next_stage_index > 18) {
    return corrupt("Research recovery returned a conflicting workflow identity");
  }
  const settled = status.execution_state === "ENGINE_COMPLETED" ||
    status.next_stage_index > receipt.stage_index;
  return Object.freeze({
    ...receipt,
    workflow_state: status.execution_state,
    workflow_next_stage_index: status.next_stage_index,
    workflow_settled: settled,
    workflow_wake: Object.freeze({
      protocol: "eliotr.external-agent-workflow-wake.v1",
      recovery_idempotency_key: recoveryKey,
      workflow_instance_id: status.workflow_instance_id,
      investigation_ref: status.investigation_ref,
      execution_state: status.execution_state,
      ...(status.engine_status === undefined ? {} : { engine_status: status.engine_status }),
      next_stage_index: status.next_stage_index,
      state: settled ? "SETTLED" : "ACTIVE",
    }),
  });
}
