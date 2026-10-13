import type { LocatorCandidate, RetrievalLane } from "@eliotr/contracts";
import type { QueryPlan } from "./planner.js";
import type { RetrievalLaneRegistry } from "./lanes.js";
import type {
  RetrievalLaneExecutionContextV1,
  RetrievalLaneExecutionResult,
  RetrievalRequest,
  RetrievalRequestBudgets,
} from "./ports.js";

const PROVIDER_CANDIDATE_MAX = 50;
const FUSION_CANDIDATE_MAX = 500;
const DIVERSITY_SCAN_MAX = 250;
const EXHAUSTIVE_DIVERSITY_SCAN_MAX = 500;
const EXACT_RESOLUTION_SCAN_MAX = 100;
const EXHAUSTIVE_EXACT_RESOLUTION_SCAN_MAX = 500;
const EVIDENCE_UTF8_MAX = 8 * 1024 * 1024;

/** Six independent server-owned caps derived from existing contract/provider ceilings and four legacy budgets. */
export interface RetrievalExecutionBoundsV1 {
  readonly provider_candidate_limit: number;
  readonly fusion_candidate_limit: number;
  readonly diversity_scan_limit: number;
  readonly exact_resolution_scan_limit: number;
  readonly evidence_limit: number;
  readonly evidence_utf8_limit: number;
}

export function createRetrievalExecutionBoundsV1(
  plan: Pick<QueryPlan, "complete_scope_required" | "max_candidates_before_policy_recheck">,
  request: Pick<RetrievalRequest, "requested_limit" | "budgets">,
): RetrievalExecutionBoundsV1 {
  const budgets = request.budgets;
  const planCandidateLimit = Math.max(0, plan.max_candidates_before_policy_recheck);
  const requestedLimit = Number.isSafeInteger(request.requested_limit) && request.requested_limit > 0
    ? request.requested_limit
    : 1;
  const fusionCandidateLimit = Math.min(
    FUSION_CANDIDATE_MAX,
    planCandidateLimit,
    budgets?.candidate_limit ?? FUSION_CANDIDATE_MAX,
  );
  return Object.freeze({
    provider_candidate_limit: Math.min(
      PROVIDER_CANDIDATE_MAX,
      fusionCandidateLimit,
      budgets?.candidate_limit ?? PROVIDER_CANDIDATE_MAX,
    ),
    fusion_candidate_limit: fusionCandidateLimit,
    diversity_scan_limit: Math.min(
      planCandidateLimit,
      plan.complete_scope_required ? EXHAUSTIVE_DIVERSITY_SCAN_MAX : DIVERSITY_SCAN_MAX,
      budgets?.candidate_limit ?? Number.MAX_SAFE_INTEGER,
    ),
    exact_resolution_scan_limit: Math.min(
      planCandidateLimit,
      plan.complete_scope_required ? EXHAUSTIVE_EXACT_RESOLUTION_SCAN_MAX : EXACT_RESOLUTION_SCAN_MAX,
      budgets?.scan_limit ?? Number.MAX_SAFE_INTEGER,
    ),
    evidence_limit: Math.min(requestedLimit, budgets?.evidence_limit ?? requestedLimit),
    evidence_utf8_limit: Math.min(EVIDENCE_UTF8_MAX, budgets?.max_evidence_bytes ?? EVIDENCE_UTF8_MAX),
  });
}

/** Mutable execution counters owned by one retrieval, across all its lane outputs. */
export interface RetrievalCandidateUsageV1 {
  readonly candidateUnitsUsed: number;
  readonly providerCandidatesReturned: number;
}

export interface RetrievalCandidateBudgetV1 {
  readonly lanes: RetrievalLaneRegistry;
  readonly bounds: RetrievalExecutionBoundsV1;
  readonly candidateLimitOmissions: readonly LocatorCandidate[];
  readonly usage: RetrievalCandidateUsageV1;
  isExhausted(): boolean;
}

function candidateRows(result: RetrievalLaneExecutionResult): readonly LocatorCandidate[] {
  return isManagedExecution(result) ? result.candidates : result;
}

function boundedResult(
  result: RetrievalLaneExecutionResult,
  admitted: readonly LocatorCandidate[],
): RetrievalLaneExecutionResult {
  if (!isManagedExecution(result)) return admitted;
  return { ...result, candidates: admitted };
}

function isManagedExecution(result: RetrievalLaneExecutionResult): result is Exclude<
  RetrievalLaneExecutionResult,
  readonly LocatorCandidate[]
> {
  return !Array.isArray(result) && typeof result === "object" && result !== null && "execution_state" in result;
}

function effectiveBudgets(
  request: RetrievalRequest,
  bounds: RetrievalExecutionBoundsV1,
  candidateLimit: number,
): RetrievalRequestBudgets {
  return {
    candidate_limit: candidateLimit,
    scan_limit: Math.min(
      request.budgets?.scan_limit ?? bounds.exact_resolution_scan_limit,
      bounds.exact_resolution_scan_limit,
    ),
    evidence_limit: Math.min(
      request.budgets?.evidence_limit ?? bounds.evidence_limit,
      bounds.evidence_limit,
    ),
    max_evidence_bytes: Math.min(
      request.budgets?.max_evidence_bytes ?? bounds.evidence_utf8_limit,
      bounds.evidence_utf8_limit,
    ),
  };
}

/** Apply the aggregate input bound before fusion and pass SEM its remaining 50-row provider cap. */
export function createRetrievalCandidateBudgetV1(
  source: RetrievalLaneRegistry,
  bounds: RetrievalExecutionBoundsV1,
): RetrievalCandidateBudgetV1 {
  let candidateUnitsUsed = 0;
  let providerCandidatesReturned = 0;
  const candidateLimitOmissions: LocatorCandidate[] = [];
  const candidateLimit = bounds.fusion_candidate_limit;
  const lanes: RetrievalLaneRegistry = {
    executorFor(lane: RetrievalLane) {
      const executor = source.executorFor(lane);
      if (executor === null) return null;
      const managedOutcomeCapable = executor.managed_outcome_capable;
      return {
        ...(managedOutcomeCapable === undefined
          ? {}
          : { managed_outcome_capable: managedOutcomeCapable }),
        async execute(executedLane, request, context?: RetrievalLaneExecutionContextV1) {
          const remaining = Math.max(0, candidateLimit - candidateUnitsUsed);
          if (remaining === 0) return [];
          const laneLimit = executedLane === "SEM"
            ? Math.min(remaining, bounds.provider_candidate_limit)
            : remaining;
          if (laneLimit === 0) return [];
          const effectiveRequest: RetrievalRequest = {
            ...request,
            budgets: effectiveBudgets(request, bounds, laneLimit),
          };
          const effectiveContext: RetrievalLaneExecutionContextV1 | undefined = executedLane !== "SEM"
            ? context
            : context === undefined
              ? { provider_candidate_limit: laneLimit }
              : { ...context, provider_candidate_limit: laneLimit };
          const result = await executor.execute(executedLane, effectiveRequest, effectiveContext);
          const returned = candidateRows(result);
          if (executedLane === "SEM") providerCandidatesReturned += returned.length;
          const admitted = returned.slice(0, laneLimit);
          candidateLimitOmissions.push(...returned.slice(laneLimit));
          candidateUnitsUsed += admitted.length;
          return boundedResult(result, admitted);
        },
      };
    },
  };
  return {
    lanes,
    bounds,
    candidateLimitOmissions,
    usage: {
      get candidateUnitsUsed() { return candidateUnitsUsed; },
      get providerCandidatesReturned() { return providerCandidatesReturned; },
    },
    isExhausted: () => candidateUnitsUsed >= candidateLimit,
  };
}
