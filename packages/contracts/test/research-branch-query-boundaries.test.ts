import { describe, expect, it } from "vitest";
import { RetrievalLaneSchema, RetrievalTraceSchema } from "../src/retrieval.js";
import {
  BranchQueryResultSchema,
  branchQueryResultMatchesPlan,
  type BranchQueryPlan,
} from "../src/research-branch-query.js";
import {
  BranchQueryBudgetExhaustionReceiptSchema,
  branchQueryBudgetExhaustionMatchesPlan,
} from "../src/research-branch-query-budget.js";

const SHA = "a".repeat(64);
const scopeRef = { id: "scope-query-boundary", revision: 1 };
const scopeSnapshot = {
  snapshot_id: scopeRef.id,
  revision: scopeRef.revision,
  resolved_scope_expression: { kind: "GLOBAL_LIBRARY" as const },
  participant_generations: {},
  member_source_revision_refs: [],
  source_owner_generations: {},
  policy_authority_ref: "policy-1",
  disclosure_closure_digest: SHA,
  purge_ledger_revision: 0,
  digest: SHA,
  created_at: "2026-01-01T00:00:00.000Z",
  expires_at: "2027-01-01T00:00:00.000Z",
};

function legacyTrace(rawQuery: string) {
  return RetrievalTraceSchema.parse({
    trace_ref: { id: "historical-trace", revision: 1 },
    raw_query: rawQuery,
    scope_snapshot: scopeSnapshot,
    query_product: "FAST_SEARCH",
    lanes_used: ["LEX"],
    lanes_skipped: [],
    exact_probes: [],
    index_generations: [],
    context_expansion: 0,
    candidates_by_lane: Object.fromEntries(RetrievalLaneSchema.options.map((lane) => [lane, 0])),
    expansion_refs: [],
    represented_source_refs: [],
    omitted_sources: [],
    stale_or_degraded_channels: [],
    budget_receipt_ref: "budget-1",
  });
}

function leg(input: {
  readonly query_id: string;
  readonly status: "COMPLETED" | "FAILED";
  readonly stop_reason?: "NO_HITS" | "CANDIDATE_BUDGET";
  readonly omitted_candidates?: readonly { readonly candidate_id: string; readonly reason_code: string }[];
}) {
  return {
    status: input.status,
    query_id: input.query_id,
    query_sha256: SHA,
    retrieval_request_digest: SHA,
    scope_snapshot_ref: scopeRef,
    scope_snapshot_digest: SHA,
    ...(input.status === "COMPLETED" ? {
      trace: legacyTrace("foreign query"),
      stop_reason: input.stop_reason ?? "NO_HITS",
    } : { failure_code: "RETRIEVAL_FAILED", stop_reason: "LEG_FAILED" }),
    resolved_handle_refs: [],
    omitted_candidates: input.omitted_candidates ?? [],
  };
}

function result(input: {
  readonly query_legs: readonly ReturnType<typeof leg>[];
  readonly stop_reason: "BUDGET_EXHAUSTED" | "ALL_LEGS_FAILED" | "NO_HITS";
  readonly failure_disposition: "NONE" | "ALL_FAILED";
  readonly budget_exhaustion?: unknown;
}) {
  return {
    protocol: "eliotr.research.branch-query-result.v1",
    query_result_ref: { id: `eliotr.research.branch-query-result-${SHA}`, revision: 1 },
    identity_digest: SHA,
    query_plan_ref: { id: `eliotr.research.branch-query-plan-${SHA}`, revision: 1 },
    query_plan_digest: SHA,
    role: "SUPPORT",
    scope_snapshot_ref: scopeRef,
    scope_snapshot_digest: SHA,
    query_legs: input.query_legs,
    ...(input.budget_exhaustion === undefined ? {} : { budget_exhaustion: input.budget_exhaustion }),
    resolved_evidence: [],
    omitted_candidate_refs: [...new Set(input.query_legs.flatMap((item) => item.omitted_candidates.map((omission) => omission.candidate_id)))],
    total_utf8_bytes: 0,
    stop_reason: input.stop_reason,
    failure_disposition: input.failure_disposition,
  };
}

describe("branch-query provenance boundaries", () => {
  it("preserves legacy trace parsing but rejects that trace as new-plan evidence", () => {
    const legacy = legacyTrace("foreign query");
    const queryResult = BranchQueryResultSchema.parse(result({
      query_legs: [leg({ query_id: "query-1", status: "COMPLETED" })],
      stop_reason: "NO_HITS",
      failure_disposition: "NONE",
    }));
    const plan = {
      role: "SUPPORT",
      query_plan_ref: queryResult.query_plan_ref,
      identity_digest: SHA,
      scope_snapshot_ref: scopeRef,
      scope_snapshot_digest: SHA,
      query_legs: [{ query_id: "query-1", query_sha256: SHA, query: "planned query", literal_probes: [] }],
      retrieval_product: "RESEARCH",
      budgets: { evidence_limit: 2, max_evidence_bytes: 128 },
      stop_rule: "EXHAUST_QUERY_LEGS",
    } as unknown as BranchQueryPlan;

    expect(RetrievalTraceSchema.safeParse(legacy).success).toBe(true);
    expect(branchQueryResultMatchesPlan(plan, queryResult)).toBe(false);
  });

  it("does not relabel all failures or a no-hit prefix as budget exhaustion", () => {
    expect(BranchQueryResultSchema.safeParse(result({
      query_legs: [leg({ query_id: "query-1", status: "FAILED" })],
      stop_reason: "BUDGET_EXHAUSTED",
      failure_disposition: "ALL_FAILED",
    })).success).toBe(false);
    expect(BranchQueryResultSchema.safeParse(result({
      query_legs: [leg({ query_id: "query-1", status: "COMPLETED" })],
      stop_reason: "BUDGET_EXHAUSTED",
      failure_disposition: "NONE",
    })).success).toBe(false);
  });

  it("accepts a leg budget stop only with the matching bounded omission", () => {
    const budgetLeg = leg({
      query_id: "query-1",
      status: "COMPLETED",
      stop_reason: "CANDIDATE_BUDGET",
      omitted_candidates: [{ candidate_id: "candidate-1", reason_code: "CANDIDATE_LIMIT" }],
    });
    expect(BranchQueryResultSchema.safeParse(result({
      query_legs: [budgetLeg],
      stop_reason: "BUDGET_EXHAUSTED",
      failure_disposition: "NONE",
    })).success).toBe(true);
    expect(BranchQueryResultSchema.safeParse(result({
      query_legs: [{ ...budgetLeg,
        omitted_candidates: [{ candidate_id: "candidate-1", reason_code: "NOT_ADMITTED" }],
      }],
      stop_reason: "BUDGET_EXHAUSTED",
      failure_disposition: "NONE",
    })).success).toBe(false);
  });

  it("binds aggregate exhaustion to settled usage and the exact unexecuted suffix", () => {
    const plan = {
      query_plan_ref: { id: `eliotr.research.branch-query-plan-${SHA}`, revision: 1 },
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
    };
    const receipt = BranchQueryBudgetExhaustionReceiptSchema.parse({
      protocol: "eliotr.research.branch-query-budget-exhaustion.v1",
      query_plan_ref: plan.query_plan_ref,
      query_plan_digest: SHA,
      executed_query_refs: [{ query_id: "query-1", query_sha256: SHA }],
      unexecuted_query_refs: [{ query_id: "query-2", query_sha256: "b".repeat(64) }],
      exhausted_dimension: "CANDIDATE_UNITS",
      settlements: [{
        query_id: "query-1",
        retrieval_request_digest: SHA,
        request_budgets: { candidate_limit: 4, scan_limit: 8, evidence_limit: 2, max_evidence_bytes: 128 },
        usage: { candidateUnitsUsed: 4, exactResolverScanUnitsUsed: 0, evidenceItemsUsed: 0, evidenceBytesUsed: 0 },
      }],
    });
    const resultLeg = {
      status: "COMPLETED" as const,
      query_id: "query-1",
      query_sha256: SHA,
      retrieval_request_digest: SHA,
    };
    const resultShape = {
      query_plan_ref: plan.query_plan_ref,
      query_plan_digest: SHA,
      query_legs: [resultLeg],
      stop_reason: "BUDGET_EXHAUSTED",
      budget_exhaustion: receipt,
    };

    expect(branchQueryBudgetExhaustionMatchesPlan(plan, resultShape)).toBe(true);
    expect(branchQueryBudgetExhaustionMatchesPlan(plan, {
      ...resultShape,
      budget_exhaustion: {
        ...receipt,
        unexecuted_query_refs: [{ query_id: "query-1", query_sha256: SHA }],
      },
    })).toBe(false);
    expect(branchQueryBudgetExhaustionMatchesPlan(plan, {
      ...resultShape,
      budget_exhaustion: {
        ...receipt,
        settlements: [{ ...receipt.settlements[0], usage: {
          candidateUnitsUsed: 3, exactResolverScanUnitsUsed: 0, evidenceItemsUsed: 0, evidenceBytesUsed: 0,
        } }],
      },
    })).toBe(false);
  });
});
