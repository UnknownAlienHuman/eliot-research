import { describe, expect, it } from "vitest";

import {
  AI_SEARCH_CUSTOM_METADATA_FIELDS,
  aiSearchGenerationRegistryArtifactDigest,
  buildAiSearchGenerationRegistryArtifact,
  canonicalModelGatewayJson,
  createAiSearchGenerationRegistryService,
  createD1AiSearchGenerationRegistryStore,
} from "../../packages/cloudflare-ai/dist/index.js";

const NAMESPACE = "eliotr-managed-search";
const T0 = "2026-09-04T02:30:00.000Z";
const EMPTY_REGISTRY = Object.freeze({
  active_head_generation: null,
  generations: Object.freeze([]),
});

class D1RegistryFixture {
  row = null;
  mode = "normal";
  calls = [];
  write_attempts = 0;
  mutations = 0;

  constructor() {
    this.database = {
      prepare: (sql) => ({
        bind: (...values) => ({
          first: async () => {
            this.calls.push({ sql, values });
            return this.execute(sql, values);
          },
        }),
      }),
    };
  }

  execute(sql, values) {
    if (sql.startsWith("SELECT ")) {
      return this.row?.namespace === values[0] ? { ...this.row } : null;
    }
    if (!sql.startsWith("INSERT ") && !sql.startsWith("UPDATE ")) {
      throw new Error(`unexpected SQL: ${sql}`);
    }

    this.write_attempts += 1;
    if (this.mode === "throw-before-write") {
      this.mode = "normal";
      throw new Error("fixture write failed before mutation");
    }

    let applied = false;
    if (sql.startsWith("INSERT ")) {
      if (this.row === null) {
        this.row = {
          namespace: String(values[0]),
          revision: Number(values[1]),
          artifact_sha256: String(values[2]),
          artifact_json: String(values[3]),
        };
        applied = true;
      }
    } else if (
      this.row !== null &&
      this.row.namespace === values[0] &&
      this.row.revision === values[1] &&
      this.row.artifact_sha256 === values[2]
    ) {
      this.row = {
        namespace: String(values[0]),
        revision: Number(values[3]),
        artifact_sha256: String(values[4]),
        artifact_json: String(values[5]),
      };
      applied = true;
    }

    if (!applied) return null;
    this.mutations += 1;
    if (this.mode === "throw-after-write") {
      this.mode = "normal";
      throw new Error("fixture lost D1 acknowledgement");
    }
    return { ...this.row };
  }
}

async function snapshot(revision) {
  const artifact = buildAiSearchGenerationRegistryArtifact(
    NAMESPACE,
    revision,
    EMPTY_REGISTRY,
  );
  return Object.freeze({
    artifact,
    artifact_sha256: await aiSearchGenerationRegistryArtifactDigest(artifact),
  });
}

function command(previous, desired) {
  return {
    namespace: NAMESPACE,
    expected_revision: previous?.artifact.revision ?? null,
    expected_artifact_sha256: previous?.artifact_sha256 ?? null,
    artifact: desired.artifact,
    artifact_sha256: desired.artifact_sha256,
  };
}

function storedRow(value) {
  return {
    namespace: value.artifact.namespace,
    revision: value.artifact.revision,
    artifact_sha256: value.artifact_sha256,
    artifact_json: canonicalModelGatewayJson(value.artifact),
  };
}

function profile() {
  return {
    id: "search_instance_g1",
    generation: "embedding-g1",
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

describe("D1 AI Search generation registry store", () => {
  it("creates and advances one canonical authority row under digest CAS", async () => {
    const fixture = new D1RegistryFixture();
    const store = createD1AiSearchGenerationRegistryStore(fixture.database);
    const first = await snapshot(1);
    const second = await snapshot(2);

    await expect(store.compareAndSwap(command(null, first))).resolves.toEqual({
      outcome: "APPLIED",
      namespace: NAMESPACE,
      revision: 1,
      artifact_sha256: first.artifact_sha256,
    });
    await expect(store.read(NAMESPACE)).resolves.toEqual(first);
    await expect(store.compareAndSwap(command(first, second))).resolves.toEqual({
      outcome: "APPLIED",
      namespace: NAMESPACE,
      revision: 2,
      artifact_sha256: second.artifact_sha256,
    });
    await expect(store.read(NAMESPACE)).resolves.toEqual(second);

    expect(fixture.mutations).toBe(2);
    expect(
      fixture.calls.some((call) =>
        call.sql.includes(
          "WHERE namespace = ?1 AND revision = ?2 AND artifact_sha256 = ?3",
        ),
      ),
    ).toBe(true);
  });

  it("classifies repeated create and update commands as exact replay", async () => {
    const fixture = new D1RegistryFixture();
    const store = createD1AiSearchGenerationRegistryStore(fixture.database);
    const first = await snapshot(1);
    const second = await snapshot(2);
    const create = command(null, first);
    const update = command(first, second);

    await store.compareAndSwap(create);
    await expect(store.compareAndSwap(create)).resolves.toMatchObject({
      outcome: "REPLAY",
      revision: 1,
    });
    await store.compareAndSwap(update);
    await expect(store.compareAndSwap(update)).resolves.toMatchObject({
      outcome: "REPLAY",
      revision: 2,
    });
    expect(fixture.write_attempts).toBe(4);
    expect(fixture.mutations).toBe(2);
  });

  it("returns the current authority receipt on stale revision or digest", async () => {
    const fixture = new D1RegistryFixture();
    const store = createD1AiSearchGenerationRegistryStore(fixture.database);
    const first = await snapshot(1);
    const second = await snapshot(2);
    await store.compareAndSwap(command(null, first));

    await expect(
      store.compareAndSwap({
        ...command(first, second),
        expected_artifact_sha256: "f".repeat(64),
      }),
    ).resolves.toEqual({
      outcome: "CONFLICT",
      namespace: NAMESPACE,
      revision: 1,
      artifact_sha256: first.artifact_sha256,
    });
    expect(fixture.mutations).toBe(1);
  });

  it("rejects malformed commands before issuing SQL", async () => {
    const fixture = new D1RegistryFixture();
    const store = createD1AiSearchGenerationRegistryStore(fixture.database);
    const first = await snapshot(1);
    const third = await snapshot(3);

    await expect(
      store.compareAndSwap({
        ...command(null, first),
        expected_revision: 1,
      }),
    ).rejects.toMatchObject({ code: "AI_SEARCH_REGISTRY_INPUT_INVALID" });
    await expect(
      store.compareAndSwap({
        ...command(first, third),
        extra: true,
      }),
    ).rejects.toMatchObject({ code: "AI_SEARCH_REGISTRY_INPUT_INVALID" });
    expect(fixture.calls).toHaveLength(0);
  });

  it("rejects noncanonical and row/artifact-divergent D1 readback", async () => {
    const fixture = new D1RegistryFixture();
    const store = createD1AiSearchGenerationRegistryStore(fixture.database);
    const first = await snapshot(1);

    fixture.row = {
      ...storedRow(first),
      artifact_json: JSON.stringify(first.artifact, null, 2),
    };
    await expect(store.read(NAMESPACE)).rejects.toMatchObject({
      code: "AI_SEARCH_REGISTRY_READBACK_INVALID",
    });

    fixture.row = { ...storedRow(first), revision: 2 };
    await expect(store.read(NAMESPACE)).rejects.toMatchObject({
      code: "AI_SEARCH_REGISTRY_READBACK_INVALID",
    });

    fixture.row = {
      ...storedRow(first),
      artifact_sha256: "0".repeat(64),
    };
    await expect(store.read(NAMESPACE)).rejects.toMatchObject({
      code: "AI_SEARCH_REGISTRY_READBACK_INVALID",
    });
  });

  it("reconciles one lost D1 acknowledgement without a second mutation", async () => {
    const fixture = new D1RegistryFixture();
    fixture.mode = "throw-after-write";
    const service = createAiSearchGenerationRegistryService(
      createD1AiSearchGenerationRegistryStore(fixture.database),
    );

    await expect(
      service.declare({
        namespace: NAMESPACE,
        profile: profile(),
        expected_item_count: 1,
        declared_at: T0,
      }),
    ).resolves.toMatchObject({
      disposition: "RECONCILED",
      revision: 1,
    });
    expect(fixture.write_attempts).toBe(1);
    expect(fixture.mutations).toBe(1);
  });

  it("never retries a D1 CAS whose effect remains unknown", async () => {
    const fixture = new D1RegistryFixture();
    fixture.mode = "throw-before-write";
    const service = createAiSearchGenerationRegistryService(
      createD1AiSearchGenerationRegistryStore(fixture.database),
    );

    await expect(
      service.declare({
        namespace: NAMESPACE,
        profile: profile(),
        expected_item_count: 1,
        declared_at: T0,
      }),
    ).rejects.toMatchObject({
      code: "AI_SEARCH_REGISTRY_WRITE_UNCERTAIN",
      ambiguous_effect: "REGISTRY_CAS",
    });
    expect(fixture.write_attempts).toBe(1);
    expect(fixture.mutations).toBe(0);
  });

  it("rejects a missing D1 capability at composition time", () => {
    expect(() => createD1AiSearchGenerationRegistryStore({})).toThrowError(
      /database binding is invalid/u,
    );
  });
});
