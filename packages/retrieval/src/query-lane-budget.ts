import type { LocatorCandidate, RetrievalLane } from "@eliotr/contracts";
import type { RetrievalLaneRegistry } from "./lanes.js";
import type { RetrievalRequest, RetrievalRequestBudgets } from "./ports.js";

/** Mutable execution counters owned by one retrieval, across all its lane outputs. */
export interface RetrievalCandidateUsageV1 {
  readonly candidateUnitsUsed: number;
  readonly providerCandidatesReturned: number;
}

export interface RetrievalCandidateBudgetV1 {
  readonly lanes: RetrievalLaneRegistry;
  readonly candidateLimitOmissions: readonly LocatorCandidate[];
  readonly usage: RetrievalCandidateUsageV1;
  isExhausted(): boolean;
}

/** Apply the aggregate candidate cap as each lane returns, passing SEM only the remaining bound. */
export function createRetrievalCandidateBudgetV1(
  source: RetrievalLaneRegistry,
  budgets: RetrievalRequestBudgets | undefined,
): RetrievalCandidateBudgetV1 {
  let candidateUnitsUsed = 0;
  let providerCandidatesReturned = 0;
  const candidateLimitOmissions: LocatorCandidate[] = [];
  const candidateLimit = budgets?.candidate_limit ?? Number.MAX_SAFE_INTEGER;
  const lanes: RetrievalLaneRegistry = {
    executorFor(lane: RetrievalLane) {
      const executor = source.executorFor(lane);
      if (executor === null) return null;
      return {
        async execute(executedLane, request) {
          const remaining = Math.max(0, candidateLimit - candidateUnitsUsed);
          if (remaining === 0) return [];
          const effectiveRequest: RetrievalRequest = budgets === undefined
            ? request
            : { ...request, budgets: { ...budgets, candidate_limit: remaining } };
          const returned = await executor.execute(executedLane, effectiveRequest);
          if (executedLane === "SEM") providerCandidatesReturned += returned.length;
          const admitted = returned.slice(0, remaining);
          candidateLimitOmissions.push(...returned.slice(remaining));
          candidateUnitsUsed += admitted.length;
          return admitted;
        },
      };
    },
  };
  return {
    lanes,
    candidateLimitOmissions,
    usage: {
      get candidateUnitsUsed() { return candidateUnitsUsed; },
      get providerCandidatesReturned() { return providerCandidatesReturned; },
    },
    isExhausted: () => budgets !== undefined && candidateUnitsUsed >= candidateLimit,
  };
}
