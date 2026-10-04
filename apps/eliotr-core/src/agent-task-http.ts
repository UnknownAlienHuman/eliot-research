import { authorizeProjectClientGrant } from "@eliotr/cloudflare-navigation";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  AGENT_TASK_INBOX_PROTOCOL,
  assertAgentTaskInboxRequestSecurity,
  isAgentTaskHttpOperation,
  parseAgentTaskInboxRequest,
  type AgentTaskInboxOperation,
} from "@eliotr/cloudflare-http-protocol/agent-task-inbox-input.js";
import { apiResult, HttpRequestError, requireNoQuery } from "./http.js";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import {
  callExternalAgentTaskTool,
  type ExternalAgentTaskToolName,
} from "./mcp-external-agent-task.js";
import type { Env } from "./env.js";

const TOOL_BY_OPERATION = Object.freeze({
  "research.agent-task.pull": "eliotr_task_pull",
  "research.agent-task.progress": "eliotr_task_progress",
  "research.agent-task.result": "eliotr_task_result",
  "research.agent-task.status": "eliotr_task_status",
} as const satisfies Readonly<Record<AgentTaskInboxOperation, ExternalAgentTaskToolName>>);

function sanitizedContext(
  context: AuthenticatedRequestContext,
  request: Request,
  grant: string,
): AuthenticatedRequestContext {
  const headers = new Headers({
    "X-Eliotr-Agent-Inbox": AGENT_TASK_INBOX_PROTOCOL,
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

export { isAgentTaskHttpOperation };

/**
 * Browser facade over the existing external-task authority.
 * Access Client Secrets are verified at the edge and are never copied into the
 * service context, durable state, response, or error.
 */
export async function handleAgentTaskHttp(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  operation: AgentTaskInboxOperation,
  maximumBytes: number,
): Promise<Response> {
  const url = new URL(request.url);
  requireNoQuery(url);
  assertAgentTaskInboxRequestSecurity(request, url);

  const { body, grant_id: grantId } = parseAgentTaskInboxRequest(
    request,
    await readJsonBodyWithinBytes(request, maximumBytes),
  );
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
