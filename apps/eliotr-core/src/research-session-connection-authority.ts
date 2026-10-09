import type { Connection } from "agents";
import type { SessionChatConnectionState } from "./research-session-chat-authority.js";

// Written only by the outer Access-authenticated transport after removing caller headers.
export const SESSION_ACCESS_EXPIRY_HEADER = "x-research-access-expires-at";

export function sessionAccessExpiresAt(request: Request): string | null {
  const value = request.headers.get(SESSION_ACCESS_EXPIRY_HEADER);
  return value !== null && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now() ? value : null;
}

export function requireCurrentSessionConnection(connection: Connection<SessionChatConnectionState>): boolean {
  const expiresAt = connection.state?.research_access_expires_at;
  if (typeof expiresAt === "string" && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) > Date.now()) return true;
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
