import type { LocatorCandidate, RetrievalLane } from "@eliotr/contracts";
import type { QueryPlan } from "./planner.js";
import { compileQueryPlan } from "./planner.js";
import type {
  DirectLookupPort,
  LexicalSearchPort,
  ManagedSearchPort,
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

// IMPLEMENTED_NOT_LIVE: ER-04 SEM lane executor over the managed-search surface with pinned-generation translation and honest degradation; live AI Search readback/promotion receipts remain separate.
/**
 * Q1 governed SEM executor over the managed-search surface.
 *
 * Generation pinning is inherited from the managed port, never reimplemented
 * here: the registry-backed port reads the D1 AI Search generation registry
 * before provider access, decodes every chunk against the promoted
 * `index_generation` plus the frozen ScopeSnapshot membership, and re-reads
 * the registry after retrieval, discarding the provider output with
 * `AI_SEARCH_MANAGED_REGISTRY_CHANGED` when the active head rotated
 * mid-read. This executor only translates that discipline into the lane
 * contract `executePlannedLanes` and the Q3 service already understand:
 * `AI_SEARCH_MANAGED_NOT_PROMOTED` becomes `SEARCH_UNAVAILABLE` (honest
 * `SKIPPED_UNAVAILABLE`, never a fabricated lane), while a mid-read rotation
 * becomes `SEARCH_INCOMPLETE` (visible `FAILED`, never served stale).
 * Context expansion follows the compiled query plan so SEM uses the same
 * per-product expansion as the planner that ordered it after direct lanes.
 *
 * Envelope translation (disclosed): the managed port decodes provider rows
 * into unresolved locators carrying a local `proof_state` marker
 * (`locator/strict-decoder.ts`). Nothing downstream reads that marker, and
 * the exact evidence authority strict-parses `LocatorCandidate`, so a marker
 * left in place fails resolution with `EVIDENCE_INPUT_INVALID` for every
 * managed candidate. The executor therefore drops the local-only marker at
 * this layer boundary and returns plain `LocatorCandidate`s, exactly the
 * `ManagedSearchPort` contract type. Strict validation is not weakened:
 * provider bytes were already strictly decoded inside the managed port, and
 * the evidence authority re-validates every field that remains.
 */
export function createSemLaneExecutor(managed: ManagedSearchPort): RetrievalLaneExecutor {
  return {
    async execute(
      lane: RetrievalLane,
      request: RetrievalRequest,
    ): Promise<readonly LocatorCandidate[]> {
      if (lane !== "SEM") {
        const error = new Error(`SEM executor cannot serve lane ${lane}`);
        error.name = "SEARCH_INPUT_INVALID";
        (error as unknown as { code: string }).code = "SEARCH_INPUT_INVALID";
        throw error;
      }
      let expansion: 0 | 1 | 2 | 3;
      try {
        expansion = compileQueryPlan(request).context_expansion;
      } catch (error: unknown) {
        const invalid = new Error(
          error instanceof Error ? error.message : "unsupported query product for SEM lane",
        );
        invalid.name = "SEARCH_INPUT_INVALID";
        (invalid as unknown as { code: string }).code = "SEARCH_INPUT_INVALID";
        throw invalid;
      }
      try {
        const results = await managed.search(request, ["SEM"], expansion);
        return results.map((candidate) => {
          const { proof_state: _localMarker, ...locator } = candidate as LocatorCandidate & {
            readonly proof_state?: unknown;
          };
          void _localMarker;
          return locator;
        });
      } catch (error: unknown) {
        const code = (error as { readonly code?: unknown }).code;
        if (code === "AI_SEARCH_MANAGED_NOT_PROMOTED") {
          const unavailable = new Error("managed semantic generation is not promoted");
          unavailable.name = "SEARCH_UNAVAILABLE";
          (unavailable as unknown as { code: string }).code = "SEARCH_UNAVAILABLE";
          throw unavailable;
        }
        if (code === "AI_SEARCH_MANAGED_REGISTRY_CHANGED") {
          const drifted = new Error("managed semantic generation drifted during readback");
          drifted.name = "SEARCH_INCOMPLETE";
          (drifted as unknown as { code: string }).code = "SEARCH_INCOMPLETE";
          throw drifted;
        }
        throw error;
      }
    },
  };
}
