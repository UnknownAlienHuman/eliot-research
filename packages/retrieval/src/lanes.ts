import type { LocatorCandidate, RetrievalLane } from "@eliotr/contracts";
import type { QueryPlan } from "./planner.js";
import { compileQueryPlan } from "./planner.js";
import type {
  DirectLookupPort,
  ExactSearchPort,
  LexicalSearchPort,
  ManagedSearchPort,
  ManagedSearchExecution,
  RetrievalLaneExecutor,
  RetrievalLaneExecutionContextV1,
  RetrievalRequest,
  RetrievalLaneExecutionResult,
} from "./ports.js";

export interface RetrievalLaneRegistry {
  executorFor(lane: RetrievalLane): RetrievalLaneExecutor | null;
}

export interface LaneExecutionReceipt {
  readonly lane: RetrievalLane;
  readonly candidates: readonly LocatorCandidate[];
  readonly managed_execution?: ManagedSearchExecution;
  readonly disposition: "EXECUTED" | "SKIPPED_UNAVAILABLE" | "SKIPPED_POLICY" | "FAILED";
  readonly failure_code?: string;
  readonly failure_detail_code?: string;
}

export interface PlannedLaneExecutionOptions {
  readonly beforeLane?: (
    lane: RetrievalLane,
    completed: readonly LaneExecutionReceipt[],
  ) => void | Promise<void>;
  readonly skipLane?: (
    lane: RetrievalLane,
    completed: readonly LaneExecutionReceipt[],
  ) => string | undefined;
  readonly propagateError?: (error: unknown, lane: RetrievalLane) => boolean;
  readonly executionContext?: RetrievalLaneExecutionContextV1;
}

function errorCode(error: unknown): unknown {
  if ((typeof error !== "object" || error === null) && typeof error !== "function") return undefined;
  return (error as { readonly code?: unknown }).code;
}

function errorDetailCode(error: unknown): string | undefined {
  if ((typeof error !== "object" || error === null) && typeof error !== "function") return undefined;
  const detail = (error as { readonly failure_detail_code?: unknown }).failure_detail_code;
  return typeof detail === "string" ? detail : undefined;
}

function isManagedSearchExecution(value: RetrievalLaneExecutionResult): value is ManagedSearchExecution {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("execution_state" in value)) {
    return false;
  }
  return value.execution_state === "EXECUTED" || value.execution_state === "NOT_EXECUTED";
}

function unavailableSearchError(message: string, detailCode: string): Error {
  const error = new Error(message);
  error.name = "SEARCH_UNAVAILABLE";
  Object.assign(error, { code: "SEARCH_UNAVAILABLE", failure_detail_code: detailCode });
  return error;
}

export async function executePlannedLanes(
  plan: QueryPlan,
  request: RetrievalRequest,
  registry: RetrievalLaneRegistry,
  options: PlannedLaneExecutionOptions = {},
): Promise<readonly LaneExecutionReceipt[]> {
  const receipts: LaneExecutionReceipt[] = [];
  for (const lane of plan.lanes) {
    await options.beforeLane?.(lane, receipts);
    const skipReason = options.skipLane?.(lane, receipts);
    if (skipReason !== undefined) {
      receipts.push({
        lane,
        candidates: [],
        disposition: "SKIPPED_POLICY",
        failure_code: skipReason,
      });
      continue;
    }
    const executor = registry.executorFor(lane);
    if (executor === null) {
      receipts.push({
        lane,
        candidates: [],
        disposition: "SKIPPED_UNAVAILABLE",
        failure_code: "LANE_UNAVAILABLE",
      });
      continue;
    }
    try {
      const result = await executor.execute(lane, request, options.executionContext);
      if (isManagedSearchExecution(result)) {
        if (result.execution_state === "NOT_EXECUTED") {
          receipts.push({
            lane,
            candidates: [],
            managed_execution: result,
            disposition: "SKIPPED_POLICY",
            failure_code: "MANAGED_NOT_EXECUTED",
          });
          continue;
        }
        if (result.outcome === null) {
          const error = new Error("executed managed search omitted its outcome");
          Object.assign(error, { code: "RETRIEVAL_TRACE_CORRUPT", retryable: false });
          throw error;
        }
        receipts.push({ lane, candidates: result.candidates, managed_execution: result, disposition: "EXECUTED" });
        continue;
      }
      receipts.push({ lane, candidates: result, disposition: "EXECUTED" });
    } catch (error: unknown) {
      if (options.propagateError?.(error, lane) === true) throw error;
      const code = errorCode(error);
      if (code === "SEARCH_UNAVAILABLE") {
        const detailCode = errorDetailCode(error);
        receipts.push({
          lane,
          candidates: [],
          disposition: "SKIPPED_UNAVAILABLE",
          failure_code: "SEARCH_UNAVAILABLE",
          ...(detailCode === undefined ? {} : { failure_detail_code: detailCode }),
        });
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

/** Q1 governed EXACT executor over the exact-phrase search surface. */
export function createExactLaneExecutor(
  exact: Pick<ExactSearchPort, "exactPhraseCandidates">,
): RetrievalLaneExecutor {
  return {
    async execute(
      lane: RetrievalLane,
      request: RetrievalRequest,
    ): Promise<readonly LocatorCandidate[]> {
      if (lane !== "EXACT") {
        const error = new Error(`EXACT executor cannot serve lane ${lane}`);
        error.name = "SEARCH_INPUT_INVALID";
        (error as unknown as { code: string }).code = "SEARCH_INPUT_INVALID";
        throw error;
      }
      return exact.exactPhraseCandidates(request);
    },
  };
}

function semanticExpansion(request: RetrievalRequest): 0 | 1 | 2 | 3 {
  try {
    return compileQueryPlan(request).context_expansion;
  } catch (error: unknown) {
    const invalid = new Error(
      error instanceof Error ? error.message : "unsupported query product for SEM lane",
    );
    invalid.name = "SEARCH_INPUT_INVALID";
    (invalid as unknown as { code: string }).code = "SEARCH_INPUT_INVALID";
    throw invalid;
  }
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
  const preflightManagedCall = async (
    request: RetrievalRequest,
    context?: RetrievalLaneExecutionContextV1,
  ): Promise<void> => {
    if (managed.preflightSearchManaged === undefined) return;
    await managed.preflightSearchManaged(
      request,
      ["SEM"],
      semanticExpansion(request),
      context?.provider_candidate_limit === undefined
        ? undefined
        : { provider_candidate_limit: context.provider_candidate_limit },
    );
  };
  return {
    managed_outcome_capable: managed.searchManaged !== undefined,
    preflightManagedCall,
    async execute(
      lane: RetrievalLane,
      request: RetrievalRequest,
      context?: RetrievalLaneExecutionContextV1,
    ): Promise<RetrievalLaneExecutionResult> {
      if (lane !== "SEM") {
        const error = new Error(`SEM executor cannot serve lane ${lane}`);
        error.name = "SEARCH_INPUT_INVALID";
        (error as unknown as { code: string }).code = "SEARCH_INPUT_INVALID";
        throw error;
      }
      const expansion = semanticExpansion(request);
      if (context?.beforeManagedCall !== undefined || context?.admission !== undefined) {
        if (managed.searchManaged === undefined) {
          const error = new Error("durable managed execution requires the single-call outcome adapter");
          Object.assign(error, { code: "RETRIEVAL_AUTHORITY_STALE", retryable: false });
          throw error;
        }
        const noProviderDispatch = context.provider_candidate_limit === 0 ||
          request.scope_snapshot.member_source_revision_refs.length === 0;
        if (noProviderDispatch) {
          return {
            execution_state: "NOT_EXECUTED",
            submitted_query: "",
            candidates: [],
            outcome: null,
          };
        }
        if (context.preflightManagedCall !== undefined) {
          await context.preflightManagedCall();
        } else {
          await preflightManagedCall(request, context);
        }
        const admission = context.admission ?? await context.beforeManagedCall?.();
        if (admission === undefined) {
          const error = new Error("managed provider dispatch has no durable admission receipt");
          Object.assign(error, { code: "RETRIEVAL_AUTHORITY_STALE", retryable: false });
          throw error;
        }
        // Typed provider/domain errors propagate unchanged; no secondary LEX dispatch is added.
        const managedContext = context.provider_candidate_limit === undefined
          ? undefined
          : { provider_candidate_limit: context.provider_candidate_limit };
        const pending = managed.searchManaged(request, ["SEM"], expansion, admission, managedContext);
        const result = await (context.waitForManagedCall === undefined
          ? pending
          : context.waitForManagedCall(pending));
        const candidates = result.candidates.map((candidate) => {
          const { proof_state: _localMarker, ...locator } = candidate as LocatorCandidate & {
            readonly proof_state?: unknown;
          };
          void _localMarker;
          return locator;
        });
        return { ...result, candidates };
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
        const code = errorCode(error);
        if (code === "AI_SEARCH_MANAGED_NOT_PROMOTED" || code === "AI_SEARCH_MANAGED_CAPABILITY_UNAVAILABLE") {
          throw unavailableSearchError("managed semantic generation is not available", String(code));
        }
        if (code === "AI_SEARCH_MANAGED_PROVIDER_CALL_FAILED") {
          throw unavailableSearchError("managed semantic provider call is unavailable", String(code));
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
