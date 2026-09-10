import { describe, expect, it } from "vitest";
import { decideBudgetAction, exactLocationEquality, type BudgetPoolState } from "./index.js";

describe("policy invariants", () => {
  it("applies warning and action thresholds at 70% while retaining evidence access", () => {
    const warning = decideBudgetAction({ pool: "total", limit_usd: 100, committed_usd: 69, reserved_usd: 1 });
    expect(warning).toMatchObject({ utilization: 0.7, action: "REDUCE_SPECULATIVE_MAINTENANCE", warning: true });
    expect(warning.evidence_access_remains_available).toBe(true);
    const belowWarning = decideBudgetAction({ pool: "total", limit_usd: 100, committed_usd: 69, reserved_usd: 0 });
    expect(belowWarning).toMatchObject({ utilization: 0.69, action: "ALLOW", warning: false });
  });

  it("keeps each higher threshold ordered and reserves block for 100%", () => {
    expect(decideBudgetAction({ pool: "total", limit_usd: 100, committed_usd: 79, reserved_usd: 1 }).action)
      .toBe("STOP_OPTIONAL_DISTILLATION");
    expect(decideBudgetAction({ pool: "total", limit_usd: 100, committed_usd: 89, reserved_usd: 1 }).action)
      .toBe("FORCE_ECONOMY_DEFAULT");
    expect(decideBudgetAction({ pool: "total", limit_usd: 100, committed_usd: 94, reserved_usd: 1 }).action)
      .toBe("REQUIRE_EXPLICIT_CONFIRMATION");
    const blocked = decideBudgetAction({ pool: "total", limit_usd: 100, committed_usd: 99, reserved_usd: 1 });
    expect(blocked).toMatchObject({ action: "BLOCK_PREMIUM_CALLS", warning: true, evidence_access_remains_available: true });
  });

  it("rejects malformed pool amounts and arithmetic overflow", () => {
    const malformed = [
      { pool: "unknown", limit_usd: 100, committed_usd: 0, reserved_usd: 0 },
      { pool: "total", limit_usd: Number.NaN, committed_usd: 0, reserved_usd: 0 },
      { pool: "total", limit_usd: 100, committed_usd: -1, reserved_usd: 0 },
      { pool: "total", limit_usd: 100, committed_usd: Number.POSITIVE_INFINITY, reserved_usd: 0 },
      { pool: "total", limit_usd: Number.MAX_VALUE, committed_usd: Number.MAX_VALUE, reserved_usd: Number.MAX_VALUE },
    ] as unknown as BudgetPoolState[];
    for (const state of malformed) expect(() => decideBudgetAction(state)).toThrow(RangeError);
  });

  it("degrades premium intelligence without disabling evidence access at zero limit", () => {
    const decision = decideBudgetAction({ pool: "total", limit_usd: 0, committed_usd: 0, reserved_usd: 0 });
    expect(decision.action).toBe("BLOCK_PREMIUM_CALLS");
    expect(decision.warning).toBe(true);
    expect(decision.evidence_access_remains_available).toBe(true);
  });

  it("does not report a subset purge as complete", () => {
    expect(exactLocationEquality(["Blob", "Index"], ["Blob"])).toBe(false);
  });
});
