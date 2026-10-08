import type { ApiProblem } from "@eliotr/interfaces";
import { RUNTIME_LIMITS, serializeJsonWithinBytes } from "@eliotr/platform-cloudflare";
import type { Env } from "./env.js";
import { HttpRequestError } from "./http-errors.js";
import { traceId } from "./http-request-auth.js";
export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const serialized = serializeJsonWithinBytes(
    "http.response",
    body,
    RUNTIME_LIMITS.semantic_api_response_bytes,
  );
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-content-type-options", "nosniff");
  return new Response(serialized, { status, headers: responseHeaders });
}
export function problem(
  request: Request,
  status: number,
  code: string,
  title: string,
  retryable: boolean,
  headers?: HeadersInit,
): Response {
  const body: ApiProblem = {
    type: `urn:eliotr:problem:${code.toLowerCase()}`,
    title,
    status,
    code,
    trace_id: traceId(request),
    retryable,
  };
  return jsonResponse(body, status, headers);
}
export function apiResult(request: Request, env: Env, data: unknown, status = 200): Response {
  return jsonResponse({ data, trace_id: traceId(request), deployment_generation: env.DEPLOYMENT_GENERATION }, status);
}
export function requireNoQuery(url: URL): void {
  if ([...url.searchParams.keys()].length > 0) {
    throw new HttpRequestError(
      "UNKNOWN_QUERY_PARAMETER",
      400,
      "this route does not accept query parameters",
    );
  }
}
