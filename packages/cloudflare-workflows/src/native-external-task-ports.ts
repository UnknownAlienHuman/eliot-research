import {
  createWorkflowCheckpointExecutor, workflowAttemptRecoveryInput, type WorkflowExternalTaskPrepare,
} from "./executor.js";
import {
  NATIVE_EXTERNAL_TASK_HANDLER_GENERATION, type NativeExternalTaskStepInput,
} from "./native-external-task-step.js";
import { WorkflowCheckpointStore } from "./store.js";
import {
  digest, fail, MAX_WORKFLOW_OUTPUT_BYTES, parseRequest, snapshotPrincipal, textDigest, WorkflowObjectSchema, type StageRequest,
  type WorkflowObject,
  type WorkflowAttemptRecoveryInput, type WorkflowExecutionPorts, type WorkflowPrincipal,
} from "./types.js";

export interface NativeExternalTaskServerPortsInput {
  readonly database: D1Database;
  readonly bucket: R2Bucket;
  readonly ports: WorkflowExecutionPorts;
  readonly prepare_task: WorkflowExternalTaskPrepare;
  readonly read_recorded_result: (
    input: WorkflowAttemptRecoveryInput, expectedResultSha256?: string,
  ) => Promise<Uint8Array | null>;
}

function requestForNative(raw: StageRequest): StageRequest {
  const request = parseRequest(raw);
  if (request.stage !== "ANALYZE_BRANCHES" || request.handler_generation !== NATIVE_EXTERNAL_TASK_HANDLER_GENERATION) {
    return fail("WORKFLOW_INPUT_INVALID");
  }
  return request;
}

/** Server composition. No fallback from canonical settlement to external dispatch. */
export function createNativeExternalTaskServerPorts(
  input: NativeExternalTaskServerPortsInput,
): Pick<NativeExternalTaskStepInput, "prepare" | "settle"> {
  const { database, bucket, ports, prepare_task: prepareTask, read_recorded_result: readRecordedResult } = input;
  const store = new WorkflowCheckpointStore(database);
  const executor = createWorkflowCheckpointExecutor(database, bucket, ports);
  return Object.freeze({
    async prepare(raw: StageRequest, actor: WorkflowPrincipal) {
      return executor.prepareExternalTask(requestForNative(raw), snapshotPrincipal(actor), prepareTask);
    },
    async settle(raw: StageRequest, actor: WorkflowPrincipal,
      prepared: Parameters<NativeExternalTaskStepInput["settle"]>[2], expectedResultSha256?: string) {
      const request = requestForNative(raw);
      const principal = snapshotPrincipal(actor);
      const requestDigest = await textDigest(JSON.stringify(request));
      if (prepared.operation_id !== request.operation_id || prepared.stage_index !== 8 ||
          prepared.request_sha256 !== requestDigest) return fail("WORKFLOW_OUTPUT_CORRUPT");
      await store.current(request, principal);
      const attempt = await store.attempt(request, requestDigest);
      if (attempt === null || attempt.operation_id !== prepared.operation_id || attempt.stage_index !== prepared.stage_index ||
          attempt.request_sha256 !== prepared.request_sha256 || attempt.attempt_ref !== prepared.attempt_ref ||
          attempt.expected_revision !== request.investigation_ref.revision ||
          attempt.budget_receipt_ref !== prepared.budget_receipt_ref || attempt.budget_expires_at_ms !== prepared.budget_expires_at_ms ||
          (attempt.state !== "STARTED" && attempt.state !== "OUTPUT_RECORDED" && attempt.state !== "COMMITTED")) {
        return fail("WORKFLOW_OUTPUT_CORRUPT");
      }
      let recovered: Uint8Array | null = null;
      if (!principal.signal?.aborted && attempt.state !== "COMMITTED") {
        await ports.authorizeResidency(request, principal);
        let existing: WorkflowObject | undefined;
        if (attempt.state === "OUTPUT_RECORDED") {
          try { existing = WorkflowObjectSchema.parse(JSON.parse(attempt.output_json ?? "null")); }
          catch { return fail("WORKFLOW_OUTPUT_CORRUPT"); }
        }
        // Read exactly once before expiry authorization can confuse an absent result with revoked authority.
        const bytes = await readRecordedResult(workflowAttemptRecoveryInput(request, principal, attempt, existing), expectedResultSha256);
        if (bytes === null) return fail("WORKFLOW_EFFECT_UNCERTAIN");
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_WORKFLOW_OUTPUT_BYTES) return fail("WORKFLOW_OUTPUT_CORRUPT");
        recovered = new Uint8Array(bytes);
        if (existing !== undefined && (existing.byte_length !== recovered.byteLength || existing.sha256 !== await digest(recovered))) {
          return fail("WORKFLOW_OUTPUT_CORRUPT");
        }
      }
      const settlement = createWorkflowCheckpointExecutor(database, bucket, {
        ...ports,
        recoverStartedAttempt: async () => recovered === null ? null : new Uint8Array(recovered),
      });
      // Existing guards own known-result settlement, including original-expiry recovery authorization.
      // Original W2 guards still reject revoked/cancelled/late authority; no provider/task call is available.
      return settlement.execute(request, principal, async () => fail("WORKFLOW_EFFECT_UNCERTAIN"));
    },
  });
}
