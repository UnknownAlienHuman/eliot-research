import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  handleComputerAgentQualificationConfirmHttp as handleConfirm,
  handleComputerAgentQualificationOwnerHttp as handleOwner,
} from "@eliotr/cloudflare-computer-agent/computer-agent-qualification-http";
import type { ComputerAgentHttpRuntime, ComputerAgentQualificationHttpSupport } from "@eliotr/cloudflare-computer-agent/computer-agent-http-support";
import {
  createD1McpClientDiagnosticService,
  McpClientDiagnosticServiceError,
} from "@eliotr/cloudflare-workspace-mcp";
import { apiResult, HttpRequestError, requireNoQuery } from "./http.js";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import type { Env } from "./env.js";

function httpSupport(env: Env): ComputerAgentQualificationHttpSupport {
  return {
    api_result: (request, result, status) => apiResult(request, env, result, status),
    http_error: (code, status, message, retryable) =>
      new HttpRequestError(code, status, message, retryable),
    require_no_query: requireNoQuery,
    read_json_body: (request, limit) => readJsonBodyWithinBytes(request, limit),
    create_diagnostic_service: (input) => createD1McpClientDiagnosticService(input.database, {
      now: input.now,
      auth_profile: input.auth_profile,
      deployment_generation: input.deployment_generation,
    }),
    is_diagnostic_error: (error): error is McpClientDiagnosticServiceError =>
      error instanceof McpClientDiagnosticServiceError,
  };
}

function runtime(env: Env): ComputerAgentHttpRuntime {
  return {
    database: env.CORE_DB,
    deployment_generation: env.DEPLOYMENT_GENERATION,
    mcp_auth_profile: env.MCP_ACCESS_AUTH_PROFILE,
  };
}

export function handleComputerAgentQualificationOwnerHttp(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  params: Readonly<Record<string, string>>,
  maximumBytes: number,
): Promise<Response> {
  return handleOwner(request, runtime(env), context, params, maximumBytes, httpSupport(env));
}

export function handleComputerAgentQualificationConfirmHttp(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  maximumBytes: number,
): Promise<Response> {
  return handleConfirm(request, runtime(env), context, maximumBytes, httpSupport(env));
}
