import { describe, expect, it, vi } from "vitest";
import { decodeAiSearchSearchResult, type AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";
import type { RetrievalRequest } from "@eliotr/retrieval";
import {
  AiSearchManagedReadError,
  compileAiSearchManagedSearchRequest,
  createAiSearchManagedSearchPort,
  type AiSearchManagedSearchAuthority,
  type AiSearchManagedSearchRequest,
} from "./ai-search-managed-read.js";
import { AI_SEARCH_RERANKING_MODEL } from "./ai-search-profile.js";
import { createManagedProjectProviderKey, managedProjectFolderPrefixV2 } from "./managed-project-path.js";
import { stableProjectionId } from "./canonical.js";
import type { AiSearchProjectCopyScope, AiSearchProjectCopyScopeV2 } from "./ai-search-scope-filter.js";

const FIXED_AT = "2026-09-08T00:00:00.000Z";

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} is missing from the fixture`);
  return value;
}

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
    target_profile_identity_sha256: "f".repeat(64),
    generation_metadata_value: "45d49371cb1a3d67e889021c98adb7fbb5cc051af29851cee3692dd1ef0299b4",
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

async function projectCopyScopeFor(
  request: RetrievalRequest,
  active: AiSearchManagedSearchAuthority,
  projectId = "project-1",
): Promise<AiSearchProjectCopyScope> {
  const copies = await Promise.all(request.scope_snapshot.member_source_revision_refs.map(async (sourceRevision) => {
    const membershipGeneration = 1;
    const key = await createManagedProjectProviderKey({
      instance_id: active.instance_id,
      projection_generation: active.index_generation,
      source_revision_ref: sourceRevision,
      project_id: projectId,
      project_membership_id: `project:${projectId}:generation:${membershipGeneration}`,
      membership_generation: membershipGeneration,
      item_key: `projection-${"a".repeat(48)}`,
    });
    return {
      source_revision_ref: sourceRevision,
      source_owner_generation: request.scope_snapshot.source_owner_generations[sourceRevision] ?? "owner-1",
      project_id: projectId,
      project_membership_id: key.project_membership_id,
      membership_generation: membershipGeneration,
      folder_prefix: key.folder_prefix,
    };
  }));
  return {
    layout: "PROJECT_COPY_V1",
    scope_snapshot_id: request.scope_snapshot.snapshot_id,
    scope_snapshot_revision: request.scope_snapshot.revision,
    scope_snapshot_digest: request.scope_snapshot.digest,
    target: {
      namespace: active.namespace,
      managed_instance_id: active.instance_id,
      managed_generation: active.index_generation,
      target_profile_identity_sha256: active.target_profile_identity_sha256,
    },
    generation_metadata_value: active.generation_metadata_value,
    representative_policy: "ONE_CANONICAL_COPY_PER_SOURCE_REVISION",
    copies,
  };
}

function projectCopyScopeResolver(
  projectId = "project-1",
) {
  return (request: RetrievalRequest, active: AiSearchManagedSearchAuthority) =>
    projectCopyScopeFor(request, active, projectId);
}

function providerChunk(
  id: string,
  section: string,
  score: number,
  rerankingScore: number,
  providerItemKey: string,
  sourceRevision = "revision-1",
  generationMetadataValue = "45d49371cb1a3d67e889021c98adb7fbb5cc051af29851cee3692dd1ef0299b4",
) {
  return {
    id,
    type: "text",
    score,
    text: "provider preview " + id,
    item: {
      key: providerItemKey,
      metadata: {
        canonical_section_id: section,
        content_sha256: "d".repeat(64),
        instruction_taint: "DATA_ONLY",
        projection_generation: generationMetadataValue,
        source_revision_ref: sourceRevision,
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

function providerKey(folderPrefix: string, ordinal: number): string {
  return `${folderPrefix}projection-${ordinal.toString(16).padStart(48, "0")}.md`;
}

describe("managed AI Search query reader", () => {
  it("V2 stable scope keeps its provider filter across aggregate membership churn", async () => {
    const request = retrievalRequest();
    const active = authority();
    const legacy = await projectCopyScopeFor(request, active);
    const base = required(legacy.copies[0], "project copy");
    const stableId = await stableProjectionId("project-membership", JSON.stringify([base.project_id, "source-1"]));
    const folder = await managedProjectFolderPrefixV2({
      instance_id: active.instance_id, projection_generation: active.index_generation,
      source_revision_ref: base.source_revision_ref, project_id: base.project_id,
      stable_project_membership_id: stableId, membership_revision: 7,
    });
    const scope: AiSearchProjectCopyScopeV2 = {
      ...legacy, layout: "PROJECT_COPY_V2",
      target_selection: {
        protocol: "eliotr.managed-target-selection.v2", domain: "MANAGED_SEARCH_PRODUCT",
        decision_version: 2, selection_mode: "STABLE_PHYSICAL_PROFILE_V2", product_alias: "primary", purpose: "ACTIVE",
        registry_revision: active.registry_revision, registry_artifact_sha256: active.registry_artifact_sha256,
        v1_exact_profile_identity_sha256: "e".repeat(64), target: legacy.target,
      },
      copies: [{ ...base, project_membership_id: stableId, stable_project_membership_id: stableId,
        membership_identity_version: 2, membership_revision: 7, project_membership_generation: 8, folder_prefix: folder }],
    };
    const stableCopy = required(scope.copies[0], "stable copy");
    if (stableCopy.membership_identity_version !== 2) throw new Error("fixture requires stable copy");
    const first = await compileAiSearchManagedSearchRequest(request, ["SEM", "LEX"], 0, active, scope);
    const next = await compileAiSearchManagedSearchRequest(request, ["SEM", "LEX"], 0, active, {
      ...scope, copies: [{ ...stableCopy, project_membership_generation: 900 }],
    });
    expect(next.ai_search_options.retrieval.filters).toEqual(first.ai_search_options.retrieval.filters);
    expect(first.ai_search_options.retrieval.filters.folder.$in).toEqual([folder]);
    await expect(compileAiSearchManagedSearchRequest(request, ["SEM"], 0, active, {
      ...scope, target_selection: { ...scope.target_selection, purpose: "SHADOW" },
    })).rejects.toMatchObject({ code: "AI_SEARCH_MANAGED_INPUT_INVALID" });
    await expect(compileAiSearchManagedSearchRequest(request, ["SEM"], 0, active, {
      ...scope, target_selection: { ...scope.target_selection, registry_revision: active.registry_revision + 1 },
    })).rejects.toMatchObject({ code: "AI_SEARCH_MANAGED_INPUT_INVALID" });
    await expect(compileAiSearchManagedSearchRequest(request, ["SEM"], 0, active, {
      ...scope, copies: [{ ...stableCopy, folder_prefix: base.folder_prefix }],
    })).rejects.toMatchObject({ code: "AI_SEARCH_MANAGED_INPUT_INVALID" });
  });

  it("V2 target selection retains an exact V1 row and rejects an unknown row identity version", async () => {
    const request = retrievalRequest();
    const active = authority();
    const legacy = await projectCopyScopeFor(request, active);
    const base = required(legacy.copies[0], "project copy");
    const scope: AiSearchProjectCopyScopeV2 = {
      ...legacy, layout: "PROJECT_COPY_V2",
      target_selection: {
        protocol: "eliotr.managed-target-selection.v2", domain: "MANAGED_SEARCH_PRODUCT",
        decision_version: 2, selection_mode: "STABLE_PHYSICAL_PROFILE_V2", product_alias: "primary", purpose: "ACTIVE",
        registry_revision: active.registry_revision, registry_artifact_sha256: active.registry_artifact_sha256,
        v1_exact_profile_identity_sha256: "e".repeat(64), target: legacy.target,
      },
      copies: [{ ...base, membership_identity_version: 1, legacy_project_membership_id: base.project_membership_id }],
    };
    const actual = await compileAiSearchManagedSearchRequest(request, ["SEM"], 0, active, scope);
    const old = await compileAiSearchManagedSearchRequest(request, ["SEM"], 0, active, legacy);
    expect(actual.ai_search_options.retrieval.filters).toEqual(old.ai_search_options.retrieval.filters);
    await expect(compileAiSearchManagedSearchRequest(request, ["SEM"], 0, active, {
      ...scope, copies: [{ ...base, membership_identity_version: 3 }],
    } as unknown as AiSearchProjectCopyScopeV2)).rejects.toMatchObject({ code: "AI_SEARCH_MANAGED_INPUT_INVALID" });
  });

  it("requests one hybrid list with an independent provider cap and plan-gated reranking", async () => {
    const request = retrievalRequest();
    const active = authority();
    const projectScope = await projectCopyScopeFor(request, active);
    const compiled = await compileAiSearchManagedSearchRequest(
      request,
      ["SEM"],
      1,
      active,
      projectScope,
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

    const directPlan = await compileAiSearchManagedSearchRequest(
      retrievalRequest({ product: "FAST_SEARCH" }),
      ["SEM"],
      0,
      authority(),
      await projectCopyScopeFor(retrievalRequest({ product: "FAST_SEARCH" }), authority()),
    );
    expect(directPlan.ai_search_options.reranking).toEqual({ enabled: false });

    const disabledProfile = await compileAiSearchManagedSearchRequest(
      retrievalRequest(),
      ["SEM"],
      1,
      authority({ reranking: false }),
      await projectCopyScopeFor(retrievalRequest(), authority({ reranking: false })),
    );
    expect(disabledProfile.ai_search_options.reranking).toEqual({ enabled: false });
  });

  it("preserves provider order and scores as one managed physical list", async () => {
    const request = retrievalRequest();
    const active = authority();
    const projectScope = await projectCopyScopeFor(request, active);
    const instanceSearch = vi.fn(async (_input: unknown) => ({
      query_kind: "text",
      search_query: "needle",
      chunks: [
        providerChunk("chunk-1", "section-1", 0.9, 0.91, providerKey(required(projectScope.copies[0], "project copy").folder_prefix, 1)),
        providerChunk("chunk-2", "section-2", 0.8, 0.81, providerKey(required(projectScope.copies[0], "project copy").folder_prefix, 2)),
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
    const port = createAiSearchManagedSearchPort(namespace, active, projectCopyScopeResolver());

    const candidates = await port.search(request, ["SEM"], 1);
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

  it("filters fifty cross-project duplicates before top-K and rejects a B folder returned to A", async () => {
    const base = retrievalRequest();
    const request = retrievalRequest({
      requested_limit: 2,
      budgets: retrievalBudgets(2),
      scope_snapshot: {
        ...base.scope_snapshot,
        member_source_revision_refs: ["revision-1", "revision-2"],
        source_owner_generations: {
          "revision-1": "owner-1",
          "revision-2": "owner-2",
        },
      },
    });
    const active = authority();
    const projectScope = await projectCopyScopeFor(request, active, "project-a");
    const aByRevision = new Map(projectScope.copies.map((copy) => [copy.source_revision_ref, copy]));
    const bDuplicates = await Promise.all(Array.from({ length: 50 }, async (_, index) => {
      const projectId = `project-b${index.toString().padStart(2, "0")}`;
      const key = await createManagedProjectProviderKey({
        instance_id: active.instance_id,
        projection_generation: active.index_generation,
        source_revision_ref: "revision-1",
        project_id: projectId,
        project_membership_id: `project:${projectId}:generation:1`,
        membership_generation: 1,
        item_key: `projection-${index.toString(16).padStart(48, "0")}`,
      });
      return providerChunk(`b-${index}`, "shared-section", 0.99, 0.99, key.provider_key);
    }));
    const aFirst = aByRevision.get("revision-1");
    const aSecond = aByRevision.get("revision-2");
    expect(aFirst).toBeDefined();
    expect(aSecond).toBeDefined();
    const documents = [
      ...bDuplicates,
      providerChunk("a-shared", "shared-section", 0.8, 0.8, providerKey(required(aFirst, "A revision-1 copy").folder_prefix, 100), "revision-1"),
      providerChunk("a-unique", "unique-section", 0.7, 0.7, providerKey(required(aSecond, "A revision-2 copy").folder_prefix, 101), "revision-2"),
    ];
    const search = vi.fn(async (input: AiSearchManagedSearchRequest) => {
      const folders = input.ai_search_options.retrieval.filters.folder.$in;
      const chunks = documents.filter((document) => {
        const key = document.item.key;
        return folders.includes(key.slice(0, key.lastIndexOf("/") + 1));
      }).slice(0, input.ai_search_options.retrieval.max_num_results);
      return { query_kind: "text", search_query: "needle", chunks };
    });
    const port = createAiSearchManagedSearchPort(
      { get: vi.fn(() => ({ search })) } as unknown as AiSearchNamespaceLike,
      active,
      projectCopyScopeResolver("project-a"),
    );

    const results = await port.search(request, ["SEM"], 0);
    const submitted = search.mock.calls[0]?.[0] as AiSearchManagedSearchRequest;
    expect(submitted.ai_search_options.retrieval.max_num_results).toBe(2);
    expect(submitted.ai_search_options.retrieval.filters.folder.$in)
      .toEqual(projectScope.copies.map((copy) => copy.folder_prefix).sort());
    expect(results.map((candidate) => candidate.metadata.provider_project_id)).toEqual(["project-a", "project-a"]);
    expect(results.map((candidate) => candidate.canonical_section_id)).toEqual(["shared-section", "unique-section"]);

    const bFolder = bDuplicates[0]?.item.key.slice(0, bDuplicates[0].item.key.lastIndexOf("/") + 1);
    expect(bFolder).toBeDefined();
    const malicious = createAiSearchManagedSearchPort(
      { get: vi.fn(() => ({ search: vi.fn(async () => ({
        query_kind: "text",
        search_query: "needle",
        chunks: [bDuplicates[0]],
      })) })) } as unknown as AiSearchNamespaceLike,
      active,
      projectCopyScopeResolver("project-a"),
    );
    await expect(malicious.search(request, ["SEM"], 0)).rejects.toMatchObject({
      code: "AI_SEARCH_MANAGED_PROVIDER_RESPONSE_INVALID",
    });
  });

  it("accepts flat keys only with an exact historical-generation fence and enforces the 128-byte key bound", () => {
    const request = retrievalRequest();
    const historical = {
      query_kind: "text",
      search_query: "needle",
      chunks: [{
        id: "historical-chunk",
        type: "text",
        score: 0.8,
        text: "legacy preview",
        item: {
          key: "legacy-flat-item.md",
          metadata: {
            canonical_section_id: "legacy-section",
            content_sha256: "d".repeat(64),
            instruction_taint: "DATA_ONLY",
            projection_generation: "historical-generation",
            source_revision_ref: "revision-1",
          },
        },
        scoring_details: { vector_score: 0.8 },
      }],
    };
    const legacyOptions = {
      expected_index_generation: "historical-generation",
      historical_generation: "historical-generation",
      project_copy_layout: "LEGACY_FLAT" as const,
      requested_lanes: ["SEM"] as const,
      max_results: 1,
      max_preview_bytes: 1024,
    };
    const historicalChunk = required(historical.chunks[0], "historical chunk");
    expect(decodeAiSearchSearchResult(request, historical, legacyOptions)[0]?.metadata.item_key)
      .toBe("legacy-flat-item");
    expect(() => decodeAiSearchSearchResult(request, historical, {
      ...legacyOptions,
      historical_generation: "another-generation",
    })).toThrow(/historical generation/u);
    expect(() => decodeAiSearchSearchResult(request, {
      ...historical,
      chunks: [{
        ...historicalChunk,
        item: { ...historicalChunk.item, key: `${"k".repeat(126)}.md` },
      }],
    }, {
      ...legacyOptions,
      historical_generation: "historical-generation",
    })).toThrow(/128/u);
  });

  it("honors the remaining candidate_limit before provider I/O and skips zero or invalid caps", async () => {
    const projectScope = await projectCopyScopeFor(retrievalRequest(), authority());
    const projectCopy = required(projectScope.copies[0], "project copy");
    const limitedSearch = vi.fn(async (_input: unknown) => ({
      query_kind: "text",
      search_query: "needle",
      chunks: [providerChunk("chunk-1", "section-1", 0.9, 0.91,
        providerKey(projectCopy.folder_prefix, 1))],
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
      projectCopyScopeResolver(),
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
      projectCopyScopeResolver(),
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
    const port = createAiSearchManagedSearchPort(namespace, authority(), projectCopyScopeResolver());
    expect(await port.search(empty, ["SEM"], 0)).toEqual([]);
    expect(get).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();

    let capabilityError: unknown;
    try {
      await compileAiSearchManagedSearchRequest(
        retrievalRequest(),
        ["SEM"],
        0,
        authority({
          index_method: { vector: false, keyword: true },
        }),
        await projectCopyScopeFor(retrievalRequest(), authority({ index_method: { vector: false, keyword: true } })),
      );
    } catch (error) {
      capabilityError = error;
    }
    expect(capabilityError).toBeInstanceOf(AiSearchManagedReadError);
    expect(capabilityError).toMatchObject({ code: "AI_SEARCH_MANAGED_CAPABILITY_UNAVAILABLE" });
  });
});
