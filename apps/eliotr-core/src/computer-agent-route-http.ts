import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  handleComputerAgentRouteHttp as handle,
} from "@eliotr/cloudflare-computer-agent/computer-agent-route-http";
import type { ComputerAgentHttpRuntime, ComputerAgentHttpSupport } from "@eliotr/cloudflare-computer-agent/computer-agent-http-support";
import { apiResult, HttpRequestError, requireNoQuery } from "./http.js";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import type { Env } from "./env.js";

export function handleComputerAgentRouteHttp(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  params: Readonly<Record<string, string>>,
  maximumBytes: number,
): Promise<Response> {
  const runtime: ComputerAgentHttpRuntime = {
    database: env.CORE_DB,
    deployment_generation: env.DEPLOYMENT_GENERATION,
  };
  const support: ComputerAgentHttpSupport = {
    api_result: (currentRequest, result, status) => apiResult(currentRequest, env, result, status),
    http_error: (code, status, message, retryable) =>
      new HttpRequestError(code, status, message, retryable),
    require_no_query: requireNoQuery,
    read_json_body: (currentRequest, limit) => readJsonBodyWithinBytes(currentRequest, limit),
  };
  return handle(request, runtime, context, params, maximumBytes, support);
}
