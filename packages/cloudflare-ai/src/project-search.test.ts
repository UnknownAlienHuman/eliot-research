import { describe, expect, it, vi } from "vitest";
import { canonicalModelGatewayJson, modelGatewaySha256 } from "@eliotr/cloudflare-model-transport/model-gateway-request.js";
import type { AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";
import { projectSearchFolderPrefix, readProjectSearchManagedAuthority, searchProject, searchProjectManaged } from "./project-search.js";

const canonical = { item_key: "projection-item-1", source_revision_ref: "revision-1",
  canonical_section_id: "section-1", content_sha256: "a".repeat(64),
  instruction_taint: "DATA_ONLY", projection_generation: "projection-1" };

function database(rows: readonly unknown[]): D1Database {
  return { prepare: () => ({ bind: () => ({ all: async () => ({ success: true, results: rows }) }) }) } as unknown as D1Database;
}

async function managedRegistryRow() {
  const generation = "g2-qwen3-2026-09-03";
  const artifact = { schema: "eliotr.ai-search-generation-registry.v1", namespace: "eliotr", revision: 4,
    registry: { active_head_generation: generation, generations: [{ namespace: "eliotr", generation, state: "ACTIVE",
      profile: { id: "private-prose-g2", generation, index_method: { vector: true, keyword: true },
        fusion_method: "rrf", reranking: true, max_num_results: 50,
        embedding_model: "@cf/qwen/qwen3-embedding-0.6b", keyword_tokenizer: "porter",
        keyword_match_mode: "and", metadata_fields: ["canonical_section_id", "content_sha256",
          "instruction_taint", "projection_generation", "source_revision_ref"] },
      expected_item_count: 1, indexed_item_count: 1, readback_item_count: 1, failed_item_count: 0, mismatch_count: 0 }] } };
  const artifact_json = canonicalModelGatewayJson(artifact);
  return { revision: 4, artifact_json, artifact_sha256: await modelGatewaySha256(artifact_json) };
}

describe("native scoped search relevance and authority", () => {
  it("accepts only the exact canonical promoted registry identity", async () => {
    const row = await managedRegistryRow();
    const registry = database([]) as unknown as { prepare: (sql: string) => { bind: (...args: unknown[]) => { first: () => Promise<unknown> } } };
    registry.prepare = () => ({ bind: () => ({ first: async () => row }) });
    await expect(readProjectSearchManagedAuthority(registry as unknown as D1Database)).resolves.toMatchObject({
      namespace: "eliotr", instance_id: "private-prose-g2", index_generation: "g2-qwen3-2026-09-03",
      registry_revision: 4, registry_artifact_sha256: row.artifact_sha256,
    });
    const corrupt = { ...row, artifact_sha256: "b".repeat(64) };
    registry.prepare = () => ({ bind: () => ({ first: async () => corrupt }) });
    await expect(readProjectSearchManagedAuthority(registry as unknown as D1Database))
      .rejects.toMatchObject({ code: "PROJECT_SEARCH_MANAGED_REGISTRY_INVALID" });
  });

  it("uses one native provider call under matching pre/post registry readback and keeps its result cap", async () => {
    const registryRow = await managedRegistryRow();
    const registryDb = database([canonical]) as unknown as {
      prepare: (sql: string) => { bind: (...args: unknown[]) => { first: () => Promise<unknown>; all: () => Promise<unknown> } };
    };
    registryDb.prepare = (sql: string) => ({ bind: () => ({
      first: async () => registryRow,
      all: async () => sql.includes("projection_item")
        ? { success: true, results: [canonical] }
        : { success: true, results: [{ source_revision_ref: canonical.source_revision_ref }] },
    }) });
    const folder = await projectSearchFolderPrefix("project-1", "prose");
    const search = vi.fn(async (request: Record<string, unknown>) => ({ chunks: [{ id: "chunk-1", type: "text",
      score: 0.8, text: "preview", item: { key: `${folder}${canonical.item_key}.md`, metadata: canonical },
      scoring_details: { vector_score: 0.8, keyword_score: 3, vector_rank: 1, keyword_rank: 1, fusion_method: "rrf" } }], request }));
    const result = await searchProjectManaged({
      namespace: { get: () => ({ search }) } as unknown as AiSearchNamespaceLike,
      core_database: registryDb as unknown as D1Database, search_database: registryDb as unknown as D1Database,
      project_id: "project-1", source_revision_refs: [canonical.source_revision_ref],
      query: "Explain the methods", max_num_results: 4, context_expansion: 1,
    });
    expect(result.authority.registry_revision).toBe(4);
    expect((result.response as { chunks: unknown[] }).chunks).toHaveLength(1);
    expect(search).toHaveBeenCalledOnce();
    expect(search.mock.calls[0]?.[0]).toMatchObject({ ai_search_options: {
      cache: { enabled: false }, query_rewrite: { enabled: false },
      retrieval: { max_num_results: 4, context_expansion: 1,
        retrieval_type: "hybrid", fusion_method: "rrf" },
    } });
  });

  it.each([true, false])("keeps native hits and D1 membership fences when membership is %s", async member => {
    const folder = await projectSearchFolderPrefix("project-1", "prose");
    const nativeSearch = vi.fn(async (request: Record<string, unknown>) => {
      const options = request.ai_search_options as {
        reranking?: { enabled?: boolean; match_threshold?: number }; query_rewrite?: { enabled?: boolean };
      };
      // Native reranking defaults to a separate 0.4 floor. The measured RU
      // scores are lower, so leaving that default would discard valid locators.
      if (options.query_rewrite?.enabled !== false) throw new Error("Unexpected rewriting");
      if (options.reranking?.enabled && (options.reranking.match_threshold ?? 0.4) > 0.02) return { chunks: [] };
      return { chunks: [
        { score: 0.02, item: { key: `${folder}${canonical.item_key}.md`, metadata: { source_revision_ref: "untrusted" } } },
        { score: 1, item: { key: "projection/v1/private-prose-g2/foreign/projection-item-1.md", metadata: canonical } },
      ] };
    });
    const result = await searchProject({
      namespace: { get: () => ({ search: nativeSearch }) } as unknown as AiSearchNamespaceLike,
      core_database: database(member ? [{ source_revision_ref: canonical.source_revision_ref }] : []),
      search_database: database([canonical]),
      project_id: "project-1", lane: "prose", query: "Which QA marker is in this known file?",
      source_revision_refs: [canonical.source_revision_ref],
    }) as { chunks: { item: { key: string; metadata: Record<string, string> } }[] };
    expect(result.chunks).toHaveLength(member ? 1 : 0);
    if (member) {
      const { item_key: _itemKey, ...metadata } = canonical;
      expect(result.chunks[0]?.item.metadata).toEqual(metadata);
    }
    expect(nativeSearch).toHaveBeenCalledOnce();
    expect(nativeSearch.mock.calls[0]?.[0]).toMatchObject({ ai_search_options: {
      reranking: { enabled: true, match_threshold: 0 }, query_rewrite: { enabled: false },
      retrieval: { retrieval_type: "hybrid", fusion_method: "rrf", keyword_match_mode: "or", filters: {
      folder: { $gte: folder, $lt: `${folder.slice(0, -1)}0` },
      source_revision_ref: { $in: [canonical.source_revision_ref] },
    } } } });
  });

  it("keeps literal lookup unrewritten and unreranked", async () => {
    const folder = await projectSearchFolderPrefix("project-1", "literal");
    const search = vi.fn(async (_request: Record<string, unknown>) => ({ chunks: [{ score: 0.01,
      item: { key: `${folder}${canonical.item_key}.md`, metadata: { source_revision_ref: "forged" } } }] }));
    const result = await searchProject({
      namespace: { get: () => ({ search }) } as unknown as AiSearchNamespaceLike,
      core_database: database([{ source_revision_ref: canonical.source_revision_ref }]), search_database: database([canonical]),
      project_id: "project-1", lane: "literal", query: 'exact "symbol"', source_revision_refs: [canonical.source_revision_ref],
    }) as { chunks: unknown[] };
    expect(result.chunks).toHaveLength(1);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ ai_search_options: expect.objectContaining({
      query_rewrite: { enabled: false }, reranking: { enabled: false },
    }) }));
    expect(search.mock.calls[0]?.[0]).not.toMatchObject({ ai_search_options: { retrieval: expect.objectContaining({
      retrieval_type: "hybrid", keyword_match_mode: "or",
    }) } });
  });

  it("retains native result order and overwrites provider authority metadata with D1 identities", async () => {
    const folder = await projectSearchFolderPrefix("project-1", "prose");
    const second = { ...canonical, item_key: "projection-item-2", canonical_section_id: "section-2", source_revision_ref: "revision-2" };
    const search = vi.fn(async () => ({ chunks: [
      { id: "native-first", score: 0.01, item: { key: `${folder}${second.item_key}.md`, metadata: { source_revision_ref: "forged" } } },
      { id: "native-second", score: 0.9, item: { key: `${folder}${canonical.item_key}.md`, metadata: { source_revision_ref: "forged" } } },
    ] }));
    const result = await searchProject({
      namespace: { get: () => ({ search }) } as unknown as AiSearchNamespaceLike,
      core_database: database([canonical, second]), search_database: database([canonical, second]),
      project_id: "project-1", lane: "prose", query: "Explain the methods", source_revision_refs: [canonical.source_revision_ref, second.source_revision_ref],
    }) as { chunks: { id: string; item: { metadata: { source_revision_ref: string } } }[] };
    expect(result.chunks.map((chunk) => chunk.id)).toEqual(["native-first", "native-second"]);
    expect(result.chunks.map((chunk) => chunk.item.metadata.source_revision_ref)).toEqual(["revision-2", "revision-1"]);
    expect(search).toHaveBeenCalledOnce();
  });

  it("rejects full source identities outside scope even when native 64-byte filter prefixes collide", async () => {
    const folder = await projectSearchFolderPrefix("project-1", "prose");
    const prefix = "r".repeat(64);
    const allowed = `${prefix}-allowed`;
    const foreign = { ...canonical, source_revision_ref: `${prefix}-foreign` };
    const search = vi.fn(async () => ({ chunks: [{ score: 0.001,
      item: { key: `${folder}${canonical.item_key}.md`, metadata: { source_revision_ref: allowed } } }] }));
    const result = await searchProject({
      namespace: { get: () => ({ search }) } as unknown as AiSearchNamespaceLike,
      core_database: database([{ source_revision_ref: foreign.source_revision_ref }]), search_database: database([foreign]),
      project_id: "project-1", lane: "prose", query: "Explain the methods", source_revision_refs: [allowed],
    }) as { chunks: unknown[] };
    expect(result.chunks).toEqual([]);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ ai_search_options: expect.objectContaining({
      retrieval: { retrieval_type: "hybrid", fusion_method: "rrf", keyword_match_mode: "or",
        filters: { folder: { $gte: folder, $lt: `${folder.slice(0, -1)}0` }, source_revision_ref: { $in: [prefix] } } },
    }) }));
  });

  it("keeps the existing fifty-chunk provider bound", async () => {
    const search = vi.fn(async () => ({ chunks: Array.from({ length: 51 }, () => ({})) }));
    await expect(searchProject({
      namespace: { get: () => ({ search }) } as unknown as AiSearchNamespaceLike,
      core_database: database([]), search_database: database([]), project_id: "project-1", lane: "prose", query: "Explain the methods",
    })).rejects.toMatchObject({ code: "PROJECT_SEARCH_PROVIDER_RESPONSE_INVALID" });
    expect(search).toHaveBeenCalledOnce();
  });
});
