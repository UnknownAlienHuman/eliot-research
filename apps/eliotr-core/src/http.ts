import type { AccessVerifier } from "@eliotr/cloudflare-access";
import type { ApplicationLifecycle, RouteDefinition } from "@eliotr/interfaces";
import { ROUTES } from "@eliotr/interfaces";
import { createApplication, type CompositionRootInput } from "./composition-root.js";
import type { Env } from "./env.js";
import { readReadiness } from "./readiness.js";
import { dispatchHttpSpecialRoute } from "./http-special-routes.js";
import { fetchStaticAsset } from "./agent-inbox-static.js";
import { HttpRequestError, mapError } from "./http-errors.js";
import { authorize, configuredAccessVerifier } from "./http-request-auth.js";
import { apiResult, jsonResponse, problem, requireNoQuery } from "./http-response.js";
import { dispatchHttpApiRoute, type HttpRouteMatch } from "./http-api-dispatch.js";
import { MAX_QUERY_VALUE_BYTES } from "./http-route-inputs.js";

export { HttpRequestError } from "./http-errors.js";
export { configuredAccessVerifier };
export { apiResult, problem, requireNoQuery };
export interface HttpDependencies {
  readonly accessVerifier?: AccessVerifier;
  readonly applicationFactory?: (input: CompositionRootInput) => ApplicationLifecycle;
}
function matchPattern(pattern: string, pathname: string): Readonly<Record<string, string>> | null {
  if (pathname.length > 1 && (pathname.endsWith("/") || pathname.includes("//"))) return null;
  const expected = pattern.split("/").filter(Boolean);
  const actual = pathname.split("/").filter(Boolean);
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const expectedSegment = expected[index];
    const actualSegment = actual[index];
    if (expectedSegment === undefined || actualSegment === undefined) return null;
    if (!expectedSegment.startsWith(":")) {
      if (expectedSegment !== actualSegment) return null;
      continue;
    }
    let decoded: string;
    try { decoded = decodeURIComponent(actualSegment); }
    catch { return null; }
    if (
      decoded.length === 0 ||
      decoded.includes("/") ||
      new TextEncoder().encode(decoded).byteLength > MAX_QUERY_VALUE_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(decoded)
    ) return null;
    params[expectedSegment.slice(1)] = decoded;
  }
  return params;
}
function resolveRoute(request: Request, pathname: string): {
  readonly match?: HttpRouteMatch;
  readonly allowedMethods: readonly string[];
} {
  const pathMatches = ROUTES.flatMap((route) => {
    const params = matchPattern(route.path, pathname);
    return params === null ? [] : [{ route, params }];
  });
  const match = pathMatches.find(({ route }) => route.method === request.method);
  if (match !== undefined) return { match, allowedMethods: [] };
  return {
    allowedMethods: [...new Set(pathMatches.map(({ route }) => route.method))].sort(),
  };
}
function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/") ||
    pathname.startsWith("/federation/") ||
    pathname.startsWith("/oauth/");
}
function validateContentLength(request: Request, route: RouteDefinition): void {
  const raw = request.headers.get("content-length");
  if (raw === null) return;
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) {
    throw new HttpRequestError("INVALID_CONTENT_LENGTH", 400, "Content-Length is invalid");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new HttpRequestError("INVALID_CONTENT_LENGTH", 400, "Content-Length is unsafe");
  }
  if (value > route.maximum_request_bytes) {
    throw new HttpRequestError("REQUEST_BODY_TOO_LARGE", 413, "request body exceeds the route limit");
  }
}
// IMPLEMENTED_NOT_LIVE: ER-24 HTTP dispatch requires live owner/service Access receipts.
export async function handleHttp(
  request: Request,
  env: Env,
  executionContext: ExecutionContext,
  dependencies: HttpDependencies = {},
): Promise<Response> {
  const url = new URL(request.url);
  const resolved = resolveRoute(request, url.pathname);
  if (resolved.match === undefined) {
    if (resolved.allowedMethods.length > 0) {
      return problem(
        request,
        405,
        "METHOD_NOT_ALLOWED",
        "Method is not allowed for this route",
        false,
        { allow: resolved.allowedMethods.join(", ") },
      );
    }
    if (isApiPath(url.pathname)) {
      return problem(request, 404, "ROUTE_NOT_FOUND", "API route does not exist", false);
    }
    return fetchStaticAsset(request, env, url);
  }
  try {
    validateContentLength(request, resolved.match.route);
    if (resolved.match.route.auth === "public") {
      requireNoQuery(url);
      const readiness = await readReadiness(env);
      return jsonResponse({
        ready: readiness.ready,
        deployment_generation: readiness.deployment_generation,
        checked_at: readiness.checked_at,
      }, readiness.ready ? 200 : 503);
    }
    const verifier = dependencies.accessVerifier ?? configuredAccessVerifier(env);
    const identity = await verifier.verify(request);
    const context = authorize(request, resolved.match.route, identity);
    const special = await dispatchHttpSpecialRoute({ request, env, url, match: resolved.match, context, identity, dependencies });
    if (special !== null) return special;
    const factory = dependencies.applicationFactory ?? createApplication;
    const application = factory({ env, executionContext });
    return await dispatchHttpApiRoute(request, env, application, context, resolved.match, url);
  } catch (error) {
    return mapError(request, error, problem);
  }
}
