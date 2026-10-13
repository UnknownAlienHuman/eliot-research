import { describe, expect, it } from "vitest";
import {
  MANAGED_RETRIEVAL_TRACE_PROTOCOL,
  MANAGED_RANKING_OUTCOME_PROTOCOL,
  ManagedRankingOutcomeSchema,
  ManagedRetrievalTraceSchema,
} from "./retrieval-managed-ranking.js";
import {
  RetrievalLaneSchema,
  RetrievalTraceSchema,
  type RetrievalLane,
  type RetrievalTrace,
} from "./retrieval.js";
import type { ManagedRankingOutcome } from "./retrieval-managed-ranking.js";

const SHA_REQUEST = "a".repeat(64);
const SHA_OUTPUT = "b".repeat(64);
const SHA_REGISTRY = "c".repeat(64);
const SHA_CONTENT = "d".repeat(64);
const SHA_SCOPE = "e".repeat(64);
const SHA_SCOPE_DIGEST = "f".repeat(64);
const RANKING_SCORE = 0.1234567890123456;

function outcome(): ManagedRankingOutcome {
  return {
    protocol: MANAGED_RANKING_OUTCOME_PROTOCOL,
    provider: "cloudflare_ai_search",
    request_digest: SHA_REQUEST,
    scoped_invocation_id: "scope-invocation-1",
    provider_execution_identity: {
      available: false,
      provider_execution_id: null,
      reason: "BINDING_RESPONSE_HAS_NO_EXECUTION_ID",
    },
    output_digest: SHA_OUTPUT,
    provider_authority: {
      namespace: "research",
      instance_id: "managed-search",
      registry_revision: 4,
      registry_artifact_sha256: SHA_REGISTRY,
    },
    authority_generations: {
      policy_generation: null,
      execution_generation: null,
      index_generation: "index-generation-1",
      query_compiler_generation: null,
    },
    executed_query: "query returned by binding search_query",
    contributing_signals: [
      { signal: "KEYWORD", basis: "RESPONSE_SCORING_DETAILS" },
      { signal: "VECTOR", basis: "RESPONSE_SCORING_DETAILS" },
      { signal: "NATIVE_FUSION", basis: "EXECUTED_QUERY" },
    ],
    list_semantics: "ONE_PHYSICAL_MANAGED_LIST",
    scope_absence_proven: false,
    rerank_requested: true,
    rerank_attempted: true,
    rerank_succeeded: true,
    rerank_provider: "cloudflare_ai_search",
    rerank_model: "reranker-model",
    fallback_used: false,
    failure_class: null,
    processing_state: "COMPLETE",
    ordered_candidates: [{
      provider_rank: 1,
      raw_score: RANKING_SCORE,
      locator: {
        candidate_id: "provider-chunk-1",
        source_revision_ref: "source-revision-1",
        canonical_section_id: "section-1",
        index_generation: "index-generation-1",
        metadata: {
          provider_item_key: "item-1.md",
          provider_chunk_type: "text",
          content_sha256: SHA_CONTENT,
          instruction_taint: "DATA_ONLY",
        },
      },
      scoring_details: {
        fusion_method: "rrf",
        keyword_rank: 2,
        keyword_score: 0.234567890123456,
        reranking_score: 0.345678901234567,
        vector_rank: 1,
        vector_score: 0.456789012345678,
      },
    }],
  };
}

function noHitOutcome(): ManagedRankingOutcome {
  return {
    ...outcome(),
    rerank_succeeded: null,
    processing_state: "NO_HIT",
    ordered_candidates: [],
  };
}

function legacyTrace(): RetrievalTrace {
  const candidatesByLane = Object.fromEntries(
    RetrievalLaneSchema.options.map((lane) => [lane, 0]),
  ) as Record<RetrievalLane, number>;
  return {
    trace_ref: { id: "trace-1", revision: 1 },
    raw_query: "query",
    scope_snapshot: {
      snapshot_id: "scope-1",
      revision: 1,
      resolved_scope_expression: { kind: "GLOBAL_LIBRARY" },
      participant_generations: {},
      member_source_revision_refs: ["source-revision-1"],
      source_owner_generations: {},
      policy_authority_ref: "policy-authority-1",
      disclosure_closure_digest: SHA_SCOPE,
      purge_ledger_revision: 0,
      digest: SHA_SCOPE_DIGEST,
      created_at: "2026-10-13T12:00:00Z",
      expires_at: "2026-10-13T12:05:00Z",
    },
    query_product: "LOCATE",
    lanes_used: ["SEM"],
    lanes_skipped: [],
    exact_probes: [],
    index_generations: ["index-generation-1"],
    context_expansion: 0,
    candidates_by_lane: candidatesByLane,
    expansion_refs: [],
    represented_source_refs: [],
    omitted_sources: [],
    stale_or_degraded_channels: [],
    budget_receipt_ref: "budget-1",
  };
}

describe("managed ranking contracts", () => {
  it("preserves finite decimal scores without rounding", () => {
    const parsed = ManagedRankingOutcomeSchema.parse(outcome());
    expect(parsed.ordered_candidates[0]?.raw_score).toBe(RANKING_SCORE);
    expect(parsed.ordered_candidates[0]?.scoring_details?.vector_score).toBe(0.456789012345678);
  });

  it("records no-hit and unknown rerank success without claiming scope absence", () => {
    const value = noHitOutcome();
    const parsed = ManagedRankingOutcomeSchema.parse(value);
    expect(parsed.processing_state).toBe("NO_HIT");
    expect(parsed.rerank_succeeded).toBeNull();
    expect(parsed.scope_absence_proven).toBe(false);
    expect(parsed.provider_execution_identity.provider_execution_id).toBeNull();
    expect(parsed.request_digest).not.toBe(parsed.output_digest);
  });

  it("rejects rank/order drift and fallback without a degraded outcome", () => {
    const rankDrift = outcome();
    rankDrift.ordered_candidates[0]!.provider_rank = 2;
    expect(ManagedRankingOutcomeSchema.safeParse(rankDrift).success).toBe(false);

    const hiddenFallback = { ...outcome(), fallback_used: true };
    expect(ManagedRankingOutcomeSchema.safeParse(hiddenFallback).success).toBe(false);
  });

  it("keeps provider execution identity explicitly unavailable and strict", () => {
    const forgedIdentity = {
      ...outcome(),
      provider_execution_identity: {
        available: false,
        provider_execution_id: null,
        reason: "BINDING_RESPONSE_HAS_NO_EXECUTION_ID",
        provider_id: "invented-provider-id",
      },
    };
    expect(ManagedRankingOutcomeSchema.safeParse(forgedIdentity).success).toBe(false);
  });

  it("keeps legacy trace readability and requires outcomes in the managed version", () => {
    const legacy = legacyTrace();
    expect(RetrievalTraceSchema.safeParse(legacy).success).toBe(true);
    expect(ManagedRetrievalTraceSchema.safeParse({
      ...legacy,
      protocol: MANAGED_RETRIEVAL_TRACE_PROTOCOL,
      managed_ranking_outcomes: [],
    }).success).toBe(false);

    expect(ManagedRetrievalTraceSchema.safeParse({
      ...legacy,
      protocol: MANAGED_RETRIEVAL_TRACE_PROTOCOL,
      managed_ranking_outcomes: [outcome()],
    }).success).toBe(true);
  });
});




