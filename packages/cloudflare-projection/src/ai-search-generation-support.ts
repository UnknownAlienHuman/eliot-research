import type { AiSearchInstanceProfile } from "@eliotr/platform-cloudflare";
import { assertCloudflareAiSearchInstanceProfile } from "./ai-search-profile.js";
import { AiSearchGenerationError, type AiSearchGenerationErrorCode, type AiSearchShadowObservation } from "./ai-search-generation-contract.js";
import { aiSearchPhysicalProfileFingerprint } from "./ai-search-generation-profile-identity.js";

const AI_SEARCH_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const AI_SEARCH_MODEL_TOKEN = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const MAX_AI_SEARCH_GENERATIONS = 64;
const MAX_AI_SEARCH_METADATA_FIELDS = 5;
const SHADOW_OBSERVATION_KEYS = new Set([
  "failed_item_count",
  "generation",
  "indexed_item_count",
  "mismatch_count",
  "observed_at",
  "readback_item_count",
]);

function generationFailure(
  code: AiSearchGenerationErrorCode,
  message: string,
): never {
  throw new AiSearchGenerationError(code, message);
}

function boundedIdentifier(
  value: string,
  label: string,
  pattern: RegExp = AI_SEARCH_IDENTIFIER,
): string {
  if (!pattern.test(value)) {
    generationFailure("AI_SEARCH_GENERATION_INVALID", `${label} is invalid`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    generationFailure(
      "AI_SEARCH_GENERATION_INVALID",
      `${label} must be a non-negative safe integer`,
    );
  }
  return value;
}

function exactShadowObservation(
  raw: unknown,
): asserts raw is AiSearchShadowObservation {
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    Object.getPrototypeOf(raw) !== Object.prototype
  ) {
    generationFailure(
      "AI_SEARCH_SHADOW_PROGRESS_INVALID",
      "shadow observation must be a plain object",
    );
  }
  const value = raw as Record<string, unknown>;
  const observed = Object.keys(value);
  if (
    observed.length !== SHADOW_OBSERVATION_KEYS.size ||
    observed.some((key) => !SHADOW_OBSERVATION_KEYS.has(key)) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    generationFailure(
      "AI_SEARCH_SHADOW_PROGRESS_INVALID",
      "shadow observation fields are not exact",
    );
  }
  for (const key of observed) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      generationFailure(
        "AI_SEARCH_SHADOW_PROGRESS_INVALID",
        `shadow observation ${key} cannot be an accessor`,
      );
    }
  }
}

function validateObservationTimestamp(value: string, label: string): string {
  if (value.length < 1 || value.length > 128 || Number.isNaN(Date.parse(value))) {
    generationFailure("AI_SEARCH_GENERATION_INVALID", `${label} is invalid`);
  }
  return value;
}

function normalizedMetadataFields(values: readonly string[]): readonly string[] {
  if (values.length > MAX_AI_SEARCH_METADATA_FIELDS) {
    generationFailure(
      "AI_SEARCH_PROFILE_INVALID",
      "metadata field count exceeds bound",
    );
  }
  const normalized = values.map((value, index) =>
    boundedIdentifier(value, `metadata_fields[${index}]`),
  );
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) {
    generationFailure(
      "AI_SEARCH_PROFILE_INVALID",
      "metadata fields must be unique",
    );
  }
  return [...normalized].sort();
}

function normalizedAiSearchProfile(
  profile: AiSearchInstanceProfile,
): Readonly<Record<string, unknown>> {
  try {
    assertCloudflareAiSearchInstanceProfile(profile);
  } catch (cause) {
    generationFailure(
      "AI_SEARCH_PROFILE_INVALID",
      cause instanceof Error ? cause.message : "AI Search profile is invalid",
    );
  }
  boundedIdentifier(profile.id, "profile.id");
  boundedIdentifier(profile.generation, "profile.generation");
  if (
    !Number.isInteger(profile.max_num_results) ||
    profile.max_num_results < 1 ||
    profile.max_num_results > 50
  ) {
    generationFailure(
      "AI_SEARCH_PROFILE_INVALID",
      "max_num_results must be an integer in [1, 50]",
    );
  }
  if (!profile.index_method.vector && !profile.index_method.keyword) {
    generationFailure(
      "AI_SEARCH_PROFILE_INVALID",
      "at least one index method must be enabled",
    );
  }
  if (profile.index_method.vector) {
    if (
      profile.embedding_model === undefined ||
      !AI_SEARCH_MODEL_TOKEN.test(profile.embedding_model)
    ) {
      generationFailure(
        "AI_SEARCH_PROFILE_INVALID",
        "vector search requires a bounded embedding model",
      );
    }
  } else if (profile.embedding_model !== undefined) {
    generationFailure(
      "AI_SEARCH_PROFILE_INVALID",
      "embedding_model is forbidden when vector search is disabled",
    );
  }
  if (!profile.index_method.keyword) {
    if (
      profile.keyword_tokenizer !== undefined ||
      profile.keyword_match_mode !== undefined
    ) {
      generationFailure(
        "AI_SEARCH_PROFILE_INVALID",
        "keyword settings require keyword search",
      );
    }
  }
  if (
    profile.index_method.vector &&
    profile.index_method.keyword &&
    profile.fusion_method === undefined
  ) {
    generationFailure(
      "AI_SEARCH_PROFILE_INVALID",
      "hybrid search requires an explicit fusion method",
    );
  }
  if (
    (!profile.index_method.vector || !profile.index_method.keyword) &&
    profile.fusion_method !== undefined
  ) {
    generationFailure(
      "AI_SEARCH_PROFILE_INVALID",
      "fusion_method requires hybrid search",
    );
  }

  return {
    id: profile.id,
    generation: profile.generation,
    index_method: {
      keyword: profile.index_method.keyword,
      vector: profile.index_method.vector,
    },
    fusion_method: profile.fusion_method ?? null,
    keyword_tokenizer: profile.keyword_tokenizer ?? null,
    keyword_match_mode: profile.keyword_match_mode ?? null,
    embedding_model: profile.embedding_model ?? null,
    reranking: profile.reranking,
    max_num_results: profile.max_num_results,
    metadata_fields: normalizedMetadataFields(profile.metadata_fields),
  };
}

function profileFingerprint(profile: AiSearchInstanceProfile): string {
  normalizedAiSearchProfile(profile);
  return aiSearchPhysicalProfileFingerprint(profile);
}

/**
 * Fails before mutation when an existing immutable AI Search instance differs
 * from the desired profile. The legacy profile.generation label is not the
 * logical corpus generation; physical settings and metadata fields are exact.
 */
export function assertImmutableAiSearchProfile(
  existing: AiSearchInstanceProfile,
  desired: AiSearchInstanceProfile,
): void {
  if (profileFingerprint(existing) !== profileFingerprint(desired)) {
    generationFailure(
      "AI_SEARCH_PROFILE_IMMUTABLE_MISMATCH",
      "existing AI Search instance does not match the immutable desired profile",
    );
  }
}


export { MAX_AI_SEARCH_GENERATIONS, generationFailure, boundedIdentifier, nonNegativeInteger, exactShadowObservation, validateObservationTimestamp, normalizedMetadataFields, normalizedAiSearchProfile, profileFingerprint };
