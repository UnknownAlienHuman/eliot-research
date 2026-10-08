import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { ComputerAgentDispatchError } from "./computer-agent-dispatch-error.js";
import { createComputerAgentDispatchService } from "./computer-agent-dispatch-store.js";
import { createComputerAgentDispatchAbandonmentService } from "./computer-agent-dispatch-abandonment.js";
import { createComputerAgentDispatchDeclineService } from "./computer-agent-dispatch-decline.js";
import { createComputerAgentDispatchReassignmentService } from "./computer-agent-dispatch-reassignment.js";
import { createComputerAgentPreferredDispatchService } from "./computer-agent-preferred-dispatch.js";
import type { ComputerAgentDispatchHttpSupport, ComputerAgentHttpRuntime } from "./computer-agent-http-support.js";

function requireJson(request: Request, support: ComputerAgentDispatchHttpSupport): void {
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json") {
    throw support.http_error("COMPUTER_AGENT_DISPATCH_INPUT_INVALID", 415,
      "Computer-agent dispatch mutations require application/json");
  }
}

function requireOwnerMutationOrigin(request: Request, url: URL,
  support: ComputerAgentDispatchHttpSupport): void {
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if ((origin !== null && origin !== url.origin) ||
      (request.headers.has("Cookie") && origin === null) ||
      (site !== null && site !== "same-origin" && site !== "none")) {
    throw support.http_error("COMPUTER_AGENT_DISPATCH_CSRF_DENIED", 403,
      "Dispatch creation requires a same-origin owner request");
  }
  requireJson(request, support);
}

function map(error: unknown, support: ComputerAgentDispatchHttpSupport): never {
  if (error instanceof ComputerAgentDispatchError) {
    throw support.http_error(error.code, error.status,
      "Computer-agent dispatch request could not be completed", error.retryable);
  }
  throw error;
}

export async function handleComputerAgentDispatchHttp(
  request: Request,
  runtime: ComputerAgentHttpRuntime,
  context: AuthenticatedRequestContext,
  operation: string,
  params: Readonly<Record<string, string>>,
  maximumBytes: number,
  support: ComputerAgentDispatchHttpSupport,
): Promise<Response> {
  const commonOptions = {
    start_run: support.start_run,
    parse_run_request: support.parse_run_request,
    is_run_request_input_error: support.is_run_request_input_error,
    is_research_run_service_error: (error: unknown): error is {
      readonly code: string;
      readonly status: number;
      readonly retryable: boolean;
    } => support.is_run_request_input_error(error) &&
      typeof error === "object" && error !== null &&
      "code" in error && typeof error.code === "string" &&
      "status" in error && typeof error.status === "number" &&
      "retryable" in error && typeof error.retryable === "boolean",
  };
  const dispatchService = (options: {
    now?: () => number;
    allow_preferred_internal_key?: boolean;
  } = {}) => createComputerAgentDispatchService(runtime, { ...commonOptions, ...options });
  const service = dispatchService();
  const url = new URL(request.url);
  try {
    support.require_no_query(url);
    if (operation === "research.computer-agent-dispatches.status") {
      return support.api_result(request, await service.status(
        context,
        params.project_id ?? "",
        params.dispatch_id ?? "",
      ));
    }
    if (operation === "research.computer-agent-dispatches.create" ||
        operation === "research.computer-agent-dispatches.create-preferred") {
      requireOwnerMutationOrigin(request, url, support);
      const body: unknown = await support.read_json_body(request, maximumBytes);
      return support.api_result(request,
        operation === "research.computer-agent-dispatches.create-preferred"
          ? await createComputerAgentPreferredDispatchService(runtime, {
              create_dispatch_service: (options) => dispatchService(options),
            }).create(context, params.project_id ?? "", body)
          : await service.create(context, params.project_id ?? "", body));
    }
    if (operation === "research.computer-agent-dispatches.abandon") {
      requireOwnerMutationOrigin(request, url, support);
      return support.api_result(request,
        await createComputerAgentDispatchAbandonmentService({ database: runtime.database })
          .abandon(context, params.project_id ?? "", params.dispatch_id ?? "",
            await support.read_json_body(request, maximumBytes)));
    }
    if (operation === "research.computer-agent-dispatches.reassign") {
      requireOwnerMutationOrigin(request, url, support);
      return support.api_result(request,
        await createComputerAgentDispatchReassignmentService(runtime, {
          create_dispatch_service: (options) => dispatchService(options),
        }).reassign(context, params.project_id ?? "", params.dispatch_id ?? "",
          await support.read_json_body(request, maximumBytes)));
    }
    requireJson(request, support);
    const body: unknown = await support.read_json_body(request, maximumBytes);
    if (operation === "research.computer-agent-dispatches.decline") {
      return support.api_result(request,
        await createComputerAgentDispatchDeclineService({ database: runtime.database })
          .decline(context, params.dispatch_id ?? "", body));
    }
    if (operation === "research.computer-agent-dispatches.pull") {
      return support.api_result(request, await service.pull(context, body));
    }
    return support.api_result(request, await service.accept(
      context,
      params.dispatch_id ?? "",
      body,
    ));
  } catch (error) {
    map(error, support);
  }
}
