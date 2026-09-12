import {
  McpDiagnosticCreateInputSchema,
  type McpDiagnosticAuthProfile,
} from "@eliotr/contracts";
import {
  McpClientDiagnosticServiceError,
  createD1McpClientDiagnosticService,
} from "./mcp-client-diagnostics.js";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { AccessIdentity } from "@eliotr/cloudflare-access";
import type { Env } from "./env.js";
import {
  apiResult,
  HttpRequestError,
  problem,
  requireNoQuery,
  type HttpDependencies,
} from "./http.js";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import { readReadiness } from "./readiness.js";

const MCP_DIAGNOSTIC_BODY_BYTES = 1024;

function requireOwnerOriginAndCsrf(request: Request): void {
  const expectedOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "" && origin !== expectedOrigin) {
    throw new HttpRequestError("MCP_DIAGNOSTIC_ORIGIN_FORBIDDEN", 403, "Cross-origin client diagnostic requests are forbidden");
  }
  const referer = request.headers.get("referer");
  if (referer !== null && referer !== expectedOrigin && !referer.startsWith(`${expectedOrigin}/`)) {
    throw new HttpRequestError("MCP_DIAGNOSTIC_ORIGIN_FORBIDDEN", 403, "Cross-origin client diagnostic requests are forbidden");
  }
  if (request.method === "POST" && (origin === null || origin === "")) {
    throw new HttpRequestError("MCP_DIAGNOSTIC_ORIGIN_REQUIRED", 400, "Client diagnostic requests require an Origin header");
  }
  if (request.method === "POST" && request.headers.get("x-eliotr-csrf") !== "1") {
    throw new HttpRequestError("MCP_DIAGNOSTIC_CSRF_REQUIRED", 400, "Client diagnostic requests require the CSRF header");
  }
}

export function requiredMcpDiagnosticAuthProfile(
  env: Pick<Env, "MCP_ACCESS_AUTH_PROFILE">,
): McpDiagnosticAuthProfile {
  const profile = env.MCP_ACCESS_AUTH_PROFILE;
  if (profile === "service-token" || profile === "managed-oauth") return profile;
  throw new HttpRequestError(
    "MCP_DIAGNOSTIC_CONFIG_INVALID",
    503,
    "Client diagnostic authentication profile is missing or invalid",
    true,
  );
}

export function configuredMcpClientDiagnosticService(env: Env) {
  return createD1McpClientDiagnosticService(env.CORE_DB, {
    now: Date.now,
    auth_profile: requiredMcpDiagnosticAuthProfile(env),
    deployment_generation: env.DEPLOYMENT_GENERATION,
  });
}

function diagnosticServiceErrorResponse(
  request: Request,
  error: McpClientDiagnosticServiceError,
): Response {
  const title = error.code === "MCP_DIAGNOSTIC_CHALLENGE_NOT_FOUND"
    ? "Client diagnostic challenge does not exist"
    : error.code === "MCP_DIAGNOSTIC_CHALLENGE_EXPIRED"
      ? "Client diagnostic challenge has expired"
      : error.code === "MCP_DIAGNOSTIC_CHALLENGE_REPLAY"
        ? "Client diagnostic challenge was already consumed"
        : error.code === "MCP_DIAGNOSTIC_MCP_PROFILE_MISMATCH" ||
            error.code === "MCP_DIAGNOSTIC_MCP_DEPLOYMENT_MISMATCH"
          ? "Client diagnostic authentication is not current"
          : error.code === "MCP_DIAGNOSTIC_TOKEN_INVALID"
            ? "Client diagnostic challenge token is invalid"
            : error.code === "MCP_DIAGNOSTIC_CONFIG_INVALID"
              ? "Client diagnostic configuration is unavailable"
              : error.status === 503
                ? "Client diagnostic service is temporarily unavailable"
                : "Client diagnostic request cannot be completed";
  return problem(request, error.status, error.code, title, error.retryable);
}

function unknownDiagnosticErrorResponse(request: Request): Response {
  return problem(
    request,
    503,
    "MCP_DIAGNOSTIC_UNAVAILABLE",
    "Client diagnostic service is temporarily unavailable",
    true,
  );
}

function ownerOf(context: AuthenticatedRequestContext) {
  return {
    principal_ref: context.principal_ref,
    credential_generation: context.credential_generation,
  } as const;
}

async function ready(env: Env, request: Request): Promise<Response | null> {
  const readiness = await readReadiness(env);
  return readiness.ready
    ? null
    : problem(request, 503, "SCHEMA_NOT_READY", "Required D1 migrations are not applied", true);
}

export async function handleMcpClientDiagnosticIssue(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  _identity: AccessIdentity,
  _dependencies: HttpDependencies,
): Promise<Response> {
  const blocked = await ready(env, request);
  if (blocked !== null) return blocked;
  requireNoQuery(new URL(request.url));
  requireOwnerOriginAndCsrf(request);
  const body = await readJsonBodyWithinBytes(request, MCP_DIAGNOSTIC_BODY_BYTES);
  if (!McpDiagnosticCreateInputSchema.safeParse(body).success) {
    throw new HttpRequestError("MCP_DIAGNOSTIC_INPUT_INVALID", 400, "Client diagnostic issue accepts only an empty JSON object");
  }
  let service;
  try {
    service = configuredMcpClientDiagnosticService(env);
    const result = await service.issue(ownerOf(context));
    return apiResult(request, env, result, 201);
  } catch (error) {
    if (error instanceof McpClientDiagnosticServiceError) return diagnosticServiceErrorResponse(request, error);
    if (error instanceof HttpRequestError) throw error;
    return unknownDiagnosticErrorResponse(request);
  }
}

export async function handleMcpClientDiagnosticLatest(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  _identity: AccessIdentity,
  _dependencies: HttpDependencies,
): Promise<Response> {
  const blocked = await ready(env, request);
  if (blocked !== null) return blocked;
  requireNoQuery(new URL(request.url));
  requireOwnerOriginAndCsrf(request);
  try {
    const service = configuredMcpClientDiagnosticService(env);
    const result = await service.latest(ownerOf(context));
    return result === null
      ? problem(request, 404, "MCP_DIAGNOSTIC_CHALLENGE_NOT_FOUND", "Client diagnostic challenge does not exist", false)
      : apiResult(request, env, result);
  } catch (error) {
    if (error instanceof McpClientDiagnosticServiceError) return diagnosticServiceErrorResponse(request, error);
    if (error instanceof HttpRequestError) throw error;
    return unknownDiagnosticErrorResponse(request);
  }
}
