import { describe, expect, it } from "vitest";

import {
  AI_SEARCH_CUSTOM_METADATA_FIELDS,
  AiSearchGenerationError,
  assertAiSearchGenerationIsolation,
  assertImmutableAiSearchProfile,
  declareAiSearchGeneration,
  promoteAiSearchGeneration,
  recordAiSearchShadowObservation,
  validateAiSearchGenerationRegistry,
} from "../../packages/cloudflare-ai/dist/index.js";

const timestamp = "2026-09-02T12:00:00.000Z";

function profile(overrides = {}) {
  return {
    id: "search-instance-g2",
    generation: "embedding-g2",
    index_method: { vector: true, keyword: true },
    fusion_method: "rrf",
    keyword_tokenizer: "porter",
    keyword_match_mode: "or",
    embedding_model: "@cf/baai/bge-m3",
    reranking: true,
    max_num_results: 20,
    metadata_fields: [...AI_SEARCH_CUSTOM_METADATA_FIELDS],
    ...overrides,
  };
}

function declared(overrides = {}) {
  return {
    namespace: "eliotr-production",
    generation: "embedding-g2",
    profile: profile(),
    state: "DECLARED",
    expected_item_count: 2,
    indexed_item_count: 0,
    readback_item_count: 0,
    failed_item_count: 0,
    mismatch_count: 0,
    declared_at: timestamp,
    ...overrides,
  };
}

function complete(overrides = {}) {
  return {
    ...declared(),
    state: "SHADOW_COMPLETE",
    indexed_item_count: 2,
    readback_item_count: 2,
    golden_set_result_ref: "golden-result-g2",
    observed_at: timestamp,
    ...overrides,
  };
}

function expectCode(fn, code) {
  expect(fn).toThrow(AiSearchGenerationError);
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AiSearchGenerationError);
    expect(error.code).toBe(code);
  }
}

describe("ER-16 AI Search generation lifecycle", () => {
  it("admits an exact existing immutable profile independent of metadata order", () => {
    const desired = profile();
    const existing = profile({
      metadata_fields: [...desired.metadata_fields].reverse(),
    });
    expect(() => assertImmutableAiSearchProfile(existing, desired)).not.toThrow();
  });

  it("fails before mutation when the existing embedding model differs", () => {
    expectCode(
      () =>
        assertImmutableAiSearchProfile(
          profile({ embedding_model: "@cf/baai/bge-base-en-v1.5" }),
          profile(),
        ),
      "AI_SEARCH_PROFILE_IMMUTABLE_MISMATCH",
    );
  });

  it("rejects invalid hybrid and metadata profiles", () => {
    expectCode(
      () =>
        declareAiSearchGeneration([], {
          namespace: "eliotr-production",
          profile: profile({ fusion_method: undefined }),
          expected_item_count: 2,
          declared_at: timestamp,
        }),
      "AI_SEARCH_PROFILE_INVALID",
    );
    expectCode(
      () =>
        declareAiSearchGeneration([], {
          namespace: "eliotr-production",
          profile: profile({
            metadata_fields: ["source_revision_ref", "source_revision_ref"],
          }),
          expected_item_count: 2,
          declared_at: timestamp,
        }),
      "AI_SEARCH_PROFILE_INVALID",
    );
    expectCode(
      () =>
        declareAiSearchGeneration([], {
          namespace: "eliotr-production",
          profile: profile({ id: "Uppercase-Instance" }),
          expected_item_count: 2,
          declared_at: timestamp,
        }),
      "AI_SEARCH_PROFILE_INVALID",
    );
  });

  it("declares shadow state without advertising completeness", () => {
    expect(
      declareAiSearchGeneration([profile()], {
        namespace: "eliotr-production",
        profile: profile(),
        expected_item_count: 2,
        declared_at: timestamp,
      }),
    ).toEqual(declared());
  });

  it("keeps partial progress in SHADOW_BUILDING", () => {
    const next = recordAiSearchShadowObservation(declared(), {
      generation: "embedding-g2",
      indexed_item_count: 1,
      readback_item_count: 1,
      failed_item_count: 0,
      mismatch_count: 0,
      observed_at: timestamp,
    });
    expect(next.state).toBe("SHADOW_BUILDING");
    expect(next.golden_set_result_ref).toBeUndefined();
  });

  it("requires exact readback and a retained golden result for completion", () => {
    const withoutGolden = recordAiSearchShadowObservation(declared(), {
      generation: "embedding-g2",
      indexed_item_count: 2,
      readback_item_count: 2,
      failed_item_count: 0,
      mismatch_count: 0,
      observed_at: timestamp,
    });
    expect(withoutGolden.state).toBe("SHADOW_BUILDING");

    const next = recordAiSearchShadowObservation(withoutGolden, {
      generation: "embedding-g2",
      indexed_item_count: 2,
      readback_item_count: 2,
      failed_item_count: 0,
      mismatch_count: 0,
      golden_set_result_ref: "golden-result-g2",
      observed_at: "2026-09-02T12:01:00.000Z",
    });
    expect(next).toEqual(
      complete({ observed_at: "2026-09-02T12:01:00.000Z" }),
    );
  });

  it("blocks generations with any failed item or differential mismatch", () => {
    expect(
      recordAiSearchShadowObservation(declared(), {
        generation: "embedding-g2",
        indexed_item_count: 1,
        readback_item_count: 1,
        failed_item_count: 1,
        mismatch_count: 0,
        observed_at: timestamp,
      }).state,
    ).toBe("BLOCKED");
    expect(
      recordAiSearchShadowObservation(declared(), {
        generation: "embedding-g2",
        indexed_item_count: 2,
        readback_item_count: 2,
        failed_item_count: 0,
        mismatch_count: 1,
        golden_set_result_ref: "golden-result-g2",
        observed_at: timestamp,
      }).state,
    ).toBe("BLOCKED");
  });

  it("rejects generation drift, counter regression and impossible readback", () => {
    expectCode(
      () =>
        recordAiSearchShadowObservation(declared(), {
          generation: "embedding-g3",
          indexed_item_count: 1,
          readback_item_count: 1,
          failed_item_count: 0,
          mismatch_count: 0,
          observed_at: timestamp,
        }),
      "AI_SEARCH_SHADOW_PROGRESS_INVALID",
    );
    expectCode(
      () =>
        recordAiSearchShadowObservation(
          declared({
            state: "SHADOW_BUILDING",
            indexed_item_count: 1,
            readback_item_count: 1,
            observed_at: timestamp,
          }),
          {
            generation: "embedding-g2",
            indexed_item_count: 0,
            readback_item_count: 0,
            failed_item_count: 0,
            mismatch_count: 0,
            observed_at: timestamp,
          },
        ),
      "AI_SEARCH_SHADOW_PROGRESS_INVALID",
    );
    expectCode(
      () =>
        recordAiSearchShadowObservation(declared(), {
          generation: "embedding-g2",
          indexed_item_count: 1,
          readback_item_count: 2,
          failed_item_count: 0,
          mismatch_count: 0,
          observed_at: timestamp,
        }),
      "AI_SEARCH_SHADOW_PROGRESS_INVALID",
    );
  });

  it("rejects incomplete promotion and active-head races", () => {
    const registry = {
      active_head_generation: null,
      generations: [declared()],
    };
    expectCode(
      () =>
        promoteAiSearchGeneration(registry, {
          expected_active_head_generation: null,
          target_generation: "embedding-g2",
          promoted_at: timestamp,
        }),
      "AI_SEARCH_SHADOW_INCOMPLETE",
    );
    expectCode(
      () =>
        promoteAiSearchGeneration(
          {
            active_head_generation: null,
            generations: [complete()],
          },
          {
            expected_active_head_generation: "embedding-g1",
            target_generation: "embedding-g2",
            promoted_at: timestamp,
          },
        ),
      "AI_SEARCH_ACTIVE_HEAD_CONFLICT",
    );
  });

  it("atomically retires the old active generation and activates the target", () => {
    const oldProfile = profile({
      id: "search-instance-g1",
      generation: "embedding-g1",
      embedding_model: "@cf/baai/bge-base-en-v1.5",
    });
    const old = complete({
      generation: "embedding-g1",
      profile: oldProfile,
      state: "ACTIVE",
      golden_set_result_ref: "golden-result-g1",
      activated_at: "2026-09-01T12:00:00.000Z",
    });
    const registry = {
      active_head_generation: "embedding-g1",
      generations: [old, complete()],
    };
    const promoted = promoteAiSearchGeneration(registry, {
      expected_active_head_generation: "embedding-g1",
      target_generation: "embedding-g2",
      promoted_at: timestamp,
    });
    expect(promoted.active_head_generation).toBe("embedding-g2");
    expect(
      promoted.generations.find((item) => item.generation === "embedding-g1"),
    ).toMatchObject({ state: "RETIRED", retired_at: timestamp });
    expect(
      promoted.generations.find((item) => item.generation === "embedding-g2"),
    ).toMatchObject({ state: "ACTIVE", activated_at: timestamp });
    expect(() => validateAiSearchGenerationRegistry(promoted)).not.toThrow();
  });

  it("rejects duplicate instances and inconsistent active-head registries", () => {
    expectCode(
      () =>
        validateAiSearchGenerationRegistry({
          active_head_generation: null,
          generations: [declared(), declared({ generation: "embedding-g3" })],
        }),
      "AI_SEARCH_GENERATION_INVALID",
    );
    expectCode(
      () =>
        validateAiSearchGenerationRegistry({
          active_head_generation: null,
          generations: [
            complete({ state: "ACTIVE", activated_at: timestamp }),
          ],
        }),
      "AI_SEARCH_GENERATION_INVALID",
    );
  });

  it("rejects mixed or unexpected score generations but preserves no-hit sets", () => {
    const candidate = {
      candidate_id: "candidate-1",
      lane: "SEM",
      source_revision_ref: "source-revision-1",
      canonical_section_id: "section-1",
      preview: "bounded preview",
      raw_score: 0.75,
      rank: 1,
      index_generation: "embedding-g2",
      metadata: {},
    };
    expect(assertAiSearchGenerationIsolation([], "embedding-g2")).toEqual([]);
    expect(
      assertAiSearchGenerationIsolation([candidate], "embedding-g2"),
    ).toEqual([candidate]);
    expectCode(
      () =>
        assertAiSearchGenerationIsolation(
          [
            candidate,
            {
              ...candidate,
              candidate_id: "candidate-2",
              rank: 2,
              index_generation: "embedding-g3",
            },
          ],
          "embedding-g2",
        ),
      "AI_SEARCH_GENERATION_MIXED",
    );
    expectCode(
      () =>
        assertAiSearchGenerationIsolation(
          [{ ...candidate, index_generation: "embedding-g1" }],
          "embedding-g2",
        ),
      "AI_SEARCH_GENERATION_MIXED",
    );
  });
});
