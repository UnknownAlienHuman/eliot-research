import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import { apiResult, HttpRequestError, requireNoQuery } from "./http.js";
import { ComputerAgentDispatchError } from "./computer-agent-dispatch-error.js";
import { createComputerAgentDispatchService } from "./computer-agent-dispatch-store.js";
import { createComputerAgentDispatchAbandonmentService } from "./computer-agent-dispatch-abandonment.js";
import { createComputerAgentDispatchDeclineService } from "./computer-agent-dispatch-decline.js";
import { createComputerAgentDispatchReassignmentService } from "./computer-agent-dispatch-reassignment.js";
import { createComputerAgentPreferredDispatchService } from "./computer-agent-preferred-dispatch.js";

function requireJson(request: Request): void {
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json") {
    throw new HttpRequestError("COMPUTER_AGENT_DISPATCH_INPUT_INVALID", 415,
      "Computer-agent dispatch mutations require application/json");
  }
}
function requireOwnerMutationOrigin(request: Request, url: URL): void {
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if ((origin !== null && origin !== url.origin) ||
      (request.headers.has("Cookie") && origin === null) ||
      (site !== null && site !== "same-origin" && site !== "none")) {
    throw new HttpRequestError("COMPUTER_AGENT_DISPATCH_CSRF_DENIED", 403,
      "Dispatch creation requires a same-origin owner request");
  }
  requireJson(request);
}
function map(error: unknown): never {
  if (error instanceof ComputerAgentDispatchError) {
    throw new HttpRequestError(error.code, error.status,
      "Computer-agent dispatch request could not be completed", error.retryable);
  }
  throw error;
}

export async function handleComputerAgentDispatchHttp(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  operation: string,
  params: Readonly<Record<string, string>>,
  maximumBytes: number,
): Promise<Response> {
  const service = createComputerAgentDispatchService(env);
  const url = new URL(request.url);
  try {
    requireNoQuery(url);
    if (operation === "research.computer-agent-dispatches.status") {
      return apiResult(request, env, await service.status(
        context,
        params.project_id ?? "",
        params.dispatch_id ?? "",
      ));
    }
    if (operation === "research.computer-agent-dispatches.create" ||
        operation === "research.computer-agent-dispatches.create-preferred") {
      requireOwnerMutationOrigin(request, url);
      const body: unknown = await readJsonBodyWithinBytes(request, maximumBytes);
      return apiResult(request, env,
        operation === "research.computer-agent-dispatches.create-preferred"
          ? await createComputerAgentPreferredDispatchService(env).create(
              context, params.project_id ?? "", body)
          : await service.create(context, params.project_id ?? "", body));
    }
    if (operation === "research.computer-agent-dispatches.abandon") {
      requireOwnerMutationOrigin(request, url);
      return apiResult(request, env,
        await createComputerAgentDispatchAbandonmentService({ database: env.CORE_DB })
          .abandon(context, params.project_id ?? "", params.dispatch_id ?? "",
            await readJsonBodyWithinBytes(request, maximumBytes)));
    }
    if (operation === "research.computer-agent-dispatches.reassign") {
      requireOwnerMutationOrigin(request, url);
      return apiResult(request, env,
        await createComputerAgentDispatchReassignmentService(env).reassign(
          context, params.project_id ?? "", params.dispatch_id ?? "",
          await readJsonBodyWithinBytes(request, maximumBytes),
        ));
    }
    requireJson(request);
    const body: unknown = await readJsonBodyWithinBytes(request, maximumBytes);
    if (operation === "research.computer-agent-dispatches.decline") {
      return apiResult(request, env,
        await createComputerAgentDispatchDeclineService({ database: env.CORE_DB })
          .decline(context, params.dispatch_id ?? "", body));
    }
    if (operation === "research.computer-agent-dispatches.pull") {
      return apiResult(request, env, await service.pull(context, body));
    }
    return apiResult(request, env, await service.accept(
      context,
      params.dispatch_id ?? "",
      body,
    ));
  } catch (error) {
    map(error);
  }
}
