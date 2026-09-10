import { describe, expect, it, vi } from "vitest";
import {
  createAiSearchErasureNamespace,
  type AiSearchErasureNamespaceBinding,
} from "./ai-search-binding.js";

function binding(pages: ReadonlyMap<number, unknown>): {
  readonly binding: AiSearchErasureNamespaceBinding;
  readonly list: ReturnType<typeof vi.fn>;
  readonly remove: ReturnType<typeof vi.fn>;
} {
  const list = vi.fn(async ({ page }: { readonly page?: number }) => pages.get(page ?? 1));
  const remove = vi.fn(async () => undefined);
  return {
    list,
    remove,
    binding: {
      get() {
        return {
          items: {
            list,
            delete: remove,
            get: (id: string) => ({ info: vi.fn(async () => ({ id })) }),
          },
        };
      },
    },
  };
}

describe("AI Search erasure binding adapter", () => {
  it("decodes bounded pages and advances only from provider readback", async () => {
    const fixture = binding(new Map([
      [1, {
        result: [{ id: "provider-id-1", key: "projection:item-1" }],
        result_info: { page: 1, total_pages: 2, total_count: 2 },
      }],
      [2, {
        result: [{ id: "provider-id-2", key: "projection:item-2" }],
        result_info: { page: 2, total_pages: 2, total_count: 2 },
      }],
    ]));
    const instance = createAiSearchErasureNamespace(fixture.binding).get("private-prose-g1");
    await expect(instance.list()).resolves.toEqual({
      items: [{ id: "provider-id-1", key: "projection:item-1" }],
      cursor: "2",
    });
    await expect(instance.list("2")).resolves.toEqual({
      items: [{ id: "provider-id-2", key: "projection:item-2" }],
    });
    expect(fixture.list).toHaveBeenNthCalledWith(1, { page: 1, per_page: 50 });
    expect(fixture.list).toHaveBeenNthCalledWith(2, { page: 2, per_page: 50 });
  });

  it("deletes by provider item ID, never by caller-supplied projection key", async () => {
    const fixture = binding(new Map([[1, { result: [], result_info: { page: 1, total_pages: 1 } }]]));
    const instance = createAiSearchErasureNamespace(fixture.binding).get("private-prose-g1");
    await instance.delete("provider-id-1");
    expect(fixture.remove).toHaveBeenCalledWith("provider-id-1");
  });

  it("fails closed on malformed or drifting list readback", async () => {
    const malformed = binding(new Map([[1, { result: [{ id: "provider-id-1" }] }]]));
    await expect(createAiSearchErasureNamespace(malformed.binding).get("private-prose-g1").list())
      .rejects.toMatchObject({ code: "ERASURE_INPUT_INVALID" });

    const drifted = binding(new Map([[1, {
      result: [],
      result_info: { page: 2, total_pages: 2 },
    }]]));
    await expect(createAiSearchErasureNamespace(drifted.binding).get("private-prose-g1").list())
      .rejects.toMatchObject({ code: "ERASURE_SETTLEMENT_UNCERTAIN", retryable: true });
  });
});
