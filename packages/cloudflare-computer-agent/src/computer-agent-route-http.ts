import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  ComputerAgentRouteError,
  createProjectComputerAgentRouteService,
} from "./computer-agent-route-store.js";
import { readProjectComputerAgentRouteReadiness } from "./computer-agent-route-readiness.js";
import type { ComputerAgentHttpRuntime, ComputerAgentHttpSupport } from "./computer-agent-http-support.js";

function requireMutationOrigin(request: Request, url: URL, support: ComputerAgentHttpSupport): void {
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if ((origin !== null && origin !== url.origin) ||
      (request.headers.has("Cookie") && origin === null) ||
      (site !== null && site !== "same-origin" && site !== "none")) {
    throw support.http_error("COMPUTER_AGENT_ROUTE_CSRF_DENIED", 403,
      "Route mutation requires a same-origin owner request");
  }
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw support.http_error("COMPUTER_AGENT_ROUTE_INPUT_INVALID", 415,
      "Route mutations require application/json");
  }
}
function map(error: unknown, support: ComputerAgentHttpSupport): never {
  if (error instanceof ComputerAgentRouteError) {
    throw support.http_error(error.code, error.status,
      "Computer-agent project route request could not be completed", error.retryable);
  }
  throw error;
}

export async function handleComputerAgentRouteHttp(
  request: Request,
  runtime: ComputerAgentHttpRuntime,
  context: AuthenticatedRequestContext,
  params: Readonly<Record<string, string>>,
  maximumBytes: number,
  support: ComputerAgentHttpSupport,
): Promise<Response> {
  const service = createProjectComputerAgentRouteService({ database: runtime.database });
  const projectId = params.project_id ?? "";
  const taskKind = params.task_kind ?? "";
  const url = new URL(request.url);
  try {
    support.require_no_query(url);
    if (request.method === "GET") {
      if (params.transport !== undefined) {
        return support.api_result(request, await readProjectComputerAgentRouteReadiness({
          database: runtime.database,
          context,
          project_id: projectId,
          task_kind: taskKind,
          transport: params.transport,
          deployment_generation: runtime.deployment_generation,
        }));
      }
      return support.api_result(request, await service.get(context, projectId, taskKind));
    }
    requireMutationOrigin(request, url, support);
    const input: unknown = await support.read_json_body(request, maximumBytes);
    const result = request.method === "PUT"
      ? await service.put(context, projectId, taskKind, input)
      : await service.disable(context, projectId, taskKind, input);
    return support.api_result(request, result);
  } catch (error) {
    map(error, support);
  }
}
