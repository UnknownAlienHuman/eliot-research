import {
  ResearchMaterializeOutputError,
  WorkflowCheckpointError,
  readResearchRunStatus as readStoredResearchRunStatus,
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-research";
import { readCommittedResearchRunResult } from "@eliotr/cloudflare-research-stages";
import { RetrievalQueryError } from "@eliotr/retrieval";
import type { AuthenticatedRequestContext, ResearchRunStatus } from "@eliotr/interfaces";
import type { VersionedRef } from "@eliotr/contracts";
import {
  prepareProjectClientRunRead,
  readProjectClientRunAnswer,
} from "./research-client-run-read.js";
import type { ProjectClientRunReadEnvironment } from "./research-client-run-read.js";
import {
  prepareReauthenticatedRunRead,
  readReauthenticatedRunAnswer,
} from "./research-run-read-authorization.js";
import type { ResearchRunReadEnvironment } from "./research-run-read-authorization.js";
import { readResearchEngineStatus, researchRunFailure } from "./research-run-failure.js";
import type { ResearchEngineObservation } from "./research-run-failure.js";
import { isSemanticResearchHandlerGeneration } from "./research-stage-handlers.js";

export interface ResearchSessionHeldScopeReadback {
  readonly investigation_id: string;
  readonly scope_snapshot_ref: VersionedRef;
}

export interface ResearchSessionStatusErrorBoundary {
  readonly fail: (code: string, message: string, status?: number, retryable?: boolean) => never;
  readonly is_research_service_error: (error: unknown) => boolean;
}

export interface ResearchSessionStatusApplicationPorts {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly deployment_generation: string;
  readonly run_read: ResearchRunReadEnvironment;
  readonly get_workflow: (operation_id: string) => Promise<WorkflowInstance>;
  readonly load_held_scope: (
    context: AuthenticatedRequestContext,
    operation_id: string,
    deployment_generation: string,
  ) => Promise<ResearchSessionHeldScopeReadback>;
  readonly errors: ResearchSessionStatusErrorBoundary;
}

function mapRunStatusFailure(error: unknown, errors: ResearchSessionStatusErrorBoundary): never {
  if (errors.is_research_service_error(error)) throw error;
  if (error instanceof WorkflowCheckpointError) {
    if (error.code === "WORKFLOW_AUTHORITY_STALE") {
      errors.fail("RESEARCH_AUTHORITY_STALE", "research run authority is no longer current", 409);
    }
    if (error.code === "WORKFLOW_OUTPUT_CORRUPT") {
      errors.fail("RESEARCH_RUN_STATUS_INVALID", "research result readback is inconsistent", 409);
    }
    if (error.code === "WORKFLOW_INPUT_INVALID") {
      errors.fail("RESEARCH_INPUT_INVALID", "research run status input is invalid", 400);
    }
    errors.fail("RESEARCH_RUN_STATUS_UNAVAILABLE", "research run status readback is unavailable", 503, true);
  }
  if (error instanceof RetrievalQueryError) {
    if (error.code === "RETRIEVAL_AUTHORITY_STALE" || error.code === "RETRIEVAL_SCOPE_STALE") {
      errors.fail("RESEARCH_AUTHORITY_STALE", "research run authority is no longer current", 409);
    }
    errors.fail("RESEARCH_RUN_STATUS_UNAVAILABLE", "research run authority readback is unavailable", 503, true);
  }
  if (error instanceof ResearchMaterializeOutputError) {
    if (error.code === "MATERIALIZE_OUTPUT_AUTHORITY_STALE") {
      errors.fail("RESEARCH_AUTHORITY_STALE", "research materialization authority is no longer current", 409);
    }
    if (error.code === "MATERIALIZE_OUTPUT_CORRUPT") {
      errors.fail("RESEARCH_RUN_STATUS_INVALID", "research materialization readback is inconsistent", 409);
    }
    if (error.code === "MATERIALIZE_OUTPUT_INPUT_INVALID") {
      errors.fail("RESEARCH_INPUT_INVALID", "research materialization reference is invalid", 400);
    }
    errors.fail("RESEARCH_RUN_STATUS_UNAVAILABLE", "research materialization readback is unavailable", 503, true);
  }
  throw error;
}

/** Builds run status from the verified caller and Core-provided scope/artifact authority. */
export async function readResearchSessionRunStatusApplication(
  ports: ResearchSessionStatusApplicationPorts,
  context: AuthenticatedRequestContext,
  workflowInstanceId: string,
): Promise<ResearchRunStatus> {
  const operationId = workflowInstanceId;
  const mapFailure = (error: unknown): never => mapRunStatusFailure(error, ports.errors);
  const principal: WorkflowPrincipal = {
    principal_ref: context.principal_ref,
    credential_generation: context.credential_generation,
    deployment_generation: ports.deployment_generation,
  };
  const recheckAuthority = async () => {
    const held = await ports.load_held_scope(context, operationId, ports.deployment_generation).catch(mapFailure);
    return {
      investigation_id: held.investigation_id,
      scope_snapshot_id: held.scope_snapshot_ref.id,
      scope_snapshot_revision: held.scope_snapshot_ref.revision,
    };
  };
  const isOwner = context.client_class === "owner_pwa";
  const clientReadEnvironment: ProjectClientRunReadEnvironment = { run_read: ports.run_read };
  const delegated = isOwner ? null : await prepareProjectClientRunRead(
    clientReadEnvironment, context, operationId,
  ).catch(mapFailure);
  if (!isOwner && delegated === null) {
    ports.errors.fail("RESEARCH_RUN_NOT_FOUND", "research run does not exist", 404);
  }
  const refreshed = isOwner ? await prepareReauthenticatedRunRead(
    ports.run_read, context, operationId,
  ).catch(mapFailure) : null;
  const status = delegated?.status ?? refreshed?.status ?? await readStoredResearchRunStatus({
    database: ports.database,
    operation_id: operationId,
    principal,
    recheck_authority: recheckAuthority,
  }).catch(mapFailure);
  if (status === null) ports.errors.fail("RESEARCH_RUN_NOT_FOUND", "research run does not exist", 404);
  const engine: ResearchEngineObservation | undefined = status.state === "ACTIVE"
    ? await readResearchEngineStatus({ get_workflow: ports.get_workflow }, operationId)
    : undefined;
  const failure = researchRunFailure(status, engine);
  const generation = delegated?.handler_generation ?? refreshed?.handler_generation ?? (await ports.database.prepare(
    "SELECT handler_generation FROM research_workflow_run WHERE operation_id=?1 AND principal_ref=?2",
  ).bind(operationId, context.principal_ref).first<{ handler_generation: string }>())?.handler_generation;
  let answer: ResearchRunStatus["answer"] = { availability: "unavailable" };
  if (delegated !== null) {
    if (isSemanticResearchHandlerGeneration(generation)) {
      answer = await readProjectClientRunAnswer(
        clientReadEnvironment, context, delegated, generation,
      ).catch(mapFailure);
    }
    await delegated.requireCurrent().catch(mapFailure);
  } else if (refreshed !== null) {
    if (isSemanticResearchHandlerGeneration(generation)) {
      answer = await readReauthenticatedRunAnswer(
        ports.run_read, context, refreshed, generation,
      ).catch(mapFailure);
    }
    await refreshed.requireCurrent().catch(mapFailure);
  } else if (status.state === "ENGINE_COMPLETED" && isSemanticResearchHandlerGeneration(generation)) {
    const completed = await readCommittedResearchRunResult({
      database: ports.database,
      work_bucket: ports.work_bucket,
      operation_id: operationId,
      principal,
      materialize_handler_generation: generation,
      recheck_authority: recheckAuthority,
    }).catch(mapFailure);
    if (completed !== null) {
      answer = { availability: "draft", artifact_ref: completed.materialization.materialization.draft.artifact_ref };
    }
  }
  return {
    protocol: failure === undefined ? "eliotr.research-run-status.v1" : "eliotr.research-run-status.v2",
    workflow_instance_id: status.operation_id,
    investigation_ref: { id: status.investigation_id, revision: status.current_revision },
    execution_state: status.state,
    ...(engine === undefined ? {} : {
      engine_status: engine.status,
      ...(failure === undefined ? {} : { failure }),
    }),
    next_stage_index: status.next_stage_index,
    answer,
    ...(status.cancellation_receipt_ref === null ? {} : {
      cancellation_receipt_ref: status.cancellation_receipt_ref,
    }),
  };
}
