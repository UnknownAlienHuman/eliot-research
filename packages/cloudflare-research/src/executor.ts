// IMPLEMENTED_NOT_LIVE: ER-09 durable single-stage D1/R2 checkpoints; governed handlers, public Workflow composition and live qualification remain separate.
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import { WorkflowCheckpointStore } from "./store.js";
import { readWorkflowObject, writeWorkflowObject } from "./objects.js";
import {
  digest, fail, MAX_WORKFLOW_OUTPUT_BYTES, MAX_WORKFLOW_RECEIPT_BYTES, parseRequest, snapshotPrincipal, textDigest, WorkflowCheckpointError, WorkflowObjectSchema,
  type StageReceipt, type StageRequest, type WorkflowBudgetGrant, type WorkflowExecutionPorts,
  type WorkflowObject, type WorkflowPrincipal, type WorkflowStageHandler,
} from "./types.js";
import type { ResearchWorkflowStage } from "@eliotr/contracts";

/** One reservation admits at most ONE handler invocation. Unknown execution is never auto-retried. */
export function createWorkflowCheckpointExecutor(
  database: D1Database, bucket: R2Bucket, ports: WorkflowExecutionPorts,
) {
  const store = new WorkflowCheckpointStore(database);
  async function guard(request: StageRequest, principal: WorkflowPrincipal, expected?: WorkflowBudgetGrant): Promise<WorkflowBudgetGrant> {
    if (principal.signal?.aborted) {
      await store.cancel(request.operation_id, principal);
      fail("WORKFLOW_CANCELLED");
    }
    await store.current(request, principal);
    await ports.authorizeResidency(request, principal);
    const rawBudget = await ports.checkBudget(request, principal);
    const budget = Object.freeze({ receipt_ref: rawBudget.receipt_ref, expires_at_ms: rawBudget.expires_at_ms });
    if (typeof budget.receipt_ref !== "string" || budget.receipt_ref.length < 1 || budget.receipt_ref.length > 256 ||
        !Number.isSafeInteger(budget.expires_at_ms) || budget.expires_at_ms <= Date.now() ||
        budget.expires_at_ms > Date.now() + 600_000) fail("WORKFLOW_BUDGET_STOP");
    if (expected !== undefined && (expected.receipt_ref !== budget.receipt_ref || expected.expires_at_ms !== budget.expires_at_ms)) {
      fail("WORKFLOW_BUDGET_STOP");
    }
    await store.current(request, principal);
    if (principal.signal?.aborted) {
      await store.cancel(request.operation_id, principal);
      fail("WORKFLOW_CANCELLED");
    }
    return budget;
  }
  async function finishReadback(request: StageRequest, principal: WorkflowPrincipal, receipt: StageReceipt): Promise<StageReceipt> {
    // Replaying already-paid work never needs a fresh spending reservation.
    await store.current(request, principal);
    await ports.authorizeResidency(request, principal);
    await readWorkflowObject(bucket, receipt.output_manifest, true);
    await store.current(request, principal);
    if (principal.signal?.aborted) {
      try { await store.cancel(request.operation_id, principal); } catch (error) {
        if (!(error instanceof WorkflowCheckpointError) || error.code !== "WORKFLOW_CONFLICT") throw error;
      }
      fail("WORKFLOW_CANCELLED");
    }
    return receipt;
  }
  return {
    async execute(raw: unknown, actor: WorkflowPrincipal, handler: WorkflowStageHandler): Promise<StageReceipt> {
      const request = parseRequest(raw);
      const principal = snapshotPrincipal(actor);
      // Snapshot caller-owned objects before any await; neither a handler nor a browser can rebind this operation.
      if (principal.signal?.aborted) {
        // A pre-existing run must retain cancellation; no new run is created for a pre-aborted request.
        try { await store.cancel(request.operation_id, principal); } catch (error) {
          if (!(error instanceof WorkflowCheckpointError) || error.code !== "WORKFLOW_CONFLICT") throw error;
        }
        fail("WORKFLOW_CANCELLED");
      }
      await ports.authorizeResidency(request, principal);
      await store.ensureRun(request, principal);
      const requestDigest = await textDigest(JSON.stringify(request));
      let attempt = await store.attempt(request, requestDigest);
      const previous = await store.receipt(request, requestDigest);
      if (previous !== null) return finishReadback(request, principal, previous);
      const pinned = attempt === null ? undefined : {
        receipt_ref: attempt.budget_receipt_ref, expires_at_ms: attempt.budget_expires_at_ms,
      };
      const budget = await guard(request, principal, pinned);
      let output: WorkflowObject;
      if (attempt === null) {
        const inputBytes = await readWorkflowObject(bucket, request.input_manifest);
        await guard(request, principal, budget);
        const nonce = crypto.randomUUID();
        attempt = await store.reserve(request, requestDigest, nonce, budget);
        if (attempt.attempt_ref !== nonce) fail("WORKFLOW_EFFECT_UNCERTAIN");
        await guard(request, principal, budget);
        // STARTED is durable before the handler. A crash/throw here requires W3 reconciliation, not another call.
        let bytes: Uint8Array;
        try {
          bytes = await handler({
            request: structuredClone(request), input_bytes: inputBytes, attempt_ref: attempt.attempt_ref,
            budget_receipt_ref: attempt.budget_receipt_ref,
            ...(principal.signal === undefined ? {} : { signal: principal.signal }),
          });
        } catch {
          if (principal.signal?.aborted) {
            await store.cancel(request.operation_id, principal);
            fail("WORKFLOW_CANCELLED");
          }
          fail("WORKFLOW_EFFECT_UNCERTAIN");
        }
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_WORKFLOW_OUTPUT_BYTES) fail("WORKFLOW_INPUT_INVALID");
        bytes = new Uint8Array(bytes);
        const hash = await digest(bytes);
        output = WorkflowObjectSchema.parse({
          object_ref: `workflow/${requestDigest}/${attempt.attempt_ref}`, sha256: hash, byte_length: bytes.byteLength,
          residency: { ...request.input_manifest.residency, content_digest: { algorithm: "sha256", digest: hash } },
        });
        await guard(request, principal, budget);
        await store.recordOutput(request, attempt, output);
        await guard(request, principal, budget);
        await writeWorkflowObject(bucket, output, bytes);
      } else {
        if (attempt.state === "STARTED" || attempt.output_json === null) {
          const recoverStartedAttempt = ports.recoverStartedAttempt;
          if (recoverStartedAttempt === undefined) fail("WORKFLOW_EFFECT_UNCERTAIN");
          let recovered: Uint8Array | null;
          try {
            recovered = await recoverStartedAttempt(Object.freeze({
              request, stage_index: RESEARCH_WORKFLOW_STAGES.indexOf(request.stage), request_sha256: attempt.request_sha256,
              attempt_ref: attempt.attempt_ref, expected_revision: attempt.expected_revision,
              output_object_ref: `workflow/${requestDigest}/${attempt.attempt_ref}`,
              budget_receipt_ref: attempt.budget_receipt_ref, budget_expires_at_ms: attempt.budget_expires_at_ms,
            }));
          } catch {
            fail("WORKFLOW_EFFECT_UNCERTAIN");
          }
          if (recovered === null) fail("WORKFLOW_EFFECT_UNCERTAIN");
          if (!(recovered instanceof Uint8Array) || recovered.byteLength > MAX_WORKFLOW_OUTPUT_BYTES) {
            fail("WORKFLOW_OUTPUT_CORRUPT");
          }
          const recoveredBytes = new Uint8Array(recovered);
          const recoveredDigest = await digest(recoveredBytes);
          try {
            output = WorkflowObjectSchema.parse({
              object_ref: `workflow/${requestDigest}/${attempt.attempt_ref}`, sha256: recoveredDigest,
              byte_length: recoveredBytes.byteLength,
              residency: { ...request.input_manifest.residency, content_digest: { algorithm: "sha256", digest: recoveredDigest } },
            });
          } catch { return fail("WORKFLOW_OUTPUT_CORRUPT"); }
          await guard(request, principal, budget);
          // Recovery returns bytes from a durably known model result; publish them through the normal immutable W2 path.
          await store.recordOutput(request, attempt, output);
          await guard(request, principal, budget);
          await writeWorkflowObject(bucket, output, recoveredBytes);
        } else {
          try { output = WorkflowObjectSchema.parse(JSON.parse(attempt.output_json)); }
          catch { return fail("WORKFLOW_OUTPUT_CORRUPT"); }
          // Lost output/checkpoint ACK: recover exact persisted bytes without invoking the handler.
          await readWorkflowObject(bucket, output, true);
        }
      }
      await guard(request, principal, budget);
      const receipt = await store.commit(request, attempt, output);
      return finishReadback(request, principal, receipt);
    },
    cancel(operationId: string, principal: WorkflowPrincipal): Promise<string> {
      return store.cancel(operationId, snapshotPrincipal(principal));
    },
  };
}

export interface MonotoneOperationParams {
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly initial_revision: number;
  readonly idempotency_key: string;
  readonly handler_generation: string;
  readonly initial_input_manifest: WorkflowObject;
}

export type MonotoneHandlerFactory = (stage: ResearchWorkflowStage) => WorkflowStageHandler;

function assertStepReceiptWithinBounds(receipt: StageReceipt): void {
  const text = JSON.stringify(receipt);
  if (new TextEncoder().encode(text).byteLength > MAX_WORKFLOW_RECEIPT_BYTES) fail("WORKFLOW_INPUT_INVALID");
  if ("completion_disposition" in receipt) fail("WORKFLOW_INPUT_INVALID");
}

/** W2 monotone bounded executor: sequential 18-stage walk reusing the W2a checkpoint boundary. */
export function createMonotoneStageExecutor(
  database: D1Database, bucket: R2Bucket, ports: WorkflowExecutionPorts,
) {
  const single = createWorkflowCheckpointExecutor(database, bucket, ports);
  return {
    async executeOperation(
      params: MonotoneOperationParams, actor: WorkflowPrincipal, handlers: MonotoneHandlerFactory,
    ): Promise<StageReceipt[]> {
      const principal = snapshotPrincipal(actor);
      if (typeof params.operation_id !== "string" || typeof params.investigation_id !== "string" ||
          typeof params.idempotency_key !== "string" || typeof params.handler_generation !== "string" ||
          !Number.isSafeInteger(params.initial_revision) || params.initial_revision < 1) {
        fail("WORKFLOW_INPUT_INVALID");
      }
      WorkflowObjectSchema.parse(params.initial_input_manifest);
      const receipts: StageReceipt[] = [];
      let investigation_ref = { id: params.investigation_id, revision: params.initial_revision };
      let input_manifest = params.initial_input_manifest;
      for (let index = 0; index < RESEARCH_WORKFLOW_STAGES.length; index += 1) {
        const stage = RESEARCH_WORKFLOW_STAGES[index] as ResearchWorkflowStage;
        const request: StageRequest = {
          protocol: "eliotr.workflow-stage.v1",
          operation_id: params.operation_id,
          investigation_ref: { ...investigation_ref },
          stage,
          idempotency_key: params.idempotency_key,
          handler_generation: params.handler_generation,
          input_manifest,
        };
        const handler = handlers(stage);
        if (typeof handler !== "function") fail("WORKFLOW_INPUT_INVALID");
        const receipt = await single.execute(request, principal, handler);
        if (receipt.operation_id !== params.operation_id || receipt.stage !== stage ||
            receipt.investigation_ref.id !== params.investigation_id) {
          fail("WORKFLOW_OUTPUT_CORRUPT");
        }
        assertStepReceiptWithinBounds(receipt);
        const expectedEngine = index === RESEARCH_WORKFLOW_STAGES.length - 1 ? "ENGINE_COMPLETED" : "CHECKPOINTED";
        if (receipt.engine_state !== expectedEngine) fail("WORKFLOW_OUTPUT_CORRUPT");
        receipts.push(receipt);
        investigation_ref = { ...receipt.investigation_ref };
        input_manifest = receipt.output_manifest;
      }
      return receipts;
    },
    cancel(operationId: string, principal: WorkflowPrincipal): Promise<string> {
      return single.cancel(operationId, principal);
    },
  };
}
