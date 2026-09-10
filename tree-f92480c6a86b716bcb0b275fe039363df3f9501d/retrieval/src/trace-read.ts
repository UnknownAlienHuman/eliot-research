// IMPLEMENTED_NOT_LIVE: ER-24 research.trace serves persisted retrieval query-* traces over D1 with owner-bound readback; RETRIEVAL slice enablement remains separate.
import { RetrievalTraceSchema, type RetrievalTrace, type VersionedRef } from "@eliotr/contracts";
import { canonicalRetrievalJson, createD1ScopePorts, type RetrievalQueryD1 } from "./query-persistence.js";
import { RetrievalQueryError } from "./service.js";

export interface RetrievalTraceReadAccess {
  readonly principal_ref: string;
  readonly client_class: string;
  readonly credential_generation: string;
}

export type RetrievalTraceReadResult =
  | { readonly status: "ok"; readonly trace: RetrievalTrace & { readonly coverage_claim: "NONE" | "SAMPLED" } }
  | { readonly status: "invalid" }
  | { readonly status: "missing" }
  | { readonly status: "stale" }
  | { readonly status: "uncertain" };

const QUERY_TRACE_ID_RE = /^query-[0-9a-f]{48}$/u;

/**
 * Read-only retrieval trace reader over migration 0021 tables.
 * SELECTs only: no grants, writes, or trace-of-trace. Missing and
 * foreign-owned traces both report missing so existence never leaks.
 * Response projects the persisted trace (lanes, skips, scope) plus the
 * owned result row coverage claim; every byte comes from those rows.
 */
export async function readRetrievalTrace(
  database: RetrievalQueryD1,
  access: RetrievalTraceReadAccess,
  ref: VersionedRef,
): Promise<RetrievalTraceReadResult> {
  if (access.client_class !== "owner_pwa") return { status: "missing" };
  if (ref.revision !== 1 || typeof ref.id !== "string" || !QUERY_TRACE_ID_RE.test(ref.id)) return { status: "invalid" };
  let traceRow: { readonly trace_json: unknown; readonly scope_snapshot_id: unknown; readonly scope_snapshot_revision: unknown } | null;
  try {
    traceRow = await database.prepare(
      "SELECT trace_json, scope_snapshot_id, scope_snapshot_revision FROM retrieval_query_trace WHERE trace_id = ?1 AND revision = ?2 LIMIT 1",
    ).bind(ref.id, ref.revision).first<{ readonly trace_json: unknown; readonly scope_snapshot_id: unknown; readonly scope_snapshot_revision: unknown }>();
  } catch {
    return { status: "uncertain" };
  }
  if (traceRow === null) return { status: "missing" };
  let owned: { readonly coverage_claim: unknown; readonly state: unknown } | null;
  try {
    owned = await database.prepare(
      "SELECT coverage_claim, state FROM retrieval_query_result WHERE trace_id = ?1 AND trace_revision = ?2 AND principal_ref = ?3 AND client_class = ?4 AND credential_generation = ?5 LIMIT 1",
    ).bind(ref.id, ref.revision, access.principal_ref, access.client_class, access.credential_generation)
      .first<{ readonly coverage_claim: unknown; readonly state: unknown }>();
  } catch {
    return { status: "uncertain" };
  }
  if (owned === null) return { status: "missing" };
  if (owned.state !== "COMPLETE") return { status: "stale" };
  if (owned.coverage_claim !== "NONE" && owned.coverage_claim !== "SAMPLED") return { status: "stale" };
  if (typeof traceRow.trace_json !== "string") return { status: "stale" };
  let parsed: RetrievalTrace;
  try {
    parsed = RetrievalTraceSchema.parse(JSON.parse(traceRow.trace_json));
  } catch {
    return { status: "stale" };
  }
  if (
    parsed.trace_ref.id !== ref.id || parsed.trace_ref.revision !== ref.revision ||
    parsed.scope_snapshot.snapshot_id !== traceRow.scope_snapshot_id ||
    parsed.scope_snapshot.revision !== traceRow.scope_snapshot_revision ||
    canonicalRetrievalJson(parsed) !== traceRow.trace_json
  ) {
    return { status: "stale" };
  }
  try {
    await createD1ScopePorts(database, {
      principal_ref: access.principal_ref,
      client_class: access.client_class as "owner_pwa",
      credential_generation: access.credential_generation,
    }).requireCurrentScope(parsed.scope_snapshot);
  } catch (error) {
    if (error instanceof RetrievalQueryError) return { status: "stale" };
    return { status: "uncertain" };
  }
  return { status: "ok", trace: { ...parsed, coverage_claim: owned.coverage_claim } };
}
