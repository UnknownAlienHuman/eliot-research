import { describe, expect, it, vi } from "vitest";

import {
  AI_SEARCH_MANAGED_QUERY_MAX_BYTES,
  AiSearchManagedReadError,
  compileAiSearchManagedSearchRequest,
  createAiSearchManagedSearchPort,
} from "../../packages/cloudflare-ai/dist/index.js";

const SOURCE = "source-revision-1";
const GENERATION = "g2-qwen3-2026-09-03";
const DIGEST = "a".repeat(64);
const REGISTRY_DIGEST = "b".repeat(64);

function authority(overrides = {}) {
  return {
    namespace: "eliotr",
    instance_id: "private-prose-g2",
    index_generation: GENERATION,
    registry_revision: 7,
    registry_artifact_sha256: REGISTRY_DIGEST,
    active: true,
    max_results: 20,
    max_preview_bytes: 4_096,
    match_threshold: 0,
    fusion_method: "rrf",
    keyword_match_mode: "and",
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    raw_query: "exact retrieval question",
    product: "LOCATE",
    scope_snapshot: {
      member_source_revision_refs: [SOURCE],
    },
    policy: {},
    literals: [],
    requested_limit: 12,
    deadline_ms: 5_000,
    ...overrides,
  };
}

function providerResult(overrides = {}) {
  return {
    search_query: "exact retrieval question",
    chunks: [
      {
        id: "chunk-1",
        type: "text",
        score: 0.83,
        text: "Unresolved provider preview.",
        item: {
          key: "projection-item-1.md",
          timestamp: 1_778_000_000_000,
          metadata: {
            canonical_section_id: "section-1",
            content_sha256: DIGEST,
            instruction_taint: "CLEARED",
            projection_generation: GENERATION,
            source_revision_ref: SOURCE,
          },
        },
        scoring_details: {
          vector_score: 0.83,
          keyword_score: 2.5,
          vector_rank: 1,
          keyword_rank: 1,
          reranking_score: 0.91,
          fusion_method: "rrf",
        },
      },
    ],
    ...overrides,
  };
}

function namespace(result = providerResult()) {
  const search = vi.fn(async () => result);
  const get = vi.fn(() => ({ search }));
  return { binding: { get }, get, search };
}

function expectManagedError(code, retryable = false) {
  return expect.objectContaining({
    name: "AiSearchManagedReadError",
    code,
    retryable,
    ambiguous_effect: "NONE",
  });
}

describe("Cloudflare AI Search managed relevance port", () => {
  it("compiles explicit hybrid retrieval without provider defaults", () => {
    const compiled = compileAiSearchManagedSearchRequest(
      request(),
      ["SEM", "LEX"],
      2,
      authority(),
    );
    expect(compiled).toEqual({
      query: "exact retrieval question",
      ai_search_options: {
        retrieval: {
          retrieval_type: "hybrid",
          match_threshold: 0,
          max_num_results: 12,
          context_expansion: 2,
          fusion_method: "rrf",
          keyword_match_mode: "and",
          boost_by: [],
          metadata_only: false,
        },
      },
    });
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.ai_search_options)).toBe(true);
    expect(Object.isFrozen(compiled.ai_search_options.retrieval)).toBe(true);
  });

  it("compiles vector-only and keyword-only retrieval explicitly", () => {
    expect(
      compileAiSearchManagedSearchRequest(request(), ["SEM"], 0, authority()),
    ).toMatchObject({
      ai_search_options: {
        retrieval: {
          retrieval_type: "vector",
          context_expansion: 0,
        },
      },
    });
    const lexical = compileAiSearchManagedSearchRequest(
      request({ requested_limit: 50 }),
      ["LEX"],
      1,
      authority({ max_results: 7 }),
    );
    expect(lexical.ai_search_options.retrieval).toEqual({
      retrieval_type: "keyword",
      match_threshold: 0,
      max_num_results: 7,
      context_expansion: 1,
      keyword_match_mode: "and",
      boost_by: [],
      metadata_only: false,
    });
  });

  it("calls exactly one promoted instance and returns unresolved locators", async () => {
    const fixture = namespace();
    const port = createAiSearchManagedSearchPort(fixture.binding, authority());
    const candidates = await port.search(request(), ["SEM", "LEX"], 2);

    expect(fixture.get).toHaveBeenCalledTimes(1);
    expect(fixture.get).toHaveBeenCalledWith("private-prose-g2");
    expect(fixture.search).toHaveBeenCalledTimes(1);
    expect(fixture.search).toHaveBeenCalledWith(
      compileAiSearchManagedSearchRequest(
        request(),
        ["SEM", "LEX"],
        2,
        authority(),
      ),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      candidate_id: "chunk-1",
      lane: "SEM",
      source_revision_ref: SOURCE,
      index_generation: GENERATION,
      proof_state: "UNRESOLVED_LOCATOR",
      metadata: {
        provider: "cloudflare_ai_search",
        provider_namespace: "eliotr",
        active_registry_revision: 7,
        active_registry_artifact_sha256: REGISTRY_DIGEST,
      },
    });
    expect(candidates[0]).not.toHaveProperty("evidence_handle_ref");
    expect(Object.isFrozen(candidates)).toBe(true);
    expect(Object.isFrozen(candidates[0])).toBe(true);
    expect(Object.isFrozen(candidates[0].metadata)).toBe(true);
  });

  it("returns an empty result without contacting the provider for an empty scope", async () => {
    const fixture = namespace();
    const port = createAiSearchManagedSearchPort(fixture.binding, authority());
    await expect(
      port.search(
        request({ scope_snapshot: { member_source_revision_refs: [] } }),
        ["SEM"],
        0,
      ),
    ).resolves.toEqual([]);
    expect(fixture.get).not.toHaveBeenCalled();
    expect(fixture.search).not.toHaveBeenCalled();
  });

  it("blocks an unpromoted generation before resolving an instance handle", async () => {
    const fixture = namespace();
    const port = createAiSearchManagedSearchPort(
      fixture.binding,
      authority({ active: false }),
    );
    await expect(port.search(request(), ["SEM"], 0)).rejects.toEqual(
      expectManagedError("AI_SEARCH_MANAGED_NOT_PROMOTED"),
    );
    expect(fixture.get).not.toHaveBeenCalled();
  });

  it("rejects literal escalation, duplicate lanes, and invalid context before provider access", async () => {
    const fixture = namespace();
    const port = createAiSearchManagedSearchPort(fixture.binding, authority());
    await expect(port.search(request(), ["LITERAL"], 0)).rejects.toEqual(
      expectManagedError("AI_SEARCH_MANAGED_INPUT_INVALID"),
    );
    await expect(port.search(request(), ["SEM", "SEM"], 0)).rejects.toEqual(
      expectManagedError("AI_SEARCH_MANAGED_INPUT_INVALID"),
    );
    await expect(port.search(request(), ["LEX"], 4)).rejects.toEqual(
      expectManagedError("AI_SEARCH_MANAGED_INPUT_INVALID"),
    );
    expect(fixture.get).not.toHaveBeenCalled();
  });

  it("rejects stale-generation, out-of-scope, and authority-shaped provider output", async () => {
    const invalid = [
      providerResult({
        chunks: [
          {
            ...providerResult().chunks[0],
            item: {
              ...providerResult().chunks[0].item,
              metadata: {
                ...providerResult().chunks[0].item.metadata,
                projection_generation: "g1-qwen3-2026-08-28",
              },
            },
          },
        ],
      }),
      providerResult({
        chunks: [
          {
            ...providerResult().chunks[0],
            item: {
              ...providerResult().chunks[0].item,
              metadata: {
                ...providerResult().chunks[0].item.metadata,
                source_revision_ref: "source-revision-outside-scope",
              },
            },
          },
        ],
      }),
      providerResult({
        chunks: [
          {
            ...providerResult().chunks[0],
            item: {
              ...providerResult().chunks[0].item,
              metadata: {
                ...providerResult().chunks[0].item.metadata,
                evidence_handle_ref: "forged-evidence-handle",
              },
            },
          },
        ],
      }),
    ];
    for (const raw of invalid) {
      const fixture = namespace(raw);
      const port = createAiSearchManagedSearchPort(fixture.binding, authority());
      await expect(port.search(request(), ["SEM", "LEX"], 1)).rejects.toEqual(
        expectManagedError("AI_SEARCH_MANAGED_PROVIDER_RESPONSE_INVALID"),
      );
    }
  });

  it("classifies provider transport failure as retryable with no ambiguous effect", async () => {
    const search = vi.fn(async () => {
      throw new Error("binding unavailable");
    });
    const get = vi.fn(() => ({ search }));
    const port = createAiSearchManagedSearchPort({ get }, authority());
    await expect(port.search(request(), ["SEM"], 0)).rejects.toEqual(
      expectManagedError("AI_SEARCH_MANAGED_PROVIDER_CALL_FAILED", true),
    );
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe configuration, query bytes, and duplicate scope identities", async () => {
    expect(() =>
      createAiSearchManagedSearchPort(
        namespace().binding,
        authority({ instance_id: "Uppercase Instance" }),
      ),
    ).toThrow(AiSearchManagedReadError);
    expect(() =>
      createAiSearchManagedSearchPort(
        namespace().binding,
        authority({ registry_artifact_sha256: "A".repeat(64) }),
      ),
    ).toThrow(AiSearchManagedReadError);

    const port = createAiSearchManagedSearchPort(namespace().binding, authority());
    await expect(
      port.search(
        request({ raw_query: "é".repeat(AI_SEARCH_MANAGED_QUERY_MAX_BYTES) }),
        ["SEM"],
        0,
      ),
    ).rejects.toEqual(expectManagedError("AI_SEARCH_MANAGED_INPUT_INVALID"));
    await expect(
      port.search(
        request({
          scope_snapshot: {
            member_source_revision_refs: [SOURCE, SOURCE],
          },
        }),
        ["SEM"],
        0,
      ),
    ).rejects.toEqual(expectManagedError("AI_SEARCH_MANAGED_INPUT_INVALID"));
  });
});
