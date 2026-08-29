import { describe, expect, it } from "vitest";
import { compileQueryPlan, reciprocalRankFuse } from "./index.js";

describe("retrieval planning", () => {
  it("does not rerank exhaustive operations", () => {
    const plan = compileQueryPlan({
      raw_query: "needle", product: "EXHAUSTIVE_JOB", literals: ["needle"], requested_limit: 50,
      deadline_ms: 1000,
      scope_snapshot: {} as never,
      policy: {} as never,
    });
    expect(plan.rerank).toBe(false);
    expect(plan.complete_scope_required).toBe(true);
  });

  it("deduplicates candidates by canonical section", () => {
    const base = {
      candidate_id: "c", source_revision_ref: "r", canonical_section_id: "s", preview: "p",
      raw_score: 1, rank: 1, index_generation: "g", metadata: {},
    } as const;
    const result = reciprocalRankFuse(new Map([
      ["LEX", [{ ...base, lane: "LEX" }]],
      ["SEM", [{ ...base, candidate_id: "c2", lane: "SEM" }]],
    ]), { reciprocal_rank_constant: 60, lane_weights: {}, maxPerSourceRevision: 5 });
    expect(result).toHaveLength(1);
  });
});
