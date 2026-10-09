import type { WorkflowStep } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { executeNativeExternalTaskStep, NATIVE_EXTERNAL_TASK_HANDLER_GENERATION,
  NATIVE_EXTERNAL_TASK_STEP_NAMES } from "./native-external-task-step.js";
import { externalTaskWakeEventType } from "./external-task-wake-event.js";
import { parseRequest, textDigest, type StageReceipt } from "./types.js";
import type { WorkflowExternalTaskPreparation } from "./executor.js";

async function fixture(kind: "WAIT" | "SETTLE" = "WAIT") {
  const sha256 = "a".repeat(64);
  const manifest = { object_ref: "input-1", sha256, byte_length: 1, residency: {
    scope_domain_id: "scope-1", access_domain_id: "actor-1", confidentiality_domain_id: "private",
    encryption_key_domain_id: "key-1", retention_domain_id: "retention-1", erasure_domain_id: "erasure-1",
    content_digest: { algorithm: "sha256" as const, digest: sha256 },
  } };
  const request = parseRequest({ protocol: "eliotr.workflow-stage.v1", operation_id: "run-1",
    stage: "ANALYZE_BRANCHES", investigation_ref: { id: "investigation-1", revision: 9 },
    idempotency_key: "key-1", handler_generation: NATIVE_EXTERNAL_TASK_HANDLER_GENERATION, input_manifest: manifest });
  const request_sha256 = await textDigest(JSON.stringify(request));
  const prepared: Exclude<WorkflowExternalTaskPreparation, { kind: "COMMITTED" }> = { kind,
    operation_id: request.operation_id, stage_index: 8, attempt_ref: "attempt-1", request_sha256,
    budget_receipt_ref: "budget-1", budget_expires_at_ms: Date.now() + 60_000, result_sha256: null };
  const result_digest = "b".repeat(64);
  const wake = { protocol: "eliotr.external-task-wake.v1",
    task_id: `external-task:${request_sha256}`, operation_id: request.operation_id, stage_index: 8,
    attempt_ref: prepared.attempt_ref, request_sha256, result_digest };
  const receipt: StageReceipt = { protocol: "eliotr.workflow-checkpoint.v1", operation_id: request.operation_id,
    stage: request.stage, request_sha256, receipt_ref: `wcp:${request_sha256}`, attempt_ref: prepared.attempt_ref,
    investigation_ref: { id: request.investigation_ref.id, revision: 10 }, input_manifest_ref: manifest.object_ref,
    output_manifest: { ...manifest, object_ref: "output-1" }, budget_receipt_ref: prepared.budget_receipt_ref,
    cancellation_checked_at: new Date().toISOString(), engine_state: "CHECKPOINTED" };
  const names: string[] = [];
  let active = false;
  const durable = vi.fn(async (name: string, options: { retries: { limit: number } }, call: () => Promise<unknown>) => {
    expect(active).toBe(false);
    expect(options.retries.limit).toBe(0);
    active = true; names.push(name);
    try { return await call(); } finally { active = false; }
  });
  const wait = vi.fn(async (name: string, options: { type: string; timeout: number }) => {
    expect(active).toBe(false); names.push(name);
    expect(options.type).toBe(await externalTaskWakeEventType(prepared));
    expect(options.timeout).toBeGreaterThanOrEqual(1_000);
    return { payload: wake };
  });
  const prepare = vi.fn(async (): Promise<WorkflowExternalTaskPreparation> => prepared);
  const settle = vi.fn(async (): Promise<StageReceipt> => receipt);
  const input = { request, principal: { principal_ref: "actor-1", credential_generation: "credential-1",
    deployment_generation: "deployment-1" }, step: { do: durable, waitForEvent: wait } as unknown as WorkflowStep,
    prepare, settle };
  return { input, prepared, receipt, wake, names, prepare, settle, wait, durable };
}

describe("R05 orchestration contracts with explicit server/native-step fixtures", () => {
  it("runs sibling prepare/wait/settle and binds only the locator's original digest", async () => {
    const f = await fixture();
    expect(await executeNativeExternalTaskStep(f.input)).toEqual(f.receipt);
    expect(f.names).toEqual(Object.values(NATIVE_EXTERNAL_TASK_STEP_NAMES));
    expect(f.settle).toHaveBeenCalledExactlyOnceWith(f.input.request, f.input.principal, f.prepared, f.wake.result_digest);
  });

  it("settles an already recorded result without entering a wait", async () => {
    const f = await fixture("SETTLE");
    const prepared = { ...f.prepared, result_sha256: f.wake.result_digest };
    f.prepare.mockResolvedValue(prepared);
    await executeNativeExternalTaskStep(f.input);
    expect(f.wait).not.toHaveBeenCalled();
    expect(f.settle).toHaveBeenCalledExactlyOnceWith(f.input.request, f.input.principal, prepared, f.wake.result_digest);
  });

  it("replays a committed checkpoint without waiting or settling again", async () => {
    const f = await fixture();
    f.prepare.mockResolvedValue({ kind: "COMMITTED", receipt: f.receipt });
    expect(await executeNativeExternalTaskStep(f.input)).toEqual(f.receipt);
    expect(f.wait).not.toHaveBeenCalled(); expect(f.settle).not.toHaveBeenCalled();
  });

  it("performs one canonical settlement read after wait transport failure", async () => {
    const f = await fixture();
    f.wait.mockRejectedValue(new Error("transport timed out"));
    expect(await executeNativeExternalTaskStep(f.input)).toEqual(f.receipt);
    expect(f.settle).toHaveBeenCalledExactlyOnceWith(f.input.request, f.input.principal, f.prepared, undefined);
  });

  it("does not convert an absent canonical result at timeout into a successful receipt", async () => {
    const f = await fixture();
    f.wait.mockRejectedValue(new Error("transport timed out"));
    f.settle.mockRejectedValue(Object.assign(new Error("unknown"), { code: "WORKFLOW_EFFECT_UNCERTAIN" }));
    await expect(executeNativeExternalTaskStep(f.input)).rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
    expect(f.settle).toHaveBeenCalledTimes(1); expect(f.prepare).toHaveBeenCalledTimes(1);
  });

  it("rejects a foreign or malformed locator before canonical settlement", async () => {
    for (const change of [{ attempt_ref: "foreign" }, { result_digest: "invalid" }, { private_result: "forbidden" }]) {
      const f = await fixture();
      f.wait.mockResolvedValue({ payload: { ...f.wake, ...change } });
      await expect(executeNativeExternalTaskStep(f.input)).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
      expect(f.settle).not.toHaveBeenCalled();
    }
  });

  it("rejects stale generation, foreign preparation and an extended original deadline", async () => {
    const old = await fixture();
    await expect(executeNativeExternalTaskStep({ ...old.input,
      request: { ...old.input.request, handler_generation: "research-handlers.exploratory.v8" } }))
      .rejects.toMatchObject({ code: "WORKFLOW_INPUT_INVALID" });
    expect(old.prepare).not.toHaveBeenCalled();
    for (const change of [{ request_sha256: "c".repeat(64) }, { budget_expires_at_ms: Date.now() + 900_000 }]) {
      const f = await fixture(); f.prepare.mockResolvedValue({ ...f.prepared, ...change });
      await expect(executeNativeExternalTaskStep(f.input)).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
      expect(f.wait).not.toHaveBeenCalled(); expect(f.settle).not.toHaveBeenCalled();
    }
  });

  it("rejects substituted settlement or committed replay receipts", async () => {
    for (const committed of [false, true]) {
      const f = await fixture(); const foreign = { ...f.receipt, request_sha256: "c".repeat(64) };
      if (committed) f.prepare.mockResolvedValue({ kind: "COMMITTED", receipt: foreign });
      else f.settle.mockResolvedValue(foreign);
      await expect(executeNativeExternalTaskStep(f.input)).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
    }
  });

  it("rejects noncanonical, malformed or object-shaped persisted preparation", async () => {
    for (const corrupt of ["{bad", '{"kind":"WAIT","kind":"SETTLE"}', {}]) {
      const f = await fixture();
      f.durable.mockResolvedValueOnce(corrupt);
      await expect(executeNativeExternalTaskStep(f.input)).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
      expect(f.wait).not.toHaveBeenCalled(); expect(f.settle).not.toHaveBeenCalled();
    }
  });
});
