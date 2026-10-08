// IMPLEMENTED_NOT_LIVE: ER-09 monotone bounded Workflow executor over durable D1/R2 checkpoints; governed model/evidence handlers and live qualification remain separate.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { VersionedRef } from "@eliotr/contracts";
import {
  MAX_WORKFLOW_RECEIPT_BYTES,
  parseResearchWorkflowParams,
  type ResearchWorkflowParams as PackageResearchWorkflowParams,
  type ResearchWorkflowRunParams as PackageResearchWorkflowRunParams,
} from "@eliotr/cloudflare-workflows";
import type { Env } from "./env.js";
import type { ExhaustiveQueryResult } from "@eliotr/interfaces";
import { createExhaustiveQueryService, parseExhaustiveQueryRequest, type ExhaustiveQueryRequest } from "./exhaustive-query-service.js";
import { validateExhaustiveWorkflowPayload } from "@eliotr/cloudflare-navigation";
import { createResearchSemanticServerHandlers } from "./research-semantic-server.js";
import {
  RESEARCH_QUALIFICATION_RENEWAL_MARKER,
  renewResearchQualifications,
  type ResearchQualificationRenewalMarker,
} from "./research-qualification-renewal.js";
import { loadResearchExecutionAccess, requireClientResearchExecution } from "./research-client-execution.js";
import { requireResearchDeploymentCompatibility } from "./research-deployment-compatibility.js";
import { readResearchRunConfiguration } from "./research-run-configuration.js";
import { executeResearchWorkflowApplication } from "@eliotr/cloudflare-research-runtime/research-workflow-application.js";

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
    return executeResearchWorkflowApplication({
      environment: {
        CORE_DB: this.env.CORE_DB,
        SEARCH_DB: this.env.SEARCH_DB,
        WORK_BUCKET: this.env.WORK_BUCKET,
        EVIDENCE_BUCKET: this.env.EVIDENCE_BUCKET,
        ...(this.env.AI_SEARCH === undefined ? {} : { AI_SEARCH: this.env.AI_SEARCH }),
      },
      params,
      qualification_renewal_marker: RESEARCH_QUALIFICATION_RENEWAL_MARKER,
      step,
      callbacks: {
        assert_deployment_compatible: () => requireResearchDeploymentCompatibility(
          this.env.CORE_DB, params.deployment_generation, this.env.DEPLOYMENT_GENERATION),
        load_execution_access: (operation_id, principal) => loadResearchExecutionAccess(this.env, operation_id, principal),
        require_client_execution: ({ access, scope, operation_id, deployment_generation }) =>
          requireClientResearchExecution(this.env, access, scope, operation_id, deployment_generation),
        read_semantic_configuration_mode: async ({ params: runParams, principal }) => {
          const configuration = await readResearchRunConfiguration(this.env, {
            operation_id: runParams.operation_id,
            investigation_id: runParams.investigation_ref.id,
            principal_ref: principal.principal_ref,
            deployment_generation: principal.deployment_generation,
          });
          return configuration.mode;
        },
        renew_qualifications: ({ operation_id, investigation, principal, navigation, initial_manifest }) =>
          renewResearchQualifications(this.env, {
            operation_id, investigation, principal, navigation, initial_manifest,
          }),
        create_semantic_handlers: ({ operation_id, investigation_id, principal, navigation, ledger, initial_manifest }) =>
          createResearchSemanticServerHandlers({
            env: this.env, operation_id, investigation_id, principal, navigation, ledger,
            initial_manifest,
          }),
        is_native_non_retryable_output_corrupt: (error) =>
          error instanceof NonRetryableError && error.message === "WORKFLOW_OUTPUT_CORRUPT",
        throw_native_non_retryable_output_corrupt: (code) => {
          throw new NonRetryableError(code, "WorkflowCheckpointError");
        },
      },
    });
  }
}
