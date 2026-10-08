import { createOrientationApi } from "@eliotr/cloudflare-navigation";
import type { createProjectClientScopeAuthority } from "@eliotr/cloudflare-navigation";
import type { VersionedRef } from "@eliotr/contracts";
import type { AuthenticatedRequestContext, QueryRequest } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { failResearch } from "./research-service-error.js";
import {
  loadResearchPlanningSources as loadResearchPlanningSourcesCapability,
  prepareResearchRunScope as prepareResearchRunScopeCapability,
} from "@eliotr/cloudflare-research-runtime";
import type { ResearchPlanningSourceRow } from "@eliotr/cloudflare-research-runtime";

export async function prepareResearchRunScope(
  env: Pick<Env, "CORE_DB" | "SEARCH_DB">,
  context: AuthenticatedRequestContext,
  request: QueryRequest,
  operationId: string,
  requestDigest: string,
  originalRef?: VersionedRef,
  delegated?: Awaited<ReturnType<typeof createProjectClientScopeAuthority>>,
): Promise<VersionedRef> {
  return prepareResearchRunScopeCapability({
    core_database: env.CORE_DB,
    search_database: env.SEARCH_DB,
    authorize_request: (actor, scopeAuthority) => {
      if (actor.client_class !== "owner_pwa" && scopeAuthority === undefined) {
        failResearch("RESEARCH_OWNER_REQUIRED", "owner authorization is required", 403);
      }
      if (actor.request.signal.aborted) failResearch("RESEARCH_CANCELLED", "research admission is cancelled", 409);
    },
    fail: failResearch,
    orient: async (actor, orientationRequest, operation, digest, scopeAuthority) => {
      const orientation = createOrientationApi(env, Date.now, {
        operation_id: operation, request_digest: digest,
      }, scopeAuthority);
      const result = await orientation.orient(actor, orientationRequest);
      return result.evidence_pack.scope_snapshot_ref;
    },
  }, context, request, operationId, requestDigest, originalRef, delegated);
}

export function loadResearchPlanningSources(
  database: D1Database,
  sourceRevisionRefs: readonly string[],
  sourceOwnerGenerations: Readonly<Record<string, string>>,
): Promise<readonly ResearchPlanningSourceRow[]> {
  return loadResearchPlanningSourcesCapability(database, sourceRevisionRefs, sourceOwnerGenerations, failResearch);
}
