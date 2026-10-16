import { describe, expect, it, vi } from "vitest";
import type { AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";
import { projectSearchFolderPrefix, searchProject } from "./project-search.js";

const canonical = { item_key: "projection-item-1", source_revision_ref: "revision-1",
  canonical_section_id: "section-1", content_sha256: "a".repeat(64),
  instruction_taint: "DATA_ONLY", projection_generation: "projection-1" };

function database(rows: readonly unknown[]): D1Database {
  return { prepare: () => ({ bind: () => ({ all: async () => ({ success: true, results: rows }) }) }) } as unknown as D1Database;
}

describe("native scoped search defaults", () => {
  it.each([true, false])("keeps native hits and D1 membership fences when membership is %s", async member => {
    const folder = await projectSearchFolderPrefix("project-1", "prose");
    const nativeSearch = vi.fn(async (request: Record<string, unknown>) => {
      const options = request.ai_search_options as {
        reranking?: { enabled?: boolean }; query_rewrite?: { enabled?: boolean };
      };
      // Reproduce the configured native postprocessor that dropped every hit.
      if (options.reranking?.enabled !== false || options.query_rewrite?.enabled !== false) return { chunks: [] };
      return { chunks: [
        { score: 0.55, item: { key: `${folder}${canonical.item_key}.md`, metadata: { source_revision_ref: "untrusted" } } },
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
    expect(nativeSearch.mock.calls[0]?.[0]).toMatchObject({ ai_search_options: { retrieval: { filters: {
      folder: { $gte: folder, $lt: `${folder.slice(0, -1)}0` },
      source_revision_ref: { $in: [canonical.source_revision_ref] },
    } } } });
  });
});
