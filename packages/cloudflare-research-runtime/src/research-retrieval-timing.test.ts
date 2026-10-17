import { describe, expect, it, vi } from "vitest";
import {
  createResearchRetrievalTimingRecorder,
  type ResearchRetrievalTimingSample,
} from "./research-retrieval-timing.js";

describe("Research retrieval timing metadata", () => {
  it("aggregates bounded allowlisted phases and emits no request or evidence data", () => {
    const write = vi.fn<(line: string) => void>();
    const timing = createResearchRetrievalTimingRecorder("run-safe", write);

    timing.record({ phase: "lane", lane: "SEM", duration_ms: 20, succeeded: true,
      prompt: "must not be logged", evidence_body: "must not be logged",
      output_object_ref: "must-not-be-logged" } as ResearchRetrievalTimingSample);
    timing.record({ phase: "lane", lane: "SEM", duration_ms: 30, succeeded: false });
    timing.record({ phase: "currentness", duration_ms: 3, succeeded: true });
    timing.record({ phase: "currentness", duration_ms: 4, succeeded: true });
    timing.record({ phase: "evidence_resolution", duration_ms: 1_000_000, succeeded: true });
    timing.record({ phase: "lane", lane: "LEX", duration_ms: 5, succeeded: true,
      idempotency_key: "must not be logged" } as ResearchRetrievalTimingSample);

    timing.flush();
    timing.flush();

    expect(write).toHaveBeenCalledOnce();
    const line = write.mock.calls[0]?.[0];
    expect(typeof line).toBe("string");
    const event = JSON.parse(line as string) as Record<string, unknown>;
    expect(Object.keys(event).sort()).toEqual(["event", "operation_id", "phases", "protocol", "stage"]);
    expect(event).toMatchObject({
      event: "research_retrieval_phase_timing",
      protocol: "eliotr.research-retrieval-phase-timing.v1",
      stage: "RETRIEVE_BRANCHES",
      operation_id: "run-safe",
    });
    expect(event.phases).toEqual([
      { phase: "lane", lane: "LEX", duration_ms: 5, calls: 1, succeeded: true },
      { phase: "lane", lane: "SEM", duration_ms: 50, calls: 2, succeeded: false },
      { phase: "evidence_resolution", duration_ms: 600_000, calls: 1, succeeded: true },
      { phase: "currentness", duration_ms: 7, calls: 2, succeeded: true },
    ]);
    expect(line).not.toContain("must not be logged");
    expect(line).not.toContain("idempotency_key");
    expect(line).not.toContain("output_object_ref");
  });
});
