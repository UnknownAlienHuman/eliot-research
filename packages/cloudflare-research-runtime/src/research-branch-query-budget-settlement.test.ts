import { describe, expect, it } from "vitest";
import type { BranchQueryPlan, BranchQueryResult } from "@eliotr/contracts";
import { aggregateBranchQueryBudgetExhaustion } from "./research-branch-query-budget-settlement.js";

const SHA = "a".repeat(64);

describe("aggregate branch-query budget receipt", () => {
  it("binds the exact settled prefix and every unexecuted plan leg", () => {
    const plan = {
      query_plan_ref: { id: "plan-1", revision: 1 },
      identity_digest: SHA,
      query_legs: [
        { query_id: "query-1", query_sha256: SHA },
        { query_id: "query-2", query_sha256: "b".repeat(64) },
      ],
      budgets: {
        candidate_limit: 4,
        scan_limit: 8,
        evidence_limit: 2,
        max_evidence_bytes: 128,
        max_query_legs: 2,
      },
    } as unknown as BranchQueryPlan;
    const settlements: NonNullable<BranchQueryResult["budget_exhaustion"]>["settlements"] = [{
      query_id: "query-1",
      retrieval_request_digest: SHA,
      request_budgets: { candidate_limit: 4, scan_limit: 8, evidence_limit: 2, max_evidence_bytes: 128 },
      usage: { candidateUnitsUsed: 4, exactResolverScanUnitsUsed: 0, evidenceItemsUsed: 0, evidenceBytesUsed: 0 },
    }];

    expect(aggregateBranchQueryBudgetExhaustion({
      plan,
      executed_leg_count: 1,
      remaining: { candidate_limit: 0, scan_limit: 8, evidence_limit: 2, max_evidence_bytes: 128 },
      settlements,
    })).toEqual({
      protocol: "eliotr.research.branch-query-budget-exhaustion.v1",
      query_plan_ref: plan.query_plan_ref,
      query_plan_digest: plan.identity_digest,
      executed_query_refs: [{ query_id: "query-1", query_sha256: SHA }],
      unexecuted_query_refs: [{ query_id: "query-2", query_sha256: "b".repeat(64) }],
      exhausted_dimension: "CANDIDATE_UNITS",
      settlements,
    });
    expect(aggregateBranchQueryBudgetExhaustion({
      plan,
      executed_leg_count: 1,
      remaining: { candidate_limit: 1, scan_limit: 8, evidence_limit: 2, max_evidence_bytes: 128 },
      settlements,
    })).toBeUndefined();
  });
});
