import type { WorkflowStep } from "cloudflare:workers";
import type { EvidenceAccessContext, NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import { createD1EvidenceAuthorityPort, createNavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { ResearchWorkflowStage, ScopeSnapshot } from "@eliotr/contracts";
import { createWorkflowCheckpointExecutor } from "@eliotr/cloudflare-research";
import {
  createResearchWorkflowServerPorts,
  createNativeExternalTaskServerPorts,
  NATIVE_EXTERNAL_TASK_HANDLER_GENERATION,
  executeResearchWorkflowNativeSteps,
  MAX_WORKFLOW_RECEIPT_BYTES,
  parseWorkflowCheckpointErrorMessage,
  retainWorkflowFailure,
  WorkflowCheckpointError,
  workflowFailure,
  type WorkflowFailureOutcome,
  type ResearchWorkflowRunParams,
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-workflows";
import { createD1ScopePorts } from "@eliotr/retrieval";
import {
  createD1InvestigationLedgerStore,
  type InvestigationLedgerStore,
  type LedgerD1Database,
} from "@eliotr/research";
import type { ResearchWorkflowSequenceResult } from "@eliotr/cloudflare-workflows";
import { readD1BoundedResearchWorkflowLeaseExpiry } from "./research-workflow-budget.js";
import { isResearchModelStage, researchStageBudgetLeaseMs } from "./research-runtime-duration.js";
import {
  createResearchStageHandlerFactory,
  isSemanticResearchHandlerGeneration,
  SERVER_OWNED_RESEARCH_HANDLER_GENERATION,
  SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION,
  type ResearchStageHandlerEnvironment,
  type ResearchStageHandlerFactory,
} from "./research-stage-handlers.js";

type ResearchWorkflowInvestigation = NonNullable<Awaited<ReturnType<InvestigationLedgerStore["read"]>>>;
type ResearchWorkflowScopeRef = Pick<ScopeSnapshot, "snapshot_id" | "revision">;
type ResearchWorkflowConfigurationMode = "legacy-installed" | "snapshot-v1" | "snapshot-v2";

export interface ResearchWorkflowApplicationCallbacks<QualificationRenewalMarker extends string> {
  readonly assert_deployment_compatible: () => Promise<unknown>;
  readonly load_execution_access: (
    operation_id: string,
    principal: WorkflowPrincipal,
  ) => Promise<EvidenceAccessContext>;
  readonly require_client_execution: (input: Readonly<{
    access: EvidenceAccessContext;
    scope: ResearchWorkflowScopeRef;
    operation_id: string;
    deployment_generation: string;
  }>) => Promise<unknown>;
  readonly read_semantic_configuration_mode: (input: Readonly<{
    params: ResearchWorkflowRunParams<QualificationRenewalMarker>;
    principal: WorkflowPrincipal;
  }>) => Promise<ResearchWorkflowConfigurationMode>;
  readonly renew_qualifications: (input: Readonly<{
    operation_id: string;
    investigation: ResearchWorkflowInvestigation;
    principal: WorkflowPrincipal;
    navigation: NavigationReadAuthority;
    initial_manifest: ResearchWorkflowRunParams<QualificationRenewalMarker>["initial_input_manifest"];
  }>) => Promise<void>;
  readonly create_semantic_handlers: (input: Readonly<{
    operation_id: string;
    investigation_id: string;
    principal: WorkflowPrincipal;
    navigation: NavigationReadAuthority;
    ledger: InvestigationLedgerStore;
    initial_manifest: ResearchWorkflowRunParams<QualificationRenewalMarker>["initial_input_manifest"];
  }>) => Promise<ResearchStageHandlerFactory>;
  readonly is_native_non_retryable_output_corrupt: (error: unknown) => boolean;
  readonly throw_native_non_retryable_output_corrupt: (code: "WORKFLOW_OUTPUT_CORRUPT") => never;
  readonly is_native_non_retryable_failure: (error: unknown) => boolean;
  readonly throw_native_non_retryable_failure: (code: WorkflowFailureOutcome["code"]) => never;
}

export interface ResearchWorkflowApplicationInput<QualificationRenewalMarker extends string> {
  readonly environment: ResearchStageHandlerEnvironment;
  readonly params: ResearchWorkflowRunParams<QualificationRenewalMarker>;
  readonly qualification_renewal_marker: QualificationRenewalMarker;
  readonly step: WorkflowStep;
  readonly callbacks: ResearchWorkflowApplicationCallbacks<QualificationRenewalMarker>;
}

function failWorkflow(code: string): never {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  throw error;
}

/** Accepts bounded diagnostics only from a native checkpoint error at a pending native step boundary. */
export function readNativeStepWorkflowFailure(error: unknown, nativeStepPending: boolean) {
  return nativeStepPending && error instanceof Error && error.name === "WorkflowCheckpointError"
    ? parseWorkflowCheckpointErrorMessage(error.message) : null;
}

/** Executes an already-admitted run; Core supplies only its Worker-bound authorities and semantic/config callbacks. */
export async function executeResearchWorkflowApplication<QualificationRenewalMarker extends string>(
  input: ResearchWorkflowApplicationInput<QualificationRenewalMarker>,
): Promise<ResearchWorkflowSequenceResult> {
  const { environment, params, step, callbacks } = input;
  const principal: WorkflowPrincipal = {
    principal_ref: params.principal_ref,
    credential_generation: params.credential_generation,
    deployment_generation: params.deployment_generation,
  };
  let activeStage: ResearchWorkflowStage | undefined;
  let nativeStepPending = false;
  try {
    await callbacks.assert_deployment_compatible();
    const database = environment.CORE_DB;
    const ledger = createD1InvestigationLedgerStore(database as unknown as LedgerD1Database);
    const investigation = await ledger.read(params.investigation_ref.id);
    if (investigation === null || investigation.head.principal_ref !== principal.principal_ref ||
        investigation.head.deployment_generation !== principal.deployment_generation) {
      failWorkflow("WORKFLOW_AUTHORITY_STALE");
    }
    const lane = investigation.head.lane;
    const semanticOwned = isSemanticResearchHandlerGeneration(params.handler_generation);
    const serverOwned = semanticOwned || params.handler_generation === SERVER_OWNED_RESEARCH_HANDLER_GENERATION ||
      params.handler_generation === SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION;
    const retrievalOwned = params.handler_generation === SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION;
    let handlers: ResearchStageHandlerFactory;
    if (lane === "confirmatory") {
      if (serverOwned) failWorkflow("WORKFLOW_AUTHORITY_STALE");
      handlers = createResearchStageHandlerFactory({ kind: "legacy-deterministic" });
    } else if (lane === "exploratory") {
      if (!serverOwned) failWorkflow("WORKFLOW_AUTHORITY_STALE");
      const evidence = createD1EvidenceAuthorityPort({
        core_database: environment.CORE_DB,
        search_database: environment.SEARCH_DB,
      });
      const scopeAuthority = await evidence.loadScope({
        id: investigation.head.scope_snapshot_id,
        revision: investigation.head.scope_snapshot_revision,
      });
      if (scopeAuthority === null) failWorkflow("WORKFLOW_AUTHORITY_STALE");
      const access = await callbacks.load_execution_access(params.operation_id, principal);
      const scopePorts = createD1ScopePorts(environment.CORE_DB, access);
      const navigation = createNavigationReadAuthority({
        database: environment.CORE_DB,
        scope_snapshot: scopeAuthority.snapshot,
        access,
        require_current: async (scope) => {
          await scopePorts.requireCurrentScope(scope);
          if (access.client_class !== "owner_pwa") {
            await callbacks.require_client_execution({
              access,
              scope,
              operation_id: params.operation_id,
              deployment_generation: principal.deployment_generation,
            });
          }
          return scope;
        },
      });
      if (params.qualification_renewal !== undefined &&
          (!semanticOwned || access.client_class !== "owner_pwa")) {
        failWorkflow("WORKFLOW_AUTHORITY_STALE");
      }
      if (semanticOwned && params.qualification_renewal === input.qualification_renewal_marker) {
        const configurationMode = await callbacks.read_semantic_configuration_mode({ params, principal });
        if (configurationMode === "legacy-installed") {
          nativeStepPending = true;
          await step.do("research-qualification-renewal", {
            retries: { limit: 0, delay: 0 },
            timeout: 600_000,
          }, async () => {
            try {
              await callbacks.renew_qualifications({
                operation_id: params.operation_id,
                investigation,
                principal,
                navigation,
                initial_manifest: params.initial_input_manifest,
              });
            } catch (error) {
              const failure = workflowFailure(error, "PREPARATION");
              await retainWorkflowFailure(environment.CORE_DB, params.operation_id, principal, failure);
              throw new WorkflowCheckpointError("WORKFLOW_PREPARATION_FAILED", failure);
            }
            return { protocol: "eliotr.research-qualification-renewal.v1", state: "CURRENT" as const };
          });
          nativeStepPending = false;
        }
      }
      handlers = semanticOwned
        ? await callbacks.create_semantic_handlers({
          operation_id: params.operation_id,
          investigation_id: params.investigation_ref.id,
          principal,
          navigation,
          ledger,
          initial_manifest: params.initial_input_manifest,
        })
        : createResearchStageHandlerFactory({
          kind: "server-owned-exploratory",
          generation: retrievalOwned ? SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION : SERVER_OWNED_RESEARCH_HANDLER_GENERATION,
          navigation,
          ledger,
          environment,
        });
    } else {
      failWorkflow("WORKFLOW_AUTHORITY_STALE");
    }

    const ports = createResearchWorkflowServerPorts({
      database,
      operation_id: params.operation_id,
      authorize_residency: async (request, authorizedPrincipal) => {
        if (request.input_manifest.residency.access_domain_id !== authorizedPrincipal.principal_ref) {
          failWorkflow("WORKFLOW_AUTHORITY_STALE");
        }
      },
      read_lease_expiry: readD1BoundedResearchWorkflowLeaseExpiry,
      ...(handlers.recoverStartedAttempt === undefined
        ? {}
        : { recover_started_attempt: handlers.recoverStartedAttempt }),
    });
    const executor = createWorkflowCheckpointExecutor(database, environment.WORK_BUCKET, ports);
    const externalTask = params.handler_generation === NATIVE_EXTERNAL_TASK_HANDLER_GENERATION
      ? handlers.external_task : undefined;
    if (params.handler_generation === NATIVE_EXTERNAL_TASK_HANDLER_GENERATION && externalTask === undefined) {
      failWorkflow("WORKFLOW_CONFIGURATION_MISSING");
    }
    const result = await executeResearchWorkflowNativeSteps({
      step,
      database,
      params: {
        operation_id: params.operation_id,
        investigation_ref: params.investigation_ref,
        idempotency_key: params.idempotency_key,
        handler_generation: params.handler_generation,
        initial_input_manifest: params.initial_input_manifest,
      },
      principal,
      ...(externalTask === undefined ? {} : { external_task: createNativeExternalTaskServerPorts({
        database, bucket: environment.WORK_BUCKET, ports, ...externalTask,
      }) }),
      execute_checkpoint: (request, runPrincipal) =>
        executor.execute(request, runPrincipal, handlers(request.stage)),
      native_handler: (stage) => handlers.native(stage),
      native_stage_policy: (request, runPrincipal) => executor.nativeStagePolicy(request, runPrincipal),
      execute_native: (request, runPrincipal, handler, policy) =>
        executor.executeNative(request, runPrincipal, handler, policy),
      stage_timeout_ms: (stage) => isResearchModelStage(stage) ? researchStageBudgetLeaseMs(stage) : undefined,
      set_active_stage: (stage) => { activeStage = stage; },
      set_step_pending: (pending) => { nativeStepPending = pending; },
      invalid_receipt: () => failWorkflow("WORKFLOW_OUTPUT_CORRUPT"),
      non_retryable_output_corrupt: callbacks.throw_native_non_retryable_output_corrupt,
      non_retryable_native_failure: callbacks.throw_native_non_retryable_failure,
    });
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_WORKFLOW_RECEIPT_BYTES) {
      failWorkflow("WORKFLOW_INPUT_INVALID");
    }
    return result;
  } catch (error) {
    const nativeFailureMessage = readNativeStepWorkflowFailure(error, nativeStepPending);
    const failure = nativeStepPending
      ? nativeFailureMessage?.failure
      : workflowFailure(error, activeStage === undefined ? "PREPARATION" : "STAGE", activeStage);
    // Rehydrate only the local bounded marker; a markerless native rejection has unknown phase and stage.
    if (!nativeStepPending && failure !== undefined) {
      await retainWorkflowFailure(environment.CORE_DB, params.operation_id, principal, failure);
    }
    if (callbacks.is_native_non_retryable_output_corrupt(error)) throw error;
    if (callbacks.is_native_non_retryable_failure(error)) throw error;
    if (error instanceof WorkflowCheckpointError && error.code === "WORKFLOW_OUTPUT_CORRUPT") {
      callbacks.throw_native_non_retryable_output_corrupt(error.code);
    }
    const outerCode = nativeFailureMessage?.outer_code ?? (error instanceof WorkflowCheckpointError ? error.code :
      activeStage === undefined ? "WORKFLOW_PREPARATION_FAILED" : "WORKFLOW_EFFECT_UNCERTAIN");
    throw new WorkflowCheckpointError(outerCode, failure);
  }
}
