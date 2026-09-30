import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  ComputerAgentRouteError,
  createProjectComputerAgentRouteService,
} from "./computer-agent-route-store.js";
import { apiResult, HttpRequestError, requireNoQuery } from "./http.js";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import type { Env } from "./env.js";
import { readProjectComputerAgentRouteReadiness } from "./computer-agent-route-readiness.js";

function requireMutationOrigin(request: Request, url: URL): void {
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if ((origin !== null && origin !== url.origin) ||
      (request.headers.has("Cookie") && origin === null) ||
      (site !== null && site !== "same-origin" && site !== "none")) {
    throw new HttpRequestError("COMPUTER_AGENT_ROUTE_CSRF_DENIED", 403,
      "Route mutation requires a same-origin owner request");
  }
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpRequestError("COMPUTER_AGENT_ROUTE_INPUT_INVALID", 415,
      "Route mutations require application/json");
  }
}
function map(error: unknown): never {
  if (error instanceof ComputerAgentRouteError) {
    throw new HttpRequestError(error.code, error.status,
      "Computer-agent project route request could not be completed", error.retryable);
  }
  throw error;
}

export async function handleComputerAgentRouteHttp(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  params: Readonly<Record<string, string>>,
  maximumBytes: number,
): Promise<Response> {
  const service = createProjectComputerAgentRouteService({ database: env.CORE_DB });
  const projectId = params.project_id ?? "";
  const taskKind = params.task_kind ?? "";
  const url = new URL(request.url);
  try {
    requireNoQuery(url);
    if (request.method === "GET") {
      if (params.transport !== undefined) {
        return apiResult(request, env, await readProjectComputerAgentRouteReadiness({
          database: env.CORE_DB,
          context,
          project_id: projectId,
          task_kind: taskKind,
          transport: params.transport,
          deployment_generation: env.DEPLOYMENT_GENERATION,
        }));
      }
      return apiResult(request, env, await service.get(context, projectId, taskKind));
    }
    requireMutationOrigin(request, url);
    const input: unknown = await readJsonBodyWithinBytes(request, maximumBytes);
    const result = request.method === "PUT"
      ? await service.put(context, projectId, taskKind, input)
      : await service.disable(context, projectId, taskKind, input);
    return apiResult(request, env, result);
  } catch (error) {
    map(error);
  }
}
