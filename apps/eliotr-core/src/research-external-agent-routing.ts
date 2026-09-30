import {
  createCloudflareEvidenceResolver,
  createD1EvidenceAuthorityPort,
  createR2EvidenceContentPort,
  type NavigationReadAuthority,
} from "@eliotr/cloudflare-evidence";
import type { ProjectClientGrant } from "@eliotr/contracts";
import {
  createResearchBranchExecutionHandlers,
  createResearchExternalBranchAnalysisHandlers,
  fail,
  type WorkflowStartedAttemptRecovery,
} from "@eliotr/cloudflare-research";
import type { InvestigationLedgerStore } from "@eliotr/research";
import type { ScopeProfileBinding } from "@eliotr/retrieval";
import { createEvidenceFreezeWorkflowReaders } from "./research-evidence-freeze-composition.js";
import {
  SERVER_OWNED_BRANCH_HANDLER_GENERATION,
  SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION,
  type ResearchStageHandlerFactory,
} from "./research-stage-handlers.js";
import type { Env } from "./env.js";

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

function selectedGeneration(value: string): boolean {
  return value === SERVER_OWNED_BRANCH_HANDLER_GENERATION ||
    value === SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION;
}

/**
 * Replace only stages 7-9 for the exact persisted generation. All later semantic
 * stages remain owned by the already-composed model/evidence/report factory.
 */
export function routeResearchComputerAgentStages(
  input: ResearchExternalAgentRoutingInput,
): ResearchStageHandlerFactory {
  if (!selectedGeneration(input.generation)) return input.base;
  const retrieve = {
    database: input.env.CORE_DB,
    search_database: input.env.SEARCH_DB,
    work_bucket: input.env.WORK_BUCKET,
    evidence_bucket: input.env.EVIDENCE_BUCKET,
    ...(input.env.AI_SEARCH === undefined ? {} : { ai_search: input.env.AI_SEARCH }),
    access: input.navigation.access,
    profile: input.retrieval_profile,
  };
  const readers = createEvidenceFreezeWorkflowReaders({
    database: input.env.CORE_DB,
    work_bucket: input.env.WORK_BUCKET,
    retrieve,
  }, input.navigation, input.ledger);
  const branchDependencies = {
    database: input.env.CORE_DB,
    work_bucket: input.env.WORK_BUCKET,
    navigation: input.navigation,
    ledger: input.ledger,
    read_stage_five: readers.read_stage_five,
  };
  const branches = createResearchBranchExecutionHandlers(branchDependencies);
  let external: ReturnType<typeof createResearchExternalBranchAnalysisHandlers> | undefined;
  if (input.generation === SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION) {
    const grant = input.grant;
    if (grant === undefined || grant.grantee.subject !== input.navigation.access.principal_ref ||
        grant.revision < 1 || grant.state !== "ACTIVE" || !grant.allowed_operations.includes("run") ||
        !grant.allowed_operations.includes("recover")) {
      fail("WORKFLOW_AUTHORITY_STALE");
    }
    const authority = createD1EvidenceAuthorityPort({
      core_database: input.env.CORE_DB,
      search_database: input.env.SEARCH_DB,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    const content = createR2EvidenceContentPort({ evidence_bucket: input.env.EVIDENCE_BUCKET });
    const resolver = createCloudflareEvidenceResolver({
      authority,
      content,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    external = createResearchExternalBranchAnalysisHandlers({
      ...branchDependencies,
      resolver,
      grant,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  }

  const factory = ((stage) => {
    if (stage === "READ_AND_EXTRACT") return branches.read_and_extract;
    if (stage === "ANALYZE_BRANCHES") {
      return input.generation === SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION
        ? external?.handler ?? (async () => fail("WORKFLOW_AUTHORITY_STALE"))
        : branches.analyze_branches;
    }
    if (stage === "COUNTER_SEARCH") return branches.counter_search;
    return input.base(stage);
  }) as ResearchStageHandlerFactory;

  const recoverStartedAttempt: WorkflowStartedAttemptRecovery = async (attempt) => {
    if (attempt.request.handler_generation !== input.generation) return null;
    if (attempt.request.stage === "ANALYZE_BRANCHES" &&
        input.generation === SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION) {
      return external?.recoverStartedAttempt(attempt) ?? null;
    }
    if (attempt.request.stage === "READ_AND_EXTRACT" || attempt.request.stage === "ANALYZE_BRANCHES" ||
        attempt.request.stage === "COUNTER_SEARCH") {
      return branches.recover(attempt.request.stage, attempt.request, {
        principal_ref: attempt.principal_ref,
        credential_generation: attempt.credential_generation,
        deployment_generation: attempt.deployment_generation,
      });
    }
    return input.base.recoverStartedAttempt?.(attempt) ?? null;
  };
  Object.defineProperty(factory, "recoverStartedAttempt", {
    configurable: false,
    enumerable: true,
    value: recoverStartedAttempt,
    writable: false,
  });
  return Object.freeze(factory);
}
