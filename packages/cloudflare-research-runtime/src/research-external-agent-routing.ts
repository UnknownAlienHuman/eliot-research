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
  readWorkflowObject,
} from "@eliotr/cloudflare-research";
import type { AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";
import type { InvestigationLedgerStore } from "@eliotr/research";
import type { ScopeProfileBinding } from "@eliotr/retrieval";
import { createEvidenceFreezeWorkflowReaders } from "./research-evidence-freeze-composition.js";
import {
  SERVER_OWNED_BRANCH_HANDLER_GENERATION,
  SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION,
  SERVER_OWNED_NATIVE_EXTERNAL_AGENT_HANDLER_GENERATION,
  type ResearchStageHandlerFactory,
} from "./research-stage-handlers.js";

export interface ResearchExternalAgentRoutingBindingsV1 {
  readonly database: D1Database;
  readonly search_database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly evidence_bucket: R2Bucket;
  readonly ai_search?: AiSearchNamespaceLike;
}

export interface ResearchExternalAgentRoutingInputV1 {
  readonly base: ResearchStageHandlerFactory;
  readonly generation: string;
  readonly bindings: ResearchExternalAgentRoutingBindingsV1;
  readonly navigation: NavigationReadAuthority;
  readonly ledger: Pick<InvestigationLedgerStore, "read">;
  readonly retrieval_profile: ScopeProfileBinding;
  readonly grant?: ProjectClientGrant | undefined;
  readonly now?: () => number;
  /** Core-backed exact persisted route-binding read; it retains route error mapping. */
  readonly require_route_binding: (
    operation_id: string,
    exact_grant: ProjectClientGrant,
  ) => Promise<void>;
}

function externalGeneration(value: string): boolean {
  return value === SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION ||
    value === SERVER_OWNED_NATIVE_EXTERNAL_AGENT_HANDLER_GENERATION;
}

function selectedGeneration(value: string): boolean {
  return value === SERVER_OWNED_BRANCH_HANDLER_GENERATION ||
    externalGeneration(value);
}

/**
 * Replace only stages 7-9 for the exact persisted generation. All later semantic
 * stages remain owned by the already-composed model/evidence/report factory.
 *
 * The v7 branch generation is already composed with substantive role model
 * execution by the semantic factory; it is returned unchanged so the composed
 * branch execution dependencies (including the role model executor) survive.
 */
export function routeResearchComputerAgentStages(
  input: ResearchExternalAgentRoutingInputV1,
): ResearchStageHandlerFactory {
  if (!selectedGeneration(input.generation)) return input.base;
  if (input.generation === SERVER_OWNED_BRANCH_HANDLER_GENERATION) return input.base;
  const retrieve = {
    database: input.bindings.database,
    search_database: input.bindings.search_database,
    work_bucket: input.bindings.work_bucket,
    evidence_bucket: input.bindings.evidence_bucket,
    ...(input.bindings.ai_search === undefined ? {} : { ai_search: input.bindings.ai_search }),
    access: input.navigation.access,
    profile: input.retrieval_profile,
  };
  const readers = createEvidenceFreezeWorkflowReaders({
    database: input.bindings.database,
    work_bucket: input.bindings.work_bucket,
    retrieve,
  }, input.navigation, input.ledger);
  const branchDependencies = {
    database: input.bindings.database,
    work_bucket: input.bindings.work_bucket,
    navigation: input.navigation,
    ledger: input.ledger,
    read_stage_five: readers.read_stage_five,
  };
  const branches = createResearchBranchExecutionHandlers(branchDependencies);
  let external: ReturnType<typeof createResearchExternalBranchAnalysisHandlers> | undefined;
  if (externalGeneration(input.generation)) {
    const grant = input.grant;
    if (grant === undefined || grant.grantee.subject !== input.navigation.access.principal_ref ||
        grant.revision < 1 || grant.state !== "ACTIVE" || !grant.allowed_operations.includes("run") ||
        !grant.allowed_operations.includes("recover") || !grant.allowed_operations.includes("evidence")) {
      fail("WORKFLOW_AUTHORITY_STALE");
    }
    const authority = createD1EvidenceAuthorityPort({
      core_database: input.bindings.database,
      search_database: input.bindings.search_database,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    const content = createR2EvidenceContentPort({ evidence_bucket: input.bindings.evidence_bucket });
    const resolver = createCloudflareEvidenceResolver({
      authority,
      content,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    external = createResearchExternalBranchAnalysisHandlers({
      ...branchDependencies,
      resolver,
      grant,
      require_route_binding: input.require_route_binding,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  }

  const factory = ((stage) => {
    if (stage === "READ_AND_EXTRACT") return branches.read_and_extract;
    if (stage === "ANALYZE_BRANCHES") {
      if (input.generation === SERVER_OWNED_NATIVE_EXTERNAL_AGENT_HANDLER_GENERATION) return async () => fail("WORKFLOW_CONFIGURATION_MISSING");
      return input.generation === SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION
        ? external?.handler ?? (async () => fail("WORKFLOW_AUTHORITY_STALE"))
        : branches.analyze_branches;
    }
    if (stage === "COUNTER_SEARCH") return branches.counter_search;
    return input.base(stage);
  }) as ResearchStageHandlerFactory;

  const readRecordedResult = async (attempt: Parameters<WorkflowStartedAttemptRecovery>[0], expectedDigest?: string) => {
    if (attempt.request.handler_generation !== input.generation || attempt.request.stage !== "ANALYZE_BRANCHES") {
      return fail("WORKFLOW_AUTHORITY_STALE");
    }
    if (external === undefined) return fail("WORKFLOW_CONFIGURATION_MISSING");
    const bytes = await readWorkflowObject(input.bindings.work_bucket, attempt.request.input_manifest, true);
    return external.readRecordedResult({
      request: attempt.request,
      principal: { principal_ref: attempt.principal_ref, credential_generation: attempt.credential_generation,
        deployment_generation: attempt.deployment_generation },
      input_bytes: bytes, attempt_ref: attempt.attempt_ref, request_sha256: attempt.request_sha256,
    }, expectedDigest);
  };
  Object.defineProperty(factory, "native", { value: input.base.native, enumerable: true });
  if (input.generation === SERVER_OWNED_NATIVE_EXTERNAL_AGENT_HANDLER_GENERATION) {
    if (external === undefined) return fail("WORKFLOW_CONFIGURATION_MISSING");
    Object.defineProperty(factory, "external_task", {
      value: Object.freeze({ prepare_task: external.prepareTask, read_recorded_result: readRecordedResult }),
      enumerable: true,
    });
  }

  const recoverStartedAttempt: WorkflowStartedAttemptRecovery = async (attempt) => {
    if (attempt.request.handler_generation !== input.generation) return null;
    if (attempt.request.stage === "ANALYZE_BRANCHES" &&
        input.generation === SERVER_OWNED_NATIVE_EXTERNAL_AGENT_HANDLER_GENERATION) return readRecordedResult(attempt);
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
