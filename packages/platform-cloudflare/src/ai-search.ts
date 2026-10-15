import type { ProjectionItem } from "@eliotr/contracts";
import { decodeUnresolvedLocatorCandidates, type ManagedSearchPort, type ProjectionSinkPort, type RetrievalRequest, type UnresolvedLocatorCandidate } from "@eliotr/retrieval";
import type { AiSearchNamespaceLike } from "./bindings.js";
const MAX_RESULTS = 50, MAX_PREVIEW_BYTES = 64 * 1024, MAX_KEY_CHARS = 128, MAX_QUERY_CHARS = 100_000, MAX_CHUNK_ID_CHARS = 256;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const RESULT_KEYS = new Set(["chunks", "query_kind", "search_query"]), CHUNK_KEYS = new Set(["id", "item", "score", "scoring_details", "text", "type"]), ITEM_KEYS = new Set(["key", "metadata", "timestamp"]);
const METADATA_KEYS = new Set(["canonical_section_id", "content_sha256", "instruction_taint", "projection_generation", "source_revision_ref"]), SCORING_KEYS = new Set(["fusion_method", "keyword_rank", "keyword_score", "reranking_score", "vector_rank", "vector_score"]);
export interface AiSearchInstanceProfile { readonly id: string; readonly generation: string; readonly index_method: { readonly vector: boolean; readonly keyword: boolean }; readonly fusion_method?: "rrf" | "max"; readonly keyword_tokenizer?: "porter" | "trigram"; readonly keyword_match_mode?: "and" | "or"; readonly embedding_model?: string; readonly reranking: boolean; readonly max_num_results: number; readonly metadata_fields: readonly string[]; }
export interface AiSearchGenerationManifest { readonly namespace: string; readonly generation: string; readonly instances: readonly AiSearchInstanceProfile[]; readonly active_head_expected_generation: string | null; readonly golden_set_result_ref?: string; }
export interface AiSearchAdapter extends ManagedSearchPort, ProjectionSinkPort { readonly locator_only: true; }
export interface AiSearchAdapterFactory { create(namespace: AiSearchNamespaceLike, manifest: AiSearchGenerationManifest): AiSearchAdapter; }
export interface AiSearchExpectedProjectCopy {
  readonly source_revision_ref: string;
  readonly source_owner_generation: string;
  readonly project_id: string;
  readonly project_membership_id: string;
  readonly membership_generation: number;
  readonly folder_prefix: string;
}
export type AiSearchExpectedProjectCopyV2 = AiSearchExpectedProjectCopy & (
  | {
    readonly membership_identity_version: 1;
    readonly legacy_project_membership_id: string;
    readonly stable_project_membership_id?: never;
    readonly membership_revision?: never;
    readonly project_membership_generation?: never;
  }
  | {
    readonly membership_identity_version: 2;
    readonly stable_project_membership_id: string;
    readonly membership_revision: number;
    /** Aggregate currentness fence; never part of the stable membership identity. */
    readonly project_membership_generation: number;
    readonly legacy_project_membership_id?: never;
  }
);
interface AiSearchLocatorDecodeBounds {
  readonly expected_index_generation: string;
  /** Exact history read fence; flat keys are rejected without this explicit match. */
  readonly historical_generation?: string;
  readonly requested_lanes: readonly ("SEM" | "LEX" | "LITERAL")[];
  readonly max_results: number;
  readonly max_preview_bytes: number;
}
export type AiSearchLocatorDecodeOptions = AiSearchLocatorDecodeBounds & (
  | {
    readonly project_copy_layout: "PROJECT_COPY_V1" | "LEGACY_FLAT";
    readonly expected_generation_metadata_value?: string;
    readonly expected_project_copies?: readonly AiSearchExpectedProjectCopy[];
  }
  | {
    readonly project_copy_layout: "PROJECT_COPY_V2";
    readonly expected_generation_metadata_value: string;
    readonly expected_project_copies: readonly AiSearchExpectedProjectCopyV2[];
  }
);
export class AiSearchLocatorDecodeError extends Error { public constructor(message: string, cause?: unknown) { super(message, cause === undefined ? undefined : { cause }); this.name = "AiSearchLocatorDecodeError"; } }
interface Metadata { readonly canonical_section_id: string; readonly content_sha256: string; readonly instruction_taint: "CLEARED" | "DATA_ONLY" | "UNTRUSTED" | "COMMAND_LIKE"; readonly projection_generation: string; readonly source_revision_ref: string; }
interface Scoring { readonly fusion_method?: "rrf" | "max"; readonly keyword_rank?: number; readonly keyword_score?: number; readonly reranking_score?: number; readonly vector_rank?: number; readonly vector_score?: number; }
interface Chunk { readonly id: string; readonly item_key: string; readonly provider_item_key: string; readonly item_timestamp?: number; readonly project_copy?: AiSearchExpectedProjectCopy; readonly metadata: Metadata; readonly score: number; readonly scoring_details?: Scoring; readonly text: string; readonly type: "text"; }
export function projectionMetadata(item: ProjectionItem): Readonly<Record<string, string>> { return Object.freeze({ canonical_section_id: item.canonical_section_id, content_sha256: item.content_sha256, instruction_taint: item.instruction_taint, projection_generation: item.projection_generation, source_revision_ref: item.source_revision_ref }); }
export function decodeAiSearchSearchResult(request: RetrievalRequest, rawResult: unknown, options: AiSearchLocatorDecodeOptions): readonly UnresolvedLocatorCandidate[] {
  validateRequest(request); validateOptions(request, options); const result = exactObject(rawResult, RESULT_KEYS, "AI Search result"); if (Object.prototype.hasOwnProperty.call(result, "query_kind") && result.query_kind !== "text") fail("AI Search result.query_kind must be text"); if (!Array.isArray(result.chunks)) fail("AI Search result.chunks must be an array"); if (result.chunks.length > options.max_results) fail(`AI Search returned ${result.chunks.length} chunks; maximum is ${options.max_results}`); nonemptyString(result.search_query, "AI Search result.search_query", MAX_QUERY_CHARS);
  const seen = new Set<string>(); const candidates = result.chunks.map((raw, index) => { const candidate = mapAiSearchChunkToLocator(request, raw, { ...options, provider_rank: index + 1 }); if (seen.has(candidate.candidate_id)) fail(`AI Search returned duplicate chunk id ${candidate.candidate_id}`); seen.add(candidate.candidate_id); return candidate; }); return Object.freeze(candidates);
}
export function mapAiSearchChunkToLocator(request: RetrievalRequest, rawChunk: unknown, context: AiSearchLocatorDecodeOptions & { readonly provider_rank: number }): UnresolvedLocatorCandidate {
  validateRequest(request); validateOptions(request, context); const generation = nonemptyString(context.expected_index_generation, "expected_index_generation", 256); positiveInteger(context.provider_rank, "provider_rank"); const chunk = parseChunk(rawChunk, context);
  const expectedGenerationMetadata = context.project_copy_layout !== "LEGACY_FLAT"
    ? context.expected_generation_metadata_value
    : context.expected_index_generation;
  if (chunk.metadata.projection_generation !== expectedGenerationMetadata) fail("AI Search chunk projection_generation does not match the selected managed generation");
  if (!request.scope_snapshot.member_source_revision_refs.includes(chunk.metadata.source_revision_ref)) fail("AI Search chunk source_revision_ref is outside the frozen ScopeSnapshot");
  if (context.project_copy_layout !== "LEGACY_FLAT" &&
      (new TextEncoder().encode(chunk.metadata.source_revision_ref).byteLength > 64 ||
       new TextEncoder().encode(chunk.metadata.projection_generation).byteLength > 64)) {
    fail(`${context.project_copy_layout} metadata exceeds Cloudflare's 64-byte filterable string prefix`);
  }
  if (chunk.project_copy !== undefined && request.scope_snapshot.source_owner_generations[chunk.metadata.source_revision_ref] !== chunk.project_copy.source_owner_generation) fail("AI Search project copy source-owner generation differs from the frozen ScopeSnapshot");
  const row = { candidate_id: chunk.id, lane: selectLane(context.requested_lanes, chunk.scoring_details), source_revision_ref: chunk.metadata.source_revision_ref, canonical_section_id: chunk.metadata.canonical_section_id, preview: chunk.text, raw_score: chunk.score, rank: context.provider_rank, index_generation: generation, metadata: Object.freeze({ content_sha256: chunk.metadata.content_sha256, instruction_taint: chunk.metadata.instruction_taint, item_key: chunk.item_key, projection_generation: generation, provider: "cloudflare_ai_search", provider_chunk_type: chunk.type, provider_item_key: chunk.provider_item_key, ...(chunk.project_copy === undefined ? {} : { provider_project_folder: chunk.project_copy.folder_prefix, provider_project_id: chunk.project_copy.project_id, provider_project_membership_id: chunk.project_copy.project_membership_id }), ...(chunk.item_timestamp === undefined ? {} : { provider_item_timestamp: chunk.item_timestamp }), ...flattenScoring(chunk.scoring_details) }) };
  const first = decodeLocators([row], 1, context.max_preview_bytes)[0]; if (first === undefined) fail("AI Search locator validation produced no candidate"); return Object.freeze({ ...first, metadata: Object.freeze({ ...first.metadata }) });
}
function parseChunk(raw: unknown, context: AiSearchLocatorDecodeOptions): Chunk {
  const chunk = exactObject(raw, CHUNK_KEYS, "AI Search chunk"), id = nonemptyString(chunk.id, "AI Search chunk.id", MAX_CHUNK_ID_CHARS), type = nonemptyString(chunk.type, "AI Search chunk.type", 16); if (type !== "text") fail("AI Search chunk.type must be text"); const score = unitScore(chunk.score, "AI Search chunk.score"); if (typeof chunk.text !== "string") fail("AI Search chunk.text must be a string"); const item = exactObject(chunk.item, ITEM_KEYS, "AI Search chunk.item"), providerItemKey = nonemptyString(item.key, "AI Search chunk.item.key", MAX_KEY_CHARS); if (new TextEncoder().encode(providerItemKey).byteLength > MAX_KEY_CHARS) fail("AI Search chunk.item.key exceeds the 128-byte Items key limit"); const itemTimestamp = item.timestamp === undefined ? undefined : nonnegativeInteger(item.timestamp, "AI Search chunk.item.timestamp"), metadata = parseMetadata(item.metadata), decodedKey = projectionItemKeyFromProviderKey(providerItemKey, metadata.source_revision_ref, context); const scoring = chunk.scoring_details === undefined ? undefined : parseScoring(chunk.scoring_details);
  return { id, item_key: decodedKey.item_key, provider_item_key: providerItemKey, ...(decodedKey.project_copy === undefined ? {} : { project_copy: decodedKey.project_copy }), ...(itemTimestamp === undefined ? {} : { item_timestamp: itemTimestamp }), metadata, score, ...(scoring === undefined ? {} : { scoring_details: scoring }), text: chunk.text, type };
}
function projectionItemKeyFromProviderKey(value: string, sourceRevisionRef: string, options: AiSearchLocatorDecodeOptions): { readonly item_key: string; readonly project_copy?: AiSearchExpectedProjectCopy } {
  if (!value.endsWith(".md")) fail("AI Search chunk.item.key must use the canonical .md suffix");
  if (options.project_copy_layout === "LEGACY_FLAT") {
    if (options.historical_generation !== options.expected_index_generation || value.includes("/")) fail("flat AI Search keys are accepted only for the exact historical generation");
    const itemKey = value.slice(0, -3);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,124}$/u.test(itemKey)) fail("legacy AI Search item key is not canonical");
    return { item_key: itemKey };
  }
  const slash = value.lastIndexOf("/");
  if (slash < 0) fail(`${options.project_copy_layout} AI Search item key must contain its canonical project folder`);
  const folderPrefix = value.slice(0, slash + 1);
  const projectCopy = options.expected_project_copies?.find((copy) =>
    copy.source_revision_ref === sourceRevisionRef && copy.folder_prefix === folderPrefix);
  if (projectCopy === undefined) fail("AI Search provider folder is outside the frozen Core-authorized project membership scope");
  if (options.project_copy_layout === "PROJECT_COPY_V1" && projectCopy.project_membership_id !== `project:${projectCopy.project_id}:generation:${projectCopy.membership_generation}`) fail("AI Search provider folder mapping has an invalid Core membership identity");
  const itemKey = value.slice(slash + 1, -3);
  if (!/^projection-[a-f0-9]{48}$/u.test(itemKey)) fail(`${options.project_copy_layout} item key is not the retained canonical projection hash`);
  return { item_key: itemKey, project_copy: projectCopy };
}
function parseMetadata(raw: unknown): Metadata { const value = exactObject(raw, METADATA_KEYS, "AI Search chunk.item.metadata"), digest = nonemptyString(value.content_sha256, "AI Search metadata.content_sha256", 64), taint = nonemptyString(value.instruction_taint, "AI Search metadata.instruction_taint", 32); if (!/^[a-f0-9]{64}$/u.test(digest)) fail("AI Search metadata.content_sha256 must be 64 lowercase hexadecimal characters"); if (!isTaint(taint)) fail("AI Search metadata.instruction_taint is invalid"); return { canonical_section_id: nonemptyString(value.canonical_section_id, "AI Search metadata.canonical_section_id", 256), content_sha256: digest, instruction_taint: taint, projection_generation: nonemptyString(value.projection_generation, "AI Search metadata.projection_generation", 256), source_revision_ref: nonemptyString(value.source_revision_ref, "AI Search metadata.source_revision_ref", 256) }; }
function parseScoring(raw: unknown): Scoring { const value = exactObject(raw, SCORING_KEYS, "AI Search chunk.scoring_details"), out: { fusion_method?: "rrf" | "max"; keyword_rank?: number; keyword_score?: number; reranking_score?: number; vector_rank?: number; vector_score?: number } = {}; if (value.vector_score !== undefined) out.vector_score = unitScore(value.vector_score, "AI Search scoring_details.vector_score"); if (value.reranking_score !== undefined) out.reranking_score = unitScore(value.reranking_score, "AI Search scoring_details.reranking_score"); if (value.keyword_score !== undefined) out.keyword_score = nonnegativeNumber(value.keyword_score, "AI Search scoring_details.keyword_score"); if (value.keyword_rank !== undefined) out.keyword_rank = positiveInteger(value.keyword_rank, "AI Search scoring_details.keyword_rank"); if (value.vector_rank !== undefined) out.vector_rank = positiveInteger(value.vector_rank, "AI Search scoring_details.vector_rank"); if (value.fusion_method !== undefined) { const method = nonemptyString(value.fusion_method, "AI Search scoring_details.fusion_method", 16); if (method !== "rrf" && method !== "max") fail("AI Search scoring_details.fusion_method is invalid"); out.fusion_method = method; } return Object.freeze(out); }
function flattenScoring(value?: Scoring): Readonly<Record<string, string | number | boolean>> { return value === undefined ? {} : { ...(value.fusion_method === undefined ? {} : { provider_fusion_method: value.fusion_method }), ...(value.keyword_rank === undefined ? {} : { provider_keyword_rank: value.keyword_rank }), ...(value.keyword_score === undefined ? {} : { provider_keyword_score: value.keyword_score }), ...(value.reranking_score === undefined ? {} : { provider_reranking_score: value.reranking_score }), ...(value.vector_rank === undefined ? {} : { provider_vector_rank: value.vector_rank }), ...(value.vector_score === undefined ? {} : { provider_vector_score: value.vector_score }) }; }
function selectLane(lanes: readonly ("SEM" | "LEX" | "LITERAL")[], scoring?: Scoring): "SEM" | "LEX" { if (lanes.includes("SEM") && scoring?.vector_score !== undefined) return "SEM"; if (lanes.includes("LEX") && scoring?.keyword_score !== undefined) return "LEX"; if (lanes.includes("SEM")) return "SEM"; if (lanes.includes("LEX")) return "LEX"; fail("AI Search results require a requested SEM or LEX retrieval lane"); }
function validateRequest(request: RetrievalRequest): void { if (typeof request !== "object" || request === null) fail("retrieval request must be an object"); if (!Number.isInteger(request.requested_limit) || request.requested_limit < 1) fail("retrieval request.requested_limit must be a positive integer"); if (typeof request.scope_snapshot !== "object" || request.scope_snapshot === null || !Array.isArray(request.scope_snapshot.member_source_revision_refs)) fail("retrieval request must contain a frozen ScopeSnapshot"); }
function validateOptions(request: RetrievalRequest, options: AiSearchLocatorDecodeOptions): void {
  nonemptyString(options.expected_index_generation, "expected_index_generation", 256);
  if (options.project_copy_layout !== "PROJECT_COPY_V1" && options.project_copy_layout !== "PROJECT_COPY_V2" && options.project_copy_layout !== "LEGACY_FLAT") {
    fail("AI Search project_copy_layout is unsupported");
  }
  if (options.project_copy_layout === "PROJECT_COPY_V1") {
    if (typeof options.expected_generation_metadata_value !== "string" ||
        !/^[a-f0-9]{64}$/u.test(options.expected_generation_metadata_value) ||
        !Array.isArray(options.expected_project_copies)) {
      fail("PROJECT_COPY_V1 requires a generation digest and Core-authorized copy map");
    }
    const revisions = new Set<string>();
    for (const copy of options.expected_project_copies) {
      if (!request.scope_snapshot.member_source_revision_refs.includes(copy.source_revision_ref) ||
          revisions.has(copy.source_revision_ref) ||
          !/^projection\/[A-Za-z0-9_-]{43}\/$/u.test(copy.folder_prefix) ||
          copy.source_owner_generation !== request.scope_snapshot.source_owner_generations[copy.source_revision_ref] ||
          !IDENTIFIER.test(copy.project_id) || !IDENTIFIER.test(copy.project_membership_id) ||
          !Number.isSafeInteger(copy.membership_generation) || copy.membership_generation < 1 ||
          copy.project_membership_id !== `project:${copy.project_id}:generation:${copy.membership_generation}`) {
        fail("PROJECT_COPY_V1 expected copy map is not bound to the frozen Core scope");
      }
      revisions.add(copy.source_revision_ref);
    }
    if (revisions.size !== request.scope_snapshot.member_source_revision_refs.length) {
      fail("PROJECT_COPY_V1 expected copy map omits a frozen source revision");
    }
  } else if (options.project_copy_layout === "PROJECT_COPY_V2") {
    validateProjectCopyV2Scope(request, options);
  } else if (options.historical_generation !== options.expected_index_generation) {
    fail("legacy flat keys require an exact historical generation");
  }
  validateLanes(options.requested_lanes);
  if (!Number.isInteger(options.max_results) || options.max_results < 1 || options.max_results > MAX_RESULTS) fail(`AI Search max_results must be an integer between 1 and ${MAX_RESULTS}`);
  if (options.max_results > request.requested_limit) fail("AI Search max_results exceeds the retrieval request limit");
  previewLimit(options.max_preview_bytes);
}
const COPY_COMMON_KEYS = ["source_revision_ref", "source_owner_generation", "project_id", "project_membership_id", "membership_generation", "folder_prefix", "membership_identity_version"];
const COPY_V2_LEGACY_KEYS = new Set([...COPY_COMMON_KEYS, "legacy_project_membership_id"]);
const COPY_V2_STABLE_KEYS = new Set([...COPY_COMMON_KEYS, "stable_project_membership_id", "membership_revision", "project_membership_generation"]);
const COPY_V2_KEYS = new Set([...COPY_V2_LEGACY_KEYS, ...COPY_V2_STABLE_KEYS]);
function validateProjectCopyV2Scope(request: RetrievalRequest, options: AiSearchLocatorDecodeOptions): void {
  if (typeof options.expected_generation_metadata_value !== "string" ||
      !/^[a-f0-9]{64}$/u.test(options.expected_generation_metadata_value) ||
      !Array.isArray(options.expected_project_copies)) {
    fail("PROJECT_COPY_V2 requires a generation digest and Core-authorized copy map");
  }
  const revisions = new Set<string>();
  const folders = new Set<string>();
  for (const raw of options.expected_project_copies) {
    const copy = exactObject(raw, COPY_V2_KEYS, "PROJECT_COPY_V2 expected copy");
    if (copy.membership_identity_version !== 1 && copy.membership_identity_version !== 2) {
      fail("PROJECT_COPY_V2 expected copy has an invalid membership identity version");
    }
    exactObject(copy, copy.membership_identity_version === 1 ? COPY_V2_LEGACY_KEYS : COPY_V2_STABLE_KEYS,
      "PROJECT_COPY_V2 versioned expected copy");
    const source = nonemptyString(copy.source_revision_ref, "PROJECT_COPY_V2 source_revision_ref", 64);
    const owner = nonemptyString(copy.source_owner_generation, "PROJECT_COPY_V2 source_owner_generation", 256);
    const project = nonemptyString(copy.project_id, "PROJECT_COPY_V2 project_id", 256);
    const membership = nonemptyString(copy.project_membership_id, "PROJECT_COPY_V2 project_membership_id", 256);
    const folder = nonemptyString(copy.folder_prefix, "PROJECT_COPY_V2 folder_prefix", 64);
    const generation = positiveInteger(copy.membership_generation, "PROJECT_COPY_V2 membership_generation");
    if (!request.scope_snapshot.member_source_revision_refs.includes(source) || revisions.has(source) ||
        folders.has(folder) || new TextEncoder().encode(source).byteLength > 64 ||
        owner !== request.scope_snapshot.source_owner_generations[source] ||
        !IDENTIFIER.test(project) || !IDENTIFIER.test(membership)) {
      fail("PROJECT_COPY_V2 expected copy map is not bound to the frozen Core scope");
    }
    if (copy.membership_identity_version === 1) {
      if (copy.legacy_project_membership_id !== membership ||
          membership !== `project:${project}:generation:${generation}` ||
          !/^projection\/[A-Za-z0-9_-]{43}\/$/u.test(folder)) {
        fail("PROJECT_COPY_V2 legacy row has an invalid Core membership identity or folder");
      }
    } else {
      positiveInteger(copy.membership_revision, "PROJECT_COPY_V2 membership_revision");
      const aggregateGeneration = positiveInteger(copy.project_membership_generation,
        "PROJECT_COPY_V2 project_membership_generation");
      if (copy.stable_project_membership_id !== membership ||
          !/^project-membership-[a-f0-9]{48}$/u.test(membership) ||
          !/^projection\/p-[a-f0-9]{48}\/$/u.test(folder) || generation > aggregateGeneration) {
        fail("PROJECT_COPY_V2 stable row has an invalid Core membership identity, folder or currentness fence");
      }
    }
    revisions.add(source);
    folders.add(folder);
  }
  if (revisions.size !== request.scope_snapshot.member_source_revision_refs.length) {
    fail("PROJECT_COPY_V2 expected copy map omits a frozen source revision");
  }
}
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
