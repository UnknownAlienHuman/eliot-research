import {
  context,
  createManagedProjectionTestPort,
  createMemoryManagedItemAuthority,
  downloaded,
  item,
  managedDocument,
  profile,
  SECTION_SHA256,
  TEST_EXECUTION_FENCE,
} from "./managed-index.test-support.js";
import { describe, expect, it, vi } from "vitest";
import { ManagedItemRecoveryBlockedError } from "./managed-index-readback.js";

describe("managed AI Search projection adapter", () => {
  it("requires upload completion and exact item-info readback", async () => {
    let key = "";
    let size = 0;
    let metadata: Readonly<Record<string, string>> = {};
    const info = vi.fn(async () => ({
      id: "provider-item-1",
      key,
      status: "completed",
      chunks_count: 1,
      file_size: size,
      metadata,
    }));
    const uploadAndPoll = vi.fn(async (
      uploadedKey: string,
      content: string,
      options?: { readonly metadata?: Readonly<Record<string, string>> },
    ) => {
      key = uploadedKey;
      size = new TextEncoder().encode(content).byteLength;
      metadata = options?.metadata ?? {};
      return {
        id: "provider-item-1",
        key,
        status: "completed",
        chunks_count: 1,
        file_size: size,
        metadata,
      };
    });
    const port = createManagedProjectionTestPort({
      authority: createMemoryManagedItemAuthority(),
      profile,
      namespace: {
        get() {
          return {
            items: {
              uploadAndPoll,
              get() {
                return {
                  info,
                  async download() { return downloaded(key); },
                };
              },
            },
          };
        },
      },
    });
    const result = await port.index(context, "projection-g1", [item], TEST_EXECUTION_FENCE);
    expect(result).toMatchObject({
      state: "READY",
      item_count: 1,
      instance_id: "private-prose-g1",
      managed_generation: "g1",
    });
    expect(uploadAndPoll).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledOnce();
    expect(key).toBe("projection-item-1.md");
    expect(metadata).toEqual({
      canonical_section_id: "section-1",
      content_sha256: SECTION_SHA256,
      instruction_taint: "DATA_ONLY",
      projection_generation: "g1",
      source_revision_ref: "revision-1",
    });
    expect(Object.keys(metadata)).toHaveLength(5);
  });

  it("accepts documented built-in metadata while keeping Eliot fields exact", async () => {
    let key = "";
    let size = 0;
    let metadata: Readonly<Record<string, string>> = {};
    const port = createManagedProjectionTestPort({
      authority: createMemoryManagedItemAuthority(),
      profile,
      namespace: {
        get() {
          return {
            items: {
              async uploadAndPoll(uploadedKey, content, options) {
                key = uploadedKey;
                size = new TextEncoder().encode(content as string).byteLength;
                metadata = options?.metadata ?? {};
                return {
                  id: "provider-item-1",
                  key,
                  status: "completed",
                  chunks_count: 1,
                  file_size: size,
                  metadata,
                };
              },
              get() {
                return {
                  async info() {
                    return {
                      id: "provider-item-1",
                      key,
                      status: "completed",
                      chunks_count: 1,
                      file_size: size,
                      metadata: {
                        ...metadata,
                        filename: key,
                        folder: "",
                        timestamp: 1_791_484_800_000,
                      },
                    };
                  },
                  async download() { return downloaded(key); },
                };
              },
            },
          };
        },
      },
    });

    await expect(port.index(context, "projection-g1", [item], TEST_EXECUTION_FENCE)).resolves.toMatchObject({
      state: "READY",
      item_count: 1,
    });
  });

  it("preflights the complete desired set before resolving the provider instance", async () => {
    const uploadAndPoll = vi.fn();
    const getInstance = vi.fn(() => ({
      items: {
        uploadAndPoll,
        get() {
          throw new Error("item readback must not run");
        },
      },
    }));
    const port = createManagedProjectionTestPort({
      authority: createMemoryManagedItemAuthority(),
      profile,
      namespace: { get: getInstance },
    });
    const invalidTail = { ...item, item_key: "invalid-tail", source_revision_ref: "foreign" };

    await expect(port.index(context, "projection-g1", [item, invalidTail], TEST_EXECUTION_FENCE)).resolves.toMatchObject({
      state: "DEGRADED",
      reason_codes: ["PROJECTION_INPUT_INVALID"],
    });
    expect(getInstance).not.toHaveBeenCalled();
    expect(uploadAndPoll).not.toHaveBeenCalled();
  });

  it("accepts a 128-character native filename and rejects 129 before provider access", async () => {
    let key = "";
    let size = 0;
    let metadata: Readonly<Record<string, string>> = {};
    const getInstance = vi.fn(() => ({
      items: {
        async uploadAndPoll(
          uploadedKey: string,
          content: string,
          options?: { readonly metadata?: Readonly<Record<string, string>> },
        ) {
          key = uploadedKey;
          size = new TextEncoder().encode(content).byteLength;
          metadata = options?.metadata ?? {};
          return {
            id: "provider-item-1",
            key,
            status: "completed",
            chunks_count: 1,
            file_size: size,
            metadata,
          };
        },
        get() {
          return {
            async info() {
              return {
                id: "provider-item-1",
                key,
                status: "completed",
                chunks_count: 1,
                file_size: size,
                metadata,
              };
            },
            async download() { return downloaded(key); },
          };
        },
      },
    }));
    const port = createManagedProjectionTestPort({
      authority: createMemoryManagedItemAuthority(),
      profile,
      namespace: { get: getInstance },
    });
    const maxKeyItem = { ...item, item_key: "a".repeat(125) };
    const tooLongKeyItem = { ...item, item_key: "a".repeat(126) };

    await expect(port.index(context, "projection-g1", [maxKeyItem], TEST_EXECUTION_FENCE)).resolves.toMatchObject({
      state: "READY",
    });
    expect(key).toHaveLength(128);
    await expect(port.index(context, "projection-g1", [tooLongKeyItem], TEST_EXECUTION_FENCE)).resolves.toMatchObject({
      state: "DEGRADED",
      reason_codes: ["PROJECTION_INPUT_INVALID"],
    });
    expect(getInstance).toHaveBeenCalledOnce();
  });

  it("rejects provider content whose downloaded bytes differ from the desired document", async () => {
    let key = "";
    let size = 0;
    let metadata: Readonly<Record<string, string>> = {};
    const port = createManagedProjectionTestPort({
      authority: createMemoryManagedItemAuthority(),
      profile,
      namespace: {
        get() {
          return {
            items: {
              async uploadAndPoll(uploadedKey, content, options) {
                key = uploadedKey;
                size = new TextEncoder().encode(content as string).byteLength;
                metadata = options?.metadata ?? {};
                return {
                  id: "provider-item-1",
                  key,
                  status: "completed",
                  chunks_count: 1,
                  file_size: size,
                  metadata,
                };
              },
              get() {
                return {
                  async info() {
                    return {
                      id: "provider-item-1",
                      key,
                      status: "completed",
                      chunks_count: 1,
                      file_size: size,
                      metadata,
                    };
                  },
                  async download() {
                    return downloaded(key, managedDocument.replace("Exact", "Other"));
                  },
                };
              },
            },
          };
        },
      },
    });

    await expect(port.index(context, "projection-g1", [item], TEST_EXECUTION_FENCE)).resolves.toMatchObject({
      state: "DEGRADED",
      reason_codes: ["MANAGED_INDEX_READBACK_FAILED"],
    });
  });

  it("degrades instead of advertising semantic readiness on mismatched readback", async () => {
    const port = createManagedProjectionTestPort({
      authority: createMemoryManagedItemAuthority(),
      profile,
      namespace: {
        get() {
          return {
            items: {
              async uploadAndPoll(
                uploadedKey: string,
                content: string,
                options?: { readonly metadata?: Readonly<Record<string, string>> },
              ) {
                return {
                  id: "provider-item-1",
                  key: uploadedKey,
                  status: "completed",
                  chunks_count: 1,
                  file_size: new TextEncoder().encode(content).byteLength,
                  metadata: options?.metadata ?? {},
                };
              },
              get() {
                return {
                  async info() {
                    return {
                      id: "provider-item-1",
                      key: "foreign-key.md",
                      status: "completed",
                      chunks_count: 1,
                      file_size: 1,
                      metadata: {},
                    };
                  },
                  async download() { return downloaded("foreign-key.md"); },
                };
              },
            },
          };
        },
      },
    });
    await expect(port.index(context, "projection-g1", [item], TEST_EXECUTION_FENCE)).resolves.toEqual({
      state: "DEGRADED",
      item_count: 1,
      instance_id: "private-prose-g1",
      managed_generation: "g1",
      reason_codes: ["MANAGED_INDEX_READBACK_FAILED"],
    });
  });

  it("rejects a legacy sixth metadata field during exact item readback", async () => {
    let key = "";
    let size = 0;
    let metadata: Readonly<Record<string, string>> = {};
    const port = createManagedProjectionTestPort({
      authority: createMemoryManagedItemAuthority(),
      profile,
      namespace: {
        get() {
          return {
            items: {
              async uploadAndPoll(
                uploadedKey: string,
                content: string,
                options?: { readonly metadata?: Readonly<Record<string, string>> },
              ) {
                key = uploadedKey;
                size = new TextEncoder().encode(content).byteLength;
                metadata = options?.metadata ?? {};
                return {
                  id: "provider-item-1",
                  key,
                  status: "completed",
                  chunks_count: 1,
                  file_size: size,
                  metadata,
                };
              },
              get() {
                return {
                  async info() {
                    return {
                      id: "provider-item-1",
                      key,
                      status: "completed",
                      chunks_count: 1,
                      file_size: size,
                      metadata: { ...metadata, item_key: item.item_key },
                    };
                  },
                  async download() { return downloaded(key); },
                };
              },
            },
          };
        },
      },
    });
    await expect(port.index(context, "projection-g1", [item], TEST_EXECUTION_FENCE)).resolves.toMatchObject({
      state: "DEGRADED",
      reason_codes: ["MANAGED_INDEX_READBACK_FAILED"],
    });
  });

  it("classifies a non-completed provider status by typed outcome", async () => {
    const port = createManagedProjectionTestPort({
      authority: createMemoryManagedItemAuthority(),
      profile,
      namespace: {
        get() {
          return {
            items: {
              async uploadAndPoll(uploadedKey, content, options) {
                return {
                  id: "provider-item-1",
                  key: uploadedKey,
                  status: "queued",
                  chunks_count: 0,
                  file_size: new TextEncoder().encode(content as string).byteLength,
                  metadata: options?.metadata ?? {},
                };
              },
              get() {
                throw new Error("provider readback must not run");
              },
            },
          };
        },
      },
    });

    await expect(port.index(context, "projection-g1", [item], TEST_EXECUTION_FENCE))
      .rejects.toBeInstanceOf(ManagedItemRecoveryBlockedError);
  });

});
