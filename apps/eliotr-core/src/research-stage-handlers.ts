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

export interface ResearchRetrieveBranchesEnvironment {
  readonly database: D1Database;
  readonly search_database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly evidence_bucket: R2Bucket;
}

export interface ResearchRetrieveBranchesInput {
  readonly environment: ResearchRetrieveBranchesEnvironment;
  readonly access: RetrieveBranchesStageDependencies["access"];
  readonly navigation: NavigationReadAuthority;
  readonly ledger: Pick<InvestigationLedgerStore, "read">;
}

/** Builds the one server-owned retrieval composition shared by all callers. */
export function createResearchRetrieveBranchesDependencies(
  input: ResearchRetrieveBranchesInput,
): RetrieveBranchesStageDependencies {
  return {
    ...input.environment,
    access: input.access,
    navigation: input.navigation,
    ledger: input.ledger,
    profile: SERVER_RETRIEVAL_SCOPE_PROFILE,
  };
}

async function readPersistedRetrievalProfile(
  database: D1Database,
  scope: NavigationReadAuthority["scope"],
): Promise<RetrieveBranchesStageDependencies["profile"]> {
  let row: { readonly profile_version: unknown; readonly max_sources: unknown; readonly max_results: unknown } | null;
  try {
    row = await database.prepare(
      "SELECT profile_version, max_sources, max_results FROM retrieval_scope_profile WHERE snapshot_id = ?1 AND revision = ?2 LIMIT 1",
    ).bind(scope.snapshot_id, scope.revision).first();
  } catch {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
  const maxSources = row?.max_sources;
  const maxResults = row?.max_results;
  if (row === null || row.profile_version !== SERVER_RETRIEVAL_SCOPE_PROFILE.version ||
      !Number.isSafeInteger(maxSources) || (maxSources as number) < 1 ||
      (maxSources as number) > SERVER_RETRIEVAL_SCOPE_PROFILE.max_sources ||
      !Number.isSafeInteger(maxResults) || (maxResults as number) < 1 ||
      (maxResults as number) > SERVER_RETRIEVAL_SCOPE_PROFILE.max_results) {
    fail("WORKFLOW_AUTHORITY_STALE");
  }
  return {
    version: SERVER_RETRIEVAL_SCOPE_PROFILE.version,
    max_sources: maxSources as number,
    max_results: maxResults as number,
  };
}

export type ResearchStageHandlerFactoryMode =
  | {
      readonly kind: "server-owned-exploratory";
      readonly navigation: NavigationReadAuthority;
      readonly ledger: Pick<InvestigationLedgerStore, "read">;
      readonly generation?: typeof SERVER_OWNED_RESEARCH_HANDLER_GENERATION | typeof SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION;
      readonly retrieval?: Omit<ResearchRetrieveBranchesInput, "navigation" | "ledger">;
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
    const base = createResearchRetrieveBranchesDependencies({
      ...mode.retrieval,
      navigation: mode.navigation,
      ledger: mode.ledger,
    });
    retrievalHandler = async (input) => {
      const profile = await readPersistedRetrievalProfile(base.database, mode.navigation.scope);
      return createRetrieveBranchesStageHandler({ ...base, profile })(input);
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
