import { provisioningFailure } from "./ai-search-provisioning-contract.js";
import {
  AI_SEARCH_INFO_KEYS,
  AI_SEARCH_MODEL_ID,
  booleanAiSearchValue,
  decodeAiSearchCustomMetadata,
  decodeAiSearchIndexMethod,
  decodeAiSearchKeywordTokenizer,
  decodeAiSearchRetrievalOptions,
  decodeAiSearchSummaryFields,
  exactAiSearchObject,
  optionalAiSearchBoolean,
  optionalAiSearchString,
  optionalAiSearchUnitInterval,
  safeAiSearchInteger,
  validateAiSearchOptionalInfoFields,
  type AiSearchInstanceReadback,
} from "./ai-search-provisioning-decode-common.js";

export function decodeAiSearchInstanceInfo(raw: unknown): AiSearchInstanceReadback {
  const value = exactAiSearchObject(raw, AI_SEARCH_INFO_KEYS, "AI Search instance info");
  validateAiSearchOptionalInfoFields(value);
  const summary = decodeAiSearchSummaryFields(value, "AI Search instance info");
  const indexMethod = decodeAiSearchIndexMethod(value.index_method);
  const legacyHybrid = optionalAiSearchBoolean(
    value.hybrid_search_enabled,
    "AI Search info.hybrid_search_enabled",
  );
  if (
    legacyHybrid !== undefined &&
    legacyHybrid !== (indexMethod.vector && indexMethod.keyword)
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search legacy hybrid flag contradicts index_method",
    );
  }
  const gatewayId = optionalAiSearchString(
    value.ai_gateway_id,
    "AI Search info.ai_gateway_id",
  );
  const scoreThreshold = optionalAiSearchUnitInterval(
    value.score_threshold,
    "AI Search info.score_threshold",
  );
  const embeddingModel = optionalAiSearchString(
    value.embedding_model,
    "AI Search info.embedding_model",
    AI_SEARCH_MODEL_ID,
  );
  const rerankingModel = optionalAiSearchString(
    value.reranking_model,
    "AI Search info.reranking_model",
    AI_SEARCH_MODEL_ID,
  );
  const fusion = optionalAiSearchString(
    value.fusion_method,
    "AI Search info.fusion_method",
  );
  if (fusion !== undefined && fusion !== "rrf" && fusion !== "max") {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search info.fusion_method is unsupported",
    );
  }
  const tokenizer = decodeAiSearchKeywordTokenizer(value.indexing_options);
  const retrieval = decodeAiSearchRetrievalOptions(value.retrieval_options);
  const chunkSize = safeAiSearchInteger(
    value.chunk_size,
    "AI Search info.chunk_size",
    64,
    1_000_000,
  );
  const chunkOverlap = safeAiSearchInteger(
    value.chunk_overlap,
    "AI Search info.chunk_overlap",
    0,
    chunkSize - 1,
  );
  return Object.freeze({
    ...summary,
    ...(gatewayId === undefined ? {} : { ai_gateway_id: gatewayId }),
    ...(embeddingModel === undefined ? {} : { embedding_model: embeddingModel }),
    reranking: booleanAiSearchValue(value.reranking, "AI Search info.reranking"),
    ...(rerankingModel === undefined ? {} : { reranking_model: rerankingModel }),
    rewrite_query: booleanAiSearchValue(
      value.rewrite_query,
      "AI Search info.rewrite_query",
    ),
    cache: booleanAiSearchValue(value.cache, "AI Search info.cache"),
    chunk: booleanAiSearchValue(value.chunk, "AI Search info.chunk"),
    index_method: indexMethod,
    ...(fusion === undefined ? {} : { fusion_method: fusion }),
    ...(tokenizer === undefined ? {} : { keyword_tokenizer: tokenizer }),
    ...(retrieval.keyword_match_mode === undefined
      ? {}
      : { keyword_match_mode: retrieval.keyword_match_mode }),
    boost_by: retrieval.boost_by,
    chunk_size: chunkSize,
    chunk_overlap: chunkOverlap,
    ...(scoreThreshold === undefined ? {} : { score_threshold: scoreThreshold }),
    max_num_results: safeAiSearchInteger(
      value.max_num_results,
      "AI Search info.max_num_results",
      1,
      50,
    ),
    custom_metadata: decodeAiSearchCustomMetadata(value.custom_metadata),
  });
}
