import type { ResolvedEvidence, RetrievalTrace, VersionedRef } from "@eliotr/contracts";
import type { RetrievalRequest } from "./ports.js";

export interface EvidencePack {
  readonly pack_ref: VersionedRef;
  readonly scope_snapshot_ref: VersionedRef;
  readonly resolved_evidence: readonly ResolvedEvidence[];
  readonly omitted_candidates: readonly { candidate_id: string; reason_code: string }[];
  readonly trace_ref: VersionedRef;
  readonly total_utf8_bytes: number;
}

export interface RetrievalResult {
  readonly evidence_pack: EvidencePack;
  readonly trace: RetrievalTrace;
  readonly coverage_claim: "NONE" | "SAMPLED" | "COMPLETE_SCOPE";
}

export interface RetrievalService {
  retrieve(request: RetrievalRequest): Promise<RetrievalResult>;
  verify(handleRef: VersionedRef, expectedScopeRef: VersionedRef): Promise<ResolvedEvidence>;
}

// IMPLEMENTED_NOT_LIVE: ER-04 Q3 retrieval query orchestration over injected ports with frozen-scope binding, direct-before-semantic lanes, fused diversity, exact resolution and persisted trace; D1 result/trace persistence executes via query-persistence.ts over migration 0021; Worker wiring and scope-profile versioning remain separate.
import {
  RetrievalLaneSchema,
  RetrievalTraceSchema,
  type LocatorCandidate,
  type RetrievalLane,
  type ScopeSnapshot,
} from "@eliotr/contracts";
import { candidatesByLane, type LaneExecutionReceipt, type RetrievalLaneRegistry } from "./lanes.js";
import { compileQueryPlan, directLanesPrecedeSemantic } from "./planner.js";
import { reciprocalRankFuse, type FusionOptions } from "./fusion.js";

export type RetrievalQueryErrorCode =
  | "RETRIEVAL_INPUT_INVALID"
  | "RETRIEVAL_SCOPE_STALE"
  | "RETRIEVAL_AUTHORITY_STALE"
  | "RETRIEVAL_IDEMPOTENCY_CONFLICT"
  | "RETRIEVAL_BUDGET_STOP"
  | "RETRIEVAL_CANCELLED"
  | "RETRIEVAL_TRACE_CORRUPT"
  | "RETRIEVAL_RESOLUTION_UNCERTAIN";

export class RetrievalQueryError extends Error {
  public readonly code: RetrievalQueryErrorCode;
  public readonly retryable: boolean;

  public constructor(code: RetrievalQueryErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "RetrievalQueryError";
    this.code = code;
    this.retryable = retryable;
  }
}

function failQuery(code: RetrievalQueryErrorCode, message: string, retryable = false): never {
  throw new RetrievalQueryError(code, message, retryable);
}

export interface RetrievalQueryInput {
  readonly request: RetrievalRequest;
  readonly idempotency_key: string;
}

export interface StoredRetrievalResult {
  readonly request_digest: string;
  readonly idempotency_key: string;
  readonly result: RetrievalResult;
}

export interface RetrievalResultStore {
  load(idempotencyKey: string): Promise<StoredRetrievalResult | null>;
  store(record: StoredRetrievalResult): Promise<void>;
}

/**
 * Q3 orchestration ports. All authority lives behind these ports; the
 * service performs no D1/R2/network/clock access itself and mints no source
 * grants (there is deliberately no grant port: a query never grants
 * coverage). Scope/authority ports throw RetrievalQueryError with
 * SCOPE_STALE or AUTHORITY_STALE when deny/purge/expiry invalidates the
 * frozen scope; checkBudget throws BUDGET_STOP or CANCELLED.
 */
export interface RetrievalQueryPorts {
  freezeScope(request: RetrievalRequest): Promise<ScopeSnapshot>;
  requireCurrentScope(snapshot: ScopeSnapshot): Promise<void>;
  lanes: RetrievalLaneRegistry;
  fusion: FusionOptions;
  resolveEvidence(
    candidate: LocatorCandidate,
    scope: ScopeSnapshot,
  ): Promise<ResolvedEvidence | null>;
  persistTrace(trace: RetrievalTrace): Promise<VersionedRef>;
  results: RetrievalResultStore;
  checkBudget(): void;
}

export interface RetrievalQueryService {
  query(input: RetrievalQueryInput): Promise<RetrievalResult>;
}

const SHA256_HEX_48 = 48;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) failQuery("RETRIEVAL_INPUT_INVALID", "query digest input is not canonical");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter((entry) => entry[1] !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  failQuery("RETRIEVAL_INPUT_INVALID", "query digest input is not canonical");
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function checkIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u0020\u007f]/u.test(value)) {
    failQuery("RETRIEVAL_INPUT_INVALID", "idempotency-key is required");
  }
  return value;
}

export function createRetrievalQueryService(ports: RetrievalQueryPorts): RetrievalQueryService {
  return {
    async query(input: RetrievalQueryInput): Promise<RetrievalResult> {
      const idempotencyKey = checkIdempotencyKey(input.idempotency_key);
      const request = input.request;
      // Freeze an explicitly authorized scope before any lane reads.
      const scope = await ports.freezeScope(request);
      await ports.requireCurrentScope(scope);
      const digest = await sha256Hex(canonicalJson({
        raw_query: request.raw_query,
        product: request.product,
        literals: [...request.literals],
        requested_limit: request.requested_limit,
        scope_digest: scope.digest,
      }));
      const prior = await ports.results.load(idempotencyKey).catch(() => {
        failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored query result is unavailable", true);
      });
      if (prior !== null) {
        if (prior.request_digest !== digest) {
          failQuery("RETRIEVAL_IDEMPOTENCY_CONFLICT", "idempotency identity is bound to different inputs");
        }
        return prior.result;
      }
      const plan = compileQueryPlan(request);
      if (!directLanesPrecedeSemantic(plan)) {
        failQuery("RETRIEVAL_INPUT_INVALID", "semantic lane must not precede direct/exact/lexical lanes");
      }
      // Ordered lane execution with a budget/currentness recheck before every
      // lane: deny, purge or expiry aborts the query instead of serving stale
      // locators. Mirrors the SKIPPED_UNAVAILABLE/FAILED mapping of
      // executePlannedLanes without its all-at-once batching.
      const receipts: LaneExecutionReceipt[] = [];
      for (const lane of plan.lanes) {
        ports.checkBudget();
        await ports.requireCurrentScope(scope);
        const executor = ports.lanes.executorFor(lane);
        if (executor === null) {
          receipts.push({ lane, candidates: [], disposition: "SKIPPED_UNAVAILABLE" });
          continue;
        }
        try {
          const candidates = await executor.execute(lane, request);
          receipts.push({ lane, candidates, disposition: "EXECUTED" });
        } catch (error: unknown) {
          if (error instanceof RetrievalQueryError) throw error;
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
      ports.checkBudget();
      await ports.requireCurrentScope(scope);
      const fused = reciprocalRankFuse(candidatesByLane(receipts), ports.fusion);
      const laneCandidateIds = new Set<string>();
      for (const receipt of receipts) {
        for (const candidate of receipt.candidates) laneCandidateIds.add(candidate.candidate_id);
      }
      const fusedIds = new Set(fused.map((entry) => entry.candidate.candidate_id));
      const omitted: { candidate_id: string; reason_code: string }[] = [];
      for (const receipt of receipts) {
        for (const candidate of receipt.candidates) {
          if (!fusedIds.has(candidate.candidate_id)) {
            omitted.push({ candidate_id: candidate.candidate_id, reason_code: "FUSION_CAP_DROPPED" });
          }
        }
      }
      const limit = Number.isSafeInteger(request.requested_limit) && request.requested_limit > 0
        ? request.requested_limit
        : 1;
      const kept = fused.slice(0, limit);
      for (const entry of fused.slice(limit)) {
        omitted.push({ candidate_id: entry.candidate.candidate_id, reason_code: "RESULT_LIMIT" });
      }
      const resolved: ResolvedEvidence[] = [];
      for (const entry of kept) {
        ports.checkBudget();
        await ports.requireCurrentScope(scope);
        const evidence = await ports.resolveEvidence(entry.candidate, scope);
        if (evidence === null) {
          omitted.push({ candidate_id: entry.candidate.candidate_id, reason_code: "EVIDENCE_UNRESOLVED" });
          continue;
        }
        resolved.push(evidence);
      }
      // Coverage is never stronger than observed: without an exhaustive
      // denominator port this service reports SAMPLED for any resolved
      // evidence and NONE otherwise. A no-hit across every lane stays a
      // visible empty result, never an absence or completeness claim.
      const coverageClaim: RetrievalResult["coverage_claim"] = resolved.length === 0 ? "NONE" : "SAMPLED";
      const totalUtf8Bytes = resolved.reduce(
        (sum, item) => sum + new TextEncoder().encode(item.exact_excerpt).byteLength,
        0,
      );
      const traceRef: VersionedRef = { id: `query-${digest.slice(0, SHA256_HEX_48)}`, revision: 1 };
      const packRef: VersionedRef = { id: `pack-${digest.slice(0, SHA256_HEX_48)}`, revision: 1 };
      const scopeRef: VersionedRef = { id: scope.snapshot_id, revision: scope.revision };
      const lanesUsed = receipts.filter((receipt) => receipt.disposition === "EXECUTED").map((receipt) => receipt.lane);
      const lanesSkipped = receipts
        .filter((receipt) => receipt.disposition !== "EXECUTED")
        .map((receipt) => ({
          lane: receipt.lane,
          reason: receipt.disposition === "SKIPPED_UNAVAILABLE"
            ? "LANE_UNAVAILABLE"
            : (receipt.failure_code ?? "LANE_EXECUTION_FAILED").slice(0, 256),
        }));
      const candidatesByLaneCount: Record<RetrievalLane, number> = Object.fromEntries(
        RetrievalLaneSchema.options.map((lane) => [lane, 0]),
      ) as Record<RetrievalLane, number>;
      for (const receipt of receipts) candidatesByLaneCount[receipt.lane] = receipt.candidates.length;
      const indexGenerations = [...new Set(
        receipts.flatMap((receipt) => receipt.candidates.map((candidate) => candidate.index_generation)),
      )];
      const representedSources: string[] = [];
      for (const item of resolved) {
        if (!representedSources.includes(item.handle.source_revision_ref)) {
          representedSources.push(item.handle.source_revision_ref);
        }
      }
      const resolvedIds = new Set(resolved.map((item) => item.handle.source_revision_ref));
      const omittedSources = [...new Set(
        kept.filter((entry) => !resolvedIds.has(entry.candidate.source_revision_ref))
          .map((entry) => entry.candidate.source_revision_ref),
      )].map((sourceRef) => ({ source_ref: sourceRef, reason: "EVIDENCE_UNRESOLVED" }));
      const degraded: string[] = [];
      if (lanesUsed.length > 0 && fused.length === 0) degraded.push("NO_HIT");
      if (plan.rerank && fused.length > 1) degraded.push("RERANK_DEFERRED");
      const trace: RetrievalTrace = RetrievalTraceSchema.parse({
        trace_ref: traceRef,
        raw_query: plan.raw_query,
        scope_snapshot: scope,
        query_product: plan.product,
        lanes_used: lanesUsed,
        lanes_skipped: lanesSkipped,
        exact_probes: [...plan.preserved_literals],
        index_generations: indexGenerations,
        context_expansion: plan.context_expansion,
        candidates_by_lane: candidatesByLaneCount,
        expansion_refs: [],
        represented_source_refs: representedSources,
        omitted_sources: omittedSources,
        stale_or_degraded_channels: degraded,
        budget_receipt_ref: `budget-${digest.slice(0, 32)}`,
        evidence_pack_ref: packRef.id,
      });
      const pack: EvidencePack = {
        pack_ref: packRef,
        scope_snapshot_ref: scopeRef,
        resolved_evidence: resolved,
        omitted_candidates: omitted,
        trace_ref: traceRef,
        total_utf8_bytes: totalUtf8Bytes,
      };
      ports.checkBudget();
      await ports.requireCurrentScope(scope);
      let persistedRef: VersionedRef;
      try {
        persistedRef = await ports.persistTrace(trace);
      } catch {
        failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "trace persistence is unavailable", true);
      }
      if (persistedRef.id !== traceRef.id || persistedRef.revision !== traceRef.revision) {
        failQuery("RETRIEVAL_TRACE_CORRUPT", "persisted trace binding does not match the frozen query");
      }
      const result: RetrievalResult = { evidence_pack: pack, trace, coverage_claim: coverageClaim };
      try {
        await ports.results.store({ request_digest: digest, idempotency_key: idempotencyKey, result });
      } catch {
        failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "query result settlement is uncertain", true);
      }
      return result;
    },
  };
}
