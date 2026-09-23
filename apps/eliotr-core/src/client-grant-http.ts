import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { ClientGrantError, createProjectClientGrantService } from "@eliotr/cloudflare-navigation";
import { apiResult, HttpRequestError, requireNoQuery } from "./http.js";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import { readReadiness } from "./readiness.js";
import type { Env } from "./env.js";

function trustedIssuers(env: Env): readonly string[] {
  return [env.ACCESS_TEAM_DOMAIN, env.MCP_ACCESS_TEAM_DOMAIN].filter((raw): raw is string => raw !== undefined)
    .map((raw) => {
      try {
        const url = new URL(raw);
        if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" ||
            url.search || url.hash || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/u.test(url.hostname)) throw new Error();
        return url.origin;
      } catch { throw new ClientGrantError("CLIENT_GRANT_CONFIG_INVALID", 503, "Configured Access issuer is invalid"); }
    });
}

/** Owner management only; the service client cannot issue or modify its own grant. */
export async function handleClientGrantHttp(request: Request, env: Env, context: AuthenticatedRequestContext,
  params: Readonly<Record<string, string>>, maximumBytes: number): Promise<Response> {
  const readiness = await readReadiness(env);
  if (!readiness.ready) throw new HttpRequestError("SCHEMA_NOT_READY", 503, "Required migrations are not applied", true);
  if (context.client_class !== "owner_pwa") throw new ClientGrantError("CLIENT_GRANT_OWNER_REQUIRED", 403, "Owner authentication required");
  const url = new URL(request.url);
  const service = createProjectClientGrantService({ database: env.CORE_DB, trusted_issuers: trustedIssuers(env) });
  const project = params.project_id ?? "";
  if (request.method === "GET") {
    if ([...url.searchParams.keys()].some((key) => key !== "after_grant_id") || url.searchParams.getAll("after_grant_id").length > 1) {
      throw new HttpRequestError("CLIENT_GRANT_INPUT_INVALID", 400, "Unsupported or duplicate grant-list query parameter");
    }
    return apiResult(request, env, await service.list(context, project, url.searchParams.get("after_grant_id") ?? ""));
  }
  requireNoQuery(url);
  // Cookie-bearing browser mutations must prove same origin. A verified header-only caller may omit Origin.
  const origin = request.headers.get("Origin"); const site = request.headers.get("Sec-Fetch-Site");
  if ((origin !== null && origin !== url.origin) || (request.headers.has("Cookie") && origin === null) ||
      (site !== null && site !== "same-origin" && site !== "none")) {
    throw new HttpRequestError("CLIENT_GRANT_CSRF_DENIED", 403, "Grant mutation requires a same-origin request");
  }
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpRequestError("CLIENT_GRANT_INPUT_INVALID", 415, "Grant mutations require application/json");
  }
  const input: unknown = await readJsonBodyWithinBytes(request, maximumBytes);
  const result = request.method === "PUT" ? await service.put(context, project, params.grant_id ?? "", input) :
    await service.revoke(context, project, params.grant_id ?? "", input);
  return apiResult(request, env, result);
}
