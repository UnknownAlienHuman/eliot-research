import type { AuthenticatedRequestContext, RouteDefinition } from "@eliotr/interfaces";
import type { AccessIdentity } from "@eliotr/platform-cloudflare";
import { apiResult, HttpRequestError, requireNoQuery, type HttpDependencies } from "./http.js";
import { handleGoogleOAuthBegin } from "./google-oauth-begin.js";
import { handleGoogleOAuthCallback } from "./google-oauth-callback.js";
import { handleGoogleConnectionDisconnect, handleGoogleConnectionStatus, handleGoogleOAuthReconnectBegin } from "./google-oauth-lifecycle.js";
import type { Env } from "./env.js";
import { readGoogleExternalTransport } from "@eliotr/cloudflare-workspace-mcp";

interface SpecialRouteMatch {
  readonly route: RouteDefinition;
}

function requireDriveExchangeTransport(env: Env): void {
  let transport;
  try {
    transport = readGoogleExternalTransport(env.GOOGLE_EXTERNAL_TRANSPORT);
  } catch {
    throw new HttpRequestError("GOOGLE_TRANSPORT_CONFIG_INVALID", 503,
      "Google external transport configuration is invalid", true);
  }
  if (transport !== "drive-exchange") {
    throw new HttpRequestError("GOOGLE_DRIVE_EXCHANGE_NOT_SELECTED", 409,
      "Google Drive Exchange routes require GOOGLE_EXTERNAL_TRANSPORT=drive-exchange");
  }
}

/** Dispatch routes whose protocol is owned by the HTTP adapter itself. */
export async function dispatchHttpSpecialRoute(input: {
  readonly request: Request;
  readonly env: Env;
  readonly url: URL;
  readonly match: SpecialRouteMatch;
  readonly context: AuthenticatedRequestContext;
  readonly identity: AccessIdentity;
  readonly dependencies: HttpDependencies;
}): Promise<Response | null> {
  if (input.match.route.operation.startsWith("google.oauth.") ||
      input.match.route.operation.startsWith("google.connection.")) {
    requireDriveExchangeTransport(input.env);
  }
  switch (input.match.route.operation) {
    case "google.oauth.begin":
      requireNoQuery(input.url);
      return handleGoogleOAuthBegin(input.request, input.env, input.context, input.identity, input.dependencies);
    case "google.oauth.callback":
      return handleGoogleOAuthCallback(input.request, input.env, input.context, input.identity, input.dependencies);
    case "google.oauth.reconnect":
      return handleGoogleOAuthReconnectBegin(input.request, input.env, input.context, input.identity, input.dependencies);
    case "google.connection.status":
      return handleGoogleConnectionStatus(input.request, input.env, input.context, input.identity, input.dependencies);
    case "google.connection.disconnect":
      return handleGoogleConnectionDisconnect(input.request, input.env, input.context, input.identity, input.dependencies);
    case "system.session":
      requireNoQuery(input.url);
      return apiResult(input.request, input.env, {
        protocol: "eliotr.owner-session.v1",
        principal_ref: input.context.principal_ref,
        client_class: input.context.client_class,
        credential_generation: input.context.credential_generation,
        expires_at: input.identity.expires_at,
      });
    default:
      return null;
  }
}
