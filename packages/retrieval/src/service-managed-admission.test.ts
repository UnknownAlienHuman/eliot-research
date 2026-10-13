import { describe, expect, it } from "vitest";
import type { LocatorCandidate, ResolvedEvidence, ScopeSnapshot } from "@eliotr/contracts";
import {
  createRetrievalQueryService,
  type RetrievalQueryPorts,
  type StoredRetrievalResult,
} from "./service.js";
import { createSemLaneExecutor } from "./lanes.js";
import type {
  ManagedSearchOutcomeDraft,
  RetrievalQueryAdmissionReceiptV1,
  RetrievalRequest,
} from "./ports.js";

const FIXED_AT = "2026-09-08T00:00:00.000Z";

function scopeFixture(): ScopeSnapshot {
  return {
    snapshot_id: "managed-service-scope",
    revision: 1,
    resolved_scope_expression: { kind: "PROJECT", project_id: "project-1" },
    participant_generations: {},
    member_source_revision_refs: ["revision-1"],
    source_owner_generations: { "revision-1": "owner-1" },
    policy_authority_ref: "policy-1",
    disclosure_closure_digest: "a".repeat(64),
    purge_ledger_revision: 0,
    digest: "b".repeat(64),
    created_at: FIXED_AT,
    expires_at: "2026-09-09T00:00:00.000Z",
  };
}

function managedCandidate(candidateId: string, sectionId: string, rank: number): LocatorCandidate {
  return {
    candidate_id: candidateId,
    lane: "SEM",
    source_revision_ref: "revision-1",
    canonical_section_id: sectionId,
    preview: "provider preview",
    raw_score: 0.9 - rank / 100,
    rank,
    index_generation: "generation-1",
    metadata: {
      provider_item_key: `item-${rank}`,
      provider_chunk_type: "text",
      content_sha256: String(rank).repeat(64),
      instruction_taint: "DATA_ONLY",
      provider_rerank_requested: true,
      provider_rerank_enabled: true,
      provider_rerank_succeeded: true,
    },
  };
}

function exactEvidence(candidate: LocatorCandidate, scope: ScopeSnapshot): ResolvedEvidence {
  const excerpt = "exact tail evidence";
  const excerptBytes = new TextEncoder().encode(excerpt).byteLength;
  return {
    handle: {
      handle_ref: { id: `handle-${candidate.candidate_id}`, revision: 1 },
      source_namespace_id: "namespace-1",
      source_owner_generation: "owner-1",
      source_revision_ref: candidate.source_revision_ref,
      scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
      anchor: { kind: "normalized_byte_range", start: 0, end: excerptBytes },
      excerpt_sha256: "c".repeat(64),
      excerpt_byte_length: excerptBytes,
      object_residency_key_digest: "d".repeat(64),
      source_assurance_ceiling: "EXACT",
      materializer_assurance_ceiling: "EXACT",
      terminal_state: "LIVE",
      created_at: FIXED_AT,
    },
    exact_excerpt: excerpt,
    verification_receipt_ref: "verification-1",
    authorization_receipt_ref: "authorization-1",
    credential_generation: "credential-1",
    source_revision_content_sha256: "e".repeat(64),
    scope_snapshot_digest: scope.digest,
    instruction_taint: "DATA_ONLY",
    allowed_effects: "READ_ONLY",
    resolved_at: FIXED_AT,
  };
}

describe("managed retrieval admission and physical-list rank", () => {
  it("does not dispatch managed search for an empty scope without an admission receipt", async () => {
    const scope = { ...scopeFixture(), member_source_revision_refs: [] };
    let providerCalls = 0;
    let admissionCalls = 0;
    const executor = createSemLaneExecutor({
      async search() {
        throw new Error("legacy managed call must not be used");
      },
      async searchManaged() {
        providerCalls += 1;
        throw new Error("empty scope must not dispatch the managed provider");
      },
    });
    const result = await executor.execute("SEM", {
      raw_query: "needle",
      product: "LOCATE",
      scope_snapshot: scope,
      literals: [],
      requested_limit: 1,
      deadline_ms: 1_000,
    }, {
      provider_candidate_limit: 10,
      async beforeManagedCall() {
        admissionCalls += 1;
        return undefined;
      },
    });

    expect(result).toMatchObject({
      execution_state: "NOT_EXECUTED",
      submitted_query: "",
      candidates: [],
      outcome: null,
    });
    expect(providerCalls).toBe(0);
    expect(admissionCalls).toBe(0);
  });

  it("admits once before one managed call, skips phase-only LEX, and backfills exact evidence in provider order", async () => {
    const scope = scopeFixture();
    const top = managedCandidate("managed-top", "section-top", 1);
    const tail = managedCandidate("managed-tail", "section-tail", 2);
    const independentIdent = { ...managedCandidate("d1-ident", "section-ident", 3), lane: "IDENT" as const };
    const callOrder: string[] = [];
    const idempotencyKey = "managed-service-admission";
    let receipt: RetrievalQueryAdmissionReceiptV1 | undefined;
    let lexicalCalls = 0;
    let providerCalls = 0;
    const resolvedCandidates: string[] = [];

    const outcome: ManagedSearchOutcomeDraft = {
      protocol: "eliotr.managed-ranking-outcome.v1",
      provider: "cloudflare_ai_search",
      provider_execution_identity: {
        available: false,
        provider_execution_id: null,
        reason: "BINDING_RESPONSE_HAS_NO_EXECUTION_ID",
      },
      provider_authority: {
        namespace: "namespace-1",
        instance_id: "instance-1",
        registry_revision: 1,
        registry_artifact_sha256: "f".repeat(64),
      },
      authority_generations: {
        policy_generation: null,
        execution_generation: null,
        index_generation: "generation-1",
        query_compiler_generation: null,
      },
      executed_query: "needle",
      contributing_signals: [{ signal: "NATIVE_FUSION", basis: "EXECUTED_QUERY" }],
      list_semantics: "ONE_PHYSICAL_MANAGED_LIST",
      scope_absence_proven: false,
      rerank_requested: true,
      rerank_attempted: true,
      rerank_succeeded: true,
      rerank_provider: "cloudflare_ai_search",
      rerank_model: "rerank-model-1",
      fallback_used: false,
      failure_class: null,
      processing_state: "COMPLETE",
    };
    const semantic = createSemLaneExecutor({
      async search() {
        throw new Error("legacy managed call must not be used");
      },
      async searchManaged(_request, _lanes, _expansion, admission) {
        providerCalls += 1;
        callOrder.push("provider");
        expect(admission).toEqual(receipt);
        return {
          execution_state: "EXECUTED",
          submitted_query: "needle",
          candidates: [top, tail],
          outcome,
        };
      },
    });
    const storedRows = new Map<string, StoredRetrievalResult>();
    const ports: RetrievalQueryPorts = {
      async freezeScope() { return scope; },
      async requireCurrentScope() {},
      admission: {
        async admit(input) {
          callOrder.push("admit");
          const operationId = `q4-${"9".repeat(64)}`;
          receipt = {
            protocol: "eliotr.retrieval-query-admission.v1",
            retrieval_operation_id: operationId,
            scoped_invocation_id: operationId,
            execution_id: "8".repeat(48),
            request_digest: input.request_digest,
            scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
            scope_digest: scope.digest,
            intent_ref: { id: operationId, revision: 1 },
            attempt_ref: `${operationId}-a1`,
            fence: {
              operation_id: "8".repeat(48),
              lease_owner: "lease-owner-1",
              lease_generation: 1,
            },
          };
          return receipt;
        },
        async recheck(admitted) {
          callOrder.push("recheck");
          expect(admitted).toEqual(receipt);
        },
      },
      lanes: {
        executorFor(lane) {
          if (lane === "SEM") return semantic;
          if (lane === "IDENT") {
            return {
              async execute() {
                return [independentIdent];
              },
            };
          }
          if (lane === "LEX") {
            return {
              async execute() {
                lexicalCalls += 1;
                return [top];
              },
            };
          }
          return null;
        },
      },
      fusion: {
        reciprocal_rank_constant: 60,
        lane_weights: {},
        maxPerSourceRevision: 3,
      },
      async resolveEvidence(candidate, frozenScope) {
        resolvedCandidates.push(candidate.candidate_id);
        return candidate.candidate_id === tail.candidate_id
          ? exactEvidence(candidate, frozenScope)
          : null;
      },
      async persistTrace(trace) { return trace.trace_ref; },
      results: {
        async load(key) { return storedRows.get(key) ?? null; },
        async loadPending() { return null; },
        async store(record) { storedRows.set(record.idempotency_key, record); },
        async settle(record, ownerReceipt) {
          if (ownerReceipt === undefined) throw new Error("managed result settlement requires its owner receipt");
          expect(ownerReceipt).toEqual(receipt);
          storedRows.set(record.idempotency_key, record);
          return record;
        },
      },
      checkBudget() {},
    };
    const request: RetrievalRequest = {
      raw_query: "needle",
      product: "LOCATE",
      scope_snapshot: scope,
      literals: [],
      requested_limit: 1,
      deadline_ms: 1_000,
    };

    const result = await createRetrievalQueryService(ports).query({ request, idempotency_key: idempotencyKey });

    expect(providerCalls).toBe(1);
    expect(lexicalCalls).toBe(0);
    expect(callOrder).toEqual(["admit", "recheck", "provider"]);
    expect(resolvedCandidates).toEqual([top.candidate_id, tail.candidate_id]);
    expect(result.evidence_pack.resolved_evidence.map((item) => item.exact_excerpt)).toEqual(["exact tail evidence"]);
    expect(result.trace.lanes_skipped).toContainEqual({ lane: "LEX", reason: "MANAGED_HYBRID_PRIMARY" });
    if (!("managed_ranking_outcomes" in result.trace)) {
      throw new Error("managed provider execution did not produce the additive strict trace");
    }
    expect(result.trace.managed_ranking_outcomes[0]?.ordered_candidates.map((item) => item.provider_rank))
      .toEqual([1, 2]);
    expect(result.trace.managed_ranking_outcomes[0]?.rerank_succeeded).toBe(true);
    // Read the settled row back out of the result store rather than holding a closure
    // reference, whose assignment TypeScript cannot see for control-flow narrowing.
    const storedRecord = await storedRows.get(idempotencyKey);
    expect(storedRecord?.result).toEqual(result);
  });
});
