import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { ProjectClientGrant } from "@eliotr/contracts";
import { fail } from "@eliotr/cloudflare-research";
import type { InvestigationLedgerStore } from "@eliotr/research";
import type { ScopeProfileBinding } from "@eliotr/retrieval";
import {
  routeResearchComputerAgentStages as routeRuntimeResearchComputerAgentStages,
  type ResearchExternalAgentRoutingBindingsV1,
} from "@eliotr/cloudflare-research-runtime/research-external-agent-routing.js";
import type { Env } from "./env.js";
import {
  ComputerAgentRouteError,
  requireComputerAgentRunRouteBinding,
} from "./computer-agent-route-store.js";
import type { ResearchStageHandlerFactory } from "@eliotr/cloudflare-research-runtime/research-stage-handlers.js";

export interface ResearchExternalAgentRoutingInput {
  readonly base: ResearchStageHandlerFactory;
  readonly generation: string;
  readonly env: Pick<Env, "CORE_DB" | "SEARCH_DB" | "WORK_BUCKET" | "EVIDENCE_BUCKET"> &
    Partial<Pick<Env, "AI_SEARCH">>;
  readonly navigation: NavigationReadAuthority;
  readonly ledger: Pick<InvestigationLedgerStore, "read">;
  readonly retrieval_profile: ScopeProfileBinding;
  readonly grant?: ProjectClientGrant | undefined;
  readonly now?: () => number;
}

/** Core adapts authenticated application bindings to the reusable runtime ports. */
export function routeResearchComputerAgentStages(
  input: ResearchExternalAgentRoutingInput,
): ResearchStageHandlerFactory {
  const bindings: ResearchExternalAgentRoutingBindingsV1 = Object.freeze({
    database: input.env.CORE_DB,
    search_database: input.env.SEARCH_DB,
    work_bucket: input.env.WORK_BUCKET,
    evidence_bucket: input.env.EVIDENCE_BUCKET,
    ...(input.env.AI_SEARCH === undefined ? {} : { ai_search: input.env.AI_SEARCH }),
  });
  return routeRuntimeResearchComputerAgentStages({
    base: input.base,
    generation: input.generation,
    bindings,
    navigation: input.navigation,
    ledger: input.ledger,
    retrieval_profile: input.retrieval_profile,
    ...(input.grant === undefined ? {} : { grant: input.grant }),
    ...(input.now === undefined ? {} : { now: input.now }),
    require_route_binding: async (operationId, exactGrant) => {
      try {
        await requireComputerAgentRunRouteBinding(input.env.CORE_DB, operationId, exactGrant);
      } catch (error) {
        if (error instanceof ComputerAgentRouteError && error.retryable) {
          fail("WORKFLOW_EFFECT_UNCERTAIN");
        }
        fail("WORKFLOW_AUTHORITY_STALE");
      }
    },
  });
}
