import type { AiSearchInstanceProfile } from "@eliotr/platform-cloudflare";

/**
 * The provider profile describes a physical index. The legacy `generation`
 * label is deliberately excluded: logical corpus generations live on registry
 * records and can rotate on one compatible physical index.
 */
export function canonicalAiSearchPhysicalProfile(
  profile: AiSearchInstanceProfile,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: profile.id,
    index_method: Object.freeze({
      keyword: profile.index_method.keyword,
      vector: profile.index_method.vector,
    }),
    fusion_method: profile.fusion_method ?? null,
    keyword_tokenizer: profile.keyword_tokenizer ?? null,
    keyword_match_mode: profile.keyword_match_mode ?? null,
    embedding_model: profile.embedding_model ?? null,
    reranking: profile.reranking,
    max_num_results: profile.max_num_results,
    metadata_fields: Object.freeze([...profile.metadata_fields].sort()),
  });
}

export function aiSearchPhysicalProfileFingerprint(
  profile: AiSearchInstanceProfile,
): string {
  return JSON.stringify(canonicalAiSearchPhysicalProfile(profile));
}
