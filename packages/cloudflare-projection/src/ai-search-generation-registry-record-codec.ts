import type { AiSearchInstanceProfile } from "@eliotr/platform-cloudflare";
import {
  type AiSearchGenerationRecord,
  type AiSearchGenerationRegistry,
  type AiSearchGenerationState,
  validateAiSearchGenerationRegistry,
} from "./ai-search-generation.js";
import { assertCloudflareAiSearchInstanceProfile } from "./ai-search-profile.js";
import { canonicalAiSearchPhysicalProfile } from "./ai-search-generation-profile-identity.js";
import { projectionDigest } from "./canonical.js";
import {
  AI_SEARCH_GENERATION_REGISTRY_SCHEMA_V1,
  type AiSearchGenerationRegistryArtifact,
} from "./ai-search-generation-registry-contract.js";
import {
  aiSearchRegistryIdentifier,
  aiSearchRegistryInteger,
  aiSearchRegistryReadbackFailure as readbackFailure,
  exactAiSearchRegistryObject,
} from "./ai-search-registry-validation.js";
import { validateStoredManagedGenerationPromotionEvidence } from "./managed-generation-promotion-evidence.js";

const MODEL_TOKEN = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const ARTIFACT_KEYS = new Set(["namespace", "registry", "revision", "schema"]);
const SNAPSHOT_KEYS = new Set(["artifact", "artifact_sha256"]);
const REGISTRY_KEYS = new Set(["active_head_generation", "generations"]);
const RECORD_KEYS_V1 = new Set([
  "activated_at",
  "declared_at",
  "expected_item_count",
  "failed_item_count",
  "generation",
  "golden_set_result_ref",
  "indexed_item_count",
  "mismatch_count",
  "namespace",
  "observed_at",
  "profile",
  "readback_item_count",
  "retired_at",
  "state",
]);
const RECORD_KEYS_V2 = new Set([
  ...RECORD_KEYS_V1,
  "inactive_at",
  "promotion_evidence_v2",
]);
const PROFILE_KEYS = new Set([
  "embedding_model",
  "fusion_method",
  "generation",
  "id",
  "index_method",
  "keyword_match_mode",
  "keyword_tokenizer",
  "max_num_results",
  "metadata_fields",
  "reranking",
]);
const INDEX_METHOD_KEYS = new Set(["keyword", "vector"]);
const STORE_RECEIPT_KEYS = new Set([
  "artifact_sha256",
  "namespace",
  "outcome",
  "revision",
  "transition_sha256",
]);
const STATES_V1 = new Set<AiSearchGenerationState>([
  "ACTIVE",
  "BLOCKED",
  "DECLARED",
  "RETIRED",
  "SHADOW_BUILDING",
  "SHADOW_COMPLETE",
]);
const STATES_V2 = new Set<AiSearchGenerationState>([
  ...STATES_V1,
  "INACTIVE_QUALIFIED",
  "INACTIVE_UNQUALIFIED",
]);
const MAX_GENERATIONS = 64;

function modelToken(value: unknown, label: string): string {
  if (typeof value !== "string" || !MODEL_TOKEN.test(value)) {
    readbackFailure(`${label} is not a bounded model token`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  return aiSearchRegistryInteger(value, label, 0, readbackFailure, `${label} must be a non-negative safe integer`);
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  return aiSearchRegistryInteger(parsed, label, 1, readbackFailure, `${label} must be positive`);
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") readbackFailure(`${label} must be boolean`);
  return value;
}

function optionalIdentifier(
  source: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  if (!Object.hasOwn(source, key)) return undefined;
  return aiSearchRegistryIdentifier(source[key], label, readbackFailure);
}

function optionalChoice<const T extends string>(
  source: Record<string, unknown>,
  key: string,
  label: string,
  allowed: readonly T[],
): T | undefined {
  if (!Object.hasOwn(source, key)) return undefined;
  const value = source[key];
  if (
    typeof value !== "string" ||
    !(allowed as readonly string[]).includes(value)
  ) {
    readbackFailure(`${label} is invalid`);
  }
  return value as T;
}

function exactAiSearchRegistryArray(
  value: unknown,
  label: string,
  fail: (message: string, cause?: unknown) => never,
): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(`${label} must be a plain array`);
  }
  if (
    Object.keys(value).length !== value.length ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    fail(`${label} must be a dense array without extra properties`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      fail(`${label}[${index}] cannot be missing or an accessor`);
    }
  }
  return value;
}

function decodeProfile(raw: unknown, label: string): AiSearchInstanceProfile {
  const value = exactAiSearchRegistryObject(raw, PROFILE_KEYS, label, readbackFailure);
  const indexMethod = exactAiSearchRegistryObject(
    value.index_method,
    INDEX_METHOD_KEYS,
    `${label}.index_method`,
    readbackFailure,
  );
  const metadataFieldValues = exactAiSearchRegistryArray(
    value.metadata_fields,
    `${label}.metadata_fields`,
    readbackFailure,
  );
  const metadataFields = metadataFieldValues.map((entry, index) =>
    aiSearchRegistryIdentifier(entry, `${label}.metadata_fields[${index}]`, readbackFailure),
  );
  const fusionMethod = optionalChoice(
    value,
    "fusion_method",
    `${label}.fusion_method`,
    ["rrf", "max"] as const,
  );
  const keywordTokenizer = optionalChoice(
    value,
    "keyword_tokenizer",
    `${label}.keyword_tokenizer`,
    ["porter", "trigram"] as const,
  );
  const keywordMatchMode = optionalChoice(
    value,
    "keyword_match_mode",
    `${label}.keyword_match_mode`,
    ["and", "or"] as const,
  );
  const embeddingModel = Object.hasOwn(value, "embedding_model")
    ? modelToken(value.embedding_model, `${label}.embedding_model`)
    : undefined;
  const profile: AiSearchInstanceProfile = Object.freeze({
    id: aiSearchRegistryIdentifier(value.id, `${label}.id`, readbackFailure),
    generation: aiSearchRegistryIdentifier(value.generation, `${label}.generation`, readbackFailure),
    index_method: Object.freeze({
      vector: booleanValue(
        indexMethod.vector,
        `${label}.index_method.vector`,
      ),
      keyword: booleanValue(
        indexMethod.keyword,
        `${label}.index_method.keyword`,
      ),
    }),
    ...(fusionMethod === undefined ? {} : { fusion_method: fusionMethod }),
    ...(keywordTokenizer === undefined
      ? {}
      : { keyword_tokenizer: keywordTokenizer }),
    ...(keywordMatchMode === undefined
      ? {}
      : { keyword_match_mode: keywordMatchMode }),
    ...(embeddingModel === undefined
      ? {}
      : { embedding_model: embeddingModel }),
    reranking: booleanValue(value.reranking, `${label}.reranking`),
    max_num_results: positiveInteger(
      value.max_num_results,
      `${label}.max_num_results`,
    ),
    metadata_fields: Object.freeze(metadataFields),
  });
  try {
    assertCloudflareAiSearchInstanceProfile(profile);
  } catch (cause) {
    readbackFailure(`${label} is not an admitted immutable profile`, cause);
  }
  return profile;
}

async function decodeRecord(
  raw: unknown,
  index: number,
  schema: AiSearchGenerationRegistryArtifact["schema"],
): Promise<AiSearchGenerationRecord> {
  const label = `registry.generations[${index}]`;
  const legacy = schema === AI_SEARCH_GENERATION_REGISTRY_SCHEMA_V1;
  const value = exactAiSearchRegistryObject(raw, legacy ? RECORD_KEYS_V1 : RECORD_KEYS_V2, label, readbackFailure);
  if (
    typeof value.state !== "string" ||
    !(legacy ? STATES_V1 : STATES_V2).has(value.state as AiSearchGenerationState)
  ) {
    readbackFailure(`${label}.state is invalid`);
  }
  const profile = decodeProfile(value.profile, `${label}.profile`);
  const namespace = aiSearchRegistryIdentifier(value.namespace, `${label}.namespace`, readbackFailure);
  const generation = aiSearchRegistryIdentifier(value.generation, `${label}.generation`, readbackFailure);
  const golden = optionalIdentifier(
    value,
    "golden_set_result_ref",
    `${label}.golden_set_result_ref`,
  );
  const observed = optionalIdentifier(
    value,
    "observed_at",
    `${label}.observed_at`,
  );
  const activated = optionalIdentifier(
    value,
    "activated_at",
    `${label}.activated_at`,
  );
  const retired = optionalIdentifier(
    value,
    "retired_at",
    `${label}.retired_at`,
  );
  const inactive = optionalIdentifier(value, "inactive_at", `${label}.inactive_at`);
  const evidence = Object.hasOwn(value, "promotion_evidence_v2")
    ? await validateStoredManagedGenerationPromotionEvidence(
      value.promotion_evidence_v2,
      {
        namespace,
        managed_instance_id: profile.id,
        managed_generation: generation,
        target_profile_identity_sha256: await projectionDigest(
          canonicalAiSearchPhysicalProfile(profile),
        ),
      },
    )
    : undefined;
  const state = value.state as AiSearchGenerationState;
  if (legacy && (inactive !== undefined || evidence !== undefined)) {
    readbackFailure(`${label} v1 record contains v2 lifecycle fields`);
  }
  if (
    !legacy &&
    (state === "SHADOW_COMPLETE" ||
      state === "INACTIVE_QUALIFIED") &&
    evidence === undefined
  ) {
    readbackFailure(`${label} v2 qualified state lacks authoritative promotion evidence`);
  }
  if (!legacy && state === "INACTIVE_UNQUALIFIED" && evidence !== undefined) {
    readbackFailure(`${label} inactive-unqualified state cannot authorize rollback`);
  }
  return Object.freeze({
    namespace,
    generation,
    profile,
    state,
    expected_item_count: legacy
      ? positiveInteger(value.expected_item_count, `${label}.expected_item_count`)
      : nonNegativeInteger(value.expected_item_count, `${label}.expected_item_count`),
    indexed_item_count: nonNegativeInteger(
      value.indexed_item_count,
      `${label}.indexed_item_count`,
    ),
    readback_item_count: nonNegativeInteger(
      value.readback_item_count,
      `${label}.readback_item_count`,
    ),
    failed_item_count: nonNegativeInteger(
      value.failed_item_count,
      `${label}.failed_item_count`,
    ),
    mismatch_count: nonNegativeInteger(
      value.mismatch_count,
      `${label}.mismatch_count`,
    ),
    ...(golden === undefined ? {} : { golden_set_result_ref: golden }),
    declared_at: aiSearchRegistryIdentifier(value.declared_at, `${label}.declared_at`, readbackFailure),
    ...(observed === undefined ? {} : { observed_at: observed }),
    ...(activated === undefined ? {} : { activated_at: activated }),
    ...(inactive === undefined ? {} : { inactive_at: inactive }),
    ...(retired === undefined ? {} : { retired_at: retired }),
    ...(evidence === undefined ? {} : { promotion_evidence_v2: evidence }),
  });
}

async function decodeRegistry(
  raw: unknown,
  namespace: string,
  schema: AiSearchGenerationRegistryArtifact["schema"],
): Promise<AiSearchGenerationRegistry> {
  const value = exactAiSearchRegistryObject(raw, REGISTRY_KEYS, "registry", readbackFailure);
  const generationValues = exactAiSearchRegistryArray(
    value.generations,
    "registry.generations",
    readbackFailure,
  );
  if (generationValues.length > MAX_GENERATIONS) {
    readbackFailure(
      `registry.generations must contain at most ${MAX_GENERATIONS} entries`,
    );
  }
  const generations = await Promise.all(
    generationValues.map((record, index) => decodeRecord(record, index, schema)),
  );
  for (const record of generations) {
    if (record.namespace !== namespace) {
      readbackFailure("registry generation belongs to another namespace");
    }
  }
  for (let index = 1; index < generations.length; index += 1) {
    const previous = generations[index - 1];
    const current = generations[index];
    if (
      previous === undefined ||
      current === undefined ||
      previous.generation >= current.generation
    ) {
      readbackFailure("registry generations are not in strict canonical order");
    }
  }
  const active =
    value.active_head_generation === null
      ? null
      : aiSearchRegistryIdentifier(
          value.active_head_generation,
          "registry.active_head_generation",
          readbackFailure,
        );
  const registry: AiSearchGenerationRegistry = Object.freeze({
    active_head_generation: active,
    generations: Object.freeze(generations),
  });
  try {
    validateAiSearchGenerationRegistry(registry);
  } catch (cause) {
    readbackFailure("registry violates the generation lifecycle contract", cause);
  }
  return registry;
}


export { ARTIFACT_KEYS, SNAPSHOT_KEYS, REGISTRY_KEYS, STORE_RECEIPT_KEYS, MAX_GENERATIONS, exactAiSearchRegistryArray, positiveInteger, decodeRecord, decodeRegistry };
