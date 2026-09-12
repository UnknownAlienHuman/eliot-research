import type { Env } from "./env.js";
import {
  GeminiMcpToolError,
  handleGeminiMcp,
  type McpClientDiagnosticConsume,
  type McpToolCallContext,
  type WorkspaceMcpRuntime,
} from "@eliotr/cloudflare-workspace-mcp";
import { handleHttp } from "./http.js";
import { handleQueue } from "./queue.js";
import { readReadiness } from "./readiness.js";
import { createD1WorkspaceMcpCandidateStore } from "./workspace-mcp-candidate-store.js";
import { handleScheduled } from "./scheduled.js";
import {
  createD1McpClientDiagnosticService,
  McpClientDiagnosticServiceError,
} from "./mcp-client-diagnostics.js";
export { ResearchSession } from "./research-session.js";
export { ResearchWorkflow } from "./research-workflow.js";

const MCP_DIAGNOSTIC_ERROR_MAP: Readonly<Record<string, {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}>> = Object.freeze({
  MCP_DIAGNOSTIC_CLOCK_INVALID: {
    code: "MCP_DIAGNOSTIC_CLOCK_INVALID",
    message: "Client diagnostic confirmation is temporarily unavailable",
    retryable: true,
  },
  MCP_DIAGNOSTIC_CONFIG_INVALID: {
    code: "MCP_DIAGNOSTIC_CONFIG_INVALID",
    message: "Client diagnostic confirmation is temporarily unavailable",
    retryable: true,
  },
  MCP_DIAGNOSTIC_CRYPTO_UNAVAILABLE: {
    code: "MCP_DIAGNOSTIC_CRYPTO_UNAVAILABLE",
    message: "Client diagnostic confirmation is temporarily unavailable",
    retryable: true,
  },
  MCP_DIAGNOSTIC_D1_CORRUPT: {
    code: "MCP_DIAGNOSTIC_D1_CORRUPT",
    message: "Client diagnostic confirmation is temporarily unavailable",
    retryable: true,
  },
  MCP_DIAGNOSTIC_D1_UNAVAILABLE: {
    code: "MCP_DIAGNOSTIC_D1_UNAVAILABLE",
    message: "Client diagnostic confirmation is temporarily unavailable",
    retryable: true,
  },
  MCP_DIAGNOSTIC_MCP_AUTH_EXPIRED: {
    code: "MCP_DIAGNOSTIC_MCP_AUTH_EXPIRED",
    message: "Client diagnostic authentication has expired",
    retryable: false,
  },
  MCP_DIAGNOSTIC_MCP_CONTEXT_INVALID: {
    code: "MCP_DIAGNOSTIC_MCP_CONTEXT_INVALID",
    message: "Authenticated client diagnostic context is invalid",
    retryable: false,
  },
  MCP_DIAGNOSTIC_MCP_CONTEXT_REQUIRED: {
    code: "MCP_DIAGNOSTIC_MCP_CONTEXT_REQUIRED",
    message: "Authenticated client diagnostic context is required",
    retryable: false,
  },
  MCP_DIAGNOSTIC_MCP_DEPLOYMENT_MISMATCH: {
    code: "MCP_DIAGNOSTIC_MCP_DEPLOYMENT_MISMATCH",
    message: "Client diagnostic authentication is not current",
    retryable: false,
  },
  MCP_DIAGNOSTIC_MCP_PROFILE_MISMATCH: {
    code: "MCP_DIAGNOSTIC_MCP_PROFILE_MISMATCH",
    message: "Client diagnostic authentication is not current",
    retryable: false,
  },
  MCP_DIAGNOSTIC_CHALLENGE_EXPIRED: {
    code: "MCP_CLIENT_DIAGNOSTIC_CHALLENGE_EXPIRED",
    message: "Client diagnostic challenge has expired",
    retryable: false,
  },
  MCP_DIAGNOSTIC_CHALLENGE_NOT_FOUND: {
    code: "MCP_CLIENT_DIAGNOSTIC_CHALLENGE_NOT_FOUND",
    message: "Client diagnostic challenge was not found",
    retryable: false,
  },
  MCP_DIAGNOSTIC_CHALLENGE_REPLAY: {
    code: "MCP_CLIENT_DIAGNOSTIC_CHALLENGE_REPLAY",
    message: "Client diagnostic challenge was already consumed",
    retryable: false,
  },
  MCP_DIAGNOSTIC_CHALLENGE_STALE: {
    code: "MCP_CLIENT_DIAGNOSTIC_CHALLENGE_STALE",
    message: "Client diagnostic challenge is no longer current",
    retryable: false,
  },
  MCP_DIAGNOSTIC_OWNER_INVALID: {
    code: "MCP_DIAGNOSTIC_OWNER_INVALID",
    message: "Client diagnostic confirmation is temporarily unavailable",
    retryable: true,
  },
  MCP_DIAGNOSTIC_INPUT_INVALID: {
    code: "INPUT_INVALID",
    message: "Client diagnostic input is invalid",
    retryable: false,
  },
  MCP_DIAGNOSTIC_SETTLEMENT_UNCERTAIN: {
    code: "MCP_DIAGNOSTIC_SETTLEMENT_UNCERTAIN",
    message: "Client diagnostic confirmation is temporarily unavailable",
    retryable: true,
  },
  MCP_DIAGNOSTIC_TOKEN_INVALID: {
    code: "MCP_CLIENT_DIAGNOSTIC_TOKEN_INVALID",
    message: "Client diagnostic challenge token is invalid",
    retryable: false,
  },
});

function mcpDiagnosticError(error: McpClientDiagnosticServiceError): GeminiMcpToolError {
  const mapped = MCP_DIAGNOSTIC_ERROR_MAP[error.code];
  return mapped === undefined
    ? new GeminiMcpToolError(
        "MCP_CLIENT_DIAGNOSTIC_UNAVAILABLE",
        "Client diagnostic confirmation is temporarily unavailable",
        true,
      )
    : new GeminiMcpToolError(mapped.code, mapped.message, mapped.retryable);
}

function unavailableMcpDiagnosticError(): GeminiMcpToolError {
  return new GeminiMcpToolError(
    "MCP_CLIENT_DIAGNOSTIC_UNAVAILABLE",
    "Client diagnostic confirmation is temporarily unavailable",
    true,
  );
}

function copyMcpDiagnosticContext(context: McpToolCallContext): McpToolCallContext {
  const verifiedActor = context.verified_actor;
  return Object.freeze({
    principal_ref: context.principal_ref,
    trace_id: context.trace_id,
    deployment_generation: context.deployment_generation,
    ...(verifiedActor === undefined
      ? {}
      : { verified_actor: Object.freeze({ ...verifiedActor }) }),
  });
}

function configuredMcpClientDiagnosticConsume(env: Env): McpClientDiagnosticConsume | undefined {
  const profile = env.MCP_ACCESS_AUTH_PROFILE;
  if (profile !== "service-token" && profile !== "managed-oauth") return undefined;
  const database = env.CORE_DB;
  const deploymentGeneration = env.DEPLOYMENT_GENERATION;
  return async (input, context) => {
    const consumeInput = Object.freeze({
      challenge_id: input.challenge_id,
      challenge_token: input.challenge_token,
    });
    const consumeContext = copyMcpDiagnosticContext(context);
    try {
      const service = createD1McpClientDiagnosticService(database, {
        now: Date.now,
        auth_profile: profile,
        deployment_generation: deploymentGeneration,
      });
      return await service.consume(consumeInput, consumeContext);
    } catch (error) {
      if (error instanceof McpClientDiagnosticServiceError) throw mcpDiagnosticError(error);
      throw unavailableMcpDiagnosticError();
    }
  };
}

function workspaceMcpRuntime(env: Env): WorkspaceMcpRuntime {
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
    ACCESS_AUDIENCE: env.ACCESS_AUDIENCE,
    workspaceCandidateStore: createD1WorkspaceMcpCandidateStore(env.CORE_DB),
    readReadiness: () => readReadiness(env),
    ...(mcpClientDiagnosticConsume === undefined ? {} : { mcpClientDiagnosticConsume }),
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
