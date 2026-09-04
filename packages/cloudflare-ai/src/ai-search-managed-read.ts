import { decodeAiSearchSearchResult, type AiSearchAdapter, type AiSearchInstanceLike, type AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";
import { decodeAiSearchGenerationRegistrySnapshot } from "./ai-search-generation-registry-codec.js";
import type { AiSearchGenerationRegistryService } from "./ai-search-generation-registry-contract.js";
import { createD1AiSearchGenerationRegistryStore } from "./ai-search-generation-registry-d1.js";
import { createAiSearchGenerationRegistryService } from "./ai-search-generation-registry.js";

type ManagedRequest = Parameters<AiSearchAdapter["search"]>[0];
type ManagedLanes = Parameters<AiSearchAdapter["search"]>[1];
type ManagedExpansion = Parameters<AiSearchAdapter["search"]>[2];
type IndexMethod = Readonly<{ vector: boolean; keyword: boolean }>;
export const AI_SEARCH_MANAGED_QUERY_MAX_BYTES = 64 * 1024;
export const AI_SEARCH_MANAGED_SCOPE_MAX_MEMBERS = 10_000;
export type AiSearchManagedReadErrorCode =
  | "AI_SEARCH_MANAGED_INPUT_INVALID" | "AI_SEARCH_MANAGED_NOT_PROMOTED"
  | "AI_SEARCH_MANAGED_REGISTRY_READ_FAILED" | "AI_SEARCH_MANAGED_REGISTRY_INVALID"
  | "AI_SEARCH_MANAGED_REGISTRY_CHANGED" | "AI_SEARCH_MANAGED_PROVIDER_CALL_FAILED"
  | "AI_SEARCH_MANAGED_PROVIDER_RESPONSE_INVALID";

export class AiSearchManagedReadError extends Error {
  public readonly ambiguous_effect = "NONE" as const;
  public constructor(public readonly code: AiSearchManagedReadErrorCode, message: string, public readonly retryable = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause }); this.name = "AiSearchManagedReadError";
  }
}
export interface AiSearchManagedSearchAuthority {
  readonly namespace: string; readonly instance_id: string; readonly index_generation: string;
  readonly registry_revision: number; readonly registry_artifact_sha256: string; readonly active: boolean;
  readonly index_method: IndexMethod; readonly max_results: number; readonly max_preview_bytes: number;
  readonly match_threshold: number; readonly fusion_method?: "rrf" | "max"; readonly keyword_match_mode?: "and" | "or";
}
export interface AiSearchManagedSearchPolicy { readonly expected_namespace: string; readonly max_preview_bytes: number; readonly match_threshold: number }
export interface AiSearchManagedSearchRequest {
  readonly query: string; readonly ai_search_options: Readonly<{ retrieval: Readonly<{
    retrieval_type: "vector" | "keyword" | "hybrid"; match_threshold: number; max_num_results: number;
    context_expansion: 0 | 1 | 2 | 3; fusion_method?: "rrf" | "max"; keyword_match_mode?: "and" | "or";
    boost_by: readonly never[]; metadata_only: false;
  }> }>;
}
export interface AiSearchManagedSearchPort { readonly search: AiSearchAdapter["search"] }

const MAX_RESULTS = 50, MAX_PREVIEW_BYTES = 64 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u, INSTANCE_ID = /^[a-z0-9_]+(?:-[a-z0-9_]+)*$/u, SHA256 = /^[a-f0-9]{64}$/u;
const AUTHORITY_KEYS = new Set(["active", "fusion_method", "index_generation", "index_method", "instance_id", "keyword_match_mode", "match_threshold", "max_preview_bytes", "max_results", "namespace", "registry_artifact_sha256", "registry_revision"]);
const POLICY_KEYS = new Set(["expected_namespace", "match_threshold", "max_preview_bytes"]), INDEX_KEYS = new Set(["keyword", "vector"]);

function failure(code: AiSearchManagedReadErrorCode, message: string, retryable = false, cause?: unknown): never {
  throw new AiSearchManagedReadError(code, message, retryable, cause);
}
function object(value: unknown, label: string, keys?: ReadonlySet<string>): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) failure("AI_SEARCH_MANAGED_INPUT_INVALID", `${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) failure("AI_SEARCH_MANAGED_INPUT_INVALID", `${label} must be a plain object`);
  const record = value as Record<string, unknown>;
  if (keys !== undefined) for (const key of Object.keys(record)) if (!keys.has(key)) failure("AI_SEARCH_MANAGED_INPUT_INVALID", `${label} contains unsupported field ${key}`);
  return record;
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) failure("AI_SEARCH_MANAGED_INPUT_INVALID", `${label} is not a bounded identifier`);
  return value;
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) failure("AI_SEARCH_MANAGED_INPUT_INVALID", `${label} must be an integer in [${min}, ${max}]`);
  return value;
}
function policy(input: AiSearchManagedSearchPolicy): AiSearchManagedSearchPolicy {
  const value = object(input, "AI Search managed policy", POLICY_KEYS), expected = identifier(value.expected_namespace, "policy.expected_namespace");
  const preview = integer(value.max_preview_bytes, "policy.max_preview_bytes", 0, MAX_PREVIEW_BYTES);
  if (typeof value.match_threshold !== "number" || !Number.isFinite(value.match_threshold) || value.match_threshold < 0 || value.match_threshold > 1) failure("AI_SEARCH_MANAGED_INPUT_INVALID", "policy.match_threshold must be in [0, 1]");
  return Object.freeze({ expected_namespace: expected, max_preview_bytes: preview, match_threshold: value.match_threshold });
}
function authority(input: AiSearchManagedSearchAuthority): AiSearchManagedSearchAuthority {
  const value = object(input, "AI Search managed authority", AUTHORITY_KEYS), namespace = identifier(value.namespace, "authority.namespace");
  if (typeof value.instance_id !== "string" || value.instance_id.length > 64 || !INSTANCE_ID.test(value.instance_id)) failure("AI_SEARCH_MANAGED_INPUT_INVALID", "authority.instance_id is not canonical");
  const generation = identifier(value.index_generation, "authority.index_generation");
  const revision = integer(value.registry_revision, "authority.registry_revision", 1, Number.MAX_SAFE_INTEGER);
  if (typeof value.registry_artifact_sha256 !== "string" || !SHA256.test(value.registry_artifact_sha256)) failure("AI_SEARCH_MANAGED_INPUT_INVALID", "authority.registry_artifact_sha256 must be lowercase SHA-256");
  if (typeof value.active !== "boolean") failure("AI_SEARCH_MANAGED_INPUT_INVALID", "authority.active must be boolean");
  const method = object(value.index_method, "authority.index_method", INDEX_KEYS);
  if (typeof method.vector !== "boolean" || typeof method.keyword !== "boolean" || (!method.vector && !method.keyword)) failure("AI_SEARCH_MANAGED_INPUT_INVALID", "authority.index_method is invalid");
  const maxResults = integer(value.max_results, "authority.max_results", 1, MAX_RESULTS), maxPreview = integer(value.max_preview_bytes, "authority.max_preview_bytes", 0, MAX_PREVIEW_BYTES);
  if (typeof value.match_threshold !== "number" || !Number.isFinite(value.match_threshold) || value.match_threshold < 0 || value.match_threshold > 1) failure("AI_SEARCH_MANAGED_INPUT_INVALID", "authority.match_threshold must be in [0, 1]");
  if (value.fusion_method !== undefined && value.fusion_method !== "rrf" && value.fusion_method !== "max") failure("AI_SEARCH_MANAGED_INPUT_INVALID", "authority.fusion_method is unsupported");
  if (value.keyword_match_mode !== undefined && value.keyword_match_mode !== "and" && value.keyword_match_mode !== "or") failure("AI_SEARCH_MANAGED_INPUT_INVALID", "authority.keyword_match_mode is unsupported");
  return Object.freeze({
    namespace, instance_id: value.instance_id, index_generation: generation, registry_revision: revision,
    registry_artifact_sha256: value.registry_artifact_sha256, active: value.active,
    index_method: Object.freeze({ vector: method.vector, keyword: method.keyword }), max_results: maxResults,
    max_preview_bytes: maxPreview, match_threshold: value.match_threshold,
    ...(value.fusion_method === undefined ? {} : { fusion_method: value.fusion_method }),
    ...(value.keyword_match_mode === undefined ? {} : { keyword_match_mode: value.keyword_match_mode }),
  });
}
function requestQuery(request: ManagedRequest): string {
  if (typeof request !== "object" || request === null) failure("AI_SEARCH_MANAGED_INPUT_INVALID", "retrieval request must be an object");
  if (typeof request.raw_query !== "string" || request.raw_query.trim().length === 0) failure("AI_SEARCH_MANAGED_INPUT_INVALID", "retrieval request.raw_query must be non-empty");
  if (new TextEncoder().encode(request.raw_query).byteLength > AI_SEARCH_MANAGED_QUERY_MAX_BYTES) failure("AI_SEARCH_MANAGED_INPUT_INVALID", "retrieval query exceeds the UTF-8 byte limit");
  integer(request.requested_limit, "retrieval request.requested_limit", 1, Number.MAX_SAFE_INTEGER);
  integer(request.deadline_ms, "retrieval request.deadline_ms", 1, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(request.literals)) failure("AI_SEARCH_MANAGED_INPUT_INVALID", "retrieval request.literals must be an array");
  const members = request.scope_snapshot?.member_source_revision_refs;
  if (!Array.isArray(members) || members.length > AI_SEARCH_MANAGED_SCOPE_MAX_MEMBERS) failure("AI_SEARCH_MANAGED_INPUT_INVALID", "ScopeSnapshot members are invalid or unbounded");
  const seen = new Set<string>();
  members.forEach((member, index) => {
    const bounded = identifier(member, `scope_snapshot.member_source_revision_refs[${index}]`);
    if (seen.has(bounded)) failure("AI_SEARCH_MANAGED_INPUT_INVALID", `ScopeSnapshot contains duplicate ${bounded}`);
    seen.add(bounded);
  });
  return request.raw_query;
}
function retrievalType(lanes: ManagedLanes, method: IndexMethod): "vector" | "keyword" | "hybrid" {
  if (!Array.isArray(lanes) || lanes.length < 1 || lanes.length > 2) failure("AI_SEARCH_MANAGED_INPUT_INVALID", "managed search requires one or two lanes");
  const seen = new Set<string>();
  for (const lane of lanes) {
    if (lane !== "SEM" && lane !== "LEX") failure("AI_SEARCH_MANAGED_INPUT_INVALID", "managed search admits only SEM and LEX");
    if (seen.has(lane)) failure("AI_SEARCH_MANAGED_INPUT_INVALID", `managed search contains duplicate lane ${lane}`);
    if ((lane === "SEM" && !method.vector) || (lane === "LEX" && !method.keyword)) failure("AI_SEARCH_MANAGED_INPUT_INVALID", `active profile does not support lane ${lane}`);
    seen.add(lane);
  }
  return seen.size === 2 ? "hybrid" : seen.has("SEM") ? "vector" : "keyword";
}
function expansion(value: ManagedExpansion): 0 | 1 | 2 | 3 {
  if (!Number.isInteger(value) || value < 0 || value > 3) failure("AI_SEARCH_MANAGED_INPUT_INVALID", "context expansion must be in [0, 3]");
  return value;
}
function routingFingerprint(value: AiSearchManagedSearchAuthority): string {
  return JSON.stringify([value.namespace, value.instance_id, value.index_generation, value.index_method, value.max_results, value.max_preview_bytes, value.match_threshold, value.fusion_method ?? null, value.keyword_match_mode ?? null]);
}
function namespaceBinding(namespace: AiSearchNamespaceLike): void {
  if (typeof namespace !== "object" || namespace === null || typeof namespace.get !== "function") failure("AI_SEARCH_MANAGED_INPUT_INVALID", "AI Search namespace binding is invalid");
}

export async function resolveAiSearchManagedSearchAuthority(rawSnapshot: unknown, inputPolicy: AiSearchManagedSearchPolicy): Promise<AiSearchManagedSearchAuthority> {
  const rules = policy(inputPolicy); let snapshot: Awaited<ReturnType<typeof decodeAiSearchGenerationRegistrySnapshot>>;
  try { snapshot = await decodeAiSearchGenerationRegistrySnapshot(rawSnapshot, rules.expected_namespace); }
  catch (cause) { failure("AI_SEARCH_MANAGED_REGISTRY_INVALID", "AI Search registry snapshot is invalid", false, cause); }
  const generation = snapshot.artifact.registry.active_head_generation;
  if (generation === null) failure("AI_SEARCH_MANAGED_NOT_PROMOTED", "AI Search registry has no promoted generation");
  const record = snapshot.artifact.registry.generations.find((candidate) => candidate.generation === generation);
  if (record === undefined || record.state !== "ACTIVE") failure("AI_SEARCH_MANAGED_REGISTRY_INVALID", "AI Search active head does not resolve to an ACTIVE record");
  return authority({
    namespace: snapshot.artifact.namespace, instance_id: record.profile.id, index_generation: record.generation,
    registry_revision: snapshot.artifact.revision, registry_artifact_sha256: snapshot.artifact_sha256, active: true,
    index_method: record.profile.index_method, max_results: record.profile.max_num_results,
    max_preview_bytes: rules.max_preview_bytes, match_threshold: rules.match_threshold,
    ...(record.profile.fusion_method === undefined ? {} : { fusion_method: record.profile.fusion_method }),
    ...(record.profile.keyword_match_mode === undefined ? {} : { keyword_match_mode: record.profile.keyword_match_mode }),
  });
}
export function compileAiSearchManagedSearchRequest(request: ManagedRequest, lanes: ManagedLanes, contextExpansion: ManagedExpansion, inputAuthority: AiSearchManagedSearchAuthority): AiSearchManagedSearchRequest {
  const active = authority(inputAuthority);
  if (!active.active) failure("AI_SEARCH_MANAGED_NOT_PROMOTED", "managed generation is not promoted");
  const type = retrievalType(lanes, active.index_method), query = requestQuery(request);
  if (type === "hybrid" && active.fusion_method === undefined) failure("AI_SEARCH_MANAGED_INPUT_INVALID", "hybrid active profile omits fusion_method");
  if (type !== "vector" && active.keyword_match_mode === undefined) failure("AI_SEARCH_MANAGED_INPUT_INVALID", "keyword active profile omits keyword_match_mode");
  const retrieval = Object.freeze({
    retrieval_type: type, match_threshold: active.match_threshold,
    max_num_results: Math.min(request.requested_limit, active.max_results), context_expansion: expansion(contextExpansion),
    ...(type === "hybrid" ? { fusion_method: active.fusion_method } : {}),
    ...(type === "vector" ? {} : { keyword_match_mode: active.keyword_match_mode }),
    boost_by: Object.freeze([]) as readonly never[], metadata_only: false as const,
  });
  return Object.freeze({ query, ai_search_options: Object.freeze({ retrieval }) });
}
export function createAiSearchManagedSearchPort(namespace: AiSearchNamespaceLike, inputAuthority: AiSearchManagedSearchAuthority): AiSearchManagedSearchPort {
  namespaceBinding(namespace); const active = authority(inputAuthority);
  return Object.freeze({ async search(request: ManagedRequest, lanes: ManagedLanes, contextExpansion: ManagedExpansion) {
    const compiled = compileAiSearchManagedSearchRequest(request, lanes, contextExpansion, active);
    if (request.scope_snapshot.member_source_revision_refs.length === 0) return Object.freeze([]);
    let instance: AiSearchInstanceLike;
    try {
      instance = namespace.get(active.instance_id);
      if (typeof instance !== "object" || instance === null || typeof instance.search !== "function") throw new Error("search capability is missing");
    } catch (cause) { failure("AI_SEARCH_MANAGED_PROVIDER_CALL_FAILED", "promoted instance could not be resolved", true, cause); }
    let raw: unknown;
    try { raw = await instance.search(compiled); }
    catch (cause) { failure("AI_SEARCH_MANAGED_PROVIDER_CALL_FAILED", "promoted instance search failed", true, cause); }
    try {
      const candidates = decodeAiSearchSearchResult(request, raw, {
        expected_index_generation: active.index_generation, requested_lanes: lanes,
        max_results: Math.min(request.requested_limit, active.max_results), max_preview_bytes: active.max_preview_bytes,
      });
      return Object.freeze(candidates.map((candidate) => Object.freeze({
        ...candidate, metadata: Object.freeze({
          ...candidate.metadata, provider_namespace: active.namespace, active_registry_revision: active.registry_revision,
          active_registry_artifact_sha256: active.registry_artifact_sha256,
        }),
      })));
    } catch (cause) {
      if (cause instanceof AiSearchManagedReadError) throw cause;
      failure("AI_SEARCH_MANAGED_PROVIDER_RESPONSE_INVALID", "result failed the managed locator boundary", false, cause);
    }
  } });
}
async function readAuthority(registry: Pick<AiSearchGenerationRegistryService, "read">, rules: AiSearchManagedSearchPolicy): Promise<AiSearchManagedSearchAuthority> {
  let snapshot: Awaited<ReturnType<AiSearchGenerationRegistryService["read"]>>;
  try { snapshot = await registry.read(rules.expected_namespace); }
  catch (cause) { failure("AI_SEARCH_MANAGED_REGISTRY_READ_FAILED", "AI Search registry read failed", true, cause); }
  if (snapshot === null) failure("AI_SEARCH_MANAGED_NOT_PROMOTED", "AI Search registry does not exist");
  return resolveAiSearchManagedSearchAuthority(snapshot, rules);
}
export function createRegistryBackedAiSearchManagedSearchPort(registry: Pick<AiSearchGenerationRegistryService, "read">, namespace: AiSearchNamespaceLike, inputPolicy: AiSearchManagedSearchPolicy): AiSearchManagedSearchPort {
  if (typeof registry !== "object" || registry === null || typeof registry.read !== "function") failure("AI_SEARCH_MANAGED_INPUT_INVALID", "AI Search registry service is invalid");
  namespaceBinding(namespace); const rules = policy(inputPolicy);
  return Object.freeze({ async search(request: ManagedRequest, lanes: ManagedLanes, contextExpansion: ManagedExpansion) {
    const before = await readAuthority(registry, rules);
    const candidates = await createAiSearchManagedSearchPort(namespace, before).search(request, lanes, contextExpansion);
    const after = await readAuthority(registry, rules);
    if (routingFingerprint(before) !== routingFingerprint(after)) failure("AI_SEARCH_MANAGED_REGISTRY_CHANGED", "AI Search active generation changed during retrieval", true);
    return candidates;
  } });
}
export function createD1BackedAiSearchManagedSearchPort(database: D1Database, namespace: AiSearchNamespaceLike, rules: AiSearchManagedSearchPolicy): AiSearchManagedSearchPort {
  return createRegistryBackedAiSearchManagedSearchPort(createAiSearchGenerationRegistryService(createD1AiSearchGenerationRegistryStore(database)), namespace, rules);
}
