import type { WorkflowStep } from "cloudflare:workers";
import { z } from "zod";
import type { WorkflowExternalTaskPreparation } from "./executor.js";
import { externalTaskPlain } from "./external-agent-task-codec.js";
import { externalTaskWakeEventType, parseExternalTaskWakeEvent } from "./external-task-wake-event.js";
import {
  fail, MAX_WORKFLOW_RECEIPT_BYTES, parseRequest, snapshotPrincipal, StageReceiptSchema, textDigest,
  type StageReceipt, type StageRequest, type WorkflowPrincipal,
} from "./types.js";

export const NATIVE_EXTERNAL_TASK_HANDLER_GENERATION = "research-handlers.exploratory.external-wait.v1";
export const NATIVE_EXTERNAL_TASK_STEP_NAMES = Object.freeze({
  prepare: "w2-external-task-08-prepare", wait: "w2-external-task-08-wait", settle: "w2-external-task-08-settle",
});
const reference = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/u);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const preparedShape = {
  operation_id: reference.max(128), stage_index: z.literal(8), attempt_ref: reference.max(128),
  request_sha256: sha256, budget_receipt_ref: reference,
  budget_expires_at_ms: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};
const PreparationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("COMMITTED"), receipt: StageReceiptSchema }).strict(),
  z.object({ kind: z.literal("WAIT"), ...preparedShape, result_sha256: z.null() }).strict(),
  z.object({ kind: z.literal("SETTLE"), ...preparedShape, result_sha256: sha256.nullable() }).strict(),
]);
const PREPARED_FIELDS = new Set(["kind", ...Object.keys(preparedShape), "result_sha256"]);

export interface NativeExternalTaskStepInput {
  readonly step: WorkflowStep;
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
  readonly prepare: (request: StageRequest, principal: WorkflowPrincipal) => Promise<WorkflowExternalTaskPreparation>;
  readonly settle: (
    request: StageRequest,
    principal: WorkflowPrincipal,
    preparation: Exclude<WorkflowExternalTaskPreparation, { readonly kind: "COMMITTED" }>,
    expectedResultSha256?: string,
  ) => Promise<StageReceipt>;
}

function bounded(value: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_WORKFLOW_RECEIPT_BYTES) {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
}

function preparation(raw: unknown): WorkflowExternalTaskPreparation {
  try {
    const plain = externalTaskPlain(raw, "Native external preparation");
    const fields = plain.kind === "COMMITTED" ? new Set(["kind", "receipt"]) : PREPARED_FIELDS;
    const keys = Reflect.ownKeys(plain);
    if (keys.length !== fields.size || keys.some((key) => typeof key !== "string" || !fields.has(key))) {
      return fail("WORKFLOW_OUTPUT_CORRUPT");
    }
    const value = PreparationSchema.parse(plain);
    bounded(value);
    return Object.freeze(value);
  } catch { return fail("WORKFLOW_OUTPUT_CORRUPT"); }
}

function persistedPreparation(raw: unknown): WorkflowExternalTaskPreparation {
  try {
    if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > MAX_WORKFLOW_RECEIPT_BYTES) {
      return fail("WORKFLOW_OUTPUT_CORRUPT");
    }
    const value = preparation(JSON.parse(raw));
    if (JSON.stringify(value) !== raw) return fail("WORKFLOW_OUTPUT_CORRUPT");
    return value;
  } catch { return fail("WORKFLOW_OUTPUT_CORRUPT"); }
}

function receipt(raw: unknown, request: StageRequest, requestDigest: string,
  prepared?: Exclude<WorkflowExternalTaskPreparation, { readonly kind: "COMMITTED" }>): StageReceipt {
  const parsed = StageReceiptSchema.safeParse(raw);
  if (!parsed.success) return fail("WORKFLOW_OUTPUT_CORRUPT");
  const value = parsed.data;
  bounded(value);
  if (value.operation_id !== request.operation_id || value.stage !== request.stage ||
      value.request_sha256 !== requestDigest || value.receipt_ref !== `wcp:${requestDigest}` ||
      value.investigation_ref.id !== request.investigation_ref.id ||
      value.investigation_ref.revision !== request.investigation_ref.revision + 1 ||
      value.input_manifest_ref !== request.input_manifest.object_ref || value.engine_state !== "CHECKPOINTED" ||
      (prepared !== undefined && (value.attempt_ref !== prepared.attempt_ref ||
        value.budget_receipt_ref !== prepared.budget_receipt_ref))) return fail("WORKFLOW_OUTPUT_CORRUPT");
  return value;
}

/** Unactivated R05 graph. Canonical result/currentness and W2 settlement remain injected server responsibilities. */
export async function executeNativeExternalTaskStep(input: NativeExternalTaskStepInput): Promise<StageReceipt> {
  const request = parseRequest(input.request);
  const principal = snapshotPrincipal(input.principal);
  const { step, prepare, settle } = input;
  if (request.stage !== "ANALYZE_BRANCHES" || request.handler_generation !== NATIVE_EXTERNAL_TASK_HANDLER_GENERATION) {
    return fail("WORKFLOW_INPUT_INVALID");
  }
  const requestDigest = await textDigest(JSON.stringify(request));
  const retries = { limit: 0, delay: 0 };
  // Primitive state avoids RPC object disposers becoming wire fields. Validate before and after persistence.
  const rawPrepared = await step.do(NATIVE_EXTERNAL_TASK_STEP_NAMES.prepare, { retries }, async () =>
    JSON.stringify(preparation(await prepare(structuredClone(request), principal))));
  const prepared = persistedPreparation(rawPrepared);
  if (prepared.kind === "COMMITTED") return receipt(prepared.receipt, request, requestDigest);
  if (prepared.operation_id !== request.operation_id || prepared.request_sha256 !== requestDigest ||
      prepared.budget_expires_at_ms > Date.now() + 600_000) return fail("WORKFLOW_OUTPUT_CORRUPT");
  let expectedResultSha256 = prepared.result_sha256 ?? undefined;
  if (prepared.kind === "WAIT") {
    const type = await externalTaskWakeEventType(prepared);
    let payload: unknown;
    let received = false;
    try {
      // Always visit this cached step on resume. A transport wait never extends callback/budget authority.
      const event = await step.waitForEvent(NATIVE_EXTERNAL_TASK_STEP_NAMES.wait, {
        type, timeout: Math.max(1_000, prepared.budget_expires_at_ms - Date.now()),
      });
      payload = event.payload;
      received = true;
    } catch (error) {
      // RPC preserves error fields with enhanced_error_serialization, not custom prototypes.
      // Lifecycle interruptions return to the native engine; only a timeout permits canonical reread.
      if (typeof error !== "object" || error === null || !("name" in error) || error.name !== "WorkflowTimeoutError") {
        throw error;
      }
    }
    if (received) {
      let wake;
      try { wake = parseExternalTaskWakeEvent(payload); } catch { return fail("WORKFLOW_OUTPUT_CORRUPT"); }
      if (wake.operation_id !== prepared.operation_id || wake.stage_index !== prepared.stage_index ||
          wake.attempt_ref !== prepared.attempt_ref || wake.request_sha256 !== prepared.request_sha256) {
        return fail("WORKFLOW_OUTPUT_CORRUPT");
      }
      expectedResultSha256 = wake.result_digest;
    }
  }
  const rawReceipt = await step.do(NATIVE_EXTERNAL_TASK_STEP_NAMES.settle, { retries },
    () => settle(structuredClone(request), principal, prepared, expectedResultSha256));
  return receipt(rawReceipt, request, requestDigest, prepared);
}
