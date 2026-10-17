import { afterEach, describe, expect, it, vi } from "vitest";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import { measureWorkflowCheckpointPhase } from "./checkpoint-performance.js";

const TEST_STAGE = (() => {
  const stage = RESEARCH_WORKFLOW_STAGES[0];
  if (stage === undefined) throw new Error("Workflow stage fixture is missing");
  return stage;
})();

afterEach(() => vi.restoreAllMocks());

describe("workflow checkpoint phase diagnostics", () => {
  it("emits only closed phase metadata for a validated stage identity", async () => {
    const info = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(measureWorkflowCheckpointPhase({
      operation_id: "run-123",
      stage: TEST_STAGE,
    }, "handler", async () => "ok")).resolves.toBe("ok");
    expect(info).toHaveBeenCalledOnce();
    const event = JSON.parse(String(info.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(Object.keys(event).sort()).toEqual([
      "duration_ms", "event", "operation_id", "phase", "stage", "succeeded",
    ]);
    expect(event).toMatchObject({
      event: "workflow_checkpoint_phase",
      operation_id: "run-123",
      stage: TEST_STAGE,
      phase: "handler",
      succeeded: true,
    });
    expect(event.duration_ms).toEqual(expect.any(Number));
  });

  it("preserves the exact operation error and marks the phase failed", async () => {
    const info = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failure = new Error("private failure details");
    await expect(measureWorkflowCheckpointPhase({
      operation_id: "run-123",
      stage: TEST_STAGE,
    }, "handler", async () => { throw failure; })).rejects.toBe(failure);
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({ succeeded: false });
    expect(String(info.mock.calls[0]?.[0])).not.toContain("private failure details");
  });

  it("suppresses events for invalid identities and ignores logging failures", async () => {
    const info = vi.spyOn(console, "warn").mockImplementation(() => { throw new Error("logger failed"); });
    await expect(measureWorkflowCheckpointPhase({
      operation_id: "bad operation id",
      stage: TEST_STAGE,
    }, "handler", async () => "ok")).resolves.toBe("ok");
    expect(info).not.toHaveBeenCalled();
    await expect(measureWorkflowCheckpointPhase({
      operation_id: "run-123",
      stage: TEST_STAGE,
    }, "handler", async () => "still ok")).resolves.toBe("still ok");
    expect(info).toHaveBeenCalledOnce();
    const operationFailure = new Error("operation failure");
    await expect(measureWorkflowCheckpointPhase({
      operation_id: "run-123",
      stage: TEST_STAGE,
    }, "handler", async () => { throw operationFailure; })).rejects.toBe(operationFailure);
    expect(info).toHaveBeenCalledTimes(2);
  });
});
