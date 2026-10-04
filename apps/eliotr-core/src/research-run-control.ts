import { ClientGrantError, OrientationError, ScopeServiceError } from "@eliotr/cloudflare-navigation";
import { WorkflowCheckpointError, WorkflowCheckpointStore } from "@eliotr/cloudflare-research";
import {
  claimWorkflowRecoveryAction,
  ensureWorkflowRecoveryAction,
  settleWorkflowRecoveryAction,
} from "@eliotr/cloudflare-workflows";
import type {
  WorkflowRecoveryAction,
  WorkflowRunControlFailureCode,
} from "@eliotr/cloudflare-workflows";
import type { WorkflowRunStatus } from "@eliotr/cloudflare-research";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import type { AuthenticatedRequestContext, ResearchEngineStatus, ResearchRunStatus } from "@eliotr/interfaces";
import { CatalogInputError } from "./catalog-service.js";
import type { Env } from "./env.js";
import { prepareReauthenticatedRunRead, requireRunStatusContinuity, type ReauthenticatedRunRead } from "./research-run-read-authorization.js";
import { prepareProjectClientRecoverySpend, prepareOwnerMachineRecoverySpend, requireProjectClientSpendSchema } from "./research-client-spend.js";
import { RUN_CONTROL_FENCE_SQL, runControlFenceBindings, requireRunControlSchema, type AuthorizedRunControl } from "./research-run-control-fence.js";
import { prepareProjectClientRunRead } from "./research-client-run-read.js";
import { prepareProjectClientCancelAction } from "./research-run-cancel-action.js";
import { isSemanticResearchHandlerGeneration, SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION } from "./research-stage-handlers.js";

function fail(code: string, status: number, retryable = false): never {
  throw new CatalogInputError(code, "Research run control could not be confirmed", status, retryable);
}

/** The body cannot supply a principal, replacement run, scope or model policy. */
export function validateResearchRunControl(
  context: AuthenticatedRequestContext, operationId: string, body: unknown, allowService = false,
): void {
  if (context.client_class !== "owner_pwa" && (!allowService ||
      (context.client_class !== "trusted_agent" && context.client_class !== "named_api_client"))) {
    fail("RESEARCH_OWNER_REQUIRED", 403);
  }
  if (context.client_class !== "owner_pwa" && context.access?.authentication_method !== "service_token") {
    fail("RESEARCH_CONTROL_DENIED", 403);
  }
  const origin = context.request.headers.get("origin");
  const site = context.request.headers.get("sec-fetch-site");
  if ((origin !== null && origin !== new URL(context.request.url).origin) ||
      (site !== null && site !== "same-origin" && site !== "none")) fail("RESEARCH_CONTROL_ORIGIN_DENIED", 403);
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(operationId)) fail("RESEARCH_INPUT_INVALID", 400);
  if (body === null || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
    fail("RESEARCH_INPUT_INVALID", 400);
  }
  const key = context.request.headers.get("idempotency-key");
  if (key === null || key.length < 1 || key.length > 256 || /[\u0000-\u0020\u007f]/u.test(key)) {
    fail("RESEARCH_INPUT_INVALID", 400);
  }
  if (context.access === undefined || context.access.principal_ref !== context.principal_ref ||
      context.access.credential_generation !== context.credential_generation ||
      !Number.isFinite(Date.parse(context.access.expires_at)) || Date.parse(context.access.expires_at) <= Date.now()) {
    fail("RESEARCH_CONTROL_DENIED", 403);
  }
  if (context.request.signal.aborted) fail("RESEARCH_CONTROL_INTERRUPTED", 503, true);
}

function mapControlFailure(error: unknown): never {
  if (error instanceof CatalogInputError || error instanceof ClientGrantError ||
      error instanceof OrientationError || error instanceof ScopeServiceError) throw error;
  if (error instanceof WorkflowCheckpointError) {
    if (error.code === "WORKFLOW_AUTHORITY_STALE") fail("RESEARCH_CONTROL_DENIED", 403);
    if (error.code === "WORKFLOW_OUTPUT_CORRUPT") fail("RESEARCH_RUN_STATUS_INVALID", 409);
    if (error.code === "WORKFLOW_INPUT_INVALID") fail("RESEARCH_INPUT_INVALID", 400);
  }
  fail("RESEARCH_CONTROL_UNCONFIRMED", 503, true);
}

function recoveryActionFailure(code: WorkflowRunControlFailureCode): never {
  if (code === "RESEARCH_INPUT_INVALID") fail(code, 400);
  if (code === "RESEARCH_RUN_CANCEL_CONFLICT") fail(code, 409);
  if (code === "RESEARCH_RUN_RECOVERY_CONFLICT") fail(code, 409);
  fail("RESEARCH_CONTROL_UNCONFIRMED", 503, true);
}

export function runControlStatus(status: WorkflowRunStatus, engineStatus?: ResearchEngineStatus): ResearchRunStatus {
  return { protocol: "eliotr.research-run-status.v1", workflow_instance_id: status.operation_id,
    investigation_ref: { id: status.investigation_id, revision: status.current_revision },
    execution_state: status.state, ...(engineStatus === undefined ? {} : { engine_status: engineStatus }),
    next_stage_index: status.next_stage_index, answer: { availability: "unavailable" },
    ...(status.cancellation_receipt_ref === null ? {} : { cancellation_receipt_ref: status.cancellation_receipt_ref }) };
}

async function authorize(env: Env, context: AuthenticatedRequestContext, operationId: string): Promise<ReauthenticatedRunRead> {
  const read = await prepareReauthenticatedRunRead(env, context, operationId, true);
  if (read === null) fail("RESEARCH_RUN_NOT_FOUND", 404);
  return read;
}

// Reuse W2's one cancellation receipt and immutable terminal transition. The
// fresh owner scope or exact client delegation authorizes control, not impersonation.
// Existing epochs fence the complete policy/member checks performed before SQL;
// explicit grant/time predicates cover expiry without a database write.
const CANCEL_SQL = `UPDATE research_workflow_run SET state='CANCELLED',
  cancellation_receipt_ref='workflow-cancelled:' || operation_id WHERE ${RUN_CONTROL_FENCE_SQL}`;

export async function cancelResearchRun(
  env: Env, context: AuthenticatedRequestContext, operationId: string, body: unknown,
): Promise<ResearchRunStatus> {
  try {
    validateResearchRunControl(context, operationId, body, true);
    await requireRunControlSchema(env.CORE_DB);
    const clientRead = context.client_class === "owner_pwa" ? null
      : await prepareProjectClientRunRead(env, context, operationId, "cancel");
    const read = context.client_class === "owner_pwa" ? await authorize(env, context, operationId) : clientRead;
    if (read === null) fail("RESEARCH_RUN_NOT_FOUND", 404);
    if (read.status.state === "ENGINE_COMPLETED") fail("RESEARCH_RUN_ALREADY_COMPLETED", 409);
    const action = clientRead !== null || ("owner_machine" in read && read.owner_machine !== undefined)
      ? await prepareProjectClientCancelAction(env.CORE_DB, context, read) : undefined;
    if (read.status.state === "CANCELLED") {
      await read.requireCurrent();
      if (read.status.cancellation_receipt_ref === null) fail("RESEARCH_RUN_STATUS_INVALID", 409);
      await action?.confirm(read.status.cancellation_receipt_ref);
      validateResearchRunControl(context, operationId, body, true);
      return runControlStatus(read.status);
    }
    const fence = await runControlFenceBindings(context, read, "cancel");
    validateResearchRunControl(context, operationId, body, true);
    let changed = false;
    let writeUnknown = false;
    try {
      const result = await env.CORE_DB.prepare(CANCEL_SQL).bind(...fence).run();
      if (!result.success) writeUnknown = true;
      else changed = result.meta.changes === 1;
    } catch { writeUnknown = true; }
    // A lost acknowledgement is reconciled once against the original operation,
    // never by minting another cancellation or rerunning a possibly paid stage.
    const after = await new WorkflowCheckpointStore(env.CORE_DB).readRunStatus(operationId, {
      principal_ref: read.status.principal_ref, credential_generation: read.status.credential_generation,
      deployment_generation: read.status.deployment_generation,
    }, "owner-read");
    await read.requireCurrent();
    validateResearchRunControl(context, operationId, body, true);
    if (after === null) fail("RESEARCH_CONTROL_UNCONFIRMED", 503, true);
    requireRunStatusContinuity(read.status, after);
    if (after.state === "ENGINE_COMPLETED") fail("RESEARCH_RUN_ALREADY_COMPLETED", 409);
    if (after.state !== "CANCELLED" || after.cancellation_receipt_ref !== `workflow-cancelled:${operationId}`) {
      fail("RESEARCH_CONTROL_UNCONFIRMED", 503, true);
    }
    await action?.confirm(after.cancellation_receipt_ref);
    // Native termination is best effort ONLY after canonical cancellation.
    // Never run rollback handlers: they are not authority to undo research data.
    if (changed || writeUnknown) {
      try {
        const instance = await env.RESEARCH_WORKFLOW.get(operationId);
        if (instance.id !== operationId) throw new Error("instance mismatch");
        await read.requireCurrent();
        validateResearchRunControl(context, operationId, body, true);
        await instance.terminate();
      } catch {
        console.warn(JSON.stringify({ event: "research_run_native_termination_unconfirmed", trace_id: context.trace_id }));
      }
    }
    await read.requireCurrent();
    return runControlStatus(after);
  } catch (error) { return mapControlFailure(error); }
}

const RECOVERABLE_STARTED_STAGES = new Set([
  "SYNTHESIZE", "VERIFY", "AUDIT_CLAIMS", "RESOLVE_CITATIONS", "MATERIALIZE",
]);
const ACTIVE_NATIVE_STATES = new Set<ResearchEngineStatus>([
  "queued", "running", "waiting", "waitingForPause",
]);

function sameRunIdentity(left: WorkflowRunStatus, right: WorkflowRunStatus): boolean {
  return left.operation_id === right.operation_id && left.investigation_id === right.investigation_id &&
    left.initial_revision === right.initial_revision && left.principal_ref === right.principal_ref &&
    left.credential_generation === right.credential_generation &&
    left.deployment_generation === right.deployment_generation &&
    left.scope_snapshot_id === right.scope_snapshot_id &&
    left.scope_snapshot_revision === right.scope_snapshot_revision;
}

function stepName(index: number): string {
  const stage = RESEARCH_WORKFLOW_STAGES[index];
  if (stage === undefined) fail("RESEARCH_RUN_STATUS_INVALID", 409);
  return `w2-stage-${String(index).padStart(2, "0")}-${stage}`;
}

function nativeState(value: Awaited<ReturnType<WorkflowInstance["status"]>>): ResearchEngineStatus {
  return value.status;
}

async function latestAuthorizedStatus(
  env: Env,
  authorized: AuthorizedRunControl,
): Promise<WorkflowRunStatus> {
  const latest = await new WorkflowCheckpointStore(env.CORE_DB).readRunStatus(authorized.status.operation_id, {
    principal_ref: authorized.status.principal_ref,
    credential_generation: authorized.status.credential_generation,
    deployment_generation: authorized.status.deployment_generation,
  }, "owner-read");
  await authorized.requireCurrent();
  if (latest === null || !sameRunIdentity(authorized.status, latest)) fail("RESEARCH_RUN_STATUS_INVALID", 409);
  return latest;
}

export function isRecoverableStartedResearchStage(handlerGeneration: string, stage: string): boolean {
  return isSemanticResearchHandlerGeneration(handlerGeneration) &&
    (RECOVERABLE_STARTED_STAGES.has(stage) ||
      (handlerGeneration === SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION &&
        stage === "ANALYZE_BRANCHES"));
}

function requireSafeRestart(status: WorkflowRunStatus, handlerGeneration: string): void {
  const stage = RESEARCH_WORKFLOW_STAGES[status.next_stage_index];
  if (stage === undefined || (status.current_attempt !== null &&
      status.current_attempt.stage_index !== status.next_stage_index)) fail("RESEARCH_RUN_STATUS_INVALID", 409);
  if (status.current_attempt?.state === "STARTED" &&
      !isRecoverableStartedResearchStage(handlerGeneration, stage)) {
    fail("RESEARCH_RUN_RECOVERY_UNSAFE", 409);
  }
}

async function observeNative(instance: WorkflowInstance): Promise<ResearchEngineStatus> {
  try { return nativeState(await instance.status()); }
  catch { fail("RESEARCH_CONTROL_UNCONFIRMED", 503, true); }
}

/**
 * Recovers the same native Workflow instance. The durable W2/W3 checkpoint and
 * attempt stores remain authoritative; a native restart is never permission to
 * repeat an unknown paid effect or to mint a replacement run.
 */
export async function recoverResearchRun(
  env: Env,
  context: AuthenticatedRequestContext,
  operationId: string,
  body: unknown,
): Promise<ResearchRunStatus> {
  try {
    validateResearchRunControl(context, operationId, body, true);
    await requireRunControlSchema(env.CORE_DB);
    await requireProjectClientSpendSchema(env);
    const clientRead = context.client_class === "owner_pwa" ? null
      : await prepareProjectClientRunRead(env, context, operationId, "recover");
    const read = context.client_class === "owner_pwa" ? await authorize(env, context, operationId) : clientRead;
    if (read === null) fail("RESEARCH_RUN_NOT_FOUND", 404);
    if (read.status.state === "CANCELLED") fail("RESEARCH_RUN_CANCELLED", 409);
    if (read.status.state === "ENGINE_COMPLETED") {
      await read.requireCurrent();
      return runControlStatus(read.status);
    }
    const spend = clientRead !== null ? await prepareProjectClientRecoverySpend(env, clientRead)
      : "owner_machine" in read && read.owner_machine !== undefined
        ? await prepareOwnerMachineRecoverySpend(env, context, read) : undefined;
    const requireCurrent = async () => { await read.requireCurrent(); await spend?.requireCurrent(); };
    let instance: WorkflowInstance;
    try {
      instance = await env.RESEARCH_WORKFLOW.get(operationId);
      if (instance.id !== operationId) fail("RESEARCH_RUN_STATUS_INVALID", 409);
    } catch (error) {
      if (error instanceof CatalogInputError) throw error;
      fail("RESEARCH_CONTROL_UNCONFIRMED", 503, true);
    }
    let observed = await observeNative(instance);
    await requireCurrent();
    validateResearchRunControl(context, operationId, body, true);
    if (ACTIVE_NATIVE_STATES.has(observed)) {
      return runControlStatus(await latestAuthorizedStatus(env, read), observed);
    }
    if (observed === "complete") {
      const latest = await latestAuthorizedStatus(env, read);
      if (latest.state === "ENGINE_COMPLETED") return runControlStatus(latest, observed);
      fail("RESEARCH_RUN_STATUS_INVALID", 409);
    }
    if (observed === "unknown") fail("RESEARCH_CONTROL_UNCONFIRMED", 503, true);
    const action: WorkflowRecoveryAction = observed === "paused" ? "RESUME" : "RESTART";
    if (action === "RESTART") requireSafeRestart(read.status, read.handler_generation);
    const durable = await ensureWorkflowRecoveryAction({ database: env.CORE_DB, context, read,
      ...(spend === undefined ? {} : { spend }), fail: recoveryActionFailure });
    if (durable.state === "SUCCEEDED") fail("RESEARCH_RUN_RECOVERY_EXHAUSTED", 409);
    const claim = durable.state === "STARTED"
      ? await claimWorkflowRecoveryAction({ database: env.CORE_DB, row: durable, action, context, read,
        ...(spend === undefined ? {} : { spend }), fail: recoveryActionFailure })
      : { row: durable, claimed: false };
    if (claim.row.state !== "CHECKPOINTED") fail("RESEARCH_RUN_RECOVERY_CONFLICT", 409);
    await requireCurrent();
    validateResearchRunControl(context, operationId, body, true);
    if (claim.claimed) {
      try {
        if (action === "RESUME") await instance.resume();
        else if (read.status.current_attempt === null) await instance.restart();
        else await instance.restart({ from: { name: stepName(read.status.next_stage_index), type: "do" } });
      } catch {
        // A lost native ACK is reconciled by status below. Never issue a second
        // resume/restart for the same durable stage action.
      }
    }
    observed = await observeNative(instance);
    await requireCurrent();
    validateResearchRunControl(context, operationId, body, true);
    const latest = await latestAuthorizedStatus(env, read);
    if (latest.state === "CANCELLED") fail("RESEARCH_RUN_CANCELLED", 409);
    if (latest.state === "ENGINE_COMPLETED") {
      await settleWorkflowRecoveryAction({ database: env.CORE_DB, row: claim.row, fail: recoveryActionFailure });
      return runControlStatus(latest, observed);
    }
    if (ACTIVE_NATIVE_STATES.has(observed)) {
      await settleWorkflowRecoveryAction({ database: env.CORE_DB, row: claim.row, fail: recoveryActionFailure });
      return runControlStatus(latest, observed);
    }
    fail("RESEARCH_CONTROL_UNCONFIRMED", 503, true);
  } catch (error) { return mapControlFailure(error); }
}
