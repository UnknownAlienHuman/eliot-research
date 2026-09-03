import type { AiSearchInstanceProfile } from "@eliotr/platform-cloudflare";
import { assertImmutableAiSearchProfile } from "./ai-search-generation.js";
import {
  AI_SEARCH_CUSTOM_METADATA_FIELDS,
  AI_SEARCH_RERANKING_MODEL,
  aiSearchCustomMetadataDefinitions,
  assertCloudflareAiSearchInstanceProfile,
} from "./ai-search-profile.js";

export type AiSearchProvisioningErrorCode =
  | "AI_SEARCH_PROVISIONING_INPUT_INVALID"
  | "AI_SEARCH_PROVISIONING_PROVIDER_CALL_FAILED"
  | "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID"
  | "AI_SEARCH_PROVISIONING_DUPLICATE_INSTANCE"
  | "AI_SEARCH_PROVISIONING_CONFIGURATION_MISMATCH"
  | "AI_SEARCH_PROVISIONING_CREATE_UNCERTAIN";

export class AiSearchProvisioningError extends Error {
  public readonly code: AiSearchProvisioningErrorCode;

  public constructor(
    code: AiSearchProvisioningErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AiSearchProvisioningError";
    this.code = code;
  }
}

export interface AiSearchInstanceProvisioningSpec {
  readonly namespace: string;
  readonly profile: AiSearchInstanceProfile;
  readonly chunk_size: number;
  readonly chunk_overlap: number;
}

export interface AiSearchProvisioningInstance {
  info(): Promise<unknown>;
}

export interface AiSearchProvisioningNamespace {
  get(instanceId: string): AiSearchProvisioningInstance;
  list(input: {
    readonly page: number;
    readonly per_page: number;
    readonly search: string;
    readonly order_by: "created_at";
    readonly order_by_direction: "asc";
  }): Promise<unknown>;
  create(input: AiSearchCreateRequest): Promise<AiSearchProvisioningInstance>;
}

export interface AiSearchCreateRequest {
  readonly id: string;
  readonly index_method: Readonly<{ vector: boolean; keyword: boolean }>;
  readonly fusion_method?: "rrf" | "max";
  readonly indexing_options?: Readonly<{ keyword_tokenizer: "porter" | "trigram" }>;
  readonly retrieval_options?: Readonly<{
    keyword_match_mode: "and" | "or";
    boost_by: readonly never[];
  }>;
  readonly embedding_model?: string;
  readonly reranking: boolean;
  readonly reranking_model?: typeof AI_SEARCH_RERANKING_MODEL;
  readonly rewrite_query: false;
  readonly cache: false;
  readonly chunk_size: number;
  readonly chunk_overlap: number;
  readonly max_num_results: number;
  readonly custom_metadata: ReturnType<typeof aiSearchCustomMetadataDefinitions>;
  readonly enable: true;
}

export type AiSearchProvisioningDisposition =
  | "EXISTING_MATCH"
  | "CREATED"
  | "CREATE_RECONCILED";

export interface AiSearchProvisioningReceipt {
  readonly receipt_ref: string;
  readonly disposition: AiSearchProvisioningDisposition;
  readonly namespace: string;
  readonly instance_id: string;
  readonly generation: string;
  readonly provider_status: "active" | "waiting" | "indexing";
  readonly provider_created_at: string;
  readonly provider_modified_at: string;
  readonly desired_configuration_sha256: string;
  readonly readback_configuration_sha256: string;
}

interface AiSearchInstanceSummary {
  readonly id: string;
  readonly type: "r2" | "web-crawler" | null;
  readonly source: string | null;
  readonly status: "active" | "waiting" | "indexing";
  readonly enable: boolean;
  readonly namespace: string;
  readonly created_at: string;
  readonly modified_at: string;
}

interface AiSearchMetadataDefinition {
  readonly field_name: string;
  readonly data_type: "text" | "number" | "boolean" | "datetime";
}

interface AiSearchInstanceReadback extends AiSearchInstanceSummary {
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

interface AiSearchListPage {
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
const MAX_NAMESPACE_BYTES = 256;
const MAX_LIST_TOTAL = 10_000;
const LIST_PAGE_SIZE = 100;
const MAX_LIST_PAGES = 100;

function provisioningFailure(
  code: AiSearchProvisioningErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new AiSearchProvisioningError(code, message, cause);
}

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
  const result = boundedString(value, label, 2048);
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

function status(value: unknown, label: string): AiSearchInstanceSummary["status"] {
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
  return boundedString(value, label, 2048);
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

function decodeSummary(raw: unknown, label: string): AiSearchInstanceSummary {
  const value = exactObject(raw, SUMMARY_KEYS, label);
  return Object.freeze({
    id: instanceId(value.id, `${label}.id`),
    type: sourceType(value.type, `${label}.type`),
    source: sourceValue(value.source, `${label}.source`),
    status: status(value.status, `${label}.status`),
    enable: booleanValue(value.enable, `${label}.enable`),
    namespace: boundedString(value.namespace, `${label}.namespace`, MAX_NAMESPACE_BYTES),
    created_at: timestamp(value.created_at, `${label}.created_at`),
    modified_at: timestamp(value.modified_at, `${label}.modified_at`),
  });
}

export function decodeAiSearchInstanceListPage(
  raw: unknown,
  expectedPage: number,
): AiSearchListPage {
  safeInteger(expectedPage, "expected page", 1, MAX_LIST_PAGES);
  const value = exactObject(raw, LIST_KEYS, "AI Search instance list");
  if (!Array.isArray(value.result) || value.result.length > LIST_PAGE_SIZE) {
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
    MAX_LIST_TOTAL,
  );
  if (
    resultInfo.count !== undefined &&
    safeInteger(resultInfo.count, "AI Search instance list count", 0, LIST_PAGE_SIZE) !==
      value.result.length
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search instance list count differs from result length",
    );
  }
  if (
    resultInfo.page !== undefined &&
    safeInteger(resultInfo.page, "AI Search instance list page", 1, MAX_LIST_PAGES) !==
      expectedPage
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search instance list returned the wrong page",
    );
  }
  if (
    resultInfo.per_page !== undefined &&
    safeInteger(resultInfo.per_page, "AI Search instance list per_page", 1, LIST_PAGE_SIZE) !==
      LIST_PAGE_SIZE
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
  boost_by: readonly Readonly<{
    field: string;
    direction?: "asc" | "desc" | "exists" | "not_exists";
  }>[];
}> {
  if (raw === undefined || raw === null) return Object.freeze({ boost_by: Object.freeze([]) });
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
  if (value.token_id !== undefined && value.token_id !== null) {
    boundedString(value.token_id, "AI Search info.token_id", 128);
  }
  if (value.source_params !== undefined && value.source_params !== null) {
    exactObject(value.source_params, new Set(), "AI Search info.source_params");
  }
  if (value.score_threshold !== undefined && value.score_threshold !== null) {
    if (
      typeof value.score_threshold !== "number" ||
      !Number.isFinite(value.score_threshold) ||
      value.score_threshold < 0 ||
      value.score_threshold > 1
    ) {
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

export function decodeAiSearchInstanceInfo(
  raw: unknown,
  generation: string,
): AiSearchInstanceReadback {
  const value = exactObject(raw, INFO_KEYS, "AI Search instance info");
  validateOptionalInfoFields(value);
  const indexMethod = decodeIndexMethod(value.index_method);
  const fusionMethod = optionalString(value.fusion_method, "AI Search info.fusion_method");
  if (
    fusionMethod !== undefined &&
    fusionMethod !== "rrf" &&
    fusionMethod !== "max"
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      "AI Search info.fusion_method is unsupported",
    );
  }
  const retrievalOptions = decodeRetrievalOptions(value.retrieval_options);
  const chunkSize = safeInteger(value.chunk_size, "AI Search info.chunk_size", 64, 1_000_000);
  const chunkOverlap = safeInteger(
    value.chunk_overlap,
    "AI Search info.chunk_overlap",
    0,
    chunkSize - 1,
  );
  const readback = {
    ...decodeSummary(value, "AI Search instance info"),
    generation: boundedString(generation, "AI Search generation", 256),
    ...(optionalString(value.embedding_model, "AI Search info.embedding_model", MODEL) ===
    undefined
      ? {}
      : {
          embedding_model: optionalString(
            value.embedding_model,
            "AI Search info.embedding_model",
            MODEL,
          ),
        }),
    reranking: booleanValue(value.reranking, "AI Search info.reranking"),
    ...(optionalString(value.reranking_model, "AI Search info.reranking_model", MODEL) ===
    undefined
      ? {}
      : {
          reranking_model: optionalString(
            value.reranking_model,
            "AI Search info.reranking_model",
            MODEL,
          ),
        }),
    rewrite_query: booleanValue(value.rewrite_query, "AI Search info.rewrite_query"),
    cache: booleanValue(value.cache, "AI Search info.cache"),
    index_method: indexMethod,
    ...(fusionMethod === undefined ? {} : { fusion_method: fusionMethod }),
    ...(decodeKeywordTokenizer(value.indexing_options) === undefined
      ? {}
      : { keyword_tokenizer: decodeKeywordTokenizer(value.indexing_options) }),
    ...(retrievalOptions.keyword_match_mode === undefined
      ? {}
      : { keyword_match_mode: retrievalOptions.keyword_match_mode }),
    boost_by: retrievalOptions.boost_by,
    chunk_size: chunkSize,
    chunk_overlap: chunkOverlap,
    max_num_results: safeInteger(
      value.max_num_results,
      "AI Search info.max_num_results",
      1,
      50,
    ),
    custom_metadata: decodeCustomMetadata(value.custom_metadata),
  };
  return Object.freeze(readback) as AiSearchInstanceReadback;
}

function validateSpec(spec: AiSearchInstanceProvisioningSpec): void {
  try {
    assertCloudflareAiSearchInstanceProfile(spec.profile);
  } catch (cause) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_INPUT_INVALID",
      "desired AI Search profile is invalid",
      cause,
    );
  }
  boundedString(spec.namespace, "AI Search namespace", MAX_NAMESPACE_BYTES);
  if (
    !Number.isSafeInteger(spec.chunk_size) ||
    spec.chunk_size < 64 ||
    spec.chunk_size > 1_000_000
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_INPUT_INVALID",
      "chunk_size must be a safe integer in [64, 1000000]",
    );
  }
  if (
    !Number.isSafeInteger(spec.chunk_overlap) ||
    spec.chunk_overlap < 0 ||
    spec.chunk_overlap >= spec.chunk_size
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_INPUT_INVALID",
      "chunk_overlap must be a non-negative integer below chunk_size",
    );
  }
}

export function compileAiSearchCreateRequest(
  spec: AiSearchInstanceProvisioningSpec,
): AiSearchCreateRequest {
  validateSpec(spec);
  const profile = spec.profile;
  const request: AiSearchCreateRequest = {
    id: profile.id,
    index_method: Object.freeze({
      vector: profile.index_method.vector,
      keyword: profile.index_method.keyword,
    }),
    ...(profile.fusion_method === undefined
      ? {}
      : { fusion_method: profile.fusion_method }),
    ...(profile.keyword_tokenizer === undefined
      ? {}
      : {
          indexing_options: Object.freeze({
            keyword_tokenizer: profile.keyword_tokenizer,
          }),
        }),
    ...(profile.keyword_match_mode === undefined
      ? {}
      : {
          retrieval_options: Object.freeze({
            keyword_match_mode: profile.keyword_match_mode,
            boost_by: Object.freeze([]) as readonly never[],
          }),
        }),
    ...(profile.embedding_model === undefined
      ? {}
      : { embedding_model: profile.embedding_model }),
    reranking: profile.reranking,
    ...(profile.reranking ? { reranking_model: AI_SEARCH_RERANKING_MODEL } : {}),
    rewrite_query: false,
    cache: false,
    chunk_size: spec.chunk_size,
    chunk_overlap: spec.chunk_overlap,
    max_num_results: profile.max_num_results,
    custom_metadata: aiSearchCustomMetadataDefinitions(),
    enable: true,
  };
  return Object.freeze(request);
}

function readbackProfile(
  readback: AiSearchInstanceReadback,
  generation: string,
): AiSearchInstanceProfile {
  return {
    id: readback.id,
    generation,
    index_method: readback.index_method,
    ...(readback.fusion_method === undefined
      ? {}
      : { fusion_method: readback.fusion_method }),
    ...(readback.keyword_tokenizer === undefined
      ? {}
      : { keyword_tokenizer: readback.keyword_tokenizer }),
    ...(readback.keyword_match_mode === undefined
      ? {}
      : { keyword_match_mode: readback.keyword_match_mode }),
    ...(readback.embedding_model === undefined
      ? {}
      : { embedding_model: readback.embedding_model }),
    reranking: readback.reranking,
    max_num_results: readback.max_num_results,
    metadata_fields: Object.freeze(
      readback.custom_metadata.map((definition) => definition.field_name),
    ),
  };
}

function assertReadbackMatchesSpec(
  readback: AiSearchInstanceReadback,
  spec: AiSearchInstanceProvisioningSpec,
): void {
  if (readback.namespace !== spec.namespace) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_CONFIGURATION_MISMATCH",
      "AI Search instance namespace differs from the desired namespace",
    );
  }
  if (readback.type !== null || readback.source !== null) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_CONFIGURATION_MISMATCH",
      "AI Search instance is not backed by built-in storage",
    );
  }
  if (!readback.enable || readback.cache || readback.rewrite_query) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_CONFIGURATION_MISMATCH",
      "AI Search instance enable, cache, or rewrite policy differs",
    );
  }
  if (
    readback.chunk_size !== spec.chunk_size ||
    readback.chunk_overlap !== spec.chunk_overlap ||
    readback.boost_by.length !== 0
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_CONFIGURATION_MISMATCH",
      "AI Search chunking or retrieval boosts differ from the desired profile",
    );
  }
  if (
    readback.custom_metadata.some((definition) => definition.data_type !== "text") ||
    readback.custom_metadata.length !== AI_SEARCH_CUSTOM_METADATA_FIELDS.length
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_CONFIGURATION_MISMATCH",
      "AI Search custom metadata types differ from the canonical text schema",
    );
  }
  if (
    (spec.profile.reranking &&
      readback.reranking_model !== AI_SEARCH_RERANKING_MODEL) ||
    (!spec.profile.reranking && readback.reranking_model !== undefined)
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_CONFIGURATION_MISMATCH",
      "AI Search reranking model differs from the desired profile",
    );
  }
  try {
    const observedProfile = readbackProfile(readback, spec.profile.generation);
    assertCloudflareAiSearchInstanceProfile(observedProfile);
    assertImmutableAiSearchProfile(observedProfile, spec.profile);
  } catch (cause) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_CONFIGURATION_MISMATCH",
      "AI Search immutable instance profile differs from the desired profile",
      cause,
    );
  }
}

async function findExistingInstance(
  namespace: AiSearchProvisioningNamespace,
  spec: AiSearchInstanceProvisioningSpec,
): Promise<AiSearchInstanceSummary | null> {
  const seenIds = new Set<string>();
  const pageFingerprints = new Set<string>();
  const matches: AiSearchInstanceSummary[] = [];
  let expectedTotal: number | undefined;
  let observedCount = 0;
  for (let pageNumber = 1; pageNumber <= MAX_LIST_PAGES; pageNumber += 1) {
    let rawPage: unknown;
    try {
      rawPage = await namespace.list({
        page: pageNumber,
        per_page: LIST_PAGE_SIZE,
        search: spec.profile.id,
        order_by: "created_at",
        order_by_direction: "asc",
      });
    } catch (cause) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_PROVIDER_CALL_FAILED",
        "AI Search namespace list call failed",
        cause,
      );
    }
    const decoded = decodeAiSearchInstanceListPage(rawPage, pageNumber);
    if (expectedTotal === undefined) expectedTotal = decoded.total_count;
    if (decoded.total_count !== expectedTotal) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
        "AI Search list total_count changed during pagination",
      );
    }
    const pageFingerprint = decoded.result.map((entry) => entry.id).join("\u0000");
    if (decoded.result.length > 0 && pageFingerprints.has(pageFingerprint)) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
        "AI Search list repeated a page during pagination",
      );
    }
    pageFingerprints.add(pageFingerprint);
    for (const summary of decoded.result) {
      if (seenIds.has(summary.id)) {
        provisioningFailure(
          summary.id === spec.profile.id
            ? "AI_SEARCH_PROVISIONING_DUPLICATE_INSTANCE"
            : "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
          `AI Search list returned duplicate instance ${summary.id}`,
        );
      }
      seenIds.add(summary.id);
      if (summary.id === spec.profile.id) matches.push(summary);
    }
    observedCount += decoded.result.length;
    if (observedCount > expectedTotal) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
        "AI Search list returned more rows than total_count",
      );
    }
    if (observedCount === expectedTotal) break;
    if (decoded.result.length === 0) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
        "AI Search list ended before total_count was observed",
      );
    }
    if (pageNumber === MAX_LIST_PAGES) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
        "AI Search list exceeded the pagination ceiling",
      );
    }
  }
  if (matches.length > 1) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_DUPLICATE_INSTANCE",
      "AI Search namespace contains duplicate desired instance IDs",
    );
  }
  return matches[0] ?? null;
}

async function readExactInstance(
  handle: AiSearchProvisioningInstance,
  spec: AiSearchInstanceProvisioningSpec,
): Promise<AiSearchInstanceReadback> {
  let rawInfo: unknown;
  try {
    rawInfo = await handle.info();
  } catch (cause) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_CALL_FAILED",
      "AI Search instance info call failed",
      cause,
    );
  }
  const readback = decodeAiSearchInstanceInfo(rawInfo, spec.profile.generation);
  assertReadbackMatchesSpec(readback, spec);
  return readback;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_INPUT_INVALID",
        "canonical provisioning JSON contains a non-finite number",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  provisioningFailure(
    "AI_SEARCH_PROVISIONING_INPUT_INVALID",
    "canonical provisioning JSON contains a non-JSON value",
  );
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function receipt(
  disposition: AiSearchProvisioningDisposition,
  spec: AiSearchInstanceProvisioningSpec,
  request: AiSearchCreateRequest,
  readback: AiSearchInstanceReadback,
): Promise<AiSearchProvisioningReceipt> {
  const desiredDigest = await sha256(request);
  const readbackDigest = await sha256(readback);
  const receiptDigest = await sha256({
    disposition,
    namespace: spec.namespace,
    instance_id: spec.profile.id,
    generation: spec.profile.generation,
    desired_configuration_sha256: desiredDigest,
    readback_configuration_sha256: readbackDigest,
  });
  return Object.freeze({
    receipt_ref: `ai-search-provisioning-${receiptDigest.slice(0, 48)}`,
    disposition,
    namespace: spec.namespace,
    instance_id: spec.profile.id,
    generation: spec.profile.generation,
    provider_status: readback.status,
    provider_created_at: readback.created_at,
    provider_modified_at: readback.modified_at,
    desired_configuration_sha256: desiredDigest,
    readback_configuration_sha256: readbackDigest,
  });
}

async function reconcileCreate(
  namespace: AiSearchProvisioningNamespace,
  spec: AiSearchInstanceProvisioningSpec,
  request: AiSearchCreateRequest,
  originalCause: unknown,
): Promise<AiSearchProvisioningReceipt> {
  try {
    const readback = await readExactInstance(namespace.get(spec.profile.id), spec);
    return receipt("CREATE_RECONCILED", spec, request, readback);
  } catch (reconciliationCause) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_CREATE_UNCERTAIN",
      "AI Search create outcome could not be reconciled to an exact instance",
      new AggregateError(
        [originalCause, reconciliationCause],
        "AI Search create and reconciliation both failed",
      ),
    );
  }
}

export async function ensureAiSearchInstance(
  namespace: AiSearchProvisioningNamespace,
  spec: AiSearchInstanceProvisioningSpec,
): Promise<AiSearchProvisioningReceipt> {
  const request = compileAiSearchCreateRequest(spec);
  const existing = await findExistingInstance(namespace, spec);
  if (existing !== null) {
    const readback = await readExactInstance(namespace.get(spec.profile.id), spec);
    return receipt("EXISTING_MATCH", spec, request, readback);
  }

  let createdHandle: AiSearchProvisioningInstance;
  try {
    createdHandle = await namespace.create(request);
  } catch (cause) {
    return reconcileCreate(namespace, spec, request, cause);
  }
  try {
    const readback = await readExactInstance(createdHandle, spec);
    return receipt("CREATED", spec, request, readback);
  } catch (cause) {
    return reconcileCreate(namespace, spec, request, cause);
  }
}
