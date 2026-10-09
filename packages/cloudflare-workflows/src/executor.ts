// IMPLEMENTED_NOT_LIVE: ER-09 durable single-stage D1/R2 checkpoints; governed handlers, public Workflow composition and live qualification remain separate.
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import { WorkflowCheckpointStore, type AttemptRow } from "./store.js";
import { readWorkflowObject, writeWorkflowObject } from "./objects.js";
import {
  digest, fail, MAX_WORKFLOW_OUTPUT_BYTES, MAX_WORKFLOW_RECEIPT_BYTES, parseRequest, snapshotPrincipal, textDigest, WorkflowCheckpointError, WorkflowObjectSchema,
  type StageReceipt, type StageRequest, type WorkflowBudgetGrant, type WorkflowExecutionPorts,
  type WorkflowNativeStageHandler, type WorkflowNativeStagePolicy, type WorkflowNativeStageReceipt,
  type WorkflowObject, type WorkflowPrincipal, type WorkflowStageHandler, type WorkflowAttemptRecoveryInput,
} from "./types.js";
import type { ResearchWorkflowStage } from "@eliotr/contracts";
import { workflowFailure, retainWorkflowFailure, type WorkflowFailure } from "./failures.js";
import { ExternalAgentTaskStore } from "./external-agent-task-store.js";

/** Internal same-task publication port. It must not invoke an external computer/model effect. */
export type WorkflowExternalTaskPrepare = (input: {
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
  readonly input_bytes: Uint8Array;
  readonly attempt_ref: string;
  readonly request_sha256: string;
  readonly budget_receipt_ref: string;
}) => Promise<void>;

export type WorkflowExternalTaskPreparation =
  | { readonly kind: "COMMITTED"; readonly receipt: StageReceipt }
  | {
    readonly kind: "WAIT" | "SETTLE";
    readonly operation_id: string;
    readonly stage_index: 8;
    readonly attempt_ref: string;
    readonly request_sha256: string;
    readonly budget_receipt_ref: string;
    readonly budget_expires_at_ms: number;
    readonly result_sha256: string | null;
  };

/** One exact recovery identity shared by canonical readback and the existing W2 executor. */
export function workflowAttemptRecoveryInput(
  request: StageRequest, principal: WorkflowPrincipal, attempt: AttemptRow, existing?: WorkflowObject,
): WorkflowAttemptRecoveryInput {
  return Object.freeze({ request, principal_ref: principal.principal_ref,
    credential_generation: principal.credential_generation, deployment_generation: principal.deployment_generation,
    stage_index: RESEARCH_WORKFLOW_STAGES.indexOf(request.stage), request_sha256: attempt.request_sha256,
    attempt_ref: attempt.attempt_ref, expected_revision: attempt.expected_revision,
    output_object_ref: existing?.object_ref ?? `workflow/${attempt.request_sha256}/${attempt.attempt_ref}`,
    budget_receipt_ref: attempt.budget_receipt_ref, budget_expires_at_ms: attempt.budget_expires_at_ms });
}

/** One reservation admits at most ONE handler invocation. Unknown execution is never auto-retried. */
export function createWorkflowCheckpointExecutor(
  database: D1Database, bucket: R2Bucket, ports: WorkflowExecutionPorts,
) {
  const store = new WorkflowCheckpointStore(database);
  async function beforeEffect(request: StageRequest, principal: WorkflowPrincipal): Promise<void> {
    if (principal.signal?.aborted) {
      await store.cancel(request.operation_id, principal);
      fail("WORKFLOW_CANCELLED");
    }
    await store.current(request, principal);
    await ports.authorizeResidency(request, principal);
  }
  async function afterEffect(request: StageRequest, principal: WorkflowPrincipal): Promise<void> {
    await store.current(request, principal);
    if (principal.signal?.aborted) {
      await store.cancel(request.operation_id, principal);
      fail("WORKFLOW_CANCELLED");
    }
  }
  async function recoveryGuard(request: StageRequest, principal: WorkflowPrincipal): Promise<void> {
    await beforeEffect(request, principal);
    await afterEffect(request, principal);
  }
  async function guard(request: StageRequest, principal: WorkflowPrincipal, expected?: WorkflowBudgetGrant): Promise<WorkflowBudgetGrant> {
    await beforeEffect(request, principal);
    const rawBudget = await ports.checkBudget(request, principal);
    const budget = Object.freeze({ receipt_ref: rawBudget.receipt_ref, expires_at_ms: rawBudget.expires_at_ms });
    if (typeof budget.receipt_ref !== "string" || budget.receipt_ref.length < 1 || budget.receipt_ref.length > 256 ||
        !Number.isSafeInteger(budget.expires_at_ms) || budget.expires_at_ms <= Date.now() ||
        budget.expires_at_ms > Date.now() + 600_000) fail("WORKFLOW_BUDGET_STOP");
    if (expected !== undefined && (expected.receipt_ref !== budget.receipt_ref || expected.expires_at_ms !== budget.expires_at_ms)) {
      fail("WORKFLOW_BUDGET_STOP");
    }
    await afterEffect(request, principal);
    return budget;
  }
  function storedBudget(attempt: AttemptRow): WorkflowBudgetGrant {
    if (typeof attempt.budget_receipt_ref !== "string" || attempt.budget_receipt_ref.length < 1 ||
        attempt.budget_receipt_ref.length > 256 || !Number.isSafeInteger(attempt.budget_expires_at_ms) ||
        attempt.budget_expires_at_ms <= 0) fail("WORKFLOW_OUTPUT_CORRUPT");
    return Object.freeze({ receipt_ref: attempt.budget_receipt_ref, expires_at_ms: attempt.budget_expires_at_ms });
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
    /** Durable preparation for an explicit native topology; existing generations do not call this seam. */
    async prepareExternalTask(
      raw: unknown,
      actor: WorkflowPrincipal,
      prepareTask: WorkflowExternalTaskPrepare,
    ): Promise<WorkflowExternalTaskPreparation> {
      const request = parseRequest(raw);
      const principal = snapshotPrincipal(actor);
      if (request.stage !== "ANALYZE_BRANCHES") fail("WORKFLOW_INPUT_INVALID");
      try {
        // A pre-aborted request follows the same cancellation path as the existing W2 executor.
        if (principal.signal?.aborted) {
          try { await store.cancel(request.operation_id, principal); } catch (error) {
            if (!(error instanceof WorkflowCheckpointError) || error.code !== "WORKFLOW_CONFLICT") throw error;
          }
          fail("WORKFLOW_CANCELLED");
        }
        await ports.authorizeResidency(request, principal);
        await store.ensureRun(request, principal);
        const requestDigest = await textDigest(JSON.stringify(request));
        const receipt = await store.receipt(request, requestDigest);
        if (receipt !== null) return Object.freeze({ kind: "COMMITTED", receipt: await finishReadback(request, principal, receipt) });
        let attempt = await store.attempt(request, requestDigest);
        if (attempt !== null && (attempt.stage_index !== 8 || attempt.expected_revision !== request.investigation_ref.revision ||
            typeof attempt.attempt_ref !== "string" || attempt.attempt_ref.length < 1 || attempt.attempt_ref.length > 128 ||
            /[\u0000-\u001f\u007f]/u.test(attempt.attempt_ref))) fail("WORKFLOW_OUTPUT_CORRUPT");
        if (attempt !== null && attempt.state !== "STARTED" && attempt.state !== "OUTPUT_RECORDED") {
          fail("WORKFLOW_OUTPUT_CORRUPT");
        }
        // Known W2 output is settled by execute(), including its existing expired-budget authorization.
        if (attempt?.state === "OUTPUT_RECORDED") {
          await recoveryGuard(request, principal);
          const budget = storedBudget(attempt);
          return Object.freeze({ kind: "SETTLE", operation_id: request.operation_id, stage_index: 8,
            attempt_ref: attempt.attempt_ref, request_sha256: requestDigest,
            budget_receipt_ref: budget.receipt_ref, budget_expires_at_ms: budget.expires_at_ms, result_sha256: null });
        }
        if (attempt !== null) {
          const recorded = await new ExternalAgentTaskStore(database).readRecordedResultReadback({
            operation_id: request.operation_id, stage_index: 8, attempt_ref: attempt.attempt_ref, request_sha256: requestDigest,
          });
          if (recorded !== null) {
            await recoveryGuard(request, principal);
            const budget = storedBudget(attempt);
            if (budget.expires_at_ms <= Date.now()) await store.requireRecoveryAuthorization(request, principal);
            return Object.freeze({ kind: "SETTLE", operation_id: request.operation_id, stage_index: 8,
              attempt_ref: attempt.attempt_ref, request_sha256: requestDigest,
              budget_receipt_ref: budget.receipt_ref, budget_expires_at_ms: budget.expires_at_ms,
              result_sha256: recorded.result_sha256 });
          }
        }
        const budget = attempt === null
          ? await guard(request, principal)
          : await guard(request, principal, storedBudget(attempt));
        const inputBytes = await readWorkflowObject(bucket, request.input_manifest, true);
        await guard(request, principal, budget);
        if (attempt === null) {
          const nonce = crypto.randomUUID();
          attempt = await store.reserve(request, requestDigest, nonce, budget);
          if (attempt.attempt_ref !== nonce) fail("WORKFLOW_EFFECT_UNCERTAIN");
        }
        await guard(request, principal, budget);
        try {
          await prepareTask({ request: structuredClone(request), principal, input_bytes: inputBytes,
            attempt_ref: attempt.attempt_ref, request_sha256: requestDigest, budget_receipt_ref: budget.receipt_ref });
        } catch (error) {
          if (principal.signal?.aborted) {
            await retainWorkflowFailure(database, request.operation_id, principal, workflowFailure(error, "STAGE", request.stage));
            await store.cancel(request.operation_id, principal);
            fail("WORKFLOW_CANCELLED");
          }
          throw error;
        }
        await guard(request, principal, budget);
        return Object.freeze({ kind: "WAIT", operation_id: request.operation_id, stage_index: 8,
          attempt_ref: attempt.attempt_ref, request_sha256: requestDigest,
          budget_receipt_ref: budget.receipt_ref, budget_expires_at_ms: budget.expires_at_ms, result_sha256: null });
      } catch (error) {
        const failure = workflowFailure(error, "STAGE", request.stage);
        await retainWorkflowFailure(database, request.operation_id, principal, failure);
        if (error instanceof WorkflowCheckpointError) throw new WorkflowCheckpointError(error.code, failure);
        throw new WorkflowCheckpointError("WORKFLOW_EFFECT_UNCERTAIN", failure);
      }
    },
    async nativeStagePolicy(raw: unknown, actor: WorkflowPrincipal): Promise<WorkflowNativeStagePolicy | null> {
      const request = parseRequest(raw);
      const principal = snapshotPrincipal(actor);
      return store.nativeStagePolicy(request, principal);
    },
    async executeNative(
      raw: unknown,
      actor: WorkflowPrincipal,
      handler: WorkflowNativeStageHandler,
      expectedPolicy: WorkflowNativeStagePolicy,
    ): Promise<WorkflowNativeStageReceipt> {
      const request = parseRequest(raw);
      const principal = snapshotPrincipal(actor);
      const requestDigest = await textDigest(JSON.stringify(request));

      async function beforeNativeEffect(): Promise<void> {
        // Durable run cancellation and the same principal fence used by W2 guard every native leg.
        await store.current(request, principal);
        await ports.authorizeResidency(request, principal);
      }
      async function finishNativeReadback(receipt: WorkflowNativeStageReceipt): Promise<WorkflowNativeStageReceipt> {
        await beforeNativeEffect();
        await readWorkflowObject(bucket, receipt.output_manifest, true);
        await store.current(request, principal);
        return receipt;
      }

      const committed = await store.readCommittedNativeStage(request.operation_id, request.stage);
      if (committed !== null) {
        if (committed.request_sha256 !== requestDigest || JSON.stringify(committed.request) !== JSON.stringify(request)) {
          fail("WORKFLOW_CONFLICT");
        }
        return finishNativeReadback(committed.receipt);
      }

      await store.ensureRun(request, principal);
      const compiled = await store.nativeStagePolicy(request, principal);
      if (compiled === null || compiled.effect_policy_generation !== expectedPolicy.effect_policy_generation ||
          compiled.effect_class !== expectedPolicy.effect_class || compiled.retry_limit !== expectedPolicy.retry_limit ||
          compiled.retry_delay_ms !== expectedPolicy.retry_delay_ms) fail("WORKFLOW_AUTHORITY_STALE");
      await beforeNativeEffect();
      const inputBytes = await readWorkflowObject(bucket, request.input_manifest, true);
      await beforeNativeEffect();

      let bytes: Uint8Array;
      try {
        bytes = await handler({
          request: structuredClone(request),
          principal: Object.freeze({
            principal_ref: principal.principal_ref,
            credential_generation: principal.credential_generation,
            deployment_generation: principal.deployment_generation,
          }),
          input_bytes: inputBytes,
        });
      } catch (error) {
        if (error instanceof WorkflowCheckpointError) throw error;
        throw new WorkflowCheckpointError("WORKFLOW_PREPARATION_FAILED", workflowFailure(error, "STAGE", request.stage));
      }
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_WORKFLOW_OUTPUT_BYTES) fail("WORKFLOW_INPUT_INVALID");
      bytes = new Uint8Array(bytes);
      const outputDigest = await digest(bytes);
      const output = WorkflowObjectSchema.parse({
        object_ref: `workflow-native/${requestDigest}/${outputDigest}`,
        sha256: outputDigest,
        byte_length: bytes.byteLength,
        residency: { ...request.input_manifest.residency, content_digest: { algorithm: "sha256", digest: outputDigest } },
      });

      await beforeNativeEffect();
      await store.ensureNativeStageIntent({ request, principal, output, request_sha256: requestDigest });
      await beforeNativeEffect();
      await writeWorkflowObject(bucket, output, bytes);
      await beforeNativeEffect();
      const receipt = await store.commitNativeStage({ request, principal, policy: compiled, output });
      return finishNativeReadback(receipt);
    },
    async execute(raw: unknown, actor: WorkflowPrincipal, handler: WorkflowStageHandler): Promise<StageReceipt> {
      const request = parseRequest(raw);
      const principal = snapshotPrincipal(actor);
      let failurePhase: WorkflowFailure["phase"] = "STAGE";
      try {
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
        if (previous !== null) return await finishReadback(request, principal, previous);
        const recoveringExistingAttempt = attempt !== null;
        if (recoveringExistingAttempt) failurePhase = "RECOVERY";
        let budget: WorkflowBudgetGrant;
        if (attempt === null) {
          budget = await guard(request, principal);
        } else {
          budget = storedBudget(attempt);
          if (budget.expires_at_ms > Date.now()) {
            budget = await guard(request, principal, budget);
          } else {
            await recoveryGuard(request, principal);
            await store.requireRecoveryAuthorization(request, principal);
          }
        }
        async function recoverKnownOutput(recoveryAttempt: AttemptRow, existing?: WorkflowObject): Promise<WorkflowObject> {
          const recoverStartedAttempt = ports.recoverStartedAttempt;
          if (recoverStartedAttempt === undefined) fail("WORKFLOW_EFFECT_UNCERTAIN");
          let recovered: Uint8Array | null;
          try {
            recovered = await recoverStartedAttempt(workflowAttemptRecoveryInput(request, principal, recoveryAttempt, existing));
          } catch (error) {
            throw new WorkflowCheckpointError("WORKFLOW_EFFECT_UNCERTAIN", workflowFailure(error, "RECOVERY", request.stage));
          }
          if (recovered === null) fail("WORKFLOW_EFFECT_UNCERTAIN");
          if (!(recovered instanceof Uint8Array) || recovered.byteLength > MAX_WORKFLOW_OUTPUT_BYTES) {
            fail("WORKFLOW_OUTPUT_CORRUPT");
          }
          const recoveredBytes = new Uint8Array(recovered);
          const recoveredDigest = await digest(recoveredBytes);
          let reconstructed: WorkflowObject;
          try {
            reconstructed = WorkflowObjectSchema.parse({
              object_ref: existing?.object_ref ?? `workflow/${requestDigest}/${recoveryAttempt.attempt_ref}`,
              sha256: recoveredDigest, byte_length: recoveredBytes.byteLength,
              residency: { ...request.input_manifest.residency, content_digest: { algorithm: "sha256", digest: recoveredDigest } },
            });
          } catch { return fail("WORKFLOW_OUTPUT_CORRUPT"); }
          if (existing !== undefined && (existing.object_ref !== reconstructed.object_ref || existing.sha256 !== reconstructed.sha256 ||
              existing.byte_length !== reconstructed.byte_length || JSON.stringify(existing.residency) !== JSON.stringify(reconstructed.residency))) {
            fail("WORKFLOW_OUTPUT_CORRUPT");
          }
          await recoveryGuard(request, principal);
          await store.recordOutput(request, recoveryAttempt, reconstructed);
          await recoveryGuard(request, principal);
          await writeWorkflowObject(bucket, reconstructed, recoveredBytes);
          return reconstructed;
        }
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
              request: structuredClone(request), principal, input_bytes: inputBytes, attempt_ref: attempt.attempt_ref,
              budget_receipt_ref: attempt.budget_receipt_ref,
              ...(principal.signal === undefined ? {} : { signal: principal.signal }),
            });
          } catch (error) {
            const originalFailure = workflowFailure(error, "STAGE", request.stage);
            if (principal.signal?.aborted) {
              await retainWorkflowFailure(database, request.operation_id, principal, originalFailure);
              await store.cancel(request.operation_id, principal);
              fail("WORKFLOW_CANCELLED");
            }
            if (error instanceof WorkflowCheckpointError && error.code === "WORKFLOW_OUTPUT_CORRUPT") {
              throw error;
            }
            throw new WorkflowCheckpointError("WORKFLOW_EFFECT_UNCERTAIN", originalFailure);
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
            output = await recoverKnownOutput(attempt);
          } else {
            try { output = WorkflowObjectSchema.parse(JSON.parse(attempt.output_json)); }
            catch { return fail("WORKFLOW_OUTPUT_CORRUPT"); }
            // Lost output/checkpoint ACK: recover exact persisted bytes without invoking the handler.
            try { await readWorkflowObject(bucket, output, true); }
            catch (error) {
              if (error instanceof WorkflowCheckpointError && error.code === "WORKFLOW_OUTPUT_UNAVAILABLE" && ports.recoverStartedAttempt !== undefined) {
                output = await recoverKnownOutput(attempt, output);
              } else throw error;
            }
          }
        }
        if (recoveringExistingAttempt) await recoveryGuard(request, principal);
        else await guard(request, principal, budget);
        const receipt = await store.commit(request, attempt, output);
        return await finishReadback(request, principal, receipt);
      } catch (error) {
        const failure = workflowFailure(error, failurePhase, request.stage);
        await retainWorkflowFailure(database, request.operation_id, principal, failure);
        if (error instanceof WorkflowCheckpointError) throw new WorkflowCheckpointError(error.code, failure);
        throw new WorkflowCheckpointError("WORKFLOW_EFFECT_UNCERTAIN", failure);
      }
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
