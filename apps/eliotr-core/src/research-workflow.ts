// IMPLEMENTED_NOT_LIVE: ER-09 monotone bounded Workflow executor over durable D1/R2 checkpoints; governed model/evidence handlers and live qualification remain separate.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { ResearchWorkflowStage, VersionedRef } from "@eliotr/contracts";
import { createD1EvidenceAuthorityPort, createNavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import {
  createWorkflowCheckpointExecutor,
} from "@eliotr/cloudflare-research";
import {
  createResearchWorkflowServerPorts,
  executeResearchWorkflowNativeSteps,
  parseResearchWorkflowParams,
  MAX_WORKFLOW_RECEIPT_BYTES,
  WorkflowCheckpointError,
  retainWorkflowFailure,
  workflowFailure,
  type ResearchWorkflowParams as PackageResearchWorkflowParams,
  type ResearchWorkflowRunParams as PackageResearchWorkflowRunParams,
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-workflows";
import { createD1ScopePorts } from "@eliotr/retrieval";
import { createD1InvestigationLedgerStore } from "@eliotr/research";
import type { LedgerD1Database } from "@eliotr/research";
import type { Env } from "./env.js";
import type { ExhaustiveQueryResult } from "@eliotr/interfaces";
import { createExhaustiveQueryService, parseExhaustiveQueryRequest, type ExhaustiveQueryRequest } from "./exhaustive-query-service.js";
import { validateExhaustiveWorkflowPayload } from "@eliotr/cloudflare-navigation";
import {
  createResearchStageHandlerFactory,
  SERVER_OWNED_RESEARCH_HANDLER_GENERATION,
  SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION,
  isSemanticResearchHandlerGeneration,
  type ResearchStageHandlerFactory,
} from "./research-stage-handlers.js";
import { createResearchSemanticServerHandlers } from "./research-semantic-server.js";
import {
  RESEARCH_QUALIFICATION_RENEWAL_MARKER,
  renewResearchQualifications,
  type ResearchQualificationRenewalMarker,
} from "./research-qualification-renewal.js";
import { isResearchModelStage, researchStageBudgetLeaseMs } from "./research-runtime-duration.js";
import { readD1BoundedResearchWorkflowLeaseExpiry } from "./research-workflow-budget.js";
import { loadResearchExecutionAccess, requireClientResearchExecution } from "./research-client-execution.js";
import { requireResearchDeploymentCompatibility } from "./research-deployment-compatibility.js";
import { readResearchRunConfiguration } from "./research-run-configuration.js";

export type ResearchWorkflowRunParams = PackageResearchWorkflowRunParams<ResearchQualificationRenewalMarker>;
export type ResearchWorkflowParams = PackageResearchWorkflowParams<ExhaustiveQueryRequest, ResearchQualificationRenewalMarker>;

export interface ResearchWorkflowResult {
  readonly operation_id: string;
  readonly investigation_ref: VersionedRef;
  readonly state: "ENGINE_COMPLETED";
  readonly receipt_refs: readonly string[];
  readonly output_manifest_ref: string;
}

function failWorkflow(code: string): never {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  throw error;
}

export class ResearchWorkflow extends WorkflowEntrypoint<Env, ResearchWorkflowParams> {
  public override async run(event: WorkflowEvent<ResearchWorkflowParams>, step: WorkflowStep): Promise<ResearchWorkflowResult | ExhaustiveQueryResult> {
    const params = parseResearchWorkflowParams(event.payload, {
      parse_exhaustive_request: parseExhaustiveQueryRequest,
      qualification_renewal_marker: RESEARCH_QUALIFICATION_RENEWAL_MARKER,
    });
    if (params.workflow_kind === "EXHAUSTIVE_QUERY") {
      if (params.deployment_generation !== this.env.DEPLOYMENT_GENERATION) {
        failWorkflow("WORKFLOW_AUTHORITY_STALE");
      }
      try {
        await validateExhaustiveWorkflowPayload(this.env.CORE_DB, params, this.env.DEPLOYMENT_GENERATION);
      } catch (error) {
        failWorkflow(error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "WORKFLOW_AUTHORITY_STALE");
      }
      const request = new Request("https://workflow.internal/api/v1/research/query", {
        method: "POST",
        headers: { "idempotency-key": params.idempotency_key },
      });
      const context = {
        request,
        principal_ref: params.principal_ref,
        client_class: "owner_pwa" as const,
        credential_generation: params.credential_generation,
        trace_id: `workflow-${params.operation_id}`,
      };
      const result = await step.do("q8-exhaustive-job", async () => {
        try {
          await validateExhaustiveWorkflowPayload(this.env.CORE_DB, params, this.env.DEPLOYMENT_GENERATION);
        } catch (error) {
          failWorkflow(error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "WORKFLOW_AUTHORITY_STALE");
        }
        const output = await createExhaustiveQueryService(this.env).query(context, params.exhaustive_request);
        // Workflow step results are durable payloads. Keep the Q8 receipt under
        // the same canonical envelope limit as every ER09 checkpoint result.
        if (new TextEncoder().encode(JSON.stringify(output)).byteLength > MAX_WORKFLOW_RECEIPT_BYTES) {
          failWorkflow("WORKFLOW_INPUT_INVALID");
        }
        return output;
      });
      return result;
    }
    const principal: WorkflowPrincipal = {
      principal_ref: params.principal_ref,
      credential_generation: params.credential_generation,
      deployment_generation: params.deployment_generation,
    };
    let activeStage: ResearchWorkflowStage | undefined;
    let nativeStepPending = false;
    try {
      await requireResearchDeploymentCompatibility(this.env.CORE_DB, params.deployment_generation, this.env.DEPLOYMENT_GENERATION);
      const ledger = createD1InvestigationLedgerStore(this.env.CORE_DB as unknown as LedgerD1Database);
      const investigation = await ledger.read(params.investigation_ref.id);
      if (investigation === null || investigation.head.principal_ref !== principal.principal_ref ||
          investigation.head.deployment_generation !== principal.deployment_generation) {
        failWorkflow("WORKFLOW_AUTHORITY_STALE");
      }
      const lane = investigation.head.lane;
      const semanticOwned = isSemanticResearchHandlerGeneration(params.handler_generation);
      const serverOwned = semanticOwned || params.handler_generation === SERVER_OWNED_RESEARCH_HANDLER_GENERATION || params.handler_generation === SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION;
      const retrievalOwned = params.handler_generation === SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION;
      let handlers: ResearchStageHandlerFactory;
      if (lane === "confirmatory") {
        if (serverOwned) failWorkflow("WORKFLOW_AUTHORITY_STALE");
        handlers = createResearchStageHandlerFactory({ kind: "legacy-deterministic" });
      } else if (lane === "exploratory") {
        if (!serverOwned) failWorkflow("WORKFLOW_AUTHORITY_STALE");
        const evidence = createD1EvidenceAuthorityPort({
          core_database: this.env.CORE_DB,
          search_database: this.env.SEARCH_DB,
        });
        const scopeAuthority = await evidence.loadScope({
          id: investigation.head.scope_snapshot_id,
          revision: investigation.head.scope_snapshot_revision,
        });
        if (scopeAuthority === null) failWorkflow("WORKFLOW_AUTHORITY_STALE");
        const access = await loadResearchExecutionAccess(this.env, params.operation_id, principal);
        const scopePorts = createD1ScopePorts(this.env.CORE_DB, access);
        const navigation = createNavigationReadAuthority({
          database: this.env.CORE_DB,
          scope_snapshot: scopeAuthority.snapshot,
          access,
          require_current: async (scope) => {
            await scopePorts.requireCurrentScope(scope);
            if (access.client_class !== "owner_pwa") await requireClientResearchExecution(this.env, access, scope,
              params.operation_id, principal.deployment_generation);
            return scope;
          },
        });
        if (params.qualification_renewal !== undefined && (!semanticOwned || access.client_class !== "owner_pwa")) {
          failWorkflow("WORKFLOW_AUTHORITY_STALE");
        }
        if (semanticOwned && params.qualification_renewal === RESEARCH_QUALIFICATION_RENEWAL_MARKER) {
          const runConfiguration = await readResearchRunConfiguration(this.env, {
            operation_id: params.operation_id,
            investigation_id: params.investigation_ref.id,
            principal_ref: principal.principal_ref,
            deployment_generation: principal.deployment_generation,
          });
          if (runConfiguration.mode === "legacy-installed") {
            nativeStepPending = true;
            await step.do("research-qualification-renewal", {
              retries: { limit: 0, delay: 0 },
              timeout: 600_000,
            }, async () => {
              try {
                await renewResearchQualifications(this.env, {
                  operation_id: params.operation_id,
                  investigation,
                  principal,
                  navigation,
                  initial_manifest: params.initial_input_manifest,
                });
              } catch (error) {
                const failure = workflowFailure(error, "PREPARATION");
                await retainWorkflowFailure(this.env.CORE_DB, params.operation_id, principal, failure);
                throw new WorkflowCheckpointError("WORKFLOW_PREPARATION_FAILED", failure);
              }
              return { protocol: "eliotr.research-qualification-renewal.v1", state: "CURRENT" as const };
            });
            nativeStepPending = false;
          }
        }
        handlers = semanticOwned
          ? await createResearchSemanticServerHandlers({ env: this.env, operation_id: params.operation_id,
            investigation_id: params.investigation_ref.id, principal, navigation, ledger,
            initial_manifest: params.initial_input_manifest })
          : createResearchStageHandlerFactory({
          kind: "server-owned-exploratory",
          generation: retrievalOwned ? SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION : SERVER_OWNED_RESEARCH_HANDLER_GENERATION,
          navigation, ledger,
          environment: this.env,
        });
      } else {
        failWorkflow("WORKFLOW_AUTHORITY_STALE");
      }
      const ports = createResearchWorkflowServerPorts({
        database: this.env.CORE_DB,
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
      const executor = createWorkflowCheckpointExecutor(this.env.CORE_DB, this.env.WORK_BUCKET, ports);
      const result: ResearchWorkflowResult = await executeResearchWorkflowNativeSteps({
        step,
        database: this.env.CORE_DB,
        params: {
          operation_id: params.operation_id,
          investigation_ref: params.investigation_ref,
          idempotency_key: params.idempotency_key,
          handler_generation: params.handler_generation,
          initial_input_manifest: params.initial_input_manifest,
        },
        principal,
        execute_checkpoint: (request, runPrincipal) =>
          executor.execute(request, runPrincipal, handlers(request.stage)),
        stage_timeout_ms: (stage) => isResearchModelStage(stage) ? researchStageBudgetLeaseMs(stage) : undefined,
        set_active_stage: (stage) => { activeStage = stage; },
        set_step_pending: (pending) => { nativeStepPending = pending; },
        invalid_receipt: () => failWorkflow("WORKFLOW_OUTPUT_CORRUPT"),
        non_retryable_output_corrupt: (code) => {
          throw new NonRetryableError(code, "WorkflowCheckpointError");
        },
      });
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_WORKFLOW_RECEIPT_BYTES) {
        failWorkflow("WORKFLOW_INPUT_INVALID");
      }
      return result;
    } catch (error) {
      const failure = workflowFailure(error, activeStage === undefined ? "PREPARATION" : "STAGE", activeStage);
      // step.do can reconstruct Error and discard custom fields. The callback has
      // already recorded the exact cause; do not replace it with that generic wrapper.
      if (!nativeStepPending) await retainWorkflowFailure(this.env.CORE_DB, params.operation_id, principal, failure);
      if (error instanceof NonRetryableError && error.message === "WORKFLOW_OUTPUT_CORRUPT") throw error;
      if (error instanceof WorkflowCheckpointError && error.code === "WORKFLOW_OUTPUT_CORRUPT") {
        throw new NonRetryableError(error.code, "WorkflowCheckpointError");
      }
      // Native status must never contain an arbitrary provider or runtime error message.
      throw new WorkflowCheckpointError(error instanceof WorkflowCheckpointError ? error.code :
        activeStage === undefined ? "WORKFLOW_PREPARATION_FAILED" : "WORKFLOW_EFFECT_UNCERTAIN", failure);
    }
  }
}
