from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return source.replace(old, new, 1)


profile_path = Path("packages/cloudflare-ai/src/ai-search-profile.ts")
profile = profile_path.read_text(encoding="utf-8")
profile = replace_once(
    profile,
    'export const AI_SEARCH_RERANKING_MODEL = "@cf/baai/bge-reranker-base" as const;\n',
    'export const AI_SEARCH_RERANKING_MODEL = "@cf/baai/bge-reranker-base" as const;\n'
    'export const AI_SEARCH_RETRIEVAL_GATEWAY_ID = "eliotr-retrieval" as const;\n'
    'export const AI_SEARCH_SCORE_THRESHOLD = 0 as const;\n'
    'export const AI_SEARCH_MAX_CHUNK_OVERLAP = 30 as const;\n',
    "profile provider constants",
)
profile_path.write_text(profile, encoding="utf-8")


contract_path = Path("packages/cloudflare-ai/src/ai-search-provisioning-contract.ts")
contract = contract_path.read_text(encoding="utf-8")
contract = replace_once(
    contract,
    '''  AI_SEARCH_RERANKING_MODEL,
  aiSearchCustomMetadataDefinitions,
''',
    '''  AI_SEARCH_MAX_CHUNK_OVERLAP,
  AI_SEARCH_RERANKING_MODEL,
  AI_SEARCH_RETRIEVAL_GATEWAY_ID,
  AI_SEARCH_SCORE_THRESHOLD,
  aiSearchCustomMetadataDefinitions,
''',
    "contract constant imports",
)
contract = replace_once(
    contract,
    '''export interface AiSearchCreateRequest {
  readonly id: string;
''',
    '''export interface AiSearchCreateRequest {
  readonly id: string;
  readonly ai_gateway_id: typeof AI_SEARCH_RETRIEVAL_GATEWAY_ID;
''',
    "create request gateway field",
)
contract = replace_once(
    contract,
    '''  readonly chunk_overlap: number;
  readonly max_num_results: number;
''',
    '''  readonly chunk_overlap: number;
  readonly score_threshold: typeof AI_SEARCH_SCORE_THRESHOLD;
  readonly max_num_results: number;
''',
    "create request threshold field",
)
contract = replace_once(
    contract,
    '''    spec.chunk_overlap < 0 ||
    spec.chunk_overlap >= spec.chunk_size
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_INPUT_INVALID",
      "chunk_overlap must be a non-negative integer below chunk_size",
''',
    '''    spec.chunk_overlap < 0 ||
    spec.chunk_overlap > AI_SEARCH_MAX_CHUNK_OVERLAP ||
    spec.chunk_overlap >= spec.chunk_size
  ) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_INPUT_INVALID",
      `chunk_overlap must be an integer in [0, ${AI_SEARCH_MAX_CHUNK_OVERLAP}] and below chunk_size`,
''',
    "provider chunk overlap limit",
)
contract = replace_once(
    contract,
    '''  return Object.freeze({
    id: profile.id,
''',
    '''  return Object.freeze({
    id: profile.id,
    ai_gateway_id: AI_SEARCH_RETRIEVAL_GATEWAY_ID,
''',
    "create gateway policy",
)
contract = replace_once(
    contract,
    '''    chunk_overlap: spec.chunk_overlap,
    max_num_results: profile.max_num_results,
''',
    '''    chunk_overlap: spec.chunk_overlap,
    score_threshold: AI_SEARCH_SCORE_THRESHOLD,
    max_num_results: profile.max_num_results,
''',
    "create score threshold policy",
)
contract_path.write_text(contract, encoding="utf-8")


decode_path = Path("packages/cloudflare-ai/src/ai-search-provisioning-decode.ts")
decode = decode_path.read_text(encoding="utf-8")
decode = replace_once(
    decode,
    '''export interface AiSearchInstanceReadback extends AiSearchInstanceSummary {
  readonly embedding_model?: string;
''',
    '''export interface AiSearchInstanceReadback extends AiSearchInstanceSummary {
  readonly ai_gateway_id?: string;
  readonly embedding_model?: string;
''',
    "readback gateway field",
)
decode = replace_once(
    decode,
    '''  readonly chunk_overlap: number;
  readonly max_num_results: number;
''',
    '''  readonly chunk_overlap: number;
  readonly score_threshold?: number;
  readonly max_num_results: number;
''',
    "readback threshold field",
)
decode = replace_once(
    decode,
    '''function booleanValue(value: unknown, label: string): boolean {
''',
    '''function optionalUnitInterval(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    provisioningFailure(
      "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
      `${label} must be a finite number in [0, 1]`,
    );
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
''',
    "unit interval decoder",
)
decode = replace_once(
    decode,
    '''  optionalString(value.rewrite_model, "AI Search info.rewrite_model", MODEL);
  optionalString(value.ai_gateway_id, "AI Search info.ai_gateway_id");
  optionalString(value.token_id, "AI Search info.token_id");
''',
    '''  optionalString(value.rewrite_model, "AI Search info.rewrite_model", MODEL);
  optionalString(value.token_id, "AI Search info.token_id");
''',
    "gateway decode ownership",
)
decode = replace_once(
    decode,
    '''  if (value.score_threshold !== undefined && value.score_threshold !== null) {
    const score = value.score_threshold;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
      provisioningFailure(
        "AI_SEARCH_PROVISIONING_PROVIDER_RESPONSE_INVALID",
        "AI Search info.score_threshold is invalid",
      );
    }
  }
''',
    "",
    "threshold decode ownership",
)
decode = replace_once(
    decode,
    '''  const embeddingModel = optionalString(
    value.embedding_model,
''',
    '''  const gatewayId = optionalString(value.ai_gateway_id, "AI Search info.ai_gateway_id");
  const scoreThreshold = optionalUnitInterval(
    value.score_threshold,
    "AI Search info.score_threshold",
  );
  const embeddingModel = optionalString(
    value.embedding_model,
''',
    "readback operational fields",
)
decode = replace_once(
    decode,
    '''  return Object.freeze({
    ...summary,
    ...(embeddingModel === undefined ? {} : { embedding_model: embeddingModel }),
''',
    '''  return Object.freeze({
    ...summary,
    ...(gatewayId === undefined ? {} : { ai_gateway_id: gatewayId }),
    ...(embeddingModel === undefined ? {} : { embedding_model: embeddingModel }),
''',
    "return gateway readback",
)
decode = replace_once(
    decode,
    '''    chunk_overlap: chunkOverlap,
    max_num_results: safeInteger(
''',
    '''    chunk_overlap: chunkOverlap,
    ...(scoreThreshold === undefined ? {} : { score_threshold: scoreThreshold }),
    max_num_results: safeInteger(
''',
    "return score threshold readback",
)
decode_path.write_text(decode, encoding="utf-8")


orchestration_path = Path("packages/cloudflare-ai/src/ai-search-provisioning.ts")
orchestration = orchestration_path.read_text(encoding="utf-8")
orchestration = replace_once(
    orchestration,
    '''  AI_SEARCH_CUSTOM_METADATA_FIELDS,
  AI_SEARCH_RERANKING_MODEL,
''',
    '''  AI_SEARCH_CUSTOM_METADATA_FIELDS,
  AI_SEARCH_RERANKING_MODEL,
  AI_SEARCH_RETRIEVAL_GATEWAY_ID,
  AI_SEARCH_SCORE_THRESHOLD,
''',
    "orchestration constant imports",
)
orchestration = replace_once(
    orchestration,
    '''  if (!readback.enable || readback.cache || readback.rewrite_query) {
''',
    '''  if (
    !readback.enable ||
    readback.cache ||
    readback.rewrite_query ||
    readback.ai_gateway_id !== AI_SEARCH_RETRIEVAL_GATEWAY_ID ||
    readback.score_threshold !== AI_SEARCH_SCORE_THRESHOLD
  ) {
''',
    "operational readback comparison",
)
orchestration = replace_once(
    orchestration,
    '      "AI Search instance enable, cache, or rewrite policy differs",\n',
    '      "AI Search instance enable, cache, rewrite, gateway, or score policy differs",\n',
    "operational mismatch message",
)
orchestration_path.write_text(orchestration, encoding="utf-8")


test_path = Path("infra/ai-search/ai-search-provisioning.test.mjs")
test = test_path.read_text(encoding="utf-8")
test = replace_once(
    test,
    '''  AI_SEARCH_CUSTOM_METADATA_FIELDS,
  AI_SEARCH_RERANKING_MODEL,
''',
    '''  AI_SEARCH_CUSTOM_METADATA_FIELDS,
  AI_SEARCH_MAX_CHUNK_OVERLAP,
  AI_SEARCH_RERANKING_MODEL,
  AI_SEARCH_RETRIEVAL_GATEWAY_ID,
  AI_SEARCH_SCORE_THRESHOLD,
''',
    "test constant imports",
)
test = test.replace("chunk_overlap: 64,", "chunk_overlap: 20,")
test = replace_once(
    test,
    '''    ai_search_model: null,
    embedding_model: "@cf/baai/bge-m3",
''',
    '''    ai_search_model: null,
    ai_gateway_id: AI_SEARCH_RETRIEVAL_GATEWAY_ID,
    embedding_model: "@cf/baai/bge-m3",
''',
    "info gateway fixture",
)
test = replace_once(
    test,
    '''      id: "search-instance-g2",
      index_method: { vector: true, keyword: true },
''',
    '''      id: "search-instance-g2",
      ai_gateway_id: AI_SEARCH_RETRIEVAL_GATEWAY_ID,
      index_method: { vector: true, keyword: true },
''',
    "create gateway assertion",
)
test = replace_once(
    test,
    '''      chunk_overlap: 20,
      max_num_results: 20,
''',
    '''      chunk_overlap: 20,
      score_threshold: AI_SEARCH_SCORE_THRESHOLD,
      max_num_results: 20,
''',
    "create threshold assertion",
)
test = replace_once(
    test,
    '''      info({ rewrite_query: true }),
      info({ chunk_size: 768 }),
''',
    '''      info({ rewrite_query: true }),
      info({ ai_gateway_id: "wrong-retrieval-gateway" }),
      info({ score_threshold: 0.4 }),
      info({ chunk_size: 768 }),
''',
    "operational mismatch cases",
)
test = replace_once(
    test,
    '''    expectSyncCode(
      () =>
        compileAiSearchCreateRequest(
          spec({
            profile: profile({
              metadata_fields: AI_SEARCH_CUSTOM_METADATA_FIELDS.slice(0, 4),
            }),
          }),
        ),
      "AI_SEARCH_PROVISIONING_INPUT_INVALID",
    );
  });
''',
    '''    expectSyncCode(
      () =>
        compileAiSearchCreateRequest(
          spec({
            profile: profile({
              metadata_fields: AI_SEARCH_CUSTOM_METADATA_FIELDS.slice(0, 4),
            }),
          }),
        ),
      "AI_SEARCH_PROVISIONING_INPUT_INVALID",
    );
    expectSyncCode(
      () =>
        compileAiSearchCreateRequest(
          spec({ chunk_overlap: AI_SEARCH_MAX_CHUNK_OVERLAP + 1 }),
        ),
      "AI_SEARCH_PROVISIONING_INPUT_INVALID",
    );
  });
''',
    "overlap provider-limit negative",
)
test = replace_once(
    test,
    '''      id: "search-instance-g2",
      embedding_model: "@cf/baai/bge-m3",
''',
    '''      id: "search-instance-g2",
      ai_gateway_id: AI_SEARCH_RETRIEVAL_GATEWAY_ID,
      embedding_model: "@cf/baai/bge-m3",
      score_threshold: AI_SEARCH_SCORE_THRESHOLD,
''',
    "standalone operational readback assertion",
)
test_path.write_text(test, encoding="utf-8")


doc_path = Path("docs/agent-work/ER-16-ai-search-and-model-gateway-adapters.md")
doc = doc_path.read_text(encoding="utf-8")
doc = replace_once(
    doc,
    '''validates the real Cloudflare instance-ID grammar, the immutable vector/keyword/fusion profile, chunking,
and the exact five-field text metadata schema shared with projection upload and retrieval decoding.
''',
    '''validates the real Cloudflare instance-ID grammar, the immutable vector/keyword/fusion profile, the
provider's 0-30 chunk-overlap range, and the exact five-field text metadata schema shared with
projection upload and retrieval decoding. Every instance is explicitly attached to `eliotr-retrieval`,
uses `score_threshold: 0` so provider defaults cannot silently reduce recall, and keeps cache and query
rewriting disabled.
''',
    "provisioning provider limits documentation",
)
doc_path.write_text(doc, encoding="utf-8")
