import {
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
  readonly ai_gateway_id?: string;
  readonly embedding_model?: string;
  readonly reranking: boolean;
  readonly reranking_model?: string;
  readonly rewrite_query: boolean;
  readonly cache: boolean;
  readonly chunk: boolean;
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
  readonly score_threshold?: number;
  readonly max_num_results: number;
  readonly custom_metadata: readonly AiSearchMetadataDefinition[];
}

export interface AiSearchListPage {
  readonly result: readonly AiSearchInstanceSummary[];
  readonly total_count: number;
}

export const AI_SEARCH_LIST_KEYS = new Set(["result", "result_info"]);
export const AI_SEARCH_LIST_INFO_KEYS = new Set([
  "count",
  "page",
  "per_page",
  "total_count",
]);
export const AI_SEARCH_INFO_KEYS = new Set([
  "ai_gateway_id",
  "ai_search_model",
  "cache",
  "cache_threshold",
  "cache_ttl",
  "chunk",
  "chunk_overlap",
  "chunk_size",
  "created_at",
  "created_by",
  "custom_metadata",
  "embedding_model",
  "enable",
  "engine_version",
  "fusion_method",
  "hybrid_search_enabled",
  "id",
  "index_method",
  "indexing_options",
  "last_activity",
  "max_num_results",
  "metadata",
  "modified_at",
  "modified_by",
  "namespace",
  "paused",
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
export const AI_SEARCH_MODEL_ID = /^[A-Za-z0-9._:@/-]{1,256}$/u;

export function exactAiSearchObject(
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

export function boundedAiSearchString(
  value: unknown,
  label: string,
  maximum = 2048,
): string {
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

export function optionalAiSearchString(
  value: unknown,
  label: string,
  pattern?: RegExp,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const result = boundedAiSearchString(value, label);
  if (pattern !== undefined && !pattern.test(result)) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      `${label} is invalid`,
    );
  }
  return result;
}

export function safeAiSearchInteger(
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

export function optionalAiSearchUnitInterval(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      `${label} must be a finite number in [0, 1]`,
    );
  }
  return value;
}

export function booleanAiSearchValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      `${label} must be boolean`,
    );
  }
  return value;
}

export function optionalAiSearchBoolean(
  value: unknown,
  label: string,
): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  return booleanAiSearchValue(value, label);
}

function aiSearchTimestamp(value: unknown, label: string): string {
  const result = boundedAiSearchString(value, label, 128);
  if (Number.isNaN(Date.parse(result))) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      `${label} must be an ISO timestamp`,
    );
  }
  return result;
}

function aiSearchInstanceStatus(
  value: unknown,
  label: string,
): AiSearchInstanceSummary["status"] {
  if (value !== "active" && value !== "waiting" && value !== "indexing") {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      `${label} is unsupported`,
    );
  }
  return value;
}

function aiSearchSourceType(
  value: unknown,
  label: string,
): AiSearchInstanceSummary["type"] {
  if (value === undefined || value === null) return null;
  if (value !== "r2" && value !== "web-crawler") {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      `${label} is unsupported`,
    );
  }
  return value;
}

function aiSearchSourceValue(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return boundedAiSearchString(value, label);
}

function aiSearchInstanceId(value: unknown, label: string): string {
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

function enabledAiSearchState(
  value: Record<string, unknown>,
  label: string,
): boolean {
  const enabled = optionalAiSearchBoolean(value.enable, `${label}.enable`);
  const paused = optionalAiSearchBoolean(value.paused, `${label}.paused`);
  if (enabled === undefined && paused === undefined) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      `${label} omits both enable and paused state`,
    );
  }
  if (enabled !== undefined && paused !== undefined && enabled === paused) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      `${label} enable and paused state contradict each other`,
    );
  }
  return enabled ?? !paused;
}

export function decodeAiSearchSummaryFields(
  value: Record<string, unknown>,
  label: string,
): AiSearchInstanceSummary {
  return Object.freeze({
    id: aiSearchInstanceId(value.id, `${label}.id`),
    type: aiSearchSourceType(value.type, `${label}.type`),
    source: aiSearchSourceValue(value.source, `${label}.source`),
    status: aiSearchInstanceStatus(value.status, `${label}.status`),
    enable: enabledAiSearchState(value, label),
    namespace: boundedAiSearchString(
      value.namespace,
      `${label}.namespace`,
      AI_SEARCH_MAX_NAMESPACE_BYTES,
    ),
    created_at: aiSearchTimestamp(value.created_at, `${label}.created_at`),
    modified_at: aiSearchTimestamp(value.modified_at, `${label}.modified_at`),
  });
}

export function decodeAiSearchIndexMethod(
  raw: unknown,
): Readonly<{ vector: boolean; keyword: boolean }> {
  const value = exactAiSearchObject(
    raw,
    INDEX_METHOD_KEYS,
    "AI Search info.index_method",
  );
  return Object.freeze({
    vector: booleanAiSearchValue(value.vector, "AI Search info.index_method.vector"),
    keyword: booleanAiSearchValue(value.keyword, "AI Search info.index_method.keyword"),
  });
}

export function decodeAiSearchKeywordTokenizer(
  raw: unknown,
): "porter" | "trigram" | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = exactAiSearchObject(
    raw,
    INDEXING_OPTIONS_KEYS,
    "AI Search info.indexing_options",
  );
  if (value.keyword_tokenizer === undefined || value.keyword_tokenizer === null) {
    return undefined;
  }
  if (value.keyword_tokenizer !== "porter" && value.keyword_tokenizer !== "trigram") {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search info keyword tokenizer is unsupported",
    );
  }
  return value.keyword_tokenizer;
}

export function decodeAiSearchRetrievalOptions(raw: unknown): Readonly<{
  keyword_match_mode?: "and" | "or";
  boost_by: AiSearchInstanceReadback["boost_by"];
}> {
  if (raw === undefined || raw === null) {
    return Object.freeze({ boost_by: Object.freeze([]) });
  }
  const value = exactAiSearchObject(
    raw,
    RETRIEVAL_OPTIONS_KEYS,
    "AI Search info.retrieval_options",
  );
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
    const boost = exactAiSearchObject(
      rawBoost,
      BOOST_KEYS,
      `AI Search info boost_by[${index}]`,
    );
    const field = boundedAiSearchString(
      boost.field,
      `AI Search info boost_by[${index}].field`,
      64,
    );
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

export function decodeAiSearchCustomMetadata(
  raw: unknown,
): readonly AiSearchMetadataDefinition[] {
  if (!Array.isArray(raw) || raw.length > 5) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search info custom_metadata exceeds the five-field provider limit",
    );
  }
  return Object.freeze(
    raw.map((rawDefinition, index) => {
      const definition = exactAiSearchObject(
        rawDefinition,
        METADATA_DEFINITION_KEYS,
        `AI Search info.custom_metadata[${index}]`,
      );
      const fieldName = boundedAiSearchString(
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

function validateAiSearchProviderMetadata(raw: unknown): void {
  if (raw === undefined || raw === null) return;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search info.metadata must be a plain object",
    );
  }
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search info.metadata must be a plain object",
    );
  }
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).length > 32) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search info.metadata exceeds its key bound",
    );
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(record);
  } catch (cause) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search info.metadata is not bounded JSON",
      cause,
    );
  }
  if (new TextEncoder().encode(serialized).byteLength > 16 * 1024) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search info.metadata exceeds its byte bound",
    );
  }
}

export function validateAiSearchOptionalInfoFields(
  value: Record<string, unknown>,
): void {
  optionalAiSearchString(value.ai_search_model, "AI Search info.ai_search_model", AI_SEARCH_MODEL_ID);
  optionalAiSearchString(value.rewrite_model, "AI Search info.rewrite_model", AI_SEARCH_MODEL_ID);
  optionalAiSearchString(value.token_id, "AI Search info.token_id");
  optionalAiSearchString(value.created_by, "AI Search info.created_by");
  optionalAiSearchString(value.modified_by, "AI Search info.modified_by");
  if (value.engine_version !== undefined && value.engine_version !== null) {
    if (
      typeof value.engine_version !== "number" ||
      !Number.isFinite(value.engine_version) ||
      value.engine_version < 0
    ) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
        "AI Search info.engine_version must be a finite non-negative number",
      );
    }
  }
  validateAiSearchProviderMetadata(value.metadata);
  if (value.source_params !== undefined && value.source_params !== null) {
    exactAiSearchObject(value.source_params, new Set(), "AI Search info.source_params");
  }
  if (value.sync_interval !== undefined && value.sync_interval !== null) {
    safeAiSearchInteger(value.sync_interval, "AI Search info.sync_interval", 1, 86_400);
  }
  if (value.cache_ttl !== undefined && value.cache_ttl !== null) {
    safeAiSearchInteger(value.cache_ttl, "AI Search info.cache_ttl", 600, 518_400);
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
    aiSearchTimestamp(value.last_activity, "AI Search info.last_activity");
  }
}
