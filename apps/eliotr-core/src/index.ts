import type { Env } from "./env.js";
import { handleGeminiMcp, type WorkspaceMcpRuntime } from "@eliotr/cloudflare-workspace-mcp";
import { handleHttp } from "./http.js";
import { handleQueue } from "./queue.js";
import { readReadiness } from "./readiness.js";
import { handleScheduled } from "./scheduled.js";
export { ResearchSession } from "./research-session.js";
export { ResearchWorkflow } from "./research-workflow.js";

function workspaceMcpRuntime(env: Env): WorkspaceMcpRuntime {
  return {
    DEPLOYMENT_GENERATION: env.DEPLOYMENT_GENERATION,
    ENVIRONMENT: env.ENVIRONMENT,
    GOOGLE_EXTERNAL_TRANSPORT: env.GOOGLE_EXTERNAL_TRANSPORT,
    MCP_HOSTNAME: env.MCP_HOSTNAME,
    MCP_ACCESS_AUTH_PROFILE: env.MCP_ACCESS_AUTH_PROFILE,
    MCP_ACCESS_TEAM_DOMAIN: env.MCP_ACCESS_TEAM_DOMAIN,
    MCP_ACCESS_AUDIENCE: env.MCP_ACCESS_AUDIENCE,
    MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: env.MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID,
    ACCESS_AUDIENCE: env.ACCESS_AUDIENCE,
    readReadiness: () => readReadiness(env),
  };
}

export default {
  fetch(request: Request, env: Env, executionContext: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === "/mcp") {
      return handleGeminiMcp(request, workspaceMcpRuntime(env), executionContext);
    }
    return handleHttp(request, env, executionContext);
  },
  queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    return handleQueue(batch, env);
  },
  scheduled(event: ScheduledController, env: Env): Promise<void> {
    return handleScheduled(event, env);
  },
} satisfies ExportedHandler<Env>;
