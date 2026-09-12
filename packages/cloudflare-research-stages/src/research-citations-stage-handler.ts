import {
  createEvidenceFreezePostSynthesisContextReader,
  type EvidenceFreezeCommittedReaders,
  type EvidenceFreezeSynthesisReaderEnvironment,
} from "@eliotr/cloudflare-research";
import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import {
  fail,
  type WorkflowAttemptRecoveryInput,
  type WorkflowStageHandler,
  type WorkflowStartedAttemptRecovery,
} from "@eliotr/cloudflare-workflows";
import {
  executeResearchCitationsStage,
  recoverResearchCitationsStage,
  type ResearchCitationsStageDependencies,
} from "./research-citations-stage-execution.js";

export type {
  ResearchCitationsStageDependencies,
  ResearchCitationsStageRecoveryOptions,
} from "./research-citations-stage-execution.js";

export type ResearchCitationsStageHandler = WorkflowStageHandler & {
  readonly recoverStartedAttempt: WorkflowStartedAttemptRecovery;
};

function validateDependencies(dependencies: ResearchCitationsStageDependencies): void {
  if (dependencies === null || typeof dependencies !== "object" ||
      typeof dependencies.database?.prepare !== "function" ||
      typeof dependencies.navigation?.current !== "function" ||
      typeof dependencies.navigation?.sources !== "function" ||
      typeof dependencies.evidence_resolver?.resolveCitationSet !== "function" ||
      typeof dependencies.context?.read !== "function" ||
      (dependencies.recovery !== undefined &&
        (dependencies.recovery === null || typeof dependencies.recovery !== "object" ||
          typeof dependencies.recovery.work_bucket?.get !== "function" ||
          typeof dependencies.recovery.evidence_content?.materialize !== "function"))) {
    fail("WORKFLOW_INPUT_INVALID");
  }
}

/** Resolve the exact Stage14 audited handle union under the current frozen authority. */
export function createResearchCitationsStageHandler(
  dependencies: ResearchCitationsStageDependencies,
): ResearchCitationsStageHandler {
  validateDependencies(dependencies);
  const handler = ((rawInput: Parameters<WorkflowStageHandler>[0]) =>
    executeResearchCitationsStage(dependencies, rawInput)) as ResearchCitationsStageHandler;
  const recoverStartedAttempt: WorkflowStartedAttemptRecovery = (
    input: WorkflowAttemptRecoveryInput,
  ) => recoverResearchCitationsStage(dependencies, input);
  Object.defineProperty(handler, "recoverStartedAttempt", {
    configurable: false,
    enumerable: true,
    value: recoverStartedAttempt,
    writable: false,
  });
  return Object.freeze(handler);
}

/** Compose the handler with the canonical post-synthesis freeze reader. */
export function createResearchCitationsStageHandlerFromFreeze(
  environment: EvidenceFreezeSynthesisReaderEnvironment,
  navigation: NavigationReadAuthority,
  readers: EvidenceFreezeCommittedReaders,
  dependencies: Omit<ResearchCitationsStageDependencies, "context" | "navigation">,
): ResearchCitationsStageHandler {
  return createResearchCitationsStageHandler({
    ...dependencies,
    navigation,
    context: createEvidenceFreezePostSynthesisContextReader(environment, navigation, readers, "RESOLVE_CITATIONS"),
  });
}
