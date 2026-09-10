import {
  DocumentMapRevisionSchema, IdentifierSchema, RetrievalTraceSchema, SourceCardSchema, VersionedRefSchema,
  type DocumentMapRevision, type RetrievalTrace, type SourceCard, type VersionedRef,
} from "@eliotr/contracts";
import { ApiRequestError, requestApi } from "./api.js";

export interface OrientationView {
  readonly cards: readonly SourceCard[];
  readonly maps: readonly DocumentMapRevision[];
  readonly scope: VersionedRef;
  readonly trace: VersionedRef;
  readonly omitted: number;
  readonly generation: string;
  readonly requestTrace: string;
}
function mismatch(): never {
  throw new ApiRequestError({ status: 502, code: "API_RESPONSE_SCHEMA_MISMATCH", message: "Invalid Corpus Lens response" });
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(value, key))) mismatch();
  return value as Record<string, unknown>;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) mismatch(); return value;
}
function ids(value: unknown, maximum = 64): string[] {
  const result = array(value, maximum).map((item) => IdentifierSchema.parse(item));
  if (new Set(result).size !== result.length) mismatch(); return result;
}
export function decodeOrientation(value: unknown): OrientationView {
  try {
    const envelope = record(value, ["data", "trace_id", "deployment_generation"]);
    const data = record(envelope.data, ["evidence_pack", "trace_ref", "navigation"]);
    const pack = record(data.evidence_pack, ["pack_ref", "scope_snapshot_ref", "resolved_evidence", "omitted_candidates", "trace_ref", "total_utf8_bytes"]);
    if (array(pack.resolved_evidence, 0).length || array(pack.omitted_candidates, 0).length || pack.total_utf8_bytes !== 0) mismatch();
    const trace = VersionedRefSchema.parse(data.trace_ref); const packTrace = VersionedRefSchema.parse(pack.trace_ref);
    if (trace.id !== packTrace.id || trace.revision !== packTrace.revision || !/^orient-[0-9a-f]{64}$/u.test(trace.id)) mismatch();
    VersionedRefSchema.parse(pack.pack_ref);
    const nav = record(data.navigation, ["source_cards", "document_maps", "represented_source_revision_refs", "omitted_source_revision_refs",
      "omitted_source_revision_count", "omissions_truncated", "omissions", "coverage_kind", "coverage_method", "degraded_source_revision_refs",
      "missing_source_classes", "contradiction_refs", "centrality", "recommended_reading_routes", "navigation_authority"]);
    if (nav.navigation_authority !== "NAVIGATION_ONLY" || nav.coverage_method !== "frozen_scope_order" ||
        !["unknown", "sampled_with_method"].includes(String(nav.coverage_kind)) || nav.omissions_truncated !== false ||
        !Number.isSafeInteger(nav.omitted_source_revision_count) || Number(nav.omitted_source_revision_count) < 0 ||
        Number(nav.omitted_source_revision_count) > 64) mismatch();
    const represented = ids(nav.represented_source_revision_refs, 16); const omitted = ids(nav.omitted_source_revision_refs);
    if (represented.some((id) => omitted.includes(id)) || omitted.length !== nav.omitted_source_revision_count) mismatch();
    const cards = array(nav.source_cards, 16).map((item) => SourceCardSchema.parse(item));
    const maps = array(nav.document_maps, 16).map((item) => DocumentMapRevisionSchema.parse(item));
    if (cards.length !== represented.length || new Set(cards.map((card) => card.source_revision_ref)).size !== cards.length ||
        cards.some((card) => !represented.includes(card.source_revision_ref)) ||
        new Set(maps.map((map) => map.source_revision_ref)).size !== maps.length ||
        maps.some((map) => !represented.includes(map.source_revision_ref))) mismatch();
    ids(nav.degraded_source_revision_refs); ids(nav.missing_source_classes); ids(nav.contradiction_refs);
    for (const value of array(nav.recommended_reading_routes, 1)) {
      const route = record(value, ["label", "navigation_authority", "source_revision_refs"]);
      if (route.navigation_authority !== "NAVIGATION_ONLY" || typeof route.label !== "string" || route.label.length > 256 ||
          ids(route.source_revision_refs, 16).some((ref) => !represented.includes(ref))) mismatch();
    }
    for (const entry of array(nav.omissions, 128)) {
      const item = record(entry, ["source_revision_ref", "reason"]);
      IdentifierSchema.parse(item.source_revision_ref); IdentifierSchema.parse(item.reason);
    }
    for (const entry of array(nav.centrality, 64)) {
      const item = record(entry, ["source_revision_ref", "score"]);
      IdentifierSchema.parse(item.source_revision_ref);
      if (typeof item.score !== "number" || !Number.isFinite(item.score)) mismatch();
    }
    return { cards, maps, scope: VersionedRefSchema.parse(pack.scope_snapshot_ref), trace,
      omitted: Number(nav.omitted_source_revision_count), generation: IdentifierSchema.parse(envelope.deployment_generation),
      requestTrace: IdentifierSchema.parse(envelope.trace_id) };
  } catch { return mismatch(); }
}

export function orientationBody(sourceIds: readonly string[], query: string): string {
  if (sourceIds.length > 64 || new Set(sourceIds).size !== sourceIds.length || new TextEncoder().encode(query).byteLength > 1024) {
    throw new ApiRequestError({ status: 400, code: "ORIENTATION_INPUT_LIMIT", message: "Use at most 64 unique source IDs and a short focus" });
  }
  sourceIds.forEach((id) => IdentifierSchema.parse(id));
  return JSON.stringify({ query, product: "ORIENT", scope_expression: sourceIds.length
    ? { kind: "SELECTED_SOURCES", source_ids: sourceIds } : { kind: "GLOBAL_LIBRARY" },
  literals: [], evidence_grade: "E0", budget_ref: "orientation-metadata-v1", max_results: 16 });
}
export async function orientSources(body: string, key: string, signal?: AbortSignal): Promise<OrientationView> {
  const value = await requestApi("/api/v1/research/orient", { method: "POST", body,
    headers: { "content-type": "application/json", "idempotency-key": key }, ...(signal ? { signal } : {}) });
  return decodeOrientation(value);
}
export async function readOrientationTrace(ref: VersionedRef, signal?: AbortSignal): Promise<RetrievalTrace> {
  if (ref.revision !== 1 || !/^orient-[0-9a-f]{64}$/u.test(ref.id)) mismatch();
  const value = record(await requestApi(`/api/v1/research/trace/${encodeURIComponent(ref.id)}`, signal ? { signal } : {}),
    ["data", "trace_id", "deployment_generation"]);
  const trace = RetrievalTraceSchema.parse(value.data);
  if (trace.trace_ref.id !== ref.id || trace.trace_ref.revision !== ref.revision) mismatch();
  return trace;
}
