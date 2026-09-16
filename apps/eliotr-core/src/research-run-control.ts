import { WorkflowCheckpointError, WorkflowCheckpointStore } from "@eliotr/cloudflare-research";
import type { WorkflowRunStatus } from "@eliotr/cloudflare-research";
import type { AuthenticatedRequestContext, ResearchRunStatus } from "@eliotr/interfaces";
import { CatalogInputError } from "./catalog-service.js";
import type { Env } from "./env.js";
import { prepareReauthenticatedRunRead, type ReauthenticatedRunRead } from "./research-run-read-authorization.js";

function fail(code: string, status: number, retryable = false): never {
  throw new CatalogInputError(code, "Research run control could not be confirmed", status, retryable);
}

/** The body cannot supply a principal, replacement run, scope or model policy. */
export function validateResearchRunControl(context: AuthenticatedRequestContext, operationId: string, body: unknown): void {
  if (context.client_class !== "owner_pwa") fail("RESEARCH_OWNER_REQUIRED", 403);
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
  if (error instanceof CatalogInputError) throw error;
  if (error instanceof WorkflowCheckpointError) {
    if (error.code === "WORKFLOW_AUTHORITY_STALE") fail("RESEARCH_CONTROL_DENIED", 403);
    if (error.code === "WORKFLOW_OUTPUT_CORRUPT") fail("RESEARCH_RUN_STATUS_INVALID", 409);
    if (error.code === "WORKFLOW_INPUT_INVALID") fail("RESEARCH_INPUT_INVALID", 400);
  }
  fail("RESEARCH_CONTROL_UNCONFIRMED", 503, true);
}

export function runControlStatus(status: WorkflowRunStatus): ResearchRunStatus {
  return { protocol: "eliotr.research-run-status.v1", workflow_instance_id: status.operation_id,
    investigation_ref: { id: status.investigation_id, revision: status.current_revision },
    execution_state: status.state, next_stage_index: status.next_stage_index, answer: { availability: "unavailable" },
    ...(status.cancellation_receipt_ref === null ? {} : { cancellation_receipt_ref: status.cancellation_receipt_ref }) };
}

async function authorize(env: Env, context: AuthenticatedRequestContext, operationId: string): Promise<ReauthenticatedRunRead> {
  const read = await prepareReauthenticatedRunRead(env, context, operationId, true);
  if (read === null) fail("RESEARCH_RUN_NOT_FOUND", 404);
  return read;
}

// Reuse W2's cancellation receipt and immutable terminal transition. The fresh
// owner grant is action authorization, not impersonation of the original JWT.
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
    AND h.scope_snapshot_revision=research_workflow_run.scope_snapshot_revision AND h.revision=research_workflow_run.current_revision)
  AND EXISTS (SELECT 1 FROM scope_snapshot s JOIN scope_access_grant g
    ON g.snapshot_id=s.snapshot_id AND g.snapshot_revision=s.revision
    WHERE s.snapshot_id=?7 AND s.revision=?8 AND s.invalidated_at IS NULL
    AND julianday(s.expires_at)>julianday('now') AND g.state='ACTIVE'
    AND julianday(g.expires_at)>julianday('now') AND g.principal_ref=?2 AND g.client_class='owner_pwa'
    AND g.credential_generation=?9 AND g.authorization_receipt_ref=?10
    AND g.policy_authority_ref=s.policy_authority_ref
    AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) WHERE value='research'))
  AND NOT EXISTS (SELECT 1 FROM scope_access_grant revoked
    WHERE revoked.snapshot_id=research_workflow_run.scope_snapshot_id
    AND revoked.snapshot_revision=research_workflow_run.scope_snapshot_revision
    AND revoked.principal_ref=?2 AND revoked.client_class='owner_pwa' AND revoked.state='REVOKED')`;

export async function cancelResearchRun(
  env: Env, context: AuthenticatedRequestContext, operationId: string, body: unknown,
): Promise<ResearchRunStatus> {
  try {
    validateResearchRunControl(context, operationId, body);
    const read = await authorize(env, context, operationId);
    if (read.status.state === "ENGINE_COMPLETED") fail("RESEARCH_RUN_ALREADY_COMPLETED", 409);
    if (read.status.state === "CANCELLED") {
      await read.requireCurrent();
      return runControlStatus(read.status);
    }
    const fence = await read.controlFence();
    validateResearchRunControl(context, operationId, body);
    let changed = false;
    let writeUnknown = false;
    try {
      const result = await env.CORE_DB.prepare(CANCEL_SQL).bind(operationId, context.principal_ref,
        env.DEPLOYMENT_GENERATION, fence.ledger_epoch, fence.orientation_epoch, fence.valid_until_ms,
        fence.scope_ref.id, fence.scope_ref.revision, context.credential_generation, fence.authorization_receipt_ref).run();
      if (!result.success) writeUnknown = true;
      else changed = result.meta.changes === 1;
    } catch { writeUnknown = true; }
    // A lost acknowledgement is reconciled once against the original operation,
    // never by minting another cancellation or rerunning a possibly paid stage.
    const after = await new WorkflowCheckpointStore(env.CORE_DB).readRunStatus(operationId, {
      principal_ref: context.principal_ref, credential_generation: context.credential_generation,
      deployment_generation: env.DEPLOYMENT_GENERATION,
    }, "owner-read");
    await read.requireCurrent();
    validateResearchRunControl(context, operationId, body);
    if (after === null) fail("RESEARCH_CONTROL_UNCONFIRMED", 503, true);
    if (after.state === "ENGINE_COMPLETED") fail("RESEARCH_RUN_ALREADY_COMPLETED", 409);
    if (after.state !== "CANCELLED" || after.cancellation_receipt_ref !== `workflow-cancelled:${operationId}`) {
      fail("RESEARCH_CONTROL_UNCONFIRMED", 503, true);
    }
    // Native termination is best effort ONLY after canonical cancellation.
    // Never run rollback handlers: they are not authority to undo research data.
    if (changed || writeUnknown) {
      try {
        const instance = await env.RESEARCH_WORKFLOW.get(operationId);
        if (instance.id !== operationId) throw new Error("instance mismatch");
        await read.requireCurrent();
        validateResearchRunControl(context, operationId, body);
        await instance.terminate();
      } catch {
        console.warn(JSON.stringify({ event: "research_run_native_termination_unconfirmed", trace_id: context.trace_id }));
      }
    }
    await read.requireCurrent();
    return runControlStatus(after);
  } catch (error) { return mapControlFailure(error); }
}
