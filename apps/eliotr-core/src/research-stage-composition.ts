import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { InvestigationLedgerStore } from "@eliotr/research";
import { createResearchStageHandlerFactory } from "./research-stage-handlers.js";
import type {
  SERVER_OWNED_RESEARCH_HANDLER_GENERATION,
  SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION,
} from "./research-stage-handlers.js";
import type { RetrieveBranchesStageDependencies } from "./research-retrieve-branches.js";
import type { MonotoneHandlerFactory } from "@eliotr/cloudflare-research";

export interface ResearchExploratoryStageCompositionInput {
  readonly generation: typeof SERVER_OWNED_RESEARCH_HANDLER_GENERATION | typeof SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION;
  readonly navigation: NavigationReadAuthority;
  readonly ledger: Pick<InvestigationLedgerStore, "read">;
  readonly retrieval?: Omit<RetrieveBranchesStageDependencies, "navigation" | "ledger" | "profile">;
}

/** Builds the shared v1/v2 handler composition used by HTTP/DO and Workflow callers. */
export function createResearchExploratoryStageHandlers(
  input: ResearchExploratoryStageCompositionInput,
): MonotoneHandlerFactory {
  return createResearchStageHandlerFactory({
    kind: "server-owned-exploratory",
    generation: input.generation,
    navigation: input.navigation,
    ledger: input.ledger,
    ...(input.retrieval === undefined ? {} : { retrieval: input.retrieval }),
  });
}
