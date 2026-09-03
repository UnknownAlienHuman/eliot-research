import {
  AI_SEARCH_LIST_PAGE_SIZE,
  AI_SEARCH_MAX_LIST_PAGES,
  AI_SEARCH_MAX_LIST_TOTAL,
  AI_SEARCH_MAX_NAMESPACE_BYTES,
  provisioningFailure,
} from "./ai-search-provisioning-contract.js";

export interface AiSearchInstanceSummary {
  readonly id: string;
  readonly type: "r2" | "web-crawler" | null;
  readonly source: string | null;
  readonly status: "active" | "waiting" | "indexing";
  readonly enable: boolean;
  readonly namespace: string;
  readonly created_at: string;
  readonly modified_at: string;
}

export interface AiSearchMetadataDefinition {
  readonly field_name: string;
  readonly data_type: "text" | "number" | "boolean" | "datetime";
}

export interface AiSearchInstanceReadback extends AiSearchInstanceSummary {
  readonly embedding_model?: string;
  readonly reranking: boolean;
  readonly reranking_model?: string;
  readonly rewrite_query: boolean;
  readonly cache: boolean;
  readonly index_method: Readonly<{ vector: boolean; keyword: boolean }>;
  readonly fusion_method?: "rrf" | "max";
  readonly keyword_tokenizer?: "porter" | "trigram";
  readonly keyword_match_mode?: "and" | "or";
  readonly boost_by: readonly Readonly<{
    field: string;
    direction?: "asc" | "desc" | "exists" | "not_exists";
  }>[];
  readonly chunk_size: number;
  readonly chunk_overlap: number;
  readonly max_num_results: number;
  readonly custom_metadata: readonly AiSearchMetadataDefinition[];
}

export interface AiSearchListPage {
  readonly result: readonly AiSearchInstanceSummary[];
  readonly total_count: number;
}

const LIST_KEYS = new Set(["result", "result_info"]);
const LIST_INFO_KEYS = new Set(["count", "page", "per_page", "total_count"]);
const SUMMARY_KEYS = new Set([
  "created_at",
  "enable",
  "id",
  "modified_at",
  "namespace",
  "source",
  "status",
  "type",
]);
const INFO_KEYS = new Set([
  "ai_gateway_id",
  "ai_search_model",
  "cache",
  "cache_threshold",
  "cache_ttl",
  "chunk_overlap",
  "chunk_size",
  "created_at",
  "custom_metadata",
  "embedding_model",
  "enable",
  "fusion_method",
  "id",
  "index_method",
  "indexing_options",
  "last_activity",
  "max_num_results",
  "modified_at",
  "namespace",
  "reranking",
  "reranking_model",
  "retrieval_options",
  "rewrite_model",
  "rewrite_query",
  "score_threshold",
  "source",
  "source_params",
  "status",
  "sync_interval",
  "token_id",
  "type",
]);
const INDEX_METHOD_KEYS = new Set(["keyword", "vector"]);
const INDEXING_OPTIONS_KEYS = new Set(["keyword_tokenizer"]);
const RETRIEVAL_OPTIONS_KEYS = new Set(["boost_by", "keyword_match_mode"]);
const BOOST_KEYS = new Set(["direction", "field"]);
const METADATA_DEFINITION_KEYS = new Set(["data_type", "field_name"]);
const INSTANCE_ID = /^[a-z0-9_]+(?:-[a-z0-9_]+)*$/u;
const MODEL = /^[A-Za-z0-9._:@/-]{1,256}$/u;

function exactObject(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      `${label} must be a plain object`,
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      `${label} must be a plain object`,
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
        `${label} contains unsupported field ${key}`,
      );
    }
  }
  return record;
}

function boundedString(value: unknown, label: string, maximum = 2048): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value !== value.trim() ||
    new TextEncoder().encode(value).byteLength > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      `${label} is invalid`,
    );
  }
  return value;
}

function optionalString(
  value: unknown,
  label: string,
  pattern?: RegExp,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const result = boundedString(value, label);
  if (pattern !== undefined && !pattern.test(result)) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      `${label} is invalid`,
    );
  }
  return result;
}

function safeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      `${label} is outside its allowed range`,
    );
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      `${label} must be boolean`,
    );
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const result = boundedString(value, label, 128);
  if (Number.isNaN(Date.parse(result))) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      `${label} must be an ISO timestamp`,
    );
  }
  return result;
}

function instanceStatus(value: unknown, label: string): AiSearchInstanceSummary["status"] {
  if (value !== "active" && value !== "waiting" && value !== "indexing") {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      `${label} is unsupported`,
    );
  }
  return value;
}

function sourceType(value: unknown, label: string): AiSearchInstanceSummary["type"] {
  if (value !== null && value !== "r2" && value !== "web-crawler") {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      `${label} is unsupported`,
    );
  }
  return value;
}

function sourceValue(value: unknown, label: string): string | null {
  if (value === null) return null;
  return boundedString(value, label);
}

function instanceId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !INSTANCE_ID.test(value)
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      `${label} is not a canonical Cloudflare AI Search instance ID`,
    );
  }
  return value;
}

function decodeSummaryFields(
  value: Record<string, unknown>,
  label: string,
): AiSearchInstanceSummary {
  return Object.freeze({
    id: instanceId(value.id, `${label}.id`),
    type: sourceType(value.type, `${label}.type`),
    source: sourceValue(value.source, `${label}.source`),
    status: instanceStatus(value.status, `${label}.status`),
    enable: booleanValue(value.enable, `${label}.enable`),
    namespace: boundedString(value.namespace, `${label}.namespace`, AI_SEARCH_MAX_NAMESPACE_BYTES),
    created_at: timestamp(value.created_at, `${label}.created_at`),
    modified_at: timestamp(value.modified_at, `${label}.modified_at`),
  });
}

function decodeSummary(raw: unknown, label: string): AiSearchInstanceSummary {
  return decodeSummaryFields(exactObject(raw, SUMMARY_KEYS, label), label);
}

export function decodeAiSearchInstanceListPage(
  raw: unknown,
  expectedPage: number,
): AiSearchListPage {
  safeInteger(expectedPage, "expected page", 1, AI_SEARCH_MAX_LIST_PAGES);
  const value = exactObject(raw, LIST_KEYS, "AI Search instance list");
  if (!Array.isArray(value.result) || value.result.length > AI_SEARCH_LIST_PAGE_SIZE) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search instance list result exceeds the page bound",
    );
  }
  const resultInfo = exactObject(
    value.result_info,
    LIST_INFO_KEYS,
    "AI Search instance list result_info",
  );
  const totalCount = safeInteger(
    resultInfo.total_count,
    "AI Search instance list total_count",
    0,
    AI_SEARCH_MAX_LIST_TOTAL,
  );
  if (
    resultInfo.count !== undefined &&
    safeInteger(
      resultInfo.count,
      "AI Search instance list count",
      0,
      AI_SEARCH_LIST_PAGE_SIZE,
    ) !== value.result.length
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search instance list count differs from result length",
    );
  }
  if (
    resultInfo.page !== undefined &&
    safeInteger(
      resultInfo.page,
      "AI Search instance list page",
      1,
      AI_SEARCH_MAX_LIST_PAGES,
    ) !== expectedPage
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search instance list returned the wrong page",
    );
  }
  if (
    resultInfo.per_page !== undefined &&
    safeInteger(
      resultInfo.per_page,
      "AI Search instance list per_page",
      1,
      AI_SEARCH_LIST_PAGE_SIZE,
    ) !== AI_SEARCH_LIST_PAGE_SIZE
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search instance list returned the wrong per_page value",
    );
  }
  return Object.freeze({
    result: Object.freeze(
      value.result.map((entry, index) =>
        decodeSummary(entry, `AI Search instance list result[${index}]`),
      ),
    ),
    total_count: totalCount,
  });
}

function decodeIndexMethod(raw: unknown): Readonly<{ vector: boolean; keyword: boolean }> {
  const value = exactObject(raw, INDEX_METHOD_KEYS, "AI Search info.index_method");
  return Object.freeze({
    vector: booleanValue(value.vector, "AI Search info.index_method.vector"),
    keyword: booleanValue(value.keyword, "AI Search info.index_method.keyword"),
  });
}

function decodeKeywordTokenizer(raw: unknown): "porter" | "trigram" | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = exactObject(raw, INDEXING_OPTIONS_KEYS, "AI Search info.indexing_options");
  if (value.keyword_tokenizer === undefined || value.keyword_tokenizer === null) return undefined;
  if (value.keyword_tokenizer !== "porter" && value.keyword_tokenizer !== "trigram") {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search info keyword tokenizer is unsupported",
    );
  }
  return value.keyword_tokenizer;
}

function decodeRetrievalOptions(raw: unknown): Readonly<{
  keyword_match_mode?: "and" | "or";
  boost_by: AiSearchInstanceReadback["boost_by"];
}> {
  if (raw === undefined || raw === null) {
    return Object.freeze({ boost_by: Object.freeze([]) });
  }
  const value = exactObject(raw, RETRIEVAL_OPTIONS_KEYS, "AI Search info.retrieval_options");
  let keywordMatchMode: "and" | "or" | undefined;
  if (value.keyword_match_mode !== undefined && value.keyword_match_mode !== null) {
    if (value.keyword_match_mode !== "and" && value.keyword_match_mode !== "or") {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
        "AI Search info keyword match mode is unsupported",
      );
    }
    keywordMatchMode = value.keyword_match_mode;
  }
  const rawBoosts = value.boost_by ?? [];
  if (!Array.isArray(rawBoosts) || rawBoosts.length > 3) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search info boost_by exceeds its bound",
    );
  }
  const boosts = rawBoosts.map((rawBoost, index) => {
    const boost = exactObject(rawBoost, BOOST_KEYS, `AI Search info boost_by[${index}]`);
    const field = boundedString(boost.field, `AI Search info boost_by[${index}].field`, 64);
    const direction = boost.direction;
    if (
      direction !== undefined &&
      direction !== "asc" &&
      direction !== "desc" &&
      direction !== "exists" &&
      direction !== "not_exists"
    ) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
        `AI Search info boost_by[${index}].direction is unsupported`,
      );
    }
    return Object.freeze({
      field,
      ...(direction === undefined ? {} : { direction }),
    });
  });
  return Object.freeze({
    ...(keywordMatchMode === undefined ? {} : { keyword_match_mode: keywordMatchMode }),
    boost_by: Object.freeze(boosts),
  });
}

function decodeCustomMetadata(raw: unknown): readonly AiSearchMetadataDefinition[] {
  if (!Array.isArray(raw) || raw.length > 5) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search info custom_metadata exceeds the five-field provider limit",
    );
  }
  return Object.freeze(
    raw.map((rawDefinition, index) => {
      const definition = exactObject(
        rawDefinition,
        METADATA_DEFINITION_KEYS,
        `AI Search info.custom_metadata[${index}]`,
      );
      const fieldName = boundedString(
        definition.field_name,
        `AI Search info.custom_metadata[${index}].field_name`,
        64,
      );
      const dataType = definition.data_type;
      if (
        dataType !== "text" &&
        dataType !== "number" &&
        dataType !== "boolean" &&
        dataType !== "datetime"
      ) {
        provisioningFailure(
          "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
          `AI Search info.custom_metadata[${index}].data_type is unsupported`,
        );
      }
      return Object.freeze({ field_name: fieldName, data_type: dataType });
    }),
  );
}

function validateOptionalInfoFields(value: Record<string, unknown>): void {
  optionalString(value.ai_search_model, "AI Search info.ai_search_model", MODEL);
  optionalString(value.rewrite_model, "AI Search info.rewrite_model", MODEL);
  optionalString(value.ai_gateway_id, "AI Search info.ai_gateway_id");
  optionalString(value.token_id, "AI Search info.token_id");
  if (value.source_params !== undefined && value.source_params !== null) {
    exactObject(value.source_params, new Set(), "AI Search info.source_params");
  }
  if (value.score_threshold !== undefined && value.score_threshold !== null) {
    const score = value.score_threshold;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
        "AI Search info.score_threshold is invalid",
      );
    }
  }
  if (value.sync_interval !== undefined && value.sync_interval !== null) {
    safeInteger(value.sync_interval, "AI Search info.sync_interval", 1, 86_400);
  }
  if (value.cache_ttl !== undefined && value.cache_ttl !== null) {
    safeInteger(value.cache_ttl, "AI Search info.cache_ttl", 600, 518_400);
  }
  if (value.cache_threshold !== undefined && value.cache_threshold !== null) {
    const threshold = value.cache_threshold;
    if (
      threshold !== "super_strict_match" &&
      threshold !== "close_enough" &&
      threshold !== "flexible_friend" &&
      threshold !== "anything_goes"
    ) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
        "AI Search info.cache_threshold is unsupported",
      );
    }
  }
  if (value.last_activity !== undefined && value.last_activity !== null) {
    timestamp(value.last_activity, "AI Search info.last_activity");
  }
}

export function decodeAiSearchInstanceInfo(raw: unknown): AiSearchInstanceReadback {
  const value = exactObject(raw, INFO_KEYS, "AI Search instance info");
  validateOptionalInfoFields(value);
  const summary = decodeSummaryFields(value, "AI Search instance info");
  const indexMethod = decodeIndexMethod(value.index_method);
  const embeddingModel = optionalString(
    value.embedding_model,
    "AI Search info.embedding_model",
    MODEL,
  );
  const rerankingModel = optionalString(
    value.reranking_model,
    "AI Search info.reranking_model",
    MODEL,
  );
  const fusion = optionalString(value.fusion_method, "AI Search info.fusion_method");
  if (fusion !== undefined && fusion !== "rrf" && fusion !== "max") {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search info.fusion_method is unsupported",
    );
  }
  const tokenizer = decodeKeywordTokenizer(value.indexing_options);
  const retrieval = decodeRetrievalOptions(value.retrieval_options);
  const chunkSize = safeInteger(value.chunk_size, "AI Search info.chunk_size", 64, 1_000_000);
  const chunkOverlap = safeInteger(
    value.chunk_overlap,
    "AI Search info.chunk_overlap",
    0,
    chunkSize - 1,
  );
  return Object.freeze({
    ...summary,
    ...(embeddingModel === undefined ? {} : { embedding_model: embeddingModel }),
    reranking: booleanValue(value.reranking, "AI Search info.reranking"),
    ...(rerankingModel === undefined ? {} : { reranking_model: rerankingModel }),
    rewrite_query: booleanValue(value.rewrite_query, "AI Search info.rewrite_query"),
    cache: booleanValue(value.cache, "AI Search info.cache"),
    index_method: indexMethod,
    ...(fusion === undefined ? {} : { fusion_method: fusion }),
    ...(tokenizer === undefined ? {} : { keyword_tokenizer: tokenizer }),
    ...(retrieval.keyword_match_mode === undefined
      ? {}
      : { keyword_match_mode: retrieval.keyword_match_mode }),
    boost_by: retrieval.boost_by,
    chunk_size: chunkSize,
    chunk_overlap: chunkOverlap,
    max_num_results: safeInteger(
      value.max_num_results,
      "AI Search info.max_num_results",
      1,
      50,
    ),
    custom_metadata: decodeCustomMetadata(value.custom_metadata),
  });
}
