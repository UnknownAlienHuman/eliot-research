import { describe, expect, it, vi } from "vitest";
import type { AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";
import { indexProjectSources } from "./project-search.js";

function fixture() {
  const current = vi.fn(async () => ({ current: 1 }));
  const core = { prepare: () => ({ bind: () => ({ first: current,
    all: async () => ({ success: true, results: [{ source_id: "source-1", source_revision_ref: "revision-1" }] }),
  }) }) } as unknown as D1Database;
  const rows = Array.from({ length: 9 }, (_, i) => ({ item_key: `projection-item-${i}`, source_revision_ref: "revision-1",
    title: "Source", document_context_header: `Source / page ${i + 1}`, section_text: `Page ${i + 1}`,
    canonical_section_id: `section-${i}`, content_sha256: "a".repeat(64), instruction_taint: "DATA_ONLY", projection_generation: "projection-1" }));
  const search = { prepare: () => ({ bind: () => ({ all: async () => ({ success: true, results: rows }) }) }) } as unknown as D1Database;
  const stored = new Map<string, AiSearchItemInfo>();
  const upload = vi.fn(async (key: string, _document: Blob, options: { metadata?: Record<string, string> }) => {
    const item: AiSearchItemInfo = { id: `native-${stored.size}`, key, metadata: options.metadata ?? {}, status: "queued" };
    stored.set(key, item);
    return item;
  });
  const items = { list: vi.fn(async ({ key }: { key: string }) => ({ result: stored.has(key) ? [stored.get(key)] : [] })), upload: upload };
  const input = { namespace: { get: () => ({ items }) } as unknown as AiSearchNamespaceLike,
    core_database: core, search_database: search, project_id: "project-1", source_ids: ["source-1"] };
  return { input, current, stored, upload };
}

describe("complete native project source delivery", () => {
  it("submits every canonical page despite a pending first batch, then reconciles without another upload", async () => {
    const test = fixture();
    await expect(indexProjectSources(test.input)).rejects.toMatchObject({ code: "PROJECT_SEARCH_INDEX_PENDING" });
    expect(test.stored.size).toBe(18);
    expect([...test.stored.keys()].filter(key => key.endsWith("projection-item-8.md"))).toHaveLength(2);
    for (const item of test.stored.values()) item.status = "completed";
    await expect(indexProjectSources(test.input)).resolves.toBe(9);
    expect(test.upload).toHaveBeenCalledTimes(18);
  });

  it("stops later batches on a terminal native error while awaiting every started upload", async () => {
    const test = fixture();
    const original = test.upload.getMockImplementation();
    if (original === undefined) throw new Error("Native upload fixture is missing");
    test.upload.mockImplementation(async (key, document, options) => {
      const item = await original(key, document, options);
      if (key.endsWith("projection-item-0.md")) item.status = "error";
      return item;
    });
    await expect(indexProjectSources(test.input)).rejects.toMatchObject({ code: "PROJECT_SEARCH_INDEX_FAILED" });
    expect(test.upload).toHaveBeenCalledTimes(8);
    expect(test.stored.size).toBe(8);
  });

  it("rechecks current membership after submission even while Cloudflare indexing is pending", async () => {
    const test = fixture();
    test.current.mockResolvedValueOnce({ current: 1 }).mockResolvedValueOnce({ current: 0 });
    await expect(indexProjectSources(test.input)).rejects.toMatchObject({ code: "PROJECT_SEARCH_MEMBERSHIP_STALE" });
    expect(test.stored.size).toBe(18);
  });
});
