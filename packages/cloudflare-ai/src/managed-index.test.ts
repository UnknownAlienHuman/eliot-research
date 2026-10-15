import {
  context,
  createManagedProjectionTestPort,
  createManagedProjectionTestWriter,
  createMemoryManagedItemAuthority,
  downloaded,
  item,
  managedProjectCopyPlanV1,
  managedProjectCopyPlanV2,
  managedDocument,
  profile,
  SECTION_SHA256,
  TEST_EXECUTION_FENCE,
} from "./managed-index.test-support.js";
import { describe, expect, it, vi } from "vitest";
import { ManagedItemRecoveryBlockedError } from "./managed-index-readback.js";

describe("managed AI Search projection adapter", () => {
  it("allows new ACTIVE writes only through an exact V2 project-copy selection", async () => {
    let key = "";
    let content = "";
    let metadata: Readonly<Record<string, string>> = {};
    const uploadAndPoll = vi.fn(async (
      uploadedKey: string,
      uploadedContent: string,
      options?: { readonly metadata?: Readonly<Record<string, string>> },
    ) => {
      key = uploadedKey;
      content = uploadedContent;
      metadata = options?.metadata ?? {};
      return {
        id: "provider-active-v2",
        key,
        status: "completed",
        chunks_count: 1,
        file_size: new TextEncoder().encode(content).byteLength,
        metadata: {
          ...metadata,
          filename: key.slice(key.lastIndexOf("/") + 1),
          folder: key.slice(0, key.lastIndexOf("/") + 1),
        },
      };
    });
    const authority = createMemoryManagedItemAuthority();
    const activeProfile = { ...profile, managed_generation_active: true };
    const copyPlan = await managedProjectCopyPlanV2("ACTIVE", activeProfile);
    const plannedItem = copyPlan.items[0];
    if (plannedItem === undefined) throw new Error("V2 fixture has no provider item");
    const canonicalGeneration = plannedItem.canonical_projection_generation;
    const port = createManagedProjectionTestWriter({
      authority,
      profile: activeProfile,
      namespace: {
        get() {
          return {
            items: {
              uploadAndPoll,
              get() {
                return {
                  async info() {
                    return {
                      id: "provider-active-v2",
                      key,
                      status: "completed",
                      chunks_count: 1,
                      file_size: new TextEncoder().encode(content).byteLength,
                      metadata: {
                        ...metadata,
                        filename: key.slice(key.lastIndexOf("/") + 1),
                        folder: key.slice(0, key.lastIndexOf("/") + 1),
                      },
                    };
                  },
                  async download() { return downloaded(key.slice(key.lastIndexOf("/") + 1), content); },
                };
              },
            },
          };
        },
      },
    });

    const receipt = await port.index(
      context,
      "execution-active-v2",
      canonicalGeneration,
      copyPlan,
      TEST_EXECUTION_FENCE,
    );
    expect(uploadAndPoll).toHaveBeenCalledOnce();
    expect(receipt).toMatchObject({
      state: "READY",
      item_count: 1,
      instance_id: activeProfile.managed_instance_id,
      managed_generation: activeProfile.managed_generation,
      reason_codes: [],
    });
    expect(authority.readManagedItemEffect(
      context,
      "execution-active-v2",
      plannedItem.item_key,
    )?.state).toBe("READBACK_VERIFIED");
  });

  it("allows paired-null registry absence only for a SHADOW V2 copy", async () => {
    let key = "";
    let content = "";
    let metadata: Readonly<Record<string, string>> = {};
    const uploadAndPoll = vi.fn(async (
      uploadedKey: string,
      uploadedContent: string,
      options?: { readonly metadata?: Readonly<Record<string, string>> },
    ) => {
      key = uploadedKey;
      content = uploadedContent;
      metadata = options?.metadata ?? {};
      return {
        id: "provider-bootstrap-shadow-v2",
        key,
        status: "completed",
        chunks_count: 1,
        file_size: new TextEncoder().encode(content).byteLength,
        metadata: {
          ...metadata,
          filename: key.slice(key.lastIndexOf("/") + 1),
          folder: key.slice(0, key.lastIndexOf("/") + 1),
        },
      };
    });
    const authority = createMemoryManagedItemAuthority();
    const shadowProfile = { ...profile, managed_generation_active: false };
    const copyPlan = await managedProjectCopyPlanV2("SHADOW", shadowProfile, "ABSENT");
    const plannedItem = copyPlan.items[0];
    if (plannedItem === undefined) throw new Error("V2 fixture has no provider item");
    const port = createManagedProjectionTestWriter({
      authority,
      profile: shadowProfile,
      namespace: {
        get() {
          return {
            items: {
              uploadAndPoll,
              get() {
                return {
                  async info() {
                    return {
                      id: "provider-bootstrap-shadow-v2",
                      key,
                      status: "completed",
                      chunks_count: 1,
                      file_size: new TextEncoder().encode(content).byteLength,
                      metadata: {
                        ...metadata,
                        filename: key.slice(key.lastIndexOf("/") + 1),
                        folder: key.slice(0, key.lastIndexOf("/") + 1),
                      },
                    };
                  },
                  async download() { return downloaded(key.slice(key.lastIndexOf("/") + 1), content); },
                };
              },
            },
          };
        },
      },
    });

    const receipt = await port.index(
      context,
      "execution-bootstrap-shadow-v2",
      plannedItem.canonical_projection_generation,
      copyPlan,
      TEST_EXECUTION_FENCE,
    );
    expect(uploadAndPoll).toHaveBeenCalledOnce();
    expect(receipt).toMatchObject({
      state: "DEGRADED",
      item_count: 1,
      instance_id: shadowProfile.managed_instance_id,
      managed_generation: shadowProfile.managed_generation,
      reason_codes: ["MANAGED_GENERATION_NOT_PROMOTED"],
    });
    expect(authority.readManagedItemEffect(
      context,
      "execution-bootstrap-shadow-v2",
      plannedItem.item_key,
    )?.state).toBe("READBACK_VERIFIED");
  });

  it("rejects paired-null registry absence on ACTIVE before provider access", async () => {
    const activeProfile = { ...profile, managed_generation_active: true };
    const copyPlan = await managedProjectCopyPlanV2("ACTIVE", activeProfile, "ABSENT");
    const getInstance = vi.fn(() => ({
      items: {
        uploadAndPoll: vi.fn(),
        get() { throw new Error("ACTIVE null capture must stop before item access"); },
      },
    }));
    const port = createManagedProjectionTestWriter({
      authority: createMemoryManagedItemAuthority(),
      profile: activeProfile,
      namespace: { get: getInstance },
    });
    const plannedItem = copyPlan.items[0];
    if (plannedItem === undefined) throw new Error("V2 fixture has no provider item");

    await expect(port.index(
      context,
      "execution-active-null-capture",
      plannedItem.canonical_projection_generation,
      copyPlan,
      TEST_EXECUTION_FENCE,
    )).resolves.toMatchObject({ state: "DEGRADED" });
    expect(getInstance).not.toHaveBeenCalled();
  });

  it("keeps legacy flat ACTIVE writes refused before provider upload", async () => {
    const uploadAndPoll = vi.fn();
    const activeProfile = { ...profile, managed_generation_active: true };
    const port = createManagedProjectionTestPort({
      authority: createMemoryManagedItemAuthority(),
      profile: activeProfile,
      namespace: {
        get() {
          return {
            items: {
              uploadAndPoll,
              get() { throw new Error("ACTIVE legacy write must stop before item readback"); },
            },
          };
        },
      },
    });

    await expect(port.index(context, "execution-active-flat", [item], TEST_EXECUTION_FENCE))
      .resolves.toMatchObject({ state: "DEGRADED" });
    expect(uploadAndPoll).not.toHaveBeenCalled();
  });

  it("keeps PROJECT_COPY_V1 ACTIVE writes refused before provider upload", async () => {
    const uploadAndPoll = vi.fn();
    const activeProfile = { ...profile, managed_generation_active: true };
    const copyPlan = await managedProjectCopyPlanV1(activeProfile);
    const plannedItem = copyPlan.items[0];
    if (plannedItem === undefined) throw new Error("V1 fixture has no provider item");
    const port = createManagedProjectionTestWriter({
      authority: createMemoryManagedItemAuthority(),
      profile: activeProfile,
      namespace: {
        get() {
          return {
            items: {
              uploadAndPoll,
              get() { throw new Error("V1 ACTIVE write must stop before item readback"); },
            },
          };
        },
      },
    });

    await expect(port.index(
      context,
      "execution-active-project-copy-v1",
      plannedItem.canonical_projection_generation,
      copyPlan,
      TEST_EXECUTION_FENCE,
    )).resolves.toMatchObject({ state: "DEGRADED" });
    expect(uploadAndPoll).not.toHaveBeenCalled();
  });

  it("rejects a V2 SHADOW-purpose plan against an ACTIVE profile before provider access", async () => {
    const activeProfile = { ...profile, managed_generation_active: true };
    const copyPlan = await managedProjectCopyPlanV2("SHADOW", activeProfile);
    const getInstance = vi.fn(() => ({
      items: {
        uploadAndPoll: vi.fn(),
        get() { throw new Error("mismatched target selection must stop before item access"); },
      },
    }));
    const port = createManagedProjectionTestWriter({
      authority: createMemoryManagedItemAuthority(),
      profile: activeProfile,
      namespace: { get: getInstance },
    });
    const canonicalGeneration = copyPlan.items[0]?.canonical_projection_generation;
    if (canonicalGeneration === undefined) throw new Error("V2 fixture has no canonical generation");

    await expect(port.index(
      context,
      "execution-active-wrong-purpose",
      canonicalGeneration,
      copyPlan,
      TEST_EXECUTION_FENCE,
    )).resolves.toMatchObject({ state: "DEGRADED" });
    expect(getInstance).not.toHaveBeenCalled();
  });

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
    const authority = createMemoryManagedItemAuthority();
    const prepareSizes: number[] = [];
    const originalPrepare = authority.prepareManagedItems.bind(authority);
    vi.spyOn(authority, "prepareManagedItems").mockImplementation(async (...args) => {
      const intents = args[3];
      if (prepareSizes.length > 0) {
        const current = intents[0];
        if (
          intents.length !== 1 ||
          current === undefined ||
          authority.readManagedItemEffect(args[0], args[1], current.item_key)?.state === "INTENT"
        ) {
          throw new Error("scalar refresh must follow this item's durable state transition");
        }
      }
      prepareSizes.push(intents.length);
      return originalPrepare(...args);
    });
    const port = createManagedProjectionTestPort({
      authority,
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
      state: "DEGRADED",
      item_count: 1,
      instance_id: "private-prose-g1",
      managed_generation: "g1",
      reason_codes: ["MANAGED_GENERATION_NOT_PROMOTED"],
    });
    expect(uploadAndPoll).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledOnce();
    expect(prepareSizes).toEqual([1, 1]);
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

  it("prepares 64 intents once and refreshes only each transitioned item", async () => {
    let activeKey = "";
    let activeContent = "";
    let activeResult: {
      readonly id: string;
      readonly key: string;
      readonly status: "completed";
      readonly chunks_count: number;
      readonly file_size: number;
      readonly metadata: Readonly<Record<string, string>>;
    } | undefined;
    const authority = createMemoryManagedItemAuthority();
    const prepareSizes: number[] = [];
    const originalPrepare = authority.prepareManagedItems.bind(authority);
    vi.spyOn(authority, "prepareManagedItems").mockImplementation(async (...args) => {
      const intents = args[3];
      if (prepareSizes.length > 0) {
        const current = intents[0];
        if (
          intents.length !== 1 ||
          current === undefined ||
          authority.readManagedItemEffect(args[0], args[1], current.item_key)?.state === "INTENT"
        ) {
          throw new Error("scalar refresh must follow this item's durable state transition");
        }
      }
      prepareSizes.push(intents.length);
      return originalPrepare(...args);
    });
    const items = Array.from({ length: 64 }, (_, index) => ({
      ...item,
      item_key: `projection-item-${index + 1}`,
      canonical_section_id: `section-${index + 1}`,
      normalized_offset_map_ref: `normalized-bytes:${index * 19}:${(index + 1) * 19}`,
    }));
    const port = createManagedProjectionTestPort({
      authority,
      profile,
      namespace: {
        get() {
          return {
            items: {
              async uploadAndPoll(key, content, options) {
                if (typeof content !== "string") {
                  throw new Error("test managed document must use the text upload form");
                }
                activeKey = key;
                activeContent = content;
                activeResult = {
                  id: `provider-${key}`,
                  key,
                  status: "completed",
                  chunks_count: 1,
                  file_size: new TextEncoder().encode(content).byteLength,
                  metadata: options?.metadata ?? {},
                };
                return activeResult;
              },
              get() {
                return {
                  async info() {
                    if (activeResult === undefined) throw new Error("missing upload receipt");
                    return activeResult;
                  },
                  async download() { return downloaded(activeKey, activeContent); },
                };
              },
            },
          };
        },
      },
    });

    const result = await port.index(context, "projection-g1", items, TEST_EXECUTION_FENCE);

    expect(result).toMatchObject({
      state: "DEGRADED",
      item_count: 64,
      reason_codes: ["MANAGED_GENERATION_NOT_PROMOTED"],
    });
    expect(prepareSizes).toHaveLength(65);
    expect(prepareSizes[0]).toBe(64);
    expect(prepareSizes.slice(1)).toEqual(Array.from({ length: 64 }, () => 1));
    expect(items.every((projectionItem) =>
      authority.readManagedItemEffect(context, "projection-g1", projectionItem.item_key)?.state ===
        "READBACK_VERIFIED"
    )).toBe(true);
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
      state: "DEGRADED",
      item_count: 1,
      reason_codes: ["MANAGED_GENERATION_NOT_PROMOTED"],
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
      state: "DEGRADED",
      reason_codes: ["MANAGED_GENERATION_NOT_PROMOTED"],
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
