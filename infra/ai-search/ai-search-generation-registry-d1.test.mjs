import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  AI_SEARCH_CUSTOM_METADATA_FIELDS,
  aiSearchGenerationRegistryArtifactDigest,
  buildAiSearchGenerationRegistryArtifact,
  canonicalModelGatewayJson,
  createAiSearchGenerationRegistryService,
  createD1AiSearchGenerationRegistryStore,
} from "../../packages/cloudflare-ai/dist/index.js";
import { projectionDigest } from "../../packages/cloudflare-projection/dist/canonical.js";

const NAMESPACE = "eliotr-managed-search";
const T0 = "2026-09-04T02:30:00.000Z";

class D1RegistryFixture {
  row = null;
  transitions = new Map();
  instances = new Map();
  mode = "normal";
  calls = [];
  write_attempts = 0;
  mutations = 0;
  transition_appends = 0;
  instance_appends = 0;

  constructor() {
    this.database = {
      prepare: (sql) => ({
        bind: (...values) => ({
          first: async () => {
            this.calls.push({ sql, values });
            return this.execute(sql, values);
          },
          run: async () => {
            this.calls.push({ sql, values });
            const result = this.execute(sql, values);
            return { results: result === null ? [] : [result], success: true, meta: { changes: result === null ? 0 : 1 } };
          },
        }),
      }),
      batch: async (statements) => {
        const before = {
          row: this.row === null ? null : { ...this.row },
          transitions: new Map(this.transitions),
          instances: new Map(this.instances),
          mutations: this.mutations,
          transition_appends: this.transition_appends,
          instance_appends: this.instance_appends,
        };
        const loseAck = this.mode === "throw-after-write";
        if (this.mode === "throw-before-batch") {
          this.mode = "normal";
          throw new Error("fixture failed before D1 batch dispatch");
        }
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          if (loseAck) {
            this.mode = "normal";
            throw new Error("fixture lost D1 batch acknowledgement");
          }
          return results;
        } catch (error) {
          if (!loseAck) {
            this.row = before.row;
            this.transitions = before.transitions;
            this.instances = before.instances;
            this.mutations = before.mutations;
            this.transition_appends = before.transition_appends;
            this.instance_appends = before.instance_appends;
          }
          if (this.mode === "throw-at-transition") this.mode = "normal";
          throw error;
        }
      },
    };
  }

  execute(sql, values) {
    if (sql.startsWith("SELECT ") && sql.includes("FROM ai_search_generation_registry_transition")) {
      return this.transitions.get(`${values[0]}:${values[1]}`) ?? null;
    }
    if (sql.startsWith("SELECT ") && sql.includes("FROM ai_search_generation_registry ")) {
      return this.row?.namespace === values[0] ? { ...this.row } : null;
    }
    if (sql.startsWith("INSERT INTO ai_search_generation_registry_transition")) {
      if (this.mode === "throw-at-transition") throw new Error("fixture transition append failed");
      if (
        this.row === null ||
        this.row.namespace !== values[0] ||
        this.row.revision !== values[1] ||
        this.row.artifact_sha256 !== values[6]
      ) return null;
      const key = `${values[0]}:${values[1]}`;
      if (this.transitions.has(key)) {
        throw new Error("UNIQUE constraint failed: generation registry transition revision");
      }
      const row = {
        namespace: String(values[0]),
        revision: Number(values[1]),
        operation: String(values[2]),
        generation: String(values[3]),
        previous_revision: values[4] === null ? null : Number(values[4]),
        previous_artifact_sha256: values[5] === null ? null : String(values[5]),
        artifact_sha256: String(values[6]),
        previous_active_head_generation: values[7] === null ? null : String(values[7]),
        active_head_generation: values[8] === null ? null : String(values[8]),
        transition_json: String(values[9]),
        transition_sha256: String(values[10]),
      };
      this.transitions.set(key, row);
      this.transition_appends += 1;
      return { namespace: row.namespace, revision: row.revision, transition_sha256: row.transition_sha256 };
    }
    if (sql.startsWith("INSERT INTO ai_search_generation_instance_history")) {
      if (
        this.row === null ||
        this.row.namespace !== values[0] ||
        this.row.revision !== values[2]
      ) return null;
      const artifact = JSON.parse(String(values[4]));
      const declared = artifact.registry.generations.find((item) => item.generation === values[1]);
      if (declared === undefined) return null;
      const key = `${values[0]}:${declared.profile.id}`;
      if (this.instances.has(key)) throw new Error("duplicate immutable generation instance id");
      const row = {
        namespace: String(values[0]),
        instance_id: String(declared.profile.id),
        generation: String(values[1]),
        first_registry_revision: Number(values[2]),
        profile_json: canonicalModelGatewayJson(declared.profile),
        profile_sha256: String(values[3]),
      };
      this.instances.set(key, row);
      this.instance_appends += 1;
      return { namespace: row.namespace, instance_id: row.instance_id, generation: row.generation };
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
    return { ...this.row };
  }
}

class SqliteD1Binding {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return {
      bind: (...values) => ({
        first: async () => {
          const row = this.database.prepare(sql).get(...values);
          return row === undefined ? null : { ...row };
        },
        run: async () => ({
          results: this.database.prepare(sql).all(...values).map((row) => ({ ...row })),
          success: true,
        }),
      }),
    };
  }

  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

async function snapshot(revision) {
  const record = {
    namespace: NAMESPACE,
    generation: "embedding-g1",
    profile: profile(),
    state: revision === 1 ? "DECLARED" : "SHADOW_BUILDING",
    expected_item_count: 1,
    indexed_item_count: 0,
    readback_item_count: 0,
    failed_item_count: 0,
    mismatch_count: 0,
    declared_at: T0,
    ...(revision === 1 ? {} : { observed_at: T0 }),
  };
  const artifact = buildAiSearchGenerationRegistryArtifact(
    NAMESPACE,
    revision,
    Object.freeze({
      active_head_generation: null,
      generations: Object.freeze([record]),
    }),
  );
  return Object.freeze({
    artifact,
    artifact_sha256: await aiSearchGenerationRegistryArtifactDigest(artifact),
  });
}

function command(previous, desired) {
  return {
    namespace: NAMESPACE,
    operation: previous === null ? "DECLARE" : "OBSERVE",
    generation: "embedding-g1",
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

function desiredManifest(target) {
  const required = "c".repeat(64);
  return {
    protocol: "eliotr.managed-target-desired-items.v2",
    target,
    copy_layout: "PROJECT_COPY_V1",
    as_of: T0,
    target_fence: {
      protocol: "eliotr.managed-required-set-target-fence.v1",
      digest: "a".repeat(64),
      assignment_heads_sha256: "b".repeat(64),
      required_set_sha256: required,
      page_provenance_sha256: "d".repeat(64),
      assigned_project_count: 1,
      project_revision_copy_count: 1,
      page_count: 1,
    },
    registry_revision_before: null,
    registry_revision_after: null,
    assigned_project_count: 1,
    project_revision_copy_count: 1,
    desired_item_count: 1,
    desired_item_set_digest: "e".repeat(64),
    eligibility_digest: "f".repeat(64),
    required_set_digest: required,
    source_authority_digest: "0".repeat(64),
    manifest_ref: "manifest-root",
    manifest_sha256: "1".repeat(64),
    manifest_size_bytes: 512,
    manifest_tree_ref: "manifest-tree",
    manifest_tree_sha256: "2".repeat(64),
  };
}

function declarationAuthority() {
  return {
    async readDesiredManifest(target) {
      return desiredManifest(target);
    },
    async readCurrentEvidence() {
      throw new Error("promotion evidence is not used by declaration fixtures");
    },
    async readFreshCurrentAuthority() {
      throw new Error("currentness is not used by declaration fixtures");
    },
    async runWithTargetWriterDrain() {
      throw new Error("writer drains are not used by declaration fixtures");
    },
    async assertTargetWriterDrainHold() {
      throw new Error("writer drains are not used by declaration fixtures");
    },
    async reconcileTargetWriterDrain() {
      throw new Error("writer drains are not used by declaration fixtures");
    },
    async readGenerationArchiveAuthorization() {
      throw new Error("archive authority is not used by declaration fixtures");
    },
  };
}

describe("D1 AI Search generation registry store", () => {
  it("creates and advances one canonical authority row under digest CAS", async () => {
    const fixture = new D1RegistryFixture();
    const store = createD1AiSearchGenerationRegistryStore(fixture.database);
    const first = await snapshot(1);
    const second = await snapshot(2);

    await expect(store.compareAndSwap(command(null, first))).resolves.toMatchObject({
      outcome: "APPLIED",
      namespace: NAMESPACE,
      revision: 1,
      artifact_sha256: first.artifact_sha256,
      transition_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    await expect(store.read(NAMESPACE)).resolves.toEqual(first);
    await expect(store.compareAndSwap(command(first, second))).resolves.toMatchObject({
      outcome: "APPLIED",
      namespace: NAMESPACE,
      revision: 2,
      artifact_sha256: second.artifact_sha256,
      transition_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    await expect(store.read(NAMESPACE)).resolves.toEqual(second);

    expect(fixture.mutations).toBe(2);
    expect(fixture.transition_appends).toBe(2);
    expect(fixture.instance_appends).toBe(1);
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
    expect(fixture.write_attempts).toBe(2);
    expect(fixture.mutations).toBe(2);
    expect(fixture.transition_appends).toBe(2);
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
      transition_sha256: expect.any(String),
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

    await store.compareAndSwap(command(null, first));
    fixture.row.artifact_json = JSON.stringify(first.artifact, null, 2);
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

  it("rolls back the registry CAS when the append-only transition insert fails", async () => {
    const fixture = new D1RegistryFixture();
    fixture.mode = "throw-at-transition";
    const store = createD1AiSearchGenerationRegistryStore(fixture.database);
    const first = await snapshot(1);

    await expect(store.compareAndSwap(command(null, first))).rejects.toThrow(/transition append failed/u);
    expect(fixture.row).toBeNull();
    expect(fixture.transitions.size).toBe(0);
    expect(fixture.instances.size).toBe(0);
    expect(fixture.mutations).toBe(0);
  });

  it("does not commit a pointer when the next audit revision is already occupied", async () => {
    const fixture = new D1RegistryFixture();
    const seeded = Object.freeze({ sentinel: "preexisting transition" });
    fixture.transitions.set(`${NAMESPACE}:1`, seeded);
    const store = createD1AiSearchGenerationRegistryStore(fixture.database);
    const first = await snapshot(1);

    await expect(store.compareAndSwap(command(null, first))).rejects.toThrow(/UNIQUE constraint/u);
    expect(fixture.row).toBeNull();
    expect(fixture.transitions.get(`${NAMESPACE}:1`)).toBe(seeded);
    expect(fixture.mutations).toBe(0);
    expect(fixture.transition_appends).toBe(0);
  });

  it("retains the exact archived generation and authorization in its append-only transition", async () => {
    const fixture = new D1RegistryFixture();
    const store = createD1AiSearchGenerationRegistryStore(fixture.database);
    const archivedRecord = {
      namespace: NAMESPACE,
      generation: "embedding-g1",
      profile: profile(),
      state: "INACTIVE_UNQUALIFIED",
      expected_item_count: 1,
      indexed_item_count: 0,
      readback_item_count: 0,
      failed_item_count: 0,
      mismatch_count: 0,
      declared_at: T0,
      inactive_at: T0,
    };
    const firstArtifact = buildAiSearchGenerationRegistryArtifact(
      NAMESPACE,
      1,
      Object.freeze({
        active_head_generation: null,
        generations: Object.freeze([archivedRecord]),
      }),
    );
    const first = Object.freeze({
      artifact: firstArtifact,
      artifact_sha256: await aiSearchGenerationRegistryArtifactDigest(firstArtifact),
    });
    await store.compareAndSwap(command(null, first));

    const canonicalProfile = {
      ...profile(),
      index_method: { ...profile().index_method },
      metadata_fields: [...profile().metadata_fields].sort(),
    };
    const target = {
      namespace: NAMESPACE,
      managed_instance_id: profile().id,
      managed_generation: archivedRecord.generation,
      target_profile_identity_sha256: await projectionDigest(canonicalProfile),
    };
    const recordSha256 = await projectionDigest({
      ...archivedRecord,
      profile: canonicalProfile,
    });
    const archiveAuthorization = {
      protocol: "eliotr.managed-generation-archive-authorization.v1",
      target,
      registry_revision: first.artifact.revision,
      registry_artifact_sha256: first.artifact_sha256,
      generation_record_sha256: recordSha256,
      rollback_window_closed_at: "2026-10-14T18:00:00.000Z",
      trusted_checked_at: "2026-10-14T18:03:00.000Z",
      valid_until: "2026-10-14T19:03:00.000Z",
      backup_ref: "registry-archive/embedding-g1",
      backup_sha256: recordSha256,
      backup_readback_sha256: recordSha256,
      disposition: "ARCHIVE_AUTHORIZED",
    };
    const archivedArtifact = buildAiSearchGenerationRegistryArtifact(
      NAMESPACE,
      2,
      Object.freeze({ active_head_generation: null, generations: Object.freeze([]) }),
    );
    const archivedSnapshot = Object.freeze({
      artifact: archivedArtifact,
      artifact_sha256: await aiSearchGenerationRegistryArtifactDigest(archivedArtifact),
    });
    await expect(store.compareAndSwap({
      namespace: NAMESPACE,
      operation: "ARCHIVE",
      generation: archivedRecord.generation,
      expected_revision: first.artifact.revision,
      expected_artifact_sha256: first.artifact_sha256,
      artifact: archivedArtifact,
      artifact_sha256: archivedSnapshot.artifact_sha256,
      archive_authorization: archiveAuthorization,
    })).resolves.toMatchObject({ outcome: "APPLIED", revision: 2 });

    const audit = fixture.transitions.get(`${NAMESPACE}:2`);
    const event = JSON.parse(audit.transition_json);
    expect(event.operation).toBe("ARCHIVE");
    expect(event.changed_generations).toEqual([expect.objectContaining({
      generation: archivedRecord.generation,
      previous_record_sha256: recordSha256,
      next_record_sha256: null,
      archived_record: { ...archivedRecord, profile: canonicalProfile },
      archive_authorization: archiveAuthorization,
    })]);
    expect(fixture.instances.size).toBe(1);
    await expect(store.read(NAMESPACE)).resolves.toEqual(archivedSnapshot);
  });

  it("uses a real SQLite transaction to roll back the pointer on audit-revision collision", async () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(
        "CREATE TABLE schema_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT; " +
        "INSERT INTO schema_state(key, value, updated_at) VALUES ('schema_generation','search-v3','2026-09-01T00:00:00Z');",
      );
      database.exec(readFileSync(
        new URL("../d1/search/migrations/0004_ai_search_generation_registry.sql", import.meta.url),
        "utf8",
      ));
      database.exec(readFileSync(
        new URL("../d1/search/migrations/0005_ai_search_generation_registry_v2.sql", import.meta.url),
        "utf8",
      ));

      const store = createD1AiSearchGenerationRegistryStore(new SqliteD1Binding(database));
      const first = await snapshot(1);
      const second = await snapshot(2);
      await store.compareAndSwap(command(null, first));

      const occupiedEvent = {
        protocol: "eliotr.ai-search-generation-registry-transition.v1",
        namespace: NAMESPACE,
        operation: "OBSERVE",
        generation: "embedding-g1",
        previous_revision: 1,
        revision: 2,
        previous_artifact_sha256: first.artifact_sha256,
        artifact_sha256: "f".repeat(64),
        previous_active_head_generation: null,
        active_head_generation: null,
        changed_generations: [],
      };
      const occupiedJson = canonicalModelGatewayJson(occupiedEvent);
      const occupiedSha = createHash("sha256").update(occupiedJson).digest("hex");
      database.prepare(
        "INSERT INTO ai_search_generation_registry_transition(" +
        "namespace,revision,operation,generation,previous_revision,previous_artifact_sha256," +
        "artifact_sha256,previous_active_head_generation,active_head_generation,transition_json,transition_sha256" +
        ") VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        NAMESPACE,
        2,
        "OBSERVE",
        "embedding-g1",
        1,
        first.artifact_sha256,
        occupiedEvent.artifact_sha256,
        null,
        null,
        occupiedJson,
        occupiedSha,
      );

      await expect(store.compareAndSwap(command(first, second))).rejects.toThrow(/UNIQUE constraint/u);
      await expect(store.read(NAMESPACE)).resolves.toEqual(first);
      expect(database.prepare(
        "SELECT revision, artifact_sha256 FROM ai_search_generation_registry WHERE namespace=?",
      ).get(NAMESPACE)).toEqual({ revision: 1, artifact_sha256: first.artifact_sha256 });
      expect(database.prepare(
        "SELECT artifact_sha256, transition_sha256 FROM ai_search_generation_registry_transition WHERE namespace=? AND revision=2",
      ).get(NAMESPACE)).toEqual({
        artifact_sha256: occupiedEvent.artifact_sha256,
        transition_sha256: occupiedSha,
      });
    } finally {
      database.close();
    }
  });

  it("reconciles one lost D1 acknowledgement without a second mutation", async () => {
    const fixture = new D1RegistryFixture();
    fixture.mode = "throw-after-write";
    const service = createAiSearchGenerationRegistryService(
      createD1AiSearchGenerationRegistryStore(fixture.database),
      { promotion_evidence: declarationAuthority() },
    );

    await expect(
      service.declare({
        namespace: NAMESPACE,
        profile: profile(),
        declared_at: T0,
      }),
    ).resolves.toMatchObject({
      disposition: "REPLAY",
      revision: 1,
    });
    expect(fixture.write_attempts).toBe(1);
    expect(fixture.mutations).toBe(1);
    expect(fixture.transition_appends).toBe(1);
    expect(fixture.instance_appends).toBe(1);
  });

  it("never retries a D1 CAS whose effect remains unknown", async () => {
    const fixture = new D1RegistryFixture();
    fixture.mode = "throw-before-write";
    const service = createAiSearchGenerationRegistryService(
      createD1AiSearchGenerationRegistryStore(fixture.database),
      { promotion_evidence: declarationAuthority() },
    );

    await expect(
      service.declare({
        namespace: NAMESPACE,
        profile: profile(),
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

  it("preserves v1 bytes while appending v2 and immutable-history constraints", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(
        "CREATE TABLE schema_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT; " +
        "INSERT INTO schema_state(key, value, updated_at) VALUES ('schema_generation','search-v3','2026-09-01T00:00:00Z');",
      );
      const migration4 = readFileSync(
        new URL("../d1/search/migrations/0004_ai_search_generation_registry.sql", import.meta.url),
        "utf8",
      );
      database.exec(migration4);

      const legacyRecord = {
        namespace: NAMESPACE,
        generation: "embedding-g1",
        profile: profile(),
        state: "ACTIVE",
        expected_item_count: 1,
        indexed_item_count: 1,
        readback_item_count: 1,
        failed_item_count: 0,
        mismatch_count: 0,
        golden_set_result_ref: "legacy-golden-g1",
        declared_at: T0,
        observed_at: T0,
        activated_at: T0,
      };
      const legacyArtifact = {
        schema: "eliotr.ai-search-generation-registry.v1",
        namespace: NAMESPACE,
        revision: 4,
        registry: {
          active_head_generation: "embedding-g1",
          generations: [legacyRecord],
        },
      };
      const legacyJson = canonicalModelGatewayJson(legacyArtifact);
      const legacySha256 = createHash("sha256").update(legacyJson).digest("hex");
      database.prepare(
        "INSERT INTO ai_search_generation_registry(namespace, revision, artifact_sha256, artifact_json) VALUES (?, ?, ?, ?)",
      ).run(NAMESPACE, 4, legacySha256, legacyJson);

      const migration5 = readFileSync(
        new URL("../d1/search/migrations/0005_ai_search_generation_registry_v2.sql", import.meta.url),
        "utf8",
      );
      database.exec(migration5);
      const retained = database.prepare(
        "SELECT revision, artifact_sha256, artifact_json FROM ai_search_generation_registry WHERE namespace = ?",
      ).get(NAMESPACE);
      expect(retained).toEqual({
        revision: 4,
        artifact_sha256: legacySha256,
        artifact_json: legacyJson,
      });
      expect(database.prepare("SELECT value FROM schema_state WHERE key='schema_generation'").get().value)
        .toBe("search-v5-ai-search-generation-registry-v2-audit");

      const baseline = database.prepare(
        "SELECT operation, transition_sha256, transition_json FROM ai_search_generation_registry_transition WHERE namespace = ? AND revision = ?",
      ).get(NAMESPACE, 4);
      expect(baseline.operation).toBe("BASELINE");
      expect(baseline.transition_sha256).toBeNull();
      expect(JSON.parse(baseline.transition_json).artifact_json).toBe(legacyJson);
      const instance = database.prepare(
        "SELECT instance_id, generation, profile_sha256 FROM ai_search_generation_instance_history WHERE namespace = ?",
      ).get(NAMESPACE);
      expect(instance).toEqual({ instance_id: profile().id, generation: "embedding-g1", profile_sha256: null });

      const v2Artifact = {
        ...legacyArtifact,
        schema: "eliotr.ai-search-generation-registry.v2",
        namespace: "eliotr-search-v2",
        revision: 1,
        registry: { active_head_generation: null, generations: [] },
      };
      const v2Json = canonicalModelGatewayJson(v2Artifact);
      const v2Sha256 = createHash("sha256").update(v2Json).digest("hex");
      database.prepare(
        "INSERT INTO ai_search_generation_registry(namespace, revision, artifact_sha256, artifact_json) VALUES (?, ?, ?, ?)",
      ).run("eliotr-search-v2", 1, v2Sha256, v2Json);
      const invalidSchema = canonicalModelGatewayJson({ ...v2Artifact, schema: "eliotr.ai-search-generation-registry.v3" });
      expect(() => database.prepare(
        "INSERT INTO ai_search_generation_registry(namespace, revision, artifact_sha256, artifact_json) VALUES (?, ?, ?, ?)",
      ).run("eliotr-search-invalid", 1, "a".repeat(64), invalidSchema)).toThrow();

      expect(() => database.prepare(
        "UPDATE ai_search_generation_registry_transition SET operation='ARCHIVE' WHERE namespace=? AND revision=?",
      ).run(NAMESPACE, 4)).toThrow(/append-only/u);
      expect(() => database.prepare(
        "DELETE FROM ai_search_generation_registry_transition WHERE namespace=? AND revision=?",
      ).run(NAMESPACE, 4)).toThrow(/append-only/u);
      expect(() => database.prepare(
        "UPDATE ai_search_generation_instance_history SET generation='embedding-g2' WHERE namespace=? AND instance_id=?",
      ).run(NAMESPACE, profile().id)).toThrow(/append-only/u);
      expect(() => database.prepare(
        "DELETE FROM ai_search_generation_instance_history WHERE namespace=? AND instance_id=?",
      ).run(NAMESPACE, profile().id)).toThrow(/append-only/u);
      expect(() => database.prepare(
        "INSERT INTO ai_search_generation_instance_history(namespace,instance_id,generation,first_registry_revision,profile_json,profile_sha256) VALUES(?,?,?,?,?,NULL)",
      ).run(NAMESPACE, profile().id, "embedding-g2", 5, canonicalModelGatewayJson(profile()))).toThrow();
    } finally {
      database.close();
    }
  });
});
