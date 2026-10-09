import {
  context,
  createManagedProjectionTestPort,
  createMemoryManagedItemAuthority,
  downloaded,
  item,
  profile,
} from "./managed-index.test-support.js";
import {
  createManagedProjectionPort,
  type ProjectionAiSearchNamespace,
} from "./managed-index.js";
import { createCurrentnessGuardedProjectionAuthority } from "./projection-execution-delivery-handler.js";
import type {
  ManagedProjectionPort,
  ManagedProjectionReceipt,
  ProjectionSettlement,
} from "@eliotr/cloudflare-projection";
import { describe, expect, it, vi } from "vitest";

const executionFence = {
  operation_id: "managed-generation-test",
  lease_owner: "managed-generation-test-worker",
  lease_generation: 1,
} satisfies Parameters<ManagedProjectionPort["index"]>[3];

describe("managed AI Search generation reconciliation", () => {
  it("rejects stale or foreign managed generation metadata on provider readback", async () => {
    let key = "";
    let size = 0;
    let uploadedMetadata: Readonly<Record<string, string>> = {};
    const uploadAndPoll = vi.fn(async (
      uploadedKey: string,
      content: string,
      options?: { readonly metadata?: Readonly<Record<string, string>> },
    ) => {
      key = uploadedKey;
      size = new TextEncoder().encode(content).byteLength;
      uploadedMetadata = options?.metadata ?? {};
      return {
        id: "provider-item-1",
        key,
        status: "completed",
        chunks_count: 1,
        file_size: size,
        metadata: uploadedMetadata,
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
                  async info() {
                    return {
                      id: "provider-item-1",
                      key,
                      status: "completed",
                      chunks_count: 1,
                      file_size: size,
                      metadata: {
                        ...uploadedMetadata,
                        projection_generation: "g0",
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

    await expect(port.index(context, "projection-g1", [item], executionFence)).resolves.toMatchObject({
      state: "DEGRADED",
      reason_codes: ["MANAGED_INDEX_READBACK_FAILED"],
    });
    expect(uploadedMetadata.projection_generation).toBe("g1");
    expect(uploadAndPoll).toHaveBeenCalledOnce();
  });

  it("keeps exact item readback in shadow state until the managed generation is promoted", async () => {
    let key = "";
    let size = 0;
    let metadata: Readonly<Record<string, string>> = {};
    const port = createManagedProjectionTestPort({
      authority: createMemoryManagedItemAuthority(),
      profile: { ...profile, managed_generation_active: false },
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
                      metadata,
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
    await expect(port.index(context, "projection-g1", [item], executionFence)).resolves.toMatchObject({
      state: "DEGRADED",
      shadow_receipt_ref: expect.any(String),
      shadow_readback_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      reason_codes: ["MANAGED_GENERATION_NOT_PROMOTED"],
    });
  });

  it("blocks new target-bound item keys on ACTIVE before dispatch while allowing SHADOW upload", async () => {
    const targetBoundProjectionGeneration = "projection-managed-items-v2-target-1";
    const targetBoundItem = {
      ...item,
      item_key: "projection-managed-items-v2-item-1",
      projection_generation: targetBoundProjectionGeneration,
    };
    const createCase = (managedGenerationActive: boolean) => {
      let key = "";
      let size = 0;
      let metadata: Readonly<Record<string, string>> = {};
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
      const beginDispatch = vi.spyOn(authority, "beginManagedItemDispatch");
      const port = createManagedProjectionTestPort({
        authority,
        profile: { ...profile, managed_generation_active: managedGenerationActive },
        namespace: {
          get() {
            return {
              items: {
                uploadAndPoll,
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
            };
          },
        },
      });
      return { beginDispatch, port, uploadAndPoll };
    };

    const active = createCase(true);
    await expect(
      active.port.index(context, targetBoundProjectionGeneration, [targetBoundItem], executionFence),
    ).resolves.toMatchObject({
      state: "DEGRADED",
      reason_codes: ["MANAGED_INDEX_NOT_COMPLETED"],
    });
    expect(active.beginDispatch).not.toHaveBeenCalled();
    expect(active.uploadAndPoll).not.toHaveBeenCalled();

    const shadow = createCase(false);
    await expect(
      shadow.port.index(context, targetBoundProjectionGeneration, [targetBoundItem], executionFence),
    ).resolves.toMatchObject({
      state: "DEGRADED",
      shadow_receipt_ref: expect.any(String),
      shadow_readback_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      reason_codes: ["MANAGED_GENERATION_NOT_PROMOTED"],
    });
    expect(shadow.beginDispatch).toHaveBeenCalledOnce();
    expect(shadow.uploadAndPoll).toHaveBeenCalledOnce();
  });

  it("rejects projection-generation drift before upload", async () => {
    const uploadAndPoll = vi.fn();
    const port = createManagedProjectionTestPort({
      authority: createMemoryManagedItemAuthority(),
      profile,
      namespace: {
        get() {
          return {
            items: {
              uploadAndPoll,
              get() {
                throw new Error("readback must not run");
              },
            },
          };
        },
      },
    });
    await expect(port.index(context, "projection-g2", [item], executionFence)).resolves.toMatchObject({
      state: "DEGRADED",
      reason_codes: ["PROJECTION_INPUT_INVALID"],
    });
    expect(uploadAndPoll).not.toHaveBeenCalled();
  });

  it("degrades when the Search registry digest changes after the provider effect", async () => {
    const initialRegistryDigest = "a".repeat(64);
    let currentRegistryDigest = initialRegistryDigest;
    const isCurrentTarget = vi.fn(async (fence: typeof executionFence) => {
      expect(fence).toBe(executionFence);
      return currentRegistryDigest === initialRegistryDigest;
    });
    const list = vi.fn(async () => {
      throw new Error("stale target must not be read back");
    });
    const uploadAndPoll = vi.fn(async (key: string) => {
      currentRegistryDigest = "b".repeat(64);
      return { id: "provider-item-1", key };
    });
    const namespace: ProjectionAiSearchNamespace = {
      get() {
        return {
          items: {
            uploadAndPoll,
            list,
            get() {
              throw new Error("stale target must not resolve an item handle");
            },
          },
        };
      },
    };
    const port = createManagedProjectionPort({
      authority: createMemoryManagedItemAuthority(),
      isCurrentTarget,
      namespace,
      profile,
    });

    await expect(
      port.index(context, "projection-g1", [item], executionFence),
    ).resolves.toMatchObject({
      state: "DEGRADED",
      reason_codes: ["MANAGED_GENERATION_STALE"],
    });
    expect(uploadAndPoll).toHaveBeenCalledOnce();
    expect(isCurrentTarget).toHaveBeenCalledTimes(4);
    expect(list).not.toHaveBeenCalled();
  });

  it("blocks settlement and terminal replay when the registry changes after managed READY", async () => {
    const authority = createMemoryManagedItemAuthority();
    const settle = vi.spyOn(authority, "settle");
    const readTerminal = vi.spyOn(authority, "readTerminal");
    let registryCurrent = true;
    const isCurrentTarget = vi.fn(async (fence: typeof executionFence) => {
      expect(fence).toBe(executionFence);
      return registryCurrent;
    });
    const guardedAuthority = createCurrentnessGuardedProjectionAuthority(authority, {
      isCurrentSnapshot: async () => registryCurrent,
      isCurrentTarget,
    });
    const managed = {
      state: "READY",
      receipt_ref: "managed-receipt-1",
      readback_digest: "c".repeat(64),
      item_count: 1,
      instance_id: profile.managed_instance_id,
      managed_generation: profile.managed_generation,
      reason_codes: [],
    } satisfies ManagedProjectionReceipt;
    const settlement = {
      outcome: "SUCCEEDED",
      reason_codes: [],
      managed,
    } satisfies ProjectionSettlement;

    expect(managed.state).toBe("READY");
    registryCurrent = false;
    await expect(
      guardedAuthority.settle(
        context,
        "projection-g1",
        profile,
        settlement,
        executionFence,
      ),
    ).rejects.toMatchObject({ code: "PROJECTION_AUTHORITY_CONFLICT" });
    expect(isCurrentTarget).toHaveBeenCalledWith(executionFence);
    expect(settle).not.toHaveBeenCalled();
    await expect(
      guardedAuthority.readTerminal(context, "projection-g1", profile),
    ).resolves.toBeNull();
    expect(readTerminal).not.toHaveBeenCalled();
  });
});
