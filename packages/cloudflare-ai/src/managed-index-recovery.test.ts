import { describe, expect, it, vi } from "vitest";
import { createManagedProjectionPort, type ProjectionAiSearchNamespace } from "./managed-index.js";
import { ManagedItemRecoveryBlockedError } from "./managed-index-readback.js";
import {
  context,
  createMemoryManagedItemAuthority,
  downloaded,
  item,
  profile,
  TEST_EXECUTION_FENCE,
} from "./managed-index.test-support.js";

interface StoredItem {
  readonly id: string;
  readonly key: string;
  readonly status: "completed";
  readonly chunks_count: number;
  readonly file_size: number;
  readonly metadata: Readonly<Record<string, string>>;
  readonly content: string;
}

function createProvider(lostAckKey: string) {
  const stored = new Map<string, StoredItem>();
  const visible = new Set<string>();
  let lostAck = false;
  let completeListMetadata = true;
  const info = vi.fn(async (id: string) => {
    const row = [...stored.values()].find((candidate) => candidate.id === id);
    if (row === undefined) throw new Error("unknown provider item ID");
    return {
      id: row.id,
      key: row.key,
      status: row.status,
      chunks_count: row.chunks_count,
      file_size: row.file_size,
      metadata: row.metadata,
    };
  });
  const download = vi.fn(async (id: string) => {
    const row = [...stored.values()].find((candidate) => candidate.id === id);
    if (row === undefined) throw new Error("unknown provider item ID");
    return downloaded(row.key, row.content);
  });
  const uploadAndPoll = vi.fn(async (
    key: string,
    content: string | ArrayBuffer | ReadableStream<Uint8Array>,
    options?: { readonly metadata?: Readonly<Record<string, string>> },
  ) => {
    if (typeof content !== "string") throw new Error("expected prepared UTF-8 document");
    const row: StoredItem = {
      id: `provider-${key.replace(".md", "")}`,
      key,
      status: "completed",
      chunks_count: 1,
      file_size: new TextEncoder().encode(content).byteLength,
      metadata: options?.metadata ?? {},
      content,
    };
    stored.set(key, row);
    if (key === lostAckKey && !lostAck) {
      lostAck = true;
      throw new Error("provider committed the item but lost the upload acknowledgement");
    }
    visible.add(key);
    return {
      id: row.id,
      key: row.key,
      status: row.status,
      chunks_count: row.chunks_count,
      file_size: row.file_size,
      metadata: row.metadata,
    };
  });
  const list = vi.fn(async (input: {
    readonly key: string;
    readonly source: "builtin";
    readonly page: number;
    readonly per_page: number;
  }) => {
    const row = input.source === "builtin" && visible.has(input.key)
      ? stored.get(input.key)
      : undefined;
    const result = row === undefined ? [] : [{
      id: row.id,
      key: row.key,
      status: row.status,
      chunks_count: row.chunks_count,
      file_size: row.file_size,
      metadata: row.metadata,
    }];
    if (!completeListMetadata) return { result };
    return {
      result,
      result_info: {
        page: input.page,
        per_page: input.per_page,
        count: result.length,
        total_count: result.length,
      },
    };
  });
  const namespace: ProjectionAiSearchNamespace = {
    get() {
      return {
        items: {
          uploadAndPoll,
          list,
          get(id) {
            return {
              info: () => info(id),
              download: () => download(id),
            };
          },
        },
      };
    },
  };
  return {
    namespace,
    uploadAndPoll,
    list,
    info,
    download,
    reveal(key: string) { visible.add(key); },
    setCompleteListMetadata(value: boolean) { completeListMetadata = value; },
  };
}

describe("managed AI Search per-item recovery", () => {
  it("recovers a lost acknowledgement by exact listing after restart without reupload", async () => {
    const key = `${item.item_key}.md`;
    const provider = createProvider(key);
    const authority = createMemoryManagedItemAuthority();
    const firstRun = createManagedProjectionPort({
      profile,
      namespace: provider.namespace,
      authority,
      isCurrentTarget: async () => true,
    });

    await expect(firstRun.index(context, "projection-g1", [item], TEST_EXECUTION_FENCE))
      .rejects.toBeInstanceOf(ManagedItemRecoveryBlockedError);
    expect(authority.readManagedItemEffect(context, "projection-g1", item.item_key))
      .toMatchObject({ state: "UNKNOWN", provider_item_id: null, receipt: null });
    expect(provider.uploadAndPoll).toHaveBeenCalledOnce();
    expect(provider.info).not.toHaveBeenCalled();
    expect(provider.download).not.toHaveBeenCalled();

    provider.reveal(key);
    const restarted = createManagedProjectionPort({
      profile,
      namespace: provider.namespace,
      authority,
      isCurrentTarget: async () => true,
    });
    await expect(restarted.index(context, "projection-g1", [item], TEST_EXECUTION_FENCE))
      .resolves.toMatchObject({ state: "READY", item_count: 1 });

    expect(provider.uploadAndPoll).toHaveBeenCalledOnce();
    expect(provider.list).toHaveBeenNthCalledWith(1, {
      key,
      source: "builtin",
      page: 1,
      per_page: 50,
    });
    expect(authority.readManagedItemEffect(context, "projection-g1", item.item_key))
      .toMatchObject({ state: "READBACK_VERIFIED", provider_item_id: `provider-${item.item_key}` });
    expect(provider.info).toHaveBeenCalledOnce();
    expect(provider.download).toHaveBeenCalledOnce();
  });

  it("blocks recovery without complete exact-list metadata and resumes without another upload", async () => {
    const key = `${item.item_key}.md`;
    const provider = createProvider("");
    provider.setCompleteListMetadata(false);
    const authority = createMemoryManagedItemAuthority();
    const firstRun = createManagedProjectionPort({
      profile,
      namespace: provider.namespace,
      authority,
      isCurrentTarget: async () => true,
    });

    await expect(firstRun.index(context, "projection-g1", [item], TEST_EXECUTION_FENCE))
      .rejects.toBeInstanceOf(ManagedItemRecoveryBlockedError);
    expect(provider.uploadAndPoll).toHaveBeenCalledOnce();
    expect(provider.list).toHaveBeenCalledWith({
      key,
      source: "builtin",
      page: 1,
      per_page: 50,
    });
    expect(authority.readManagedItemEffect(context, "projection-g1", item.item_key))
      .toMatchObject({ state: "UNKNOWN", provider_item_id: `provider-${item.item_key}` });

    provider.setCompleteListMetadata(true);
    const restarted = createManagedProjectionPort({
      profile,
      namespace: provider.namespace,
      authority,
      isCurrentTarget: async () => true,
    });
    await expect(restarted.index(context, "projection-g1", [item], TEST_EXECUTION_FENCE))
      .resolves.toMatchObject({ state: "READY", item_count: 1 });
    expect(provider.uploadAndPoll).toHaveBeenCalledOnce();
    expect(provider.info).toHaveBeenCalledOnce();
    expect(provider.download).toHaveBeenCalledOnce();
  });

  it("preserves an earlier item receipt when a later item blocks, then resumes only by exact readback", async () => {
    const secondItem = {
      ...item,
      item_key: "projection-item-2",
      canonical_section_id: "section-2",
    };
    const secondKey = `${secondItem.item_key}.md`;
    const provider = createProvider(secondKey);
    const authority = createMemoryManagedItemAuthority();
    const desired = [item, secondItem];
    const firstRun = createManagedProjectionPort({
      profile,
      namespace: provider.namespace,
      authority,
      isCurrentTarget: async () => true,
    });

    await expect(firstRun.index(context, "projection-g1", desired, TEST_EXECUTION_FENCE))
      .rejects.toBeInstanceOf(ManagedItemRecoveryBlockedError);
    expect(authority.readManagedItemEffect(context, "projection-g1", item.item_key))
      .toMatchObject({ state: "READBACK_VERIFIED", provider_item_id: `provider-${item.item_key}` });
    expect(authority.readManagedItemEffect(context, "projection-g1", secondItem.item_key))
      .toMatchObject({ state: "UNKNOWN", provider_item_id: null, receipt: null });
    expect(provider.uploadAndPoll).toHaveBeenCalledTimes(2);

    provider.reveal(secondKey);
    const restarted = createManagedProjectionPort({
      profile,
      namespace: provider.namespace,
      authority,
      isCurrentTarget: async () => true,
    });
    await expect(restarted.index(context, "projection-g1", desired, TEST_EXECUTION_FENCE))
      .resolves.toMatchObject({ state: "READY", item_count: 2 });

    expect(provider.uploadAndPoll).toHaveBeenCalledTimes(2);
    expect(authority.readManagedItemEffect(context, "projection-g1", item.item_key))
      .toMatchObject({ state: "READBACK_VERIFIED", provider_item_id: `provider-${item.item_key}` });
    expect(authority.readManagedItemEffect(context, "projection-g1", secondItem.item_key))
      .toMatchObject({ state: "READBACK_VERIFIED", provider_item_id: `provider-${secondItem.item_key}` });
    expect(provider.info).toHaveBeenCalledTimes(3);
    expect(provider.download).toHaveBeenCalledTimes(3);
  });
});
