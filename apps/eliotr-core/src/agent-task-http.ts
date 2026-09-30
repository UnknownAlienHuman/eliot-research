import { authorizeProjectClientGrant } from "@eliotr/cloudflare-navigation";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { apiResult, HttpRequestError, requireNoQuery } from "./http.js";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import {
  callExternalAgentTaskTool,
  type ExternalAgentTaskToolName,
} from "./mcp-external-agent-task.js";
import type { Env } from "./env.js";

const INBOX_PROTOCOL = "eliotr.agent-inbox.v1";
const SAFE_GRANT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

const TOOL_BY_OPERATION = Object.freeze({
  "research.agent-task.pull": "eliotr_task_pull",
  "research.agent-task.progress": "eliotr_task_progress",
  "research.agent-task.result": "eliotr_task_result",
  "research.agent-task.status": "eliotr_task_status",
} as const satisfies Readonly<Record<string, ExternalAgentTaskToolName>>);

type AgentTaskHttpOperation = keyof typeof TOOL_BY_OPERATION;

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

function requireInboxOrigin(request: Request, url: URL): void {
  if (request.headers.get("X-Eliotr-Agent-Inbox") !== INBOX_PROTOCOL) {
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

function grantLocator(request: Request, body: Record<string, unknown>): string {
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
  return header;
}

function sanitizedContext(
  context: AuthenticatedRequestContext,
  request: Request,
  grant: string,
): AuthenticatedRequestContext {
  const headers = new Headers({
    "X-Eliotr-Agent-Inbox": INBOX_PROTOCOL,
    "X-Eliotr-Client-Grant": grant,
  });
  for (const name of [
    "Origin", "Referer", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest",
  ] as const) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return {
    ...context,
    request: new Request(request.url, {
      method: request.method,
      headers,
      signal: request.signal,
    }),
  };
}

export function isAgentTaskHttpOperation(
  value: string,
): value is AgentTaskHttpOperation {
  return Object.hasOwn(TOOL_BY_OPERATION, value);
}

/**
 * Browser facade over the existing external-task authority.
 * Access Client Secrets are verified at the edge and are never copied into the
 * service context, durable state, response, or error.
 */
export async function handleAgentTaskHttp(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  operation: AgentTaskHttpOperation,
  maximumBytes: number,
): Promise<Response> {
  const url = new URL(request.url);
  requireNoQuery(url);
  requireInboxOrigin(request, url);

  const body = plainObject(
    await readJsonBodyWithinBytes(request, maximumBytes),
  );
  const grantId = grantLocator(request, body);
  const safeContext = sanitizedContext(context, request, grantId);
  const lease = await authorizeProjectClientGrant(
    env.CORE_DB,
    safeContext,
    { operation: "run" },
  );
  if (lease.grant.grant_id !== grantId) {
    throw new HttpRequestError(
      "AGENT_INBOX_GRANT_MISMATCH",
      409,
      "Resolved project grant differs from the requested grant",
    );
  }

  const result = await callExternalAgentTaskTool(
    env,
    safeContext,
    lease.grant,
    TOOL_BY_OPERATION[operation],
    body,
    "WEB_INBOX",
  );
  await lease.requireGrantCurrent();
  return apiResult(request, env, result);
}
