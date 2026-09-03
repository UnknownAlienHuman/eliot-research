import type { AiSearchInstanceProfile } from "@eliotr/platform-cloudflare";

export const AI_SEARCH_CUSTOM_METADATA_FIELDS = Object.freeze([
  "source_revision_ref",
  "canonical_section_id",
  "projection_generation",
  "instruction_taint",
  "content_sha256",
] as const);

export const AI_SEARCH_RERANKING_MODEL = "@cf/baai/bge-reranker-base" as const;

const INSTANCE_ID = /^[a-z0-9_]+(?:-[a-z0-9_]+)*$/u;
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const MODEL = /^[A-Za-z0-9._:@/-]{1,256}$/u;

export class AiSearchProfileValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AiSearchProfileValidationError";
  }
}

function profileFailure(message: string): never {
  throw new AiSearchProfileValidationError(message);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function assertCloudflareAiSearchInstanceProfile(
  profile: AiSearchInstanceProfile,
): void {
  if (
    typeof profile.id !== "string" ||
    profile.id.length > 64 ||
    !INSTANCE_ID.test(profile.id)
  ) {
    profileFailure("AI Search instance ID must match the Cloudflare 1-64 character grammar");
  }
  if (typeof profile.generation !== "string" || !GENERATION.test(profile.generation)) {
    profileFailure("AI Search generation is not a bounded identifier");
  }
  if (
    typeof profile.index_method !== "object" ||
    profile.index_method === null ||
    typeof profile.index_method.vector !== "boolean" ||
    typeof profile.index_method.keyword !== "boolean" ||
    (!profile.index_method.vector && !profile.index_method.keyword)
  ) {
    profileFailure("AI Search profile must enable vector search, keyword search, or both");
  }
  if (
    !Number.isSafeInteger(profile.max_num_results) ||
    profile.max_num_results < 1 ||
    profile.max_num_results > 50
  ) {
    profileFailure("AI Search max_num_results must be an integer in [1, 50]");
  }
  if (!Array.isArray(profile.metadata_fields)) {
    profileFailure("AI Search metadata_fields must be an array");
  }
  const observedMetadata = [...profile.metadata_fields].sort();
  const expectedMetadata = [...AI_SEARCH_CUSTOM_METADATA_FIELDS].sort();
  if (
    new Set(observedMetadata).size !== observedMetadata.length ||
    !sameStrings(observedMetadata, expectedMetadata)
  ) {
    profileFailure("AI Search profile must declare exactly the five canonical metadata fields");
  }
  if (profile.index_method.vector) {
    if (profile.embedding_model === undefined || !MODEL.test(profile.embedding_model)) {
      profileFailure("vector AI Search requires a bounded embedding model");
    }
  } else if (profile.embedding_model !== undefined) {
    profileFailure("embedding_model is forbidden when vector search is disabled");
  }
  if (profile.index_method.keyword) {
    if (
      profile.keyword_tokenizer !== "porter" &&
      profile.keyword_tokenizer !== "trigram"
    ) {
      profileFailure("keyword search requires an explicit supported tokenizer");
    }
    if (
      profile.keyword_match_mode !== "and" &&
      profile.keyword_match_mode !== "or"
    ) {
      profileFailure("keyword search requires an explicit supported match mode");
    }
  } else if (
    profile.keyword_tokenizer !== undefined ||
    profile.keyword_match_mode !== undefined
  ) {
    profileFailure("keyword settings are forbidden when keyword search is disabled");
  }
  const hybrid = profile.index_method.vector && profile.index_method.keyword;
  if (hybrid) {
    if (profile.fusion_method !== "rrf" && profile.fusion_method !== "max") {
      profileFailure("hybrid AI Search requires an explicit supported fusion method");
    }
  } else if (profile.fusion_method !== undefined) {
    profileFailure("fusion_method is forbidden when hybrid search is disabled");
  }
  if (typeof profile.reranking !== "boolean") {
    profileFailure("AI Search reranking must be boolean");
  }
}

export function aiSearchCustomMetadataDefinitions(): readonly Readonly<{
  field_name: (typeof AI_SEARCH_CUSTOM_METADATA_FIELDS)[number];
  data_type: "text";
}>[] {
  return Object.freeze(
    AI_SEARCH_CUSTOM_METADATA_FIELDS.map((field_name) =>
      Object.freeze({ field_name, data_type: "text" as const }),
    ),
  );
}
