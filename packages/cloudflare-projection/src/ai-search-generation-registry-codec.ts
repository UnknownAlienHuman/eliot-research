import { type AiSearchGenerationRegistry, validateAiSearchGenerationRegistry } from "./ai-search-generation.js";
import { canonicalProjectionJson, projectionSha256Utf8 } from "./canonical.js";
import {
  AI_SEARCH_GENERATION_REGISTRY_MAX_BYTES,
  AI_SEARCH_GENERATION_REGISTRY_SCHEMA,
  AI_SEARCH_GENERATION_REGISTRY_SCHEMA_V1,
  aiSearchGenerationRegistryFailure,
  type AiSearchGenerationRegistryArtifact,
  type AiSearchGenerationRegistrySnapshot,
  type AiSearchGenerationRegistryStoreReceipt,
} from "./ai-search-generation-registry-contract.js";
import {
  aiSearchRegistryDigest,
  aiSearchRegistryInputFailure as inputFailure,
  aiSearchRegistryIdentifier,
  aiSearchRegistryInteger,
  aiSearchRegistryReadbackFailure as readbackFailure,
  exactAiSearchRegistryObject,
  isAiSearchRegistryIdentifier,
} from "./ai-search-registry-validation.js";
import { ARTIFACT_KEYS, SNAPSHOT_KEYS, REGISTRY_KEYS, STORE_RECEIPT_KEYS, MAX_GENERATIONS, exactAiSearchRegistryArray, positiveInteger, decodeRecord, decodeRegistry } from "./ai-search-generation-registry-record-codec.js";

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
  schema: AiSearchGenerationRegistryArtifact["schema"] = AI_SEARCH_GENERATION_REGISTRY_SCHEMA,
): AiSearchGenerationRegistryArtifact {
  if (
    !isAiSearchRegistryIdentifier(namespace) ||
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
    schema,
    namespace,
    revision,
    registry: normalized,
  });
}

export async function aiSearchGenerationRegistryArtifactDigest(
  artifact: AiSearchGenerationRegistryArtifact,
): Promise<string> {
  await validateArtifactDigestInput(artifact);
  const json = canonicalProjectionJson(artifact);
  if (
    new TextEncoder().encode(json).byteLength >
    AI_SEARCH_GENERATION_REGISTRY_MAX_BYTES
  ) {
    aiSearchGenerationRegistryFailure(
      "AI_SEARCH_REGISTRY_INPUT_INVALID",
      "AI Search generation registry exceeds its byte envelope",
    );
  }
  return projectionSha256Utf8(json);
}

async function validateArtifactDigestInput(
  raw: unknown,
): Promise<void> {
  const value = exactAiSearchRegistryObject(
    raw,
    ARTIFACT_KEYS,
    "generation registry artifact",
    inputFailure,
  );
  if (value.schema !== AI_SEARCH_GENERATION_REGISTRY_SCHEMA &&
      value.schema !== AI_SEARCH_GENERATION_REGISTRY_SCHEMA_V1) {
    inputFailure("generation registry schema is unsupported");
  }
  aiSearchRegistryIdentifier(
    value.namespace,
    "generation registry namespace",
    inputFailure,
  );
  aiSearchRegistryInteger(
    value.revision,
    "generation registry revision",
    1,
    inputFailure,
    "generation registry revision must be a positive safe integer",
  );
  const registry = exactAiSearchRegistryObject(
    value.registry,
    REGISTRY_KEYS,
    "generation registry",
    inputFailure,
  );
  const generations = exactAiSearchRegistryArray(
    registry.generations,
    "generation registry generations",
    inputFailure,
  );
  if (generations.length > MAX_GENERATIONS) {
    inputFailure("generation registry generations exceed their bound");
  }
  if (registry.active_head_generation !== null) {
    aiSearchRegistryIdentifier(
      registry.active_head_generation,
      "generation registry active head",
      inputFailure,
    );
  }
  for (let index = 0; index < generations.length; index += 1) {
    try {
      await decodeRecord(
        generations[index],
        index,
        value.schema as AiSearchGenerationRegistryArtifact["schema"],
      );
    } catch (cause) {
      inputFailure(`generation registry record ${index} is invalid`, cause);
    }
  }
}

export async function decodeAiSearchGenerationRegistrySnapshot(
  raw: unknown,
  expectedNamespace: string,
): Promise<AiSearchGenerationRegistrySnapshot> {
  const value = exactAiSearchRegistryObject(
    raw,
    SNAPSHOT_KEYS,
    "generation registry snapshot",
    readbackFailure,
  );
  const artifactValue = exactAiSearchRegistryObject(
    value.artifact,
    ARTIFACT_KEYS,
    "generation registry artifact",
    readbackFailure,
  );
  if (artifactValue.schema !== AI_SEARCH_GENERATION_REGISTRY_SCHEMA &&
      artifactValue.schema !== AI_SEARCH_GENERATION_REGISTRY_SCHEMA_V1) {
    readbackFailure("generation registry schema is unsupported");
  }
  const namespace = aiSearchRegistryIdentifier(
    artifactValue.namespace,
    "generation registry namespace",
    readbackFailure,
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
      await decodeRegistry(
        artifactValue.registry,
        namespace,
        artifactValue.schema as AiSearchGenerationRegistryArtifact["schema"],
      ),
      artifactValue.schema as AiSearchGenerationRegistryArtifact["schema"],
    );
  } catch (cause) {
    readbackFailure("generation registry artifact is invalid", cause);
  }
  const artifactSha256 = aiSearchRegistryDigest(
    value.artifact_sha256,
    "generation registry artifact digest",
    readbackFailure,
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
  const value = exactAiSearchRegistryObject(
    raw,
    STORE_RECEIPT_KEYS,
    "generation registry store receipt",
    readbackFailure,
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
    namespace: aiSearchRegistryIdentifier(
      value.namespace,
      "generation registry receipt namespace",
      readbackFailure,
    ),
    revision: positiveInteger(
      value.revision,
      "generation registry receipt revision",
    ),
    artifact_sha256: aiSearchRegistryDigest(
      value.artifact_sha256,
      "generation registry receipt digest",
      readbackFailure,
    ),
    transition_sha256: value.transition_sha256 === null
      ? null
      : aiSearchRegistryDigest(
        value.transition_sha256,
        "generation registry transition receipt digest",
        readbackFailure,
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
