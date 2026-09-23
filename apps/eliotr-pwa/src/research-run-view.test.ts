import { describe, expect, it } from "vitest";
import { badgeText, idleBadgeText, idleProgressText, researchHistoryCards, statusText } from "./research-run-view.js";
import type { ResearchRunHistoryView, ResearchRunStatusView } from "./research-run-api.js";

const status: ResearchRunStatusView = {
  workflow_instance_id: `run-${"a".repeat(48)}`, investigation_ref: { id: "investigation-1", revision: 1 },
  execution_state: "ENGINE_COMPLETED", engine_status: "complete", next_stage_index: 18,
  answer: { availability: "draft", artifact_ref: { id: "draft-1", revision: 1 } }, deployment_generation: "test-1",
};

describe("Research presentation preserves execution facts", () => {
  it.each([
    [false, false, "WAITING"], [false, true, "WAITING"], [true, false, "BLOCKED"], [true, true, "READY"],
  ] as const)("requires health=%s and configuration=%s for %s", (health, configured, expected) => {
    expect(idleBadgeText(health, configured)).toBe(expected);
  });
  it("directs a blocked question to Connections without asserting readiness", () => {
    expect(idleProgressText(true, false)).toContain("Connections");
    expect(idleProgressText(true, false)).toContain("unavailable");
  });
  it("does not promote an engine completion or an unverified draft to an answer", () => {
    expect(badgeText(status)).toBe("DRAFT");
    expect(statusText(status)).toContain("review");
    expect(statusText({ ...status, answer: { availability: "unavailable" } })).toContain("No answer");
    expect(badgeText({ ...status, execution_state: "CANCELLED" })).toBe("CANCELLED");
  });
  it("sorts history without mutating it or collapsing different artifact revisions", () => {
    const view: ResearchRunHistoryView = {
      protocol: "eliotr.research-runs.v3", deployment_generation: "test-1", configuration_state: "INSTALLED", checked_at: "2026-09-23T00:00:00.000Z",
      runs: [{ created_at: "2026-09-21T00:00:00.000Z", status }],
      saved_drafts: [
        { artifact_ref: { id: "draft-1", revision: 1 }, created_at: "2026-09-21T00:00:00.000Z" },
        { artifact_ref: { id: "draft-1", revision: 2 }, created_at: "2026-09-22T00:00:00.000Z" },
      ],
    };
    const original = structuredClone(view);
    const cards = researchHistoryCards(view);
    expect(cards).toEqual([{ created_at: view.saved_drafts[1]?.created_at, draft: view.saved_drafts[1] }, { created_at: view.runs[0]?.created_at, entry: view.runs[0] }]);
    expect(view).toEqual(original);
  });
});
