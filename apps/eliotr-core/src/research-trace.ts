// IMPLEMENTED_NOT_LIVE: ER-24 research.trace serves persisted retrieval query-* traces over D1 with owner-bound readback; RETRIEVAL slice enablement remains separate.
import { RetrievalTraceSchema, type RetrievalTrace, type VersionedRef } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { canonicalRetrievalJson, createD1ScopePorts } from "@eliotr/retrieval";
import { RetrievalQueryError } from "@eliotr/retrieval";
import { CatalogInputError } from "./catalog-service.js";
import type { Env } from "./env.js";

export class ResearchTraceError extends CatalogInputError {}

function fail(code: string, message: string, status = 400, retryable = false): never {
  throw new ResearchTraceError(code, message, status, retryable);
}

const QUERY_TRACE_ID_RE = /^query-[0-9a-f]{48}$/u;

interface TraceRow {
  readonly trace_json: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
}

interface OwnedResultRow {
  readonly coverage_claim: unknown;
  readonly state: unknown;
}

/**
 * Read-only retrieval trace port over migration 0021 tables.
 *
 * Intent -> Attempt -> Receipt -> Readback -> Reconciliation does not apply:
 * a read mints nothing. This reader issues SELECTs only: no grants, no
 * result/trace/profile writes, no trace of the trace. Callers assert
 * table-count stability around reads.
 *
 * Principal boundary mirrors the query that wrote the trace: the caller must
 * own a retrieval_query_result row carrying this trace id under the same
 * principal/client/credential. A missing trace and a foreign-owned trace both
 * fail with RESEARCH_TRACE_NOT_FOUND (404) so existence never leaks.
 * An owned trace whose scope/grant is stale fails with RESEARCH_TRACE_STALE
 * (409), mirroring the orientation trace 409 after policy withdrawal.
 *
 * Response shape is the persisted RetrievalTrace (lanes_used, lanes_skipped
 * with reasons, scope_snapshot) plus coverage_claim projected directly from
 * the owned retrieval_query_result row (NONE/SAMPLED). No field is invented:
 * every returned byte comes from one of those two rows.
 */
export function createRetrievalTraceReader(env: Pick<Env, "CORE_DB">): {
  readTrace(
    context: AuthenticatedRequestContext,
    ref: VersionedRef,
  ): Promise<RetrievalTrace & { readonly coverage_claim: "NONE" | "SAMPLED" }>;
} {
  return {
    async readTrace(context, ref) {
      if (context.client_class !== "owner_pwa") {
        fail("RESEARCH_OWNER_REQUIRED", "research trace requires the owner profile", 403);
      }
      if (ref.revision !== 1 || typeof ref.id !== "string" || !QUERY_TRACE_ID_RE.test(ref.id)) {
        fail("RESEARCH_TRACE_INVALID", "research trace ref is invalid", 400);
      }
      const db = env.CORE_DB;
      let traceRow: TraceRow | null;
      try {
        traceRow = await db
          .prepare(
            "SELECT trace_json, scope_snapshot_id, scope_snapshot_revision FROM retrieval_query_trace " +
              "WHERE trace_id = ?1 AND revision = ?2 LIMIT 1",
          )
          .bind(ref.id, ref.revision)
          .first<TraceRow>();
      } catch {
        fail("RESEARCH_TRACE_NOT_FOUND", "research trace does not exist", 404);
      }
      if (traceRow === null) {
        fail("RESEARCH_TRACE_NOT_FOUND", "research trace does not exist", 404);
      }
      let owned: OwnedResultRow | null;
      try {
        owned = await db
          .prepare(
            "SELECT coverage_claim, state FROM retrieval_query_result WHERE trace_id = ?1 " +
              "AND trace_revision = ?2 AND principal_ref = ?3 AND client_class = ?4 " +
              "AND credential_generation = ?5 LIMIT 1",
          )
          .bind(
            ref.id,
            ref.revision,
            context.principal_ref,
            context.client_class,
            context.credential_generation,
          )
          .first<OwnedResultRow>();
      } catch {
        fail("RESEARCH_TRACE_NOT_FOUND", "research trace does not exist", 404);
      }
      if (owned === null) {
        fail("RESEARCH_TRACE_NOT_FOUND", "research trace does not exist", 404);
      }
      if (owned.state !== "COMPLETE") {
        fail("RESEARCH_TRACE_STALE", "research trace scope is no longer current", 409);
      }
      if (owned.coverage_claim !== "NONE" && owned.coverage_claim !== "SAMPLED") {
        fail("RESEARCH_TRACE_CORRUPT", "stored coverage claim is not a recorded value", 409);
      }
      if (typeof traceRow.trace_json !== "string") {
        fail("RESEARCH_TRACE_CORRUPT", "stored trace payload is not canonical", 409);
      }
      let parsed: RetrievalTrace;
      try {
        parsed = RetrievalTraceSchema.parse(JSON.parse(traceRow.trace_json));
      } catch {
        fail("RESEARCH_TRACE_CORRUPT", "stored trace fails strict validation", 409);
      }
      if (
        parsed.trace_ref.id !== ref.id ||
        parsed.trace_ref.revision !== ref.revision ||
        parsed.scope_snapshot.snapshot_id !== traceRow.scope_snapshot_id ||
        parsed.scope_snapshot.revision !== traceRow.scope_snapshot_revision
      ) {
        fail("RESEARCH_TRACE_CORRUPT", "stored trace binding does not match its row", 409);
      }
      if (canonicalRetrievalJson(parsed) !== traceRow.trace_json) {
        fail("RESEARCH_TRACE_CORRUPT", "stored trace is not canonical", 409);
      }
      const access = {
        principal_ref: context.principal_ref,
        client_class: context.client_class,
        credential_generation: context.credential_generation,
      };
      try {
        await createD1ScopePorts(db, access).requireCurrentScope(parsed.scope_snapshot);
      } catch (error) {
        if (error instanceof RetrievalQueryError) {
          fail("RESEARCH_TRACE_STALE", "research trace scope is no longer current", 409);
        }
        fail("RESEARCH_TRACE_STALE", "research trace scope is no longer current", 409);
      }
      return { ...parsed, coverage_claim: owned.coverage_claim };
    },
  };
}
