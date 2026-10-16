import { describe, expect, it, vi } from "vitest";
import type { AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";
import { projectSearchFolderPrefix } from "@eliotr/cloudflare-ai/project-search";
import { readProjectSemanticReadiness } from "./library-semantic-readiness.js";

const row = { item_key: "item-1", source_revision_ref: "revision-1", canonical_section_id: "section-1",
  content_sha256: "a".repeat(64), instruction_taint: "DATA_ONLY", projection_generation: "projection-1" };
async function fixture(status = "completed") {
  const prefix = await projectSearchFolderPrefix("project-1", "prose");
  const first = vi.fn(async () => ({ generation: 1, head_rev: "revision-1" }));
  const database = { prepare: () => ({ bind: () => ({ first }) }) } as unknown as D1Database;
  const search = { prepare: () => ({ bind: () => ({ all: async () => ({ success: true, results: [row] }) }) }) } as unknown as D1Database;
  const { item_key: _key, ...metadata } = row;
  const item = { id: "provider-item", key: `${prefix}item-1.md`, status, metadata };
  const list = vi.fn(async (_params?: AiSearchListItemsParams) => ({ result: [item] }));
  const input = { database, search_database: search,
    namespace: { get: () => ({ items: { list } }) } as unknown as AiSearchNamespaceLike,
    project_id: "project-1", source_id: "source-1", source_revision_ref: "revision-1",
    principal_ref: "owner", observed_at: "2026-10-16T12:00:00.000Z" };
  return { input, item, first, list };
}
describe("project native semantic readiness", () => {
  it("reports ready only after canonical metadata and both project fences agree", async () => {
    const test = await fixture();
    const result = await readProjectSemanticReadiness(test.input);
    expect(result.state).toBe("ready");
    expect(result.receipt_ref).toMatch(/^native-items-readback:[a-f0-9]{64}$/u);
    expect(test.first).toHaveBeenCalledTimes(2);
    expect(test.list.mock.calls[0]?.[0]).toMatchObject({ source: "builtin", per_page: 50, page: 1 });
  });
  it("keeps pending native indexing visible", async () => {
    const test = await fixture("queued");
    expect((await readProjectSemanticReadiness(test.input)).state).toBe("queued");
  });
  it("never accepts matching provider metadata under a foreign project folder", async () => {
    const test = await fixture();
    test.item.key = "projection/v1/private-prose-g2/foreign/item-1.md";
    expect((await readProjectSemanticReadiness(test.input)).state).not.toBe("ready");
  });
  it("refuses changed canonical metadata and an unavailable provider", async () => {
    const test = await fixture();
    test.item.metadata.content_sha256 = "b".repeat(64);
    expect((await readProjectSemanticReadiness(test.input)).state).toBe("degraded");
    test.list.mockRejectedValueOnce(new Error("Native read failed"));
    expect((await readProjectSemanticReadiness(test.input)).state).toBe("degraded");
  });
  it("rejects project changes while native readback is in flight", async () => {
    const test = await fixture();
    test.first.mockResolvedValueOnce({ generation: 1, head_rev: "revision-1" })
      .mockResolvedValueOnce({ generation: 2, head_rev: "revision-1" });
    await expect(readProjectSemanticReadiness(test.input)).rejects.toMatchObject({ code: "LIBRARY_PROJECT_CHANGED" });
  });
  it("checks current project authority even before the first projection exists", async () => {
    const test = await fixture();
    test.input.search_database = { prepare: () => ({ bind: () => ({ all: async () => ({ success: true, results: [] }) }) }) } as unknown as D1Database;
    test.first.mockResolvedValueOnce({ generation: 1, head_rev: "revision-1" })
      .mockResolvedValueOnce({ generation: 2, head_rev: "revision-1" });
    await expect(readProjectSemanticReadiness(test.input)).rejects.toMatchObject({ code: "LIBRARY_PROJECT_CHANGED" });
    expect(test.list).not.toHaveBeenCalled();
  });
});
