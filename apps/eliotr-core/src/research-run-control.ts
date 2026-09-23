import { ClientGrantError, OrientationError, ScopeServiceError } from "@eliotr/cloudflare-navigation";
import { textDigest, WorkflowCheckpointError, WorkflowCheckpointStore } from "@eliotr/cloudflare-research";
import type { WorkflowRunStatus } from "@eliotr/cloudflare-research";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import type { AuthenticatedRequestContext, ResearchEngineStatus, ResearchRunStatus } from "@eliotr/interfaces";
import { CatalogInputError } from "./catalog-service.js";
import type { Env } from "./env.js";
import { prepareReauthenticatedRunRead, requireRunStatusContinuity, type ReauthenticatedRunRead } from "./research-run-read-authorization.js";
import { prepareProjectClientRunRead } from "./research-client-run-read.js";
import { prepareProjectClientCancelAction } from "./research-run-cancel-action.js";
import { isSemanticResearchHandlerGeneration } from "./research-stage-handlers.js";

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
  cancellation_receipt_ref='workflow-cancelled:' || operation_id
  WHERE operation_id=?1 AND principal_ref=?2 AND deployment_generation=?3 AND state='ACTIVE'
  AND ?4 = (SELECT generation FROM investigation_ledger_epoch WHERE singleton=1)
  AND ?5 = (SELECT generation FROM orientation_authority_epoch WHERE singleton=1)
  AND ?6 > CAST(unixepoch('subsec') * 1000 AS INTEGER)
  AND EXISTS (SELECT 1 FROM investigation_ledger_head h WHERE h.investigation_id=research_workflow_run.investigation_id
    AND h.principal_ref=?2 AND h.scope_snapshot_id=research_workflow_run.scope_snapshot_id
    AND h.scope_snapshot_revision=research_workflow_run.scope_snapshot_revision AND h.revision=research_workflow_run.current_revision
    AND EXISTS (SELECT 1 FROM investigation_current_policy p WHERE p.policy_generation=h.policy_generation
      AND p.policy_authority_ref=h.policy_authority_ref AND p.state='ACTIVE'))
  AND ((?11='owner_pwa' AND EXISTS (SELECT 1 FROM scope_snapshot s JOIN scope_access_grant g
    ON g.snapshot_id=s.snapshot_id AND g.snapshot_revision=s.revision
    WHERE s.snapshot_id=?7 AND s.revision=?8 AND s.invalidated_at IS NULL
    AND julianday(s.expires_at)>julianday('now') AND g.state='ACTIVE'
    AND julianday(g.expires_at)>julianday('now') AND g.principal_ref=?2 AND g.client_class='owner_pwa'
    AND g.credential_generation=?9 AND g.authorization_receipt_ref=?10
    AND g.policy_authority_ref=s.policy_authority_ref
    AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) WHERE value='research')))
    OR (?11 IN ('trusted_agent','named_api_client') AND EXISTS (
      SELECT 1 FROM project_client_grant_current c JOIN project p ON p.project_id=c.project_id
      JOIN project_owner o ON o.project_id=p.project_id AND o.principal_ref=c.grantor_principal_ref
      JOIN scope_snapshot s ON s.snapshot_id=research_workflow_run.scope_snapshot_id
        AND s.revision=research_workflow_run.scope_snapshot_revision
      JOIN scope_access_grant g ON g.snapshot_id=s.snapshot_id AND g.snapshot_revision=s.revision
        AND g.principal_ref=research_workflow_run.principal_ref
        AND g.credential_generation=research_workflow_run.credential_generation
        AND g.authorization_receipt_ref=research_workflow_run.authorization_receipt_ref
        AND g.policy_authority_ref=research_workflow_run.policy_authority_ref
      WHERE c.grant_id=?12 AND c.revision=?13 AND c.state='ACTIVE' AND p.generation=?14
        AND c.grantor_principal_ref=?2 AND c.grantee_issuer=?15
        AND c.grantee_method='service_token' AND c.grantee_subject=?16 AND c.project_id=?17
        AND julianday(c.expires_at)>julianday('now')
        AND EXISTS (SELECT 1 FROM json_each(c.record_json,'$.allowed_operations') WHERE value='cancel')
        AND json_extract(s.resolved_scope_expression_json,'$.kind')='PROJECT'
        AND json_extract(s.resolved_scope_expression_json,'$.project_id')=c.project_id
        AND g.client_class='owner_pwa' AND g.project_client_grant_id IS NULL AND g.state IN ('ACTIVE','EXPIRED')
        AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) WHERE value='research'))))
  AND NOT EXISTS (SELECT 1 FROM scope_access_grant revoked
    WHERE revoked.snapshot_id=research_workflow_run.scope_snapshot_id
    AND revoked.snapshot_revision=research_workflow_run.scope_snapshot_revision
    AND revoked.principal_ref=?2 AND revoked.client_class='owner_pwa' AND revoked.state='REVOKED')`;

export async function cancelResearchRun(
  env: Env, context: AuthenticatedRequestContext, operationId: string, body: unknown,
): Promise<ResearchRunStatus> {
  try {
    validateResearchRunControl(context, operationId, body, true);
    const clientRead = context.client_class === "owner_pwa" ? null
      : await prepareProjectClientRunRead(env, context, operationId, "cancel");
    const read = context.client_class === "owner_pwa" ? await authorize(env, context, operationId) : clientRead;
    if (read === null) fail("RESEARCH_RUN_NOT_FOUND", 404);
    if (read.status.state === "ENGINE_COMPLETED") fail("RESEARCH_RUN_ALREADY_COMPLETED", 409);
    const action = clientRead === null ? undefined : await prepareProjectClientCancelAction(env.CORE_DB, context, clientRead);
    if (read.status.state === "CANCELLED") {
      await read.requireCurrent();
      if (read.status.cancellation_receipt_ref === null) fail("RESEARCH_RUN_STATUS_INVALID", 409);
      await action?.confirm(read.status.cancellation_receipt_ref);
      validateResearchRunControl(context, operationId, body, true);
      return runControlStatus(read.status);
    }
    const fence = await read.controlFence();
    validateResearchRunControl(context, operationId, body, true);
    let changed = false;
    let writeUnknown = false;
    try {
      const delegated = "client_grant" in fence ? fence : undefined;
      const owner = "scope_ref" in fence ? fence : undefined;
      const result = await env.CORE_DB.prepare(CANCEL_SQL).bind(operationId, read.status.principal_ref,
        read.status.deployment_generation, fence.ledger_epoch, fence.orientation_epoch, fence.valid_until_ms,
        owner?.scope_ref.id ?? "", owner?.scope_ref.revision ?? 0, context.credential_generation,
        owner?.authorization_receipt_ref ?? "", context.client_class,
        delegated?.client_grant.grant_id ?? "", delegated?.client_grant.revision ?? 0,
        delegated?.project_generation ?? 0, context.access?.issuer ?? "", context.principal_ref,
        delegated?.client_grant.project_id ?? "").run();
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

type RecoveryAction = "RESUME" | "RESTART";
type RecoveryActionState = "STARTED" | "CHECKPOINTED" | "SUCCEEDED" | "FAILED" | "CANCELLED";
interface RecoveryActionRow {
  readonly intent_id: string;
  readonly operation_kind: string;
  readonly principal_ref: string;
  readonly idempotency_key: string;
  readonly payload_ref: string;
  readonly policy_decision_ref: string;
  readonly attempt_id: string;
  readonly state: RecoveryActionState;
  readonly checkpoint_ref: string | null;
  readonly error_code: string | null;
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
  context: AuthenticatedRequestContext,
  authorized: ReauthenticatedRunRead,
): Promise<WorkflowRunStatus> {
  const latest = await new WorkflowCheckpointStore(env.CORE_DB).readRunStatus(authorized.status.operation_id, {
    principal_ref: context.principal_ref,
    credential_generation: context.credential_generation,
    deployment_generation: authorized.status.deployment_generation,
  }, "owner-read");
  await authorized.requireCurrent();
  if (latest === null || !sameRunIdentity(authorized.status, latest)) fail("RESEARCH_RUN_STATUS_INVALID", 409);
  return latest;
}

function recoveryIdentity(operationId: string, stageIndex: number): {
  readonly intent_id: string;
  readonly attempt_id: string;
  readonly payload_ref: string;
  readonly policy_decision_ref: string;
} {
  return {
    intent_id: `research-recover:${operationId}:${stageIndex}`,
    attempt_id: `research-recover-attempt:${operationId}:${stageIndex}`,
    payload_ref: `research-run:${operationId}:${stageIndex}`,
    policy_decision_ref: `research-recovery-authorized:${operationId}:${stageIndex}`,
  };
}

async function recoveryIdempotencyKey(context: AuthenticatedRequestContext, operationId: string): Promise<string> {
  const supplied = context.request.headers.get("idempotency-key");
  if (supplied === null) fail("RESEARCH_INPUT_INVALID", 400);
  return `research-recover:${await textDigest(`${operationId}\u0000${supplied}`)}`;
}

async function readRecoveryAction(database: D1Database, intentId: string): Promise<RecoveryActionRow | null> {
  const row = await database.prepare(`SELECT i.intent_id, i.operation_kind, i.principal_ref, i.idempotency_key,
    i.payload_ref, i.policy_decision_ref, a.attempt_id, a.state, a.checkpoint_ref, a.error_code
    FROM operation_intent i JOIN operation_attempt a
      ON a.intent_id=i.intent_id AND a.intent_revision=i.revision
    WHERE i.intent_id=?1 AND i.revision=1 AND a.attempt_number=1 LIMIT 1`).bind(intentId).first<RecoveryActionRow>();
  return row ?? null;
}

function validateRecoveryAction(
  row: RecoveryActionRow,
  expected: ReturnType<typeof recoveryIdentity> & { readonly principal_ref: string; readonly idempotency_key: string },
): void {
  if (row.intent_id !== expected.intent_id || row.attempt_id !== expected.attempt_id ||
      row.operation_kind !== "research.run.recover.v1" || row.principal_ref !== expected.principal_ref ||
      row.idempotency_key !== expected.idempotency_key || row.payload_ref !== expected.payload_ref ||
      row.policy_decision_ref !== expected.policy_decision_ref) {
    fail("RESEARCH_RUN_RECOVERY_CONFLICT", 409);
  }
}

async function ensureRecoveryAction(
  database: D1Database,
  context: AuthenticatedRequestContext,
  status: WorkflowRunStatus,
): Promise<RecoveryActionRow> {
  const identity = recoveryIdentity(status.operation_id, status.next_stage_index);
  const expected = {
    ...identity,
    principal_ref: context.principal_ref,
    idempotency_key: await recoveryIdempotencyKey(context, status.operation_id),
  };
  const createdAt = new Date().toISOString();
  try {
    await database.batch([
      database.prepare(`INSERT OR IGNORE INTO operation_intent(intent_id,revision,operation_kind,principal_ref,
        idempotency_key,payload_ref,policy_decision_ref,budget_reservation_ref,cancellation_ref,created_at)
        VALUES(?1,1,'research.run.recover.v1',?2,?3,?4,?5,NULL,?6,?7)`)
        .bind(identity.intent_id, context.principal_ref, expected.idempotency_key, identity.payload_ref,
          identity.policy_decision_ref, `workflow:${status.operation_id}`, createdAt),
      database.prepare(`INSERT OR IGNORE INTO operation_attempt(attempt_id,intent_id,intent_revision,attempt_number,
        state,checkpoint_ref,error_code,started_at,ended_at) VALUES(?1,?2,1,1,'STARTED',NULL,NULL,?3,NULL)`)
        .bind(identity.attempt_id, identity.intent_id, createdAt),
    ]);
  } catch { fail("RESEARCH_CONTROL_UNCONFIRMED", 503, true); }
  const row = await readRecoveryAction(database, identity.intent_id);
  if (row === null) fail("RESEARCH_CONTROL_UNCONFIRMED", 503, true);
  validateRecoveryAction(row, expected);
  return row;
}

async function claimRecoveryAction(
  database: D1Database,
  row: RecoveryActionRow,
  action: RecoveryAction,
): Promise<{ readonly row: RecoveryActionRow; readonly claimed: boolean }> {
  const checkpointRef = `${action.toLowerCase()}:${row.intent_id}`;
  let result: D1Result;
  try {
    result = await database.prepare(`UPDATE operation_attempt SET state='CHECKPOINTED', checkpoint_ref=?2
      WHERE attempt_id=?1 AND intent_id=?3 AND intent_revision=1 AND attempt_number=1 AND state='STARTED'`)
      .bind(row.attempt_id, checkpointRef, row.intent_id).run();
  } catch { fail("RESEARCH_CONTROL_UNCONFIRMED", 503, true); }
  const current = await readRecoveryAction(database, row.intent_id);
  if (current === null) fail("RESEARCH_CONTROL_UNCONFIRMED", 503, true);
  if (current.state === "CHECKPOINTED" && current.checkpoint_ref !== checkpointRef) {
    fail("RESEARCH_RUN_RECOVERY_CONFLICT", 409);
  }
  return { row: current, claimed: result.success && result.meta.changes === 1 };
}

async function settleRecoveryAction(database: D1Database, row: RecoveryActionRow): Promise<void> {
  const endedAt = new Date().toISOString();
  try {
    await database.prepare(`UPDATE operation_attempt SET state='SUCCEEDED', ended_at=?2
      WHERE attempt_id=?1 AND intent_id=?3 AND intent_revision=1 AND state='CHECKPOINTED'`)
      .bind(row.attempt_id, endedAt, row.intent_id).run();
  } catch { fail("RESEARCH_CONTROL_UNCONFIRMED", 503, true); }
  const after = await readRecoveryAction(database, row.intent_id);
  if (after?.state !== "SUCCEEDED") fail("RESEARCH_CONTROL_UNCONFIRMED", 503, true);
}

function requireSafeRestart(status: WorkflowRunStatus, handlerGeneration: string): void {
  const stage = RESEARCH_WORKFLOW_STAGES[status.next_stage_index];
  if (stage === undefined || (status.current_attempt !== null &&
      status.current_attempt.stage_index !== status.next_stage_index)) fail("RESEARCH_RUN_STATUS_INVALID", 409);
  if (status.current_attempt?.state === "STARTED" &&
      (!isSemanticResearchHandlerGeneration(handlerGeneration) || !RECOVERABLE_STARTED_STAGES.has(stage))) {
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
    validateResearchRunControl(context, operationId, body);
    const read = await authorize(env, context, operationId);
    if (read.status.state === "CANCELLED") fail("RESEARCH_RUN_CANCELLED", 409);
    if (read.status.state === "ENGINE_COMPLETED") {
      await read.requireCurrent();
      return runControlStatus(read.status);
    }
    let instance: WorkflowInstance;
    try {
      instance = await env.RESEARCH_WORKFLOW.get(operationId);
      if (instance.id !== operationId) fail("RESEARCH_RUN_STATUS_INVALID", 409);
    } catch (error) {
      if (error instanceof CatalogInputError) throw error;
      fail("RESEARCH_CONTROL_UNCONFIRMED", 503, true);
    }
    let observed = await observeNative(instance);
    await read.requireCurrent();
    validateResearchRunControl(context, operationId, body);
    if (ACTIVE_NATIVE_STATES.has(observed)) {
      return runControlStatus(await latestAuthorizedStatus(env, context, read), observed);
    }
    if (observed === "complete") {
      const latest = await latestAuthorizedStatus(env, context, read);
      if (latest.state === "ENGINE_COMPLETED") return runControlStatus(latest, observed);
      fail("RESEARCH_RUN_STATUS_INVALID", 409);
    }
    if (observed === "unknown") fail("RESEARCH_CONTROL_UNCONFIRMED", 503, true);
    const action: RecoveryAction = observed === "paused" ? "RESUME" : "RESTART";
    if (action === "RESTART") requireSafeRestart(read.status, read.handler_generation);
    const durable = await ensureRecoveryAction(env.CORE_DB, context, read.status);
    if (durable.state === "SUCCEEDED") fail("RESEARCH_RUN_RECOVERY_EXHAUSTED", 409);
    const claim = durable.state === "STARTED"
      ? await claimRecoveryAction(env.CORE_DB, durable, action)
      : { row: durable, claimed: false };
    if (claim.row.state !== "CHECKPOINTED") fail("RESEARCH_RUN_RECOVERY_CONFLICT", 409);
    await read.requireCurrent();
    validateResearchRunControl(context, operationId, body);
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
    await read.requireCurrent();
    validateResearchRunControl(context, operationId, body);
    const latest = await latestAuthorizedStatus(env, context, read);
    if (latest.state === "CANCELLED") fail("RESEARCH_RUN_CANCELLED", 409);
    if (latest.state === "ENGINE_COMPLETED") {
      await settleRecoveryAction(env.CORE_DB, claim.row);
      return runControlStatus(latest, observed);
    }
    if (ACTIVE_NATIVE_STATES.has(observed)) {
      await settleRecoveryAction(env.CORE_DB, claim.row);
      return runControlStatus(latest, observed);
    }
    fail("RESEARCH_CONTROL_UNCONFIRMED", 503, true);
  } catch (error) { return mapControlFailure(error); }
}
