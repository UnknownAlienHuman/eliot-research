import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { ResearchWorkflowStage } from "@eliotr/contracts";
import type { InvestigationLedgerStore } from "@eliotr/research";
import {
  createFreezeProtocolAndScopeStageHandler,
  digest,
  fail,
  type MonotoneHandlerFactory,
  type WorkflowStageHandler,
} from "@eliotr/cloudflare-research";

/** Generation used only by the server-owned exploratory research.run path. */
export const SERVER_OWNED_RESEARCH_HANDLER_GENERATION = "research-handlers.exploratory.v1";

export type ResearchStageHandlerFactoryMode =
  | {
      readonly kind: "server-owned-exploratory";
      readonly navigation: NavigationReadAuthority;
      readonly ledger: Pick<InvestigationLedgerStore, "read">;
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

  return (stage) => {
    if (stage === "FREEZE_PROTOCOL_AND_SCOPE" && protocolScopeHandler !== undefined) {
      return protocolScopeHandler;
    }
    return ({ request, input_bytes, attempt_ref }) =>
      deterministicStageBytes(request.operation_id, request.stage, input_bytes, attempt_ref);
  };
}
