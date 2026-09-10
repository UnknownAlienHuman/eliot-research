import { describe, expect, it } from "vitest";
import { defaultResearchWorkflowPlan } from "./index.js";

describe("research workflow", () => {
  it("freezes evidence before synthesis", () => {
    const stages = defaultResearchWorkflowPlan().stages;
    expect(stages.indexOf("FREEZE_EVIDENCE")).toBeLessThan(stages.indexOf("SYNTHESIZE"));
    expect(stages.at(-1)).toBe("MATERIALIZE");
  });
});
