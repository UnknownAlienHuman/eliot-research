import {
  AI_SEARCH_CUSTOM_METADATA_FIELDS,
  aiSearchGenerationRegistryArtifactDigest,
  buildAiSearchGenerationRegistryArtifact,
  canonicalModelGatewayJson,
} from "../../packages/cloudflare-ai/dist/index.js";


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
      const physicalProfileJson = (profileValue) => {
        const { generation: _legacyGeneration, ...physicalProfile } = profileValue;
        void _legacyGeneration;
        return canonicalModelGatewayJson(physicalProfile);
      };
      for (const prior of this.instances.values()) {
        if (
          prior.namespace === values[0] &&
          prior.instance_id === declared.profile.id &&
          prior.physical_profile_json !== physicalProfileJson(declared.profile)
        ) {
          throw new Error("AI Search physical instance profile is immutable");
        }
      }
      const key = `${values[0]}:${values[1]}`;
      if (this.instances.has(key)) throw new Error("duplicate logical generation history");
      const row = {
        namespace: String(values[0]),
        instance_id: String(declared.profile.id),
        generation: String(values[1]),
        first_registry_revision: Number(values[2]),
        profile_json: canonicalModelGatewayJson(declared.profile),
        physical_profile_json: physicalProfileJson(declared.profile),
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

async function rotationSnapshot(revision) {
  const generations = [
    {
      namespace: NAMESPACE,
      generation: "embedding-g1",
      profile: profile(),
      state: "SHADOW_BUILDING",
      expected_item_count: 1,
      indexed_item_count: 0,
      readback_item_count: 0,
      failed_item_count: 0,
      mismatch_count: 0,
      declared_at: T0,
      observed_at: T0,
    },
    {
      namespace: NAMESPACE,
      generation: "corpus-generation-g2",
      profile: { ...profile(), generation: "legacy-profile-label-g2" },
      state: "DECLARED",
      expected_item_count: 1,
      indexed_item_count: 0,
      readback_item_count: 0,
      failed_item_count: 0,
      mismatch_count: 0,
      declared_at: T0,
    },
  ];
  const artifact = buildAiSearchGenerationRegistryArtifact(
    NAMESPACE,
    revision,
    Object.freeze({
      active_head_generation: null,
      generations: Object.freeze(generations),
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

function declareLogicalGenerationCommand(previous, desired, generation) {
  return {
    ...command(previous, desired),
    operation: "DECLARE",
    generation,
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


export { NAMESPACE, T0, D1RegistryFixture, SqliteD1Binding, snapshot, rotationSnapshot, command, declareLogicalGenerationCommand, storedRow, profile, desiredManifest, declarationAuthority };
