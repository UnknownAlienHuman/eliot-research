import { requireOwnerScopeProfile } from "@eliotr/cloudflare-navigation";
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
  createResearchMaterializeRecovery,
  readWorkflowObject,
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
  SEMANTIC_RETRIEVAL_HANDLER_GENERATION,
  SEMANTIC_PROTOCOL_HANDLER_GENERATION,
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
/** Legacy semantic generation; committed v4 runs remain readable. */
export const SERVER_OWNED_SEMANTIC_HANDLER_GENERATION = SEMANTIC_RETRIEVAL_HANDLER_GENERATION;
/** Persisted protocol runs retain their original non-semantic retrieval plan. */
export const SERVER_OWNED_LEGACY_PROTOCOL_HANDLER_GENERATION = "research-handlers.exploratory.v5";
/** New explicit InquiryProtocol/obligation runs include managed semantic retrieval. */
export const SERVER_OWNED_PROTOCOL_HANDLER_GENERATION = SEMANTIC_PROTOCOL_HANDLER_GENERATION;
export type SemanticResearchHandlerGeneration =
  typeof SERVER_OWNED_FREEZE_HANDLER_GENERATION | typeof SERVER_OWNED_SEMANTIC_HANDLER_GENERATION |
  typeof SERVER_OWNED_LEGACY_PROTOCOL_HANDLER_GENERATION | typeof SERVER_OWNED_PROTOCOL_HANDLER_GENERATION;
export function isSemanticResearchHandlerGeneration(generation: unknown): generation is SemanticResearchHandlerGeneration {
  return generation === SERVER_OWNED_FREEZE_HANDLER_GENERATION ||
    generation === SERVER_OWNED_SEMANTIC_HANDLER_GENERATION ||
    generation === SERVER_OWNED_LEGACY_PROTOCOL_HANDLER_GENERATION || generation === SERVER_OWNED_PROTOCOL_HANDLER_GENERATION;
}
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
      readonly environment?: Pick<Env, "CORE_DB" | "SEARCH_DB" | "WORK_BUCKET" | "EVIDENCE_BUCKET"> & Partial<Pick<Env, "AI_SEARCH">>;
      readonly generation?: typeof SERVER_OWNED_RESEARCH_HANDLER_GENERATION | typeof SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION | SemanticResearchHandlerGeneration;
      readonly retrieval?: Omit<RetrieveBranchesStageDependencies, "navigation" | "ledger" | "profile">;
      readonly freeze?: EvidenceFreezeCompositionDependencies;
      readonly synthesis?: Parameters<typeof createEvidenceFreezeSynthesisHandler>[0];
      readonly materialize?: ResearchMaterializeStageDependencies;
      readonly report_materialize?: ResearchReportMaterializeStageDependencies;
      /** Server-composed finalizer that carries the committed coverage into the saved report. */
      readonly materialize_handler?: WorkflowStageHandler;
      readonly verification?: ResearchVerificationStageDependencies;
      /** Explicit Stage14 server-owned audit wiring; no default verifier is inferred. */
      readonly audit_claims?: ResearchClaimAuditStageDependencies;
      /** Explicit Stage15 server-owned citation wiring; no default resolver is inferred. */
      readonly resolve_citations?: ResearchCitationsStageDependencies;
      /** Server-composed deterministic coverage calculation over the frozen sources. */
      readonly calculate_coverage?: WorkflowStageHandler;
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
      evidence_bucket: mode.environment.EVIDENCE_BUCKET, ai_search: mode.environment.AI_SEARCH, access: mode.navigation.access }
    : mode.kind === "server-owned-exploratory" ? mode.retrieval : undefined;
  let retrievalHandler: WorkflowStageHandler | undefined;
  if (mode.kind === "server-owned-exploratory" &&
      (mode.generation === SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION || isSemanticResearchHandlerGeneration(mode.generation)) && retrieval !== undefined) {
    const { navigation, ledger } = mode;
    retrievalHandler = async (input) => {
      let profile;
      try {
        profile = await createD1ScopeProfilePort(retrieval.database).loadBinding(navigation.scope);
      } catch {
        fail("WORKFLOW_AUTHORITY_STALE");
      }
      try { requireOwnerScopeProfile(profile, navigation.scope); }
      catch { fail("WORKFLOW_AUTHORITY_STALE"); }
      return createRetrieveBranchesStageHandler({ ...retrieval, navigation, ledger, profile })(input);
    };
  }
  const freezeComposition = mode.kind === "server-owned-exploratory" &&
    isSemanticResearchHandlerGeneration(mode.generation) && mode.freeze !== undefined
    ? createEvidenceFreezeComposition(mode.freeze)
    : undefined;
  let materializeHandler: WorkflowStageHandler | undefined;
  if (mode.kind === "server-owned-exploratory" && isSemanticResearchHandlerGeneration(mode.generation)) {
    const materializerCount = [mode.materialize, mode.report_materialize, mode.materialize_handler]
      .filter((value) => value !== undefined).length;
    if (materializerCount === 1 && mode.materialize_handler !== undefined) {
      materializeHandler = mode.materialize_handler;
    } else if (materializerCount === 1 && mode.report_materialize !== undefined) {
      materializeHandler = createResearchReportMaterializeStageHandler(mode.report_materialize);
    } else if (materializerCount === 1 && mode.materialize !== undefined) {
      materializeHandler = createResearchMaterializeStageHandler(mode.materialize);
    }
  }

  const explicitSemantic = mode.kind === "server-owned-exploratory" &&
    isSemanticResearchHandlerGeneration(mode.generation);
  let synthesisAdapter: ReturnType<typeof createEvidenceFreezeSynthesisHandler> | undefined;
  let verificationHandler: ReturnType<typeof createResearchVerificationStageHandler> | undefined;
  let auditAdapter: ReturnType<typeof createResearchClaimAuditStageHandler> | undefined;
  let citationsAdapter: ReturnType<typeof createResearchCitationsStageHandler> | undefined;
  let materializeRecovery: WorkflowStartedAttemptRecovery | undefined;
  if (explicitSemantic && materializeHandler !== undefined && mode.kind === "server-owned-exploratory" && mode.environment !== undefined) {
    materializeRecovery = createResearchMaterializeRecovery({
      database: mode.environment.CORE_DB,
      work_bucket: mode.environment.WORK_BUCKET,
      navigation: mode.navigation,
      materialize_handler_generation: mode.generation ?? SERVER_OWNED_FREEZE_HANDLER_GENERATION,
    });
  }
  function getSynthesisAdapter(): ReturnType<typeof createEvidenceFreezeSynthesisHandler> | undefined {
    if (mode.kind !== "server-owned-exploratory" ||
        !isSemanticResearchHandlerGeneration(mode.generation) || mode.synthesis === undefined) return undefined;
    synthesisAdapter ??= createEvidenceFreezeSynthesisHandler(mode.synthesis);
    return synthesisAdapter;
  }
  function getVerificationHandler(): ReturnType<typeof createResearchVerificationStageHandler> | undefined {
    if (mode.kind !== "server-owned-exploratory" ||
        !isSemanticResearchHandlerGeneration(mode.generation) || mode.verification === undefined) return undefined;
    verificationHandler ??= createResearchVerificationStageHandler(mode.verification);
    return verificationHandler;
  }
  function getAuditAdapter(): ReturnType<typeof createResearchClaimAuditStageHandler> | undefined {
    if (mode.kind !== "server-owned-exploratory" ||
        !isSemanticResearchHandlerGeneration(mode.generation) || mode.audit_claims === undefined) return undefined;
    auditAdapter ??= createResearchClaimAuditStageHandler(mode.audit_claims);
    return auditAdapter;
  }
  function getCitationsAdapter(): ReturnType<typeof createResearchCitationsStageHandler> | undefined {
    if (mode.kind !== "server-owned-exploratory" ||
        !isSemanticResearchHandlerGeneration(mode.generation) || mode.resolve_citations === undefined) return undefined;
    citationsAdapter ??= createResearchCitationsStageHandler(mode.resolve_citations);
    return citationsAdapter;
  }

  const factory = ((stage) => {
    if (stage === "FREEZE_PROTOCOL_AND_SCOPE" && protocolScopeHandler !== undefined) {
      return protocolScopeHandler;
    }
    if (stage === "RETRIEVE_BRANCHES" && mode.kind === "server-owned-exploratory" &&
        (mode.generation === SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION || isSemanticResearchHandlerGeneration(mode.generation))) {
      if (retrievalHandler === undefined) return async () => fail("WORKFLOW_AUTHORITY_STALE");
      return retrievalHandler;
    }
    if ((stage === "RECONCILE" || stage === "FREEZE_EVIDENCE") && freezeComposition !== undefined) {
      return stage === "RECONCILE" ? freezeComposition.reconcile : freezeComposition.freeze;
    }
    if (mode.kind === "server-owned-exploratory" && isSemanticResearchHandlerGeneration(mode.generation) &&
        (stage === "RECONCILE" || stage === "FREEZE_EVIDENCE")) {
      return async () => fail("WORKFLOW_AUTHORITY_STALE");
    }
    if (stage === "SYNTHESIZE" && mode.kind === "server-owned-exploratory" && isSemanticResearchHandlerGeneration(mode.generation)) {
      const adapter = getSynthesisAdapter();
      return adapter === undefined ? async () => fail("WORKFLOW_AUTHORITY_STALE") : adapter.handler;
    }
    if (stage === "VERIFY" && mode.kind === "server-owned-exploratory" && isSemanticResearchHandlerGeneration(mode.generation)) {
      return getVerificationHandler() ?? (async () => fail("WORKFLOW_AUTHORITY_STALE"));
    }
    if (stage === "AUDIT_CLAIMS" && mode.kind === "server-owned-exploratory" && isSemanticResearchHandlerGeneration(mode.generation)) {
      const adapter = getAuditAdapter();
      return adapter === undefined ? async () => fail("WORKFLOW_AUTHORITY_STALE") : adapter.handler;
    }
    if (stage === "RESOLVE_CITATIONS" && mode.kind === "server-owned-exploratory" && isSemanticResearchHandlerGeneration(mode.generation)) {
      const adapter = getCitationsAdapter();
      return adapter === undefined ? async () => fail("WORKFLOW_AUTHORITY_STALE") : adapter;
    }
    if (stage === "CALCULATE_COVERAGE" && mode.kind === "server-owned-exploratory" && isSemanticResearchHandlerGeneration(mode.generation)) {
      return mode.calculate_coverage ?? (async () => fail("WORKFLOW_AUTHORITY_STALE"));
    }
    if (stage === "MATERIALIZE" && mode.kind === "server-owned-exploratory" && isSemanticResearchHandlerGeneration(mode.generation)) {
      return materializeHandler === undefined ? async () => fail("WORKFLOW_AUTHORITY_STALE") : materializeHandler;
    }
    return ({ request, input_bytes, attempt_ref }) =>
      deterministicWorkflowStageBytes(request.operation_id, request.stage, input_bytes, attempt_ref);
  }) as ResearchStageHandlerFactory;

  if (explicitSemantic) {
    const recoverStartedAttempt: WorkflowStartedAttemptRecovery = async (input) => {
      if (input.request.handler_generation !== mode.generation) return null;
      if (input.request.stage === "SYNTHESIZE") return getSynthesisAdapter()?.recoverStartedAttempt(input) ?? null;
      if (input.request.stage === "VERIFY") {
        const handler = getVerificationHandler();
        if (handler === undefined || mode.kind !== "server-owned-exploratory" || mode.environment === undefined) return null;
        const inputBytes = await readWorkflowObject(mode.environment.WORK_BUCKET, input.request.input_manifest, true);
        return handler({
          request: input.request,
          principal: { principal_ref: input.principal_ref, credential_generation: input.credential_generation,
            deployment_generation: input.deployment_generation },
          input_bytes: inputBytes, attempt_ref: input.attempt_ref, budget_receipt_ref: input.budget_receipt_ref,
        });
      }
      if (input.request.stage === "AUDIT_CLAIMS") return getAuditAdapter()?.recoverStartedAttempt(input) ?? null;
      if (input.request.stage === "RESOLVE_CITATIONS") return getCitationsAdapter()?.recoverStartedAttempt(input) ?? null;
      if (input.request.stage === "MATERIALIZE") return materializeRecovery?.(input) ?? null;
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
