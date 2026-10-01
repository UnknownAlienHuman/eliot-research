import { describe, expect, it, vi } from "vitest";
import { settleW1BranchObservations } from "./research-w1-observations.js";

describe("settleW1BranchObservations", () => {
  it("settles nothing when the run generation never executed branches", async () => {
    const database = { prepare: vi.fn() } as unknown as D1Database;
    const work_bucket = { get: vi.fn() } as unknown as R2Bucket;
    const settled = await settleW1BranchObservations({
      database,
      work_bucket,
      operation_id: "op-1",
      investigation_id: "inv-1",
      principal_ref: "owner-1",
      branch_execution: false,
    });
    expect(settled).toBeNull();
    // No database or bucket touch: a legacy COUNTER_SEARCH is not decoded.
    expect(database.prepare).not.toHaveBeenCalled();
    expect(work_bucket.get).not.toHaveBeenCalled();
  });
});
