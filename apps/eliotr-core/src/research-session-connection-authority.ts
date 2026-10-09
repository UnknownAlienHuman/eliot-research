import type { Connection } from "agents";
import { IsoDateTimeSchema } from "@eliotr/contracts";
import type { SessionChatConnectionState } from "./research-session-chat-authority.js";

// Written only by the outer Access-authenticated transport after removing caller headers.
export const SESSION_ACCESS_EXPIRY_HEADER = "x-research-access-expires-at";

export interface SessionConnectionDeadline {
  readonly expires_at: string;
  readonly expires_at_ms: number;
}

function earliestValidDeadline(values: readonly unknown[]): SessionConnectionDeadline | null {
  let earliest: SessionConnectionDeadline | null = null;
  for (const value of values) {
    const parsed = IsoDateTimeSchema.safeParse(value);
    if (!parsed.success) return null;
    const expiresAtMs = Date.parse(parsed.data);
    if (!Number.isFinite(expiresAtMs)) return null;
    if (earliest === null || expiresAtMs < earliest.expires_at_ms) {
      earliest = { expires_at: parsed.data, expires_at_ms: expiresAtMs };
    }
  }
  return earliest;
}

export function minimumSessionConnectionDeadline(
  accessExpiresAt: unknown,
  scopeExpiresAt: unknown,
  grantExpiresAt: unknown,
): SessionConnectionDeadline | null {
  const deadline = earliestValidDeadline([accessExpiresAt, scopeExpiresAt, grantExpiresAt]);
  return deadline !== null && deadline.expires_at_ms > Date.now() ? deadline : null;
}

export function sessionConnectionDeadline(
  state: SessionChatConnectionState | null | undefined,
): SessionConnectionDeadline | null {
  return earliestValidDeadline([state?.research_access_expires_at, state?.research_authority_expires_at]);
}

export function sessionAccessExpiresAt(request: Request): string | null {
  const value = request.headers.get(SESSION_ACCESS_EXPIRY_HEADER);
  const parsed = IsoDateTimeSchema.safeParse(value);
  if (!parsed.success) return null;
  const expiresAtMs = Date.parse(parsed.data);
  return Number.isFinite(expiresAtMs) && expiresAtMs > Date.now() ? parsed.data : null;
}

export function requireCurrentSessionConnection(connection: Connection<SessionChatConnectionState>): boolean {
  const deadline = sessionConnectionDeadline(connection.state);
  if (deadline !== null && deadline.expires_at_ms > Date.now()) return true;
  connection.close(1008, "SESSION_AUTHORITY_STALE");
  return false;
}

/** Guard direct resume sends as well as broadcasts, including across asynchronous SDK reads. */
export function createSessionConnectionSendGuard(): (connection: Connection<SessionChatConnectionState>) => void {
  const guarded = new WeakSet<Connection<SessionChatConnectionState>>();
  return (connection) => {
    if (guarded.has(connection)) return;
    const send = connection.send.bind(connection);
    connection.send = (message: string | ArrayBuffer | ArrayBufferView | Blob) => {
      if (requireCurrentSessionConnection(connection)) Reflect.apply(send, connection, [message]);
    };
    guarded.add(connection);
  };
}
