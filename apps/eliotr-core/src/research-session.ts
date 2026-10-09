// IMPLEMENTED_NOT_LIVE: ER-24 ResearchSession exposes a read-only Agent RPC projection over canonical Workflow/D1 status; native, browser, multi-tab and live qualification remain pending.
import { Agent, callable, getCurrentAgent } from "agents";
import type { Connection, ConnectionContext } from "agents";
import {
  WorkflowCheckpointStore,
  WorkflowObjectSchema,
  MAX_WORKFLOW_RECEIPT_BYTES,
  WorkflowCheckpointError,
} from "@eliotr/cloudflare-research";
import type { WorkflowPrincipal } from "@eliotr/cloudflare-research";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { ResearchServiceError, failResearch as fail } from "./research-service-error.js";
export { ResearchServiceError } from "./research-service-error.js";
import type { Env } from "./env.js";
import { requireResearchDeploymentCompatibility } from "./research-deployment-compatibility.js";
export type { McpFastSearchQueryResult } from "./research-query-execution-result.js";
import {
  SESSION_CHAT_BINDING_KEY,
  RESEARCH_SESSION_PROJECTION_PROTOCOL,
  isResearchSessionProjection,
  readCurrentSessionChatProjection,
  SessionProjectionReadError,
  sameSessionChatBinding,
  sessionChatBindingFor,
  sessionIdForAgentRequest,
} from "./research-session-chat-authority.js";
import type {
  ResearchSessionProjection,
  SessionChatAuthorization,
  SessionChatBinding,
  SessionChatConnectionState,
} from "./research-session-chat-authority.js";
import { readCurrentSessionAuthority, readCurrentSessionAuthorityWithExpiry } from "./research-session-current-authority.js";
import {
  createSessionConnectionSendGuard,
  minimumSessionConnectionDeadline,
  requireCurrentSessionConnection,
  sessionConnectionDeadline,
  sessionAccessExpiresAt,
} from "./research-session-connection-authority.js";
import { checkId, ID_RE, readResearchRunStatus } from "./research-run-service.js";
export {
  FAST_SEARCH_PROFILE,
  RETRIEVAL_SCOPE_MAX_RESULTS,
  RETRIEVAL_SCOPE_MAX_SOURCES,
  RETRIEVAL_SCOPE_PROFILE_VERSION,
  createResearchQueryService,
  createResearchRunService,
  parseResearchQueryRequest,
  parseResearchRunRequest,
} from "./research-run-service.js";
export type { ResearchQueryOptions } from "./research-run-service.js";
export const RESEARCH_SESSION_PROTOCOL = "eliotr.research-session.v1";
interface SessionRecord { protocol: typeof RESEARCH_SESSION_PROTOCOL; session_id: string; investigation_id: string; investigation_revision: number; operation_id: string; idempotency_key: string; handler_generation: string; principal_ref: string; credential_generation: string; deployment_generation: string; state: "ACTIVE" | "CANCELLED" | "ENGINE_COMPLETED"; receipt_refs: readonly string[]; output_manifest_ref: string | null; updated_at: string; }
function callerOf(request: Request, body?: Record<string, unknown>): WorkflowPrincipal { const pick = (name: string, fallback?: unknown) => request.headers.get(name) ?? (typeof fallback === "string" ? fallback : undefined); const principal_ref = pick("x-research-principal", body?.principal_ref); const credential_generation = pick("x-research-credential", body?.credential_generation); const deployment_generation = pick("x-research-deployment", body?.deployment_generation); if (typeof principal_ref !== "string" || typeof credential_generation !== "string" || typeof deployment_generation !== "string") fail("RESEARCH_INPUT_INVALID", "research session caller identity is required"); return { principal_ref, credential_generation, deployment_generation }; }
function sessionRunContext(request: Request, caller: WorkflowPrincipal, traceFallback: string = crypto.randomUUID()): AuthenticatedRequestContext { return { request, principal_ref: caller.principal_ref, client_class: "owner_pwa", credential_generation: caller.credential_generation, trace_id: request.headers.get("cf-ray") ?? traceFallback }; }
function sessionReopenRequired(request: Request, sessionId: string, operationId: string): Response { return json(request, { code: "SESSION_AUTHORITY_STALE", reason_code: "SESSION_REOPEN_REQUIRED", protocol: RESEARCH_SESSION_PROTOCOL, session_id: sessionId, operation_id: operationId, state: "BLOCKED", disposition: "REOPEN_REQUIRED", trace_id: request.headers.get("cf-ray") ?? crypto.randomUUID(), retryable: false }, 409); }
function json(request: Request, value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
function problem(request: Request, status: number, code: string, retryable = status === 503): Response { return json(request, { code, trace_id: request.headers.get("cf-ray") ?? crypto.randomUUID(), retryable }, status); }
function workflowProblem(request: Request, error: WorkflowCheckpointError): Response {
  const code = error.failure?.code ?? error.code;
  const conflict = ["WORKFLOW_CONFLICT", "WORKFLOW_STAGE_OUT_OF_ORDER", "WORKFLOW_AUTHORITY_STALE", "WORKFLOW_CANCELLED", "WORKFLOW_BUDGET_STOP"].includes(error.code);
  return problem(request, error.code === "WORKFLOW_INPUT_INVALID" ? 400 : conflict ? 409 : 503,
    code, error.failure?.retryable === true);
}
function isProjectionRpcRequest(frame: unknown): boolean {
  if (typeof frame !== "string") return false;
  let value: unknown;
  try { value = JSON.parse(frame); }
  catch { return false; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return Object.keys(request).length === 4 &&
    ["type", "id", "method", "args"].every((key) => Object.hasOwn(request, key)) &&
    request.type === "rpc" && typeof request.id === "string" && request.id.length > 0 && request.id.length <= 256 &&
    request.method === "readResearchSessionProjection" && Array.isArray(request.args) && request.args.length === 0;
}
function isProjectionRpcResponse(message: string | ArrayBuffer | ArrayBufferView | Blob): boolean {
  if (typeof message !== "string") return false;
  let value: unknown;
  try { value = JSON.parse(message); }
  catch { return false; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return Object.keys(response).length === 5 &&
    ["type", "id", "success", "done", "result"].every((key) => Object.hasOwn(response, key)) &&
    response.type === "rpc" && typeof response.id === "string" && response.id.length > 0 && response.id.length <= 256 &&
    response.success === true && response.done === true && isResearchSessionProjection(response.result);
}
function projectionErrorResponse(request: Request, error: unknown): Response {
  if (!(error instanceof SessionProjectionReadError)) {
    return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
  }
  const codes = new Set(["SESSION_NOT_FOUND", "SESSION_FOREIGN", "SESSION_AUTHORITY_STALE",
    "SESSION_SETTLEMENT_UNCERTAIN", "SESSION_CONFLICT", "RESEARCH_INPUT_INVALID"]);
  const code = codes.has(error.code) ? error.code : "SESSION_AUTHORITY_STALE";
  const status = error.status === 400 || error.status === 403 || error.status === 404 ||
    error.status === 409 || error.status === 422 || error.status === 503 ? error.status : 409;
  return problem(request, status, code, status === 503);
}
export class ResearchSession extends Agent<Env> {
  private readonly guardConnectionSend = createSessionConnectionSendGuard();
  private readonly guardedProjectionConnections = new WeakSet<Connection<SessionChatConnectionState>>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Reattach guards after hibernation, before restored RPC connections can send.
    for (const connection of this.getConnections<SessionChatConnectionState>()) {
      this.guardProjectionConnectionSend(connection);
      this.guardConnectionSend(connection);
      requireCurrentSessionConnection(connection);
    }
    const connect = this.onConnect.bind(this);
    this.onConnect = async (connection: Connection<SessionChatConnectionState>, context) => {
      if (sessionAccessExpiresAt(context.request) === null) { connection.close(1008, "SESSION_AUTHORITY_STALE"); return; }
      this.guardConnectionSend(connection);
      if (!await this.bindChatConnection(connection, context)) return;
      try {
        const deadline = sessionConnectionDeadline(connection.state);
        if (deadline === null || deadline.expires_at_ms <= Date.now()) {
          requireCurrentSessionConnection(connection);
          return;
        }
        // Agents stores Date schedules in epoch seconds using floor; round up so cleanup never precedes expiry.
        const scheduledAtMs = Math.ceil(deadline.expires_at_ms / 1_000) * 1_000;
        await this.schedule(new Date(scheduledAtMs),
          "expireResearchSessionConnections", { connection_id: connection.id, expires_at: deadline.expires_at }, { idempotent: true });
        if (requireCurrentSessionConnection(connection)) await connect(connection, context);
      } catch (error) {
        connection.close(1008, "SESSION_AUTHORITY_STALE");
        throw error;
      }
    };
    const message = this.onMessage.bind(this);
    this.onMessage = async (connection: Connection<SessionChatConnectionState>, frame) => {
      this.guardProjectionConnectionSend(connection);
      this.guardConnectionSend(connection);
      if (!requireCurrentSessionConnection(connection)) return;
      if (!isProjectionRpcRequest(frame)) {
        connection.close(1008, "SESSION_PROJECTION_READ_ONLY");
        return;
      }
      await message(connection, frame);
    };
    const start = this.onStart.bind(this);
    this.onStart = async (props) => {
      // Connection attachments survive hibernation; function guards do not.
      for (const connection of this.getConnections<SessionChatConnectionState>()) {
        this.guardConnectionSend(connection);
        await this.authorizeConnectedChat(connection);
      }
      await start(props);
    };
  }
  public override shouldSendProtocolMessages(connection: Connection, _context: ConnectionContext): boolean {
    this.guardProjectionConnectionSend(connection as Connection<SessionChatConnectionState>);
    return false;
  }
  public override validateStateChange(_state: unknown, source: Connection | "server"): void {
    if (source !== "server") throw new Error("SESSION_PROJECTION_READ_ONLY");
  }
  private guardProjectionConnectionSend(connection: Connection<SessionChatConnectionState>): void {
    if (this.guardedProjectionConnections.has(connection)) return;
    const send = connection.send.bind(connection);
    connection.send = (message) => {
      if (!isProjectionRpcResponse(message) || !requireCurrentSessionConnection(connection)) return;
      Reflect.apply(send, connection, [message]);
    };
    this.guardedProjectionConnections.add(connection);
  }
  public expireResearchSessionConnections(expected?: { connection_id: string; expires_at: string }): void {
    for (const connection of this.getConnections<SessionChatConnectionState>()) {
      if (expected === undefined || (connection.id === expected.connection_id &&
          sessionConnectionDeadline(connection.state)?.expires_at === expected.expires_at)) requireCurrentSessionConnection(connection);
    }
  }
  private load(id: string): Promise<SessionRecord | null> { return this.ctx.storage.get<SessionRecord>(`session:${id}`).then((value) => value ?? null); }
  private save(record: SessionRecord): Promise<void> { if (new TextEncoder().encode(JSON.stringify(record)).byteLength > 256 * 1024) fail("RESEARCH_INPUT_LIMIT", "session state exceeds its persist bound", 413); return this.ctx.storage.put(`session:${record.session_id}`, record); }
  private async settleTerminal(
    expected: SessionRecord,
    change: Pick<SessionRecord, "state"> & Partial<Pick<SessionRecord, "investigation_revision" | "receipt_refs" | "output_manifest_ref">>,
  ): Promise<SessionRecord> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = `session:${expected.session_id}`;
      const current = await transaction.get<SessionRecord>(key);
      if (current === undefined || current.operation_id !== expected.operation_id ||
          current.investigation_id !== expected.investigation_id || current.principal_ref !== expected.principal_ref ||
          current.credential_generation !== expected.credential_generation ||
          current.deployment_generation !== expected.deployment_generation) {
        throw new WorkflowCheckpointError("WORKFLOW_AUTHORITY_STALE");
      }
      if (current.state !== "ACTIVE") {
        if (current.state !== change.state) throw new WorkflowCheckpointError("WORKFLOW_CONFLICT");
        return current;
      }
      const next: SessionRecord = { ...current, ...change, updated_at: new Date().toISOString() };
      if (new TextEncoder().encode(JSON.stringify(next)).byteLength > 256 * 1024) {
        fail("RESEARCH_INPUT_LIMIT", "session state exceeds its persist bound", 413);
      }
      await transaction.put(key, next);
      return next;
    });
  }
  private async authorizeChatRequest(request: Request, sessionId: string): Promise<SessionChatAuthorization | Response> {
    const record = await this.load(sessionId);
    if (record === null) return problem(request, 404, "SESSION_NOT_FOUND");
    let caller: WorkflowPrincipal;
    try { caller = callerOf(request); }
    catch { return problem(request, 400, "RESEARCH_INPUT_INVALID"); }
    if (caller.principal_ref !== record.principal_ref ||
        caller.credential_generation !== record.credential_generation ||
        caller.deployment_generation !== record.deployment_generation) {
      return problem(request, 409, "SESSION_AUTHORITY_STALE");
    }

    const env = this.env;
    if (!env?.CORE_DB || !env.SEARCH_DB) return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
    const accessExpiresAt = sessionAccessExpiresAt(request);
    if (accessExpiresAt === null) return problem(request, 409, "SESSION_AUTHORITY_STALE");
    const authority = await readCurrentSessionAuthorityWithExpiry(env, caller, record.investigation_id);
    if (authority.status === "STALE") return problem(request, 409, "SESSION_AUTHORITY_STALE");
    if (authority.status === "UNAVAILABLE") return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");

    const expected = sessionChatBindingFor(record);
    const existing = await this.ctx.storage.get<unknown>(SESSION_CHAT_BINDING_KEY);
    if (existing !== undefined && !sameSessionChatBinding(existing, expected)) return problem(request, 409, "SESSION_CONFLICT");
    try { await this.readCurrentChatProjection(expected, accessExpiresAt); }
    catch (error) { return projectionErrorResponse(request, error); }
    const binding = await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<unknown>(SESSION_CHAT_BINDING_KEY);
      if (current === undefined) {
        await transaction.put(SESSION_CHAT_BINDING_KEY, expected);
        return expected;
      }
      return sameSessionChatBinding(current, expected) ? expected : null;
    });
    if (binding === null) return problem(request, 409, "SESSION_CONFLICT");
    return {
      binding,
      scope_expires_at: authority.scope_expires_at,
      grant_expires_at: authority.grant_expires_at,
    };
  }
  private async readCurrentChatProjection(
    binding: SessionChatBinding,
    accessExpiresAt: string,
  ): Promise<ResearchSessionProjection> {
    return readCurrentSessionChatProjection(
      binding,
      accessExpiresAt,
      (request) => this.fetch(request),
    );
  }
  private async readConnectedProjection(
    connection: Connection<SessionChatConnectionState>,
  ): Promise<ResearchSessionProjection> {
    if (!requireCurrentSessionConnection(connection)) throw new Error("SESSION_AUTHORITY_STALE");
    const binding = connection.state?.research_session;
    const accessExpiresAt = connection.state?.research_access_expires_at;
    try {
      const record = binding === undefined ? null : await this.load(binding.session_id);
      if (binding === undefined || typeof accessExpiresAt !== "string" || record === null ||
          !sameSessionChatBinding(binding, sessionChatBindingFor(record))) {
        throw new Error("SESSION_AUTHORITY_STALE");
      }
      const projection = await this.readCurrentChatProjection(binding, accessExpiresAt);
      if (!requireCurrentSessionConnection(connection)) throw new Error("SESSION_AUTHORITY_STALE");
      return projection;
    } catch {
      connection.close(1008, "SESSION_AUTHORITY_STALE");
      throw new Error("SESSION_AUTHORITY_STALE");
    }
  }
  private async authorizeConnectedChat(connection: Connection<SessionChatConnectionState>): Promise<boolean> {
    try { await this.readConnectedProjection(connection); return true; }
    catch {
      connection.close(1008, "SESSION_AUTHORITY_STALE");
      return false;
    }
  }
  @callable({ description: "Read the current canonical research session projection." })
  public async readResearchSessionProjection(): Promise<ResearchSessionProjection> {
    const current = getCurrentAgent<ResearchSession>();
    if (current.agent !== this || current.connection === undefined) throw new Error("SESSION_AUTHORITY_STALE");
    return this.readConnectedProjection(current.connection as Connection<SessionChatConnectionState>);
  }
  private async bindChatConnection(
    connection: Connection<SessionChatConnectionState>,
    context: ConnectionContext,
  ): Promise<boolean> {
    const sessionId = sessionIdForAgentRequest(new URL(context.request.url), (value) => ID_RE.test(value));
    if (sessionId === null) {
      connection.close(1008, "SESSION_AUTHORITY_STALE");
      return false;
    }
    const accessExpiresAt = sessionAccessExpiresAt(context.request);
    if (accessExpiresAt === null) {
      connection.close(1008, "SESSION_AUTHORITY_STALE");
      return false;
    }
    let authorization: SessionChatAuthorization | Response;
    try { authorization = await this.authorizeChatRequest(context.request, sessionId); }
    catch {
      connection.close(1008, "SESSION_AUTHORITY_STALE");
      return false;
    }
    if (authorization instanceof Response) {
      connection.close(1008, "SESSION_AUTHORITY_STALE");
      return false;
    }
    const deadline = minimumSessionConnectionDeadline(
      accessExpiresAt,
      authorization.scope_expires_at,
      authorization.grant_expires_at,
    );
    if (deadline === null) {
      connection.close(1008, "SESSION_AUTHORITY_STALE");
      return false;
    }
    const previous = connection.state;
    connection.setState({
      ...(typeof previous === "object" && previous !== null ? previous : {}),
      research_session: authorization.binding,
      research_access_expires_at: accessExpiresAt,
      research_authority_expires_at: deadline.expires_at,
    });
    return true;
  }
public override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.endsWith("/get-messages")) {
        return problem(request, 410, "SESSION_CHAT_HISTORY_DISABLED", false);
      }
      if (url.pathname === "/status") {
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          if (sessionAccessExpiresAt(request) === null) return problem(request, 409, "SESSION_AUTHORITY_STALE");
          const sessionId = sessionIdForAgentRequest(url, (value) => ID_RE.test(value));
          if (sessionId === null) return problem(request, 400, "RESEARCH_INPUT_INVALID");
          const binding = await this.authorizeChatRequest(request, sessionId);
          if (binding instanceof Response) return binding;
          // Validate the owner binding before the Agent accepts the read-only RPC socket.
          return await super.fetch(request);
        }
        return json(request, { protocol: RESEARCH_SESSION_PROTOCOL, state: "READY",
          persisted_state_authoritative: true, durable_copy_location: "DO storage + D1 Core + R2 checkpoints" });
      }
      if (url.pathname === "/session/start" && request.method === "POST") return await this.start(request);
      const match = url.pathname.match(/^\/session\/([^/]+)(\/(run|cancel|projection))?$/u);
      const sessionId = match?.[1];
      if (sessionId !== undefined) {
        checkId(sessionId, "session_id");
        if (request.method === "GET" && (match?.[2] ?? null) === null) return await this.read(request, sessionId);
        if (request.method === "GET" && match?.[3] === "projection") {
          if (sessionAccessExpiresAt(request) === null) return problem(request, 409, "SESSION_AUTHORITY_STALE");
          return await this.project(request, sessionId);
        }
        if (request.method === "POST" && match?.[3] === "run") return await this.execute(request, sessionId);
        if (request.method === "POST" && match?.[3] === "cancel") return await this.cancel(request, sessionId);
      }
      const isAgentRequest = request.headers.get("upgrade")?.toLowerCase() === "websocket" ||
        url.pathname.startsWith("/agents/") || url.pathname.endsWith("/get-messages") ||
        /^\/session\/[^/]+\/chat(?:\/|$)/u.test(url.pathname);
      if (!isAgentRequest) return problem(request, 501, "SESSION_IMPLEMENTATION_PENDING");
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return problem(request, 410, "SESSION_PROJECTION_PROTOCOL_REQUIRED", false);
      }
      if (sessionAccessExpiresAt(request) === null) return problem(request, 409, "SESSION_AUTHORITY_STALE");
      const chatSessionId = sessionIdForAgentRequest(url, (value) => ID_RE.test(value));
      if (chatSessionId === null) return problem(request, 400, "RESEARCH_INPUT_INVALID");
      const binding = await this.authorizeChatRequest(request, chatSessionId);
      if (binding instanceof Response) return binding;
      // Socket disposal remains presentation-only; domain cancel uses /session/:sid/cancel.
      return await super.fetch(request);
    } catch (error) {
      if (error instanceof ResearchServiceError) return problem(request, error.status, error.code, error.retryable);
      if (error instanceof WorkflowCheckpointError && error.failure !== undefined) return workflowProblem(request, error);
      const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "INTERNAL_ERROR";
      if (code === "WORKFLOW_CONFLICT" || code === "WORKFLOW_CANCELLED" || code === "WORKFLOW_AUTHORITY_STALE" || code === "WORKFLOW_BUDGET_STOP") return problem(request, 409, code);
      if (code.startsWith("WORKFLOW_") || code.startsWith("LEDGER_")) return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
      return problem(request, 500, "INTERNAL_ERROR");
    }
  }
  private async project(request: Request, sid: string): Promise<Response> {
    const stored = await this.load(sid);
    if (stored === null) return problem(request, 404, "SESSION_NOT_FOUND");
    let caller: WorkflowPrincipal;
    try { caller = callerOf(request); }
    catch { return problem(request, 400, "RESEARCH_INPUT_INVALID"); }
    if (caller.principal_ref !== stored.principal_ref) return problem(request, 403, "SESSION_FOREIGN");
    if (caller.credential_generation !== stored.credential_generation) return problem(request, 409, "SESSION_AUTHORITY_STALE");
    const env = this.env;
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
  private async start(request: Request): Promise<Response> {
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
      const existing = await this.load(session_id);
      if (existing !== null) {
        if (existing.protocol !== RESEARCH_SESSION_PROTOCOL || existing.session_id !== session_id ||
            existing.investigation_id !== investigation_id || existing.operation_id !== operation_id ||
            existing.idempotency_key !== idempotency_key || existing.handler_generation !== handler_generation ||
            existing.principal_ref !== caller.principal_ref ||
            existing.credential_generation !== caller.credential_generation ||
            existing.deployment_generation !== caller.deployment_generation) return problem(request, 409, "SESSION_CONFLICT");
        if (existing.state === "ENGINE_COMPLETED") {
          if (!this.env?.CORE_DB) return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
          const canonical = await new WorkflowCheckpointStore(this.env.CORE_DB).readRunStatus(operation_id, caller, "owner-read");
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
      await this.save({ protocol: RESEARCH_SESSION_PROTOCOL, session_id, investigation_id,
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
  private async read(request: Request, sid: string): Promise<Response> {
    const stored = await this.load(sid);
    if (stored === null) return problem(request, 404, "SESSION_NOT_FOUND");
    let caller: WorkflowPrincipal;
    try { caller = callerOf(request); }
    catch { return problem(request, 400, "RESEARCH_INPUT_INVALID"); }
    if (caller.principal_ref !== stored.principal_ref) return problem(request, 403, "SESSION_FOREIGN");
    if (caller.credential_generation !== stored.credential_generation) return problem(request, 409, "SESSION_AUTHORITY_STALE");
    if (!this.env?.CORE_DB) return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
    try { await requireResearchDeploymentCompatibility(this.env.CORE_DB, stored.deployment_generation, caller.deployment_generation); }
    catch { return problem(request, 409, "SESSION_AUTHORITY_STALE"); }
    return json(request, { protocol: RESEARCH_SESSION_PROTOCOL, session_id: sid, state: stored.state,
      operation_id: stored.operation_id, investigation_ref: { id: stored.investigation_id, revision: stored.investigation_revision },
      receipt_refs: [...stored.receipt_refs], output_manifest_ref: stored.output_manifest_ref });
  }
  private async execute(request: Request, sid: string): Promise<Response> {
    const stored = await this.load(sid);
    if (stored === null) return problem(request, 404, "SESSION_NOT_FOUND");
    let caller: WorkflowPrincipal;
    try { caller = callerOf(request); } catch { return problem(request, 400, "RESEARCH_INPUT_INVALID"); }
    if (caller.principal_ref !== stored.principal_ref) return problem(request, 403, "SESSION_FOREIGN");
    if (caller.credential_generation !== stored.credential_generation) return problem(request, 409, "SESSION_AUTHORITY_STALE");
    const env = this.env;
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
      if (stored.state === "ACTIVE") await this.settleTerminal(stored, { state: "CANCELLED" });
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
    if (stored.state === "ACTIVE") await this.settleTerminal(stored, {
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
  private async cancel(request: Request, sid: string): Promise<Response> {
    const stored = await this.load(sid);
    if (stored === null) return problem(request, 404, "SESSION_NOT_FOUND");
    let caller: WorkflowPrincipal;
    try { caller = callerOf(request); }
    catch { return problem(request, 400, "RESEARCH_INPUT_INVALID"); }
    if (caller.principal_ref !== stored.principal_ref) return problem(request, 403, "SESSION_FOREIGN");
    if (caller.credential_generation !== stored.credential_generation) {
      return problem(request, 409, "SESSION_AUTHORITY_STALE");
    }
    if (!this.env?.CORE_DB) return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
    try { await requireResearchDeploymentCompatibility(this.env.CORE_DB, stored.deployment_generation, caller.deployment_generation); }
    catch { return problem(request, 409, "SESSION_AUTHORITY_STALE"); }
    const storedPrincipal: WorkflowPrincipal = { principal_ref: stored.principal_ref,
      credential_generation: stored.credential_generation, deployment_generation: stored.deployment_generation };
    const store = new WorkflowCheckpointStore(this.env.CORE_DB);
    const before = await store.readRunStatus(stored.operation_id, storedPrincipal);
    if (before === null) return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
    if (before.state === "ENGINE_COMPLETED") return problem(request, 409, "SESSION_CONFLICT");
    const cancellationReceipt = await store.cancel(stored.operation_id, storedPrincipal);
    const after = await store.readRunStatus(stored.operation_id, storedPrincipal);
    if (after?.state !== "CANCELLED" || after.cancellation_receipt_ref !== cancellationReceipt) {
      return problem(request, 503, "SESSION_SETTLEMENT_UNCERTAIN");
    }
    await this.settleTerminal(stored, { state: "CANCELLED" });
    return json(request, { protocol: RESEARCH_SESSION_PROTOCOL, session_id: sid,
      state: "CANCELLED", operation_id: stored.operation_id, cancellation_receipt_ref: cancellationReceipt });
  }
}
