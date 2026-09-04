import { describe, expect, it, vi } from "vitest";

import {
  AI_SEARCH_CUSTOM_METADATA_FIELDS,
  AI_SEARCH_MANAGED_QUERY_MAX_BYTES,
  AiSearchManagedReadError,
  aiSearchGenerationRegistryArtifactDigest,
  buildAiSearchGenerationRegistryArtifact,
  compileAiSearchManagedSearchRequest,
  createAiSearchManagedSearchPort,
  createRegistryBackedAiSearchManagedSearchPort,
  resolveAiSearchManagedSearchAuthority,
} from "../../packages/cloudflare-ai/dist/index.js";

const SOURCE = "source-revision-1";
const GENERATION = "g2-qwen3-2026-09-03";
const DIGEST = "a".repeat(64);
const REGISTRY_DIGEST = "b".repeat(64);
const T0 = "2026-09-04T04:00:00.000Z";
const T1 = "2026-09-04T04:01:00.000Z";
const T2 = "2026-09-04T04:02:00.000Z";
const POLICY = Object.freeze({
  expected_namespace: "eliotr",
  max_preview_bytes: 4_096,
  match_threshold: 0,
});

function authority(overrides = {}) {
  return {
    namespace: "eliotr",
    instance_id: "private-prose-g2",
    index_generation: GENERATION,
    registry_revision: 7,
    registry_artifact_sha256: REGISTRY_DIGEST,
    active: true,
    index_method: { vector: true, keyword: true },
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
    scope_snapshot: { member_source_revision_refs: [SOURCE] },
    policy: {},
    literals: [],
    requested_limit: 12,
    deadline_ms: 5_000,
    ...overrides,
  };
}

function profile(generation, id, kind = "hybrid") {
  const vector = kind !== "keyword";
  const keyword = kind !== "vector";
  return {
    id,
    generation,
    index_method: { vector, keyword },
    ...(vector && keyword ? { fusion_method: "rrf" } : {}),
    ...(keyword
      ? { keyword_tokenizer: "porter", keyword_match_mode: "and" }
      : {}),
    ...(vector ? { embedding_model: "@cf/qwen/qwen3-embedding-0.6b" } : {}),
    reranking: vector,
    max_num_results: 20,
    metadata_fields: [...AI_SEARCH_CUSTOM_METADATA_FIELDS],
  };
}

function generationRecord(
  generation,
  id,
  kind = "hybrid",
  state = "ACTIVE",
) {
  return {
    namespace: "eliotr",
    generation,
    profile: profile(generation, id, kind),
    state,
    expected_item_count: 1,
    indexed_item_count: state === "SHADOW_BUILDING" ? 0 : 1,
    readback_item_count: state === "SHADOW_BUILDING" ? 0 : 1,
    failed_item_count: 0,
    mismatch_count: 0,
    ...(state === "SHADOW_BUILDING"
      ? {}
      : { golden_set_result_ref: `golden-${generation}`, observed_at: T1 }),
    declared_at: T0,
    ...(state === "ACTIVE" ? { activated_at: T2 } : {}),
  };
}

async function registrySnapshot({
  generation = GENERATION,
  instanceId = "private-prose-g2",
  kind = "hybrid",
  revision = 7,
  active = true,
  extra = [],
} = {}) {
  const record = generationRecord(
    generation,
    instanceId,
    kind,
    active ? "ACTIVE" : "SHADOW_COMPLETE",
  );
  const registry = {
    active_head_generation: active ? generation : null,
    generations: [record, ...extra],
  };
  const artifact = buildAiSearchGenerationRegistryArtifact(
    "eliotr",
    revision,
    registry,
  );
  return Object.freeze({
    artifact,
    artifact_sha256:
      await aiSearchGenerationRegistryArtifactDigest(artifact),
  });
}

function providerResult(generation = GENERATION, overrides = {}) {
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
            projection_generation: generation,
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

function registrySequence(values) {
  let cursor = 0;
  const read = vi.fn(async () => {
    const value = values[Math.min(cursor, values.length - 1)];
    cursor += 1;
    if (value instanceof Error) throw value;
    return value;
  });
  return { service: { read }, read };
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

  it("enforces the active profile's vector and keyword capabilities", () => {
    const vector = authority({
      index_method: { vector: true, keyword: false },
      fusion_method: undefined,
      keyword_match_mode: undefined,
    });
    expect(
      compileAiSearchManagedSearchRequest(request(), ["SEM"], 0, vector),
    ).toMatchObject({
      ai_search_options: { retrieval: { retrieval_type: "vector" } },
    });
    expect(() =>
      compileAiSearchManagedSearchRequest(request(), ["LEX"], 0, vector),
    ).toThrow(/does not support lane LEX/u);

    const keyword = authority({
      index_method: { vector: false, keyword: true },
      fusion_method: undefined,
      max_results: 7,
    });
    expect(
      compileAiSearchManagedSearchRequest(
        request({ requested_limit: 50 }),
        ["LEX"],
        1,
        keyword,
      ).ai_search_options.retrieval,
    ).toEqual({
      retrieval_type: "keyword",
      match_threshold: 0,
      max_num_results: 7,
      context_expansion: 1,
      keyword_match_mode: "and",
      boost_by: [],
      metadata_only: false,
    });
    expect(() =>
      compileAiSearchManagedSearchRequest(request(), ["SEM"], 0, keyword),
    ).toThrow(/does not support lane SEM/u);
  });

  it("calls exactly one promoted instance and returns unresolved locators", async () => {
    const fixture = namespace();
    const port = createAiSearchManagedSearchPort(fixture.binding, authority());
    const candidates = await port.search(request(), ["SEM", "LEX"], 2);

    expect(fixture.get).toHaveBeenCalledTimes(1);
    expect(fixture.get).toHaveBeenCalledWith("private-prose-g2");
    expect(fixture.search).toHaveBeenCalledTimes(1);
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
    const base = providerResult().chunks[0];
    const invalid = [
      providerResult("g1-qwen3-2026-08-28"),
      providerResult(GENERATION, {
        chunks: [{
          ...base,
          item: {
            ...base.item,
            metadata: {
              ...base.item.metadata,
              source_revision_ref: "source-revision-outside-scope",
            },
          },
        }],
      }),
      providerResult(GENERATION, {
        chunks: [{
          ...base,
          item: {
            ...base.item,
            metadata: {
              ...base.item.metadata,
              evidence_handle_ref: "forged-evidence-handle",
            },
          },
        }],
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
        authority({ index_method: { vector: false, keyword: false } }),
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

  it("derives immutable routing authority from an exact active registry snapshot", async () => {
    const snapshot = await registrySnapshot();
    const resolved = await resolveAiSearchManagedSearchAuthority(
      snapshot,
      POLICY,
    );
    expect(resolved).toEqual({
      namespace: "eliotr",
      instance_id: "private-prose-g2",
      index_generation: GENERATION,
      registry_revision: 7,
      registry_artifact_sha256: snapshot.artifact_sha256,
      active: true,
      index_method: { vector: true, keyword: true },
      max_results: 20,
      max_preview_bytes: 4_096,
      match_threshold: 0,
      fusion_method: "rrf",
      keyword_match_mode: "and",
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.index_method)).toBe(true);
  });

  it("preserves keyword-only capability from the active registry record", async () => {
    const snapshot = await registrySnapshot({
      generation: "literal-g1",
      instanceId: "private-literal-g1",
      kind: "keyword",
    });
    const resolved = await resolveAiSearchManagedSearchAuthority(
      snapshot,
      POLICY,
    );
    expect(resolved).toMatchObject({
      instance_id: "private-literal-g1",
      index_method: { vector: false, keyword: true },
      keyword_match_mode: "and",
    });
    expect(resolved).not.toHaveProperty("fusion_method");
    expect(() =>
      compileAiSearchManagedSearchRequest(request(), ["SEM"], 0, resolved),
    ).toThrow(/does not support lane SEM/u);
  });

  it("rejects a corrupted registry digest and a registry without an active head", async () => {
    const valid = await registrySnapshot();
    await expect(
      resolveAiSearchManagedSearchAuthority(
        { ...valid, artifact_sha256: "0".repeat(64) },
        POLICY,
      ),
    ).rejects.toEqual(
      expectManagedError("AI_SEARCH_MANAGED_REGISTRY_INVALID"),
    );
    await expect(
      resolveAiSearchManagedSearchAuthority(
        await registrySnapshot({ active: false }),
        POLICY,
      ),
    ).rejects.toEqual(
      expectManagedError("AI_SEARCH_MANAGED_NOT_PROMOTED"),
    );
  });

  it("reads registry authority before and after provider retrieval", async () => {
    const before = await registrySnapshot({ revision: 7 });
    const after = await registrySnapshot({ revision: 8 });
    const registry = registrySequence([before, after]);
    const fixture = namespace();
    const port = createRegistryBackedAiSearchManagedSearchPort(
      registry.service,
      fixture.binding,
      POLICY,
    );
    const candidates = await port.search(request(), ["SEM"], 0);

    expect(registry.read).toHaveBeenCalledTimes(2);
    expect(registry.read).toHaveBeenNthCalledWith(1, "eliotr");
    expect(registry.read).toHaveBeenNthCalledWith(2, "eliotr");
    expect(fixture.get).toHaveBeenCalledWith("private-prose-g2");
    expect(candidates[0]?.metadata).toMatchObject({
      active_registry_revision: 7,
      active_registry_artifact_sha256: before.artifact_sha256,
    });
  });

  it("discards provider output when the active head rotates during retrieval", async () => {
    const before = await registrySnapshot({
      generation: "g1-qwen3-2026-08-28",
      instanceId: "private-prose-g1",
      revision: 1,
    });
    const after = await registrySnapshot({
      generation: GENERATION,
      instanceId: "private-prose-g2",
      revision: 2,
    });
    const registry = registrySequence([before, after]);
    const fixture = namespace(providerResult("g1-qwen3-2026-08-28"));
    const port = createRegistryBackedAiSearchManagedSearchPort(
      registry.service,
      fixture.binding,
      POLICY,
    );

    await expect(port.search(request(), ["SEM"], 0)).rejects.toEqual(
      expectManagedError("AI_SEARCH_MANAGED_REGISTRY_CHANGED", true),
    );
    expect(fixture.get).toHaveBeenCalledWith("private-prose-g1");
    expect(fixture.search).toHaveBeenCalledTimes(1);
    expect(registry.read).toHaveBeenCalledTimes(2);
  });

  it("fails before provider access when registry authority is absent or unreadable", async () => {
    for (const value of [null, new Error("SEARCH_DB unavailable")]) {
      const registry = registrySequence([value]);
      const fixture = namespace();
      const port = createRegistryBackedAiSearchManagedSearchPort(
        registry.service,
        fixture.binding,
        POLICY,
      );
      await expect(port.search(request(), ["SEM"], 0)).rejects.toEqual(
        value === null
          ? expectManagedError("AI_SEARCH_MANAGED_NOT_PROMOTED")
          : expectManagedError("AI_SEARCH_MANAGED_REGISTRY_READ_FAILED", true),
      );
      expect(fixture.get).not.toHaveBeenCalled();
      expect(fixture.search).not.toHaveBeenCalled();
    }
  });
});
