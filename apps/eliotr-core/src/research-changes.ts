import type { SemanticApi } from "@eliotr/interfaces";
import {
  createResearchChangesService as createRuntimeResearchChangesService,
  type ResearchChangesScopeReadAuthorization,
  type ResearchChangesServiceOptions,
} from "@eliotr/cloudflare-research-runtime/research-changes.js";
import type { Env } from "./env.js";
import { prepareOwnerScopeHistoricalReadAuthorization } from "./wiki-proposal-reauthorization.js";

export {
  RESEARCH_CHANGE_KINDS,
  RESEARCH_CHANGES_PROTOCOL,
  parseResearchChangesRequest,
  recordResearchChange,
} from "@eliotr/cloudflare-research-runtime/research-changes.js";
export type {
  ResearchChangeWrite,
  ResearchChangesServiceOptions,
} from "@eliotr/cloudflare-research-runtime/research-changes.js";

export function createResearchChangesService(
  env: Pick<Env, "CORE_DB" | "DEPLOYMENT_GENERATION" | "RESEARCH_CHANGES_CURSOR_KEY">,
  options: ResearchChangesServiceOptions = {},
): SemanticApi["changes"] {
  return createRuntimeResearchChangesService({
    database: env.CORE_DB,
    deployment_generation: env.DEPLOYMENT_GENERATION,
    cursor_key: env.RESEARCH_CHANGES_CURSOR_KEY,
    authorize_historical_scope: async (context, scopeRef): Promise<ResearchChangesScopeReadAuthorization> =>
      prepareOwnerScopeHistoricalReadAuthorization(env, context, scopeRef),
  }, options);
}