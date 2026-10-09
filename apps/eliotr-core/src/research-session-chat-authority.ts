import type { ResearchEngineStatus } from "@eliotr/interfaces";

export const SESSION_CHAT_BINDING_KEY = "research-session-chat-binding:v1";
export const RESEARCH_SESSION_PROJECTION_PROTOCOL = "eliotr.research-session-projection.v1";

export interface SessionChatBinding {
  protocol: "eliotr.research-session-chat-binding.v1";
  session_id: string;
  investigation_id: string;
  operation_id: string;
  handler_generation: string;
  principal_ref: string;
  credential_generation: string;
  deployment_generation: string;
}

export interface SessionChatAuthorization {
  readonly binding: SessionChatBinding;
  readonly scope_expires_at: string;
  readonly grant_expires_at: string;
}

export interface SessionChatConnectionState {
  research_session?: SessionChatBinding;
  research_access_expires_at?: string;
  research_authority_expires_at?: string;
  [key: string]: unknown;
}

export type ResearchSessionProjection =
  | {
    readonly protocol: typeof RESEARCH_SESSION_PROJECTION_PROTOCOL;
    readonly session_id: string;
    readonly operation_id: string;
    readonly state: "ACTIVE";
    readonly investigation_ref: { readonly id: string; readonly revision: number };
    readonly run_status: {
      readonly execution_state: "ACTIVE";
      readonly engine_status: Exclude<ResearchEngineStatus, "unknown">;
      readonly next_stage_index: number;
    };
  }
  | {
    readonly protocol: typeof RESEARCH_SESSION_PROJECTION_PROTOCOL;
    readonly session_id: string;
    readonly operation_id: string;
    readonly state: "CANCELLED";
    readonly investigation_ref: { readonly id: string; readonly revision: number };
    readonly cancellation_receipt_ref: string;
  }
  | {
    readonly protocol: typeof RESEARCH_SESSION_PROJECTION_PROTOCOL;
    readonly session_id: string;
    readonly operation_id: string;
    readonly state: "ENGINE_COMPLETED";
    readonly investigation_ref: { readonly id: string; readonly revision: number };
    readonly completion_receipt_ref: string;
    readonly output_manifest_ref: string;
  };

const ENGINE_STATUSES: readonly Exclude<ResearchEngineStatus, "unknown">[] = [
  "queued", "running", "paused", "errored", "terminated", "complete", "waiting", "waitingForPause",
];

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isProjectionInvestigationRef(value: unknown): value is { id: string; revision: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return exactKeys(ref, ["id", "revision"]) && typeof ref.id === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(ref.id) &&
    Number.isSafeInteger(ref.revision) && (ref.revision as number) >= 1;
}

export function isResearchSessionProjection(value: unknown): value is ResearchSessionProjection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const projection = value as Record<string, unknown>;
  if (projection.protocol !== RESEARCH_SESSION_PROJECTION_PROTOCOL ||
      typeof projection.session_id !== "string" || typeof projection.operation_id !== "string" ||
      !isProjectionInvestigationRef(projection.investigation_ref)) return false;

  if (projection.state === "ACTIVE") {
    if (!exactKeys(projection, ["protocol", "session_id", "operation_id", "state", "investigation_ref", "run_status"]) ||
        typeof projection.run_status !== "object" || projection.run_status === null || Array.isArray(projection.run_status)) return false;
    const status = projection.run_status as Record<string, unknown>;
    return exactKeys(status, ["execution_state", "engine_status", "next_stage_index"]) &&
      status.execution_state === "ACTIVE" && ENGINE_STATUSES.includes(status.engine_status as Exclude<ResearchEngineStatus, "unknown">) &&
      Number.isSafeInteger(status.next_stage_index) && (status.next_stage_index as number) >= 0;
  }
  if (projection.state === "CANCELLED") {
    return exactKeys(projection, ["protocol", "session_id", "operation_id", "state", "investigation_ref", "cancellation_receipt_ref"]) &&
      typeof projection.cancellation_receipt_ref === "string" && projection.cancellation_receipt_ref.length > 0;
  }
  if (projection.state === "ENGINE_COMPLETED") {
    return exactKeys(projection, ["protocol", "session_id", "operation_id", "state", "investigation_ref", "completion_receipt_ref", "output_manifest_ref"]) &&
      typeof projection.completion_receipt_ref === "string" && projection.completion_receipt_ref.length > 0 &&
      typeof projection.output_manifest_ref === "string" && projection.output_manifest_ref.length > 0;
  }
  return false;
}

export class SessionProjectionReadError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

interface SessionChatRecord {
  session_id: string;
  investigation_id: string;
  operation_id: string;
  handler_generation: string;
  principal_ref: string;
  credential_generation: string;
  deployment_generation: string;
}

export function sessionChatBindingFor(record: SessionChatRecord): SessionChatBinding {
  return {
    protocol: "eliotr.research-session-chat-binding.v1",
    session_id: record.session_id,
    investigation_id: record.investigation_id,
    operation_id: record.operation_id,
    handler_generation: record.handler_generation,
    principal_ref: record.principal_ref,
    credential_generation: record.credential_generation,
    deployment_generation: record.deployment_generation,
  };
}

export function sameSessionChatBinding(value: unknown, expected: SessionChatBinding): value is SessionChatBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = ["protocol", "session_id", "investigation_id", "operation_id", "handler_generation",
    "principal_ref", "credential_generation", "deployment_generation"] as const;
  return Object.keys(record).length === keys.length && keys.every((key) => record[key] === expected[key]);
}

function decodeSessionId(value: string, isValidId: (value: string) => boolean): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return isValidId(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export function sessionIdForAgentRequest(url: URL, isValidId: (value: string) => boolean): string | null {
  const queryValues = url.searchParams.getAll("session_id");
  if (queryValues.length > 1) return null;
  // URLSearchParams has already decoded this value; decoding twice changes its identity.
  const queryId = queryValues[0];
  if (queryId !== undefined && !isValidId(queryId)) return null;
  const sessionPath = url.pathname.match(/^\/session\/([^/]+)\//u);
  const segments = url.pathname.split("/").filter(Boolean);
  const agentId = segments[0]?.toLowerCase() === "agents" &&
      (segments[1]?.toLowerCase() === "researchsession" || segments[1]?.toLowerCase() === "research-session") &&
      segments[2] !== undefined ? segments[2] : undefined;
  const pathId = sessionPath?.[1] ?? agentId;
  if (pathId === undefined) return queryId ?? null;
  const decoded = decodeSessionId(pathId, isValidId);
  return decoded !== null && (queryId === undefined || queryId === decoded) ? decoded : null;
}

export function sessionProjectionRequest(request: Request, sessionId: string): Request {
  const headers = new Headers();
  for (const name of ["x-research-principal", "x-research-credential", "x-research-deployment",
    "x-research-access-expires-at", "cf-ray"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Request(new URL(`/session/${encodeURIComponent(sessionId)}/projection`, request.url), {
    method: "GET",
    headers,
  });
}

function sessionChatRequest(binding: SessionChatBinding, accessExpiresAt: string): Request {
  const headers = new Headers({
    "x-research-principal": binding.principal_ref,
    "x-research-credential": binding.credential_generation,
    "x-research-deployment": binding.deployment_generation,
    "x-research-access-expires-at": accessExpiresAt,
  });
  return new Request(`https://research-session.invalid/status?session_id=${encodeURIComponent(binding.session_id)}`, { headers });
}

export async function readCurrentSessionChatProjection(
  binding: SessionChatBinding,
  accessExpiresAt: string,
  readback: (request: Request, sessionId: string) => Promise<Response>,
): Promise<ResearchSessionProjection> {
  const request = sessionChatRequest(binding, accessExpiresAt);
  const response = await readback(sessionProjectionRequest(request, binding.session_id), binding.session_id);
  const body = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
  if (response.status !== 200) {
    const code = typeof body?.code === "string" ? body.code : "SESSION_AUTHORITY_STALE";
    throw new SessionProjectionReadError(response.status, code);
  }
  if (!isResearchSessionProjection(body) || body.session_id !== binding.session_id ||
      body.operation_id !== binding.operation_id || body.investigation_ref.id !== binding.investigation_id) {
    throw new SessionProjectionReadError(409, "SESSION_AUTHORITY_STALE");
  }
  return body;
}
