import type { ProjectionItem } from "@eliotr/contracts";
import { decodeUnresolvedLocatorCandidates, type ManagedSearchPort, type ProjectionSinkPort, type RetrievalRequest, type UnresolvedLocatorCandidate } from "@eliotr/retrieval";
import type { AiSearchNamespaceLike } from "./bindings.js";
const MAX_RESULTS = 50, MAX_PREVIEW_BYTES = 64 * 1024, MAX_KEY_CHARS = 256, MAX_QUERY_CHARS = 100_000, MAX_CHUNK_ID_CHARS = 256;
const RESULT_KEYS = new Set(["chunks", "search_query"]), CHUNK_KEYS = new Set(["id", "item", "score", "scoring_details", "text", "type"]), ITEM_KEYS = new Set(["key", "metadata", "timestamp"]);
const METADATA_KEYS = new Set(["canonical_section_id", "content_sha256", "instruction_taint", "projection_generation", "source_revision_ref"]), SCORING_KEYS = new Set(["fusion_method", "keyword_rank", "keyword_score", "reranking_score", "vector_rank", "vector_score"]);
export interface AiSearchInstanceProfile { readonly id: string; readonly generation: string; readonly index_method: { readonly vector: boolean; readonly keyword: boolean }; readonly fusion_method?: "rrf" | "max"; readonly keyword_tokenizer?: "porter" | "trigram"; readonly keyword_match_mode?: "and" | "or"; readonly embedding_model?: string; readonly reranking: boolean; readonly max_num_results: number; readonly metadata_fields: readonly string[]; }
export interface AiSearchGenerationManifest { readonly namespace: string; readonly generation: string; readonly instances: readonly AiSearchInstanceProfile[]; readonly active_head_expected_generation: string | null; readonly golden_set_result_ref?: string; }
export interface AiSearchAdapter extends ManagedSearchPort, ProjectionSinkPort { readonly locator_only: true; }
export interface AiSearchAdapterFactory { create(namespace: AiSearchNamespaceLike, manifest: AiSearchGenerationManifest): AiSearchAdapter; }
export interface AiSearchLocatorDecodeOptions { readonly expected_index_generation: string; readonly requested_lanes: readonly ("SEM" | "LEX" | "LITERAL")[]; readonly max_results: number; readonly max_preview_bytes: number; }
export class AiSearchLocatorDecodeError extends Error { public constructor(message: string, cause?: unknown) { super(message, cause === undefined ? undefined : { cause }); this.name = "AiSearchLocatorDecodeError"; } }
interface Metadata { readonly canonical_section_id: string; readonly content_sha256: string; readonly instruction_taint: "CLEARED" | "DATA_ONLY" | "UNTRUSTED" | "COMMAND_LIKE"; readonly projection_generation: string; readonly source_revision_ref: string; }
interface Scoring { readonly fusion_method?: "rrf" | "max"; readonly keyword_rank?: number; readonly keyword_score?: number; readonly reranking_score?: number; readonly vector_rank?: number; readonly vector_score?: number; }
interface Chunk { readonly id: string; readonly item_key: string; readonly provider_item_key: string; readonly item_timestamp?: number; readonly metadata: Metadata; readonly score: number; readonly scoring_details?: Scoring; readonly text: string; readonly type: "text"; }
export function projectionMetadata(item: ProjectionItem): Readonly<Record<string, string>> { return Object.freeze({ canonical_section_id: item.canonical_section_id, content_sha256: item.content_sha256, instruction_taint: item.instruction_taint, projection_generation: item.projection_generation, source_revision_ref: item.source_revision_ref }); }
export function decodeAiSearchSearchResult(request: RetrievalRequest, rawResult: unknown, options: AiSearchLocatorDecodeOptions): readonly UnresolvedLocatorCandidate[] {
  validateRequest(request); validateOptions(request, options); const result = exactObject(rawResult, RESULT_KEYS, "AI Search result"); if (!Array.isArray(result.chunks)) fail("AI Search result.chunks must be an array"); if (result.chunks.length > options.max_results) fail(`AI Search returned ${result.chunks.length} chunks; maximum is ${options.max_results}`); nonemptyString(result.search_query, "AI Search result.search_query", MAX_QUERY_CHARS);
  const seen = new Set<string>(); const candidates = result.chunks.map((raw, index) => { const candidate = mapAiSearchChunkToLocator(request, raw, { expected_index_generation: options.expected_index_generation, requested_lanes: options.requested_lanes, provider_rank: index + 1, max_preview_bytes: options.max_preview_bytes }); if (seen.has(candidate.candidate_id)) fail(`AI Search returned duplicate chunk id ${candidate.candidate_id}`); seen.add(candidate.candidate_id); return candidate; }); return Object.freeze(candidates);
}
export function mapAiSearchChunkToLocator(request: RetrievalRequest, rawChunk: unknown, context: { readonly expected_index_generation: string; readonly requested_lanes: readonly ("SEM" | "LEX" | "LITERAL")[]; readonly provider_rank: number; readonly max_preview_bytes: number }): UnresolvedLocatorCandidate {
  validateRequest(request); const generation = nonemptyString(context.expected_index_generation, "expected_index_generation", 256); validateLanes(context.requested_lanes); positiveInteger(context.provider_rank, "provider_rank"); previewLimit(context.max_preview_bytes); const chunk = parseChunk(rawChunk); if (chunk.metadata.projection_generation !== generation) fail("AI Search chunk projection_generation does not match the promoted managed generation"); if (!request.scope_snapshot.member_source_revision_refs.includes(chunk.metadata.source_revision_ref)) fail("AI Search chunk source_revision_ref is outside the frozen ScopeSnapshot");
  const row = { candidate_id: chunk.id, lane: selectLane(context.requested_lanes, chunk.scoring_details), source_revision_ref: chunk.metadata.source_revision_ref, canonical_section_id: chunk.metadata.canonical_section_id, preview: chunk.text, raw_score: chunk.score, rank: context.provider_rank, index_generation: chunk.metadata.projection_generation, metadata: Object.freeze({ content_sha256: chunk.metadata.content_sha256, instruction_taint: chunk.metadata.instruction_taint, item_key: chunk.item_key, projection_generation: chunk.metadata.projection_generation, provider: "cloudflare_ai_search", provider_chunk_type: chunk.type, provider_item_key: chunk.provider_item_key, ...(chunk.item_timestamp === undefined ? {} : { provider_item_timestamp: chunk.item_timestamp }), ...flattenScoring(chunk.scoring_details) }) };
  const first = decodeLocators([row], 1, context.max_preview_bytes)[0]; if (first === undefined) fail("AI Search locator validation produced no candidate"); return Object.freeze({ ...first, metadata: Object.freeze({ ...first.metadata }) });
}
function parseChunk(raw: unknown): Chunk {
  const chunk = exactObject(raw, CHUNK_KEYS, "AI Search chunk"), id = nonemptyString(chunk.id, "AI Search chunk.id", MAX_CHUNK_ID_CHARS), type = nonemptyString(chunk.type, "AI Search chunk.type", 16); if (type !== "text") fail("AI Search chunk.type must be text"); const score = unitScore(chunk.score, "AI Search chunk.score"); if (typeof chunk.text !== "string") fail("AI Search chunk.text must be a string"); const item = exactObject(chunk.item, ITEM_KEYS, "AI Search chunk.item"), providerItemKey = nonemptyString(item.key, "AI Search chunk.item.key", MAX_KEY_CHARS), itemKey = projectionItemKeyFromProviderKey(providerItemKey), itemTimestamp = item.timestamp === undefined ? undefined : nonnegativeInteger(item.timestamp, "AI Search chunk.item.timestamp"), metadata = parseMetadata(item.metadata); const scoring = chunk.scoring_details === undefined ? undefined : parseScoring(chunk.scoring_details);
  return { id, item_key: itemKey, provider_item_key: providerItemKey, ...(itemTimestamp === undefined ? {} : { item_timestamp: itemTimestamp }), metadata, score, ...(scoring === undefined ? {} : { scoring_details: scoring }), text: chunk.text, type };
}
function projectionItemKeyFromProviderKey(value: string): string { if (!value.endsWith(".md")) fail("AI Search chunk.item.key must use the canonical .md suffix"); const itemKey = value.slice(0, -3); if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,252}$/u.test(itemKey)) fail("AI Search chunk.item.key is not a canonical projection item filename"); return itemKey; } function parseMetadata(raw: unknown): Metadata { const value = exactObject(raw, METADATA_KEYS, "AI Search chunk.item.metadata"), digest = nonemptyString(value.content_sha256, "AI Search metadata.content_sha256", 64), taint = nonemptyString(value.instruction_taint, "AI Search metadata.instruction_taint", 32); if (!/^[a-f0-9]{64}$/u.test(digest)) fail("AI Search metadata.content_sha256 must be 64 lowercase hexadecimal characters"); if (!isTaint(taint)) fail("AI Search metadata.instruction_taint is invalid"); return { canonical_section_id: nonemptyString(value.canonical_section_id, "AI Search metadata.canonical_section_id", 256), content_sha256: digest, instruction_taint: taint, projection_generation: nonemptyString(value.projection_generation, "AI Search metadata.projection_generation", 256), source_revision_ref: nonemptyString(value.source_revision_ref, "AI Search metadata.source_revision_ref", 256) }; }
function parseScoring(raw: unknown): Scoring { const value = exactObject(raw, SCORING_KEYS, "AI Search chunk.scoring_details"), out: { fusion_method?: "rrf" | "max"; keyword_rank?: number; keyword_score?: number; reranking_score?: number; vector_rank?: number; vector_score?: number } = {}; if (value.vector_score !== undefined) out.vector_score = unitScore(value.vector_score, "AI Search scoring_details.vector_score"); if (value.reranking_score !== undefined) out.reranking_score = unitScore(value.reranking_score, "AI Search scoring_details.reranking_score"); if (value.keyword_score !== undefined) out.keyword_score = nonnegativeNumber(value.keyword_score, "AI Search scoring_details.keyword_score"); if (value.keyword_rank !== undefined) out.keyword_rank = positiveInteger(value.keyword_rank, "AI Search scoring_details.keyword_rank"); if (value.vector_rank !== undefined) out.vector_rank = positiveInteger(value.vector_rank, "AI Search scoring_details.vector_rank"); if (value.fusion_method !== undefined) { const method = nonemptyString(value.fusion_method, "AI Search scoring_details.fusion_method", 16); if (method !== "rrf" && method !== "max") fail("AI Search scoring_details.fusion_method is invalid"); out.fusion_method = method; } return Object.freeze(out); }
function flattenScoring(value?: Scoring): Readonly<Record<string, string | number | boolean>> { return value === undefined ? {} : { ...(value.fusion_method === undefined ? {} : { provider_fusion_method: value.fusion_method }), ...(value.keyword_rank === undefined ? {} : { provider_keyword_rank: value.keyword_rank }), ...(value.keyword_score === undefined ? {} : { provider_keyword_score: value.keyword_score }), ...(value.reranking_score === undefined ? {} : { provider_reranking_score: value.reranking_score }), ...(value.vector_rank === undefined ? {} : { provider_vector_rank: value.vector_rank }), ...(value.vector_score === undefined ? {} : { provider_vector_score: value.vector_score }) }; }
function selectLane(lanes: readonly ("SEM" | "LEX" | "LITERAL")[], scoring?: Scoring): "SEM" | "LEX" { if (lanes.includes("SEM") && scoring?.vector_score !== undefined) return "SEM"; if (lanes.includes("LEX") && scoring?.keyword_score !== undefined) return "LEX"; if (lanes.includes("SEM")) return "SEM"; if (lanes.includes("LEX")) return "LEX"; fail("AI Search results require a requested SEM or LEX retrieval lane"); }
function validateRequest(request: RetrievalRequest): void { if (typeof request !== "object" || request === null) fail("retrieval request must be an object"); if (!Number.isInteger(request.requested_limit) || request.requested_limit < 1) fail("retrieval request.requested_limit must be a positive integer"); if (typeof request.scope_snapshot !== "object" || request.scope_snapshot === null || !Array.isArray(request.scope_snapshot.member_source_revision_refs)) fail("retrieval request must contain a frozen ScopeSnapshot"); }
function validateOptions(request: RetrievalRequest, options: AiSearchLocatorDecodeOptions): void { nonemptyString(options.expected_index_generation, "expected_index_generation", 256); validateLanes(options.requested_lanes); if (!Number.isInteger(options.max_results) || options.max_results < 1 || options.max_results > MAX_RESULTS) fail(`AI Search max_results must be an integer between 1 and ${MAX_RESULTS}`); if (options.max_results > request.requested_limit) fail("AI Search max_results exceeds the retrieval request limit"); previewLimit(options.max_preview_bytes); }
function validateLanes(lanes: readonly ("SEM" | "LEX" | "LITERAL")[]): void { if (!Array.isArray(lanes) || lanes.length < 1) fail("AI Search requested_lanes must be a non-empty array"); const seen = new Set<string>(); for (const lane of lanes) { if (lane !== "SEM" && lane !== "LEX" && lane !== "LITERAL") fail("AI Search requested_lanes contains an unsupported lane"); if (seen.has(lane)) fail(`AI Search requested_lanes contains duplicate lane ${lane}`); seen.add(lane); } }
function previewLimit(value: number): void { if (!Number.isInteger(value) || value < 0 || value > MAX_PREVIEW_BYTES) fail(`AI Search max_preview_bytes must be an integer between 0 and ${MAX_PREVIEW_BYTES}`); }
function decodeLocators(input: unknown, maxResults: number, maxPreviewBytes: number): readonly UnresolvedLocatorCandidate[] { try { return decodeUnresolvedLocatorCandidates(input, { max_results: maxResults, max_preview_bytes: maxPreviewBytes }); } catch (error) { if (error instanceof AiSearchLocatorDecodeError) throw error; throw new AiSearchLocatorDecodeError("AI Search result could not be decoded as unresolved locators", error); } }
function exactObject(value: unknown, allowed: ReadonlySet<string>, label: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${label} must be an object`); const prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`); const out = value as Record<string, unknown>; for (const key of Object.keys(out)) if (!allowed.has(key)) fail(`${label} contains unsupported field ${key}`); return out; }
function nonemptyString(value: unknown, label: string, max: number): string { if (typeof value !== "string" || value.length < 1) fail(`${label} must be a non-empty string`); if (value.length > max) fail(`${label} exceeds ${max} characters`); return value; }
function unitScore(value: unknown, label: string): number { const score = nonnegativeNumber(value, label); if (score > 1) fail(`${label} must be between 0 and 1`); return score; }
function nonnegativeNumber(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(`${label} must be a finite nonnegative number`); return value; }
function nonnegativeInteger(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(`${label} must be a nonnegative safe integer`); return value; }
function positiveInteger(value: unknown, label: string): number { const integer = nonnegativeInteger(value, label); if (integer < 1) fail(`${label} must be positive`); return integer; }
function isTaint(value: string): value is Metadata["instruction_taint"] { return value === "CLEARED" || value === "DATA_ONLY" || value === "UNTRUSTED" || value === "COMMAND_LIKE"; }
function fail(message: string): never { throw new AiSearchLocatorDecodeError(message); }

export const AI_SEARCH_MANAGED_QUERY_MAX_BYTES = 64 * 1024;
export const AI_SEARCH_MANAGED_SCOPE_MAX_MEMBERS = 10_000;

export type AiSearchManagedReadErrorCode =
  | "AI_SEARCH_MANAGED_INPUT_INVALID"
  | "AI_SEARCH_MANAGED_NOT_PROMOTED"
  | "AI_SEARCH_MANAGED_PROVIDER_CALL_FAILED"
  | "AI_SEARCH_MANAGED_PROVIDER_RESPONSE_INVALID";

export class AiSearchManagedReadError extends Error {
  public readonly code: AiSearchManagedReadErrorCode;
  public readonly retryable: boolean;
  public readonly ambiguous_effect = "NONE" as const;

  public constructor(
    code: AiSearchManagedReadErrorCode,
    message: string,
    retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AiSearchManagedReadError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface AiSearchManagedSearchAuthority {
  readonly namespace: string;
  readonly instance_id: string;
  readonly index_generation: string;
  readonly registry_revision: number;
  readonly registry_artifact_sha256: string;
  readonly active: boolean;
  readonly max_results: number;
  readonly max_preview_bytes: number;
  readonly match_threshold: number;
  readonly fusion_method: "rrf" | "max";
  readonly keyword_match_mode: "and" | "or";
}

export interface AiSearchManagedSearchRequest {
  readonly query: string;
  readonly ai_search_options: Readonly<{
    retrieval: Readonly<{
      retrieval_type: "vector" | "keyword" | "hybrid";
      match_threshold: number;
      max_num_results: number;
      context_expansion: 0 | 1 | 2 | 3;
      fusion_method?: "rrf" | "max";
      keyword_match_mode?: "and" | "or";
      boost_by: readonly never[];
      metadata_only: false;
    }>;
  }>;
}

const MANAGED_AUTHORITY_KEYS = new Set([
  "active",
  "fusion_method",
  "index_generation",
  "instance_id",
  "keyword_match_mode",
  "match_threshold",
  "max_preview_bytes",
  "max_results",
  "namespace",
  "registry_artifact_sha256",
  "registry_revision",
]);
const MANAGED_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const MANAGED_INSTANCE_ID = /^[a-z0-9_]+(?:-[a-z0-9_]+)*$/u;
const MANAGED_SHA256 = /^[a-f0-9]{64}$/u;

function managedReadFailure(
  code: AiSearchManagedReadErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new AiSearchManagedReadError(code, message, retryable, cause);
}

function managedReadObject(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    managedReadFailure(
      "AI_SEARCH_MANAGED_INPUT_INVALID",
      `${label} must be a plain object`,
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    managedReadFailure(
      "AI_SEARCH_MANAGED_INPUT_INVALID",
      `${label} must be a plain object`,
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      managedReadFailure(
        "AI_SEARCH_MANAGED_INPUT_INVALID",
        `${label} contains unsupported field ${key}`,
      );
    }
  }
  return record;
}

function managedIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !MANAGED_IDENTIFIER.test(value)) {
    managedReadFailure(
      "AI_SEARCH_MANAGED_INPUT_INVALID",
      `${label} is not a bounded identifier`,
    );
  }
  return value;
}

function managedPositiveInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    managedReadFailure(
      "AI_SEARCH_MANAGED_INPUT_INVALID",
      `${label} must be an integer in [1, ${maximum}]`,
    );
  }
  return value;
}

function decodeManagedSearchAuthority(
  input: AiSearchManagedSearchAuthority,
): AiSearchManagedSearchAuthority {
  const value = managedReadObject(
    input,
    MANAGED_AUTHORITY_KEYS,
    "AI Search managed authority",
  );
  const namespace = managedIdentifier(value.namespace, "authority.namespace");
  if (
    typeof value.instance_id !== "string" ||
    value.instance_id.length > 64 ||
    !MANAGED_INSTANCE_ID.test(value.instance_id)
  ) {
    managedReadFailure(
      "AI_SEARCH_MANAGED_INPUT_INVALID",
      "authority.instance_id is not a canonical AI Search instance ID",
    );
  }
  const indexGeneration = managedIdentifier(
    value.index_generation,
    "authority.index_generation",
  );
  const registryRevision = managedPositiveInteger(
    value.registry_revision,
    "authority.registry_revision",
    Number.MAX_SAFE_INTEGER,
  );
  if (
    typeof value.registry_artifact_sha256 !== "string" ||
    !MANAGED_SHA256.test(value.registry_artifact_sha256)
  ) {
    managedReadFailure(
      "AI_SEARCH_MANAGED_INPUT_INVALID",
      "authority.registry_artifact_sha256 must be lowercase SHA-256",
    );
  }
  if (typeof value.active !== "boolean") {
    managedReadFailure(
      "AI_SEARCH_MANAGED_INPUT_INVALID",
      "authority.active must be boolean",
    );
  }
  const maxResults = managedPositiveInteger(
    value.max_results,
    "authority.max_results",
    MAX_RESULTS,
  );
  if (
    typeof value.max_preview_bytes !== "number" ||
    !Number.isSafeInteger(value.max_preview_bytes) ||
    value.max_preview_bytes < 0 ||
    value.max_preview_bytes > MAX_PREVIEW_BYTES
  ) {
    managedReadFailure(
      "AI_SEARCH_MANAGED_INPUT_INVALID",
      `authority.max_preview_bytes must be an integer in [0, ${MAX_PREVIEW_BYTES}]`,
    );
  }
  if (
    typeof value.match_threshold !== "number" ||
    !Number.isFinite(value.match_threshold) ||
    value.match_threshold < 0 ||
    value.match_threshold > 1
  ) {
    managedReadFailure(
      "AI_SEARCH_MANAGED_INPUT_INVALID",
      "authority.match_threshold must be a finite number in [0, 1]",
    );
  }
  if (value.fusion_method !== "rrf" && value.fusion_method !== "max") {
    managedReadFailure(
      "AI_SEARCH_MANAGED_INPUT_INVALID",
      "authority.fusion_method is unsupported",
    );
  }
  if (
    value.keyword_match_mode !== "and" &&
    value.keyword_match_mode !== "or"
  ) {
    managedReadFailure(
      "AI_SEARCH_MANAGED_INPUT_INVALID",
      "authority.keyword_match_mode is unsupported",
    );
  }
  return Object.freeze({
    namespace,
    instance_id: value.instance_id,
    index_generation: indexGeneration,
    registry_revision: registryRevision,
    registry_artifact_sha256: value.registry_artifact_sha256,
    active: value.active,
    max_results: maxResults,
    max_preview_bytes: value.max_preview_bytes,
    match_threshold: value.match_threshold,
    fusion_method: value.fusion_method,
    keyword_match_mode: value.keyword_match_mode,
  });
}

function validateManagedRetrievalRequest(request: RetrievalRequest): string {
  if (typeof request !== "object" || request === null) {
    managedReadFailure(
      "AI_SEARCH_MANAGED_INPUT_INVALID",
      "retrieval request must be an object",
    );
  }
  if (
    typeof request.raw_query !== "string" ||
    request.raw_query.trim().length === 0
  ) {
    managedReadFailure(
      "AI_SEARCH_MANAGED_INPUT_INVALID",
      "retrieval request.raw_query must be non-empty",
    );
  }
  if (
    new TextEncoder().encode(request.raw_query).byteLength >
    AI_SEARCH_MANAGED_QUERY_MAX_BYTES
  ) {
    managedReadFailure(
      "AI_SEARCH_MANAGED_INPUT_INVALID",
      "retrieval request.raw_query exceeds the UTF-8 byte limit",
    );
  }
  managedPositiveInteger(
    request.requested_limit,
    "retrieval request.requested_limit",
    Number.MAX_SAFE_INTEGER,
  );
  managedPositiveInteger(
    request.deadline_ms,
    "retrieval request.deadline_ms",
    Number.MAX_SAFE_INTEGER,
  );
  if (!Array.isArray(request.literals)) {
    managedReadFailure(
      "AI_SEARCH_MANAGED_INPUT_INVALID",
      "retrieval request.literals must be an array",
    );
  }
  if (
    typeof request.scope_snapshot !== "object" ||
    request.scope_snapshot === null ||
    !Array.isArray(
      request.scope_snapshot.member_source_revision_refs,
    )
  ) {
    managedReadFailure(
      "AI_SEARCH_MANAGED_INPUT_INVALID",
      "retrieval request must contain a frozen ScopeSnapshot",
    );
  }
  const members = request.scope_snapshot.member_source_revision_refs;
  if (members.length > AI_SEARCH_MANAGED_SCOPE_MAX_MEMBERS) {
    managedReadFailure(
      "AI_SEARCH_MANAGED_INPUT_INVALID",
      "ScopeSnapshot member count exceeds the managed-search bound",
    );
  }
  const seen = new Set<string>();
  for (const [index, member] of members.entries()) {
    const bounded = managedIdentifier(
      member,
      `scope_snapshot.member_source_revision_refs[${index}]`,
    );
    if (seen.has(bounded)) {
      managedReadFailure(
        "AI_SEARCH_MANAGED_INPUT_INVALID",
        `ScopeSnapshot contains duplicate source revision ${bounded}`,
      );
    }
    seen.add(bounded);
  }
  return request.raw_query;
}

function managedRetrievalType(
  lanes: readonly ("SEM" | "LEX" | "LITERAL")[],
): "vector" | "keyword" | "hybrid" {
  if (!Array.isArray(lanes) || lanes.length < 1 || lanes.length > 2) {
    managedReadFailure(
      "AI_SEARCH_MANAGED_INPUT_INVALID",
      "managed search requires one or two retrieval lanes",
    );
  }
  const seen = new Set<string>();
  for (const lane of lanes) {
    if (lane !== "SEM" && lane !== "LEX") {
      managedReadFailure(
        "AI_SEARCH_MANAGED_INPUT_INVALID",
        "managed search admits only SEM and LEX lanes",
      );
    }
    if (seen.has(lane)) {
      managedReadFailure(
        "AI_SEARCH_MANAGED_INPUT_INVALID",
        `managed search contains duplicate lane ${lane}`,
      );
    }
    seen.add(lane);
  }
  if (seen.has("SEM") && seen.has("LEX")) return "hybrid";
  return seen.has("SEM") ? "vector" : "keyword";
}

function managedContextExpansion(
  value: 0 | 1 | 2 | 3,
): 0 | 1 | 2 | 3 {
  if (!Number.isInteger(value) || value < 0 || value > 3) {
    managedReadFailure(
      "AI_SEARCH_MANAGED_INPUT_INVALID",
      "managed search context expansion must be an integer in [0, 3]",
    );
  }
  return value;
}

export function compileAiSearchManagedSearchRequest(
  request: RetrievalRequest,
  lanes: readonly ("SEM" | "LEX" | "LITERAL")[],
  contextExpansion: 0 | 1 | 2 | 3,
  inputAuthority: AiSearchManagedSearchAuthority,
): AiSearchManagedSearchRequest {
  const authority = decodeManagedSearchAuthority(inputAuthority);
  if (!authority.active) {
    managedReadFailure(
      "AI_SEARCH_MANAGED_NOT_PROMOTED",
      "AI Search managed generation is not the promoted active authority",
    );
  }
  const query = validateManagedRetrievalRequest(request);
  const retrievalType = managedRetrievalType(lanes);
  const context = managedContextExpansion(contextExpansion);
  const maxNumResults = Math.min(
    request.requested_limit,
    authority.max_results,
  );
  const boostBy = Object.freeze([]) as readonly never[];
  const retrieval = Object.freeze({
    retrieval_type: retrievalType,
    match_threshold: authority.match_threshold,
    max_num_results: maxNumResults,
    context_expansion: context,
    ...(retrievalType === "hybrid"
      ? { fusion_method: authority.fusion_method }
      : {}),
    ...(retrievalType === "vector"
      ? {}
      : { keyword_match_mode: authority.keyword_match_mode }),
    boost_by: boostBy,
    metadata_only: false as const,
  });
  return Object.freeze({
    query,
    ai_search_options: Object.freeze({ retrieval }),
  });
}

function validateManagedNamespace(
  namespace: AiSearchNamespaceLike,
): void {
  if (
    typeof namespace !== "object" ||
    namespace === null ||
    typeof namespace.get !== "function"
  ) {
    managedReadFailure(
      "AI_SEARCH_MANAGED_INPUT_INVALID",
      "AI Search namespace binding is invalid",
    );
  }
}

export function createAiSearchManagedSearchPort(
  namespace: AiSearchNamespaceLike,
  inputAuthority: AiSearchManagedSearchAuthority,
): ManagedSearchPort {
  validateManagedNamespace(namespace);
  const authority = decodeManagedSearchAuthority(inputAuthority);
  return Object.freeze({
    async search(request, lanes, contextExpansion) {
      const compiled = compileAiSearchManagedSearchRequest(
        request,
        lanes,
        contextExpansion,
        authority,
      );
      if (
        request.scope_snapshot.member_source_revision_refs.length === 0
      ) {
        return Object.freeze([]) as readonly UnresolvedLocatorCandidate[];
      }

      let instance;
      try {
        instance = namespace.get(authority.instance_id);
        if (
          typeof instance !== "object" ||
          instance === null ||
          typeof instance.search !== "function"
        ) {
          throw new Error("AI Search instance search capability is missing");
        }
      } catch (cause) {
        managedReadFailure(
          "AI_SEARCH_MANAGED_PROVIDER_CALL_FAILED",
          "AI Search promoted instance could not be resolved",
          true,
          cause,
        );
      }

      let rawResult: unknown;
      try {
        rawResult = await instance.search(compiled);
      } catch (cause) {
        managedReadFailure(
          "AI_SEARCH_MANAGED_PROVIDER_CALL_FAILED",
          "AI Search promoted instance search call failed",
          true,
          cause,
        );
      }

      let candidates: readonly UnresolvedLocatorCandidate[];
      const maxResults = Math.min(
        request.requested_limit,
        authority.max_results,
      );
      try {
        candidates = decodeAiSearchSearchResult(request, rawResult, {
          expected_index_generation: authority.index_generation,
          requested_lanes: lanes,
          max_results: maxResults,
          max_preview_bytes: authority.max_preview_bytes,
        });
      } catch (cause) {
        managedReadFailure(
          "AI_SEARCH_MANAGED_PROVIDER_RESPONSE_INVALID",
          "AI Search result failed the managed locator boundary",
          false,
          cause,
        );
      }

      return Object.freeze(
        candidates.map((candidate) =>
          Object.freeze({
            ...candidate,
            metadata: Object.freeze({
              ...candidate.metadata,
              provider_namespace: authority.namespace,
              active_registry_revision: authority.registry_revision,
              active_registry_artifact_sha256:
                authority.registry_artifact_sha256,
            }),
          }),
        ),
      );
    },
  });
}
