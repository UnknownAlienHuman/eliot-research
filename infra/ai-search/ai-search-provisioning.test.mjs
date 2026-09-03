import { describe, expect, it, vi } from "vitest";

import { projectionMetadata } from "../../packages/platform-cloudflare/dist/index.js";
import {
  AI_SEARCH_CUSTOM_METADATA_FIELDS,
  AI_SEARCH_MAX_CHUNK_OVERLAP,
  AI_SEARCH_RERANKING_MODEL,
  AI_SEARCH_RETRIEVAL_GATEWAY_ID,
  AI_SEARCH_SCORE_THRESHOLD,
  AiSearchProvisioningError,
  compileAiSearchCreateRequest,
  decodeAiSearchInstanceInfo,
  decodeAiSearchInstanceListPage,
  ensureAiSearchInstance,
} from "../../packages/cloudflare-ai/dist/index.js";

const timestamp = "2026-09-03T03:00:00.000Z";
const DIGEST = "a".repeat(64);

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

function spec(overrides = {}) {
  return {
    namespace: "eliotr-production",
    profile: profile(),
    chunk_size: 512,
    chunk_overlap: 20,
    ...overrides,
  };
}

function metadata(overrides = []) {
  return AI_SEARCH_CUSTOM_METADATA_FIELDS.map((field_name) => ({
    field_name,
    data_type: "text",
  })).concat(overrides);
}

function summary(overrides = {}) {
  return {
    id: "search-instance-g2",
    type: null,
    source: null,
    status: "active",
    enable: true,
    namespace: "eliotr-production",
    created_at: timestamp,
    modified_at: timestamp,
    ...overrides,
  };
}

function listPage(result = [summary()], overrides = {}) {
  return {
    result,
    result_info: {
      count: result.length,
      total_count: result.length,
      page: 1,
      per_page: 100,
      ...overrides,
    },
  };
}

function info(overrides = {}) {
  return {
    ...summary(),
    ai_search_model: null,
    ai_gateway_id: AI_SEARCH_RETRIEVAL_GATEWAY_ID,
    embedding_model: "@cf/baai/bge-m3",
    reranking: true,
    reranking_model: AI_SEARCH_RERANKING_MODEL,
    rewrite_query: false,
    rewrite_model: null,
    cache: false,
    cache_threshold: "close_enough",
    cache_ttl: 172800,
    index_method: { vector: true, keyword: true },
    fusion_method: "rrf",
    indexing_options: { keyword_tokenizer: "porter" },
    retrieval_options: { keyword_match_mode: "or", boost_by: [] },
    chunk_size: 512,
    chunk_overlap: 20,
    score_threshold: 0,
    max_num_results: 20,
    sync_interval: 21600,
    custom_metadata: metadata(),
    last_activity: timestamp,
    ...overrides,
  };
}

async function expectCode(promise, code) {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AiSearchProvisioningError);
    expect(error.code).toBe(code);
  }
}

function expectSyncCode(call, code) {
  try {
    call();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AiSearchProvisioningError);
    expect(error.code).toBe(code);
  }
}

function existingNamespace(rawInfo = info(), rawPage = listPage()) {
  const infoCall = vi.fn(async () => rawInfo);
  const create = vi.fn();
  const get = vi.fn(() => ({ info: infoCall }));
  const list = vi.fn(async () => rawPage);
  return { namespace: { list, get, create }, list, get, create, infoCall };
}

describe("ER-16 AI Search namespace provisioning boundary", () => {
  it("compiles one bounded built-in instance request with exact five-field metadata", () => {
    const request = compileAiSearchCreateRequest(spec());
    expect(request).toEqual({
      id: "search-instance-g2",
      ai_gateway_id: AI_SEARCH_RETRIEVAL_GATEWAY_ID,
      index_method: { vector: true, keyword: true },
      fusion_method: "rrf",
      indexing_options: { keyword_tokenizer: "porter" },
      retrieval_options: { keyword_match_mode: "or", boost_by: [] },
      embedding_model: "@cf/baai/bge-m3",
      reranking: true,
      reranking_model: AI_SEARCH_RERANKING_MODEL,
      rewrite_query: false,
      cache: false,
      chunk_size: 512,
      chunk_overlap: 20,
      score_threshold: AI_SEARCH_SCORE_THRESHOLD,
      max_num_results: 20,
      custom_metadata: metadata(),
      enable: true,
    });
    expect(request).not.toHaveProperty("type");
    expect(request).not.toHaveProperty("source");
    expect(request.custom_metadata).toHaveLength(5);
    expect(Object.isFrozen(request)).toBe(true);
  });

  it("keeps the shared item metadata constructor exactly aligned with provisioning", () => {
    const itemMetadata = projectionMetadata({
      item_key: "projection-item-1",
      canonical_section_id: "section-1",
      source_revision_ref: "revision-1",
      project_membership_ids: [],
      heading_path: [],
      document_context_header: "Document",
      section_text: "Exact text.",
      normalized_offset_map_ref: "normalized-bytes:0:11",
      content_sha256: DIGEST,
      instruction_taint: "DATA_ONLY",
      projection_generation: "embedding-g2",
    });
    expect(Object.keys(itemMetadata).sort()).toEqual(
      [...AI_SEARCH_CUSTOM_METADATA_FIELDS].sort(),
    );
  });

  it("returns EXISTING_MATCH without creating or updating an exact instance", async () => {
    const fixture = existingNamespace();
    const receipt = await ensureAiSearchInstance(fixture.namespace, spec());
    expect(receipt).toMatchObject({
      disposition: "EXISTING_MATCH",
      namespace: "eliotr-production",
      instance_id: "search-instance-g2",
      generation: "embedding-g2",
      provider_status: "active",
    });
    expect(receipt.receipt_ref).toMatch(/^ai-search-provisioning-[a-f0-9]{48}$/u);
    expect(receipt.desired_configuration_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.readback_configuration_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(fixture.list).toHaveBeenCalledWith({
      page: 1,
      per_page: 100,
      search: "search-instance-g2",
      order_by: "created_at",
      order_by_direction: "asc",
    });
    expect(fixture.get).toHaveBeenCalledWith("search-instance-g2");
    expect(fixture.create).not.toHaveBeenCalled();
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it("fails before mutation when an existing embedding model differs", async () => {
    const fixture = existingNamespace(
      info({ embedding_model: "@cf/baai/bge-base-en-v1.5" }),
    );
    await expectCode(
      ensureAiSearchInstance(fixture.namespace, spec()),
      "AI_SEARCH_PROVISIONING_CONFIGURATION_MISMATCH",
    );
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("creates one absent instance and verifies the returned handle", async () => {
    const createdInfo = vi.fn(async () => info());
    const create = vi.fn(async () => ({ info: createdInfo }));
    const get = vi.fn();
    const list = vi.fn(async () => listPage([], { total_count: 0 }));
    const receipt = await ensureAiSearchInstance({ list, get, create }, spec());
    expect(receipt.disposition).toBe("CREATED");
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toEqual(compileAiSearchCreateRequest(spec()));
    expect(createdInfo).toHaveBeenCalledOnce();
    expect(get).not.toHaveBeenCalled();
  });

  it("reconciles a lost create acknowledgement through exact get/info readback", async () => {
    const list = vi.fn(async () => listPage([], { total_count: 0 }));
    const create = vi.fn(async () => {
      throw new Error("connection closed after commit");
    });
    const reconciledInfo = vi.fn(async () => info());
    const get = vi.fn(() => ({ info: reconciledInfo }));
    const receipt = await ensureAiSearchInstance({ list, get, create }, spec());
    expect(receipt.disposition).toBe("CREATE_RECONCILED");
    expect(create).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith("search-instance-g2");
    expect(reconciledInfo).toHaveBeenCalledOnce();
  });

  it("reconciles when the create handle loses its info acknowledgement", async () => {
    const list = vi.fn(async () => listPage([], { total_count: 0 }));
    const create = vi.fn(async () => ({
      async info() {
        throw new Error("lost handle acknowledgement");
      },
    }));
    const get = vi.fn(() => ({ info: vi.fn(async () => info()) }));
    const receipt = await ensureAiSearchInstance({ list, get, create }, spec());
    expect(receipt.disposition).toBe("CREATE_RECONCILED");
    expect(get).toHaveBeenCalledOnce();
  });

  it("returns CREATE_UNCERTAIN instead of guessing after failed reconciliation", async () => {
    const list = vi.fn(async () => listPage([], { total_count: 0 }));
    const create = vi.fn(async () => {
      throw new Error("unknown create outcome");
    });
    const get = vi.fn(() => ({
      async info() {
        throw new Error("instance not found");
      },
    }));
    await expectCode(
      ensureAiSearchInstance({ list, get, create }, spec()),
      "AI_SEARCH_PROVISIONING_CREATE_UNCERTAIN",
    );
  });

  it("strictly rejects unknown list and info fields", async () => {
    const create = vi.fn();
    await expectCode(
      ensureAiSearchInstance(
        {
          list: vi.fn(async () => ({ ...listPage(), unknown: true })),
          get: vi.fn(),
          create,
        },
        spec(),
      ),
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
    );
    expect(create).not.toHaveBeenCalled();

    const fixture = existingNamespace({ ...info(), provider_secret: "forbidden" });
    await expectCode(
      ensureAiSearchInstance(fixture.namespace, spec()),
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
    );
    expect(fixture.create).not.toHaveBeenCalled();
  });

  it("rejects duplicate exact IDs and unstable pagination totals", async () => {
    const duplicateList = vi.fn(async ({ page }) =>
      page === 1
        ? listPage([summary()], { total_count: 2, page: 1 })
        : listPage([summary()], { total_count: 2, page: 2 }),
    );
    await expectCode(
      ensureAiSearchInstance(
        { list: duplicateList, get: vi.fn(), create: vi.fn() },
        spec(),
      ),
      "AI_SEARCH_PROVISIONING_DUPLICATE_INSTANCE",
    );

    const unstableList = vi.fn(async ({ page }) =>
      page === 1
        ? listPage([summary({ id: "other-instance" })], {
            total_count: 2,
            page: 1,
          })
        : listPage([summary({ id: "second-instance" })], {
            total_count: 3,
            page: 2,
          }),
    );
    await expectCode(
      ensureAiSearchInstance(
        { list: unstableList, get: vi.fn(), create: vi.fn() },
        spec(),
      ),
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
    );
  });

  it("rejects cache, rewrite, chunking, boosts, and reranking drift", async () => {
    const mismatches = [
      info({ cache: true }),
      info({ rewrite_query: true }),
      info({ ai_gateway_id: "wrong-retrieval-gateway" }),
      info({ score_threshold: 0.4 }),
      info({ chunk_size: 768 }),
      info({ retrieval_options: {
        keyword_match_mode: "or",
        boost_by: [{ field: "content_sha256", direction: "exists" }],
      } }),
      info({ reranking_model: "@cf/not-the-approved-reranker" }),
    ];
    for (const rawInfo of mismatches) {
      const fixture = existingNamespace(rawInfo);
      await expectCode(
        ensureAiSearchInstance(fixture.namespace, spec()),
        "AI_SEARCH_PROVISIONING_CONFIGURATION_MISMATCH",
      );
      expect(fixture.create).not.toHaveBeenCalled();
    }
  });

  it("rejects non-built-in storage and malformed custom metadata", async () => {
    const external = existingNamespace(info({ type: "r2", source: "bucket" }));
    await expectCode(
      ensureAiSearchInstance(external.namespace, spec()),
      "AI_SEARCH_PROVISIONING_CONFIGURATION_MISMATCH",
    );

    const wrongType = existingNamespace(
      info({
        custom_metadata: metadata().map((definition, index) =>
          index === 0 ? { ...definition, data_type: "number" } : definition),
      }),
    );
    await expectCode(
      ensureAiSearchInstance(wrongType.namespace, spec()),
      "AI_SEARCH_PROVISIONING_CONFIGURATION_MISMATCH",
    );

    const sixth = existingNamespace(
      info({
        custom_metadata: metadata([{ field_name: "legacy", data_type: "text" }]),
      }),
    );
    await expectCode(
      ensureAiSearchInstance(sixth.namespace, spec()),
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
    );
  });

  it("rejects invalid provider IDs and noncanonical metadata profiles before calls", () => {
    expectSyncCode(
      () =>
        compileAiSearchCreateRequest(
          spec({ profile: profile({ id: "Uppercase-Instance" }) }),
        ),
      "AI_SEARCH_PROVISIONING_INPUT_INVALID",
    );
    expectSyncCode(
      () =>
        compileAiSearchCreateRequest(
          spec({
            profile: profile({
              metadata_fields: AI_SEARCH_CUSTOM_METADATA_FIELDS.slice(0, 4),
            }),
          }),
        ),
      "AI_SEARCH_PROVISIONING_INPUT_INVALID",
    );
    expectSyncCode(
      () =>
        compileAiSearchCreateRequest(
          spec({ chunk_overlap: AI_SEARCH_MAX_CHUNK_OVERLAP + 1 }),
        ),
      "AI_SEARCH_PROVISIONING_INPUT_INVALID",
    );
  });

  it("strictly decodes standalone list and info fixtures", () => {
    expect(decodeAiSearchInstanceListPage(listPage(), 1)).toMatchObject({
      total_count: 1,
      result: [{ id: "search-instance-g2", type: null }],
    });
    expect(decodeAiSearchInstanceInfo(info())).toMatchObject({
      id: "search-instance-g2",
      ai_gateway_id: AI_SEARCH_RETRIEVAL_GATEWAY_ID,
      embedding_model: "@cf/baai/bge-m3",
      score_threshold: AI_SEARCH_SCORE_THRESHOLD,
      custom_metadata: metadata(),
    });
  });
});
