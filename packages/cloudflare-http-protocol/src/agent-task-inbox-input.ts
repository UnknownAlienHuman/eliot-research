import { HttpRequestError } from "./http-request-error.js";

export const AGENT_TASK_INBOX_PROTOCOL = "eliotr.agent-inbox.v1" as const;

const SAFE_GRANT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const AGENT_TASK_INBOX_OPERATIONS = [
  "research.agent-task.pull",
  "research.agent-task.progress",
  "research.agent-task.result",
  "research.agent-task.status",
] as const;

export type AgentTaskInboxOperation = typeof AGENT_TASK_INBOX_OPERATIONS[number];

export interface ParsedAgentTaskInboxRequest {
  readonly body: Record<string, unknown>;
  readonly grant_id: string;
}

function deny(code: string, message: string): never {
  throw new HttpRequestError(code, 403, message);
}

function plainObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpRequestError(
      "AGENT_INBOX_INPUT_INVALID",
      400,
      "Agent inbox request body must be a JSON object",
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new HttpRequestError(
      "AGENT_INBOX_INPUT_INVALID",
      400,
      "Agent inbox request body must be a plain JSON object",
    );
  }
  return value as Record<string, unknown>;
}

export function assertAgentTaskInboxRequestSecurity(request: Request, url: URL): void {
  if (request.headers.get("X-Eliotr-Agent-Inbox") !== AGENT_TASK_INBOX_PROTOCOL) {
    deny("AGENT_INBOX_CSRF_DENIED", "Agent inbox protocol marker is required");
  }
  const origin = request.headers.get("Origin");
  if (origin !== url.origin) {
    deny("AGENT_INBOX_ORIGIN_DENIED", "Agent inbox mutations require the exact page origin");
  }
  const referer = request.headers.get("Referer");
  if (referer !== null) {
    let parsed: URL;
    try {
      parsed = new URL(referer);
    } catch {
      deny("AGENT_INBOX_ORIGIN_DENIED", "Agent inbox referrer is invalid");
    }
    if (
      parsed.origin !== url.origin ||
      !parsed.pathname.startsWith("/agent-inbox/") ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      deny("AGENT_INBOX_ORIGIN_DENIED", "Agent inbox referrer is outside the dedicated shell");
    }
  }
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    deny("AGENT_INBOX_ORIGIN_DENIED", "Agent inbox request is not same-origin");
  }
  const mode = request.headers.get("Sec-Fetch-Mode");
  if (mode !== null && mode !== "same-origin" && mode !== "cors") {
    deny("AGENT_INBOX_ORIGIN_DENIED", "Agent inbox request has an invalid fetch mode");
  }
  const destination = request.headers.get("Sec-Fetch-Dest");
  if (destination !== null && destination !== "empty") {
    deny("AGENT_INBOX_ORIGIN_DENIED", "Agent inbox request has an invalid fetch destination");
  }
  if (request.headers.has("Cookie")) {
    deny("AGENT_INBOX_COOKIE_DENIED", "Agent inbox API requests must omit browser cookies");
  }
}

export function parseAgentTaskInboxRequest(
  request: Request,
  decodedBody: unknown,
): ParsedAgentTaskInboxRequest {
  const body = plainObject(decodedBody);
  const header = request.headers.get("X-Eliotr-Client-Grant");
  const supplied = body.client_grant_id;
  if (
    header === null ||
    !SAFE_GRANT.test(header) ||
    typeof supplied !== "string" ||
    supplied !== header
  ) {
    throw new HttpRequestError(
      "AGENT_INBOX_GRANT_MISMATCH",
      400,
      "Body client_grant_id must exactly match X-Eliotr-Client-Grant",
    );
  }
  return { body, grant_id: header };
}

export function isAgentTaskHttpOperation(value: string): value is AgentTaskInboxOperation {
  return (AGENT_TASK_INBOX_OPERATIONS as readonly string[]).includes(value);
}
