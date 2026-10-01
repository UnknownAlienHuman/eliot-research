from pathlib import Path
from textwrap import dedent

ROOT = Path.cwd()


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(dedent(content).lstrip(), encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}: {old[:160]!r}")
    target.write_text(text.replace(old, new), encoding="utf-8")


write("apps/eliotr-core/src/external-agent-result-wake.ts", r'''
import { ExternalAgentTaskError } from "@eliotr/cloudflare-workflows";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { recoverResearchRun } from "./research-run-control.js";

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
  if (!TASK_ID.test(taskId) || !OPERATION_ID.test(operationId) || !SHA256.test(requestSha) ||
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
  env: Env,
  context: AuthenticatedRequestContext,
  rawReceipt: unknown,
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
  const status = await recoverResearchRun(env, wakeContext, receipt.operation_id, {});
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
''')

replace_once(
    "apps/eliotr-core/src/mcp-external-agent-task.ts",
    'import type { Env } from "./env.js";\n',
    'import type { Env } from "./env.js";\nimport { wakeExternalAgentResultWorkflow } from "./external-agent-result-wake.js";\n',
)
replace_once(
    "apps/eliotr-core/src/mcp-external-agent-task.ts",
    '''      return store.recordResult(taskActor, parsed);\n''',
    '''      const receipt = await store.recordResult(taskActor, parsed);\n      return wakeExternalAgentResultWorkflow(env, context, receipt);\n''',
)

replace_once(
    "apps/eliotr-core/src/research-run-control.ts",
    'import { isSemanticResearchHandlerGeneration } from "./research-stage-handlers.js";\n',
    'import { isSemanticResearchHandlerGeneration, SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION } from "./research-stage-handlers.js";\n',
)
replace_once(
    "apps/eliotr-core/src/research-run-control.ts",
    '''function requireSafeRestart(status: WorkflowRunStatus, handlerGeneration: string): void {\n  const stage = RESEARCH_WORKFLOW_STAGES[status.next_stage_index];\n  if (stage === undefined || (status.current_attempt !== null &&\n      status.current_attempt.stage_index !== status.next_stage_index)) fail("RESEARCH_RUN_STATUS_INVALID", 409);\n  if (status.current_attempt?.state === "STARTED" &&\n      (!isSemanticResearchHandlerGeneration(handlerGeneration) || !RECOVERABLE_STARTED_STAGES.has(stage))) {\n    fail("RESEARCH_RUN_RECOVERY_UNSAFE", 409);\n  }\n}\n''',
    '''export function isRecoverableStartedResearchStage(handlerGeneration: string, stage: string): boolean {\n  return isSemanticResearchHandlerGeneration(handlerGeneration) &&\n    (RECOVERABLE_STARTED_STAGES.has(stage) ||\n      (handlerGeneration === SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION &&\n        stage === "ANALYZE_BRANCHES"));\n}\n\nfunction requireSafeRestart(status: WorkflowRunStatus, handlerGeneration: string): void {\n  const stage = RESEARCH_WORKFLOW_STAGES[status.next_stage_index];\n  if (stage === undefined || (status.current_attempt !== null &&\n      status.current_attempt.stage_index !== status.next_stage_index)) fail("RESEARCH_RUN_STATUS_INVALID", 409);\n  if (status.current_attempt?.state === "STARTED" &&\n      !isRecoverableStartedResearchStage(handlerGeneration, stage)) {\n    fail("RESEARCH_RUN_RECOVERY_UNSAFE", 409);\n  }\n}\n''',
)

replace_once(
    "packages/cloudflare-workflows/src/external-agent-task-store.ts",
    '''interface ProgressRow {\n  task_id: string; cursor: number; lease_id: string; credential_generation: string;\n  progress_json: string; progress_sha256: string; created_at: string;\n}\n''',
    '''interface ProgressRow {\n  task_id: string; cursor: number; lease_id: string; credential_generation: string;\n  progress_json: string; progress_sha256: string; created_at: string;\n}\ninterface WorkflowSettlementRow {\n  state: "ACTIVE" | "CANCELLED" | "ENGINE_COMPLETED";\n  next_stage_index: number;\n}\ninterface WorkflowSettlement extends WorkflowSettlementRow {\n  settled: boolean;\n}\n''',
)
replace_once(
    "packages/cloudflare-workflows/src/external-agent-task-store.ts",
    '''  async #progress(task: string, cursor: number): Promise<ProgressRow | null> {\n    try { return await this.#db.prepare("SELECT * FROM research_external_agent_task_progress WHERE task_id=?1 AND cursor=?2 LIMIT 1")\n      .bind(task, cursor).first<ProgressRow>(); }\n    catch { fail("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503, "External task progress read is unavailable", true); }\n  }\n\n''',
    '''  async #progress(task: string, cursor: number): Promise<ProgressRow | null> {\n    try { return await this.#db.prepare("SELECT * FROM research_external_agent_task_progress WHERE task_id=?1 AND cursor=?2 LIMIT 1")\n      .bind(task, cursor).first<ProgressRow>(); }\n    catch { fail("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503, "External task progress read is unavailable", true); }\n  }\n  async #workflowSettlement(row: TaskRow): Promise<WorkflowSettlement> {\n    let status: WorkflowSettlementRow | null;\n    try {\n      status = await this.#db.prepare(\n        "SELECT state,next_stage_index FROM research_workflow_run WHERE operation_id=?1 LIMIT 1",\n      ).bind(row.operation_id).first<WorkflowSettlementRow>();\n    } catch {\n      fail("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503,\n        "External task workflow settlement read is unavailable", true);\n    }\n    if (status === null ||\n        (status.state !== "ACTIVE" && status.state !== "CANCELLED" &&\n          status.state !== "ENGINE_COMPLETED") ||\n        !Number.isSafeInteger(status.next_stage_index) || status.next_stage_index < 0 ||\n        status.next_stage_index > RESEARCH_WORKFLOW_STAGES.length ||\n        (status.state === "ACTIVE" && status.next_stage_index < row.stage_index)) {\n      fail("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500,\n        "External task workflow settlement is corrupt");\n    }\n    return Object.freeze({\n      ...status,\n      settled: status.state === "ENGINE_COMPLETED" ||\n        status.next_stage_index > row.stage_index,\n    });\n  }\n\n''',
)
replace_once(
    "packages/cloudflare-workflows/src/external-agent-task-store.ts",
    '''    return Object.freeze({ protocol: "eliotr.external-agent-result-receipt.v1", task_id: row.task_id,\n      operation_id: row.operation_id, stage_index: row.stage_index, stage: row.stage,\n      attempt_ref: row.attempt_ref, request_sha256: row.request_sha256, lease_id: row.lease_id,\n      idempotency_key: row.result_idempotency_key, disposition: envelope.disposition,\n      worker_slot: row.lease_slot, result_sha256: row.result_sha256, submitted_at: envelope.submitted_at,\n      delivery_state: row.state, workflow_settled: false });\n''',
    '''    const settlement = await this.#workflowSettlement(row);\n    return Object.freeze({ protocol: "eliotr.external-agent-result-receipt.v1", task_id: row.task_id,\n      operation_id: row.operation_id, stage_index: row.stage_index, stage: row.stage,\n      attempt_ref: row.attempt_ref, request_sha256: row.request_sha256, lease_id: row.lease_id,\n      idempotency_key: row.result_idempotency_key, disposition: envelope.disposition,\n      worker_slot: row.lease_slot, result_sha256: row.result_sha256, submitted_at: envelope.submitted_at,\n      delivery_state: row.state, workflow_state: settlement.state,\n      workflow_next_stage_index: settlement.next_stage_index, workflow_settled: settlement.settled });\n''',
)
replace_once(
    "packages/cloudflare-workflows/src/external-agent-task-store.ts",
    '''    let result: Readonly<Record<string, unknown>> | null = null;\n    if (row.state === "RESULT_RECORDED" && row.result_json !== null && row.result_sha256 !== null) {\n      const envelope = decodeExternalAgentRecordedResult(row);\n      result = Object.freeze({ disposition: envelope.disposition, result_sha256: row.result_sha256,\n        idempotency_key: row.result_idempotency_key, submitted_at: envelope.submitted_at, workflow_settled: false });\n    }\n    return Object.freeze({ protocol: "eliotr.external-agent-task-status.v1", task_id: row.task_id,\n      operation_id: row.operation_id, stage_index: row.stage_index, stage: row.stage,\n      attempt_ref: row.attempt_ref, request_sha256: row.request_sha256, project_id: row.project_id,\n      delivery_state: row.state, effective_state: row.workflow_state === "CANCELLED" ? "CANCELLED" : row.state,\n      workflow_state: row.workflow_state, cancellation_receipt_ref: row.cancellation_receipt_ref,\n      lease: row.lease_id === null ? null : Object.freeze({ lease_id: row.lease_id, worker_slot: row.lease_slot,\n        revision: row.lease_revision, expires_at: row.lease_expires_at }),\n      latest_progress: latest === null ? null : Object.freeze({ cursor: latest.cursor,\n        progress_sha256: latest.progress_sha256, recorded_at: latest.created_at }), result });\n''',
    '''    const settlement = await this.#workflowSettlement(row);\n    let result: Readonly<Record<string, unknown>> | null = null;\n    if (row.state === "RESULT_RECORDED" && row.result_json !== null && row.result_sha256 !== null) {\n      const envelope = decodeExternalAgentRecordedResult(row);\n      result = Object.freeze({ disposition: envelope.disposition, result_sha256: row.result_sha256,\n        idempotency_key: row.result_idempotency_key, submitted_at: envelope.submitted_at,\n        workflow_state: settlement.state, workflow_next_stage_index: settlement.next_stage_index,\n        workflow_settled: settlement.settled });\n    }\n    return Object.freeze({ protocol: "eliotr.external-agent-task-status.v1", task_id: row.task_id,\n      operation_id: row.operation_id, stage_index: row.stage_index, stage: row.stage,\n      attempt_ref: row.attempt_ref, request_sha256: row.request_sha256, project_id: row.project_id,\n      delivery_state: row.state, effective_state: settlement.state === "CANCELLED" ? "CANCELLED" : row.state,\n      workflow_state: settlement.state, workflow_next_stage_index: settlement.next_stage_index,\n      workflow_settled: settlement.settled, cancellation_receipt_ref: row.cancellation_receipt_ref,\n      lease: row.lease_id === null ? null : Object.freeze({ lease_id: row.lease_id, worker_slot: row.lease_slot,\n        revision: row.lease_revision, expires_at: row.lease_expires_at }),\n      latest_progress: latest === null ? null : Object.freeze({ cursor: latest.cursor,\n        progress_sha256: latest.progress_sha256, recorded_at: latest.created_at }), result });\n''',
)

replace_once(
    "packages/cloudflare-research/src/research-external-branch-analysis.ts",
    '        "After eliotr_task_result succeeds, call the existing recover operation for this same workflow instance.",\n',
    '        "After eliotr_task_result readback, Core attempts the existing recover operation automatically with key agent-recover-<first 24 request_sha256 hex>; use that exact key only as a manual fallback after an unconfirmed wake.",\n',
)

replace_once(
    "packages/cloudflare-workspace-mcp/src/gemini-mcp-research-tools.ts",
    '    description: "Record an idempotent subscription-agent callback for the exact live lease. Repeat the same idempotency key and semantic result after a lost acknowledgement. The receipt explicitly reports workflow_settled=false: a later stage-specific consumer must validate and commit through the existing W1/W2 authority.",\n',
    '    description: "Record an idempotent subscription-agent callback for the exact live lease. After durable readback Core attempts the existing recover action with deterministic key agent-recover-<first 24 request_sha256 hex>. Repeat the same result after an uncertain response; manual recover is only a fallback with that exact key. workflow_settled becomes true only after the stage-specific consumer validates and W2/W1 advances.",\n',
)
replace_once(
    "packages/cloudflare-workspace-mcp/src/gemini-mcp-research-tools.ts",
    '    description: "Read delivery, lease, latest progress, callback digest and workflow cancellation for one task bound to this exact grant revision. It never renews a lease or converts a recorded callback into a Research stage result.",\n',
    '    description: "Read delivery, lease, latest progress, callback digest, canonical next-stage settlement and workflow cancellation for one task bound to this exact grant revision. It never renews a lease or converts a recorded callback into a Research stage result.",\n',
)

replace_once(
    "apps/eliotr-pwa/src/pages/agent-inbox.astro",
    '''              <h2>Result</h2>\n''',
    '''              <h2>Result and automatic wake</h2>\n''',
)
replace_once(
    "apps/eliotr-pwa/src/pages/agent-inbox.astro",
    '''            <h2 id="recover-heading">Canonical recovery</h2>\n          </div>\n          <button id="recover-run" class="button button--danger" type="button" data-request>Recover workflow</button>\n        </div>\n        <p class="help">\n          A recorded callback is delivery evidence only. Recovery validates it and settles the existing\n          W2/W1 authority; it does not create a replacement run.\n        </p>\n''',
    '''            <h2 id="recover-heading">Manual recovery fallback</h2>\n          </div>\n          <button id="recover-run" class="button button--danger" type="button" data-request>Retry canonical wake</button>\n        </div>\n        <p class="help">\n          Result submission automatically invokes the existing recovery path after durable callback readback.\n          Use this fallback only when that wake is unconfirmed, preserving the prefilled deterministic key.\n          Recovery validates the callback and settles W2/W1; it never creates a replacement run.\n        </p>\n''',
)

replace_once(
    "docs/implementation/computer-agent-web-inbox.md",
    '''6. Submit the result with one stable idempotency key.\n7. Invoke recovery with the existing workflow ID and one stable recovery idempotency key.\n8. Read task status to reconcile uncertain responses.\n\nThe result receipt remains `workflow_settled=false` until the existing recovery path validates the callback,\nreopens selected evidence and commits the W2/W1 checkpoint.\n''',
    '''6. Submit the result with one stable idempotency key. After durable result readback, Core invokes the\n   existing recovery path using `agent-recover-<first 24 request_sha256 hex>`.\n7. If result/wake acknowledgement is uncertain, repeat the exact result. Use the manual recovery control only\n   as a fallback with that same deterministic key; a different key conflicts with the durable recovery journal.\n8. Read task status to reconcile delivery and canonical settlement.\n\n`workflow_settled` remains false while the same workflow is merely active. It becomes true only after the\nstage-specific consumer reopens selected evidence, validates the callback and advances W2/W1.\n''',
)
replace_once(
    "docs/implementation/computer-agent-web-inbox.md",
    '''- automatic Workflow wake-up after callback;\n''',
    '''- deployment/live qualification of automatic Workflow wake-up after callback;\n''',
)

replace_once(
    "docs/implementation/muse-operator-runbook.md",
    '''6. After the result receipt (`workflow_settled=false`), call the existing `eliotr_recover` for the same\n   workflow ID and grant. Recovery reads the exact callback, re-resolves every selected handle under current\n   scope/evidence authority, derives the canonical branch checkpoint server-side, and settles through W2/W1.\n7. Use `eliotr_task_status` to inspect delivery state, lease, progress digest, callback digest and workflow\n   cancellation. It does not renew a lease or settle the stage.\n''',
    '''6. After durable result readback, Core automatically invokes the existing recovery action with\n   `agent-recover-<first 24 request_sha256 hex>`. Recovery reads the exact callback, re-resolves every selected\n   handle under current scope/evidence authority, derives the canonical branch checkpoint server-side and\n   settles through W2/W1. If acknowledgement is uncertain, repeat the exact result; use manual recover only\n   as a fallback with that same deterministic key.\n7. Use `eliotr_task_status` to inspect delivery state, lease, progress digest, callback digest, canonical\n   next-stage settlement and workflow cancellation. It does not renew a lease or settle the stage itself.\n''',
)
replace_once(
    "docs/implementation/muse-operator-runbook.md",
    '''5. Pull the Stage 8 task only after the workflow publishes it, submit the callback, then recover through the\n   existing W2/W1 path.\n''',
    '''5. Pull the Stage 8 task only after the workflow publishes it and submit the callback. Core attempts the\n   existing W2/W1 recovery automatically; preserve the deterministic recovery key for fallback reconciliation.\n''',
)

replace_once(
    "docs/adr/0007-external-agents-and-cloudflare-evolution.md",
    '''A callback is delivery evidence until the stage-specific consumer validates it. The first handler call\npublishes and leaves the W2 attempt STARTED; after `eliotr_task_result`, the originating agent calls the\nexisting recovery operation. Recovery reads the exact recorded callback and commits through existing\nW2/W1 authority. Task deadlines may outlive the original ten-minute W2 reservation, but do not outlive\n''',
    '''A callback is delivery evidence until the stage-specific consumer validates it. The first handler call\npublishes and leaves the W2 attempt STARTED. After durable `eliotr_task_result` readback, Core invokes the\nexisting recovery operation with a request-digest-derived idempotency key; the same key remains the manual\nfallback after an unconfirmed wake. The v8 `ANALYZE_BRANCHES` STARTED attempt is restart-safe only because\nits dedicated recovery handler reads the exact recorded callback before producing canonical bytes. Recovery\ncommits through existing W2/W1 authority. Task deadlines may outlive the original ten-minute W2 reservation, but do not outlive\n''',
)
replace_once(
    "docs/adr/0007-external-agents-and-cloudflare-evolution.md",
    '''provider-native inference transports, safe connection removal, automatic cross-agent failover and live\nSpark/Muse/Dot qualification remain pending. Exact owner-selected dispatch is implemented in source, and\n''',
    '''provider-native inference transports, safe connection removal, automatic cross-agent failover and live\nSpark/Muse/Dot qualification remain pending. Automatic same-workflow callback wake is implemented in source;\nexact owner-selected dispatch is implemented in source, and\n''',
)
