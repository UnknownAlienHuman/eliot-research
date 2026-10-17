import { describe, expect, it } from "vitest";
import type { LocatorCandidate, ResolvedEvidence, ScopeSnapshot } from "@eliotr/contracts";
import type { RetrievalRequest } from "./ports.js";
import { createRetrievalQueryService, RetrievalQueryError, type RetrievalQueryPorts, type StoredRetrievalResult } from "./service.js";

const AT = "2026-10-16T16:38:36.071Z";
const encoder = new TextEncoder();

function candidates(sourceCount = 10, perSource = 5, lane: LocatorCandidate["lane"] = "SEM"): LocatorCandidate[] {
  return Array.from({ length: sourceCount * perSource }, (_, index) => ({
    candidate_id: `candidate-${String(index + 1).padStart(2, "0")}`, lane,
    source_revision_ref: `revision-${Math.floor(index / perSource)}`,
    canonical_section_id: `section-${index}`, preview: "untrusted preview, same apparent source name",
    raw_score: 1 - index / 100, rank: index + 1, index_generation: "index-1",
    metadata: { content_sha256: "a".repeat(64), title: "same untrusted title" },
  }));
}

async function exact(candidate: LocatorCandidate, scope: ScopeSnapshot, text: string): Promise<ResolvedEvidence> {
  const bytes = encoder.encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return {
    handle: {
      handle_ref: { id: `handle-${candidate.candidate_id}`, revision: 1 },
      source_namespace_id: `namespace-${candidate.source_revision_ref}`, source_owner_generation: "owner-1",
      source_revision_ref: candidate.source_revision_ref, scope_snapshot_ref: { id: scope.snapshot_id, revision: 1 },
      anchor: { kind: "normalized_byte_range", start: 0, end: bytes.byteLength }, excerpt_sha256: sha,
      excerpt_byte_length: bytes.byteLength, object_residency_key_digest: "b".repeat(64),
      source_assurance_ceiling: "EXACT", materializer_assurance_ceiling: "EXACT", terminal_state: "LIVE", created_at: AT,
    },
    exact_excerpt: text, verification_receipt_ref: `verified-${candidate.candidate_id}`,
    authorization_receipt_ref: "authorization-1", credential_generation: "credential-1",
    source_revision_content_sha256: "c".repeat(64), scope_snapshot_digest: scope.digest,
    instruction_taint: "DATA_ONLY", allowed_effects: "READ_ONLY", resolved_at: AT,
  };
}

function harness(rows: readonly LocatorCandidate[], options: {
  readonly unresolved?: ReadonlySet<string>;
  readonly excerpt?: (candidate: LocatorCandidate) => string;
  readonly revokeAfterFirst?: boolean;
  readonly maxPerSource?: number;
} = {}) {
  const sources = [...new Set(rows.map((candidate) => candidate.source_revision_ref))];
  const scope: ScopeSnapshot = {
    snapshot_id: "scope-selection", revision: 1,
    resolved_scope_expression: { kind: "PROJECT", project_id: "project-selection" },
    participant_generations: {}, member_source_revision_refs: sources,
    source_owner_generations: Object.fromEntries(sources.map((source) => [source, "owner-1"])),
    policy_authority_ref: "policy-1", disclosure_closure_digest: "d".repeat(64),
    purge_ledger_revision: 0, digest: "e".repeat(64), created_at: AT, expires_at: "2027-10-16T00:00:00.000Z",
  };
  const events: string[] = [];
  const seen: string[] = [];
  const evidenceByCandidate = new Map<string, ResolvedEvidence>();
  const stored = new Map<string, StoredRetrievalResult>();
  let current = true;
  let laneCalls = 0;
  let traceWrites = 0;
  const ports: RetrievalQueryPorts = {
    async freezeScope() { return scope; },
    async requireCurrentScope() {
      events.push("authority");
      if (!current) throw new RetrievalQueryError("RETRIEVAL_AUTHORITY_STALE", "scope revoked during exact reads");
    },
    lanes: { executorFor(lane) {
      const laneRows = rows.filter((candidate) => candidate.lane === lane);
      if (laneRows.length === 0) return null;
      return { async execute() { laneCalls += 1; return laneRows; } };
    } },
    fusion: { reciprocal_rank_constant: 60, lane_weights: {}, maxPerSourceRevision: options.maxPerSource ?? 5 },
    async resolveEvidence(candidate, frozen) {
      expect(events.slice(-2)).toEqual(["budget", "authority"]);
      events.push(`resolve:${candidate.candidate_id}`);
      seen.push(candidate.candidate_id);
      if (options.unresolved?.has(candidate.candidate_id)) return null;
      const value = await exact(candidate, frozen, options.excerpt?.(candidate) ?? `exact ${candidate.candidate_id}`);
      evidenceByCandidate.set(candidate.candidate_id, value);
      if (options.revokeAfterFirst) current = false;
      return value;
    },
    async persistTrace(trace) { traceWrites += 1; return trace.trace_ref; },
    results: {
      async load(key) { return stored.get(key) ?? null; },
      async store(record) { stored.set(record.idempotency_key, record); },
    },
    checkBudget() { events.push("budget"); },
  };
  const request: RetrievalRequest = {
    raw_query: "compare methods across this source set", product: "RESEARCH", scope_snapshot: scope,
    literals: [], requested_limit: 16, deadline_ms: Number.MAX_SAFE_INTEGER,
    budgets: { candidate_limit: 50, scan_limit: 16, evidence_limit: 16, max_evidence_bytes: 4096 },
  };
  const service = createRetrievalQueryService(ports);
  return { request, service, seen, evidenceByCandidate, stored,
    laneCalls: () => laneCalls, traceWrites: () => traceWrites,
  };
}

describe("Research evidence selection after fusion", () => {
  it("retains all ten represented sources within a sixteen-item/scan bound and replays the same canonical handles", async () => {
    const world = harness(candidates());
    const input = { request: world.request, idempotency_key: "research-source-selection" };
    const execution = await world.service.queryWithBudgetSettlement(input);
    const pack = execution.result.evidence_pack;
    expect(pack.resolved_evidence).toHaveLength(16);
    expect(new Set(pack.resolved_evidence.map((value) => value.handle.source_revision_ref)).size).toBe(10);
    expect(world.seen.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, index) => `candidate-${String(index * 5 + 1).padStart(2, "0")}`));
    expect(execution.budget_settlement?.usage).toMatchObject({
      providerCandidatesReturned: 50, candidateUnitsUsed: 50, exactResolverScanUnitsUsed: 16, evidenceItemsUsed: 16,
    });
    expect(pack.omitted_candidates.filter((item) => item.reason_code === "EVIDENCE_LIMIT")).toHaveLength(34);
    expect(pack.total_utf8_bytes).toBe(pack.resolved_evidence.reduce((total, value) => total + encoder.encode(value.exact_excerpt).byteLength, 0));
    for (const value of pack.resolved_evidence) {
      expect([...world.evidenceByCandidate.values()]).toContainEqual(value);
      expect(value.exact_excerpt).not.toContain("untrusted preview");
    }
    expect(execution.result.coverage_claim).toBe("SAMPLED");
    expect(await world.service.query(input)).toEqual(execution.result);
    expect(world.seen).toHaveLength(16);
    expect(world.laneCalls()).toBe(1);
  });

  it("reconstructed producer: resolves the full Adam locator for a fused SEM/LEX identity without widening budgets", async () => {
    // These are the exact 8588 FAST_SEARCH parent bytes (SHA d1c0497d...) and
    // the exact C3 Research narrowed SEM excerpt (SHA 2290b210...). This is a
    // reconstructed cross-lane seam regression, not a replay of the unpersisted
    // 50-row SEM provider response; ranks below only force SEM to remain the
    // fused score/provenance representative.
    const parent = "### Page 2\nPublished as a conference paper at ICLR 2015Algorithm 1: Adam, our proposed algorithm for stochastic optimization. See section 2 for details,\nand for a slightly more efficient (but less clear) order of computation. g2t indicates the elementwise\nsquare gt gt. Good default settings for the tested machine learning problems are α = 0.001,β1 = 0.9, β2 = 0.999 and \u000f = 10−8. All operations on vectors are element-wise. With βt1 and βt2we denote β1 and β2 to the power t.Require: α: StepsizeRequire: β1, β2 ∈ [0, 1): Exponential decay rates for the moment estimatesRequire: f (θ): Stochastic objective function with parameters θRequire: θ0: Initial parameter vectorm0 ← 0 (Initialize 1st moment vector)v0 ← 0 (Initialize 2nd moment vector)t ← 0 (Initialize timestep)while θt not converged dot ← t + 1gt ← ∇θ ft(θt−1) (Get gradients w.r.t. stochastic objective at timestep t)mt ← β1 · mt−1 + (1 − β1) · gt (Update biased first moment estimate)vt ← β2 · vt−1 + (1 − β2) · g2t (Update biased second raw moment estimate)̂mt ← mt/(1 − βt1) (Compute bias-corrected first moment estimate)̂vt ← vt/(1 − βt2) (Compute bias-corrected second raw moment estimate)θt ← θt−1 − α ·̂ mt/(√̂ vt + \u000f) (Update parameters)end while\nreturn θt (Resulting parameters)\nIn section 2 we describe the algorithm and the properties of its update rule. Section 3 explains\nour initialization bias correction technique, and section 4 provides a theoretical analysis of Adam’s\nconvergence in online convex programming. Empirically, our method consistently outperforms other\nmethods for a variety of models and datasets, as shown in section 6. Overall, we show that Adam is\na versatile algorithm that scales to large-scale high-dimensional machine learning problems.2 ALGORITHMSee algorithm 1 for pseudo-code of our proposed algorithm Adam. Let f (θ) be a noisy objec-\ntive function: a stochastic scalar function that is differentiable w.r.t. parameters θ. We are in-\nterested in minimizing the expected value of this function, E[f (θ)] w.r.t. its parameters θ. Withf1(θ), ..., , fT (θ) we denote the realisations of the stochastic function at subsequent timesteps1, ..., T . The stochasticity might come from the evaluation at random subsamples (minibatches)\nof datapoints, or arise from inherent function noise. With gt = ∇θ ft(θ) we denote the gradient, i.e.\nthe vector of partial derivatives of ft, w.r.t θ evaluated at timestep t.\nThe algorithm updates exponential moving averages of the gradient (mt) and the squared gradient\n(vt) where the hyper-parameters β1, β2 ∈ [0, 1) control the exponential decay rates of these moving\naverages. The moving averages themselves are estimates of the 1st moment (the mean) and the\n2nd raw moment (the uncentered variance) of the gradient. However, these moving averages are\ninitialized as (vectors of) 0’s, leading to moment estimates that are biased towards zero, especially\nduring the initial timesteps, and especially when the decay rates are small (i.e. the βs are close to 1).\nThe good news is that this initialization bias can be easily counteracted, resulting in bias-corrected\nestimateŝ mt and̂ vt. See section 3 for more details.\nNote that the efficiency of algorithm 1 can, at the expense of clarity, be improved upon by changing\nthe order of computation, e.g. by replacing the last three lines in the loop with the following lines:αt = α · √1 − βt2/(1 − βt1) and θt ← θt−1 − αt · mt/(√vt + ˆ\u000f).\n2.1 ADAM’S UPDATE RULEAn important property of Adam’s update rule is its careful choice of stepsizes. Assuming \u000f = 0, the\neffective step taken in parameter space at timestep t is ∆t = α ·̂ mt/√̂ vt. The effective stepsize has\ntwo upper bounds: |∆t| ≤ α · (1 − β1)/√1 − β2 in the case (1 − β1) > √1 − β2, and |∆t| ≤ α2\n\n\n\n";
    const semanticPreview = ". Empirically, our method consistently outperforms other\nmethods for a variety of models and datasets, as shown in section 6. Overall, we show that Adam is\na versatile algorithm that scales to large-scale high-dimensional machine learning problems.2 ALGORITHMSee algorithm 1 for pseudo-code of our proposed algorithm Adam. Let f (θ) be a noisy objec-\ntive function: a stochastic scalar function that is differentiable w.r.t. parameters θ. We are in-\nterested in minimizing the expected value of this function, E[f (θ)] w.r.t. its parameters θ. Withf1(θ), ..., , fT (θ) we denote the realisations of the stochastic function at subsequent timesteps1, ..., T . The stochasticity might come from the evaluation at random subsamples (minibatches)\nof datapoints, or arise from inherent function noise. With gt = ∇θ ft(θ) we denote the gradient, i.e.\nthe vector of partial derivatives of ft, w.r.t θ evaluated at timestep t.\nThe algorithm updates exponential moving averages of the gradient (mt) and the squared gradient\n(vt) where the hyper-parameters β1, β2 ∈ [0, 1) control the exponential decay rates of these moving\naverages.";
    const sourceRevision = "raw-revision-6a1a9fe11297fb0b28e3478cdc31a380392c41bd8de4a7ad";
    const section = "section-d210dbb88ea7df835ba960ab34997eabc96e5bcba63e2ab9";
    const digest = "d1c0497dd7b0ac59a49478f7994c160ada6dfd3b2d11c420e652f7ae12aa76eb";
    expect(semanticPreview).toContain("we show that Adam is");
    expect(parent).toContain("Good default settings for the tested machine learning problems are α = 0.001");
    expect(parent).toContain("10−8");
    expect(semanticPreview).not.toContain("Good default settings");

    const lexical: LocatorCandidate = {
      candidate_id: "projection-dcff075d54fc60624ed7e56366da590c8a75b8b5e0510b6d",
      lane: "LEX", source_revision_ref: sourceRevision, canonical_section_id: section,
      preview: parent, raw_score: 0.9, rank: 2,
      index_generation: "projection-7cf0734aebc024e787e70da92f582522375dca134e4ceb0f",
      metadata: { content_sha256: digest },
    };
    const semantic: LocatorCandidate = {
      ...lexical, candidate_id: "native-sem-adam-page2", lane: "SEM", preview: semanticPreview,
      raw_score: 0.99, rank: 1,
      metadata: { content_sha256: digest, provider: "cloudflare_ai_search", provider_chunk_type: "text" },
    };
    const world = harness([lexical, semantic], {
      excerpt: (candidate) => candidate.lane === "SEM" ? semanticPreview : parent,
    });
    const execution = await world.service.queryWithBudgetSettlement({
      request: {
        ...world.request,
        budgets: { candidate_limit: 2, scan_limit: 1, evidence_limit: 1, max_evidence_bytes: 4096 },
      },
      idempotency_key: "reconstructed-adam-sem-lex-canonical-merge",
    });

    expect(world.seen).toEqual([lexical.candidate_id]);
    expect(execution.result.evidence_pack.resolved_evidence).toHaveLength(1);
    expect(execution.result.evidence_pack.resolved_evidence[0]?.exact_excerpt).toBe(parent);
    expect(execution.result.evidence_pack.resolved_evidence[0]?.handle.excerpt_sha256).toBe(digest);
    expect(execution.result.evidence_pack.omitted_candidates).not.toContainEqual({
      candidate_id: lexical.candidate_id, reason_code: "DIVERSITY_LIMIT",
    });
    expect(execution.budget_settlement?.usage).toMatchObject({
      candidateUnitsUsed: 2, exactResolverScanUnitsUsed: 1, evidenceItemsUsed: 1,
      evidenceBytesUsed: 3909,
    });
    expect(execution.result.evidence_pack.total_utf8_bytes).toBe(3909);

    const byteLimitedWorld = harness([lexical, semantic], {
      excerpt: (candidate) => candidate.lane === "SEM" ? semanticPreview : parent,
    });
    const byteLimited = await byteLimitedWorld.service.queryWithBudgetSettlement({
      request: {
        ...byteLimitedWorld.request,
        budgets: { candidate_limit: 2, scan_limit: 1, evidence_limit: 1, max_evidence_bytes: 1200 },
      },
      idempotency_key: "reconstructed-adam-sem-lex-byte-bound",
    });
    expect(byteLimitedWorld.seen).toEqual([lexical.candidate_id]);
    expect(byteLimited.result.evidence_pack.resolved_evidence).toHaveLength(0);
    expect(byteLimited.result.evidence_pack.total_utf8_bytes).toBe(0);
    expect(byteLimited.result.evidence_pack.omitted_candidates).toContainEqual({
      candidate_id: lexical.candidate_id, reason_code: "EVIDENCE_UTF8_LIMIT",
    });
    expect(byteLimited.budget_settlement?.usage).toMatchObject({
      exactResolverScanUnitsUsed: 1, evidenceItemsUsed: 1, evidenceBytesUsed: 3909,
    });
  });

  it("keeps a high-ranked same-source passage through the source, scan, and evidence caps", async () => {
    const rows = candidates(3, 6).map((row, index) => ({
      ...row,
      source_revision_ref: index === 1
        ? "revision-side-a"
        : index === 2
          ? "revision-side-b"
          : index <= 11
            ? "revision-adam"
            : row.source_revision_ref,
    }));
    const algorithmOne = rows[11];
    if (algorithmOne === undefined) throw new Error("missing target passage");
    const pageTwo = "### Page 2\nAlgorithm 1: Adam. Good default settings include alpha, beta1, beta2, and epsilon.";
    const world = harness(rows, {
      maxPerSource: 8,
      excerpt: (candidate) => candidate.candidate_id === algorithmOne.candidate_id
        ? pageTwo
        : `exact ${candidate.candidate_id}`,
    });

    const execution = await world.service.queryWithBudgetSettlement({
      request: world.request,
      idempotency_key: "research-same-source-evidence-cap",
    });

    expect(execution.budget_settlement?.usage).toMatchObject({
      exactResolverScanUnitsUsed: 16,
      evidenceItemsUsed: 16,
    });
    expect(execution.result.evidence_pack.resolved_evidence.map((item) => item.exact_excerpt))
      .toContain(pageTwo);
    expect(execution.result.evidence_pack.resolved_evidence).toHaveLength(16);
    expect(execution.result.evidence_pack.total_utf8_bytes).toBe(
      execution.result.evidence_pack.resolved_evidence.reduce(
        (total, item) => total + encoder.encode(item.exact_excerpt).byteLength,
        0,
      ),
    );
  });

  it("leaves FAST_SEARCH selection in rank order", async () => {
    const world = harness(candidates(3, 3, "LEX"));
    const result = await world.service.query({ request: { ...world.request, product: "FAST_SEARCH", requested_limit: 2 }, idempotency_key: "fast-selection" });
    expect(world.seen).toEqual(["candidate-01", "candidate-02"]);
    expect(result.evidence_pack.resolved_evidence.map((value) => value.handle.source_revision_ref)).toEqual(["revision-0", "revision-0"]);
  });

  it("counts unresolved reads against the same scan cap and honors source caps up to the output limit", async () => {
    const world = harness(candidates(), { unresolved: new Set(["candidate-01"]) });
    const execution = await world.service.queryWithBudgetSettlement({
      request: { ...world.request, budgets: { ...world.request.budgets, candidate_limit: 50, scan_limit: 10, evidence_limit: 16, max_evidence_bytes: 4096 } },
      idempotency_key: "bounded-unresolved",
    });
    expect(world.seen).toHaveLength(10);
    expect(execution.result.evidence_pack.resolved_evidence).toHaveLength(9);
    expect(execution.budget_settlement?.usage).toMatchObject({ exactResolverScanUnitsUsed: 10, evidenceItemsUsed: 9 });
    expect(execution.result.evidence_pack.omitted_candidates.filter((item) => item.reason_code === "EXACT_RESOLUTION_SCAN_LIMIT")).toHaveLength(40);
    const capped = harness(candidates(3, 3), { maxPerSource: 1 });
    const result = await capped.service.query({
      request: {
        ...capped.request,
        requested_limit: 1,
        budgets: { candidate_limit: 50, scan_limit: 16, evidence_limit: 1, max_evidence_bytes: 4096 },
      },
      idempotency_key: "source-cap",
    });
    expect(result.evidence_pack.resolved_evidence).toHaveLength(1);
    expect(result.evidence_pack.omitted_candidates.filter((item) => item.reason_code === "DIVERSITY_LIMIT")).toHaveLength(6);
  });

  it("keeps the UTF-8 stop and rejects authority loss before further resolution or persistence", async () => {
    const world = harness(candidates(3, 2), { excerpt: (candidate) => candidate.source_revision_ref === "revision-0" ? "four" : "oversized" });
    const execution = await world.service.queryWithBudgetSettlement({
      request: { ...world.request, requested_limit: 3, budgets: { candidate_limit: 50, scan_limit: 6, evidence_limit: 3, max_evidence_bytes: 5 } },
      idempotency_key: "byte-stop",
    });
    expect(world.seen).toEqual(["candidate-01", "candidate-03"]);
    expect(execution.result.evidence_pack.total_utf8_bytes).toBe(4);
    expect(execution.result.evidence_pack.omitted_candidates.filter((item) => item.reason_code === "EVIDENCE_UTF8_LIMIT")).toHaveLength(5);
    expect(execution.budget_settlement?.usage).toMatchObject({ exactResolverScanUnitsUsed: 2, evidenceItemsUsed: 2, evidenceBytesUsed: 13 });
    const revoked = harness(candidates(3, 2), { revokeAfterFirst: true });
    await expect(revoked.service.query({ request: revoked.request, idempotency_key: "authority-loss" }))
      .rejects.toMatchObject({ code: "RETRIEVAL_AUTHORITY_STALE" });
    expect(revoked.seen).toHaveLength(1);
    expect(revoked.traceWrites()).toBe(0);
    expect(revoked.stored.size).toBe(0);
  });

  it("rejects conflicting canonical locator digests before selection can resolve anything", async () => {
    const rows = candidates(1, 2);
    const first = rows[0];
    if (first === undefined) throw new Error("missing fixture");
    const world = harness([first, { ...first, candidate_id: "conflicting-candidate", metadata: { content_sha256: "f".repeat(64) } }]);
    await expect(world.service.query({ request: world.request, idempotency_key: "identity-conflict" }))
      .rejects.toMatchObject({ code: "RETRIEVAL_INPUT_INVALID" });
    expect(world.seen).toEqual([]);
    expect(world.stored.size).toBe(0);
  });
});
