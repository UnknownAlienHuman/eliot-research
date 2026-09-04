import { describe, expect, it } from "vitest";

import {
  AI_SEARCH_CUSTOM_METADATA_FIELDS,
  AI_SEARCH_GENERATION_REGISTRY_SCHEMA,
  AiSearchGenerationRegistryError,
  aiSearchGenerationRegistryArtifactDigest,
  createAiSearchGenerationRegistryService,
  decodeAiSearchGenerationRegistrySnapshot,
} from "../../packages/cloudflare-ai/dist/index.js";

const NAMESPACE = "eliotr-managed-search";
const T0 = "2026-09-03T12:00:00.000Z";
const T1 = "2026-09-03T12:01:00.000Z";
const T2 = "2026-09-03T12:02:00.000Z";
const T3 = "2026-09-03T12:03:00.000Z";

function clone(value) {
  return value === null ? null : JSON.parse(JSON.stringify(value));
}

function profile(generation = "embedding-g1", id = "search_instance_g1") {
  return {
    id,
    generation,
    index_method: { vector: true, keyword: true },
    fusion_method: "rrf",
    keyword_tokenizer: "porter",
    keyword_match_mode: "or",
    embedding_model: "@cf/baai/bge-m3",
    reranking: true,
    max_num_results: 20,
    metadata_fields: [...AI_SEARCH_CUSTOM_METADATA_FIELDS],
  };
}

function declaration(
  generation = "embedding-g1",
  id = "search_instance_g1",
  expected = 2,
) {
  return {
    namespace: NAMESPACE,
    profile: profile(generation, id),
    expected_item_count: expected,
    declared_at: T0,
  };
}

class MemoryRegistryStore {
  snapshot = null;
  compare_calls = 0;
  read_calls = 0;
  mode = "normal";

  async read(namespace) {
    this.read_calls += 1;
    if (this.mode === "read-throws") {
      throw new Error("fixture read unavailable");
    }
    if (
      this.snapshot !== null &&
      this.snapshot.artifact.namespace !== namespace
    ) {
      return null;
    }
    return clone(this.snapshot);
  }

  async compareAndSwap(command) {
    this.compare_calls += 1;
    if (this.mode === "throw-before") {
      throw new Error("fixture timeout before write");
    }

    const currentRevision = this.snapshot?.artifact.revision ?? null;
    const currentDigest = this.snapshot?.artifact_sha256 ?? null;
    if (
      this.mode === "conflict" ||
      currentRevision !== command.expected_revision ||
      currentDigest !== command.expected_artifact_sha256
    ) {
      if (this.snapshot === null) {
        throw new Error("fixture conflict lacks current state");
      }
      return {
        outcome: "CONFLICT",
        namespace: this.snapshot.artifact.namespace,
        revision: this.snapshot.artifact.revision,
        artifact_sha256: this.snapshot.artifact_sha256,
      };
    }

    if (
      this.snapshot !== null &&
      this.snapshot.artifact.revision === command.artifact.revision &&
      this.snapshot.artifact_sha256 === command.artifact_sha256
    ) {
      return {
        outcome: "REPLAY",
        namespace: command.namespace,
        revision: command.artifact.revision,
        artifact_sha256: command.artifact_sha256,
      };
    }

    if (this.mode === "applied-without-write") {
      return {
        outcome: "APPLIED",
        namespace: command.namespace,
        revision: command.artifact.revision,
        artifact_sha256: command.artifact_sha256,
      };
    }

    this.snapshot = clone({
      artifact: command.artifact,
      artifact_sha256: command.artifact_sha256,
    });
    if (this.mode === "throw-after") {
      throw new Error("fixture lost acknowledgement");
    }
    if (this.mode === "malformed-after") {
      return { outcome: "APPLIED", extra: true };
    }
    return {
      outcome: "APPLIED",
      namespace: command.namespace,
      revision: command.artifact.revision,
      artifact_sha256: command.artifact_sha256,
    };
  }
}

async function completeGeneration(service, generation, timestamp = T1) {
  return service.observe(NAMESPACE, {
    generation,
    indexed_item_count: 2,
    readback_item_count: 2,
    failed_item_count: 0,
    mismatch_count: 0,
    golden_set_result_ref: `golden-${generation}`,
    observed_at: timestamp,
  });
}

function expectRegistryError(code, ambiguousEffect = "NONE") {
  return expect.objectContaining({
    name: "AiSearchGenerationRegistryError",
    code,
    ambiguous_effect: ambiguousEffect,
  });
}

describe("durable AI Search generation registry", () => {
  it("creates one canonical registry and treats an exact declaration as existing", async () => {
    const store = new MemoryRegistryStore();
    const service = createAiSearchGenerationRegistryService(store);

    const created = await service.declare(declaration());
    expect(created).toMatchObject({
      operation: "DECLARE",
      disposition: "CREATED",
      namespace: NAMESPACE,
      generation: "embedding-g1",
      previous_revision: null,
      revision: 1,
      active_head_generation: null,
    });
    expect(created.artifact_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(store.compare_calls).toBe(1);

    const replay = await service.declare(declaration());
    expect(replay).toMatchObject({
      operation: "DECLARE",
      disposition: "EXISTING",
      previous_revision: 1,
      revision: 1,
    });
    expect(store.compare_calls).toBe(1);

    const snapshot = await service.read(NAMESPACE);
    expect(snapshot?.artifact).toMatchObject({
      schema: AI_SEARCH_GENERATION_REGISTRY_SCHEMA,
      namespace: NAMESPACE,
      revision: 1,
      registry: { active_head_generation: null },
    });
    expect(snapshot?.artifact.registry.generations).toHaveLength(1);
  });

  it("persists monotonic shadow observations and active-head promotion", async () => {
    const store = new MemoryRegistryStore();
    const service = createAiSearchGenerationRegistryService(store);
    await service.declare(declaration());

    const partial = await service.observe(NAMESPACE, {
      generation: "embedding-g1",
      indexed_item_count: 1,
      readback_item_count: 1,
      failed_item_count: 0,
      mismatch_count: 0,
      observed_at: T1,
    });
    expect(partial).toMatchObject({ disposition: "UPDATED", revision: 2 });

    const complete = await completeGeneration(service, "embedding-g1", T2);
    expect(complete).toMatchObject({ disposition: "UPDATED", revision: 3 });

    const promoted = await service.promote(NAMESPACE, {
      expected_active_head_generation: null,
      target_generation: "embedding-g1",
      promoted_at: T3,
    });
    expect(promoted).toMatchObject({
      disposition: "UPDATED",
      revision: 4,
      active_head_generation: "embedding-g1",
    });

    const existing = await service.promote(NAMESPACE, {
      expected_active_head_generation: "embedding-g1",
      target_generation: "embedding-g1",
      promoted_at: T3,
    });
    expect(existing).toMatchObject({
      disposition: "EXISTING",
      revision: 4,
    });
    expect(store.compare_calls).toBe(4);
  });

  it("atomically retires the previous active generation", async () => {
    const store = new MemoryRegistryStore();
    const service = createAiSearchGenerationRegistryService(store);
    await service.declare(declaration());
    await completeGeneration(service, "embedding-g1");
    await service.promote(NAMESPACE, {
      expected_active_head_generation: null,
      target_generation: "embedding-g1",
      promoted_at: T2,
    });

    await service.declare(
      declaration("embedding-g2", "search_instance_g2"),
    );
    await completeGeneration(service, "embedding-g2", T2);
    await service.promote(NAMESPACE, {
      expected_active_head_generation: "embedding-g1",
      target_generation: "embedding-g2",
      promoted_at: T3,
    });

    const snapshot = await service.read(NAMESPACE);
    expect(snapshot?.artifact.registry.active_head_generation).toBe(
      "embedding-g2",
    );
    expect(
      snapshot?.artifact.registry.generations.map(({ generation, state }) => ({
        generation,
        state,
      })),
    ).toEqual([
      { generation: "embedding-g1", state: "RETIRED" },
      { generation: "embedding-g2", state: "ACTIVE" },
    ]);
  });

  it("reconciles a lost CAS acknowledgement without issuing a second write", async () => {
    const store = new MemoryRegistryStore();
    store.mode = "throw-after";
    const service = createAiSearchGenerationRegistryService(store);

    const receipt = await service.declare(declaration());
    expect(receipt.disposition).toBe("RECONCILED");
    expect(store.compare_calls).toBe(1);
    expect(store.read_calls).toBe(2);
  });

  it("reconciles a malformed write receipt only through authoritative readback", async () => {
    const store = new MemoryRegistryStore();
    store.mode = "malformed-after";
    const service = createAiSearchGenerationRegistryService(store);

    const receipt = await service.declare(declaration());
    expect(receipt.disposition).toBe("RECONCILED");
    expect(store.compare_calls).toBe(1);
  });

  it("never retries an unresolved compare-and-swap", async () => {
    const store = new MemoryRegistryStore();
    store.mode = "throw-before";
    const service = createAiSearchGenerationRegistryService(store);

    await expect(service.declare(declaration())).rejects.toEqual(
      expectRegistryError(
        "AI_SEARCH_REGISTRY_WRITE_UNCERTAIN",
        "REGISTRY_CAS",
      ),
    );
    expect(store.compare_calls).toBe(1);
  });

  it("fails closed when an applied receipt lacks committed readback", async () => {
    const store = new MemoryRegistryStore();
    store.mode = "applied-without-write";
    const service = createAiSearchGenerationRegistryService(store);

    await expect(service.declare(declaration())).rejects.toEqual(
      expectRegistryError(
        "AI_SEARCH_REGISTRY_READBACK_MISMATCH",
        "REGISTRY_CAS",
      ),
    );
    expect(store.compare_calls).toBe(1);
  });

  it("surfaces compare-and-swap races as retryable conflicts", async () => {
    const store = new MemoryRegistryStore();
    const service = createAiSearchGenerationRegistryService(store);
    await service.declare(declaration());
    store.mode = "conflict";

    await expect(
      service.observe(NAMESPACE, {
        generation: "embedding-g1",
        indexed_item_count: 1,
        readback_item_count: 1,
        failed_item_count: 0,
        mismatch_count: 0,
        observed_at: T1,
      }),
    ).rejects.toMatchObject({
      code: "AI_SEARCH_REGISTRY_WRITE_CONFLICT",
      retryable: true,
      ambiguous_effect: "NONE",
    });
  });

  it("rejects generation identity reuse with different bytes before CAS", async () => {
    const store = new MemoryRegistryStore();
    const service = createAiSearchGenerationRegistryService(store);
    await service.declare(declaration());

    await expect(
      service.declare(declaration("embedding-g1", "search_instance_g1", 3)),
    ).rejects.toEqual(
      expectRegistryError("AI_SEARCH_REGISTRY_GENERATION_CONFLICT"),
    );
    expect(store.compare_calls).toBe(1);
  });

  it("strictly rejects corrupted, noncanonical, and cross-namespace snapshots", async () => {
    const store = new MemoryRegistryStore();
    const service = createAiSearchGenerationRegistryService(store);
    await service.declare(declaration());
    await service.declare(
      declaration("embedding-g2", "search_instance_g2"),
    );
    const valid = clone(store.snapshot);

    const unknown = clone(valid);
    unknown.extra = true;
    await expect(
      decodeAiSearchGenerationRegistrySnapshot(unknown, NAMESPACE),
    ).rejects.toEqual(
      expectRegistryError("AI_SEARCH_REGISTRY_READBACK_INVALID"),
    );

    const driftedDigest = clone(valid);
    driftedDigest.artifact_sha256 = "0".repeat(64);
    await expect(
      decodeAiSearchGenerationRegistrySnapshot(driftedDigest, NAMESPACE),
    ).rejects.toEqual(
      expectRegistryError("AI_SEARCH_REGISTRY_READBACK_INVALID"),
    );

    const reversed = clone(valid);
    reversed.artifact.registry.generations.reverse();
    reversed.artifact_sha256 = await aiSearchGenerationRegistryArtifactDigest(
      reversed.artifact,
    );
    await expect(
      decodeAiSearchGenerationRegistrySnapshot(reversed, NAMESPACE),
    ).rejects.toEqual(
      expectRegistryError("AI_SEARCH_REGISTRY_READBACK_INVALID"),
    );

    await expect(
      decodeAiSearchGenerationRegistrySnapshot(valid, "another-namespace"),
    ).rejects.toEqual(
      expectRegistryError("AI_SEARCH_REGISTRY_READBACK_INVALID"),
    );
  });

  it("fails before mutation on read failure and malformed store capability", async () => {
    const store = new MemoryRegistryStore();
    store.mode = "read-throws";
    const service = createAiSearchGenerationRegistryService(store);
    await expect(service.declare(declaration())).rejects.toMatchObject({
      code: "AI_SEARCH_REGISTRY_READ_FAILED",
      retryable: true,
      ambiguous_effect: "NONE",
    });
    expect(store.compare_calls).toBe(0);

    expect(() =>
      createAiSearchGenerationRegistryService({ read() {} }),
    ).toThrow(AiSearchGenerationRegistryError);
  });

  it("exposes only the bounded registry operations", () => {
    const service = createAiSearchGenerationRegistryService(
      new MemoryRegistryStore(),
    );
    expect(Object.keys(service).sort()).toEqual([
      "declare",
      "observe",
      "promote",
      "read",
    ]);
  });
});
