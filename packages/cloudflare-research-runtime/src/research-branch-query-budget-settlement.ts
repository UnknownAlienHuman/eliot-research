import type { BranchQueryPlan, BranchQueryResult } from "@eliotr/contracts";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import { fail } from "@eliotr/cloudflare-workflows";
import type { RetrievalQueryExecutionV1, RetrievalRequestBudgets } from "@eliotr/retrieval";

type BudgetExhaustion = NonNullable<BranchQueryResult["budget_exhaustion"]>;
type BudgetSettlementEvidence = BudgetExhaustion["settlements"][number];

export function assertBranchQueryBudgetSettlement(input: {
  readonly execution: RetrievalQueryExecutionV1;
  readonly expectedBudgets: RetrievalRequestBudgets;
  readonly expectedDigest: string;
}): NonNullable<RetrievalQueryExecutionV1["budget_settlement"]> {
  const receipt = input.execution.budget_settlement;
  if (receipt === undefined || receipt.request_digest !== input.expectedDigest ||
      canonicalEvidenceJson(receipt.request_budgets) !== canonicalEvidenceJson(input.expectedBudgets) ||
      !Number.isSafeInteger(receipt.usage.candidateUnitsUsed) || receipt.usage.candidateUnitsUsed < 0 ||
      receipt.usage.candidateUnitsUsed > input.expectedBudgets.candidate_limit ||
      !Number.isSafeInteger(receipt.usage.exactResolverScanUnitsUsed) || receipt.usage.exactResolverScanUnitsUsed < 0 ||
      receipt.usage.exactResolverScanUnitsUsed > input.expectedBudgets.scan_limit ||
      !Number.isSafeInteger(receipt.usage.evidenceItemsUsed) || receipt.usage.evidenceItemsUsed < 0 ||
      receipt.usage.evidenceItemsUsed > input.expectedBudgets.evidence_limit ||
      !Number.isSafeInteger(receipt.usage.evidenceBytesUsed) || receipt.usage.evidenceBytesUsed < 0 ||
      receipt.usage.evidenceBytesUsed > input.expectedBudgets.max_evidence_bytes) {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  return receipt;
}

export function branchQueryBudgetSettlementEvidence(input: {
  readonly query_id: string;
  readonly retrieval_request_digest: string;
  readonly request_budgets: RetrievalRequestBudgets;
  readonly settlement: NonNullable<RetrievalQueryExecutionV1["budget_settlement"]>;
}): BudgetSettlementEvidence {
  return {
    query_id: input.query_id,
    retrieval_request_digest: input.retrieval_request_digest,
    request_budgets: { ...input.request_budgets },
    usage: {
      candidateUnitsUsed: input.settlement.usage.candidateUnitsUsed,
      exactResolverScanUnitsUsed: input.settlement.usage.exactResolverScanUnitsUsed,
      evidenceItemsUsed: input.settlement.usage.evidenceItemsUsed,
      evidenceBytesUsed: input.settlement.usage.evidenceBytesUsed,
    },
  };
}

function exhaustedBudgetDimension(value: RetrievalRequestBudgets): BudgetExhaustion["exhausted_dimension"] | null {
  if (value.candidate_limit === 0) return "CANDIDATE_UNITS";
  if (value.scan_limit === 0) return "SCAN_UNITS";
  if (value.evidence_limit === 0) return "EVIDENCE_ITEMS";
  if (value.max_evidence_bytes === 0) return "EVIDENCE_BYTES";
  return null;
}

export function aggregateBranchQueryBudgetExhaustion(input: {
  readonly plan: BranchQueryPlan;
  readonly executed_leg_count: number;
  readonly remaining: RetrievalRequestBudgets;
  readonly settlements: readonly BudgetSettlementEvidence[];
}): BudgetExhaustion | undefined {
  const exhaustedDimension = exhaustedBudgetDimension(input.remaining);
  const unexecuted = input.plan.query_legs.slice(input.executed_leg_count);
  if (exhaustedDimension === null || unexecuted.length === 0) return undefined;
  return {
    protocol: "eliotr.research.branch-query-budget-exhaustion.v1",
    query_plan_ref: input.plan.query_plan_ref,
    query_plan_digest: input.plan.identity_digest,
    executed_query_refs: input.plan.query_legs.slice(0, input.executed_leg_count)
      .map(({ query_id, query_sha256 }) => ({ query_id, query_sha256 })),
    unexecuted_query_refs: unexecuted.map(({ query_id, query_sha256 }) => ({ query_id, query_sha256 })),
    exhausted_dimension: exhaustedDimension,
    settlements: [...input.settlements],
  };
}
