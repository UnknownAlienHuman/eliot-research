// IMPLEMENTED_NOT_LIVE: ER-36 Gemini Spark MCP requires live Access and Google readback receipts.
import {
  AccessVerificationError,
  createCloudflareAccessVerifier,
  type AccessIdentity,
  type AccessVerifier,
} from "@eliotr/platform-cloudflare";
import { readCatalog } from "./catalog-service.js";
import type { Env } from "./env.js";
import {
  handleGeminiMcpProtocol,
  type GeminiMcpServerDependencies,
  type McpToolCallContext,
} from "./gemini-mcp-protocol.js";
import {
  callGeminiMcpTool,
  GEMINI_MCP_TOOLS,
  type GoogleExternalTransport,
} from "./gemini-mcp-tools.js";
import { readReadiness } from "./readiness.js";

const REQUIRED_MCP_SERVICE_PRINCIPAL = "gemini-spark";
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const ALLOWED_TRANSPORTS = new Set<GoogleExternalTransport>([
  "disabled",
  "gemini-mcp",
  "drive-exchange",
]);

interface AccessVerifierCache {
  readonly key: string;
  readonly verifier: AccessVerifier;
}

export interface GeminiMcpHttpDependencies {
  readonly accessVerifier?: AccessVerifier;
  readonly now?: () => number;
}

let verifierCache: AccessVerifierCache | undefined;

function traceId(request: Request): string {
  const candidate = request.headers.get("cf-ray");
  return candidate !== null && SAFE_TRACE_ID.test(candidate) ? candidate : crypto.randomUUID();
}

function jsonError(status: number, code: string, trace: string, retryable = false): Response {
  return new Response(JSON.stringify({
    protocol: "eliotr.mcp.http-error.v1",
    code,
    trace_id: trace,
    retryable,
  }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function requiredHostname(raw: string | undefined): string {
  if (
    raw === undefined ||
    raw.length === 0 ||
    raw !== raw.trim() ||
    raw !== raw.toLowerCase() ||
    raw.includes("://") ||
    raw.includes("/") ||
    raw.startsWith("*") ||
    !SAFE_HOSTNAME.test(raw)
  ) {
    throw new AccessVerificationError(
      "ACCESS_CONFIG_INVALID",
      "MCP_HOSTNAME must be one exact lowercase hostname",
      true,
    );
  }
  return raw;
}

function configuredVerifier(env: Env): AccessVerifier {
  if (env.MCP_ACCESS_TEAM_DOMAIN === undefined || env.MCP_ACCESS_AUDIENCE === undefined) {
    throw new AccessVerificationError(
      "ACCESS_CONFIG_INVALID",
      "Dedicated MCP Cloudflare Access runtime configuration is missing",
      true,
    );
  }
  const key = JSON.stringify([
    env.MCP_ACCESS_TEAM_DOMAIN,
    env.MCP_ACCESS_AUDIENCE,
    REQUIRED_MCP_SERVICE_PRINCIPAL,
  ]);
  if (verifierCache?.key === key) return verifierCache.verifier;
  const verifier = createCloudflareAccessVerifier({
    team_domain: env.MCP_ACCESS_TEAM_DOMAIN,
    audience: env.MCP_ACCESS_AUDIENCE,
    allowed_service_principal_common_names: [REQUIRED_MCP_SERVICE_PRINCIPAL],
  });
  verifierCache = { key, verifier };
  return verifier;
}

function googleTransport(env: Env): GoogleExternalTransport {
  const value = env.GOOGLE_EXTERNAL_TRANSPORT ?? "disabled";
  if (!ALLOWED_TRANSPORTS.has(value)) return "disabled";
  return value;
}

function authenticatedContext(
  env: Env,
  identity: AccessIdentity,
  trace: string,
): McpToolCallContext | Response {
  if (
    identity.authentication_method !== "service_token" ||
    identity.principal_ref !== REQUIRED_MCP_SERVICE_PRINCIPAL
  ) {
    return jsonError(403, "MCP_SERVICE_PRINCIPAL_DENIED", trace);
  }
  return {
    principal_ref: identity.principal_ref,
    trace_id: trace,
    deployment_generation: env.DEPLOYMENT_GENERATION,
  };
}

function serverDependencies(
  env: Env,
  now: () => number,
): GeminiMcpServerDependencies {
  const toolDependencies = {
    google_transport: googleTransport(env),
    now,
    async systemStatus(): Promise<Record<string, unknown>> {
      const readiness = await readReadiness(env);
      return {
        protocol: "eliotr.mcp.system-status.v1",
        environment: env.ENVIRONMENT,
        deployment_generation: env.DEPLOYMENT_GENERATION,
        ready: readiness.ready,
        blocking_reason_codes: readiness.blocking_reason_codes,
        enabled_surfaces: ["system_status", "catalog", "google_sync_planning"],
        google_external_transport: googleTransport(env),
        exact_readback_required: true,
        canonical_mutation_available_through_mcp: false,
      };
    },
    async catalog(
      input: { readonly project_id?: string; readonly cursor?: string; readonly limit: number },
    ): Promise<unknown> {
      return readCatalog(env.CORE_DB, input);
    },
  } as const;
  return {
    server_version: "0.1.0",
    deployment_generation: env.DEPLOYMENT_GENERATION,
    listTools: () => GEMINI_MCP_TOOLS,
    callTool: (name, input, context) =>
      callGeminiMcpTool(toolDependencies, name, input, context),
  };
}

export async function handleGeminiMcp(
  request: Request,
  env: Env,
  _executionContext: ExecutionContext,
  dependencies: GeminiMcpHttpDependencies = {},
): Promise<Response> {
  const trace = traceId(request);
  const url = new URL(request.url);
  let hostname: string;
  try {
    hostname = requiredHostname(env.MCP_HOSTNAME);
  } catch {
    return jsonError(503, "MCP_CONFIGURATION_UNAVAILABLE", trace, true);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== hostname ||
    url.port !== "" ||
    url.pathname !== "/mcp" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return jsonError(404, "MCP_ROUTE_NOT_FOUND", trace);
  }
  if (request.headers.has("origin")) {
    return jsonError(403, "MCP_BROWSER_ORIGIN_DENIED", trace);
  }

  let identity: AccessIdentity;
  try {
    const verifier = dependencies.accessVerifier ?? configuredVerifier(env);
    identity = await verifier.verify(request);
  } catch (error) {
    if (error instanceof AccessVerificationError) {
      const unavailable = error.retryable || error.code === "ACCESS_CONFIG_INVALID" ||
        error.code === "ACCESS_JWKS_UNAVAILABLE" || error.code === "ACCESS_JWKS_INVALID";
      return jsonError(
        unavailable ? 503 : error.code === "ACCESS_SERVICE_PRINCIPAL_DENIED" ? 403 : 401,
        unavailable ? "MCP_AUTHENTICATION_UNAVAILABLE" : "MCP_AUTHENTICATION_FAILED",
        trace,
        unavailable,
      );
    }
    return jsonError(503, "MCP_AUTHENTICATION_UNAVAILABLE", trace, true);
  }

  const context = authenticatedContext(env, identity, trace);
  if (context instanceof Response) return context;
  return handleGeminiMcpProtocol(
    request,
    serverDependencies(env, dependencies.now ?? Date.now),
    context,
  );
}
