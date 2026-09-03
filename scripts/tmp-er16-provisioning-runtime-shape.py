from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return source.replace(old, new, 1)


contract_path = Path("packages/cloudflare-ai/src/ai-search-provisioning-contract.ts")
contract = contract_path.read_text(encoding="utf-8")
contract = replace_once(
    contract,
    '''  readonly rewrite_query: false;
  readonly cache: false;
  readonly chunk_size: number;
''',
    '''  readonly rewrite_query: false;
  readonly cache: false;
  readonly chunk: true;
  readonly chunk_size: number;
''',
    "create request chunk field",
)
contract = replace_once(
    contract,
    '''    rewrite_query: false,
    cache: false,
    chunk_size: spec.chunk_size,
''',
    '''    rewrite_query: false,
    cache: false,
    chunk: true,
    chunk_size: spec.chunk_size,
''',
    "create request chunk policy",
)
contract_path.write_text(contract, encoding="utf-8")


decode_path = Path("packages/cloudflare-ai/src/ai-search-provisioning-decode.ts")
decode = decode_path.read_text(encoding="utf-8")
decode = replace_once(
    decode,
    '''  readonly rewrite_query: boolean;
  readonly cache: boolean;
  readonly index_method: Readonly<{ vector: boolean; keyword: boolean }>;
''',
    '''  readonly rewrite_query: boolean;
  readonly cache: boolean;
  readonly chunk: boolean;
  readonly index_method: Readonly<{ vector: boolean; keyword: boolean }>;
''',
    "readback chunk field",
)
decode = replace_once(
    decode,
    '''const SUMMARY_KEYS = new Set([
  "created_at",
  "enable",
  "id",
  "modified_at",
  "namespace",
  "source",
  "status",
  "type",
]);
''',
    "",
    "remove summary-only key ceiling",
)
decode = replace_once(
    decode,
    '''  "cache_ttl",
  "chunk_overlap",
  "chunk_size",
  "created_at",
  "custom_metadata",
''',
    '''  "cache_ttl",
  "chunk",
  "chunk_overlap",
  "chunk_size",
  "created_at",
  "created_by",
  "custom_metadata",
''',
    "official runtime info fields part one",
)
decode = replace_once(
    decode,
    '''  "enable",
  "fusion_method",
  "id",
''',
    '''  "enable",
  "engine_version",
  "fusion_method",
  "hybrid_search_enabled",
  "id",
''',
    "official runtime info fields part two",
)
decode = replace_once(
    decode,
    '''  "max_num_results",
  "modified_at",
  "namespace",
  "reranking",
''',
    '''  "max_num_results",
  "metadata",
  "modified_at",
  "modified_by",
  "namespace",
  "paused",
  "reranking",
''',
    "official runtime info fields part three",
)
decode = replace_once(
    decode,
    '''function booleanValue(value: unknown, label: string): boolean {
''',
    '''function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  return booleanValue(value, label);
}

function booleanValue(value: unknown, label: string): boolean {
''',
    "optional boolean helper",
)
decode = replace_once(
    decode,
    '''function sourceType(value: unknown, label: string): AiSearchInstanceSummary["type"] {
  if (value !== null && value !== "r2" && value !== "web-crawler") {
''',
    '''function sourceType(value: unknown, label: string): AiSearchInstanceSummary["type"] {
  if (value === undefined || value === null) return null;
  if (value !== "r2" && value !== "web-crawler") {
''',
    "optional built-in source type",
)
decode = replace_once(
    decode,
    '''function sourceValue(value: unknown, label: string): string | null {
  if (value === null) return null;
''',
    '''function sourceValue(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
''',
    "optional built-in source value",
)
decode = replace_once(
    decode,
    '''function decodeSummaryFields(
  value: Record<string, unknown>,
  label: string,
): AiSearchInstanceSummary {
  return Object.freeze({
''',
    '''function enabledState(value: Record<string, unknown>, label: string): boolean {
  const enabled = optionalBoolean(value.enable, `${label}.enable`);
  const paused = optionalBoolean(value.paused, `${label}.paused`);
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

function decodeSummaryFields(
  value: Record<string, unknown>,
  label: string,
): AiSearchInstanceSummary {
  return Object.freeze({
''',
    "normalized enabled state",
)
decode = replace_once(
    decode,
    '''    status: instanceStatus(value.status, `${label}.status`),
    enable: booleanValue(value.enable, `${label}.enable`),
''',
    '''    status: instanceStatus(value.status, `${label}.status`),
    enable: enabledState(value, label),
''',
    "summary enabled normalization",
)
decode = replace_once(
    decode,
    '''function decodeSummary(raw: unknown, label: string): AiSearchInstanceSummary {
  return decodeSummaryFields(exactObject(raw, SUMMARY_KEYS, label), label);
}
''',
    '''function decodeSummary(raw: unknown, label: string): AiSearchInstanceSummary {
  return decodeSummaryFields(exactObject(raw, INFO_KEYS, label), label);
}
''',
    "list accepts the documented info shape",
)
decode = replace_once(
    decode,
    '''  const resultInfo = exactObject(
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
''',
    '''  if (value.result_info === undefined) {
    if (value.result.length === AI_SEARCH_LIST_PAGE_SIZE) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
        "AI Search instance list omits pagination at the page-size boundary",
      );
    }
    return Object.freeze({
      result: Object.freeze(
        value.result.map((entry, index) =>
          decodeSummary(entry, `AI Search instance list result[${index}]`),
        ),
      ),
      total_count: value.result.length,
    });
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
''',
    "optional bounded list pagination",
)
decode = replace_once(
    decode,
    '''function validateOptionalInfoFields(value: Record<string, unknown>): void {
  optionalString(value.ai_search_model, "AI Search info.ai_search_model", MODEL);
''',
    '''function validateProviderMetadata(raw: unknown): void {
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

function validateOptionalInfoFields(value: Record<string, unknown>): void {
  optionalString(value.ai_search_model, "AI Search info.ai_search_model", MODEL);
''',
    "bounded provider metadata",
)
decode = replace_once(
    decode,
    '''  optionalString(value.token_id, "AI Search info.token_id");
  if (value.source_params !== undefined && value.source_params !== null) {
''',
    '''  optionalString(value.token_id, "AI Search info.token_id");
  optionalString(value.created_by, "AI Search info.created_by");
  optionalString(value.modified_by, "AI Search info.modified_by");
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
  validateProviderMetadata(value.metadata);
  if (value.source_params !== undefined && value.source_params !== null) {
''',
    "official optional info validation",
)
decode = replace_once(
    decode,
    '''  const summary = decodeSummaryFields(value, "AI Search instance info");
  const indexMethod = decodeIndexMethod(value.index_method);
''',
    '''  const summary = decodeSummaryFields(value, "AI Search instance info");
  const indexMethod = decodeIndexMethod(value.index_method);
  const legacyHybrid = optionalBoolean(
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
''',
    "legacy hybrid consistency",
)
decode = replace_once(
    decode,
    '''    rewrite_query: booleanValue(value.rewrite_query, "AI Search info.rewrite_query"),
    cache: booleanValue(value.cache, "AI Search info.cache"),
    index_method: indexMethod,
''',
    '''    rewrite_query: booleanValue(value.rewrite_query, "AI Search info.rewrite_query"),
    cache: booleanValue(value.cache, "AI Search info.cache"),
    chunk: booleanValue(value.chunk, "AI Search info.chunk"),
    index_method: indexMethod,
''',
    "strict chunk readback",
)
decode_path.write_text(decode, encoding="utf-8")


orchestration_path = Path("packages/cloudflare-ai/src/ai-search-provisioning.ts")
orchestration = orchestration_path.read_text(encoding="utf-8")
orchestration = replace_once(
    orchestration,
    '''    !readback.enable ||
    readback.cache ||
    readback.rewrite_query ||
''',
    '''    !readback.enable ||
    !readback.chunk ||
    readback.cache ||
    readback.rewrite_query ||
''',
    "chunk readback policy",
)
orchestration = replace_once(
    orchestration,
    '      "AI Search instance enable, cache, rewrite, gateway, or score policy differs",\n',
    '      "AI Search instance enable, chunk, cache, rewrite, gateway, or score policy differs",\n',
    "chunk mismatch message",
)
orchestration_path.write_text(orchestration, encoding="utf-8")


test_path = Path("infra/ai-search/ai-search-provisioning.test.mjs")
test = test_path.read_text(encoding="utf-8")
test = replace_once(
    test,
    '''    cache: false,
    cache_threshold: "close_enough",
''',
    '''    cache: false,
    cache_threshold: "close_enough",
    chunk: true,
''',
    "runtime chunk fixture",
)
test = replace_once(
    test,
    '''    custom_metadata: metadata(),
    last_activity: timestamp,
''',
    '''    custom_metadata: metadata(),
    metadata: { created_from_aisearch_wizard: false },
    last_activity: timestamp,
''',
    "runtime metadata fixture",
)
test = replace_once(
    test,
    '''      rewrite_query: false,
      cache: false,
      chunk_size: 512,
''',
    '''      rewrite_query: false,
      cache: false,
      chunk: true,
      chunk_size: 512,
''',
    "create chunk assertion",
)
test = replace_once(
    test,
    '''      info({ rewrite_query: true }),
      info({ ai_gateway_id: "wrong-retrieval-gateway" }),
''',
    '''      info({ rewrite_query: true }),
      info({ chunk: false }),
      info({ ai_gateway_id: "wrong-retrieval-gateway" }),
''',
    "chunk mismatch negative",
)
test = replace_once(
    test,
    '''  it("strictly decodes standalone list and info fixtures", () => {
''',
    '''  it("normalizes the official paused and optional built-in source shape", () => {
    const runtimeShape = info({
      type: undefined,
      source: undefined,
      enable: undefined,
      paused: false,
      hybrid_search_enabled: true,
      created_by: "cloudflare",
      modified_by: "cloudflare",
      engine_version: 2,
    });
    expect(decodeAiSearchInstanceInfo(runtimeShape)).toMatchObject({
      type: null,
      source: null,
      enable: true,
      chunk: true,
    });
    const withoutPagination = listPage();
    delete withoutPagination.result_info;
    expect(decodeAiSearchInstanceListPage(withoutPagination, 1)).toMatchObject({
      total_count: 1,
    });
  });

  it("rejects contradictory compatibility fields and unbounded provider metadata", () => {
    expectSyncCode(
      () => decodeAiSearchInstanceInfo(info({ enable: true, paused: true })),
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
    );
    expectSyncCode(
      () => decodeAiSearchInstanceInfo(info({ hybrid_search_enabled: false })),
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
    );
    const oversizedMetadata = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`key-${index}`, index]),
    );
    expectSyncCode(
      () => decodeAiSearchInstanceInfo(info({ metadata: oversizedMetadata })),
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
    );
  });

  it("strictly decodes standalone list and info fixtures", () => {
''',
    "runtime shape negative corpus",
)
test_path.write_text(test, encoding="utf-8")


doc_path = Path("docs/agent-work/ER-16-ai-search-and-model-gateway-adapters.md")
doc = doc_path.read_text(encoding="utf-8")
doc = replace_once(
    doc,
    '''The provider contract was rechecked against the official Workers Binding and REST create schemas on
2026-09-03. The implementation pins the binding's `list`/`get`/`create` surface, the 64-character
instance-ID ceiling, the five custom-metadata slots, immutable embedding-model behavior and the REST
chunk-overlap ceiling rather than relying on undocumented defaults.
''',
    '''The provider contract was rechecked against the official Workers Binding, generated runtime types
and REST create schemas on 2026-09-03. The implementation pins the binding's `list`/`get`/`create`
surface, the 64-character instance-ID ceiling, the five custom-metadata slots, immutable embedding-model
behavior and the REST chunk-overlap ceiling rather than relying on undocumented defaults. Strict
readback accepts both documented `enable` and generated-runtime `paused` state, optional built-in
`type`/`source`, the compatibility `hybrid_search_enabled` flag, explicit chunk state and bounded
provider metadata; contradictory compatibility fields still fail closed.
''',
    "runtime shape documentation",
)
doc_path.write_text(doc, encoding="utf-8")
