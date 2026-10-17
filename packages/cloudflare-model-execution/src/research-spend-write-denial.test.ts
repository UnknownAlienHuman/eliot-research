import { describe, expect, it } from "vitest";
import { workflowFailure } from "@eliotr/cloudflare-workflows";
import { researchSpendWriteDenial } from "./research-spend-write-denial.js";

describe("spend admission denial before model dispatch", () => {
  it.each([
    new Error("D1_ERROR: MODEL_SPEND_ADMISSION_AUTHORITY_STALE: SQLITE_CONSTRAINT"),
    new Error("D1_ERROR", { cause: new Error("MODEL_SPEND_ADMISSION_AUTHORITY_STALE") }),
  ])("preserves a known trigger denial without claiming an uncertain paid call", cause => {
    const denied = researchSpendWriteDenial(cause);
    expect(denied).toBeDefined();
    expect(workflowFailure(denied, "STAGE", "SYNTHESIZE")).toMatchObject({
      code: "MODEL_ATTEMPT_AUTHORITY_STALE", dispatch_state: "NOT_STARTED", retryable: false,
      recovery_action: "NONE", references_intact: "UNKNOWN",
    });
    expect(JSON.stringify(workflowFailure(denied, "STAGE", "SYNTHESIZE"))).not.toContain("D1_ERROR");
  });

  it.each([new Error("D1 readback unavailable"), new Error("MODEL_SPEND_ADMISSION_AUTHORITY_STALE_EXTRA"),
    { code: "MODEL_SPEND_ADMISSION_AUTHORITY_STALE" }, null])("leaves unclassified failures uncertain", cause => {
    expect(researchSpendWriteDenial(cause)).toBeUndefined();
  });

  it("does not execute diagnostic getters", () => {
    const cause = Object.defineProperties({}, {
      message: { get() { throw new Error("message getter must not run"); } },
      cause: { get() { throw new Error("cause getter must not run"); } },
    });
    expect(researchSpendWriteDenial(cause)).toBeUndefined();
  });
});
