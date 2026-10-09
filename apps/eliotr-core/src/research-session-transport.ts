import { routeAgentRequest } from "agents";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "./env.js";
import { HttpRequestError } from "./http-errors.js";
import { bootstrapResearchSession } from "./research-session-bootstrap.js";
import { SESSION_ACCESS_EXPIRY_HEADER } from "./research-session-connection-authority.js";

/** The outer Access boundary has authenticated this request before SDK routing. */
export async function handleResearchSessionTransport(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
): Promise<Response> {
  if (context.client_class !== "owner_pwa") {
    throw new HttpRequestError("PRINCIPAL_CLASS_DENIED", 403,
      "authenticated principal class is not allowed for this operation");
  }
  const identity = context.access;
  if (identity === undefined || identity.principal_ref !== context.principal_ref ||
      identity.credential_generation !== context.credential_generation ||
      !Number.isFinite(Date.parse(identity.expires_at)) || Date.parse(identity.expires_at) <= Date.now()) {
    throw new HttpRequestError("SESSION_AUTHORITY_STALE", 409, "research session requires current Access authority");
  }
  const url = new URL(request.url);
  const match = /^\/agents\/research-session\/([A-Za-z0-9][A-Za-z0-9:._-]{0,127})(?:\/get-messages)?$/u.exec(url.pathname);
  if (match === null || url.searchParams.has("session_id")) {
    throw new HttpRequestError("RESEARCH_INPUT_INVALID", 400, "research session locator is invalid");
  }
  const headers = new Headers(request.headers);
  for (const name of headers.keys()) {
    if (name.startsWith("x-research-") || name.startsWith("x-agents-")) headers.delete(name);
  }
  headers.set("x-research-principal", context.principal_ref);
  headers.set("x-research-credential", context.credential_generation);
  headers.set("x-research-deployment", env.DEPLOYMENT_GENERATION);
  headers.set(SESSION_ACCESS_EXPIRY_HEADER, identity.expires_at);
  headers.set("cf-ray", context.trace_id);
  const sessionId = match[1];
  if (sessionId === undefined) throw new HttpRequestError("RESEARCH_INPUT_INVALID", 400, "research session locator is invalid");
  const bootstrap = await bootstrapResearchSession(env, context, sessionId, headers);
  if (bootstrap !== null) return bootstrap;
  const response = await routeAgentRequest(new Request(request, { headers }), {
    RESEARCH_SESSION: env.RESEARCH_SESSION,
  }, { routingRetry: false });
  if (response === null) {
    throw new HttpRequestError("ROUTE_NOT_FOUND", 404, "research session route does not exist");
  }
  return response;
}
