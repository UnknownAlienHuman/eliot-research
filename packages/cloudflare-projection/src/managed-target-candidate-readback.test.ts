
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
import { putCanonicalManifestObjectIfAbsent } from "./managed-target-manifest-fragments.js";
import { readManagedTargetManifestCandidateTreeV3 } from "./managed-target-candidate-readback.js";

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
    let cursor: { readonly ref: string; readonly sha256: string } | null = null;
    let steps = 0;
    let previousNodesVisited = 0;
    while (steps < 1000) {
      steps += 1;
      const step = await readManagedTargetManifestCandidateTreeV3({
        store,
        candidate,
        candidate_sha256,
        ...(cursor === null ? {} : { cursor }),
      });
      // nodes_visited is cumulative; each step advances it by at most the object budget.
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
      cursor = step.cursor;
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

  it("reads a single-copy candidate whose tree root is the sole COPY leaf", async () => {
    // The producer tree writer returns that lone leaf unchanged, so the root kind is
    // COPY rather than INDEX. This is the one-copy case the reader must accept.
    const { store, candidate, candidate_sha256 } = await stageCandidate(1);
    const step = await readManagedTargetManifestCandidateTreeV3({ store, candidate, candidate_sha256 });
    expect(step.status).toBe("COMPLETE");
    expect(step.next_ordinal).toBe(1);
    expect(step.leaves).toHaveLength(1);
    expect(step.leaves[0]?.kind).toBe("COPY");
    expect(step.leaves[0]?.first_copy_ordinal).toBe(0);
    expect(step.cursor).toBeNull();
  });

  it("reads a two-copy candidate through a real INDEX node", async () => {
    const { objects, store, candidate, candidate_sha256 } = await stageCandidate(2);
    const rootKey = rootKeyOf(candidate);
    const root = JSON.parse(objects.get(rootKey) ?? "{}") as { protocol: string; children: ManifestTreeObjectRef[] };
    expect(root.protocol).toBe("eliotr.managed-target-manifest-index.v1");
    expect(root.children).toHaveLength(2);

    const seen: ManifestTreeObjectRef[] = [];
    let cursor: { readonly ref: string; readonly sha256: string } | null = null;
    for (let step = 0; step < 20; step += 1) {
      const advanced = await readManagedTargetManifestCandidateTreeV3({
        store,
        candidate,
        candidate_sha256,
        ...(cursor === null ? {} : { cursor }),
      });
      seen.push(...advanced.leaves);
      if (advanced.status === "COMPLETE") break;
      cursor = advanced.cursor;
    }
    expect(seen).toHaveLength(2);
    expect(seen.map((leaf) => leaf.first_copy_ordinal)).toEqual([0, 1]);
  });

  it("keeps the durable cursor inside its bounded DFS stack on a 4096-copy tree", async () => {
    // A breadth-first queue would inflate the whole 4096-copy frontier before the first
    // leaf and overflow the durable cursor byte bound. Depth-first descent must keep the
    // pending stack within MAX_TREE_FANOUT * MAX_TREE_DEPTH, then still deliver complete
    // ordered coverage.
    const copyCount = 4096;
    const { store, candidate, candidate_sha256 } = await stageCandidate(copyCount);
    const first = await readManagedTargetManifestCandidateTreeV3({ store, candidate, candidate_sha256 });
    expect(first.status).toBe("CONTINUE");
    expect(first.cursor).not.toBeNull();
    if (first.cursor === null) throw new Error("a CONTINUE step must persist a cursor");

    const opened = await store.open(first.cursor.ref);
    if (opened === null) throw new Error("durable cursor object is absent");
    const cursorBytes = new TextEncoder().encode(await new Response(opened.body).text());
    expect(cursorBytes.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
    const cursor = JSON.parse(new TextDecoder().decode(cursorBytes)) as {
      readonly pending: readonly ManifestTreeObjectRef[];
    };
    expect(cursor.pending.length).toBeLessThanOrEqual(256 * 12);
    expect(cursor.pending.length).toBeGreaterThan(0);

    let cursor_ref = first.cursor;
    // The first step already delivered some leaves; carry its ordinal forward.
    let ordinal = first.next_ordinal;
    first.leaves.forEach((leaf, index) => {
      expect(leaf.kind).toBe("COPY");
      expect(leaf.first_copy_ordinal).toBe(index);
    });
    for (let step = 0; step < 2000; step += 1) {
      const advanced = await readManagedTargetManifestCandidateTreeV3({
        store,
        candidate,
        candidate_sha256,
        cursor: cursor_ref,
      });
      advanced.leaves.forEach((leaf, index) => {
        expect(leaf.kind).toBe("COPY");
        expect(leaf.first_copy_ordinal).toBe(ordinal + index);
      });
      ordinal += advanced.leaves.length;
      if (advanced.status === "COMPLETE") {
        expect(ordinal).toBe(copyCount);
        return;
      }
      if (advanced.cursor === null) throw new Error("a CONTINUE step must persist a cursor");
      cursor_ref = advanced.cursor;
    }
    throw new Error("resumable readback did not complete the 4096-copy tree");
  });

  it("writes and resumes its durable cursor inside a custom prefix scope", async () => {
    // The writer honours cursor_prefix, so the resume must be read back from that exact
    // scope. A cursor produced under one prefix cannot be replayed under another.
    const { store, candidate, candidate_sha256 } = await stageCandidate(120);
    const first = await readManagedTargetManifestCandidateTreeV3({
      store,
      candidate,
      candidate_sha256,
      cursor_prefix: "custom-prefix",
    });
    expect(first.status).toBe("CONTINUE");
    if (first.cursor === null) throw new Error("a CONTINUE step must persist a cursor");
    expect(first.cursor.ref.startsWith("custom-prefix/" + candidate_sha256 + "/")).toBe(true);

    const resumed = await readManagedTargetManifestCandidateTreeV3({
      store,
      candidate,
      candidate_sha256,
      cursor_prefix: "custom-prefix",
      cursor: first.cursor,
    });
    expect(resumed.status).toBe("CONTINUE");
    if (resumed.cursor === null) throw new Error("a CONTINUE step must persist a cursor");
    expect(resumed.cursor.ref.startsWith("custom-prefix/" + candidate_sha256 + "/")).toBe(true);

    // The same durable cursor is refused when the readback names a different prefix.
    await expect(
      readManagedTargetManifestCandidateTreeV3({
        store,
        candidate,
        candidate_sha256,
        cursor_prefix: "other-prefix",
        cursor: first.cursor,
      }),
    ).rejects.toThrowError(ManagedTargetManifestError);
  });

  it("rejects an unary index chain whose actual depth exceeds its observed bound", async () => {
    // A forged chain of unary INDEX nodes can all declare level 0, so the declared level
    // cannot be the depth authority. The reader tracks its own descent depth and must
    // fail closed at MAX_TREE_DEPTH even though every node claims level 0. The tree holds
    // two copies so the root is an INDEX node rather than an inferred COPY leaf.
    const { objects, store, candidate } = await stageCandidate(2);
    const chainLength = 13;
    const originalRootKey = rootKeyOf(candidate);
    const original = JSON.parse(objects.get(originalRootKey) ?? "{}") as {
      readonly children: readonly ManifestTreeObjectRef[];
    };
    const grandchild = original.children[0];
    if (grandchild === undefined) throw new Error("fixture tree has no first child");

    // Build the chain root -> n1 -> ... -> n13 -> grandchild, each declaring level 0.
    let childRef = grandchild;
    for (let depth = chainLength; depth >= 1; depth -= 1) {
      const key = "scope/build/forged-chain/" + String(depth).padStart(2, "0") + ".json";
      const value = {
        protocol: "eliotr.managed-target-manifest-index.v1",
        level: 0,
        first_copy_ordinal: childRef.first_copy_ordinal,
        last_copy_ordinal: childRef.last_copy_ordinal,
        copy_count: childRef.copy_count,
        item_count: childRef.item_count,
        children: [childRef],
      };
      objects.set(key, canonicalProjectionJson(value));
      childRef = {
        kind: "INDEX",
        key,
        sha256: await projectionSha256Utf8(canonicalProjectionJson(value)),
        size_bytes: 128,
        first_copy_ordinal: value.first_copy_ordinal,
        last_copy_ordinal: value.last_copy_ordinal,
        copy_count: value.copy_count,
        item_count: value.item_count,
      };
    }

    // Repoint the candidate at the forged chain root.
    const forgedCandidate = {
      ...candidate,
      tree: { key: childRef.key, sha256: childRef.sha256, copy_count: 2, item_count: candidate.desired_item_count },
    } as unknown as ManagedTargetManifestCandidatePayloadV2;
    const forgedSha = await projectionSha256Utf8(canonicalProjectionJson(forgedCandidate));

    await expect(
      readManagedTargetManifestCandidateTreeV3({ store, candidate: forgedCandidate, candidate_sha256: forgedSha }),
    ).rejects.toThrowError(ManagedTargetManifestError);
  });

  it("completes an empty tree without persisting a cursor", async () => {
    const { store, candidate, candidate_sha256 } = await stageCandidate(0);
    const step = await readManagedTargetManifestCandidateTreeV3({ store, candidate, candidate_sha256 });
    expect(step.status).toBe("COMPLETE");
    expect(step.cursor).toBeNull();
    expect(step.leaves).toHaveLength(0);
    expect(step.next_ordinal).toBe(0);
  });

  it("denies a candidate payload whose bytes do not bind to candidate_sha256", async () => {
    const { store, candidate } = await stageCandidate(3);
    const truth = await projectionSha256Utf8(canonicalProjectionJson(candidate));
    await expect(
      readManagedTargetManifestCandidateTreeV3({
        store,
        candidate,
        candidate_sha256: "0".repeat(64),
      }),
    ).rejects.toThrowError(ManagedTargetManifestError);
    expect(truth).not.toBe("0".repeat(64));
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

  it("denies a forged cursor whose supplied digest differs from its Work bytes", async () => {
    const { store, candidate, candidate_sha256 } = await stageCandidate(40);
    const first = await readManagedTargetManifestCandidateTreeV3({ store, candidate, candidate_sha256 });
    expect(first.status).toBe("CONTINUE");
    const real = first.cursor;
    if (real === null) throw new Error("a CONTINUE step must persist a cursor");
    // An external caller cannot resume from an unauthenticated in-memory cursor value.
    await expect(
      readManagedTargetManifestCandidateTreeV3({
        store,
        candidate,
        candidate_sha256,
        cursor: { ref: real.ref, sha256: "0".repeat(64) },
      }),
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
    const cursor = step.cursor;
    if (cursor === null) throw new Error("a CONTINUE step must persist a cursor");
    await expect(
      readManagedTargetManifestCandidateTreeV3({
        store: second.store,
        candidate: second.candidate,
        candidate_sha256: second.candidate_sha256,
        cursor,
      }),
    ).rejects.toThrowError(ManagedTargetManifestError);
  });

  it("resumes across many durable steps to complete the whole tree", async () => {
    const { store, candidate, candidate_sha256 } = await stageCandidate(200);
    let cursor: { readonly ref: string; readonly sha256: string } | null = null;
    for (let step = 0; step < 500; step += 1) {
      const advanced = await readManagedTargetManifestCandidateTreeV3({
        store,
        candidate,
        candidate_sha256,
        ...(cursor === null ? {} : { cursor }),
      });
      if (advanced.status === "COMPLETE") {
        expect(advanced.next_ordinal).toBe(200);
        return;
      }
      cursor = advanced.cursor;
    }
    throw new Error("resumable readback did not complete");
  });

  it("reuses the existing projection-invalid error code rather than adding one", async () => {
    const { store, candidate, candidate_sha256 } = await stageCandidate(2);
    const forged = { ...candidate, copy_layout: "PROJECT_COPY_V1" } as unknown as ManagedTargetManifestCandidatePayloadV2;
    await expect(
      readManagedTargetManifestCandidateTreeV3({ store, candidate: forged, candidate_sha256 }),
    ).rejects.toMatchObject({ code: "MANAGED_TARGET_MANIFEST_PROJECTION_INVALID" });
  });
});

