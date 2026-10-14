import { z } from "zod";
import { IdentifierSchema, Sha256Schema, VersionedRefSchema } from "./common.js";

export const MAX_BRANCH_QUERY_LEGS = 4;

const BranchQueryBudgetUsageSchema = z.object({
  candidateUnitsUsed: z.number().int().nonnegative().max(512),
  exactResolverScanUnitsUsed: z.number().int().nonnegative().max(4_096),
  evidenceItemsUsed: z.number().int().nonnegative().max(64),
  evidenceBytesUsed: z.number().int().nonnegative().max(64 * 1024),
}).strict();

const BranchQueryBudgetLimitsSchema = z.object({
  candidate_limit: z.number().int().positive().max(512),
  scan_limit: z.number().int().positive().max(4_096),
  evidence_limit: z.number().int().positive().max(64),
  max_evidence_bytes: z.number().int().positive().max(64 * 1024),
}).strict();

const BranchQueryBudgetSettlementEvidenceSchema = z.object({
  query_id: IdentifierSchema,
  retrieval_request_digest: Sha256Schema,
  request_budgets: BranchQueryBudgetLimitsSchema,
  usage: BranchQueryBudgetUsageSchema,
}).strict();

const BranchQueryRefSchema = z.object({
  query_id: IdentifierSchema,
  query_sha256: Sha256Schema,
}).strict();

export const BranchQueryBudgetExhaustionReceiptSchema = z.object({
  protocol: z.literal("eliotr.research.branch-query-budget-exhaustion.v1"),
  query_plan_ref: VersionedRefSchema,
  query_plan_digest: Sha256Schema,
  executed_query_refs: z.array(BranchQueryRefSchema).min(1).max(MAX_BRANCH_QUERY_LEGS),
  unexecuted_query_refs: z.array(BranchQueryRefSchema).min(1).max(MAX_BRANCH_QUERY_LEGS),
  exhausted_dimension: z.enum(["CANDIDATE_UNITS", "SCAN_UNITS", "EVIDENCE_ITEMS", "EVIDENCE_BYTES"]),
  settlements: z.array(BranchQueryBudgetSettlementEvidenceSchema).min(1).max(MAX_BRANCH_QUERY_LEGS),
}).strict();
export type BranchQueryBudgetExhaustionReceipt = z.infer<typeof BranchQueryBudgetExhaustionReceiptSchema>;

const BUDGET_STOP_REASONS = ["CANDIDATE_BUDGET", "SCAN_BUDGET", "EVIDENCE_BUDGET"] as const;

export function branchQueryBudgetStopReasonIsValid(leg: {
  readonly status: "COMPLETED" | "FAILED";
  readonly stop_reason: string;
  readonly omitted_candidates: readonly { readonly reason_code: string }[];
}): boolean {
  if (!BUDGET_STOP_REASONS.includes(leg.stop_reason as (typeof BUDGET_STOP_REASONS)[number])) return true;
  const reasonCodes = leg.omitted_candidates.map((item) => item.reason_code);
  const matchingOmission = leg.stop_reason === "CANDIDATE_BUDGET"
    ? reasonCodes.some((code) => code === "CANDIDATE_LIMIT" || code === "FUSION_CANDIDATE_LIMIT")
    : leg.stop_reason === "SCAN_BUDGET"
      ? reasonCodes.some((code) => code === "DIVERSITY_SCAN_LIMIT" || code === "EXACT_RESOLUTION_SCAN_LIMIT")
      : reasonCodes.some((code) => code === "EVIDENCE_LIMIT" || code === "EVIDENCE_UTF8_LIMIT");
  return leg.status === "COMPLETED" && matchingOmission;
}

export function branchQueryHasMaterialBudgetStop(leg: {
  readonly status: "COMPLETED" | "FAILED";
  readonly stop_reason: string;
  readonly omitted_candidates: readonly { readonly reason_code: string }[];
}): boolean {
  return BUDGET_STOP_REASONS.includes(leg.stop_reason as (typeof BUDGET_STOP_REASONS)[number]) &&
    branchQueryBudgetStopReasonIsValid(leg);
}

interface BudgetResultShape {
  readonly query_plan_ref: { readonly id: string; readonly revision: number };
  readonly query_plan_digest: string;
  readonly query_legs: readonly {
    readonly status: "COMPLETED" | "FAILED";
    readonly query_id: string;
    readonly query_sha256: string;
    readonly retrieval_request_digest: string;
    readonly stop_reason: string;
    readonly omitted_candidates: readonly { readonly reason_code: string }[];
  }[];
  readonly stop_reason: string;
  readonly budget_exhaustion?: BranchQueryBudgetExhaustionReceipt | undefined;
}

interface BudgetPlanShape {
  readonly query_plan_ref: { readonly id: string; readonly revision: number };
  readonly identity_digest: string;
  readonly query_legs: readonly { readonly query_id: string; readonly query_sha256: string }[];
  readonly budgets: {
    readonly candidate_limit: number;
    readonly scan_limit: number;
    readonly evidence_limit: number;
    readonly max_evidence_bytes: number;
  };
}

export function branchQueryBudgetExhaustionStructureMatchesResult(value: BudgetResultShape): boolean {
  const receipt = value.budget_exhaustion;
  if (receipt === undefined) return true;
  return value.stop_reason === "BUDGET_EXHAUSTED" &&
    receipt.query_plan_ref.id === value.query_plan_ref.id &&
    receipt.query_plan_ref.revision === value.query_plan_ref.revision &&
    receipt.query_plan_digest === value.query_plan_digest &&
    receipt.executed_query_refs.length === value.query_legs.length &&
    receipt.settlements.length === value.query_legs.length &&
    value.query_legs.every((leg, index) => {
      const executed = receipt.executed_query_refs[index];
      const settlement = receipt.settlements[index];
      return leg.status === "COMPLETED" && executed?.query_id === leg.query_id &&
        executed.query_sha256 === leg.query_sha256 && settlement?.query_id === leg.query_id &&
        settlement.retrieval_request_digest === leg.retrieval_request_digest &&
        settlement.usage.candidateUnitsUsed <= settlement.request_budgets.candidate_limit &&
        settlement.usage.exactResolverScanUnitsUsed <= settlement.request_budgets.scan_limit &&
        settlement.usage.evidenceItemsUsed <= settlement.request_budgets.evidence_limit &&
        settlement.usage.evidenceBytesUsed <= settlement.request_budgets.max_evidence_bytes;
    }) &&
    new Set(receipt.executed_query_refs.map((item) => item.query_id)).size === receipt.executed_query_refs.length &&
    new Set(receipt.unexecuted_query_refs.map((item) => item.query_id)).size === receipt.unexecuted_query_refs.length &&
    receipt.unexecuted_query_refs.every((item) =>
      !receipt.executed_query_refs.some((executed) => executed.query_id === item.query_id));
}

function exhaustedBudgetDimension(remaining: BudgetPlanShape["budgets"]): BranchQueryBudgetExhaustionReceipt["exhausted_dimension"] | null {
  if (remaining.candidate_limit === 0) return "CANDIDATE_UNITS";
  if (remaining.scan_limit === 0) return "SCAN_UNITS";
  if (remaining.evidence_limit === 0) return "EVIDENCE_ITEMS";
  if (remaining.max_evidence_bytes === 0) return "EVIDENCE_BYTES";
  return null;
}

export function branchQueryBudgetExhaustionMatchesPlan(plan: BudgetPlanShape, result: BudgetResultShape): boolean {
  const receipt = result.budget_exhaustion;
  if (receipt === undefined) {
    if (result.stop_reason !== "BUDGET_EXHAUSTED") return true;
    const finalLeg = result.query_legs[result.query_legs.length - 1];
    return finalLeg !== undefined && branchQueryHasMaterialBudgetStop(finalLeg);
  }
  if (result.stop_reason !== "BUDGET_EXHAUSTED" || result.query_legs.some((leg) => leg.status !== "COMPLETED") ||
      receipt.query_plan_ref.id !== plan.query_plan_ref.id ||
      receipt.query_plan_ref.revision !== plan.query_plan_ref.revision ||
      receipt.query_plan_digest !== plan.identity_digest) return false;
  const executed = plan.query_legs.slice(0, result.query_legs.length);
  const unexecuted = plan.query_legs.slice(result.query_legs.length);
  if (unexecuted.length === 0 || receipt.executed_query_refs.length !== executed.length ||
      receipt.unexecuted_query_refs.length !== unexecuted.length || receipt.settlements.length !== executed.length) return false;
  const sameQueryRefs = (actual: readonly { readonly query_id: string; readonly query_sha256: string }[],
    expected: readonly { readonly query_id: string; readonly query_sha256: string }[]): boolean =>
    actual.length === expected.length && actual.every((item, index) =>
      item.query_id === expected[index]?.query_id && item.query_sha256 === expected[index]?.query_sha256);
  if (!sameQueryRefs(receipt.executed_query_refs, executed) ||
      !sameQueryRefs(receipt.unexecuted_query_refs, unexecuted)) return false;

  let remaining = { ...plan.budgets };
  for (let index = 0; index < receipt.settlements.length; index += 1) {
    const settlement = receipt.settlements[index];
    const leg = result.query_legs[index];
    if (settlement === undefined || leg === undefined || settlement.query_id !== leg.query_id ||
        settlement.retrieval_request_digest !== leg.retrieval_request_digest ||
        settlement.request_budgets.candidate_limit !== remaining.candidate_limit ||
        settlement.request_budgets.scan_limit !== remaining.scan_limit ||
        settlement.request_budgets.evidence_limit !== remaining.evidence_limit ||
        settlement.request_budgets.max_evidence_bytes !== remaining.max_evidence_bytes) return false;
    remaining = {
      candidate_limit: remaining.candidate_limit - settlement.usage.candidateUnitsUsed,
      scan_limit: remaining.scan_limit - settlement.usage.exactResolverScanUnitsUsed,
      evidence_limit: remaining.evidence_limit - settlement.usage.evidenceItemsUsed,
      max_evidence_bytes: remaining.max_evidence_bytes - settlement.usage.evidenceBytesUsed,
    };
    if (Object.values(remaining).some((value) => value < 0)) return false;
  }
  return exhaustedBudgetDimension(remaining) === receipt.exhausted_dimension;
}
