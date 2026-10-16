import { describe, expect, it, vi } from "vitest";
import { ensureProjectSearchItem } from "./project-search-item.js";

const key = "projection/v1/prose/project/section.md";
const metadata = { content_sha256: "a".repeat(64), source_revision_ref: "revision-1" };
const info = (status: AiSearchItemInfo["status"]): AiSearchItemInfo => ({ id: "item-1", key, metadata, status });

describe("native project Items delivery", () => {
  it("reconciles a lost upload acknowledgement without another upsert", async () => {
    let stored: AiSearchItemInfo | undefined;
    const items = {
      list: vi.fn(async () => ({ result: stored ? [stored] : [] })),
      upload: vi.fn(async () => { stored = info("completed"); throw new Error("lost acknowledgement"); }),
    };
    await expect(ensureProjectSearchItem(items, key, "document", metadata)).rejects.toThrow("lost acknowledgement");
    await expect(ensureProjectSearchItem(items, key, "document", metadata)).resolves.toBeUndefined();
    expect(items.upload).toHaveBeenCalledTimes(1);
    expect(items.list).toHaveBeenLastCalledWith({ key, source: "builtin", per_page: 5 });
  });

  it("leaves in-progress indexing with Cloudflare and only reads on redelivery", async () => {
    const items = { list: vi.fn(async () => ({ result: [info("running")] })), upload: vi.fn() };
    await expect(ensureProjectSearchItem(items, key, "document", metadata)).rejects.toMatchObject({ code: "PROJECT_SEARCH_INDEX_PENDING" });
    items.list.mockResolvedValue({ result: [info("completed")] });
    await expect(ensureProjectSearchItem(items, key, "document", metadata)).resolves.toBeUndefined();
    expect(items.upload).not.toHaveBeenCalled();
  });

  it("does not overwrite an existing key with another canonical identity", async () => {
    const items = { list: vi.fn(async () => ({ result: [{ ...info("completed"), metadata: { ...metadata, source_revision_ref: "foreign" } }] })), upload: vi.fn() };
    await expect(ensureProjectSearchItem(items, key, "document", metadata)).rejects.toMatchObject({ code: "PROJECT_SEARCH_PROVIDER_RESPONSE_INVALID" });
    expect(items.upload).not.toHaveBeenCalled();
  });

  it("keeps an acknowledgement without metadata pending and requires exact completed readback", async () => {
    const items = { list: vi.fn(async () => ({ result: [] as AiSearchItemInfo[] })),
      upload: vi.fn(async () => { const { metadata: _metadata, ...ack } = info("queued"); return ack; }) };
    await expect(ensureProjectSearchItem(items, key, "document", metadata))
      .rejects.toMatchObject({ code: "PROJECT_SEARCH_INDEX_PENDING" });
    items.list.mockResolvedValue({ result: [{ ...info("completed"), metadata: { ...metadata, content_sha256: "b".repeat(64) } }] });
    await expect(ensureProjectSearchItem(items, key, "document", metadata))
      .rejects.toMatchObject({ code: "PROJECT_SEARCH_PROVIDER_RESPONSE_INVALID" });
    items.list.mockResolvedValue({ result: [info("completed")] });
    await expect(ensureProjectSearchItem(items, key, "document", metadata)).resolves.toBeUndefined();
    expect(items.upload).toHaveBeenCalledTimes(1);
  });

  it("does not report a native timeout or terminal failure as completed", async () => {
    const items = { list: vi.fn(async () => ({ result: [] })), upload: vi.fn(async () => info("queued")) };
    await expect(ensureProjectSearchItem(items, key, "document", metadata)).rejects.toMatchObject({ code: "PROJECT_SEARCH_INDEX_PENDING" });
    items.upload.mockResolvedValue(info("error"));
    await expect(ensureProjectSearchItem(items, key, "document", metadata)).rejects.toMatchObject({ code: "PROJECT_SEARCH_INDEX_FAILED" });
  });
});
