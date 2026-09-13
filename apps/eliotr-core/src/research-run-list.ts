import type { AuthenticatedRequestContext, ResearchRunStatus } from "@eliotr/interfaces";
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
  return {
    protocol: "eliotr.research-runs.v1" as const,
    runs,
    configuration_state: researchSemanticConfigurationInstalled(env) ? "INSTALLED" as const : "MISSING" as const,
    checked_at: new Date().toISOString(),
  };
}
