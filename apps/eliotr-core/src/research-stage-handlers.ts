import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { ResearchWorkflowStage } from "@eliotr/contracts";
import type { InvestigationLedgerStore } from "@eliotr/research";
import { createD1ScopeProfilePort } from "@eliotr/retrieval";
import {
  createFreezeProtocolAndScopeStageHandler,
  digest,
  fail,
  type MonotoneHandlerFactory,
  type WorkflowStageHandler,
} from "@eliotr/cloudflare-research";
import {
  createRetrieveBranchesStageHandler,
  type RetrieveBranchesStageDependencies,
} from "./research-retrieve-branches.js";

/** Generation used only by the server-owned exploratory research.run path. */
export const SERVER_OWNED_RESEARCH_HANDLER_GENERATION = "research-handlers.exploratory.v1";
/** Generation for new exploratory runs that include the persisted retrieval stage. */
export const SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION = "research-handlers.exploratory.v2";
export const SERVER_RETRIEVAL_SCOPE_PROFILE = {
  version: "retrieval-scope-v1",
  max_sources: 64,
  max_results: 16,
} as const;

export type ResearchStageHandlerFactoryMode =
  | {
      readonly kind: "server-owned-exploratory";
      readonly navigation: NavigationReadAuthority;
      readonly ledger: Pick<InvestigationLedgerStore, "read">;
      readonly generation?: typeof SERVER_OWNED_RESEARCH_HANDLER_GENERATION | typeof SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION;
      readonly retrieval?: Omit<RetrieveBranchesStageDependencies, "navigation" | "ledger" | "profile">;
    }
  | { readonly kind: "legacy-deterministic" };

async function deterministicStageBytes(
  operationId: string,
  stage: ResearchWorkflowStage,
  inputBytes: Uint8Array,
  attemptRef: string,
): Promise<Uint8Array> {
  const inputSha = await digest(inputBytes);
  const bytes = new TextEncoder().encode(JSON.stringify({
    operation_id: operationId,
    stage,
    input_sha: inputSha,
    attempt_ref: attemptRef,
  }));
  if (bytes.byteLength > 8 * 1024 * 1024) {
    fail("WORKFLOW_INPUT_INVALID");
  }
  return bytes;
}

/**
 * Selects the real protocol/scope producer only for its explicit generation.
 * Legacy workflow records continue to use the deterministic handler, including
 * arbitrary fixture bytes and their existing replay identity.
 */
export function createResearchStageHandlerFactory(
  mode: ResearchStageHandlerFactoryMode,
): MonotoneHandlerFactory {
  const protocolScopeHandler: WorkflowStageHandler | undefined = mode.kind === "server-owned-exploratory"
    ? createFreezeProtocolAndScopeStageHandler({ navigation: mode.navigation, ledger: mode.ledger })
    : undefined;
  let retrievalHandler: WorkflowStageHandler | undefined;
  if (mode.kind === "server-owned-exploratory" &&
      mode.generation === SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION && mode.retrieval !== undefined) {
    const { retrieval, navigation, ledger } = mode;
    retrievalHandler = async (input) => {
      let profile;
      try {
        profile = await createD1ScopeProfilePort(retrieval.database).loadBinding(navigation.scope);
      } catch {
        fail("WORKFLOW_AUTHORITY_STALE");
      }
      if (profile.version !== SERVER_RETRIEVAL_SCOPE_PROFILE.version ||
          !Number.isSafeInteger(profile.max_sources) || profile.max_sources > SERVER_RETRIEVAL_SCOPE_PROFILE.max_sources ||
          !Number.isSafeInteger(profile.max_results) || profile.max_results > SERVER_RETRIEVAL_SCOPE_PROFILE.max_results) {
        fail("WORKFLOW_AUTHORITY_STALE");
      }
      return createRetrieveBranchesStageHandler({ ...retrieval, navigation, ledger, profile })(input);
    };
  }

  return (stage) => {
    if (stage === "FREEZE_PROTOCOL_AND_SCOPE" && protocolScopeHandler !== undefined) {
      return protocolScopeHandler;
    }
    if (stage === "RETRIEVE_BRANCHES" && mode.kind === "server-owned-exploratory" &&
        mode.generation === SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION) {
      if (retrievalHandler === undefined) return async () => fail("WORKFLOW_AUTHORITY_STALE");
      return retrievalHandler;
    }
    return ({ request, input_bytes, attempt_ref }) =>
      deterministicStageBytes(request.operation_id, request.stage, input_bytes, attempt_ref);
  };
}
