import { describe, expect, it, vi } from "vitest";
import { canonicalModelGatewayJson, modelGatewaySha256 } from "@eliotr/cloudflare-model-transport/model-gateway-request.js";
import type { AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";
import { assertProjectSearchManagedPrimaryAvailable, projectSearchFolderPrefix,
  readProjectSearchManagedAuthority, searchProjectManaged } from "./project-search.js";

const canonical = { item_key: "projection-item-1", source_revision_ref: "revision-1",
  canonical_section_id: "section-1", content_sha256: "a".repeat(64),
  instruction_taint: "DATA_ONLY", projection_generation: "projection-1" };

const registryRow = async () => {
  const generation = "g2-qwen3-2026-09-03";
  const artifact = { schema: "eliotr.ai-search-generation-registry.v1", namespace: "eliotr", revision: 7,
    registry: { active_head_generation: generation, generations: [{ namespace: "eliotr", generation, state: "ACTIVE",
      profile: { id: "private-prose-g2", generation, index_method: { vector: true, keyword: true },
        fusion_method: "rrf", reranking: true, max_num_results: 50,
        embedding_model: "@cf/qwen/qwen3-embedding-0.6b", keyword_tokenizer: "porter",
        keyword_match_mode: "and", metadata_fields: ["canonical_section_id", "content_sha256",
          "instruction_taint", "projection_generation", "source_revision_ref"] },
      expected_item_count: 1, indexed_item_count: 1, readback_item_count: 1, failed_item_count: 0, mismatch_count: 0 }] } };
  const artifact_json = canonicalModelGatewayJson(artifact);
  return { revision: 7, artifact_json, artifact_sha256: await modelGatewaySha256(artifact_json) };
};

function database(input: {
  readonly row?: unknown;
  readonly rows?: readonly unknown[];
  readonly current?: readonly unknown[];
}): D1Database {
  return { prepare(sql: string) {
    return { bind() {
      return {
        first: async () => input.row ?? null,
        all: async () => ({ success: true, results: sql.includes("projection_item") ? input.rows ?? [] : input.current ?? [] }),
      };
    } };
  } } as unknown as D1Database;
}

describe("managed native project search authority", () => {
  it("requires a canonical active generation registry row", async () => {
    const row = await registryRow();
    await expect(readProjectSearchManagedAuthority(database({ row }))).resolves.toMatchObject({
      namespace: "eliotr", instance_id: "private-prose-g2", index_generation: "g2-qwen3-2026-09-03",
      registry_revision: 7, registry_artifact_sha256: row.artifact_sha256, max_num_results: 50,
    });
    await expect(readProjectSearchManagedAuthority(database({})))
      .rejects.toMatchObject({ code: "PROJECT_SEARCH_MANAGED_NOT_PROMOTED" });
  });

  it("preflights registry plus native binding without dispatching a provider call", async () => {
    const row = await registryRow();
    const search = vi.fn();
    const authority = await assertProjectSearchManagedPrimaryAvailable({
      search_database: database({ row }),
      namespace: { get: () => ({ search }) } as unknown as AiSearchNamespaceLike,
    });
    expect(authority.index_generation).toBe("g2-qwen3-2026-09-03");
    expect(search).not.toHaveBeenCalled();
    await expect(assertProjectSearchManagedPrimaryAvailable({
      search_database: database({ row }), namespace: { get: () => ({}) } as unknown as AiSearchNamespaceLike,
    })).rejects.toMatchObject({ code: "PROJECT_SEARCH_MANAGED_CAPABILITY_UNAVAILABLE" });
  });

  it("wraps one documented native response in exact D1 membership and before/after registry fences", async () => {
    const row = await registryRow();
    const folder = await projectSearchFolderPrefix("project-1", "prose");
    const nativeSearch = vi.fn(async (request: Record<string, unknown>) => ({
      search_query: "Explain positional encodings",
      chunks: [{ id: "chunk-1", type: "text", score: 0.91, text: "canonical preview",
        item: { key: `${folder}${canonical.item_key}.md`, metadata: canonical },
        scoring_details: { vector_score: 0.8, vector_rank: 1, keyword_score: 4.2, keyword_rank: 1,
          fusion_method: "rrf", reranking_score: 0.91 } }],
      request,
    }));
    const authority = await searchProjectManaged({
      namespace: { get: () => ({ search: nativeSearch }) } as unknown as AiSearchNamespaceLike,
      core_database: database({ current: [{ source_revision_ref: canonical.source_revision_ref }] }),
      search_database: database({ row, rows: [canonical] }),
      project_id: "project-1", source_revision_refs: [canonical.source_revision_ref],
      query: "Explain positional encodings", max_num_results: 3, context_expansion: 2,
    });
    expect(authority.authority.registry_revision).toBe(7);
    expect((authority.response as { chunks: unknown[] }).chunks).toHaveLength(1);
    expect(nativeSearch).toHaveBeenCalledOnce();
    expect(nativeSearch.mock.calls[0]?.[0]).toMatchObject({ ai_search_options: {
      query_rewrite: { enabled: false }, retrieval: { retrieval_type: "hybrid", fusion_method: "rrf",
        max_num_results: 3, context_expansion: 2 },
    } });
  });
});
