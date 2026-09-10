import type {
  ErasureFence,
  ErasureRequest,
  PurgeTarget,
} from "@eliotr/contracts";
import { describe, expect, it, vi } from "vitest";
import { createManagedSearchErasureLocationPort } from "./provider-location.js";
import { createR2ErasureLocationPort } from "./r2-location.js";
import type {
  ManagedSearchErasureInstance,
  ManagedSearchErasureNamespace,
} from "./types.js";

const request: ErasureRequest = {
  protocol: "erc.privacy.erasure.v1",
  erasure_ref: { id: "erase-1", revision: 1 },
  requested_by_principal_ref: "privacy-officer-1",
  exact_subject_refs: ["source-revision:revision-1"],
  required_locations: ["ProviderCopy"],
  legal_basis_ref: "delete-request-1",
  admitted_at: "2026-09-01T00:00:00.000Z",
  deadline: "2026-09-08T00:00:00.000Z",
};
const fence: ErasureFence = {
  erasure_id: "erase-1",
  revision: 1,
  lease_owner: "worker-1",
  lease_generation: 1,
  lease_until_ms: Date.UTC(2026, 8, 1, 1),
};

function target(canonicalRef: string): PurgeTarget {
  return {
    target_id: "target-1",
    target_kind: "OBJECT",
    exact_subject_ref: (request.exact_subject_refs[0] ?? (() => { throw new Error("fixture requires one exact subject reference"); })()),
    location: canonicalRef.startsWith("ai-search:") ? "ProviderCopy" : "Projection",
    canonical_ref: canonicalRef,
    identity_digest: "a".repeat(64),
    shared_live_reference_count: 0,
  };
}

describe("erasure location adapters", () => {
  it("deletes one exact AI Search key and proves it is no longer listed", async () => {
    const items = new Map([["provider-1", "source-item-1.md"]]);
    const instance: ManagedSearchErasureInstance = {
      list: vi.fn(async () => ({
        items: [...items].map(([id, key]) => ({ id, key })),
      })),
      delete: vi.fn(async (id: string) => { items.delete(id); }),
      info: vi.fn(async (id: string) => items.has(id) ? { id } : null),
    };
    const namespace: ManagedSearchErasureNamespace = { get: () => instance };
    const port = createManagedSearchErasureLocationPort(namespace);
    const item = target("ai-search:private-prose-g1:source-item-1.md");
    const deletion = await port.purge(request, fence, item);
    expect(deletion.disposition).toBe("DELETE_ACCEPTED");
    await expect(port.verifyAbsent(request, fence, item, deletion)).resolves.toMatchObject({ absent: true });
    expect(instance.delete).toHaveBeenCalledWith("provider-1");
  });

  it("fails closed when a provider exposes duplicate exact keys", async () => {
    const instance: ManagedSearchErasureInstance = {
      list: vi.fn(async () => ({
        items: [
          { id: "provider-1", key: "duplicate.md" },
          { id: "provider-2", key: "duplicate.md" },
        ],
      })),
      delete: vi.fn(async () => undefined),
      info: vi.fn(async () => null),
    };
    const port = createManagedSearchErasureLocationPort({ get: () => instance });
    await expect(port.purge(
      request,
      fence,
      target("ai-search:private-prose-g1:duplicate.md"),
    )).rejects.toMatchObject({ code: "ERASURE_IDENTITY_CONFLICT" });
  });

  it("deletes only objects under the exact projection generation prefix", async () => {
    const keys = new Set([
      "projection/source-a/generation-a/items/one.md",
      "projection/source-a/generation-a/manifests/manifest.json",
      "projection/source-a/generation-b/items/keep.md",
    ]);
    const bucket = {
      async list(options: { prefix?: string }) {
        const objects = [...keys]
          .filter((key) => key.startsWith(options.prefix ?? ""))
          .map((key) => ({ key }));
        return { objects, truncated: false };
      },
      async delete(input: string | string[]) {
        for (const key of Array.isArray(input) ? input : [input]) keys.delete(key);
      },
      async head(key: string) {
        return keys.has(key) ? { key } : null;
      },
    } as unknown as R2Bucket;
    const port = createR2ErasureLocationPort({ evidence_bucket: bucket, work_bucket: bucket });
    const projection = target("r2-work-prefix:projection/source-a/generation-a");
    const deletion = await port.purge(request, fence, projection);
    expect(deletion.disposition).toBe("DELETE_ACCEPTED");
    await expect(port.verifyAbsent(request, fence, projection, deletion)).resolves.toMatchObject({ absent: true });
    expect([...keys]).toEqual(["projection/source-a/generation-b/items/keep.md"]);
  });
});
