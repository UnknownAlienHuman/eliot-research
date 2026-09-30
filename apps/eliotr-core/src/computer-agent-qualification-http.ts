import { ComputerAgentQualificationIssueInputSchema } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  ComputerAgentQualificationError,
  confirmWebInboxComputerAgentQualification,
  createComputerAgentQualificationService,
} from "./computer-agent-qualification-store.js";
import { apiResult, HttpRequestError, requireNoQuery } from "./http.js";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import type { Env } from "./env.js";

const INBOX_PROTOCOL = "eliotr.agent-inbox.v1";

function map(error: unknown): never {
  if (error instanceof ComputerAgentQualificationError) {
    throw new HttpRequestError(error.code, error.status,
      "Computer-agent qualification request could not be completed", error.retryable);
  }
  throw error;
}
function requireOwnerMutation(request: Request, url: URL): void {
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if (origin !== url.origin || request.headers.get("X-Eliotr-Csrf") !== "1" ||
      (site !== null && site !== "same-origin" && site !== "none")) {
    throw new HttpRequestError("COMPUTER_AGENT_QUALIFICATION_CSRF_DENIED", 403,
      "Qualification issuance requires a same-origin owner request");
  }
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpRequestError("COMPUTER_AGENT_QUALIFICATION_INPUT_INVALID", 415,
      "Qualification issuance requires application/json");
  }
}
function requireInboxOrigin(request: Request, url: URL): void {
  if (request.headers.get("X-Eliotr-Agent-Inbox") !== INBOX_PROTOCOL ||
      request.headers.get("Origin") !== url.origin || request.headers.has("Cookie")) {
    throw new HttpRequestError("COMPUTER_AGENT_QUALIFICATION_ORIGIN_DENIED", 403,
      "Web-inbox qualification requires the dedicated same-origin cookie-free shell");
  }
  const referer = request.headers.get("Referer");
  if (referer !== null) {
    let parsed: URL;
    try { parsed = new URL(referer); }
    catch { throw new HttpRequestError("COMPUTER_AGENT_QUALIFICATION_ORIGIN_DENIED", 403,
      "Web-inbox qualification referrer is invalid"); }
    if (parsed.origin !== url.origin || !parsed.pathname.startsWith("/agent-inbox/") ||
        parsed.username !== "" || parsed.password !== "") {
      throw new HttpRequestError("COMPUTER_AGENT_QUALIFICATION_ORIGIN_DENIED", 403,
        "Web-inbox qualification referrer is outside the dedicated shell");
    }
  }
  const site = request.headers.get("Sec-Fetch-Site");
  const mode = request.headers.get("Sec-Fetch-Mode");
  const destination = request.headers.get("Sec-Fetch-Dest");
  if ((site !== null && site !== "same-origin" && site !== "none") ||
      (mode !== null && mode !== "same-origin" && mode !== "cors") ||
      (destination !== null && destination !== "empty")) {
    throw new HttpRequestError("COMPUTER_AGENT_QUALIFICATION_ORIGIN_DENIED", 403,
      "Web-inbox qualification fetch metadata is invalid");
  }
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpRequestError("COMPUTER_AGENT_QUALIFICATION_INPUT_INVALID", 415,
      "Qualification confirmation requires application/json");
  }
}

export async function handleComputerAgentQualificationOwnerHttp(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  params: Readonly<Record<string, string>>,
  maximumBytes: number,
): Promise<Response> {
  const url = new URL(request.url);
  requireNoQuery(url);
  const service = createComputerAgentQualificationService({
    database: env.CORE_DB,
    deployment_generation: env.DEPLOYMENT_GENERATION,
    mcp_auth_profile: env.MCP_ACCESS_AUTH_PROFILE,
  });
  try {
    if (request.method === "GET") {
      return apiResult(request, env, await service.latestStatus(context,
        params.connection_id ?? "", params.transport ?? ""));
    }
    requireOwnerMutation(request, url);
    const body: unknown = await readJsonBodyWithinBytes(request, maximumBytes);
    if (!ComputerAgentQualificationIssueInputSchema.safeParse(body).success) {
      throw new HttpRequestError("COMPUTER_AGENT_QUALIFICATION_INPUT_INVALID", 400,
        "Qualification issue accepts only an empty JSON object");
    }
    return apiResult(request, env, await service.issue(context,
      params.connection_id ?? "", params.transport ?? ""), 201);
  } catch (error) { map(error); }
}

export async function handleComputerAgentQualificationConfirmHttp(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  maximumBytes: number,
): Promise<Response> {
  const url = new URL(request.url);
  requireNoQuery(url);
  requireInboxOrigin(request, url);
  try {
    const result = await confirmWebInboxComputerAgentQualification({
      database: env.CORE_DB,
      context,
      body: await readJsonBodyWithinBytes(request, maximumBytes),
      deployment_generation: env.DEPLOYMENT_GENERATION,
    });
    return apiResult(request, env, result);
  } catch (error) { map(error); }
}
