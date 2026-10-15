
import { describe, expect, it } from "vitest";
import type { EvidenceObjectStore, ImmutableObjectReceipt } from "@eliotr/platform-cloudflare";
import {
  MANAGED_TARGET_MANIFEST_CANDIDATE_PROTOCOL_V2,
  MANAGED_TARGET_MANIFEST_COPY_LAYOUT_V2,
  ManagedTargetManifestError,
  type ManagedTargetManifestCandidatePayloadV2,
} from "./managed-target-manifest-contract.js";
import { ManagedTargetManifestTreeWriter, type ManifestTreeObjectRef } from "./managed-target-manifest-tree.js";
import { canonicalProjectionJson, projectionSha256Utf8 } from "./canonical.js";
import {
  putCanonicalManifestObjectIfAbsent,
  readCanonicalManifestObject,
} from "./managed-target-manifest-fragments.js";
import {
  readManagedTargetManifestCandidateTreeV3,
  type ManagedTargetCandidateReadbackCursor,
} from "./managed-target-candidate-readback.js";

const AS_OF = "2026-10-14T16:00:00.000Z";
const TARGET = Object.freeze({
  namespace: "primary-search",
  managed_instance_id: "ai-search-primary",
  managed_generation: "generation-b",
  target_profile_identity_sha256: "a".repeat(64),
});

/** Same in-memory immutable store shape the manifest test support uses. */
function memoryStore(): { readonly objects: Map<string, string>; readonly store: EvidenceObjectStore } {
  const objects = new Map<string, string>();
  const store: EvidenceObjectStore = {
    async putImmutable(write): Promise<ImmutableObjectReceipt> {
      const bytes = new Uint8Array(await new Response(write.body).arrayBuffer());
      const body = new TextDecoder().decode(bytes);
      const digest = await projectionSha256Utf8(body);
      if (digest !== write.expected_sha256 || bytes.byteLength !== write.expected_size_bytes) {
        throw new Error("test store received bytes outside its immutable write receipt");
      }
      const previous = objects.get(write.key);
      if (previous !== undefined && previous !== body) throw new Error("immutable key collision");
      objects.set(write.key, body);
      return {
        key: write.key,
        expected_sha256: write.expected_sha256,
        readback_sha256: digest,
        size_bytes: bytes.byteLength,
        etag: `etag-${digest.slice(0, 12)}`,
        existed_identically: previous !== undefined,
      };
    },
    async putResidencyObject() { throw new Error("candidate readback cannot write residency bytes"); },
    async open(key: string) {
      const body = objects.get(key);
      if (body === undefined) return null;
      const bytes = new TextEncoder().encode(body);
      return { size: bytes.byteLength, body: new Response(bytes).body } as NonNullable<Awaited<ReturnType<EvidenceObjectStore["open"]>>>;
    },
    async deleteForErasure() { throw new Error("candidate readback cannot invoke erasure deletion"); },
  } as EvidenceObjectStore;
  return Object.freeze({ objects, store });
}

async function stageCandidate(copyCount: number): Promise<{
  readonly objects: Map<string, string>;
  readonly store: EvidenceObjectStore;
  readonly candidate: ManagedTargetManifestCandidatePayloadV2;
  readonly candidate_sha256: string;
}> {
  const { objects, store } = memoryStore();
  const prefix = "scope/build/";
  const writer = new ManagedTargetManifestTreeWriter(
    store,
    `${prefix}tree`,
    (s, key, value, metadata) => putCanonicalManifestObjectIfAbsent(s, key, value, metadata),
  );
  let itemCount = 0;
  for (let ordinal = 0; ordinal < copyCount; ordinal += 1) {
    const items = (ordinal % 3) + 1;
    const leafKey = `${prefix}copies/${String(ordinal).padStart(6, "0")}-${"c".repeat(64)}.json`;
    // The producer stores the copy fragment object the leaf names; the readback opens it.
    const leafValue = Object.freeze({
      protocol: "eliotr.managed-target-manifest-copy.v3",
      copy_ordinal: ordinal,
      copy_count: 1,
      item_count: items,
    });
    const leafStored = await putCanonicalManifestObjectIfAbsent(store, leafKey, leafValue, {
      manifest_kind: "managed-target-manifest-project-copy-refs-v2",
    });
    await writer.add(Object.freeze({
      kind: "COPY" as const,
      key: leafKey,
      sha256: leafStored.sha256,
      size_bytes: 128,
      first_copy_ordinal: ordinal,
      last_copy_ordinal: ordinal,
      copy_count: 1,
      item_count: items,
    }));
    itemCount += items;
  }
  const root = copyCount === 0 ? null : await writer.finish();
  if (copyCount > 0 && root === null) throw new Error("producer tree writer emitted no root");

  const requiredSet = Object.freeze({
    protocol: "eliotr.managed-required-project-revisions.v3" as const,
    target: TARGET,
    target_selection: null,
    as_of: AS_OF,
    target_fence: Object.freeze({
      protocol: "eliotr.managed-required-set-target-fence.v2" as const,
      digest: "7".repeat(64),
      target_selection_sha256: "8".repeat(64),
      assignment_heads_sha256: "9".repeat(64),
      required_set_sha256: "a1".repeat(32),
      page_provenance_sha256: "b1".repeat(32),
      assigned_project_count: copyCount,
      project_revision_copy_count: copyCount,
      page_count: 1,
    }),
    assigned_project_count: copyCount,
    project_revision_copy_count: copyCount,
    page_count: 1,
    required_set_digest: "d1".repeat(32),
  });
  const candidate = Object.freeze({
    protocol: MANAGED_TARGET_MANIFEST_CANDIDATE_PROTOCOL_V2,
    manifest_protocol: "eliotr.managed-target-desired-items.v3",
    target: TARGET,
    target_profile_sha256: "d".repeat(64),
    projection_profile_sha256: "e".repeat(64),
    copy_layout: MANAGED_TARGET_MANIFEST_COPY_LAYOUT_V2,
    target_selection: Object.freeze({
      protocol: "eliotr.managed-target-selection.v2" as const,
      domain: "MANAGED_SEARCH_PRODUCT" as const,
      decision_version: 2 as const,
      selection_mode: "STABLE_PHYSICAL_PROFILE_V2" as const,
      product_alias: "primary" as const,
      purpose: "SHADOW" as const,
      registry_revision: 7,
      registry_artifact_sha256: "b".repeat(64),
      v1_exact_profile_identity_sha256: "c".repeat(64),
      target: TARGET,
    }),
    as_of: AS_OF,
    required_set: requiredSet,
    desired_item_count: itemCount,
    desired_item_set_sha256: "f".repeat(64),
    canonical_source_summary: Object.freeze({
      protocol: "eliotr.managed-target-canonical-source-summary.v1" as const,
      canonical_projection_generation_count: copyCount,
      canonical_section_count: itemCount,
      canonical_source_set_sha256: "e1".repeat(32),
      canonical_section_set_sha256: "f1".repeat(32),
    }),
    provider_copy_summary: Object.freeze({
      protocol: "eliotr.managed-target-provider-copy-summary.v1" as const,
      provider_copy_count: copyCount,
      provider_copy_set_sha256: "11".repeat(32),
      provider_item_count: itemCount,
      provider_item_set_sha256: "12".repeat(32),
    }),
    source_authority_sha256: "13".repeat(32),
    post_source_authority_sha256: "14".repeat(32),
    shadow_fence_sha256: "15".repeat(32),
    provider_capacity_policy: "eliotr.ai-search-file-capacity-cloudflare-2026-10-01.v1",
    provider_capacity_receipt_sha256: "16".repeat(32),
    empty_provider_readback: null,
    tree: root === null
      ? null
      : Object.freeze({ key: root.key, sha256: root.sha256, copy_count: copyCount, item_count: itemCount }),
    authority_sha256: "17".repeat(32),
    finalization_state: "REQUIRES_HELD_WRITER_DRAIN_AND_EXPECTED_HEAD_CAS" as const,
  }) as unknown as ManagedTargetManifestCandidatePayloadV2;
  const candidateKey = `${prefix}candidates/${"6".repeat(64)}.json`;
  objects.set(candidateKey, canonicalProjectionJson(candidate));
  return Object.freeze({
    objects,
    store,
    candidate,
    candidate_sha256: await projectionSha256Utf8(canonicalProjectionJson(candidate)),
  });
}

async function loadCursor(
  store: EvidenceObjectStore,
  ref: string,
  sha256: string,
): Promise<ManagedTargetCandidateReadbackCursor> {
  const stored = await readCanonicalManifestObject(store, ref);
  if (stored === null || stored.ref.sha256 !== sha256) throw new Error("readback cursor readback differs");
  return stored.value as ManagedTargetCandidateReadbackCursor;
}

function tamperTree(
  objects: Map<string, string>,
  rootKey: string,
  value: unknown,
): void {
  objects.set(rootKey, canonicalProjectionJson(value));
}

function rootKeyOf(candidate: ManagedTargetManifestCandidatePayloadV2): string {
  return (candidate.tree as unknown as { readonly key: string }).key;
}


describe("managed target candidate tree readback V3", () => {
  it("walks a complete ordered copy tree in bounded durable steps", async () => {
    const copyCount = 120;
    const { store, candidate, candidate_sha256 } = await stageCandidate(copyCount);
    const seen: ManifestTreeObjectRef[] = [];
    let cursor: ManagedTargetCandidateReadbackCursor | undefined;
    let steps = 0;
    let previousNodesVisited = 0;
    while (steps < 1000) {
      steps += 1;
      const step = await readManagedTargetManifestCandidateTreeV3({
        store,
        candidate,
        candidate_sha256,
        ...(cursor === undefined ? {} : { cursor }),
      });
      // nodes_visited is cumulative across the whole read; each step advances it
      // by at most the single per-step object budget.
      expect(step.leaves.length).toBeLessThanOrEqual(24);
      expect(step.nodes_visited - previousNodesVisited).toBeLessThanOrEqual(24);
      expect(step.nodes_visited).toBeGreaterThan(previousNodesVisited);
      previousNodesVisited = step.nodes_visited;
      seen.push(...step.leaves);
      if (step.status === "COMPLETE") {
        expect(step.cursor).toBeNull();
        expect(step.next_ordinal).toBe(copyCount);
        break;
      }
      expect(step.cursor).not.toBeNull();
      cursor = await loadCursor(store, step.cursor?.ref ?? "", step.cursor?.sha256 ?? "");
    }
    expect(steps).toBeGreaterThan(1);
    expect(seen).toHaveLength(copyCount);
    seen.forEach((leaf, index) => {
      expect(leaf.kind).toBe("COPY");
      expect(leaf.first_copy_ordinal).toBe(index);
      expect(leaf.last_copy_ordinal).toBe(index);
      expect(leaf.copy_count).toBe(1);
    });
  });

  it("completes an empty tree without persisting a cursor", async () => {
    const { store, candidate, candidate_sha256 } = await stageCandidate(0);
    const step = await readManagedTargetManifestCandidateTreeV3({ store, candidate, candidate_sha256 });
    expect(step.status).toBe("COMPLETE");
    expect(step.cursor).toBeNull();
    expect(step.leaves).toHaveLength(0);
    expect(step.next_ordinal).toBe(0);
  });

  it("denies a candidate whose tree omits required copies", async () => {
    const { store, candidate, candidate_sha256 } = await stageCandidate(9);
    const tree = candidate.tree as unknown as Record<string, unknown>;
    const forged = { ...candidate, tree: { ...tree, copy_count: 3 } } as unknown as ManagedTargetManifestCandidatePayloadV2;
    await expect(
      readManagedTargetManifestCandidateTreeV3({ store, candidate: forged, candidate_sha256 }),
    ).rejects.toThrowError(ManagedTargetManifestError);
  });

  it("denies a foreign tree node whose stored bytes differ from its parent receipt", async () => {
    const { objects, store, candidate, candidate_sha256 } = await stageCandidate(3);
    const rootKey = rootKeyOf(candidate);
    const root = JSON.parse(objects.get(rootKey) ?? "{}") as { children: { key: string }[] };
    const foreignKey = root.children[0]?.key ?? "";
    expect(foreignKey).not.toBe("");
    tamperTree(objects, foreignKey, {
      protocol: "eliotr.managed-target-manifest-index.v1",
      level: 0,
      first_copy_ordinal: 0,
      last_copy_ordinal: 0,
      copy_count: 1,
      item_count: 99,
      children: [],
    });
    await expect(
      readManagedTargetManifestCandidateTreeV3({ store, candidate, candidate_sha256 }),
    ).rejects.toThrowError(ManagedTargetManifestError);
  });

  it("denies a duplicated copy ordinal in the ordered tree", async () => {
    const { objects, store, candidate, candidate_sha256 } = await stageCandidate(4);
    const rootKey = rootKeyOf(candidate);
    const root = JSON.parse(objects.get(rootKey) ?? "{}") as { children: ManifestTreeObjectRef[] };
    const first = root.children[0];
    if (first === undefined) throw new Error("fixture tree has no first child");
    tamperTree(objects, rootKey, {
      protocol: "eliotr.managed-target-manifest-index.v1",
      level: 1,
      first_copy_ordinal: 0,
      last_copy_ordinal: 1,
      copy_count: 2,
      item_count: first.item_count * 2,
      children: [first, first],
    });
    await expect(
      readManagedTargetManifestCandidateTreeV3({ store, candidate, candidate_sha256 }),
    ).rejects.toThrowError(ManagedTargetManifestError);
  });

  it("denies a candidate whose protocol discriminators are not a stored V3 candidate", async () => {
    const { store, candidate, candidate_sha256 } = await stageCandidate(2);
    const forged = { ...candidate, copy_layout: "PROJECT_COPY_V1" } as unknown as ManagedTargetManifestCandidatePayloadV2;
    await expect(
      readManagedTargetManifestCandidateTreeV3({ store, candidate: forged, candidate_sha256 }),
    ).rejects.toThrowError(ManagedTargetManifestError);
  });

  it("denies a cursor bound to a different candidate", async () => {
    const first = await stageCandidate(40);
    const second = await stageCandidate(4);
    const step = await readManagedTargetManifestCandidateTreeV3({
      store: first.store,
      candidate: first.candidate,
      candidate_sha256: first.candidate_sha256,
    });
    expect(step.status).toBe("CONTINUE");
    const cursor = await loadCursor(first.store, step.cursor?.ref ?? "", step.cursor?.sha256 ?? "");
    await expect(
      readManagedTargetManifestCandidateTreeV3({
        store: second.store,
        candidate: second.candidate,
        candidate_sha256: second.candidate_sha256,
        cursor,
      }),
    ).rejects.toThrowError(ManagedTargetManifestError);
  });

  it("reuses the existing projection-invalid error code rather than adding one", async () => {
    const { store, candidate, candidate_sha256 } = await stageCandidate(2);
    const forged = { ...candidate, copy_layout: "PROJECT_COPY_V1" } as unknown as ManagedTargetManifestCandidatePayloadV2;
    await expect(
      readManagedTargetManifestCandidateTreeV3({ store, candidate: forged, candidate_sha256 }),
    ).rejects.toMatchObject({ code: "MANAGED_TARGET_MANIFEST_PROJECTION_INVALID" });
  });
});



