import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  ComputerAgentConnectionError,
  createComputerAgentConnectionService,
} from "./computer-agent-connection-store.js";
import type { ComputerAgentHttpRuntime, ComputerAgentHttpSupport } from "./computer-agent-http-support.js";

function trustedIssuers(runtime: ComputerAgentHttpRuntime, support: ComputerAgentHttpSupport): readonly string[] {
  return [runtime.access_team_domain, runtime.mcp_access_team_domain]
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
        throw support.http_error("COMPUTER_AGENT_CONNECTION_CONFIG_INVALID", 503,
          "Configured Access issuer is invalid", true);
      }
    });
}
function map(error: unknown, support: ComputerAgentHttpSupport): never {
  if (error instanceof ComputerAgentConnectionError) {
    throw support.http_error(error.code, error.status,
      "Computer-agent connection request could not be completed", error.retryable);
  }
  throw error;
}
function requireMutationOrigin(request: Request, url: URL, support: ComputerAgentHttpSupport): void {
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if ((origin !== null && origin !== url.origin) ||
      (request.headers.has("Cookie") && origin === null) ||
      (site !== null && site !== "same-origin" && site !== "none")) {
    throw support.http_error("COMPUTER_AGENT_CONNECTION_CSRF_DENIED", 403,
      "Connection mutation requires a same-origin owner request");
  }
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw support.http_error("COMPUTER_AGENT_CONNECTION_INPUT_INVALID", 415,
      "Connection mutations require application/json");
  }
}

export async function handleComputerAgentConnectionHttp(
  request: Request,
  runtime: ComputerAgentHttpRuntime,
  context: AuthenticatedRequestContext,
  params: Readonly<Record<string, string>>,
  maximumBytes: number,
  support: ComputerAgentHttpSupport,
): Promise<Response> {
  const service = createComputerAgentConnectionService({
    database: runtime.database,
    trusted_issuers: trustedIssuers(runtime, support),
  });
  const url = new URL(request.url);
  try {
    if (request.method === "GET") {
      if ([...url.searchParams.keys()].some((key) => key !== "after_connection_id") ||
          url.searchParams.getAll("after_connection_id").length > 1) {
        throw support.http_error("COMPUTER_AGENT_CONNECTION_INPUT_INVALID", 400,
          "Unsupported or duplicate connection-list query parameter");
      }
      return support.api_result(request,
        await service.list(context, url.searchParams.get("after_connection_id") ?? ""));
    }
    support.require_no_query(url);
    requireMutationOrigin(request, url, support);
    const input: unknown = await support.read_json_body(request, maximumBytes);
    const id = params.connection_id ?? "";
    const result = request.method === "PUT"
      ? await service.put(context, id, input)
      : await service.disable(context, id, input);
    return support.api_result(request, result);
  } catch (error) {
    map(error, support);
  }
}
