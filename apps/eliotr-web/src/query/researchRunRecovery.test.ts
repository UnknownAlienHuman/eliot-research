import { describe, expect, it, vi } from "vitest";
import { createResearchRunsApi, createSessionEpoch, type ResearchRunStatusView } from "@eliotr/owner-api-client";
import { createPrivacyController } from "../app/privacy";
import { WorkspaceRequestError } from "../app/runtime";
import { canRequestResearchRecovery, canStopFailedResearchRun, recoverExistingResearchRun, rememberFailedResearchRun,
  hasCanonicalResearchCancellation, researchRecoveryFirstCause, stopFailedResearchRun,
  type ResearchRunRecoveryMemory, type ResearchRunStopMemory } from
  "./researchRunRecovery";

const generation = "deployment-1";
const launch = { workflow_instance_id: "run-recovery-1", investigation_ref: { id: "investigation-1", revision: 1 },
  deployment_generation: generation };
const failure = { code: "WORKFLOW_OUTPUT_UNAVAILABLE", stage: "RESOLVE_CITATIONS", phase: "STAGE", retryable: false } as const;
const stopped: ResearchRunStatusView = { ...launch, investigation_ref: { id: "investigation-1", revision: 16 },
  execution_state: "ACTIVE", engine_status: "errored", next_stage_index: 15, answer: { availability: "unavailable" }, failure };
const running: ResearchRunStatusView = { ...launch, investigation_ref: stopped.investigation_ref,
  execution_state: "ACTIVE", engine_status: "running", next_stage_index: 15, answer: { availability: "unavailable" } };
const detached: ResearchRunStatusView = { ...launch, investigation_ref: stopped.investigation_ref,
  execution_state: "ACTIVE", engine_status: "unknown", next_stage_index: 15, answer: { availability: "unavailable" } };
const { failure: _stoppedFailure, ...stoppedWithoutFailure } = stopped;
const cancelled: ResearchRunStatusView = { ...stoppedWithoutFailure, investigation_ref: stopped.investigation_ref,
  execution_state: "CANCELLED", engine_status: "unknown", next_stage_index: 15, answer: { availability: "unavailable" },
  cancellation_receipt_ref: `workflow-cancelled:${launch.workflow_instance_id}` };
const envelope = (view: ResearchRunStatusView) => {
  const { deployment_generation, ...status } = view;
  return { data: { protocol: "eliotr.research-run-status.v2", ...status }, trace_id: "recovery-trace", deployment_generation };
};

async function fixture() {
  let memory: ResearchRunRecoveryMemory | undefined;
  let stopMemory: ResearchRunStopMemory | undefined;
  let current = true;
  const published: ResearchRunStatusView[] = [];
  let reply = async (_path: string, init: RequestInit | undefined) => envelope(init?.method === "POST" ? running : stopped);
  const request = vi.fn(async (path: string, init: RequestInit | undefined, _statuses: readonly number[]) => reply(path, init));
  const runs = createResearchRunsApi({ request, epoch: createSessionEpoch(), errors: details => new WorkspaceRequestError(details) });
  const start = vi.spyOn(runs, "startResearchRun");
  const privacy = createPrivacyController({ mask() {}, reveal() {}, cancelReads() {},
    clearProtected() { memory = undefined; stopMemory = undefined; published.length = 0; }, now: () => Date.parse("2026-10-16T12:00:00.000Z"),
    timers: { setTimeout: () => 0, clearTimeout() {} }, verify: async () => ({ principal: "owner-1",
      credentialGeneration: "credential-1", deploymentGeneration: generation, expiresAt: "2027-01-01T00:00:00.000Z" }) });
  await privacy.refresh();
  const snapshot = privacy.getSnapshot();
  if (snapshot.phase !== "available") throw new Error("Recovery fixture authority unavailable");
  const controller = new AbortController();
  const writes = vi.fn((next: ResearchRunRecoveryMemory) => { memory = next; });
  const invoke = (action: "recover" | "readback" = "recover") => recoverExistingResearchRun({ runs, privacy,
    context: snapshot.context, launch, status: stopped, action, signal: controller.signal, isCurrent: () => current,
    readMemory: () => memory, writeMemory: writes, onStatus: async view => { published.push(view); } });
  const invokeStop = (action: "stop" | "readback" = "stop", status: ResearchRunStatusView = stopped) =>
    stopFailedResearchRun({ runs, privacy, context: snapshot.context, launch, status, failedRunObserved: true, action,
      signal: controller.signal, isCurrent: () => current, readMemory: () => stopMemory,
      writeMemory: next => { stopMemory = next; }, onStatus: async view => { published.push(view); } });
  return { request, start, privacy, controller, published, writes, invoke, memory: () => memory,
    invokeStop, stopMemory: () => stopMemory,
    loseCurrentness: () => { current = false; }, reply: (next: typeof reply) => { reply = next; } };
}

describe("existing research run recovery", () => {
  it("uses the same typed control identity, exact status readback and no new run", async () => {
    const test = await fixture();
    let posted = false;
    test.reply(async (_path, init) => { if (init?.method === "POST") posted = true; return envelope(posted ? running : stopped); });
    await test.invoke();
    expect(test.request.mock.calls.map(([path, init]) => [path, init?.method ?? "GET"])).toEqual([
      ["/api/v1/research/run/run-recovery-1", "GET"],
      ["/api/v1/research/run/run-recovery-1/recover", "POST"],
      ["/api/v1/research/run/run-recovery-1", "GET"],
    ]);
    const control = test.request.mock.calls[1]?.[1];
    expect(control?.body).toBe("{}");
    expect(new Headers(control?.headers).get("idempotency-key")).toBe("research-recover:run-recovery-1");
    expect(test.memory()).toEqual({ workflowInstanceId: launch.workflow_instance_id, phase: "observed",
      failedRunObserved: true, firstCause: failure });
    expect(test.published.at(-1)?.engine_status).toBe("running");
    expect(test.start).not.toHaveBeenCalled();
    test.privacy.dispose();
  });

  it("holds a lost acknowledgement and requires an exact read before another explicit recovery", async () => {
    const test = await fixture(); let reads = 0;
    test.reply(async (_path, init) => {
      if (init?.method === "POST") throw new TypeError("lost recovery acknowledgement");
      if (++reads === 2) throw new TypeError("status unavailable");
      return envelope(stopped);
    });
    await test.invoke();
    expect(test.memory()?.phase).toBe("unknown");
    expect(test.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    // Even calling the recover action while unknown can only read the held run.
    await test.invoke();
    expect(test.memory()?.phase).toBe("checked");
    expect(test.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await test.invoke();
    const controls = test.request.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(controls).toHaveLength(2);
    expect(controls.map(([, init]) => new Headers(init?.headers).get("idempotency-key")))
      .toEqual(["research-recover:run-recovery-1", "research-recover:run-recovery-1"]);
    expect(test.start).not.toHaveBeenCalled();
    test.privacy.dispose();
  });

  it("serializes double clicks while the exact recovery request is pending", async () => {
    const test = await fixture(); let posted = false;
    let release: (() => void) | undefined;
    test.reply(async (_path, init) => {
      if (init?.method === "POST") { posted = true; await new Promise<void>(resolve => { release = resolve; }); }
      return envelope(posted ? running : stopped);
    });
    const pending = test.invoke();
    await vi.waitFor(() => expect(release).toBeDefined());
    await test.invoke();
    release?.(); await pending;
    expect(test.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(test.memory()?.phase).toBe("observed");
    test.privacy.dispose();
  });

  it("does not post when a fresh status already reports completion", async () => {
    const test = await fixture();
    test.reply(async () => envelope({ ...running, execution_state: "ENGINE_COMPLETED", engine_status: "complete", next_stage_index: 18,
      answer: { availability: "draft", artifact_ref: { id: "saved-report", revision: 1 } } }));
    await test.invoke();
    expect(test.request).toHaveBeenCalledTimes(1);
    expect(test.memory()?.phase).toBe("observed");
    expect(test.published.at(-1)?.answer.availability).toBe("draft");
    test.privacy.dispose();
  });

  it("retains the original Stage 15 failure when recovery is refused or later fails", async () => {
    const test = await fixture();
    const consequence = { code: "WORKFLOW_AUTHORITY_STALE", phase: "RECOVERY", stage: "RESOLVE_CITATIONS", retryable: false } as const;
    test.reply(async (_path, init) => {
      if (init?.method === "POST") throw new WorkspaceRequestError({ code: "RESEARCH_RUN_RECOVERY_EXHAUSTED", status: 409,
        message: "Recovery exhausted", traceId: null, retryable: false });
      return envelope({ ...stopped, failure: { ...failure, consequence, consequences: [consequence] } });
    });
    await test.invoke();
    expect(test.memory()?.phase).toBe("blocked");
    expect(researchRecoveryFirstCause(test.memory(), test.published.at(-1)))
      .toEqual({ ...failure, consequence, consequences: [consequence] });
    expect(researchRecoveryFirstCause(test.memory(), { ...stopped, failure: consequence })).toEqual(failure);
    await test.invoke("readback");
    expect(test.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(test.start).not.toHaveBeenCalled();
    test.privacy.dispose();
  });

  it.each(["project/run changed", "unmount abort", "authority loss"])("discards a late recovery response after %s", async reason => {
    const test = await fixture(); let release: (() => void) | undefined;
    test.reply(async (_path, init) => {
      if (init?.method === "POST") await new Promise<void>(resolve => { release = resolve; });
      return envelope(init?.method === "POST" ? running : stopped);
    });
    const pending = test.invoke();
    await vi.waitFor(() => expect(release).toBeDefined());
    const writesBefore = test.writes.mock.calls.length;
    if (reason === "project/run changed") test.loseCurrentness();
    else if (reason === "unmount abort") test.controller.abort();
    else test.privacy.close();
    const publishedBefore = test.published.length;
    release?.();
    await expect(pending).rejects.toThrow();
    expect(test.writes).toHaveBeenCalledTimes(writesBefore);
    expect(test.published).toHaveLength(publishedBefore);
    expect(test.request).toHaveBeenCalledTimes(2);
    expect(test.start).not.toHaveBeenCalled();
    if (reason === "authority loss") expect(test.memory()).toBeUndefined();
    test.privacy.dispose();
  });

  it.each([
    { ...stopped, workflow_instance_id: "foreign-run" },
    { ...stopped, investigation_ref: { id: "foreign-investigation", revision: 16 } },
    { ...stopped, investigation_ref: { id: "investigation-1", revision: 15 } },
    { ...stopped, deployment_generation: "foreign-deployment" },
  ])("refuses a foreign or regressed status before invoking recovery: %j", async view => {
    const test = await fixture(); test.reply(async () => envelope(view));
    await test.invoke();
    expect(test.memory()?.phase).toBe("unknown");
    expect(test.published).toHaveLength(0);
    expect(test.request).toHaveBeenCalledTimes(1);
    test.privacy.dispose();
  });

  it("offers only a stopped ACTIVE held run and leaves restart safety with the server", () => {
    expect(canRequestResearchRecovery(stopped, launch)).toBe(true);
    expect(canRequestResearchRecovery({ ...stopped, engine_status: "paused" }, launch)).toBe(true);
    expect(canRequestResearchRecovery({ ...stopped, execution_state: "CANCELLED" }, launch)).toBe(false);
    expect(canRequestResearchRecovery({ ...stopped, execution_state: "ENGINE_COMPLETED" }, launch)).toBe(false);
    expect(canRequestResearchRecovery(running, launch)).toBe(false);
    expect(canRequestResearchRecovery({ ...stopped, workflow_instance_id: "foreign-run" }, launch)).toBe(false);
  });

  it("does not publish a status that regresses after the pre-recovery read", async () => {
    const test = await fixture(); let reads = 0;
    const advanced = { ...stopped, investigation_ref: { id: "investigation-1", revision: 17 } };
    test.reply(async (_path, init) => init?.method === "POST"
      ? envelope({ ...running, investigation_ref: advanced.investigation_ref })
      : envelope(++reads === 1 ? advanced : stopped));
    await test.invoke();
    expect(test.memory()?.phase).toBe("unknown");
    expect(test.published.map(view => view.investigation_ref.revision)).toEqual([17]);
    expect(test.request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(test.start).not.toHaveBeenCalled();
    test.privacy.dispose();
  });

  it("keeps the first failed-run facts when the native engine later becomes unknown", () => {
    const unknownReferences = { ...failure, dispatch_state: "OUTCOME_UNKNOWN" as const,
      references_intact: "UNKNOWN" as const };
    const first = rememberFailedResearchRun(undefined, launch, { ...stopped, failure: unknownReferences });
    expect(first).toMatchObject({ workflowInstanceId: launch.workflow_instance_id, failedRunObserved: true,
      firstCause: unknownReferences });
    expect(rememberFailedResearchRun(first, launch, detached)).toBe(first);
    expect(canStopFailedResearchRun(detached, launch, first?.failedRunObserved === true)).toBe(true);
    expect(canStopFailedResearchRun({ ...detached, workflow_instance_id: "foreign-run" }, launch,
      first?.failedRunObserved === true)).toBe(false);
    expect(first?.firstCause?.references_intact).toBe("UNKNOWN");
    expect(researchRecoveryFirstCause(first, { ...stopped,
      failure: { ...unknownReferences, references_intact: "INTACT" } })).toMatchObject({
      references_intact: "UNKNOWN", dispatch_state: "OUTCOME_UNKNOWN",
    });
  });

  it("closes only after cancel and exact canonical CANCELLED readback for the same run", async () => {
    const test = await fixture(); let reads = 0;
    test.reply(async (path, init) => {
      if (path.endsWith("/cancel") && init?.method === "POST") return envelope(cancelled);
      return envelope(++reads === 1 ? stopped : cancelled);
    });

    await expect(test.invokeStop()).resolves.toMatchObject({ execution_state: "CANCELLED",
      cancellation_receipt_ref: `workflow-cancelled:${launch.workflow_instance_id}` });
    expect(test.request.mock.calls.map(([path, init]) => [path, init?.method ?? "GET"])).toEqual([
      [`/api/v1/research/run/${launch.workflow_instance_id}`, "GET"],
      [`/api/v1/research/run/${launch.workflow_instance_id}/cancel`, "POST"],
      [`/api/v1/research/run/${launch.workflow_instance_id}`, "GET"],
    ]);
    expect(new Headers(test.request.mock.calls[1]?.[1]?.headers).get("idempotency-key"))
      .toBe(`research-cancel:${launch.workflow_instance_id}`);
    expect(test.start).not.toHaveBeenCalled();
    test.privacy.dispose();
  });

  it("allows Retry to proceed only after re-reading the exact prior CANCELLED receipt", async () => {
    const test = await fixture();
    test.reply(async () => envelope(cancelled));

    expect(hasCanonicalResearchCancellation(cancelled, launch)).toBe(true);
    expect(hasCanonicalResearchCancellation({ ...cancelled, cancellation_receipt_ref: "workflow-cancelled:other-run" }, launch)).toBe(false);
    await expect(test.invokeStop("stop", cancelled)).resolves.toMatchObject({
      execution_state: "CANCELLED", cancellation_receipt_ref: `workflow-cancelled:${launch.workflow_instance_id}`,
    });
    expect(test.request).toHaveBeenCalledTimes(1);
    expect(test.request.mock.calls[0]?.[0]).toBe(`/api/v1/research/run/${launch.workflow_instance_id}`);
    expect(test.start).not.toHaveBeenCalled();
    test.privacy.dispose();
  });

  it("keeps cancellation-dispatched uncertainty sticky and makes both later controls GET-only", async () => {
    const test = await fixture(); let reads = 0;
    test.reply(async (path, init) => {
      if (path.endsWith("/cancel") && init?.method === "POST") {
        throw new TypeError("lost cancel acknowledgement");
      }
      reads += 1;
      if (reads === 1) return envelope(stopped);
      if (reads === 2) throw new TypeError("cancel readback unavailable");
      if (reads === 3) return envelope(detached);
      return envelope(cancelled);
    });

    await expect(test.invokeStop()).resolves.toBeUndefined();
    expect(test.stopMemory()?.phase).toBe("unknown");
    expect(test.stopMemory()?.cancel_dispatched).toBe(true);
    await expect(test.invokeStop("readback", detached)).resolves.toBeUndefined();
    expect(test.stopMemory()?.phase).toBe("unknown");
    expect(test.request.mock.calls.filter(([path, init]) => path.endsWith("/cancel") && init?.method === "POST")).toHaveLength(1);
    // Retry/Stop after a dispatch may only read; the exact cancellation receipt closes the hold.
    await expect(test.invokeStop("stop", detached)).resolves.toMatchObject({ execution_state: "CANCELLED",
      cancellation_receipt_ref: `workflow-cancelled:${launch.workflow_instance_id}` });
    const controls = test.request.mock.calls.filter(([path, init]) => path.endsWith("/cancel") && init?.method === "POST");
    expect(controls).toHaveLength(1);
    expect(controls.map(([, init]) => new Headers(init?.headers).get("idempotency-key")))
      .toEqual([`research-cancel:${launch.workflow_instance_id}`]);
    expect(test.start).not.toHaveBeenCalled();
    test.privacy.dispose();
  });

  it("does not post or publish after the owner/run currentness fence closes", async () => {
    const test = await fixture();
    test.reply(async (path, init) => {
      if (path.endsWith("/cancel") && init?.method === "POST") {
        test.loseCurrentness();
        return envelope(cancelled);
      }
      return envelope(stopped);
    });
    const before = test.published.length;
    await expect(test.invokeStop()).rejects.toThrow();
    expect(test.published).toHaveLength(before + 1); // The pre-cancel canonical status only.
    expect(test.stopMemory()?.phase).toBe("stopping");
    expect(test.request.mock.calls.filter(([path, init]) => path.endsWith("/cancel") && init?.method === "POST")).toHaveLength(1);
    expect(test.start).not.toHaveBeenCalled();
    test.privacy.dispose();
  });

  it("rejects a foreign investigation readback before issuing the cancel control", async () => {
    const test = await fixture();
    test.reply(async () => envelope({ ...stopped, investigation_ref: { id: "foreign-investigation", revision: 16 } }));

    await expect(test.invokeStop()).resolves.toBeUndefined();
    expect(test.stopMemory()?.phase).toBe("unknown");
    expect(test.request.mock.calls).toHaveLength(1);
    expect(test.request.mock.calls.some(([path, init]) => path.endsWith("/cancel") && init?.method === "POST")).toBe(false);
    expect(test.start).not.toHaveBeenCalled();
    test.privacy.dispose();
  });
});
