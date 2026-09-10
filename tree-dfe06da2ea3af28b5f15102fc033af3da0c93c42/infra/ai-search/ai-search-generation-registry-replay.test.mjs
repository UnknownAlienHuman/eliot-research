import { describe, expect, it } from "vitest";

import {
  AI_SEARCH_CUSTOM_METADATA_FIELDS,
  createAiSearchGenerationRegistryService,
} from "../../packages/cloudflare-ai/dist/index.js";

const NAMESPACE = "eliotr-managed-search";
const T0 = "2026-09-03T12:00:00.000Z";
const T1 = "2026-09-03T12:01:00.000Z";
const T2 = "2026-09-03T12:02:00.000Z";
const T3 = "2026-09-03T12:03:00.000Z";
const T4 = "2026-09-03T12:04:00.000Z";

function clone(value) {
  return value === null ? null : JSON.parse(JSON.stringify(value));
}

function profile(generation, id) {
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
  generation,
  id,
  expectedItemCount = 1,
  declaredAt = T0,
) {
  return {
    namespace: NAMESPACE,
    profile: profile(generation, id),
    expected_item_count: expectedItemCount,
    declared_at: declaredAt,
  };
}

class MemoryRegistryStore {
  snapshot = null;
  compare_calls = 0;

  async read(namespace) {
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
    expect(command.expected_revision).toBe(
      this.snapshot?.artifact.revision ?? null,
    );
    expect(command.expected_artifact_sha256).toBe(
      this.snapshot?.artifact_sha256 ?? null,
    );
    this.snapshot = clone({
      artifact: command.artifact,
      artifact_sha256: command.artifact_sha256,
    });
    return {
      outcome: "APPLIED",
      namespace: command.namespace,
      revision: command.artifact.revision,
      artifact_sha256: command.artifact_sha256,
    };
  }
}

async function completeGeneration(service, generation, observedAt) {
  await service.observe(NAMESPACE, {
    generation,
    indexed_item_count: 1,
    readback_item_count: 1,
    failed_item_count: 0,
    mismatch_count: 0,
    golden_set_result_ref: `golden-${generation}`,
    observed_at: observedAt,
  });
}

describe("durable AI Search generation registry replay", () => {
  it("replays immutable declarations after generations become active or retired", async () => {
    const store = new MemoryRegistryStore();
    const service = createAiSearchGenerationRegistryService(store);
    const first = declaration("embedding-g1", "search_instance_g1");
    const second = declaration("embedding-g2", "search_instance_g2");

    await service.declare(first);
    await completeGeneration(service, "embedding-g1", T1);
    await service.promote(NAMESPACE, {
      expected_active_head_generation: null,
      target_generation: "embedding-g1",
      promoted_at: T2,
    });
    await service.declare(second);
    await completeGeneration(service, "embedding-g2", T2);
    await service.promote(NAMESPACE, {
      expected_active_head_generation: "embedding-g1",
      target_generation: "embedding-g2",
      promoted_at: T3,
    });

    const writesBeforeReplay = store.compare_calls;
    await expect(service.declare(first)).resolves.toMatchObject({
      disposition: "EXISTING",
      generation: "embedding-g1",
    });
    await expect(service.declare(second)).resolves.toMatchObject({
      disposition: "EXISTING",
      generation: "embedding-g2",
    });
    expect(store.compare_calls).toBe(writesBeforeReplay);

    await expect(
      service.declare(
        declaration("embedding-g1", "search_instance_g1", 2),
      ),
    ).rejects.toMatchObject({
      code: "AI_SEARCH_REGISTRY_GENERATION_CONFLICT",
    });
    await expect(
      service.declare(
        declaration("embedding-g1", "search_instance_g1", 1, T4),
      ),
    ).rejects.toMatchObject({
      code: "AI_SEARCH_REGISTRY_GENERATION_CONFLICT",
    });
    expect(store.compare_calls).toBe(writesBeforeReplay);
  });

  it("replays the original initial-promotion request after the active head advances", async () => {
    const store = new MemoryRegistryStore();
    const service = createAiSearchGenerationRegistryService(store);
    await service.declare(
      declaration("embedding-g1", "search_instance_g1"),
    );
    await completeGeneration(service, "embedding-g1", T1);
    const request = {
      expected_active_head_generation: null,
      target_generation: "embedding-g1",
      promoted_at: T2,
    };
    await service.promote(NAMESPACE, request);

    const writesBeforeReplay = store.compare_calls;
    await expect(service.promote(NAMESPACE, request)).resolves.toMatchObject({
      disposition: "EXISTING",
      generation: "embedding-g1",
      active_head_generation: "embedding-g1",
    });
    expect(store.compare_calls).toBe(writesBeforeReplay);

    await expect(
      service.promote(NAMESPACE, { ...request, promoted_at: T3 }),
    ).rejects.toMatchObject({ code: "AI_SEARCH_ACTIVE_HEAD_CONFLICT" });
    expect(store.compare_calls).toBe(writesBeforeReplay);
  });

  it("replays the original rotation request only with the exact retired head and timestamp", async () => {
    const store = new MemoryRegistryStore();
    const service = createAiSearchGenerationRegistryService(store);
    await service.declare(
      declaration("embedding-g1", "search_instance_g1"),
    );
    await completeGeneration(service, "embedding-g1", T1);
    await service.promote(NAMESPACE, {
      expected_active_head_generation: null,
      target_generation: "embedding-g1",
      promoted_at: T1,
    });
    await service.declare(
      declaration("embedding-g2", "search_instance_g2"),
    );
    await completeGeneration(service, "embedding-g2", T2);
    const request = {
      expected_active_head_generation: "embedding-g1",
      target_generation: "embedding-g2",
      promoted_at: T3,
    };
    await service.promote(NAMESPACE, request);

    const writesBeforeReplay = store.compare_calls;
    await expect(service.promote(NAMESPACE, request)).resolves.toMatchObject({
      disposition: "EXISTING",
      generation: "embedding-g2",
      active_head_generation: "embedding-g2",
    });
    expect(store.compare_calls).toBe(writesBeforeReplay);

    await expect(
      service.promote(NAMESPACE, { ...request, promoted_at: T4 }),
    ).rejects.toMatchObject({ code: "AI_SEARCH_ACTIVE_HEAD_CONFLICT" });
    await expect(
      service.promote(NAMESPACE, {
        ...request,
        expected_active_head_generation: "embedding-g0",
      }),
    ).rejects.toMatchObject({ code: "AI_SEARCH_ACTIVE_HEAD_CONFLICT" });
    expect(store.compare_calls).toBe(writesBeforeReplay);
  });

  it("admits an exact replay at the 64-generation bound but rejects a 65th generation", async () => {
    const store = new MemoryRegistryStore();
    const service = createAiSearchGenerationRegistryService(store);
    for (let index = 0; index < 64; index += 1) {
      const suffix = String(index).padStart(2, "0");
      await service.declare(
        declaration(
          `embedding-g${suffix}`,
          `search_instance_g${suffix}`,
        ),
      );
    }

    const writesAtBound = store.compare_calls;
    await expect(
      service.declare(
        declaration("embedding-g63", "search_instance_g63"),
      ),
    ).resolves.toMatchObject({
      disposition: "EXISTING",
      generation: "embedding-g63",
    });
    expect(store.compare_calls).toBe(writesAtBound);

    await expect(
      service.declare(
        declaration("embedding-g64", "search_instance_g64"),
      ),
    ).rejects.toMatchObject({ code: "AI_SEARCH_REGISTRY_INPUT_INVALID" });
    expect(store.compare_calls).toBe(writesAtBound);
  });
});
