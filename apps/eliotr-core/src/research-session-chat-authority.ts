import { WorkflowCheckpointStore } from "@eliotr/cloudflare-research";
import type { WorkflowPrincipal } from "@eliotr/cloudflare-research";

export const SESSION_CHAT_BINDING_KEY = "research-session-chat-binding:v1";

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
  for (const name of ["x-research-principal", "x-research-credential", "x-research-deployment", "cf-ray"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Request(new URL(`/session/${encodeURIComponent(sessionId)}/run`, request.url), {
    method: "POST",
    headers,
  });
}

function sessionChatRequest(binding: SessionChatBinding): Request {
  const headers = new Headers({
    "x-research-principal": binding.principal_ref,
    "x-research-credential": binding.credential_generation,
    "x-research-deployment": binding.deployment_generation,
  });
  return new Request(`https://research-session.invalid/status?session_id=${encodeURIComponent(binding.session_id)}`, { headers });
}

export async function readCurrentSessionChatProjection(
  binding: SessionChatBinding,
  coreDatabase: D1Database | undefined,
  execute: (request: Request, sessionId: string) => Promise<Response>,
  protocol: string,
): Promise<unknown> {
  const request = sessionChatRequest(binding);
  const projected = await execute(sessionProjectionRequest(request, binding.session_id), binding.session_id);
  const body = await projected.clone().json().catch(() => null) as Record<string, unknown> | null;
  if (projected.status === 200 && body !== null) return body;
  if (body?.code === "SESSION_CANCELLED" && coreDatabase) {
    const principal: WorkflowPrincipal = {
      principal_ref: binding.principal_ref,
      credential_generation: binding.credential_generation,
      deployment_generation: binding.deployment_generation,
    };
    const canonical = await new WorkflowCheckpointStore(coreDatabase)
      .readRunStatus(binding.operation_id, principal, "owner-read");
    if (canonical?.state === "CANCELLED" && canonical.investigation_id === binding.investigation_id &&
        canonical.cancellation_receipt_ref !== null) {
      return {
        protocol,
        session_id: binding.session_id,
        state: "CANCELLED",
        operation_id: binding.operation_id,
        cancellation_receipt_ref: canonical.cancellation_receipt_ref,
      };
    }
  }
  throw new Error(typeof body?.code === "string" ? body.code : "SESSION_AUTHORITY_STALE");
}
