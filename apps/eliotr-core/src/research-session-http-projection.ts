// IMPLEMENTED_NOT_LIVE: ER-24 HTTP projection handlers extracted from ResearchSession; the DO class keeps lifecycle and session persistence.
import {
  WorkflowCheckpointStore,
  WorkflowObjectSchema,
  MAX_WORKFLOW_RECEIPT_BYTES,
  WorkflowCheckpointError,
} from "@eliotr/cloudflare-research";
import type { WorkflowPrincipal } from "@eliotr/cloudflare-research";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { ResearchServiceError, failResearch as fail } from "./research-service-error.js";
import type { Env } from "./env.js";
import { requireResearchDeploymentCompatibility } from "./research-deployment-compatibility.js";
import { checkId, readResearchRunStatus } from "./research-run-service.js";
import { readCurrentSessionAuthority } from "./research-session-current-authority.js";
import { RESEARCH_SESSION_PROJECTION_PROTOCOL } from "./research-session-chat-authority.js";
import { jsonResponse } from "./http-response.js";

export const RESEARCH_SESSION_PROTOCOL = "eliotr.research-session.v1";

export type SessionRecordState = "ACTIVE" | "CANCELLED" | "ENGINE_COMPLETED";

export interface SessionRecord {
  protocol: typeof RESEARCH_SESSION_PROTOCOL;
  session_id: string;
  investigation_id: string;
  investigation_revision: number;
  operation_id: string;
  idempotency_key: string;
  handler_generation: string;
  principal_ref: string;
  credential_generation: string;
  deployment_generation: string;
  state: SessionRecordState;
  receipt_refs: readonly string[];
  output_manifest_ref: string | null;
  updated_at: string;
}

/** Minimal DO collaborator: environment access plus the session-record lifecycle the projection needs. */
export interface SessionProjectionHost {
  readonly env: Env | undefined;
  load(id: string): Promise<SessionRecord | null>;
  save(record: SessionRecord): Promise<void>;
  settleTerminal(
    expected: SessionRecord,
    change: Pick<SessionRecord, "state"> & Partial<Pick<SessionRecord, "investigation_revision" | "receipt_refs" | "output_manifest_ref">>,
  ): Promise<SessionRecord>;
}
export function callerOf(request: Request, body?: Record<string, unknown>): WorkflowPrincipal {
  const pick = (name: string, fallback?: unknown) => request.headers.get(name) ?? (typeof fallback === "string" ? fallback : undefined);
  const principal_ref = pick("x-research-principal", body?.principal_ref);
  const credential_generation = pick("x-research-credential", body?.credential_generation);
  const deployment_generation = pick("x-research-deployment", body?.deployment_generation);
  if (typeof principal_ref !== "string" || typeof credential_generation !== "string" || typeof deployment_generation !== "string") fail("RESEARCH_INPUT_INVALID", "research session caller identity is required");
  return { principal_ref, credential_generation, deployment_generation };
}

function sessionRunContext(request: Request, caller: WorkflowPrincipal, traceFallback: string = crypto.randomUUID()): AuthenticatedRequestContext {
  return { request, principal_ref: caller.principal_ref, client_class: "owner_pwa", credential_generation: caller.credential_generation, trace_id: request.headers.get("cf-ray") ?? traceFallback };
}

function sessionReopenRequired(request: Request, sessionId: string, operationId: string): Response {
  return json(request, { code: "SESSION_AUTHORITY_STALE", reason_code: "SESSION_REOPEN_REQUIRED", protocol: RESEARCH_SESSION_PROTOCOL, session_id: sessionId, operation_id: operationId, state: "BLOCKED", disposition: "REOPEN_REQUIRED", trace_id: request.headers.get("cf-ray") ?? crypto.randomUUID(), retryable: false }, 409);
}

export function json(request: Request, value: unknown, status = 200): Response {
  return jsonResponse(value, status);
}

export function problem(request: Request, status: number, code: string, retryable = status === 503): Response {
  return json(request, { code, trace_id: request.headers.get("cf-ray") ?? crypto.randomUUID(), retryable }, status);
}

export function workflowProblem(request: Request, error: WorkflowCheckpointError): Response {
  const code = error.failure?.code ?? error.code;
  const conflict = ["WORKFLOW_CONFLICT", "WORKFLOW_STAGE_OUT_OF_ORDER", "WORKFLOW_AUTHORITY_STALE", "WORKFLOW_CANCELLED", "WORKFLOW_BUDGET_STOP"].includes(error.code);
  return problem(request, error.code === "WORKFLOW_INPUT_INVALID" ? 400 : conflict ? 409 : 503,
    code, error.failure?.retryable === true);
}

export async function projectSession(host: SessionProjectionHost, request: Request, sid: string): Promise<Response> {
  const stored = await host.load(sid);
  if (stored === null) return problem(request, 404, "SESSION_NOT_FOUND");
  let caller: WorkflowPrincipal;
  try { caller = callerOf(request); }
  catch { return problem(request, 400, "RESEARCH_INPUT_INVALID"); }
  if (caller.principal_ref !== stored.principal_ref) return problem(request, 403, "SESSION_FOREIGN");
  if (caller.credential_generation !== stored.credential_generation) return problem(request, 409, "SESSION_AUTHORITY_STALE");
  const env = host.env;
  if (!env?.CORE_DB || !env.SEARCH_DB || !env.WORK_BUCKET) return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
  try { await requireResearchDeploymentCompatibility(env.CORE_DB, stored.deployment_generation, caller.deployment_generation); }
  catch { return problem(request, 409, "SESSION_AUTHORITY_STALE"); }

  const principal: WorkflowPrincipal = {
    principal_ref: stored.principal_ref,
    credential_generation: stored.credential_generation,
    deployment_generation: stored.deployment_generation,
  };
  const checkpoints = new WorkflowCheckpointStore(env.CORE_DB);
  const persisted = await checkpoints.readRunStatus(stored.operation_id, principal, "owner-read");
  if (persisted === null) {
    const authority = await readCurrentSessionAuthority(env, caller, stored.investigation_id);
    if (authority === "STALE") return problem(request, 409, "SESSION_AUTHORITY_STALE");
    if (authority === "UNAVAILABLE") return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
    return sessionReopenRequired(request, sid, stored.operation_id);
  }

  const status = await readResearchRunStatus(
    env,
    sessionRunContext(request, caller, stored.operation_id),
    stored.operation_id,
  );
  if (status.workflow_instance_id !== stored.operation_id || status.investigation_ref.id !== stored.investigation_id) {
    return problem(request, 409, "SESSION_AUTHORITY_STALE");
  }
  if (status.execution_state === "ACTIVE") {
    if (stored.state !== "ACTIVE" || persisted.state !== "ACTIVE") return problem(request, 409, "SESSION_CONFLICT");
    if (status.engine_status === undefined || status.engine_status === "unknown") {
      return sessionReopenRequired(request, sid, stored.operation_id);
    }
    if (!Number.isSafeInteger(status.next_stage_index) || status.next_stage_index < 0) {
      return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
    }
    return json(request, {
      protocol: RESEARCH_SESSION_PROJECTION_PROTOCOL,
      session_id: sid,
      operation_id: stored.operation_id,
      state: "ACTIVE",
      investigation_ref: status.investigation_ref,
      run_status: {
        execution_state: "ACTIVE",
        engine_status: status.engine_status,
        next_stage_index: status.next_stage_index,
      },
    });
  }
  if (status.execution_state === "CANCELLED") {
    if (stored.state === "ENGINE_COMPLETED") return problem(request, 409, "SESSION_CONFLICT");
    if (persisted.state !== "CANCELLED" || persisted.investigation_id !== stored.investigation_id ||
        persisted.cancellation_receipt_ref === null ||
        status.cancellation_receipt_ref !== persisted.cancellation_receipt_ref) {
      return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
    }
    return json(request, {
      protocol: RESEARCH_SESSION_PROJECTION_PROTOCOL,
      session_id: sid,
      operation_id: stored.operation_id,
      state: "CANCELLED",
      investigation_ref: status.investigation_ref,
      cancellation_receipt_ref: persisted.cancellation_receipt_ref,
    });
  }
  if (stored.state === "CANCELLED") return problem(request, 409, "SESSION_CONFLICT");
  const finalReceipt = persisted.final_receipt;
  if (persisted.state !== "ENGINE_COMPLETED" || finalReceipt == null ||
      persisted.investigation_id !== stored.investigation_id ||
      persisted.current_revision !== status.investigation_ref.revision ||
      finalReceipt.engine_state !== "ENGINE_COMPLETED" || finalReceipt.stage !== "MATERIALIZE" ||
      finalReceipt.investigation_ref.id !== stored.investigation_id ||
      finalReceipt.investigation_ref.revision !== persisted.current_revision) {
    return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
  }
  if (new TextEncoder().encode(JSON.stringify(finalReceipt)).byteLength > MAX_WORKFLOW_RECEIPT_BYTES ||
      "completion_disposition" in finalReceipt) return problem(request, 409, "WORKFLOW_INPUT_INVALID");
  if (stored.state === "ENGINE_COMPLETED" &&
      (stored.receipt_refs.at(-1) !== finalReceipt.receipt_ref ||
        stored.output_manifest_ref !== finalReceipt.output_manifest.object_ref)) {
    return problem(request, 409, "SESSION_CONFLICT");
  }
  return json(request, {
    protocol: RESEARCH_SESSION_PROJECTION_PROTOCOL,
    session_id: sid,
    operation_id: stored.operation_id,
    state: "ENGINE_COMPLETED",
    investigation_ref: finalReceipt.investigation_ref,
    completion_receipt_ref: finalReceipt.receipt_ref,
    output_manifest_ref: finalReceipt.output_manifest.object_ref,
  });
}

export async function startSession(host: SessionProjectionHost, request: Request): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); }
  catch { return problem(request, 400, "RESEARCH_INPUT_INVALID"); }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return problem(request, 400, "RESEARCH_INPUT_INVALID");
  const value = body as Record<string, unknown>;
  const allowed = new Set(["session_id", "investigation_id", "investigation_revision", "operation_id",
    "idempotency_key", "handler_generation", "initial_input_manifest", "principal_ref",
    "credential_generation", "deployment_generation"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return problem(request, 400, "RESEARCH_INPUT_INVALID");
  try {
    const session_id = checkId(value.session_id, "session_id");
    const investigation_id = checkId(value.investigation_id, "investigation_id");
    const operation_id = checkId(value.operation_id, "operation_id");
    const idempotency_key = checkId(value.idempotency_key, "idempotency_key");
    const handler_generation = checkId(value.handler_generation, "handler_generation");
    const caller = callerOf(request, value);
    if (caller.principal_ref !== value.principal_ref || caller.credential_generation !== value.credential_generation ||
        caller.deployment_generation !== value.deployment_generation) return problem(request, 403, "SESSION_FOREIGN");
    if (!Number.isSafeInteger(value.investigation_revision) || (value.investigation_revision as number) < 1) {
      return problem(request, 400, "RESEARCH_INPUT_INVALID");
    }
    const revision = value.investigation_revision as number;
    const manifest = WorkflowObjectSchema.safeParse(value.initial_input_manifest);
    if (!manifest.success || manifest.data.residency.access_domain_id !== caller.principal_ref) {
      return problem(request, 400, "RESEARCH_INPUT_INVALID");
    }
    const existing = await host.load(session_id);
    if (existing !== null) {
      if (existing.protocol !== RESEARCH_SESSION_PROTOCOL || existing.session_id !== session_id ||
          existing.investigation_id !== investigation_id || existing.operation_id !== operation_id ||
          existing.idempotency_key !== idempotency_key || existing.handler_generation !== handler_generation ||
          existing.principal_ref !== caller.principal_ref ||
          existing.credential_generation !== caller.credential_generation ||
          existing.deployment_generation !== caller.deployment_generation) return problem(request, 409, "SESSION_CONFLICT");
      if (existing.state === "ENGINE_COMPLETED") {
        if (!host.env?.CORE_DB) return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
        const canonical = await new WorkflowCheckpointStore(host.env.CORE_DB).readRunStatus(operation_id, caller, "owner-read");
        if (canonical?.state !== "ENGINE_COMPLETED" || canonical.investigation_id !== investigation_id ||
            canonical.initial_revision !== revision || canonical.current_revision !== existing.investigation_revision ||
            canonical.final_receipt?.receipt_ref !== existing.receipt_refs.at(-1) ||
            canonical.final_receipt?.output_manifest.object_ref !== existing.output_manifest_ref) {
          return problem(request, 409, "SESSION_CONFLICT");
        }
      } else if ((existing.state !== "ACTIVE" && existing.state !== "CANCELLED") || existing.investigation_revision !== revision) {
        return problem(request, 409, "SESSION_CONFLICT");
      }
      return json(request, { protocol: RESEARCH_SESSION_PROTOCOL, session_id, state: existing.state,
        operation_id, investigation_ref: { id: investigation_id, revision: existing.investigation_revision } });
    }
    await host.save({ protocol: RESEARCH_SESSION_PROTOCOL, session_id, investigation_id,
      investigation_revision: revision, operation_id, idempotency_key, handler_generation,
      principal_ref: caller.principal_ref, credential_generation: caller.credential_generation,
      deployment_generation: caller.deployment_generation, state: "ACTIVE", receipt_refs: [],
      output_manifest_ref: null, updated_at: new Date().toISOString() });
    return json(request, { protocol: RESEARCH_SESSION_PROTOCOL, session_id, state: "ACTIVE",
      operation_id, investigation_ref: { id: investigation_id, revision } });
  } catch (error) {
    if (error instanceof ResearchServiceError) return problem(request, error.status, error.code);
    if (error instanceof WorkflowCheckpointError) return workflowProblem(request, error);
    return problem(request, 400, "RESEARCH_INPUT_INVALID");
  }
}

export async function readSession(host: SessionProjectionHost, request: Request, sid: string): Promise<Response> {
  const stored = await host.load(sid);
  if (stored === null) return problem(request, 404, "SESSION_NOT_FOUND");
  let caller: WorkflowPrincipal;
  try { caller = callerOf(request); }
  catch { return problem(request, 400, "RESEARCH_INPUT_INVALID"); }
  if (caller.principal_ref !== stored.principal_ref) return problem(request, 403, "SESSION_FOREIGN");
  if (caller.credential_generation !== stored.credential_generation) return problem(request, 409, "SESSION_AUTHORITY_STALE");
  if (!host.env?.CORE_DB) return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
  try { await requireResearchDeploymentCompatibility(host.env.CORE_DB, stored.deployment_generation, caller.deployment_generation); }
  catch { return problem(request, 409, "SESSION_AUTHORITY_STALE"); }
  return json(request, { protocol: RESEARCH_SESSION_PROTOCOL, session_id: sid, state: stored.state,
    operation_id: stored.operation_id, investigation_ref: { id: stored.investigation_id, revision: stored.investigation_revision },
    receipt_refs: [...stored.receipt_refs], output_manifest_ref: stored.output_manifest_ref });
}

export async function executeSession(host: SessionProjectionHost, request: Request, sid: string): Promise<Response> {
  const stored = await host.load(sid);
  if (stored === null) return problem(request, 404, "SESSION_NOT_FOUND");
  let caller: WorkflowPrincipal;
  try { caller = callerOf(request); } catch { return problem(request, 400, "RESEARCH_INPUT_INVALID"); }
  if (caller.principal_ref !== stored.principal_ref) return problem(request, 403, "SESSION_FOREIGN");
  if (caller.credential_generation !== stored.credential_generation) return problem(request, 409, "SESSION_AUTHORITY_STALE");
  const env = host.env;
  if (!env?.CORE_DB || !env.SEARCH_DB || !env.WORK_BUCKET) return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
  try { await requireResearchDeploymentCompatibility(env.CORE_DB, stored.deployment_generation, caller.deployment_generation); }
  catch { return problem(request, 409, "SESSION_AUTHORITY_STALE"); }

  const principal: WorkflowPrincipal = { principal_ref: stored.principal_ref, credential_generation: stored.credential_generation, deployment_generation: stored.deployment_generation };
  const checkpoints = new WorkflowCheckpointStore(env.CORE_DB);
  const persisted = await checkpoints.readRunStatus(stored.operation_id, principal, "owner-read");
  if (persisted === null) {
    const authority = await readCurrentSessionAuthority(env, caller, stored.investigation_id);
    if (authority === "STALE") return problem(request, 409, "SESSION_AUTHORITY_STALE");
    if (authority === "UNAVAILABLE") return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
    return sessionReopenRequired(request, sid, stored.operation_id);
  }

  const projection = await readResearchRunStatus(env, sessionRunContext(request, caller), stored.operation_id);
  if (projection.workflow_instance_id !== stored.operation_id || projection.investigation_ref.id !== stored.investigation_id) {
    return problem(request, 409, "SESSION_AUTHORITY_STALE");
  }
  if (projection.execution_state === "ACTIVE") {
    if (stored.state !== "ACTIVE") return problem(request, 409, "SESSION_CONFLICT");
    if (projection.engine_status === undefined || projection.engine_status === "unknown") {
      return sessionReopenRequired(request, sid, stored.operation_id);
    }
    return json(request, { protocol: RESEARCH_SESSION_PROTOCOL, session_id: sid, state: "ACTIVE",
      operation_id: stored.operation_id, investigation_ref: projection.investigation_ref, run_status: projection });
  }
  if (projection.execution_state === "CANCELLED") {
    if (stored.state === "ENGINE_COMPLETED") return problem(request, 409, "SESSION_CONFLICT");
    const cancelled = await checkpoints.readRunStatus(stored.operation_id, principal, "owner-read");
    if (cancelled?.state !== "CANCELLED" || cancelled.cancellation_receipt_ref === null ||
        projection.cancellation_receipt_ref !== cancelled.cancellation_receipt_ref) {
      return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
    }
    if (stored.state === "ACTIVE") await host.settleTerminal(stored, { state: "CANCELLED" });
    return problem(request, 409, "SESSION_CANCELLED");
  }
  if (stored.state === "CANCELLED") return problem(request, 409, "SESSION_CONFLICT");
  const completed = await checkpoints.readRunStatus(stored.operation_id, principal, "owner-read");
  const finalReceipt = completed?.final_receipt;
  if (completed?.state !== "ENGINE_COMPLETED" || finalReceipt == null ||
      completed.investigation_id !== stored.investigation_id ||
      completed.current_revision !== projection.investigation_ref.revision ||
      finalReceipt.engine_state !== "ENGINE_COMPLETED" || finalReceipt.stage !== "MATERIALIZE" ||
      finalReceipt.investigation_ref.id !== stored.investigation_id ||
      finalReceipt.investigation_ref.revision !== completed.current_revision) {
    return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
  }
  if (new TextEncoder().encode(JSON.stringify(finalReceipt)).byteLength > MAX_WORKFLOW_RECEIPT_BYTES ||
      "completion_disposition" in finalReceipt) return problem(request, 409, "WORKFLOW_INPUT_INVALID");
  if (stored.state === "ENGINE_COMPLETED" &&
      (stored.receipt_refs.at(-1) !== finalReceipt.receipt_ref ||
        stored.output_manifest_ref !== finalReceipt.output_manifest.object_ref)) {
    return problem(request, 409, "SESSION_CONFLICT");
  }
  const receiptRefs = stored.state === "ENGINE_COMPLETED" ? [...stored.receipt_refs] : [finalReceipt.receipt_ref];
  if (stored.state === "ACTIVE") await host.settleTerminal(stored, {
    state: "ENGINE_COMPLETED", investigation_revision: finalReceipt.investigation_ref.revision,
    receipt_refs: receiptRefs, output_manifest_ref: finalReceipt.output_manifest.object_ref,
  });
  return json(request, {
    protocol: RESEARCH_SESSION_PROTOCOL, session_id: sid, state: "ENGINE_COMPLETED",
    operation_id: stored.operation_id, investigation_ref: finalReceipt.investigation_ref,
    receipt_refs: receiptRefs, output_manifest_ref: finalReceipt.output_manifest.object_ref,
    final_receipt: finalReceipt,
  });
}

export async function cancelSession(host: SessionProjectionHost, request: Request, sid: string): Promise<Response> {
  const stored = await host.load(sid);
  if (stored === null) return problem(request, 404, "SESSION_NOT_FOUND");
  let caller: WorkflowPrincipal;
  try { caller = callerOf(request); }
  catch { return problem(request, 400, "RESEARCH_INPUT_INVALID"); }
  if (caller.principal_ref !== stored.principal_ref) return problem(request, 403, "SESSION_FOREIGN");
  if (caller.credential_generation !== stored.credential_generation) {
    return problem(request, 409, "SESSION_AUTHORITY_STALE");
  }
  if (!host.env?.CORE_DB) return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
  try { await requireResearchDeploymentCompatibility(host.env.CORE_DB, stored.deployment_generation, caller.deployment_generation); }
  catch { return problem(request, 409, "SESSION_AUTHORITY_STALE"); }
  const storedPrincipal: WorkflowPrincipal = { principal_ref: stored.principal_ref,
    credential_generation: stored.credential_generation, deployment_generation: stored.deployment_generation };
  const store = new WorkflowCheckpointStore(host.env.CORE_DB);
  const before = await store.readRunStatus(stored.operation_id, storedPrincipal);
  if (before === null) return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
  if (before.state === "ENGINE_COMPLETED") return problem(request, 409, "SESSION_CONFLICT");
  const cancellationReceipt = await store.cancel(stored.operation_id, storedPrincipal);
  const after = await store.readRunStatus(stored.operation_id, storedPrincipal);
  if (after?.state !== "CANCELLED" || after.cancellation_receipt_ref !== cancellationReceipt) {
    return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
  }
  await host.settleTerminal(stored, { state: "CANCELLED" });
  return json(request, { protocol: RESEARCH_SESSION_PROTOCOL, session_id: sid,
    state: "CANCELLED", operation_id: stored.operation_id, cancellation_receipt_ref: cancellationReceipt });
}
