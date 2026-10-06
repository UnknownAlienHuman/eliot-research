import { createManagedOAuthOwnerContext, createMcpResearchToolCall } from "./mcp-research-service.js";
import type { Env } from "./env.js";
import {
  GeminiMcpToolError,
  createWorkspaceMcpDiagnosticConsume,
  handleGeminiMcp,
  projectWorkspaceMcpEnvironment,
  type McpClientDiagnosticConsume,
  type WorkspaceMcpEnvironmentProjection,
  type WorkspaceMcpRuntime,
} from "@eliotr/cloudflare-workspace-mcp";
import { handleHttp } from "./http.js";
import { CatalogInputError, ClientGrantError, OrientationError, readCatalog } from "@eliotr/cloudflare-navigation";
import { handleQueue } from "./queue.js";
import { readReadiness } from "./readiness.js";
import { createD1WorkspaceMcpCandidateStore } from "@eliotr/cloudflare-workspace-mcp/workspace-mcp-candidate-d1-store";
import { handleScheduled } from "./scheduled.js";
import {
  ComputerAgentQualificationError,
  preflightComputerAgentQualificationChallenge,
  requireComputerAgentQualificationChallengeReady,
} from "./computer-agent-qualification-store.js";
export { ResearchSession } from "./research-session.js";
export { ResearchWorkflow } from "./research-workflow.js";

function computerAgentQualificationError(error: ComputerAgentQualificationError): GeminiMcpToolError {
  return new GeminiMcpToolError(error.code,
    "Computer-agent qualification is not current for this Access actor", error.retryable);
}

function configuredMcpClientDiagnosticConsume(env: Env): McpClientDiagnosticConsume | undefined {
  const profile = env.MCP_ACCESS_AUTH_PROFILE;
  if (profile !== "service-token" && profile !== "managed-oauth") return undefined;
  const database = env.CORE_DB;
  const deploymentGeneration = env.DEPLOYMENT_GENERATION;
  return createWorkspaceMcpDiagnosticConsume({
    database,
    auth_profile: profile,
    deployment_generation: deploymentGeneration,
    preflight_computer_agent_qualification: async (input, context) => {
      if (context.verified_actor === undefined) return false;
      const access = context.verified_access;
      return preflightComputerAgentQualificationChallenge({
        database,
        challenge_id: input.challenge_id,
        transport: "MCP_WRITE",
        issuer: access?.issuer,
        subject: context.principal_ref,
        deployment_generation: deploymentGeneration,
      });
    },
    require_computer_agent_qualification_current: async (input, context) => {
      const actor = context.verified_actor;
      if (actor === undefined) return;
      await requireComputerAgentQualificationChallengeReady({
        database,
        challenge_id: input.challenge_id,
        transport: "MCP_WRITE",
        credential_generation: actor.credential_generation,
        deployment_generation: deploymentGeneration,
      });
    },
    translate_computer_agent_qualification_error: (error) =>
      error instanceof ComputerAgentQualificationError ? computerAgentQualificationError(error) : undefined,
  });
}

function workspaceMcpRuntime(env: WorkspaceMcpEnvironmentProjection<Env["AI"]>, request: Request): WorkspaceMcpRuntime {
  const mcpClientDiagnosticConsume = configuredMcpClientDiagnosticConsume(env);
  return {
    DEPLOYMENT_GENERATION: env.DEPLOYMENT_GENERATION,
    ENVIRONMENT: env.ENVIRONMENT,
    GOOGLE_EXTERNAL_TRANSPORT: env.GOOGLE_EXTERNAL_TRANSPORT,
    MCP_HOSTNAME: env.MCP_HOSTNAME,
    MCP_ACCESS_AUTH_PROFILE: env.MCP_ACCESS_AUTH_PROFILE,
    MCP_ACCESS_TEAM_DOMAIN: env.MCP_ACCESS_TEAM_DOMAIN,
    MCP_ACCESS_AUDIENCE: env.MCP_ACCESS_AUDIENCE,
    MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: env.MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID,
    MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS: env.MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS,
    ACCESS_AUDIENCE: env.ACCESS_AUDIENCE,
    workspaceCandidateStore: createD1WorkspaceMcpCandidateStore(env.CORE_DB),
    research: createMcpResearchToolCall(env, request),
    async projectCatalog(input, context) {
      const identity = context.verified_access;
      if (!identity || !identity.issuer ||
          (identity.authentication_method !== "service_token" && identity.authentication_method !== "cloudflare_access")) {
        throw new GeminiMcpToolError("CLIENT_GRANT_IDENTITY_INVALID", "Verified Access identity required");
      }
      const readiness = await readReadiness(env);
      if (!readiness.ready) throw new GeminiMcpToolError("SCHEMA_NOT_READY", "Required migrations are not applied");
      try {
        if (identity.authentication_method === "cloudflare_access") {
          if (input.project_id === undefined) {
            throw new GeminiMcpToolError("MCP_PROJECT_SCOPE_REQUIRED", "An explicit project is required");
          }
          const owner = createManagedOAuthOwnerContext(env, request, context, { project_id: input.project_id });
          const result = await readCatalog(env.CORE_DB, owner, input, env.DEPLOYMENT_GENERATION);
          createManagedOAuthOwnerContext(env, request, context, { project_id: input.project_id });
          return result;
        }
        return await readCatalog(env.CORE_DB, { request, principal_ref: identity.principal_ref,
          client_class: "trusted_agent", credential_generation: identity.credential_generation,
          trace_id: context.trace_id, access: identity }, input, env.DEPLOYMENT_GENERATION);
      } catch (error) {
        if (error instanceof ClientGrantError || error instanceof CatalogInputError || error instanceof OrientationError) {
          throw new GeminiMcpToolError(error.code, "Project catalog request is not authorized or no longer current");
        }
        throw new GeminiMcpToolError("CLIENT_GRANT_STORAGE_UNAVAILABLE", "Project catalog is temporarily unavailable");
      }
    },
    readReadiness: () => readReadiness(env),
    ...(mcpClientDiagnosticConsume === undefined ? {} : { mcpClientDiagnosticConsume }),
  };
}

export default {
  fetch(request: Request, env: Env, executionContext: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === "/mcp") {
      const mcpEnv = projectWorkspaceMcpEnvironment(env);
      return handleGeminiMcp(request, workspaceMcpRuntime(mcpEnv, request), executionContext);
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
