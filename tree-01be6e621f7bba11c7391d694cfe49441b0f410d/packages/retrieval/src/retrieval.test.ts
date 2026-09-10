import { describe, expect, it } from "vitest";
import type {
  LocatorCandidate,
  ResolvedEvidence,
  RetrievalLane,
  ScopeSnapshot,
} from "@eliotr/contracts";
import type { RetrievalRequest, RetrievalQueryPorts } from "./index.js";
import {
  compileQueryPlan,
  createRetrievalQueryService,
  directLanesPrecedeSemantic,
  reciprocalRankFuse,
  RetrievalQueryError,
} from "./index.js";

describe("retrieval planning", () => {
  it("does not rerank exhaustive operations", () => {
    const plan = compileQueryPlan({
      raw_query: "needle", product: "EXHAUSTIVE_JOB", literals: ["needle"], requested_limit: 50,
      deadline_ms: 1000,
      scope_snapshot: {} as never,
      policy: {} as never,
    });
    expect(plan.rerank).toBe(false);
    expect(plan.complete_scope_required).toBe(true);
  });

  it("deduplicates candidates by canonical section", () => {
    const base = {
      candidate_id: "c", source_revision_ref: "r", canonical_section_id: "s", preview: "p",
      raw_score: 1, rank: 1, index_generation: "g", metadata: {},
    } as const;
    const result = reciprocalRankFuse(new Map([
      ["LEX", [{ ...base, lane: "LEX" }]],
      ["SEM", [{ ...base, candidate_id: "c2", lane: "SEM" }]],
    ]), { reciprocal_rank_constant: 60, lane_weights: {}, maxPerSourceRevision: 5 });
    expect(result).toHaveLength(1);
  });
});

const FIXED_AT = "2026-09-08T00:00:00.000Z";

function q3Scope(overrides: Partial<ScopeSnapshot> = {}): ScopeSnapshot {
  return {
    snapshot_id: "snap-1",
    revision: 1,
    resolved_scope_expression: { kind: "PROJECT", project_id: "p1" },
    participant_generations: {},
    member_source_revision_refs: ["rev-1"],
    source_owner_generations: { "rev-1": "gen-1" },
    policy_authority_ref: "policy-1",
    disclosure_closure_digest: "a".repeat(64),
    purge_ledger_revision: 0,
    digest: "b".repeat(64),
    created_at: FIXED_AT,
    expires_at: "2026-09-09T00:00:00.000Z",
    ...overrides,
  };
}

function q3Candidate(overrides: Partial<LocatorCandidate> = {}): LocatorCandidate {
  return {
    candidate_id: "c-1",
    lane: "LEX",
    source_revision_ref: "rev-1",
    canonical_section_id: "sec-1",
    preview: "",
    raw_score: 1,
    rank: 1,
    index_generation: "search-gen-1",
    metadata: {},
    ...overrides,
  };
}

function q3Resolved(candidate: LocatorCandidate, scope: ScopeSnapshot): ResolvedEvidence {
  return {
    handle: {
      handle_ref: { id: `handle-${candidate.candidate_id}`, revision: 1 },
      source_namespace_id: "ns-1",
      source_owner_generation: "gen-1",
      source_revision_ref: candidate.source_revision_ref,
      scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
      anchor: { kind: "normalized_byte_range", start: 0, end: 5 },
      excerpt_sha256: "c".repeat(64),
      excerpt_byte_length: 5,
      object_residency_key_digest: "d".repeat(64),
      source_assurance_ceiling: "EXACT",
      materializer_assurance_ceiling: "EXACT",
      terminal_state: "LIVE",
      created_at: FIXED_AT,
    },
    exact_excerpt: "hello",
    verification_receipt_ref: "vr-1",
    authorization_receipt_ref: "ar-1",
    credential_generation: "cred-1",
    source_revision_content_sha256: "e".repeat(64),
    scope_snapshot_digest: scope.digest,
    instruction_taint: "DATA_ONLY",
    allowed_effects: "READ_ONLY",
    resolved_at: FIXED_AT,
  };
}

function q3Request(overrides: Partial<RetrievalRequest> = {}): RetrievalRequest {
  return {
    raw_query: "needle",
    product: "RESEARCH",
    scope_snapshot: q3Scope({ digest: "0".repeat(64) }),
    policy: {} as never,
    literals: ["needle"],
    requested_limit: 10,
    deadline_ms: 1000,
    ...overrides,
  };
}

interface Q3Harness {
  readonly calls: string[];
  readonly ports: RetrievalQueryPorts;
  readonly store: Map<string, { request_digest: string; idempotency_key: string; result: never }>;
}

function q3Harness(options: {
  scope?: ScopeSnapshot;
  candidates?: Partial<Record<RetrievalLane, LocatorCandidate[]>>;
  unavailableLanes?: readonly RetrievalLane[];
  failingLanes?: Partial<Record<RetrievalLane, string>>;
  resolve?: (candidate: LocatorCandidate, scope: ScopeSnapshot) => Promise<ResolvedEvidence | null>;
  currentness?: (call: number) => void;
  budget?: (call: number) => void;
  persist?: (trace: never) => Promise<{ id: string; revision: number }>;
  fusion?: Partial<RetrievalQueryPorts["fusion"]>;
} = {}): Q3Harness {
  const calls: string[] = [];
  const store = new Map<string, { request_digest: string; idempotency_key: string; result: never }>();
  let currentCalls = 0;
  let budgetCalls = 0;
  const ports: RetrievalQueryPorts = {
    async freezeScope() {
      calls.push("freeze");
      return options.scope ?? q3Scope();
    },
    async requireCurrentScope() {
      currentCalls += 1;
      calls.push("current");
      options.currentness?.(currentCalls);
    },
    lanes: {
      executorFor: (lane: RetrievalLane) => {
        if (options.unavailableLanes?.includes(lane)) return null;
        const failure = options.failingLanes?.[lane];
        if (failure !== undefined) {
          return {
            async execute() {
              calls.push(`lane:${lane}`);
              const error = new Error(failure);
              error.name = failure;
              (error as unknown as { code: string }).code = failure;
              throw error;
            },
          };
        }
        const preset = options.candidates?.[lane];
        if (preset === undefined) return null;
        return {
          async execute() {
            calls.push(`lane:${lane}`);
            return preset;
          },
        };
      },
    },
    fusion: {
      reciprocal_rank_constant: 60,
      lane_weights: {},
      maxPerSourceRevision: 5,
      ...options.fusion,
    },
    async resolveEvidence(candidate: LocatorCandidate, scope: ScopeSnapshot) {
      calls.push(`resolve:${candidate.candidate_id}`);
      if (options.resolve !== undefined) return options.resolve(candidate, scope) as Promise<ResolvedEvidence | null>;
      return q3Resolved(candidate, scope);
    },
    async persistTrace(trace) {
      calls.push("persist");
      const overridden = options.persist?.(trace as never);
      if (overridden !== undefined) return overridden;
      return trace.trace_ref;
    },
    results: {
      async load(key: string) {
        return (store.get(key) as { request_digest: string; idempotency_key: string; result: never } | undefined) ?? null;
      },
      async store(record) {
        store.set(record.idempotency_key, record as { request_digest: string; idempotency_key: string; result: never });
      },
    },
    checkBudget() {
      budgetCalls += 1;
      calls.push("budget");
      options.budget?.(budgetCalls);
    },
  };
  return { calls, ports, store };
}

async function q3Error(promise: Promise<unknown>): Promise<RetrievalQueryError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RetrievalQueryError) return error;
    throw new Error(`expected RetrievalQueryError, got ${String(error)}`, { cause: error });
  }
  throw new Error("expected query to fail");
}

describe("Q3 query orchestration", () => {
  it("keeps direct lanes before semantic for every query product", () => {
    for (const product of ["FAST_SEARCH", "LOCATE", "ORIENT", "RESEARCH", "EXHAUSTIVE_JOB", "VERIFY_EXACT", "MATERIALIZE"] as const) {
      const plan = compileQueryPlan({
        raw_query: "needle", product, literals: ["needle"], requested_limit: 10,
        deadline_ms: 1000, scope_snapshot: {} as never, policy: {} as never,
      });
      expect(directLanesPrecedeSemantic(plan)).toBe(true);
    }
  });

  it("freezes scope before any lane and runs direct lanes before semantic", async () => {
    const frozen = q3Scope();
    const harness = q3Harness({
      scope: frozen,
      candidates: {
        IDENT: [q3Candidate({ candidate_id: "c-ident", lane: "IDENT" })],
        LEX: [q3Candidate({ candidate_id: "c-lex", lane: "LEX" })],
        SEM: [q3Candidate({ candidate_id: "c-sem", lane: "SEM", rank: 2 })],
      },
    });
    const service = createRetrievalQueryService(harness.ports);
    const result = await service.query({ request: q3Request(), idempotency_key: "q3-key-1" });
    expect(harness.calls[0]).toBe("freeze");
    const laneOrder = harness.calls.filter((call) => call.startsWith("lane:"));
    expect(laneOrder.slice(0, 3)).toEqual(["lane:IDENT", "lane:LEX", "lane:SEM"]);
    expect(result.trace.lanes_skipped).toContainEqual({ lane: "EXACT", reason: "LANE_UNAVAILABLE" });
    expect(laneOrder.indexOf("lane:LEX")).toBeLessThan(laneOrder.indexOf("lane:SEM"));
    expect(result.evidence_pack.scope_snapshot_ref).toEqual({ id: frozen.snapshot_id, revision: frozen.revision });
    expect(result.trace.scope_snapshot).toEqual(frozen);
    expect(result.coverage_claim).toBe("SAMPLED");
  });

  it("degrades a failed semantic lane visibly while keeping exact results", async () => {
    const harness = q3Harness({
      candidates: { LEX: [q3Candidate({ candidate_id: "c-lex", lane: "LEX" })] },
      failingLanes: { SEM: "SEARCH_INCOMPLETE" },
    });
    const result = await createRetrievalQueryService(harness.ports)
      .query({ request: q3Request(), idempotency_key: "q3-key-2" });
    expect(result.trace.lanes_used).toContain("LEX");
    expect(result.trace.lanes_skipped).toContainEqual({ lane: "SEM", reason: "SEARCH_INCOMPLETE" });
    expect(result.coverage_claim).toBe("SAMPLED");
    expect(result.evidence_pack.resolved_evidence).toHaveLength(1);
  });

  it("never converts an AI Search no-hit into an absence claim", async () => {
    const harness = q3Harness({
      candidates: { IDENT: [], LEX: [], SEM: [] },
    });
    const result = await createRetrievalQueryService(harness.ports)
      .query({ request: q3Request(), idempotency_key: "q3-key-3" });
    expect(result.coverage_claim).toBe("NONE");
    expect(result.evidence_pack.resolved_evidence).toEqual([]);
    expect(result.evidence_pack.omitted_candidates).toEqual([]);
    expect(result.trace.candidates_by_lane["SEM"]).toBe(0);
    expect(result.trace.stale_or_degraded_channels).toContain("NO_HIT");
  });

  it("replays the same retry without re-executing lanes and conflicts on changed inputs", async () => {
    const harness = q3Harness({
      candidates: { LEX: [q3Candidate({ candidate_id: "c-lex", lane: "LEX" })] },
    });
    const service = createRetrievalQueryService(harness.ports);
    const first = await service.query({ request: q3Request(), idempotency_key: "q3-key-4" });
    const laneCallsAfterFirst = harness.calls.filter((call) => call.startsWith("lane:")).length;
    expect(laneCallsAfterFirst).toBeGreaterThan(0);
    const second = await service.query({ request: q3Request(), idempotency_key: "q3-key-4" });
    expect(second.evidence_pack.pack_ref).toEqual(first.evidence_pack.pack_ref);
    expect(harness.calls.filter((call) => call.startsWith("lane:")).length).toBe(laneCallsAfterFirst);
    const conflict = await q3Error(service.query({
      request: q3Request({ raw_query: "changed" }),
      idempotency_key: "q3-key-4",
    }));
    expect(conflict.code).toBe("RETRIEVAL_IDEMPOTENCY_CONFLICT");
  });

  it("aborts on budget stop without persisting a result", async () => {
    const harness = q3Harness({
      candidates: { LEX: [q3Candidate({ candidate_id: "c-lex", lane: "LEX" })] },
      budget: (call) => {
        if (call >= 3) throw new RetrievalQueryError("RETRIEVAL_BUDGET_STOP", "budget exhausted");
      },
    });
    const error = await q3Error(createRetrievalQueryService(harness.ports)
      .query({ request: q3Request(), idempotency_key: "q3-key-5" }));
    expect(error.code).toBe("RETRIEVAL_BUDGET_STOP");
    expect(harness.calls).not.toContain("persist");
    expect(harness.store.has("q3-key-5")).toBe(false);
  });

  it("fails closed when scope goes stale mid-run and resolves nothing", async () => {
    const harness = q3Harness({
      candidates: { LEX: [q3Candidate({ candidate_id: "c-lex", lane: "LEX" })] },
      currentness: (call) => {
        if (call >= 2) throw new RetrievalQueryError("RETRIEVAL_SCOPE_STALE", "scope snapshot expired");
      },
    });
    const error = await q3Error(createRetrievalQueryService(harness.ports)
      .query({ request: q3Request(), idempotency_key: "q3-key-6" }));
    expect(error.code).toBe("RETRIEVAL_SCOPE_STALE");
    expect(harness.calls.some((call) => call.startsWith("resolve:"))).toBe(false);
  });

  it("refuses a substituted trace binding without storing a result", async () => {
    const harness = q3Harness({
      candidates: { LEX: [q3Candidate({ candidate_id: "c-lex", lane: "LEX" })] },
      persist: () => Promise.resolve({ id: "query-substituted", revision: 1 }),
    });
    const error = await q3Error(createRetrievalQueryService(harness.ports)
      .query({ request: q3Request(), idempotency_key: "q3-key-7" }));
    expect(error.code).toBe("RETRIEVAL_TRACE_CORRUPT");
    expect(harness.store.has("q3-key-7")).toBe(false);
  });

  it("binds multi-project UNION then EXCEPT scopes without cross-contamination", async () => {
    const unionScope = q3Scope({
      snapshot_id: "snap-union",
      digest: "c".repeat(64),
      resolved_scope_expression: {
        kind: "UNION",
        left: { kind: "PROJECT", project_id: "pa" },
        right: { kind: "PROJECT", project_id: "pb" },
      },
      member_source_revision_refs: ["rev-a", "rev-b"],
      source_owner_generations: { "rev-a": "gen-a", "rev-b": "gen-b" },
    });
    const union = q3Harness({
      scope: unionScope,
      candidates: { LEX: [q3Candidate({ candidate_id: "c-a", source_revision_ref: "rev-a" })] },
    });
    const unionResult = await createRetrievalQueryService(union.ports)
      .query({ request: q3Request(), idempotency_key: "q3-union" });
    expect(unionResult.trace.scope_snapshot.digest).toBe("c".repeat(64));
    expect(unionResult.evidence_pack.scope_snapshot_ref).toEqual({ id: "snap-union", revision: 1 });

    const exceptScope = q3Scope({
      snapshot_id: "snap-except",
      digest: "d".repeat(64),
      resolved_scope_expression: {
        kind: "EXCEPT",
        left: { kind: "PROJECT", project_id: "pa" },
        right: { kind: "PROJECT", project_id: "pb" },
      },
      member_source_revision_refs: ["rev-a"],
      source_owner_generations: { "rev-a": "gen-a" },
    });
    const except = q3Harness({
      scope: exceptScope,
      candidates: { LEX: [q3Candidate({ candidate_id: "c-a", source_revision_ref: "rev-a" })] },
    });
    const exceptResult = await createRetrievalQueryService(except.ports)
      .query({ request: q3Request(), idempotency_key: "q3-except" });
    expect(exceptResult.trace.scope_snapshot.digest).toBe("d".repeat(64));
    expect(exceptResult.trace.scope_snapshot.member_source_revision_refs).toEqual(["rev-a"]);
  });

  it("reports per-candidate resolution omissions while keeping resolved evidence", async () => {
    const harness = q3Harness({
      candidates: {
        LEX: [
          q3Candidate({ candidate_id: "c-good", lane: "LEX", rank: 1 }),
          q3Candidate({ candidate_id: "c-bad", lane: "LEX", rank: 2, canonical_section_id: "sec-2" }),
        ],
      },
      resolve: async (candidate: LocatorCandidate, scope: ScopeSnapshot) =>
        candidate.candidate_id === "c-bad" ? null : q3Resolved(candidate, scope),
    });
    const result = await createRetrievalQueryService(harness.ports)
      .query({ request: q3Request(), idempotency_key: "q3-key-8" });
    expect(result.coverage_claim).toBe("SAMPLED");
    expect(result.evidence_pack.resolved_evidence).toHaveLength(1);
    expect(result.evidence_pack.omitted_candidates).toContainEqual({
      candidate_id: "c-bad",
      reason_code: "EVIDENCE_UNRESOLVED",
    });
  });

  it("enforces source-family diversity in fusion order", async () => {
    const harness = q3Harness({
      candidates: {
        LEX: [
          q3Candidate({ candidate_id: "c-a1", lane: "LEX", rank: 1, source_revision_ref: "rev-a", metadata: { source_family: "family-a" } }),
          q3Candidate({ candidate_id: "c-a2", lane: "LEX", rank: 2, source_revision_ref: "rev-a", canonical_section_id: "sec-2", metadata: { source_family: "family-a" } }),
          q3Candidate({ candidate_id: "c-b1", lane: "LEX", rank: 3, source_revision_ref: "rev-b", canonical_section_id: "sec-1", metadata: { source_family: "family-b" } }),
        ],
      },
      fusion: { maxPerFamily: 1 },
    });
    const result = await createRetrievalQueryService(harness.ports)
      .query({ request: q3Request(), idempotency_key: "q3-key-9" });
    const kept = result.evidence_pack.resolved_evidence.map((item) => item.handle.handle_ref.id);
    expect(kept).toContain("handle-c-a1");
    expect(kept).toContain("handle-c-b1");
    expect(kept).not.toContain("handle-c-a2");
    expect(result.evidence_pack.omitted_candidates).toContainEqual({
      candidate_id: "c-a2",
      reason_code: "FUSION_CAP_DROPPED",
    });
  });
});
