// IMPLEMENTED_NOT_LIVE: ER-36 Gemini Spark MCP requires live Access and Google readback receipts.
import {
  AccessVerificationError,
  createCloudflareAccessVerifier,
  type AccessIdentity,
  type AccessVerifier,
} from "@eliotr/platform-cloudflare";
import {
  GeminiMcpToolError,
  readGoogleExternalTransport,
  sha256,
  stable,
} from "./gemini-mcp-tool-common.js";
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

const MCP_LOGICAL_PRINCIPAL = "gemini-spark";
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const ACCESS_SERVICE_TOKEN_CLIENT_ID =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}\.access$/u;
const MCP_ACCESS_AUTH_PROFILES = ["service-token", "managed-oauth"] as const;
type McpAccessAuthProfile = typeof MCP_ACCESS_AUTH_PROFILES[number];

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
  return candidate !== null && SAFE_TRACE_ID.test(candidate)
    ? candidate
    : crypto.randomUUID();
}

function jsonError(
  status: number,
  code: string,
  trace: string,
  retryable = false,
): Response {
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

function requiredServiceTokenClientId(raw: string | undefined): string {
  if (
    raw === undefined ||
    raw.length > 256 ||
    !ACCESS_SERVICE_TOKEN_CLIENT_ID.test(raw)
  ) {
    throw new AccessVerificationError(
      "ACCESS_CONFIG_INVALID",
      "MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID must be the exact Cloudflare Access service-token Client ID",
      true,
    );
  }
  return raw;
}

function accessAuthProfile(raw: unknown): McpAccessAuthProfile {
  if (raw === undefined) return "service-token";
  if (typeof raw !== "string" || !MCP_ACCESS_AUTH_PROFILES.includes(raw as McpAccessAuthProfile)) {
    throw new AccessVerificationError(
      "ACCESS_CONFIG_INVALID",
      "MCP_ACCESS_AUTH_PROFILE must be service-token or managed-oauth",
      true,
    );
  }
  return raw as McpAccessAuthProfile;
}

function requiredAccessTeamDomain(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "" || raw !== raw.trim()) {
    throw new AccessVerificationError(
      "ACCESS_CONFIG_INVALID",
      "Dedicated MCP Cloudflare Access team domain is missing",
      true,
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AccessVerificationError("ACCESS_CONFIG_INVALID", "Dedicated MCP team domain is invalid", true);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" ||
      url.pathname !== "/" || url.search !== "" || url.hash !== "" ||
      !url.hostname.endsWith(".cloudflareaccess.com")) {
    throw new AccessVerificationError("ACCESS_CONFIG_INVALID", "Dedicated MCP team domain is invalid", true);
  }
  return url.origin;
}

function requiredAccessAudience(raw: string | undefined, ordinary: string | undefined): string {
  if (raw === undefined || raw.trim() === "" || raw !== raw.trim() || raw.length > 512 ||
      /[\u0000-\u001f\u007f]/u.test(raw)) {
    throw new AccessVerificationError("ACCESS_CONFIG_INVALID", "Dedicated MCP Access audience is missing", true);
  }
  if (ordinary !== undefined && raw === ordinary) {
    throw new AccessVerificationError(
      "ACCESS_CONFIG_INVALID",
      "Dedicated MCP Access audience must differ from the ordinary Access audience",
      true,
    );
  }
  return raw;
}

function configuredVerifier(
  env: Env,
  profile: McpAccessAuthProfile,
  serviceTokenClientId: string,
): AccessVerifier {
  const teamDomain = requiredAccessTeamDomain(env.MCP_ACCESS_TEAM_DOMAIN);
  const audience = requiredAccessAudience(env.MCP_ACCESS_AUDIENCE, env.ACCESS_AUDIENCE);
  const key = JSON.stringify([
    profile,
    teamDomain,
    audience,
    serviceTokenClientId,
  ]);
  if (verifierCache?.key === key) return verifierCache.verifier;
  const verifier = createCloudflareAccessVerifier({
    team_domain: teamDomain,
    audience,
    ...(profile === "service-token"
      ? { allowed_service_principal_common_names: [serviceTokenClientId] }
      : {}),
  });
  verifierCache = { key, verifier };
  return verifier;
}

function googleTransport(env: Env): GoogleExternalTransport {
  return readGoogleExternalTransport(env.GOOGLE_EXTERNAL_TRANSPORT);
}

async function authenticatedContext(
  identity: AccessIdentity,
  trace: string,
  profile: McpAccessAuthProfile,
  expectedServiceTokenClientId: string,
  accessTeamDomain: string | undefined,
  accessAudience: string | undefined,
  deploymentGeneration: string,
): Promise<McpToolCallContext | Response> {
  if (profile === "service-token") {
    if (
      identity.authentication_method !== "service_token" ||
      identity.principal_ref !== expectedServiceTokenClientId
    ) {
      return jsonError(403, "MCP_SERVICE_PRINCIPAL_DENIED", trace);
    }
    return {
      principal_ref: MCP_LOGICAL_PRINCIPAL,
      trace_id: trace,
      deployment_generation: deploymentGeneration,
    };
  }

  if (identity.authentication_method !== "cloudflare_access") {
    return jsonError(403, "MCP_MANAGED_OAUTH_CREDENTIAL_DENIED", trace);
  }
  const issuer = requiredAccessTeamDomain(accessTeamDomain);
  const audience = requiredAccessAudience(accessAudience, undefined);
  // AccessIdentity.principal_ref is the verifier's checked JWT subject for a
  // managed identity. Hash the verified tuple before it enters any ELIOT
  // context, so logs/receipts never carry provider PII while two identities
  // remain distinct within the dedicated auth profile.
  const principalRef = await sha256(JSON.stringify(stable({
    protocol: "eliot.mcp.managed-actor.v1",
    profile,
    issuer,
    audience,
    subject: identity.principal_ref,
  })));
  return {
    principal_ref: `mcp-actor-${principalRef}`,
    trace_id: trace,
    deployment_generation: deploymentGeneration,
  };
}

function serverDependencies(
  env: Env,
  profile: McpAccessAuthProfile,
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
        enabled_surfaces: [
          "system_status",
          "google_sync_planning",
        ],
        disabled_surfaces: [{ surface: "catalog", reason: "MCP_CATALOG_SCOPE_REQUIRED" }],
        google_external_transport: googleTransport(env),
        mcp_access_auth_profile: profile,
        exact_readback_required: true,
        canonical_mutation_available_through_mcp: false,
      };
    },
    async catalog(): Promise<never> {
      // A dedicated Access token proves the caller, not authorization to every owner's library.
      // The current read-policy schema is owner-only. Never impersonate an owner for a service token.
      throw new GeminiMcpToolError("MCP_CATALOG_SCOPE_REQUIRED", "An explicit service catalog scope is required");
    },
  } as const;
  return {
    server_version: "0.1.0",
    deployment_generation: env.DEPLOYMENT_GENERATION,
    listTools: () => GEMINI_MCP_TOOLS.filter((tool) => tool.name !== "eliotr_catalog"),
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
  let profile: McpAccessAuthProfile;
  let configuredClientId: string | undefined;
  try {
    hostname = requiredHostname(env.MCP_HOSTNAME);
    // Validate the selected external transport before authentication so an
    // unknown or mixed deployment cannot be probed through the auth boundary.
    googleTransport(env);
    profile = accessAuthProfile(env.MCP_ACCESS_AUTH_PROFILE);
    if (profile === "service-token" && (
      dependencies.accessVerifier === undefined ||
      env.MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID !== undefined
    )) {
      configuredClientId = requiredServiceTokenClientId(
        env.MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID,
      );
    } else if (env.MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID !== undefined) {
      throw new AccessVerificationError(
        "ACCESS_CONFIG_INVALID",
        "Managed OAuth MCP profile must not configure a service-token Client ID",
        true,
      );
    }
    if (profile === "managed-oauth" || dependencies.accessVerifier === undefined) {
      requiredAccessTeamDomain(env.MCP_ACCESS_TEAM_DOMAIN);
      if (profile === "managed-oauth" && env.ACCESS_AUDIENCE === undefined) {
        throw new AccessVerificationError(
          "ACCESS_CONFIG_INVALID",
          "Ordinary Access audience is required to prove a dedicated managed MCP audience",
          true,
        );
      }
      requiredAccessAudience(env.MCP_ACCESS_AUDIENCE, env.ACCESS_AUDIENCE);
    }
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
    const verifier = dependencies.accessVerifier ?? configuredVerifier(
      env,
      profile,
      configuredClientId ?? "managed-oauth",
    );
    identity = await verifier.verify(request);
  } catch (error) {
    if (error instanceof AccessVerificationError) {
      const unavailable = error.retryable ||
        error.code === "ACCESS_CONFIG_INVALID" ||
        error.code === "ACCESS_JWKS_UNAVAILABLE" ||
        error.code === "ACCESS_JWKS_INVALID";
      return jsonError(
        unavailable
          ? 503
          : error.code === "ACCESS_SERVICE_PRINCIPAL_DENIED"
            ? 403
            : 401,
        unavailable
          ? "MCP_AUTHENTICATION_UNAVAILABLE"
          : "MCP_AUTHENTICATION_FAILED",
        trace,
        unavailable,
      );
    }
    return jsonError(503, "MCP_AUTHENTICATION_UNAVAILABLE", trace, true);
  }

  const context = await authenticatedContext(
    identity,
    trace,
    profile,
    configuredClientId ?? "",
    env.MCP_ACCESS_TEAM_DOMAIN,
    env.MCP_ACCESS_AUDIENCE,
    env.DEPLOYMENT_GENERATION,
  );
  if (context instanceof Response) return context;
  try {
    return handleGeminiMcpProtocol(
      request,
      serverDependencies(env, profile, dependencies.now ?? Date.now),
      context,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("GOOGLE_EXTERNAL_TRANSPORT ")) {
      return jsonError(503, "MCP_CONFIGURATION_UNAVAILABLE", trace, true);
    }
    throw error;
  }
}
