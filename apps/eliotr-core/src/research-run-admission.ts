import { createOrientationApi, ORIENTATION_PROFILE, splitExhaustiveSourceRefs, type createProjectClientScopeAuthority } from "@eliotr/cloudflare-navigation";
import { createD1EvidenceAuthorityPort } from "@eliotr/cloudflare-evidence";
import { createD1ScopePorts } from "@eliotr/retrieval";
import type { VersionedRef } from "@eliotr/contracts";
import type { AuthenticatedRequestContext, QueryRequest } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { failResearch as fail } from "./research-service-error.js";

/** Admission only: neither native execution nor a replay renews this deadline. */
export async function prepareResearchRunScope(
  env: Pick<Env, "CORE_DB" | "SEARCH_DB">,
  context: AuthenticatedRequestContext,
  request: QueryRequest,
  operationId: string,
  requestDigest: string,
  originalRef?: VersionedRef,
  delegated?: Awaited<ReturnType<typeof createProjectClientScopeAuthority>>,
): Promise<VersionedRef> {
  if (context.client_class !== "owner_pwa" && delegated === undefined) fail("RESEARCH_OWNER_REQUIRED", "owner authorization is required", 403);
  if (context.request.signal.aborted) fail("RESEARCH_CANCELLED", "research admission is cancelled", 409);
  if (originalRef !== undefined) {
    // Never refreeze current heads, change the original JWT attribution or revive
    // expired/revoked execution on a repeated POST. Reauthenticated history and
    // control use their existing separate authorizers.
    const original = await createD1EvidenceAuthorityPort({
      core_database: env.CORE_DB, search_database: env.SEARCH_DB,
    }).loadScope(originalRef);
    if (original === null || original.invalidated_at !== null) {
      fail("RESEARCH_AUTHORITY_STALE", "original research scope is unavailable", 409);
    }
    await createD1ScopePorts(env.CORE_DB, context).requireCurrentScope(original.snapshot);
    await delegated?.requireScopeCurrent(original.snapshot);
    return originalRef;
  }
  const generation = await env.CORE_DB.prepare(
    "SELECT value FROM schema_state WHERE key='research_execution_scope_generation'",
  ).first<string>("value");
  const profileGeneration = await env.CORE_DB.prepare(
    "SELECT value FROM schema_state WHERE key='research_scope_profile_generation'",
  ).first<string>("value");
  if (generation !== "research-execution-scope-v1" || profileGeneration !== "retrieval-scope-v2") {
    fail("RESEARCH_INPUT_SCHEMA_MISMATCH", "Research execution scopes require Core migrations 0070 and 0071", 503);
  }
  const orientation = createOrientationApi(env, Date.now, {
    operation_id: operationId, request_digest: requestDigest,
  }, delegated);
  const oriented = await orientation.orient(context, {
    query: request.query, product: "ORIENT", scope_expression: request.scope_expression,
    literals: [], evidence_grade: "E0", budget_ref: ORIENTATION_PROFILE, max_results: request.max_results,
  }).catch((error: unknown) => {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (typeof code === "string" && ["SCOPE_MEMBER_LIMIT", "SCOPE_SNAPSHOT_TOO_LARGE", "SCOPE_STORAGE_RESOURCE_LIMIT",
      "SCOPE_SELECTED_SOURCE_LIMIT", "ORIENTATION_SCOPE_LIMIT", "ORIENTATION_INPUT_LIMIT", "ORIENTATION_RESULT_LIMIT"].includes(code)) {
      fail("RESEARCH_INPUT_LIMIT", "Requested scope exceeds its member or UTF-8 envelope; partition the scope without dropping sources", 413);
    }
    throw error;
  });
  return oriented.evidence_pack.scope_snapshot_ref;
}

interface ResearchPlanningSourceRow {
  readonly source_revision_ref: string;
  readonly source_id: string;
  readonly source_class: string;
  readonly source_namespace_id: string;
  readonly source_owner_generation: string;
  readonly origin_uri: string | null;
  readonly purge_state: string;
  readonly current_owner_generation: string | null;
  readonly owner_status: string | null;
}
export async function loadResearchPlanningSources(
  database: D1Database,
  sourceRevisionRefs: readonly string[],
  sourceOwnerGenerations: Readonly<Record<string, string>>,
): Promise<readonly ResearchPlanningSourceRow[]> {
  const expected = new Set(sourceRevisionRefs);
  const portfolio: ResearchPlanningSourceRow[] = [];
  for (const batch of splitExhaustiveSourceRefs(sourceRevisionRefs)) {
    const rows = await database.prepare(
      "SELECT sr.source_revision_ref, sr.source_id, s.source_class, s.source_namespace_id, " +
      "sr.source_owner_generation, s.origin_uri, sr.purge_state, " +
      "own.source_owner_generation AS current_owner_generation, own.status AS owner_status " +
      "FROM json_each(?1) requested " +
      "JOIN source_revision sr ON sr.source_revision_ref=requested.value " +
      "JOIN source s ON s.source_id=sr.source_id " +
      "LEFT JOIN source_namespace_ownership own ON own.source_namespace_id=s.source_namespace_id AND own.status='ACTIVE' " +
      "ORDER BY sr.source_revision_ref LIMIT ?2",
    ).bind(JSON.stringify(batch), batch.length + 1).all<ResearchPlanningSourceRow>();
    if (!rows.success || !Array.isArray(rows.results) || rows.results.length !== batch.length) {
      fail("RESEARCH_AUTHORITY_STALE", "planning source portfolio is unavailable", 409);
    }
    const requested = new Set(batch);
    for (const row of rows.results) {
      if (!requested.delete(row.source_revision_ref) || !expected.delete(row.source_revision_ref) ||
          row.purge_state !== "LIVE" || row.owner_status !== "ACTIVE" ||
          row.current_owner_generation !== row.source_owner_generation ||
          sourceOwnerGenerations[row.source_revision_ref] !== row.source_owner_generation) {
        fail("RESEARCH_AUTHORITY_STALE", "planning source portfolio is not current", 409);
      }
      portfolio.push(row);
    }
  }
  if (expected.size !== 0) fail("RESEARCH_AUTHORITY_STALE", "planning source portfolio is incomplete", 409);
  return portfolio.sort((left, right) => left.source_revision_ref < right.source_revision_ref ? -1 : 1);
}
