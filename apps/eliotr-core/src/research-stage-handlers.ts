import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { InvestigationLedgerStore } from "@eliotr/research";
import { createD1ScopeProfilePort } from "@eliotr/retrieval";
import type { WorkflowStartedAttemptRecovery } from "@eliotr/cloudflare-workflows";
import {
  createFreezeProtocolAndScopeStageHandler,
  deterministicWorkflowStageBytes,
  fail,
  type MonotoneHandlerFactory,
  type WorkflowStageHandler,
  createEvidenceFreezeSynthesisHandler,
  createResearchMaterializeStageHandler,
  type ResearchMaterializeStageDependencies,
  createResearchReportMaterializeStageHandler,
  type ResearchReportMaterializeStageDependencies,
} from "@eliotr/cloudflare-research";
import {
  createResearchVerificationStageHandler,
  createResearchClaimAuditStageHandler,
  createResearchCitationsStageHandler,
  type ResearchClaimAuditStageDependencies,
  type ResearchCitationsStageDependencies,
  type ResearchVerificationStageDependencies,
} from "@eliotr/cloudflare-research-stages";
import {
  createRetrieveBranchesStageHandler,
  type RetrieveBranchesStageDependencies,
} from "./research-retrieve-branches.js";
import {
  createEvidenceFreezeComposition,
  type EvidenceFreezeCompositionDependencies,
} from "./research-evidence-freeze-composition.js";
import type { Env } from "./env.js";

/** Generation used only by the server-owned exploratory research.run path. */
export const SERVER_OWNED_RESEARCH_HANDLER_GENERATION = "research-handlers.exploratory.v1";
/** Generation for new exploratory runs that include the persisted retrieval stage. */
export const SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION = "research-handlers.exploratory.v2";
/** Generation for the explicit stage-10/11 evidence-freeze composition. */
export const SERVER_OWNED_FREEZE_HANDLER_GENERATION = "research-handlers.exploratory.v3";
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
      /** Server-owned bindings used to compose retrieval for v2. */
      readonly environment?: Pick<Env, "CORE_DB" | "SEARCH_DB" | "WORK_BUCKET" | "EVIDENCE_BUCKET">;
      readonly generation?: typeof SERVER_OWNED_RESEARCH_HANDLER_GENERATION | typeof SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION | typeof SERVER_OWNED_FREEZE_HANDLER_GENERATION;
      readonly retrieval?: Omit<RetrieveBranchesStageDependencies, "navigation" | "ledger" | "profile">;
      readonly freeze?: EvidenceFreezeCompositionDependencies;
      readonly synthesis?: Parameters<typeof createEvidenceFreezeSynthesisHandler>[0];
      readonly materialize?: ResearchMaterializeStageDependencies;
      readonly report_materialize?: ResearchReportMaterializeStageDependencies;
      readonly verification?: ResearchVerificationStageDependencies;
      /** Explicit Stage14 server-owned audit wiring; no default verifier is inferred. */
      readonly audit_claims?: ResearchClaimAuditStageDependencies;
      /** Explicit Stage15 server-owned citation wiring; no default resolver is inferred. */
      readonly resolve_citations?: ResearchCitationsStageDependencies;
    }
  | { readonly kind: "legacy-deterministic" };

export type ResearchStageHandlerFactory = MonotoneHandlerFactory & {
  readonly recoverStartedAttempt?: WorkflowStartedAttemptRecovery;
};

/**
 * Selects the real protocol/scope producer only for its explicit generation.
 * Legacy workflow records continue to use the deterministic handler, including
 * arbitrary fixture bytes and their existing replay identity.
 */
export function createResearchStageHandlerFactory(
  mode: ResearchStageHandlerFactoryMode,
): ResearchStageHandlerFactory {
  const protocolScopeHandler: WorkflowStageHandler | undefined = mode.kind === "server-owned-exploratory"
    ? createFreezeProtocolAndScopeStageHandler({ navigation: mode.navigation, ledger: mode.ledger })
    : undefined;
  const retrieval = mode.kind === "server-owned-exploratory" && mode.environment !== undefined
    ? { database: mode.environment.CORE_DB, search_database: mode.environment.SEARCH_DB, work_bucket: mode.environment.WORK_BUCKET,
      evidence_bucket: mode.environment.EVIDENCE_BUCKET, access: mode.navigation.access }
    : mode.kind === "server-owned-exploratory" ? mode.retrieval : undefined;
  let retrievalHandler: WorkflowStageHandler | undefined;
  if (mode.kind === "server-owned-exploratory" &&
      (mode.generation === SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION || mode.generation === SERVER_OWNED_FREEZE_HANDLER_GENERATION) && retrieval !== undefined) {
    const { navigation, ledger } = mode;
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
  const freezeComposition = mode.kind === "server-owned-exploratory" &&
    mode.generation === SERVER_OWNED_FREEZE_HANDLER_GENERATION && mode.freeze !== undefined
    ? createEvidenceFreezeComposition(mode.freeze)
    : undefined;
  let materializeHandler: WorkflowStageHandler | undefined;
  if (mode.kind === "server-owned-exploratory" && mode.generation === SERVER_OWNED_FREEZE_HANDLER_GENERATION) {
    if (mode.report_materialize !== undefined && mode.materialize === undefined) {
      materializeHandler = createResearchReportMaterializeStageHandler(mode.report_materialize);
    } else if (mode.materialize !== undefined && mode.report_materialize === undefined) {
      materializeHandler = createResearchMaterializeStageHandler(mode.materialize);
    }
  }

  const explicitV3 = mode.kind === "server-owned-exploratory" &&
    mode.generation === SERVER_OWNED_FREEZE_HANDLER_GENERATION;
  let synthesisAdapter: ReturnType<typeof createEvidenceFreezeSynthesisHandler> | undefined;
  let auditAdapter: ReturnType<typeof createResearchClaimAuditStageHandler> | undefined;
  let citationsAdapter: ReturnType<typeof createResearchCitationsStageHandler> | undefined;
  function getSynthesisAdapter(): ReturnType<typeof createEvidenceFreezeSynthesisHandler> | undefined {
    if (mode.kind !== "server-owned-exploratory" ||
        mode.generation !== SERVER_OWNED_FREEZE_HANDLER_GENERATION || mode.synthesis === undefined) return undefined;
    synthesisAdapter ??= createEvidenceFreezeSynthesisHandler(mode.synthesis);
    return synthesisAdapter;
  }
  function getAuditAdapter(): ReturnType<typeof createResearchClaimAuditStageHandler> | undefined {
    if (mode.kind !== "server-owned-exploratory" ||
        mode.generation !== SERVER_OWNED_FREEZE_HANDLER_GENERATION || mode.audit_claims === undefined) return undefined;
    auditAdapter ??= createResearchClaimAuditStageHandler(mode.audit_claims);
    return auditAdapter;
  }
  function getCitationsAdapter(): ReturnType<typeof createResearchCitationsStageHandler> | undefined {
    if (mode.kind !== "server-owned-exploratory" ||
        mode.generation !== SERVER_OWNED_FREEZE_HANDLER_GENERATION || mode.resolve_citations === undefined) return undefined;
    citationsAdapter ??= createResearchCitationsStageHandler(mode.resolve_citations);
    return citationsAdapter;
  }

  const factory = ((stage) => {
    if (stage === "FREEZE_PROTOCOL_AND_SCOPE" && protocolScopeHandler !== undefined) {
      return protocolScopeHandler;
    }
    if (stage === "RETRIEVE_BRANCHES" && mode.kind === "server-owned-exploratory" &&
        (mode.generation === SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION || mode.generation === SERVER_OWNED_FREEZE_HANDLER_GENERATION)) {
      if (retrievalHandler === undefined) return async () => fail("WORKFLOW_AUTHORITY_STALE");
      return retrievalHandler;
    }
    if ((stage === "RECONCILE" || stage === "FREEZE_EVIDENCE") && freezeComposition !== undefined) {
      return stage === "RECONCILE" ? freezeComposition.reconcile : freezeComposition.freeze;
    }
    if (mode.kind === "server-owned-exploratory" && mode.generation === SERVER_OWNED_FREEZE_HANDLER_GENERATION &&
        (stage === "RECONCILE" || stage === "FREEZE_EVIDENCE")) {
      return async () => fail("WORKFLOW_AUTHORITY_STALE");
    }
    if (stage === "SYNTHESIZE" && mode.kind === "server-owned-exploratory" && mode.generation === SERVER_OWNED_FREEZE_HANDLER_GENERATION) {
      const adapter = getSynthesisAdapter();
      return adapter === undefined ? async () => fail("WORKFLOW_AUTHORITY_STALE") : adapter.handler;
    }
    if (stage === "VERIFY" && mode.kind === "server-owned-exploratory" && mode.generation === SERVER_OWNED_FREEZE_HANDLER_GENERATION) {
      return mode.verification === undefined ? async () => fail("WORKFLOW_AUTHORITY_STALE") : createResearchVerificationStageHandler(mode.verification);
    }
    if (stage === "AUDIT_CLAIMS" && mode.kind === "server-owned-exploratory" && mode.generation === SERVER_OWNED_FREEZE_HANDLER_GENERATION) {
      const adapter = getAuditAdapter();
      return adapter === undefined ? async () => fail("WORKFLOW_AUTHORITY_STALE") : adapter.handler;
    }
    if (stage === "RESOLVE_CITATIONS" && mode.kind === "server-owned-exploratory" && mode.generation === SERVER_OWNED_FREEZE_HANDLER_GENERATION) {
      const adapter = getCitationsAdapter();
      return adapter === undefined ? async () => fail("WORKFLOW_AUTHORITY_STALE") : adapter;
    }
    if (stage === "MATERIALIZE" && mode.kind === "server-owned-exploratory" && mode.generation === SERVER_OWNED_FREEZE_HANDLER_GENERATION) {
      return materializeHandler === undefined ? async () => fail("WORKFLOW_AUTHORITY_STALE") : materializeHandler;
    }
    return ({ request, input_bytes, attempt_ref }) =>
      deterministicWorkflowStageBytes(request.operation_id, request.stage, input_bytes, attempt_ref);
  }) as ResearchStageHandlerFactory;

  if (explicitV3) {
    const recoverStartedAttempt: WorkflowStartedAttemptRecovery = async (input) => {
      if (input.request.handler_generation !== SERVER_OWNED_FREEZE_HANDLER_GENERATION) return null;
      if (input.request.stage === "SYNTHESIZE") return getSynthesisAdapter()?.recoverStartedAttempt(input) ?? null;
      if (input.request.stage === "AUDIT_CLAIMS") return getAuditAdapter()?.recoverStartedAttempt(input) ?? null;
      return null;
    };
    Object.defineProperty(factory, "recoverStartedAttempt", {
      configurable: false,
      enumerable: true,
      value: recoverStartedAttempt,
      writable: false,
    });
  }
  return Object.freeze(factory);
}
