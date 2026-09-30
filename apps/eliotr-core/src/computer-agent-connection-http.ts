import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  ComputerAgentConnectionError,
  createComputerAgentConnectionService,
} from "./computer-agent-connection-store.js";
import { apiResult, HttpRequestError, requireNoQuery } from "./http.js";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import type { Env } from "./env.js";

function trustedIssuers(env: Env): readonly string[] {
  return [env.ACCESS_TEAM_DOMAIN, env.MCP_ACCESS_TEAM_DOMAIN]
    .filter((value): value is string => value !== undefined)
    .map((value) => {
      try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || url.port ||
            url.pathname !== "/" || url.search || url.hash ||
            !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/u.test(url.hostname)) {
          throw new Error();
        }
        return url.origin;
      } catch {
        throw new HttpRequestError("COMPUTER_AGENT_CONNECTION_CONFIG_INVALID", 503,
          "Configured Access issuer is invalid", true);
      }
    });
}
function map(error: unknown): never {
  if (error instanceof ComputerAgentConnectionError) {
    throw new HttpRequestError(error.code, error.status,
      "Computer-agent connection request could not be completed", error.retryable);
  }
  throw error;
}
function requireMutationOrigin(request: Request, url: URL): void {
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if ((origin !== null && origin !== url.origin) ||
      (request.headers.has("Cookie") && origin === null) ||
      (site !== null && site !== "same-origin" && site !== "none")) {
    throw new HttpRequestError("COMPUTER_AGENT_CONNECTION_CSRF_DENIED", 403,
      "Connection mutation requires a same-origin owner request");
  }
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpRequestError("COMPUTER_AGENT_CONNECTION_INPUT_INVALID", 415,
      "Connection mutations require application/json");
  }
}

export async function handleComputerAgentConnectionHttp(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  params: Readonly<Record<string, string>>,
  maximumBytes: number,
): Promise<Response> {
  const service = createComputerAgentConnectionService({
    database: env.CORE_DB,
    trusted_issuers: trustedIssuers(env),
  });
  const url = new URL(request.url);
  try {
    if (request.method === "GET") {
      if ([...url.searchParams.keys()].some((key) => key !== "after_connection_id") ||
          url.searchParams.getAll("after_connection_id").length > 1) {
        throw new HttpRequestError("COMPUTER_AGENT_CONNECTION_INPUT_INVALID", 400,
          "Unsupported or duplicate connection-list query parameter");
      }
      return apiResult(request, env,
        await service.list(context, url.searchParams.get("after_connection_id") ?? ""));
    }
    requireNoQuery(url);
    requireMutationOrigin(request, url);
    const input: unknown = await readJsonBodyWithinBytes(request, maximumBytes);
    const id = params.connection_id ?? "";
    const result = request.method === "PUT"
      ? await service.put(context, id, input)
      : await service.disable(context, id, input);
    return apiResult(request, env, result);
  } catch (error) {
    map(error);
  }
}
