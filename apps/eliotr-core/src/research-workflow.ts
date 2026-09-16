// IMPLEMENTED_NOT_LIVE: ER-09 monotone bounded Workflow executor over durable D1/R2 checkpoints; governed model/evidence handlers and live qualification remain separate.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import type { ResearchWorkflowStage, VersionedRef } from "@eliotr/contracts";
import { createD1EvidenceAuthorityPort, createNavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import {
  createWorkflowCheckpointExecutor, MAX_WORKFLOW_RECEIPT_BYTES, WorkflowObjectSchema,
  type StageReceipt, type WorkflowExecutionPorts, type WorkflowObject, type WorkflowPrincipal,
} from "@eliotr/cloudflare-research";
import { WorkflowCheckpointError, type WorkflowStartedAttemptRecovery } from "@eliotr/cloudflare-workflows";
import { createD1ScopePorts } from "@eliotr/retrieval";
import { createD1InvestigationLedgerStore } from "@eliotr/research";
import type { LedgerD1Database } from "@eliotr/research";
import type { Env } from "./env.js";
import type { ExhaustiveQueryResult } from "@eliotr/interfaces";
import { createExhaustiveQueryService, parseExhaustiveQueryRequest } from "./exhaustive-query-service.js";
import type { ExhaustiveWorkflowPayload } from "./exhaustive-workflow-service.js";
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

export interface ResearchWorkflowRunParams {
  readonly workflow_kind?: "RESEARCH";
  readonly operation_id: string;
  readonly investigation_ref: VersionedRef;
  readonly idempotency_key: string;
  readonly handler_generation: string;
  readonly initial_input_manifest: WorkflowObject;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly requested_by_principal_ref?: string;
  readonly qualification_renewal?: ResearchQualificationRenewalMarker;
}
export type ResearchWorkflowParams = ResearchWorkflowRunParams | ExhaustiveWorkflowPayload;

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

function parseParams(raw: unknown): ResearchWorkflowParams {
  if (typeof raw !== "object" || raw === null) failWorkflow("WORKFLOW_INPUT_INVALID");
  const value = raw as Record<string, unknown>;
  if (value.workflow_kind === "EXHAUSTIVE_QUERY") {
    const allowed = new Set(["workflow_kind", "operation_id", "idempotency_key", "principal_ref",
      "credential_generation", "deployment_generation", "exhaustive_request"]);
    if (Object.keys(value).some((key) => !allowed.has(key)) || Object.keys(value).length !== allowed.size) {
      failWorkflow("WORKFLOW_INPUT_INVALID");
    }
    const operation_id = value.operation_id;
    const idempotency_key = value.idempotency_key;
    const principal_ref = value.principal_ref;
    const credential_generation = value.credential_generation;
    const deployment_generation = value.deployment_generation;
    if (typeof operation_id !== "string" || operation_id.length < 1 || operation_id.length > 128 ||
        typeof idempotency_key !== "string" || idempotency_key.length < 1 || idempotency_key.length > 256 ||
        typeof principal_ref !== "string" || principal_ref.length < 1 ||
        typeof credential_generation !== "string" || credential_generation.length < 1 ||
        typeof deployment_generation !== "string" || deployment_generation.length < 1) {
      failWorkflow("WORKFLOW_INPUT_INVALID");
    }
    const exhaustive_request = parseExhaustiveQueryRequest(value.exhaustive_request);
    return { workflow_kind: "EXHAUSTIVE_QUERY", operation_id, idempotency_key, principal_ref,
      credential_generation, deployment_generation, exhaustive_request };
  }
  const operation_id = value.operation_id;
  const investigation_ref = value.investigation_ref as VersionedRef | undefined;
  const idempotency_key = value.idempotency_key;
  const handler_generation = value.handler_generation;
  const initial_input_manifest = value.initial_input_manifest;
  const principal_ref = value.principal_ref ?? value.requested_by_principal_ref;
  const credential_generation = value.credential_generation;
  const deployment_generation = value.deployment_generation;
  if (typeof operation_id !== "string" || operation_id.length < 1 || operation_id.length > 128) failWorkflow("WORKFLOW_INPUT_INVALID");
  if (typeof investigation_ref !== "object" || investigation_ref === null ||
      typeof (investigation_ref as VersionedRef).id !== "string" ||
      !Number.isSafeInteger((investigation_ref as VersionedRef).revision)) failWorkflow("WORKFLOW_INPUT_INVALID");
  if (typeof idempotency_key !== "string" || idempotency_key.length < 1 || idempotency_key.length > 256) failWorkflow("WORKFLOW_INPUT_INVALID");
  if (typeof handler_generation !== "string" || handler_generation.length < 1) failWorkflow("WORKFLOW_INPUT_INVALID");
  if (typeof principal_ref !== "string" || principal_ref.length < 1) failWorkflow("WORKFLOW_INPUT_INVALID");
  if (typeof credential_generation !== "string" || credential_generation.length < 1) failWorkflow("WORKFLOW_INPUT_INVALID");
  if (typeof deployment_generation !== "string" || deployment_generation.length < 1) failWorkflow("WORKFLOW_INPUT_INVALID");
  const manifest = WorkflowObjectSchema.safeParse(initial_input_manifest);
  if (!manifest.success) failWorkflow("WORKFLOW_INPUT_INVALID");
  const requested = value.requested_by_principal_ref;
  if (requested !== undefined && requested !== principal_ref) failWorkflow("WORKFLOW_CONFLICT");
  const qualificationRenewal = value.qualification_renewal;
  if (qualificationRenewal !== undefined && qualificationRenewal !== RESEARCH_QUALIFICATION_RENEWAL_MARKER) {
    failWorkflow("WORKFLOW_INPUT_INVALID");
  }
  const allowed = new Set(["operation_id", "investigation_ref", "idempotency_key", "handler_generation",
    "initial_input_manifest", "principal_ref", "credential_generation", "deployment_generation", "requested_by_principal_ref",
    "qualification_renewal"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) failWorkflow("WORKFLOW_INPUT_INVALID");
  }
  return {
    operation_id, investigation_ref: { ...(investigation_ref as VersionedRef) },
    idempotency_key: idempotency_key as string, handler_generation: handler_generation as string,
    initial_input_manifest: manifest.data as WorkflowObject,
    principal_ref: principal_ref as string, credential_generation: credential_generation as string,
    deployment_generation: deployment_generation as string,
    ...(value.requested_by_principal_ref === undefined ? {} : { requested_by_principal_ref: value.requested_by_principal_ref as string }),
    ...(qualificationRenewal === undefined ? {} : { qualification_renewal: qualificationRenewal }),
  };
}

function createServerPorts(
  database: D1Database,
  operationId: string,
  recoverStartedAttempt?: WorkflowStartedAttemptRecovery,
): WorkflowExecutionPorts {
  const grants = new Map<string, { receipt_ref: string; expires_at_ms: number }>();
  return {
    async authorizeResidency(request, principal): Promise<void> {
      if (request.operation_id !== operationId) failWorkflow("WORKFLOW_CONFLICT");
      if (request.input_manifest.residency.access_domain_id !== principal.principal_ref) failWorkflow("WORKFLOW_AUTHORITY_STALE");
    },
    async checkBudget(request): Promise<{ receipt_ref: string; expires_at_ms: number }> {
      const key = `${request.operation_id}:${request.stage}`;
      const cached = grants.get(key);
      if (cached !== undefined && cached.expires_at_ms > Date.now()) return cached;
      try {
        const row = await database.prepare(
          "SELECT budget_receipt_ref, budget_expires_at_ms FROM research_workflow_attempt WHERE operation_id = ?1 AND stage_index = ?2",
        ).bind(request.operation_id, RESEARCH_WORKFLOW_STAGES.indexOf(request.stage))
          .first<{ budget_receipt_ref: string; budget_expires_at_ms: number }>();
        if (row !== null && typeof row.budget_receipt_ref === "string" &&
            Number.isSafeInteger(row.budget_expires_at_ms) && row.budget_expires_at_ms > Date.now()) {
          const grant = { receipt_ref: row.budget_receipt_ref, expires_at_ms: row.budget_expires_at_ms };
          grants.set(key, grant);
          return grant;
        }
      } catch {
        // Fall through to a fresh bounded grant; SQL guards still enforce authority.
      }
      const grant = {
        receipt_ref: `w2-budget:${request.operation_id}:${request.stage}`,
        expires_at_ms: Date.now() + researchStageBudgetLeaseMs(request.stage),
      };
      grants.set(key, grant);
      return grant;
    },
    ...(recoverStartedAttempt === undefined ? {} : { recoverStartedAttempt }),
  };
}

export class ResearchWorkflow extends WorkflowEntrypoint<Env, ResearchWorkflowParams> {
  public override async run(event: WorkflowEvent<ResearchWorkflowParams>, step: WorkflowStep): Promise<ResearchWorkflowResult | ExhaustiveQueryResult> {
    const params = parseParams(event.payload);
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
      const access = {
        principal_ref: principal.principal_ref,
        client_class: "owner_pwa" as const,
        credential_generation: principal.credential_generation,
      };
      const scopePorts = createD1ScopePorts(this.env.CORE_DB, access);
      const navigation = createNavigationReadAuthority({
        database: this.env.CORE_DB,
        scope_snapshot: scopeAuthority.snapshot,
        access,
        require_current: async (scope) => { await scopePorts.requireCurrentScope(scope); return scope; },
      });
      if (params.qualification_renewal !== undefined && !semanticOwned) {
        failWorkflow("WORKFLOW_AUTHORITY_STALE");
      }
      if (semanticOwned && params.qualification_renewal === RESEARCH_QUALIFICATION_RENEWAL_MARKER) {
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
            const code = error instanceof Error && "code" in error
              ? String((error as { code: unknown }).code)
              : "RESEARCH_QUALIFICATION_RENEWAL_UNAVAILABLE";
            failWorkflow(code);
          }
          return { protocol: "eliotr.research-qualification-renewal.v1", state: "CURRENT" as const };
        });
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
    const ports = createServerPorts(this.env.CORE_DB, params.operation_id, handlers.recoverStartedAttempt);
    const executor = createWorkflowCheckpointExecutor(this.env.CORE_DB, this.env.WORK_BUCKET, ports);
    let investigation_ref: VersionedRef = { ...params.investigation_ref };
    let input_manifest: WorkflowObject = params.initial_input_manifest;
    const receipt_refs: string[] = [];
    let output_manifest: WorkflowObject = input_manifest;
    for (let index = 0; index < RESEARCH_WORKFLOW_STAGES.length; index += 1) {
      const stage = RESEARCH_WORKFLOW_STAGES[index] as ResearchWorkflowStage;
      const request = {
        protocol: "eliotr.workflow-stage.v1" as const,
        operation_id: params.operation_id,
        investigation_ref: { ...investigation_ref },
        stage,
        idempotency_key: params.idempotency_key,
        handler_generation: params.handler_generation,
        input_manifest,
      };
      const executeStage = async (): Promise<StageReceipt> => {
        try {
          const outcome = await executor.execute(request, principal, handlers(stage));
          const text = JSON.stringify(outcome);
          if (new TextEncoder().encode(text).byteLength > MAX_WORKFLOW_RECEIPT_BYTES) failWorkflow("WORKFLOW_INPUT_INVALID");
          if ("completion_disposition" in outcome) failWorkflow("WORKFLOW_INPUT_INVALID");
          return outcome;
        } catch (error) {
          if (error instanceof WorkflowCheckpointError && error.code === "WORKFLOW_OUTPUT_CORRUPT") {
            throw new NonRetryableError("WORKFLOW_OUTPUT_CORRUPT", "WorkflowCheckpointError");
          }
          throw error;
        }
      };
      const stepName = `w2-stage-${String(index).padStart(2, "0")}-${stage}`;
      const receipt = isResearchModelStage(stage)
        ? await step.do(stepName, {
          retries: { limit: 0, delay: 0 },
          timeout: researchStageBudgetLeaseMs(stage),
        }, executeStage)
        : await step.do(stepName, {
          retries: { limit: 0, delay: 0 },
        }, executeStage);
      const expectedEngine = index === RESEARCH_WORKFLOW_STAGES.length - 1 ? "ENGINE_COMPLETED" : "CHECKPOINTED";
      if (receipt.engine_state !== expectedEngine || receipt.operation_id !== params.operation_id || receipt.stage !== stage) {
        failWorkflow("WORKFLOW_OUTPUT_CORRUPT");
      }
      receipt_refs.push(receipt.receipt_ref);
      investigation_ref = { ...receipt.investigation_ref };
      input_manifest = receipt.output_manifest;
      output_manifest = receipt.output_manifest;
    }
    const result: ResearchWorkflowResult = {
      operation_id: params.operation_id,
      investigation_ref: { ...investigation_ref },
      state: "ENGINE_COMPLETED",
      receipt_refs: [...receipt_refs],
      output_manifest_ref: output_manifest.object_ref,
    };
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_WORKFLOW_RECEIPT_BYTES) {
      failWorkflow("WORKFLOW_INPUT_INVALID");
    }
    return result;
  }
}
