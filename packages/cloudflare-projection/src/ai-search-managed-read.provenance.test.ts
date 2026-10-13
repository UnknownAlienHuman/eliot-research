import { describe, expect, it, vi } from "vitest";
import type { AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";
import type { RetrievalRequest } from "@eliotr/retrieval";
import {
  createAiSearchManagedSearchPort,
  type AiSearchManagedExecutionOutcome,
  type AiSearchManagedReadError,
  type AiSearchManagedSearchAuthority,
  type AiSearchManagedSearchExecution,
  type AiSearchManagedSearchRequest,
} from "./ai-search-managed-read.js";

const FIXED_AT = "2026-09-08T00:00:00.000Z";

function retrievalRequest(overrides: Partial<RetrievalRequest> = {}): RetrievalRequest {
  return {
    raw_query: "needle",
    product: "LOCATE",
    scope_snapshot: {
      snapshot_id: "scope-1",
      revision: 1,
      resolved_scope_expression: { kind: "PROJECT", project_id: "project-1" },
      participant_generations: {},
      member_source_revision_refs: ["revision-1"],
      source_owner_generations: { "revision-1": "owner-1" },
      policy_authority_ref: "policy-1",
      disclosure_closure_digest: "b".repeat(64),
      purge_ledger_revision: 0,
      digest: "c".repeat(64),
      created_at: FIXED_AT,
      expires_at: "2026-09-09T00:00:00.000Z",
    },
    literals: [],
    requested_limit: 2,
    deadline_ms: 1_000,
    ...overrides,
  };
}

function authority(
  overrides: Partial<AiSearchManagedSearchAuthority> = {},
): AiSearchManagedSearchAuthority {
  return {
    namespace: "eliot",
    instance_id: "eliot-hybrid",
    index_generation: "index-1",
    registry_revision: 7,
    registry_artifact_sha256: "a".repeat(64),
    active: true,
    index_method: { vector: true, keyword: true },
    max_results: 50,
    max_preview_bytes: 64 * 1024,
    match_threshold: 0,
    fusion_method: "rrf",
    keyword_match_mode: "or",
    reranking: true,
    ...overrides,
  };
}

function providerChunk(
  id: string,
  score: number,
  scoringDetails: Readonly<Record<string, string | number>> = {},
) {
  return {
    id,
    type: "text",
    score,
    text: `provider preview ${id}`,
    item: {
      key: `${id}.md`,
      metadata: {
        canonical_section_id: `section-${id}`,
        content_sha256: "d".repeat(64),
        instruction_taint: "DATA_ONLY",
        projection_generation: "index-1",
        source_revision_ref: "revision-1",
      },
    },
    ...(Object.keys(scoringDetails).length === 0 ? {} : { scoring_details: scoringDetails }),
  };
}

function portFor(
  response: unknown,
  active: AiSearchManagedSearchAuthority = authority(),
) {
  const search = vi.fn(async (_request: unknown) => response);
  const get = vi.fn(() => ({ search }));
  const port = createAiSearchManagedSearchPort(
    { get } as unknown as AiSearchNamespaceLike,
    active,
  );
  return { port, get, search };
}

function executedOutcome(execution: AiSearchManagedSearchExecution): AiSearchManagedExecutionOutcome {
  if (execution.execution_state !== "EXECUTED" || execution.outcome === null) {
    throw new Error("expected a completed provider execution");
  }
  return execution.outcome;
}

describe("managed AI Search provenance result", () => {
  it("retains one provider-ordered list, actual query, authority, and raw scores", async () => {
    const request = retrievalRequest();
    const { port, search } = portFor({
      query_kind: "text",
      search_query: "provider-normalized needle",
      chunks: [
        providerChunk("chunk-1", 0.937, {
          fusion_method: "rrf",
          keyword_rank: 2,
          keyword_score: 3.25,
          vector_rank: 1,
          vector_score: 0.83,
          reranking_score: 0.91,
        }),
        providerChunk("chunk-2", 0.612, {
          keyword_rank: 4,
          keyword_score: 1.75,
          vector_rank: 3,
          vector_score: 0.54,
          reranking_score: 0.72,
        }),
      ],
    });

    const execution = await port.searchManaged(request, ["SEM"], 1);
    const outcome = executedOutcome(execution);
    const submitted = search.mock.calls[0]?.[0] as AiSearchManagedSearchRequest | undefined;

    expect(execution.execution_state).toBe("EXECUTED");
    expect(execution.submitted_query).toBe(submitted?.query);
    expect(execution.submitted_query).toBe("needle");
    expect(outcome.executed_query).toBe("provider-normalized needle");
    expect(outcome.provider_authority).toEqual({
      namespace: "eliot",
      instance_id: "eliot-hybrid",
      registry_revision: 7,
      registry_artifact_sha256: "a".repeat(64),
    });
    expect(outcome.authority_generations).toEqual({
      policy_generation: null,
      execution_generation: null,
      index_generation: "index-1",
      query_compiler_generation: null,
    });
    expect(outcome.provider_execution_identity).toEqual({
      available: false,
      provider_execution_id: null,
      reason: "BINDING_RESPONSE_HAS_NO_EXECUTION_ID",
    });
    expect(outcome.list_semantics).toBe("ONE_PHYSICAL_MANAGED_LIST");
    expect(execution.candidates.map((candidate) => [candidate.rank, candidate.raw_score])).toEqual([
      [1, 0.937],
      [2, 0.612],
    ]);
    expect(execution.candidates[0]?.metadata).toMatchObject({
      provider_keyword_rank: 2,
      provider_keyword_score: 3.25,
      provider_vector_rank: 1,
      provider_vector_score: 0.83,
      provider_reranking_score: 0.91,
    });
    expect(outcome.contributing_signals).toContainEqual({
      signal: "RERANK",
      basis: "RESPONSE_SCORING_DETAILS",
    });
    expect(outcome.processing_state).toBe("COMPLETE");
    expect(submitted?.ai_search_options.query_rewrite).toEqual({ enabled: false });
    expect(submitted?.ai_search_options.cache).toEqual({ enabled: false });
    expect(submitted?.ai_search_options.retrieval.return_on_failure).toBe(false);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("retains binding search_query on no-hit and leaves unobserved rerank success null", async () => {
    const { port, search } = portFor({
      query_kind: "text",
      search_query: "provider-normalized no-hit query",
      chunks: [],
    });

    const execution = await port.searchManaged(retrievalRequest(), ["SEM"], 1);
    const outcome = executedOutcome(execution);

    expect(execution.candidates).toEqual([]);
    expect(execution.submitted_query).toBe("needle");
    expect(outcome.executed_query).toBe("provider-normalized no-hit query");
    expect(outcome.rerank_requested).toBe(true);
    expect(outcome.rerank_attempted).toBe(true);
    expect(outcome.rerank_succeeded).toBeNull();
    expect(outcome.processing_state).toBe("NO_HIT");
    expect(outcome.scope_absence_proven).toBe(false);
    expect(outcome.fallback_used).toBe(false);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("leaves attempted rerank success unknown when hits contain no reranking score", async () => {
    const { port } = portFor({
      query_kind: "text",
      search_query: "provider query without rerank score",
      chunks: [providerChunk("chunk-1", 0.8, { vector_score: 0.8 })],
    });

    const execution = await port.searchManaged(retrievalRequest(), ["SEM"], 1);
    const outcome = executedOutcome(execution);

    expect(outcome.rerank_attempted).toBe(true);
    expect(outcome.rerank_succeeded).toBeNull();
    expect(outcome.processing_state).toBe("COMPLETE");
    expect(outcome.fallback_used).toBe(false);
    expect(execution.candidates[0]?.metadata).not.toHaveProperty("provider_rerank_succeeded");
  });

  it("distinguishes a requested but profile-disabled rerank from an observed success", async () => {
    const { port } = portFor({
      query_kind: "text",
      search_query: "needle",
      chunks: [providerChunk("chunk-1", 0.8, { vector_score: 0.8 })],
    }, authority({ reranking: false }));

    const execution = await port.searchManaged(retrievalRequest(), ["SEM"], 1);
    const outcome = executedOutcome(execution);

    expect(outcome.rerank_requested).toBe(true);
    expect(outcome.rerank_attempted).toBe(false);
    expect(outcome.rerank_succeeded).toBe(false);
    expect(outcome.rerank_provider).toBeNull();
    expect(outcome.rerank_model).toBeNull();
    expect(outcome.processing_state).toBe("COMPLETE");
    expect(execution.candidates[0]?.metadata["provider_rerank_succeeded"]).toBe(false);
  });

  it("returns no provider outcome for empty scope", async () => {
    const { port, get, search } = portFor({
      query_kind: "text",
      search_query: "must not be used",
      chunks: [],
    });
    const request = retrievalRequest({
      scope_snapshot: {
        ...retrievalRequest().scope_snapshot,
        member_source_revision_refs: [],
        source_owner_generations: {},
      },
    });

    const execution = await port.searchManaged(request, ["SEM"], 1);

    expect(execution.execution_state).toBe("NOT_EXECUTED");
    expect(execution.candidates).toEqual([]);
    expect(execution.outcome).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("returns no provider outcome for a zero candidate budget", async () => {
    const { port, get, search } = portFor({
      query_kind: "text",
      search_query: "must not be used",
      chunks: [],
    });
    const request = retrievalRequest({
      budgets: {
        candidate_limit: 0,
        scan_limit: 1,
        evidence_limit: 1,
        max_evidence_bytes: 1_024,
      },
    });

    const execution = await port.searchManaged(request, ["SEM"], 1);

    expect(execution.execution_state).toBe("NOT_EXECUTED");
    expect(execution.candidates).toEqual([]);
    expect(execution.outcome).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("keeps the legacy search callable on one execution and propagates transport failure without fallback", async () => {
    const responsePort = portFor({
      query_kind: "text",
      search_query: "provider query",
      chunks: [providerChunk("chunk-1", 0.8, { vector_score: 0.8 })],
    });
    const legacyCandidates = await responsePort.port.search(retrievalRequest(), ["SEM"], 1);
    const submitted = responsePort.search.mock.calls[0]?.[0] as AiSearchManagedSearchRequest | undefined;

    expect(legacyCandidates.map((candidate) => candidate.rank)).toEqual([1]);
    expect(responsePort.search).toHaveBeenCalledTimes(1);
    expect(submitted?.ai_search_options.retrieval.return_on_failure).toBe(false);

    const failureSearch = vi.fn(async (_request: unknown) => {
      throw new Error("binding transport failed");
    });
    const failurePort = createAiSearchManagedSearchPort(
      { get: vi.fn(() => ({ search: failureSearch })) } as unknown as AiSearchNamespaceLike,
      authority(),
    );

    await expect(failurePort.searchManaged(retrievalRequest(), ["SEM"], 1)).rejects.toMatchObject({
      code: "AI_SEARCH_MANAGED_PROVIDER_CALL_FAILED",
      retryable: true,
    } satisfies Partial<AiSearchManagedReadError>);
    expect(failureSearch).toHaveBeenCalledTimes(1);
  });
});
