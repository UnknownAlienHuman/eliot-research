import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  aiSearchGenerationRegistryArtifactDigest,
  buildAiSearchGenerationRegistryArtifact,
  canonicalModelGatewayJson,
  createAiSearchGenerationRegistryService,
  createD1AiSearchGenerationRegistryStore,
} from "../../packages/cloudflare-ai/dist/index.js";
import { projectionDigest } from "../../packages/cloudflare-projection/dist/canonical.js";
import { canonicalAiSearchPhysicalProfile } from "../../packages/cloudflare-projection/dist/ai-search-generation-profile-identity.js";

import { NAMESPACE, T0, D1RegistryFixture, SqliteD1Binding, snapshot, rotationSnapshot, command, declareLogicalGenerationCommand, storedRow, profile, declarationAuthority } from "./ai-search-generation-registry-d1-test-support.mjs";

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

    const rotated = await rotationSnapshot(3);
    await expect(store.compareAndSwap(
      declareLogicalGenerationCommand(second, rotated, "corpus-generation-g2"),
    )).resolves.toMatchObject({
      outcome: "APPLIED",
      namespace: NAMESPACE,
      revision: 3,
      artifact_sha256: rotated.artifact_sha256,
      transition_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    await expect(store.read(NAMESPACE)).resolves.toEqual(rotated);

    expect(fixture.mutations).toBe(3);
    expect(fixture.transition_appends).toBe(3);
    expect(fixture.instance_appends).toBe(2);
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
      target_profile_identity_sha256: await projectionDigest(
        canonicalAiSearchPhysicalProfile(profile()),
      ),
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
      const samePhysicalInstance = { ...profile(), generation: "legacy-profile-label-g2" };
      expect(database.prepare(
        "INSERT INTO ai_search_generation_instance_history(namespace,instance_id,generation,first_registry_revision,profile_json,profile_sha256) VALUES(?,?,?,?,?,?)",
      ).run(
        NAMESPACE,
        profile().id,
        "corpus-generation-g2",
        5,
        canonicalModelGatewayJson(samePhysicalInstance),
        "b".repeat(64),
      ).changes).toBe(1);

      const incompatibleProfile = {
        ...samePhysicalInstance,
        generation: "another-legacy-profile-label",
        embedding_model: "incompatible-embedding-model",
      };
      expect(() => database.prepare(
        "INSERT INTO ai_search_generation_instance_history(namespace,instance_id,generation,first_registry_revision,profile_json,profile_sha256) VALUES(?,?,?,?,?,?)",
      ).run(
        NAMESPACE,
        profile().id,
        "corpus-generation-g3",
        6,
        canonicalModelGatewayJson(incompatibleProfile),
        "c".repeat(64),
      )).toThrow(/physical instance profile is immutable/u);

      const changedPhysicalInstance = {
        ...incompatibleProfile,
        id: "search_instance_g2",
      };
      expect(database.prepare(
        "INSERT INTO ai_search_generation_instance_history(namespace,instance_id,generation,first_registry_revision,profile_json,profile_sha256) VALUES(?,?,?,?,?,?)",
      ).run(
        NAMESPACE,
        changedPhysicalInstance.id,
        "corpus-generation-g3",
        6,
        canonicalModelGatewayJson(changedPhysicalInstance),
        "d".repeat(64),
      ).changes).toBe(1);
    } finally {
      database.close();
    }
  });
});
