import type { AiSearchInstanceProfile } from "@eliotr/platform-cloudflare";
import { AI_SEARCH_CUSTOM_METADATA_FIELDS } from "./ai-search-profile.js";
export const AI_SEARCH_PRIMARY_NAMESPACE = "eliotr" as const;
export const AI_SEARCH_PRIMARY_GENERATION = "g2-qwen3-2026-09-03" as const;
export const AI_SEARCH_PRIMARY_INSTANCE_ID = "private-prose-g2" as const;
export const AI_SEARCH_PRIMARY_PROJECTION_PROFILE: AiSearchInstanceProfile = Object.freeze({
  id: AI_SEARCH_PRIMARY_INSTANCE_ID,
  generation: AI_SEARCH_PRIMARY_GENERATION,
  index_method: Object.freeze({ vector: true, keyword: true }),
  fusion_method: "rrf", keyword_tokenizer: "porter", keyword_match_mode: "and",
  embedding_model: "@cf/qwen/qwen3-embedding-0.6b",
  reranking: true, max_num_results: 50,
  metadata_fields: AI_SEARCH_CUSTOM_METADATA_FIELDS,
});
