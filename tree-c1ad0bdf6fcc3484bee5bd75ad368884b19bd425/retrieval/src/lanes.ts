import type { LocatorCandidate, RetrievalLane } from "@eliotr/contracts";
import type { QueryPlan } from "./planner.js";
import type {
  DirectLookupPort,
  LexicalSearchPort,
  RetrievalLaneExecutor,
  RetrievalRequest,
} from "./ports.js";

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
      const code = (error as { readonly code?: unknown }).code;
      if (code === "SEARCH_UNAVAILABLE") {
        receipts.push({ lane, candidates: [], disposition: "SKIPPED_UNAVAILABLE" });
        continue;
      }
      receipts.push({
        lane,
        candidates: [],
        disposition: "FAILED",
        failure_code:
          typeof code === "string" && code.length > 0
            ? code
            : error instanceof Error
              ? error.name || "LANE_EXECUTION_FAILED"
              : "LANE_EXECUTION_FAILED",
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

/**
 * Q1 governed IDENT executor. Delegates bounded identifier probes to the
 * D1 Search read port, which pins each in-scope revision to its exact READY
 * watermark/generation and rechecks LIVE purge + owner generation. Candidates
 * remain unresolved locators: preview is empty and only pinned references are
 * exposed. SEARCH_UNAVAILABLE is mapped by executePlannedLanes to
 * SKIPPED_UNAVAILABLE; SEARCH_INCOMPLETE stays a typed FAILED.
 */
export function createIdentLaneExecutor(direct: DirectLookupPort): RetrievalLaneExecutor {
  return {
    async execute(
      lane: RetrievalLane,
      request: RetrievalRequest,
    ): Promise<readonly LocatorCandidate[]> {
      if (lane !== "IDENT") {
        const error = new Error(`IDENT executor cannot serve lane ${lane}`);
        error.name = "SEARCH_INPUT_INVALID";
        (error as unknown as { code: string }).code = "SEARCH_INPUT_INVALID";
        throw error;
      }
      return direct.lookupIdentifiers(request);
    },
  };
}

/** Q1 governed LEX executor over pinned D1 Search FTS reads. See IDENT notes. */
export function createLexLaneExecutor(lexical: LexicalSearchPort): RetrievalLaneExecutor {
  return {
    async execute(
      lane: RetrievalLane,
      request: RetrievalRequest,
    ): Promise<readonly LocatorCandidate[]> {
      if (lane !== "LEX") {
        const error = new Error(`LEX executor cannot serve lane ${lane}`);
        error.name = "SEARCH_INPUT_INVALID";
        (error as unknown as { code: string }).code = "SEARCH_INPUT_INVALID";
        throw error;
      }
      return lexical.search(request, "LEX");
    },
  };
}
