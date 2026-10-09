import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeExternalTaskServerPorts } from "./native-external-task-ports.js";
import { NATIVE_EXTERNAL_TASK_HANDLER_GENERATION } from "./native-external-task-step.js";
import { WorkflowCheckpointStore, type AttemptRow } from "./store.js";
import type * as WorkflowExecutor from "./executor.js";
import { digest, fail, parseRequest, textDigest, type StageReceipt, type WorkflowAttemptRecoveryInput, type WorkflowExecutionPorts } from "./types.js";

// Composition regressions only: W2/storage/native acceptance uses separate real-runtime fixtures.
const execution = vi.hoisted(() => ({ ports: [] as WorkflowExecutionPorts[], execute: vi.fn(), prepare: vi.fn() }));
vi.mock("./executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof WorkflowExecutor>();
  return { ...actual, createWorkflowCheckpointExecutor: (_db: D1Database, _bucket: R2Bucket, ports: WorkflowExecutionPorts) => {
    execution.ports.push(ports);
    return { execute: execution.execute, prepareExternalTask: execution.prepare };
  } };
});
beforeEach(() => { execution.ports.length = 0; execution.execute.mockReset(); execution.prepare.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

async function fixture(state: AttemptRow["state"] = "STARTED") {
  const inputSha = "a".repeat(64);
  const input = { object_ref: "input-1", sha256: inputSha, byte_length: 1, residency: {
    scope_domain_id: "scope-1", access_domain_id: "actor-1", confidentiality_domain_id: "private",
    encryption_key_domain_id: "key-1", retention_domain_id: "retention-1", erasure_domain_id: "erasure-1",
    content_digest: { algorithm: "sha256" as const, digest: inputSha },
  } };
  const request = parseRequest({ protocol: "eliotr.workflow-stage.v1", operation_id: "run-1",
    investigation_ref: { id: "investigation-1", revision: 9 }, stage: "ANALYZE_BRANCHES",
    idempotency_key: "key-1", handler_generation: NATIVE_EXTERNAL_TASK_HANDLER_GENERATION, input_manifest: input });
  const requestSha = await textDigest(JSON.stringify(request));
  const bytes = new TextEncoder().encode("canonical stage result");
  const sha256 = await digest(bytes);
  const output = { ...input, object_ref: "recorded-output", sha256, byte_length: bytes.byteLength,
    residency: { ...input.residency, content_digest: { algorithm: "sha256" as const, digest: sha256 } } };
  const prepared = { kind: "SETTLE" as const, result_sha256: null,
    operation_id: request.operation_id, stage_index: 8 as const, attempt_ref: "attempt-1",
    request_sha256: requestSha, budget_receipt_ref: "budget-1", budget_expires_at_ms: Date.now() - 60_000 };
  const attempt: AttemptRow = { ...prepared, expected_revision: 9, request_json: JSON.stringify(request), state,
    output_json: state === "OUTPUT_RECORDED" ? JSON.stringify(output) : null };
  const principal = { principal_ref: "actor-1", credential_generation: "credential-1", deployment_generation: "deployment-1" };
  const receipt: StageReceipt = { protocol: "eliotr.workflow-checkpoint.v1", operation_id: request.operation_id,
    stage: request.stage, request_sha256: requestSha, receipt_ref: `wcp:${requestSha}`, attempt_ref: prepared.attempt_ref,
    investigation_ref: { id: request.investigation_ref.id, revision: 10 }, input_manifest_ref: input.object_ref,
    output_manifest: output, budget_receipt_ref: prepared.budget_receipt_ref,
    cancellation_checked_at: new Date().toISOString(), engine_state: "CHECKPOINTED" };
  vi.spyOn(WorkflowCheckpointStore.prototype, "current").mockResolvedValue();
  vi.spyOn(WorkflowCheckpointStore.prototype, "attempt").mockImplementation(async () => attempt);
  const read = vi.fn(async (_input: WorkflowAttemptRecoveryInput, _expected?: string): Promise<Uint8Array | null> => bytes);
  const prepareTask = vi.fn();
  const budget = vi.fn();
  const authorize = vi.fn(async () => {});
  const ports = createNativeExternalTaskServerPorts({ database: {} as D1Database, bucket: {} as R2Bucket,
    ports: { authorizeResidency: authorize, checkBudget: budget }, prepare_task: prepareTask, read_recorded_result: read });
  execution.execute.mockResolvedValue(receipt);
  return { ports, request, principal, prepared, attempt, bytes, receipt, read, prepareTask, budget, authorize };
}

describe("native external result server composition", () => {
  it("keeps an expired absent result uncertain without entering recovery authorization or new dispatch", async () => {
    const f = await fixture();
    f.read.mockResolvedValue(null);
    execution.execute.mockImplementation(async () => fail("WORKFLOW_AUTHORITY_STALE"));
    await expect(f.ports.settle(f.request, f.principal, f.prepared)).rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(execution.execute).not.toHaveBeenCalled();
    expect(f.prepareTask).not.toHaveBeenCalled();
    expect(f.budget).not.toHaveBeenCalled();
  });
  it("consults the expected result digest for OUTPUT_RECORDED before cached W2 execution", async () => {
    const f = await fixture("OUTPUT_RECORDED");
    const expected = "b".repeat(64);
    f.read.mockRejectedValue(Object.assign(new Error("foreign stored result digest"), { code: "WORKFLOW_OUTPUT_CORRUPT" }));
    await expect(f.ports.settle(f.request, f.principal, f.prepared, expected))
      .rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
    expect(f.read).toHaveBeenCalledWith(expect.objectContaining({ output_object_ref: "recorded-output" }), expected);
    expect(execution.execute).not.toHaveBeenCalled();
  });
  it("rejects canonical bytes conflicting with the original OUTPUT_RECORDED manifest", async () => {
    const f = await fixture("OUTPUT_RECORDED");
    const conflicting = new Uint8Array(f.bytes);
    conflicting[0] = (conflicting[0] ?? 0) ^ 1;
    f.read.mockResolvedValue(conflicting);
    await expect(f.ports.settle(f.request, f.principal, f.prepared)).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
    expect(execution.execute).not.toHaveBeenCalled();
  });
  it("snapshots a single canonical read for repeated executor recovery without calling task preparation", async () => {
    const f = await fixture();
    execution.execute.mockImplementation(async () => {
      f.bytes.fill(0);
      const recover = execution.ports[1]?.recoverStartedAttempt;
      if (recover === undefined) throw new Error("Missing executor recovery port");
      const identity = f.read.mock.calls[0]?.[0];
      if (identity === undefined) throw new Error("Missing read identity");
      const first = await recover(identity);
      if (first === null) throw new Error("Missing result snapshot");
      expect(new TextDecoder().decode(first)).toBe("canonical stage result");
      first.fill(0);
      expect(new TextDecoder().decode(await recover(identity) ?? new Uint8Array())).toBe("canonical stage result");
      return f.receipt;
    });
    expect(await f.ports.settle(f.request, f.principal, f.prepared)).toBe(f.receipt);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.prepareTask).not.toHaveBeenCalled();
    expect(f.budget).not.toHaveBeenCalled();
  });
  it.each([
    { attempt_ref: "foreign-attempt" }, { budget_receipt_ref: "foreign-budget" }, { budget_expires_at_ms: 1 },
  ])("rejects foreign preparation $attempt_ref $budget_receipt_ref $budget_expires_at_ms before read or execution", async (foreign) => {
    const f = await fixture();
    await expect(f.ports.settle(f.request, f.principal, { ...f.prepared, ...foreign }))
      .rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
    expect(f.read).not.toHaveBeenCalled();
    expect(execution.execute).not.toHaveBeenCalled();
    expect(f.prepareTask).not.toHaveBeenCalled();
  });
  it("passes an aborted actor to the existing cancellation executor without canonical reads", async () => {
    const f = await fixture();
    const signal = AbortSignal.abort();
    execution.execute.mockImplementation(async (_request, principal) => {
      expect(principal.signal.aborted).toBe(true);
      return fail("WORKFLOW_CANCELLED");
    });
    await expect(f.ports.settle(f.request, { ...f.principal, signal }, f.prepared))
      .rejects.toMatchObject({ code: "WORKFLOW_CANCELLED" });
    expect(execution.execute).toHaveBeenCalledTimes(1);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.authorize).not.toHaveBeenCalled();
  });
  it("uses committed executor replay without re-reading canonical result bytes", async () => {
    const f = await fixture("COMMITTED");
    expect(await f.ports.settle(f.request, f.principal, f.prepared)).toBe(f.receipt);
    expect(execution.execute).toHaveBeenCalledTimes(1);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.prepareTask).not.toHaveBeenCalled();
    expect(f.budget).not.toHaveBeenCalled();
  });
});
