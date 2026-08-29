import type { LocatorCandidate, RetrievalLane } from "@eliotr/contracts";
import type { QueryPlan } from "./planner.js";
import type { RetrievalLaneExecutor, RetrievalRequest } from "./ports.js";

export interface RetrievalLaneRegistry {
  executorFor(lane: RetrievalLane): RetrievalLaneExecutor | null;
}

export interface LaneExecutionReceipt {
  readonly lane: RetrievalLane;
  readonly candidates: readonly LocatorCandidate[];
  readonly disposition: "EXECUTED" | "SKIPPED_UNAVAILABLE" | "FAILED";
  readonly failure_code?: string;
}

export async function executePlannedLanes(
  plan: QueryPlan,
  request: RetrievalRequest,
  registry: RetrievalLaneRegistry,
): Promise<readonly LaneExecutionReceipt[]> {
  const receipts: LaneExecutionReceipt[] = [];
  for (const lane of plan.lanes) {
    const executor = registry.executorFor(lane);
    if (executor === null) {
      receipts.push({ lane, candidates: [], disposition: "SKIPPED_UNAVAILABLE" });
      continue;
    }
    try {
      const candidates = await executor.execute(lane, request);
      receipts.push({ lane, candidates, disposition: "EXECUTED" });
    } catch (error: unknown) {
      receipts.push({
        lane,
        candidates: [],
        disposition: "FAILED",
        failure_code: error instanceof Error ? error.name || "LANE_EXECUTION_FAILED" : "LANE_EXECUTION_FAILED",
      });
    }
  }
  return receipts;
}

export function candidatesByLane(
  receipts: readonly LaneExecutionReceipt[],
): ReadonlyMap<RetrievalLane, readonly LocatorCandidate[]> {
  return new Map(
    receipts
      .filter((receipt) => receipt.disposition === "EXECUTED")
      .map((receipt) => [receipt.lane, receipt.candidates] as const),
  );
}
