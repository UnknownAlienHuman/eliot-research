import { describe, expect, it } from "vitest";
import { decideBudgetAction, exactLocationEquality } from "./index.js";

describe("policy invariants", () => {
  it("degrades premium intelligence without disabling evidence access", () => {
    const decision = decideBudgetAction({ pool: "total", limit_usd: 100, committed_usd: 100, reserved_usd: 0 });
    expect(decision.action).toBe("BLOCK_PREMIUM_CALLS");
    expect(decision.evidence_access_remains_available).toBe(true);
  });

  it("does not report a subset purge as complete", () => {
    expect(exactLocationEquality(["Blob", "Index"], ["Blob"])).toBe(false);
  });
});
