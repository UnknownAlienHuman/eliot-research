import type { SemanticApi } from "@eliotr/interfaces";
import { CatalogInputError } from "@eliotr/cloudflare-navigation";
import {
  createResearchChangesService as createRuntimeResearchChangesService,
  type ResearchChangesScopeReadAuthorization,
  type ResearchChangesServiceOptions,
} from "@eliotr/cloudflare-research-runtime/research-changes.js";
import type { Env } from "./env.js";
import { createErasureChangeAuthorizer } from "./erasure-change-authority.js";
import { prepareOwnerScopeHistoricalReadAuthorization } from "./wiki-proposal-reauthorization.js";

const ERASURE_COMPLETION_FEED_GENERATION_KEY = "erasure_completion_feed_generation";
const ERASURE_COMPLETION_FEED_GENERATION = "erasure-completion-feed-v1";
const ERASURE_COMPLETION_FEED_TRIGGER = "erasure_execution_completion_change_feed";

async function erasureCompletionFeedReady(database: D1Database): Promise<boolean> {
  try {
    const [generation, trigger] = await Promise.all([
      database.prepare("SELECT value FROM schema_state WHERE key=?1")
        .bind(ERASURE_COMPLETION_FEED_GENERATION_KEY).first<{ value: unknown }>(),
      database.prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?1 AND name=?2 LIMIT 1",
      ).bind("erasure_execution", ERASURE_COMPLETION_FEED_TRIGGER).first<{ name: unknown }>(),
    ]);
    return generation?.value === ERASURE_COMPLETION_FEED_GENERATION &&
      trigger?.name === ERASURE_COMPLETION_FEED_TRIGGER;
  } catch {
    return false;
  }
}

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
  const service: SemanticApi["changes"] = createRuntimeResearchChangesService({
    database: env.CORE_DB,
    deployment_generation: env.DEPLOYMENT_GENERATION,
    cursor_key: env.RESEARCH_CHANGES_CURSOR_KEY,
    authorize_erasure_change: createErasureChangeAuthorizer(env),
    authorize_historical_scope: async (context, scopeRef): Promise<ResearchChangesScopeReadAuthorization> =>
      prepareOwnerScopeHistoricalReadAuthorization(env, context, scopeRef),
  }, options);
  const guarded: SemanticApi["changes"] = async (context, request) => {
    if (context.client_class === "owner_pwa" && !(await erasureCompletionFeedReady(env.CORE_DB))) {
      throw new CatalogInputError(
        "RESEARCH_CHANGES_SCHEMA_NOT_READY",
        "Research changes are not ready",
        503,
        true,
      );
    }
    return service(context, request);
  };
  return guarded;
}