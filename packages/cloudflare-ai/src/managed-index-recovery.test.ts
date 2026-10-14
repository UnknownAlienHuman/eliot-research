import { describe, expect, it, vi } from "vitest";
import { createManagedProjectionPort, type ProjectionAiSearchNamespace } from "./managed-index.js";
import { ManagedItemRecoveryBlockedError } from "./managed-index-readback.js";
import {
  context,
  createMemoryManagedItemAuthority,
  downloaded,
  item,
  managedDocument,
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
  const infoFailures = new Map<string, { readonly cause: unknown }>();
  const downloadFailures = new Map<string, { readonly cause: unknown }>();
  const downloadBodyFailures = new Map<string, { readonly cause: unknown }>();
  const downloadedContent = new Map<string, string>();
  let lostAck = false;
  let completeListMetadata = true;
  const info = vi.fn(async (id: string) => {
    const row = [...stored.values()].find((candidate) => candidate.id === id);
    if (row === undefined) throw new Error("unknown provider item ID");
    const failure = infoFailures.get(id);
    if (failure !== undefined) {
      infoFailures.delete(id);
      throw failure.cause;
    }
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
    const failure = downloadFailures.get(id);
    if (failure !== undefined) {
      downloadFailures.delete(id);
      throw failure.cause;
    }
    const bodyFailure = downloadBodyFailures.get(id);
    if (bodyFailure !== undefined) {
      downloadBodyFailures.delete(id);
      return {
        filename: row.key,
        size: new TextEncoder().encode(row.content).byteLength,
        body: new ReadableStream<Uint8Array>({
          start(controller) { controller.error(bodyFailure.cause); },
        }),
      };
    }
    return downloaded(row.key, downloadedContent.get(row.key) ?? row.content);
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
    failNextInfo(id: string, cause: unknown) { infoFailures.set(id, { cause }); },
    failNextDownload(id: string, cause: unknown) { downloadFailures.set(id, { cause }); },
    failNextDownloadBodyRead(id: string, cause: unknown) { downloadBodyFailures.set(id, { cause }); },
    setDownloadedContent(key: string, content: string) { downloadedContent.set(key, content); },
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
      .resolves.toMatchObject({
        state: "DEGRADED",
        item_count: 1,
        reason_codes: ["MANAGED_GENERATION_NOT_PROMOTED"],
      });

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

  it.each([
    ["info", new Error("provider info read timed out")],
    ["download", new Error("provider download read timed out")],
    ["body", new Error("provider download body stream reset")],
    ["info", undefined],
    ["download", null],
  ] as const)("recovers a temporary %s readback failure without changing item keys", async (readbackCall, cause) => {
    const secondItem = {
      ...item,
      item_key: "projection-item-recovery-2",
      canonical_section_id: "section-recovery-2",
    };
    const desired = [item, secondItem];
    const firstKey = `${item.item_key}.md`;
    const secondKey = `${secondItem.item_key}.md`;
    const firstProviderId = `provider-${item.item_key}`;
    const provider = createProvider("");
    if (readbackCall === "info") provider.failNextInfo(firstProviderId, cause);
    else if (readbackCall === "download") provider.failNextDownload(firstProviderId, cause);
    else provider.failNextDownloadBodyRead(firstProviderId, cause);
    const authority = createMemoryManagedItemAuthority();
    const firstRun = createManagedProjectionPort({
      profile,
      namespace: provider.namespace,
      authority,
      isCurrentTarget: async () => true,
    });

    let initialError: unknown;
    try {
      await firstRun.index(context, "projection-g1", desired, TEST_EXECUTION_FENCE);
    } catch (error) {
      initialError = error;
    }
    expect(initialError).toBeInstanceOf(ManagedItemRecoveryBlockedError);
    expect(initialError).toHaveProperty("cause", cause);
    expect(initialError).toMatchObject({ retryable: true, reason_code: "MANAGED_ITEM_RECOVERY_BLOCKED" });
    expect(authority.readManagedItemEffect(context, "projection-g1", item.item_key)).toMatchObject({
      state: "DISPATCHED",
      provider_item_id: firstProviderId,
      intent: { provider_key: firstKey },
      receipt: null,
    });
    expect(authority.readManagedItemEffect(context, "projection-g1", secondItem.item_key)).toMatchObject({
      state: "INTENT",
      provider_item_id: null,
      intent: { provider_key: secondKey },
    });
    expect(provider.uploadAndPoll.mock.calls.map(([key]) => key)).toEqual([firstKey]);

    const restarted = createManagedProjectionPort({
      profile,
      namespace: provider.namespace,
      authority,
      isCurrentTarget: async () => true,
    });
    await expect(restarted.index(context, "projection-g1", desired, TEST_EXECUTION_FENCE))
      .resolves.toMatchObject({
        state: "DEGRADED",
        item_count: 2,
        shadow_receipt_ref: expect.any(String),
        reason_codes: ["MANAGED_GENERATION_NOT_PROMOTED"],
      });

    expect(provider.uploadAndPoll.mock.calls.map(([key]) => key)).toEqual([firstKey, secondKey]);
    expect(authority.readManagedItemEffect(context, "projection-g1", item.item_key))
      .toMatchObject({ state: "READBACK_VERIFIED", provider_item_id: firstProviderId });
    expect(authority.readManagedItemEffect(context, "projection-g1", secondItem.item_key))
      .toMatchObject({ state: "READBACK_VERIFIED", provider_item_id: `provider-${secondItem.item_key}` });
  });

  it("preserves an earlier verified receipt while a later item's readback is temporarily unavailable", async () => {
    const secondItem = {
      ...item,
      item_key: "projection-item-recovery-2",
      canonical_section_id: "section-recovery-2",
    };
    const desired = [item, secondItem];
    const firstKey = `${item.item_key}.md`;
    const secondKey = `${secondItem.item_key}.md`;
    const provider = createProvider("");
    const readbackCause = new Error("second item download is temporarily unavailable");
    provider.failNextDownload(`provider-${secondItem.item_key}`, readbackCause);
    const authority = createMemoryManagedItemAuthority();
    const firstRun = createManagedProjectionPort({
      profile,
      namespace: provider.namespace,
      authority,
      isCurrentTarget: async () => true,
    });

    let initialError: unknown;
    try {
      await firstRun.index(context, "projection-g1", desired, TEST_EXECUTION_FENCE);
    } catch (error) {
      initialError = error;
    }
    expect(initialError).toBeInstanceOf(ManagedItemRecoveryBlockedError);
    expect(initialError).toHaveProperty("cause", readbackCause);
    const verifiedReceipt = authority.readManagedItemEffect(context, "projection-g1", item.item_key)?.receipt;
    expect(verifiedReceipt).not.toBeNull();
    expect(authority.readManagedItemEffect(context, "projection-g1", item.item_key))
      .toMatchObject({ state: "READBACK_VERIFIED", receipt: verifiedReceipt });
    expect(authority.readManagedItemEffect(context, "projection-g1", secondItem.item_key)).toMatchObject({
      state: "DISPATCHED",
      provider_item_id: `provider-${secondItem.item_key}`,
      intent: { provider_key: secondKey },
      receipt: null,
    });

    const restarted = createManagedProjectionPort({
      profile,
      namespace: provider.namespace,
      authority,
      isCurrentTarget: async () => true,
    });
    await expect(restarted.index(context, "projection-g1", desired, TEST_EXECUTION_FENCE))
      .resolves.toMatchObject({
        state: "DEGRADED",
        reason_codes: ["MANAGED_GENERATION_NOT_PROMOTED"],
      });
    expect(authority.readManagedItemEffect(context, "projection-g1", item.item_key))
      .toMatchObject({ state: "READBACK_VERIFIED", receipt: verifiedReceipt });
    expect(authority.readManagedItemEffect(context, "projection-g1", secondItem.item_key))
      .toMatchObject({ state: "READBACK_VERIFIED" });
    expect(provider.uploadAndPoll.mock.calls.map(([key]) => key)).toEqual([firstKey, secondKey]);
  });

  it("refuses a newly claimed provider dispatch when the managed target is revoked", async () => {
    const provider = createProvider("");
    const authority = createMemoryManagedItemAuthority();
    let currentnessReads = 0;
    const port = createManagedProjectionPort({
      profile,
      namespace: provider.namespace,
      authority,
      isCurrentTarget: async () => {
        currentnessReads += 1;
        return currentnessReads < 3;
      },
    });

    await expect(port.index(context, "projection-g1", [item], TEST_EXECUTION_FENCE))
      .resolves.toMatchObject({
        state: "DEGRADED",
        reason_codes: ["MANAGED_GENERATION_STALE"],
      });
    expect(currentnessReads).toBe(3);
    expect(provider.uploadAndPoll).not.toHaveBeenCalled();
    expect(provider.info).not.toHaveBeenCalled();
    expect(provider.download).not.toHaveBeenCalled();
    expect(authority.readManagedItemEffect(context, "projection-g1", item.item_key))
      .toMatchObject({ state: "UNKNOWN", provider_item_id: null, receipt: null });
  });

  it("keeps wrong downloaded content as a permanent readback mismatch", async () => {
    const key = `${item.item_key}.md`;
    const provider = createProvider("");
    provider.setDownloadedContent(key, managedDocument.replace("Exact", "Other"));
    const authority = createMemoryManagedItemAuthority();
    const port = createManagedProjectionPort({
      profile,
      namespace: provider.namespace,
      authority,
      isCurrentTarget: async () => true,
    });

    await expect(port.index(context, "projection-g1", [item], TEST_EXECUTION_FENCE))
      .resolves.toEqual({
        state: "DEGRADED",
        item_count: 1,
        instance_id: profile.managed_instance_id,
        managed_generation: profile.managed_generation,
        reason_codes: ["MANAGED_INDEX_READBACK_FAILED"],
      });
    expect(authority.readManagedItemEffect(context, "projection-g1", item.item_key)).toMatchObject({
      state: "DISPATCHED",
      provider_item_id: `provider-${item.item_key}`,
      receipt: null,
    });
    expect(provider.uploadAndPoll).toHaveBeenCalledOnce();
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
      .resolves.toMatchObject({
        state: "DEGRADED",
        item_count: 1,
        reason_codes: ["MANAGED_GENERATION_NOT_PROMOTED"],
      });
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
      .resolves.toMatchObject({
        state: "DEGRADED",
        item_count: 2,
        reason_codes: ["MANAGED_GENERATION_NOT_PROMOTED"],
      });

    expect(provider.uploadAndPoll).toHaveBeenCalledTimes(2);
    expect(authority.readManagedItemEffect(context, "projection-g1", item.item_key))
      .toMatchObject({ state: "READBACK_VERIFIED", provider_item_id: `provider-${item.item_key}` });
    expect(authority.readManagedItemEffect(context, "projection-g1", secondItem.item_key))
      .toMatchObject({ state: "READBACK_VERIFIED", provider_item_id: `provider-${secondItem.item_key}` });
    expect(provider.info).toHaveBeenCalledTimes(3);
    expect(provider.download).toHaveBeenCalledTimes(3);
  });
});
