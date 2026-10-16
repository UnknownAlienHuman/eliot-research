import { describe, expect, it } from "vitest";
import type { LocatorCandidate, ResolvedEvidence, ScopeSnapshot } from "@eliotr/contracts";
import type { RetrievalRequest } from "./ports.js";
import { sourceDiverseEvidenceOrder } from "./evidence-selection.js";
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
      if (lane !== rows[0]?.lane) return null;
      return { async execute() { laneCalls += 1; return rows; } };
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
  it("covers canonical sources before extras without changing locators or within-source rank", () => {
    const rows = candidates(3, 3);
    const before = JSON.stringify(rows);
    const ordered = sourceDiverseEvidenceOrder(rows);
    expect(ordered.map((candidate) => candidate.rank)).toEqual([1, 4, 7, 2, 3, 5, 6, 8, 9]);
    expect(JSON.stringify(rows)).toBe(before);
    for (const candidate of ordered) expect(rows.find((row) => row.candidate_id === candidate.candidate_id)).toBe(candidate);
    expect(sourceDiverseEvidenceOrder(rows)).toEqual(ordered);
  });

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

  it("leaves FAST_SEARCH selection in rank order", async () => {
    const world = harness(candidates(3, 3, "LEX"));
    const result = await world.service.query({ request: { ...world.request, product: "FAST_SEARCH", requested_limit: 2 }, idempotency_key: "fast-selection" });
    expect(world.seen).toEqual(["candidate-01", "candidate-02"]);
    expect(result.evidence_pack.resolved_evidence.map((value) => value.handle.source_revision_ref)).toEqual(["revision-0", "revision-0"]);
  });

  it("counts unresolved reads against the same scan cap and retains source caps", async () => {
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
    const result = await capped.service.query({ request: capped.request, idempotency_key: "source-cap" });
    expect(result.evidence_pack.resolved_evidence).toHaveLength(3);
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
