import { ComputerAgentQualificationIssueInputSchema } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  ComputerAgentQualificationError,
  confirmWebInboxComputerAgentQualification,
  createComputerAgentQualificationService,
} from "./computer-agent-qualification-store.js";
import type { ComputerAgentHttpRuntime, ComputerAgentQualificationHttpSupport } from "./computer-agent-http-support.js";

const INBOX_PROTOCOL = "eliotr.agent-inbox.v1";

function map(error: unknown, support: ComputerAgentQualificationHttpSupport): never {
  if (error instanceof ComputerAgentQualificationError) {
    throw support.http_error(error.code, error.status,
      "Computer-agent qualification request could not be completed", error.retryable);
  }
  throw error;
}

function requireOwnerMutation(request: Request, url: URL,
  support: ComputerAgentQualificationHttpSupport): void {
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if (origin !== url.origin || request.headers.get("X-Eliotr-Csrf") !== "1" ||
      (site !== null && site !== "same-origin" && site !== "none")) {
    throw support.http_error("COMPUTER_AGENT_QUALIFICATION_CSRF_DENIED", 403,
      "Qualification issuance requires a same-origin owner request");
  }
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw support.http_error("COMPUTER_AGENT_QUALIFICATION_INPUT_INVALID", 415,
      "Qualification issuance requires application/json");
  }
}

function requireInboxOrigin(request: Request, url: URL,
  support: ComputerAgentQualificationHttpSupport): void {
  if (request.headers.get("X-Eliotr-Agent-Inbox") !== INBOX_PROTOCOL ||
      request.headers.get("Origin") !== url.origin || request.headers.has("Cookie")) {
    throw support.http_error("COMPUTER_AGENT_QUALIFICATION_ORIGIN_DENIED", 403,
      "Web-inbox qualification requires the dedicated same-origin cookie-free shell");
  }
  const referer = request.headers.get("Referer");
  if (referer !== null) {
    let parsed: URL;
    try { parsed = new URL(referer); }
    catch { throw support.http_error("COMPUTER_AGENT_QUALIFICATION_ORIGIN_DENIED", 403,
      "Web-inbox qualification referrer is invalid"); }
    if (parsed.origin !== url.origin || !parsed.pathname.startsWith("/agent-inbox/") ||
        parsed.username !== "" || parsed.password !== "") {
      throw support.http_error("COMPUTER_AGENT_QUALIFICATION_ORIGIN_DENIED", 403,
        "Web-inbox qualification referrer is outside the dedicated shell");
    }
  }
  const site = request.headers.get("Sec-Fetch-Site");
  const mode = request.headers.get("Sec-Fetch-Mode");
  const destination = request.headers.get("Sec-Fetch-Dest");
  if ((site !== null && site !== "same-origin" && site !== "none") ||
      (mode !== null && mode !== "same-origin" && mode !== "cors") ||
      (destination !== null && destination !== "empty")) {
    throw support.http_error("COMPUTER_AGENT_QUALIFICATION_ORIGIN_DENIED", 403,
      "Web-inbox qualification fetch metadata is invalid");
  }
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw support.http_error("COMPUTER_AGENT_QUALIFICATION_INPUT_INVALID", 415,
      "Qualification confirmation requires application/json");
  }
}

export async function handleComputerAgentQualificationOwnerHttp(
  request: Request,
  runtime: ComputerAgentHttpRuntime,
  context: AuthenticatedRequestContext,
  params: Readonly<Record<string, string>>,
  maximumBytes: number,
  support: ComputerAgentQualificationHttpSupport,
): Promise<Response> {
  const url = new URL(request.url);
  support.require_no_query(url);
  const service = createComputerAgentQualificationService({
    database: runtime.database,
    deployment_generation: runtime.deployment_generation,
    mcp_auth_profile: runtime.mcp_auth_profile,
    create_diagnostic_service: support.create_diagnostic_service,
    is_diagnostic_error: support.is_diagnostic_error,
  });
  try {
    if (request.method === "GET") {
      return support.api_result(request, await service.latestStatus(context,
        params.connection_id ?? "", params.transport ?? ""));
    }
    requireOwnerMutation(request, url, support);
    const body: unknown = await support.read_json_body(request, maximumBytes);
    if (!ComputerAgentQualificationIssueInputSchema.safeParse(body).success) {
      throw support.http_error("COMPUTER_AGENT_QUALIFICATION_INPUT_INVALID", 400,
        "Qualification issue accepts only an empty JSON object");
    }
    return support.api_result(request, await service.issue(context,
      params.connection_id ?? "", params.transport ?? ""), 201);
  } catch (error) { map(error, support); }
}

export async function handleComputerAgentQualificationConfirmHttp(
  request: Request,
  runtime: ComputerAgentHttpRuntime,
  context: AuthenticatedRequestContext,
  maximumBytes: number,
  support: ComputerAgentQualificationHttpSupport,
): Promise<Response> {
  const url = new URL(request.url);
  support.require_no_query(url);
  requireInboxOrigin(request, url, support);
  try {
    const result = await confirmWebInboxComputerAgentQualification({
      database: runtime.database,
      context,
      body: await support.read_json_body(request, maximumBytes),
      deployment_generation: runtime.deployment_generation,
      create_diagnostic_service: support.create_diagnostic_service,
      is_diagnostic_error: support.is_diagnostic_error,
    });
    return support.api_result(request, result);
  } catch (error) { map(error, support); }
}
