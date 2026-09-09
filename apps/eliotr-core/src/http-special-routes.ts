import type { AuthenticatedRequestContext, RouteDefinition } from "@eliotr/interfaces";
import type { AccessIdentity } from "@eliotr/platform-cloudflare";
import { apiResult, requireNoQuery, type HttpDependencies } from "./http.js";
import { handleGoogleOAuthBegin } from "./google-oauth-begin.js";
import { handleGoogleOAuthCallback } from "./google-oauth-callback.js";
import type { Env } from "./env.js";

interface SpecialRouteMatch {
  readonly route: RouteDefinition;
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
  switch (input.match.route.operation) {
    case "google.oauth.begin":
      requireNoQuery(input.url);
      return handleGoogleOAuthBegin(input.request, input.env, input.context, input.identity, input.dependencies);
    case "google.oauth.callback":
      return handleGoogleOAuthCallback(input.request, input.env, input.context, input.identity, input.dependencies);
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
