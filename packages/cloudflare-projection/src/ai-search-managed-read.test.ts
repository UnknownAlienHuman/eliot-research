import { describe, expect, it, vi } from "vitest";
import type { AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";
import type { RetrievalRequest } from "@eliotr/retrieval";
import {
  AiSearchManagedReadError,
  compileAiSearchManagedSearchRequest,
  createAiSearchManagedSearchPort,
  type AiSearchManagedSearchAuthority,
  type AiSearchManagedSearchRequest,
} from "./ai-search-managed-read.js";
import { AI_SEARCH_RERANKING_MODEL } from "./ai-search-profile.js";

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
    requested_limit: 1,
    deadline_ms: 1_000,
    ...overrides,
  };
}

function retrievalBudgets(candidate_limit: number) {
  return {
    candidate_limit,
    scan_limit: 1,
    evidence_limit: 1,
    max_evidence_bytes: 1_024,
  };
}

function authority(
  overrides: Partial<AiSearchManagedSearchAuthority> = {},
): AiSearchManagedSearchAuthority {
  return {
    namespace: "eliot",
    instance_id: "eliot-hybrid",
    index_generation: "index-1",
    registry_revision: 1,
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
  section: string,
  score: number,
  rerankingScore: number,
) {
  return {
    id,
    type: "text",
    score,
    text: "provider preview " + id,
    item: {
      key: id + ".md",
      metadata: {
        canonical_section_id: section,
        content_sha256: "d".repeat(64),
        instruction_taint: "DATA_ONLY",
        projection_generation: "index-1",
        source_revision_ref: "revision-1",
      },
    },
    scoring_details: {
      fusion_method: "rrf",
      keyword_rank: score > 0.85 ? 1 : 2,
      keyword_score: score,
      vector_rank: score > 0.85 ? 1 : 2,
      vector_score: score,
      reranking_score: rerankingScore,
    },
  };
}

describe("managed AI Search query reader", () => {
  it("requests one hybrid list with an independent provider cap and plan-gated reranking", () => {
    const compiled = compileAiSearchManagedSearchRequest(
      retrievalRequest(),
      ["SEM"],
      1,
      authority(),
    );
    expect(compiled.ai_search_options.retrieval.retrieval_type).toBe("hybrid");
    expect(compiled.ai_search_options.retrieval.fusion_method).toBe("rrf");
    expect(compiled.ai_search_options.retrieval.max_num_results).toBe(50);
    expect(compiled.ai_search_options.retrieval.return_on_failure).toBe(false);
    expect(compiled.ai_search_options.query_rewrite).toEqual({ enabled: false });
    expect(compiled.ai_search_options.cache).toEqual({ enabled: false });
    expect(compiled.ai_search_options.reranking).toEqual({
      enabled: true,
      model: AI_SEARCH_RERANKING_MODEL,
    });

    const directPlan = compileAiSearchManagedSearchRequest(
      retrievalRequest({ product: "FAST_SEARCH" }),
      ["SEM"],
      0,
      authority(),
    );
    expect(directPlan.ai_search_options.reranking).toEqual({ enabled: false });

    const disabledProfile = compileAiSearchManagedSearchRequest(
      retrievalRequest(),
      ["SEM"],
      1,
      authority({ reranking: false }),
    );
    expect(disabledProfile.ai_search_options.reranking).toEqual({ enabled: false });
  });

  it("preserves provider order and scores as one managed physical list", async () => {
    const instanceSearch = vi.fn(async (_input: unknown) => ({
      query_kind: "text",
      search_query: "needle",
      chunks: [
        providerChunk("chunk-1", "section-1", 0.9, 0.91),
        providerChunk("chunk-2", "section-2", 0.8, 0.81),
      ],
    }));
    const get = vi.fn(() => ({
      search: instanceSearch,
      items: {
        createOrUpdate: vi.fn(),
        uploadAndPoll: vi.fn(),
        delete: vi.fn(),
        get: vi.fn(),
      },
    }));
    const namespace = { get } as unknown as AiSearchNamespaceLike;
    const port = createAiSearchManagedSearchPort(namespace, authority());

    const candidates = await port.search(retrievalRequest(), ["SEM"], 1);
    const submitted = instanceSearch.mock.calls[0]?.[0] as AiSearchManagedSearchRequest;

    expect(instanceSearch).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(submitted.ai_search_options.retrieval.retrieval_type).toBe("hybrid");
    expect(submitted.ai_search_options.retrieval.max_num_results).toBe(50);
    expect(submitted.ai_search_options.retrieval.return_on_failure).toBe(false);
    expect(submitted.ai_search_options.query_rewrite).toEqual({ enabled: false });
    expect(submitted.ai_search_options.cache).toEqual({ enabled: false });
    expect(candidates.map((candidate) => candidate.rank)).toEqual([1, 2]);
    expect(candidates.map((candidate) => candidate.lane)).toEqual(["SEM", "SEM"]);
    expect(candidates[0]?.metadata).toMatchObject({
      provider_submitted_query: "needle",
      provider_retrieval_type: "hybrid",
      provider_rerank_requested: true,
      provider_rerank_enabled: true,
      provider_rerank_succeeded: true,
      provider_rerank_model: AI_SEARCH_RERANKING_MODEL,
      provider_keyword_rank: 1,
      provider_vector_rank: 1,
      provider_reranking_score: 0.91,
    });
  });

  it("honors the remaining candidate_limit before provider I/O and skips zero or invalid caps", async () => {
    const limitedSearch = vi.fn(async (_input: unknown) => ({
      query_kind: "text",
      search_query: "needle",
      chunks: [providerChunk("chunk-1", "section-1", 0.9, 0.91)],
    }));
    const limitedGet = vi.fn(() => ({
      search: limitedSearch,
      items: {
        createOrUpdate: vi.fn(),
        uploadAndPoll: vi.fn(),
        delete: vi.fn(),
        get: vi.fn(),
      },
    }));
    const limitedPort = createAiSearchManagedSearchPort(
      { get: limitedGet } as unknown as AiSearchNamespaceLike,
      authority(),
    );
    const limitedCandidates = await limitedPort.search(
      retrievalRequest({ budgets: retrievalBudgets(1) }),
      ["SEM"],
      1,
    );
    const limitedRequest = limitedSearch.mock.calls[0]?.[0] as AiSearchManagedSearchRequest;
    expect(limitedRequest.ai_search_options.retrieval.max_num_results).toBe(1);
    expect(limitedCandidates).toHaveLength(1);
    expect(limitedGet).toHaveBeenCalledTimes(1);

    const noBudgetSearch = vi.fn(async () => ({ chunks: [], query_kind: "text", search_query: "needle" }));
    const noBudgetGet = vi.fn(() => ({
      search: noBudgetSearch,
      items: {
        createOrUpdate: vi.fn(),
        uploadAndPoll: vi.fn(),
        delete: vi.fn(),
        get: vi.fn(),
      },
    }));
    const noBudgetPort = createAiSearchManagedSearchPort(
      { get: noBudgetGet } as unknown as AiSearchNamespaceLike,
      authority(),
    );
    expect(await noBudgetPort.search(
      retrievalRequest({ budgets: retrievalBudgets(0) }),
      ["SEM"],
      1,
    )).toEqual([]);
    expect(noBudgetGet).not.toHaveBeenCalled();
    expect(noBudgetSearch).not.toHaveBeenCalled();

    await expect(noBudgetPort.search(
      retrievalRequest({ budgets: retrievalBudgets(513) }),
      ["SEM"],
      1,
    )).rejects.toMatchObject({ code: "AI_SEARCH_MANAGED_INPUT_INVALID" });
    expect(noBudgetGet).not.toHaveBeenCalled();
    expect(noBudgetSearch).not.toHaveBeenCalled();
  });

  it("does not call the provider for empty scope and reports missing SEM capability as unavailable", async () => {
    const search = vi.fn(async () => ({ chunks: [], query_kind: "text", search_query: "needle" }));
    const get = vi.fn(() => ({
      search,
      items: {
        createOrUpdate: vi.fn(),
        uploadAndPoll: vi.fn(),
        delete: vi.fn(),
        get: vi.fn(),
      },
    }));
    const namespace = { get } as unknown as AiSearchNamespaceLike;
    const empty = retrievalRequest({
      scope_snapshot: {
        ...retrievalRequest().scope_snapshot,
        member_source_revision_refs: [],
        source_owner_generations: {},
      },
    });
    const port = createAiSearchManagedSearchPort(namespace, authority());
    expect(await port.search(empty, ["SEM"], 0)).toEqual([]);
    expect(get).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();

    let capabilityError: unknown;
    try {
      compileAiSearchManagedSearchRequest(
        retrievalRequest(),
        ["SEM"],
        0,
        authority({
          index_method: { vector: false, keyword: true },
        }),
      );
    } catch (error) {
      capabilityError = error;
    }
    expect(capabilityError).toBeInstanceOf(AiSearchManagedReadError);
    expect(capabilityError).toMatchObject({ code: "AI_SEARCH_MANAGED_CAPABILITY_UNAVAILABLE" });
  });
});
