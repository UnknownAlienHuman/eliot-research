import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  handleComputerAgentDispatchHttp as handle,
} from "@eliotr/cloudflare-computer-agent/computer-agent-dispatch-http";
import type { ComputerAgentDispatchHttpSupport, ComputerAgentHttpRuntime } from "@eliotr/cloudflare-computer-agent/computer-agent-http-support";
import { apiResult, HttpRequestError, requireNoQuery } from "./http.js";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import { createResearchRunService, parseResearchRunRequest, ResearchServiceError } from "./research-session.js";
import type { Env } from "./env.js";

export function handleComputerAgentDispatchHttp(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  operation: string,
  params: Readonly<Record<string, string>>,
  maximumBytes: number,
): Promise<Response> {
  const runtime: ComputerAgentHttpRuntime = {
    database: env.CORE_DB,
    deployment_generation: env.DEPLOYMENT_GENERATION,
  };
  const support: ComputerAgentDispatchHttpSupport = {
    api_result: (currentRequest, result, status) => apiResult(currentRequest, env, result, status),
    http_error: (code, status, message, retryable) =>
      new HttpRequestError(code, status, message, retryable),
    require_no_query: requireNoQuery,
    read_json_body: (currentRequest, limit) => readJsonBodyWithinBytes(currentRequest, limit),
    start_run: (currentContext, runRequest) => createResearchRunService(env).run(currentContext, runRequest),
    parse_run_request: parseResearchRunRequest,
    is_run_request_input_error: (error) => error instanceof ResearchServiceError,
  };
  return handle(request, runtime, context, operation, params, maximumBytes, support);
}
