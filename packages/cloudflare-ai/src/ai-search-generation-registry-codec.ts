import type { AiSearchInstanceProfile } from "@eliotr/platform-cloudflare";
import {
  type AiSearchGenerationRecord,
  type AiSearchGenerationRegistry,
  type AiSearchGenerationState,
  validateAiSearchGenerationRegistry,
} from "./ai-search-generation.js";
import { assertCloudflareAiSearchInstanceProfile } from "./ai-search-profile.js";
import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
} from "./model-gateway-request.js";
import {
  AI_SEARCH_GENERATION_REGISTRY_MAX_BYTES,
  AI_SEARCH_GENERATION_REGISTRY_SCHEMA,
  aiSearchGenerationRegistryFailure,
  type AiSearchGenerationRegistryArtifact,
  type AiSearchGenerationRegistrySnapshot,
  type AiSearchGenerationRegistryStoreReceipt,
} from "./ai-search-generation-registry-contract.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const MODEL_TOKEN = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const ARTIFACT_KEYS = new Set(["namespace", "registry", "revision", "schema"]);
const SNAPSHOT_KEYS = new Set(["artifact", "artifact_sha256"]);
const REGISTRY_KEYS = new Set(["active_head_generation", "generations"]);
const RECORD_KEYS = new Set([
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
]);
const STATES = new Set<AiSearchGenerationState>([
  "ACTIVE",
  "BLOCKED",
  "DECLARED",
  "RETIRED",
  "SHADOW_BUILDING",
  "SHADOW_COMPLETE",
]);
const MAX_GENERATIONS = 64;

function readbackFailure(message: string, cause?: unknown): never {
  aiSearchGenerationRegistryFailure(
    "AI_SEARCH_REGISTRY_READBACK_INVALID",
    message,
    cause === undefined ? {} : { cause },
  );
}

function exactObject(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    readbackFailure(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    readbackFailure(`${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      readbackFailure(`${label} cannot contain accessors`);
    }
    if (!allowedKeys.has(key)) {
      readbackFailure(`${label} contains unsupported field ${key}`);
    }
  }
  return record;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    readbackFailure(`${label} is not a bounded identifier`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    readbackFailure(`${label} is not canonical SHA-256`);
  }
  return value;
}

function modelToken(value: unknown, label: string): string {
  if (typeof value !== "string" || !MODEL_TOKEN.test(value)) {
    readbackFailure(`${label} is not a bounded model token`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    readbackFailure(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (parsed < 1) readbackFailure(`${label} must be positive`);
  return parsed;
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
  return identifier(source[key], label);
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

function decodeProfile(raw: unknown, label: string): AiSearchInstanceProfile {
  const value = exactObject(raw, PROFILE_KEYS, label);
  const indexMethod = exactObject(
    value.index_method,
    INDEX_METHOD_KEYS,
    `${label}.index_method`,
  );
  if (!Array.isArray(value.metadata_fields)) {
    readbackFailure(`${label}.metadata_fields must be an array`);
  }
  const metadataFields = value.metadata_fields.map((entry, index) =>
    identifier(entry, `${label}.metadata_fields[${index}]`),
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
    id: identifier(value.id, `${label}.id`),
    generation: identifier(value.generation, `${label}.generation`),
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

function decodeRecord(raw: unknown, index: number): AiSearchGenerationRecord {
  const label = `registry.generations[${index}]`;
  const value = exactObject(raw, RECORD_KEYS, label);
  if (
    typeof value.state !== "string" ||
    !STATES.has(value.state as AiSearchGenerationState)
  ) {
    readbackFailure(`${label}.state is invalid`);
  }
  const profile = decodeProfile(value.profile, `${label}.profile`);
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
  return Object.freeze({
    namespace: identifier(value.namespace, `${label}.namespace`),
    generation: identifier(value.generation, `${label}.generation`),
    profile,
    state: value.state as AiSearchGenerationState,
    expected_item_count: positiveInteger(
      value.expected_item_count,
      `${label}.expected_item_count`,
    ),
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
    declared_at: identifier(value.declared_at, `${label}.declared_at`),
    ...(observed === undefined ? {} : { observed_at: observed }),
    ...(activated === undefined ? {} : { activated_at: activated }),
    ...(retired === undefined ? {} : { retired_at: retired }),
  });
}

function decodeRegistry(
  raw: unknown,
  namespace: string,
): AiSearchGenerationRegistry {
  const value = exactObject(raw, REGISTRY_KEYS, "registry");
  if (
    !Array.isArray(value.generations) ||
    value.generations.length > MAX_GENERATIONS
  ) {
    readbackFailure(
      `registry.generations must contain at most ${MAX_GENERATIONS} entries`,
    );
  }
  const generations = value.generations.map(decodeRecord);
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
      : identifier(
          value.active_head_generation,
          "registry.active_head_generation",
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

export function normalizeAiSearchGenerationRegistry(
  registry: AiSearchGenerationRegistry,
): AiSearchGenerationRegistry {
  try {
    validateAiSearchGenerationRegistry(registry);
  } catch (cause) {
    aiSearchGenerationRegistryFailure(
      "AI_SEARCH_REGISTRY_INPUT_INVALID",
      "AI Search generation registry input is invalid",
      { cause },
    );
  }
  const generations = [...registry.generations]
    .map((record) =>
      Object.freeze({
        ...record,
        profile: Object.freeze({
          ...record.profile,
          index_method: Object.freeze({ ...record.profile.index_method }),
          metadata_fields: Object.freeze([
            ...record.profile.metadata_fields,
          ].sort()),
        }),
      }),
    )
    .sort((left, right) =>
      left.generation < right.generation
        ? -1
        : left.generation > right.generation
          ? 1
          : 0,
    );
  return Object.freeze({
    active_head_generation: registry.active_head_generation,
    generations: Object.freeze(generations),
  });
}

export function buildAiSearchGenerationRegistryArtifact(
  namespace: string,
  revision: number,
  registry: AiSearchGenerationRegistry,
): AiSearchGenerationRegistryArtifact {
  if (
    !IDENTIFIER.test(namespace) ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    aiSearchGenerationRegistryFailure(
      "AI_SEARCH_REGISTRY_INPUT_INVALID",
      "AI Search generation registry artifact identity is invalid",
    );
  }
  const normalized = normalizeAiSearchGenerationRegistry(registry);
  if (normalized.generations.some((record) => record.namespace !== namespace)) {
    aiSearchGenerationRegistryFailure(
      "AI_SEARCH_REGISTRY_INPUT_INVALID",
      "AI Search generation registry contains another namespace",
    );
  }
  return Object.freeze({
    schema: AI_SEARCH_GENERATION_REGISTRY_SCHEMA,
    namespace,
    revision,
    registry: normalized,
  });
}

export async function aiSearchGenerationRegistryArtifactDigest(
  artifact: AiSearchGenerationRegistryArtifact,
): Promise<string> {
  const json = canonicalModelGatewayJson(artifact);
  if (
    new TextEncoder().encode(json).byteLength >
    AI_SEARCH_GENERATION_REGISTRY_MAX_BYTES
  ) {
    aiSearchGenerationRegistryFailure(
      "AI_SEARCH_REGISTRY_INPUT_INVALID",
      "AI Search generation registry exceeds its byte envelope",
    );
  }
  return modelGatewaySha256(json);
}

export async function decodeAiSearchGenerationRegistrySnapshot(
  raw: unknown,
  expectedNamespace: string,
): Promise<AiSearchGenerationRegistrySnapshot> {
  const value = exactObject(
    raw,
    SNAPSHOT_KEYS,
    "generation registry snapshot",
  );
  const artifactValue = exactObject(
    value.artifact,
    ARTIFACT_KEYS,
    "generation registry artifact",
  );
  if (artifactValue.schema !== AI_SEARCH_GENERATION_REGISTRY_SCHEMA) {
    readbackFailure("generation registry schema is unsupported");
  }
  const namespace = identifier(
    artifactValue.namespace,
    "generation registry namespace",
  );
  if (namespace !== expectedNamespace) {
    readbackFailure("generation registry snapshot belongs to another namespace");
  }
  let artifact: AiSearchGenerationRegistryArtifact;
  try {
    artifact = buildAiSearchGenerationRegistryArtifact(
      namespace,
      positiveInteger(
        artifactValue.revision,
        "generation registry revision",
      ),
      decodeRegistry(artifactValue.registry, namespace),
    );
  } catch (cause) {
    readbackFailure("generation registry artifact is invalid", cause);
  }
  const artifactSha256 = digest(
    value.artifact_sha256,
    "generation registry artifact digest",
  );
  const computed = await aiSearchGenerationRegistryArtifactDigest(artifact);
  if (computed !== artifactSha256) {
    readbackFailure(
      "generation registry artifact digest does not match readback bytes",
    );
  }
  return Object.freeze({
    artifact,
    artifact_sha256: artifactSha256,
  });
}

export function decodeAiSearchGenerationRegistryStoreReceipt(
  raw: unknown,
): AiSearchGenerationRegistryStoreReceipt {
  const value = exactObject(
    raw,
    STORE_RECEIPT_KEYS,
    "generation registry store receipt",
  );
  if (
    value.outcome !== "APPLIED" &&
    value.outcome !== "REPLAY" &&
    value.outcome !== "CONFLICT"
  ) {
    readbackFailure("generation registry store outcome is invalid");
  }
  return Object.freeze({
    outcome: value.outcome,
    namespace: identifier(
      value.namespace,
      "generation registry receipt namespace",
    ),
    revision: positiveInteger(
      value.revision,
      "generation registry receipt revision",
    ),
    artifact_sha256: digest(
      value.artifact_sha256,
      "generation registry receipt digest",
    ),
  });
}

export function sameAiSearchGenerationRegistrySnapshot(
  left: AiSearchGenerationRegistrySnapshot | null,
  right: AiSearchGenerationRegistrySnapshot,
): boolean {
  return (
    left !== null &&
    left.artifact_sha256 === right.artifact_sha256 &&
    left.artifact.revision === right.artifact.revision &&
    left.artifact.namespace === right.artifact.namespace
  );
}
