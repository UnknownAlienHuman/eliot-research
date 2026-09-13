import type { AuthenticatedRequestContext, ResearchRunStatus } from "@eliotr/interfaces";
import { VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import { loadScopeAuthority } from "@eliotr/cloudflare-evidence";
import { createOwnerScopeAuthority, OrientationError } from "@eliotr/cloudflare-navigation";
import type { Env } from "./env.js";
import { createResearchRunService } from "./research-session.js";
import { CatalogInputError } from "./catalog-service.js";
import { researchSemanticConfigurationInstalled } from "./research-semantic-server.js";

/** Recent run locators are re-authorized through the same reader as an opened run. */
export async function readOwnerResearchRuns(env: Env, context: AuthenticatedRequestContext) {
  if (context.client_class !== "owner_pwa") {
    throw new CatalogInputError("RESEARCH_OWNER_REQUIRED", "Research history requires an owner session", 403);
  }
  let rows: { operation_id: string; created_at: string }[];
  try {
    const result = await env.CORE_DB.prepare(
      "SELECT operation_id, created_at FROM research_workflow_run " +
      "WHERE principal_ref=?1 AND credential_generation=?2 AND deployment_generation=?3 " +
      "ORDER BY created_at DESC, operation_id DESC LIMIT 8",
    ).bind(context.principal_ref, context.credential_generation, env.DEPLOYMENT_GENERATION)
      .all<{ operation_id: string; created_at: string }>();
    if (!result.success) throw new Error("Research history read failed");
    rows = result.results;
  } catch {
    throw new CatalogInputError("RESEARCH_HISTORY_UNAVAILABLE", "Research history is temporarily unavailable", 503, true);
  }
  const service = createResearchRunService(env);
  const runs: { created_at: string; status: ResearchRunStatus }[] = [];
  for (const row of rows) {
    if (typeof row.operation_id !== "string" || typeof row.created_at !== "string" ||
        !Number.isFinite(Date.parse(row.created_at))) {
      throw new CatalogInputError("RESEARCH_HISTORY_INVALID", "Stored research history is invalid", 503, true);
    }
    try {
      const status = await service.runStatus(context, row.operation_id);
      runs.push({ created_at: row.created_at, status });
    } catch (error) {
      // A revoked, purged, expired or missing run must disappear from this session.
      if (error instanceof CatalogInputError && [403, 404, 409, 410].includes(error.status)) continue;
      throw error;
    }
  }
  // Historical report locators contain no document text. Recheck the current owner's
  // source policy before listing them; POST reauthorization performs full disclosure checks.
  const authority = createOwnerScopeAuthority(env.CORE_DB, context);
  const drafts = await env.CORE_DB.prepare(
    "SELECT b.artifact_id,b.revision,b.scope_snapshot_id,b.scope_snapshot_revision,b.created_at " +
    "FROM artifact_draft_binding b JOIN artifact_revision a " +
    "ON a.artifact_id=b.artifact_id AND a.revision=b.revision " +
    "WHERE b.principal_ref=?1 AND a.status='DRAFT' ORDER BY b.created_at DESC,b.artifact_id DESC LIMIT 8",
  ).bind(context.principal_ref).all<{
    artifact_id: string; revision: number; scope_snapshot_id: string; scope_snapshot_revision: number; created_at: string;
  }>();
  if (!drafts.success) throw new CatalogInputError("RESEARCH_HISTORY_UNAVAILABLE", "Saved reports are temporarily unavailable", 503, true);
  const savedDrafts: { artifact_ref: VersionedRef; created_at: string }[] = [];
  for (const row of drafts.results) {
    const ref = VersionedRefSchema.parse({ id: row.artifact_id, revision: row.revision });
    if (!Number.isFinite(Date.parse(row.created_at))) throw new CatalogInputError("RESEARCH_HISTORY_INVALID", "Saved report metadata is invalid", 503);
    const original = await loadScopeAuthority(env.CORE_DB, VersionedRefSchema.parse({
      id: row.scope_snapshot_id, revision: row.scope_snapshot_revision,
    }));
    if (original === null || original.invalidated_at !== null) continue;
    try {
      await authority.requireReadPolicy();
      const sources = await authority.sources(original.snapshot.member_source_revision_refs);
      if (sources.length !== original.snapshot.member_source_revision_refs.length || sources.some((source) =>
        !source.authority.allowed_use.includes("research") ||
        source.authority.source_owner_generation !== original.snapshot.source_owner_generations[source.authority.source_revision_ref])) continue;
      savedDrafts.push({ artifact_ref: ref, created_at: row.created_at });
    } catch (error) {
      if (error instanceof OrientationError && [403, 404, 409, 410].includes(error.status)) continue;
      throw error;
    }
  }
  return {
    protocol: "eliotr.research-runs.v2" as const,
    runs,
    saved_drafts: savedDrafts,
    configuration_state: researchSemanticConfigurationInstalled(env) ? "INSTALLED" as const : "MISSING" as const,
    checked_at: new Date().toISOString(),
  };
}
