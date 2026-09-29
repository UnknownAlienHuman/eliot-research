// IMPLEMENTED_NOT_LIVE: ER-36 Gemini Spark MCP requires live Access and Google readback receipts.
import { isMcpResearchTool, type McpResearchToolCall } from "./gemini-mcp-research-tools.js";
import {
  AccessVerificationError,
  createCloudflareAccessVerifier,
  type AccessIdentity,
  type AccessVerifier,
} from "@eliotr/cloudflare-access";
import {
  GeminiMcpToolError,
  readGoogleExternalTransport as readGoogleExternalTransportValue,
  sha256,
  stable,
  type McpClientDiagnosticConsume,
  type GeminiMcpToolDependencies,
} from "./gemini-mcp-tool-common.js";
import {
  handleGeminiMcpProtocol,
  type McpAccessAuthProfile,
  type GeminiMcpServerDependencies,
  type McpToolCallContext,
  type McpVerifiedActorContext,
} from "./gemini-mcp-protocol.js";
import {
  callGeminiMcpTool,
  GEMINI_MCP_TOOLS,
  type GoogleExternalTransport,
} from "./gemini-mcp-tools.js";
import type { WorkspaceMcpCandidateStore } from "./workspace-mcp-ledger.js";
import { readMcpServiceClients, type McpServiceClient } from "./mcp-service-clients.js";

export interface WorkspaceMcpRuntime {
  readonly DEPLOYMENT_GENERATION: string;
  readonly ENVIRONMENT: string;
  readonly GOOGLE_EXTERNAL_TRANSPORT?: unknown;
  readonly MCP_HOSTNAME?: string | undefined;
  readonly MCP_ACCESS_AUTH_PROFILE?: unknown;
  readonly MCP_ACCESS_TEAM_DOMAIN?: string | undefined;
  readonly MCP_ACCESS_AUDIENCE?: string | undefined;
  readonly MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID?: string | undefined;
  /** Independent service clients; JSON array binding or JSON-encoded array, without secrets. */
  readonly MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS?: unknown;
  readonly ACCESS_AUDIENCE?: string | undefined;
  readonly mcpClientDiagnosticConsume?: McpClientDiagnosticConsume;
  readonly workspaceCandidateStore?: WorkspaceMcpCandidateStore;
  readonly projectCatalog?: GeminiMcpToolDependencies["catalog"];
  readonly research?: McpResearchToolCall;
  readonly readReadiness: () => Promise<{
    readonly ready: boolean;
    readonly blocking_reason_codes: readonly string[];
  }>;
}

const MCP_LOGICAL_PRINCIPAL = "gemini-spark";
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;
const MCP_ACCESS_AUTH_PROFILES = ["service-token", "managed-oauth"] as const;

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
  env: WorkspaceMcpRuntime,
  profile: McpAccessAuthProfile,
  serviceTokenClientIds: readonly string[],
): AccessVerifier {
  const teamDomain = requiredAccessTeamDomain(env.MCP_ACCESS_TEAM_DOMAIN);
  const audience = requiredAccessAudience(env.MCP_ACCESS_AUDIENCE, env.ACCESS_AUDIENCE);
  const key = JSON.stringify([
    profile,
    teamDomain,
    audience,
    serviceTokenClientIds,
  ]);
  if (verifierCache?.key === key) return verifierCache.verifier;
  const verifier = createCloudflareAccessVerifier({
    team_domain: teamDomain,
    audience,
    ...(profile === "service-token"
      ? { allowed_service_principal_common_names: serviceTokenClientIds }
      : {}),
  });
  verifierCache = { key, verifier };
  return verifier;
}

function googleTransport(env: WorkspaceMcpRuntime): GoogleExternalTransport {
  return readGoogleExternalTransportValue(env.GOOGLE_EXTERNAL_TRANSPORT);
}

function hasVerifiedIdentityShape(identity: AccessIdentity): boolean {
  return typeof identity.principal_ref === "string" && identity.principal_ref.length > 0 &&
    typeof identity.credential_generation === "string" && identity.credential_generation.length > 0 &&
    identity.credential_generation.length <= 256 &&
    (identity.authentication_method === "cloudflare_access" || identity.authentication_method === "service_token") &&
    typeof identity.expires_at === "string" && Number.isSafeInteger(Date.parse(identity.expires_at)) &&
    new Date(identity.expires_at).toISOString() === identity.expires_at;
}

export async function authenticatedContext(
  identity: AccessIdentity,
  trace: string,
  profile: McpAccessAuthProfile,
  expectedServiceTokenClientId: string | readonly McpServiceClient[],
  accessTeamDomain: string | undefined,
  accessAudience: string | undefined,
  deploymentGeneration: string,
): Promise<McpToolCallContext | Response> {
  if (!hasVerifiedIdentityShape(identity)) {
    return jsonError(401, "MCP_AUTHENTICATION_FAILED", trace);
  }
  if (profile === "service-token") {
    // Preserve the exported legacy call shape while the runtime passes the validated client set.
    const clients = typeof expectedServiceTokenClientId === "string"
      ? [{ client_id: expectedServiceTokenClientId, legacy: true }]
      : expectedServiceTokenClientId;
    const client = clients.find((candidate) => candidate.client_id === identity.principal_ref);
    if (identity.authentication_method !== "service_token" || client === undefined) {
      return jsonError(403, "MCP_SERVICE_PRINCIPAL_DENIED", trace);
    }
    let actorRef = MCP_LOGICAL_PRINCIPAL;
    if (!client.legacy) {
      const issuer = requiredAccessTeamDomain(accessTeamDomain);
      const audience = requiredAccessAudience(accessAudience, undefined);
      if (identity.issuer !== issuer) return jsonError(403, "MCP_SERVICE_PRINCIPAL_DENIED", trace);
      actorRef = `mcp-service-${await sha256(JSON.stringify(stable({
        protocol: "eliotr.mcp.service-actor.v1", issuer, audience, client_id: identity.principal_ref,
      })))}`;
    }
    const verifiedActor: McpVerifiedActorContext = Object.freeze({
      actor_ref: actorRef,
      credential_generation: identity.credential_generation,
      authentication_method: identity.authentication_method,
      expires_at: identity.expires_at,
      auth_profile: profile,
      deployment_generation: deploymentGeneration,
    });
    return Object.freeze({
      principal_ref: actorRef,
      trace_id: trace,
      deployment_generation: deploymentGeneration,
      verified_actor: verifiedActor,
      ...(identity.issuer === undefined ? {} : { verified_access: Object.freeze({ ...identity }) }),
    });
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
  const verifiedActor: McpVerifiedActorContext = Object.freeze({
    actor_ref: `mcp-actor-${principalRef}`,
    credential_generation: identity.credential_generation,
    authentication_method: identity.authentication_method,
    expires_at: identity.expires_at,
    auth_profile: profile,
    deployment_generation: deploymentGeneration,
  });
  return Object.freeze({
    principal_ref: `mcp-actor-${principalRef}`,
    trace_id: trace,
    deployment_generation: deploymentGeneration,
    verified_actor: verifiedActor,
  });
}

function serverDependencies(
  env: WorkspaceMcpRuntime,
  profile: McpAccessAuthProfile,
  now: () => number,
): GeminiMcpServerDependencies {
  const diagnosticEnabled = typeof env.mcpClientDiagnosticConsume === "function";
  const catalogEnabled = profile === "service-token" && typeof env.projectCatalog === "function";
  const researchEnabled = profile === "service-token" && typeof env.research === "function";
  const transport = googleTransport(env);
  const googleSyncEnabled = transport === "gemini-mcp";
  const tools = GEMINI_MCP_TOOLS.filter((tool) =>
    (!isMcpResearchTool(tool.name) || researchEnabled) &&
    (tool.name !== "eliotr_catalog" || catalogEnabled) &&
    (tool.name !== "eliotr_confirm_client_diagnostic" || diagnosticEnabled) &&
    ((tool.name !== "eliotr_create_google_sync_plan" && tool.name !== "eliotr_validate_google_sync_receipt") || googleSyncEnabled),
  );
  const hasTool = (name: string): boolean => tools.some((tool) => tool.name === name);
  const runEnabled = hasTool("eliotr_run");
  const controlEnabled = hasTool("eliotr_cancel") || hasTool("eliotr_recover");
  const ingestEnabled = hasTool("eliotr_ingest_commit");
  const toolDependencies = {
    google_transport: transport,
    now,
    deployment_generation: env.DEPLOYMENT_GENERATION,
    async systemStatus(): Promise<Record<string, unknown>> {
      const readiness = await env.readReadiness();
      return {
        protocol: "eliotr.mcp.system-status.v1",
        environment: env.ENVIRONMENT,
        deployment_generation: env.DEPLOYMENT_GENERATION,
        ready: readiness.ready,
        blocking_reason_codes: readiness.blocking_reason_codes,
        enabled_surfaces: [
          "system_status",
          ...(googleSyncEnabled ? ["google_sync_planning"] : []),
          ...(catalogEnabled ? ["project_catalog"] : []),
          ...(researchEnabled ? ["project_fast_search", "saved_report_reads", "exact_evidence_reads"] : []),
          ...(runEnabled ? ["research_run_creation"] : []),
          ...(controlEnabled ? ["research_run_control"] : []),
          ...(ingestEnabled ? ["normalized_bundle_ingest"] : []),
          ...(hasTool("eliotr_project_attach") ? ["project_source_attachment"] : []),
          ...(diagnosticEnabled ? ["client_diagnostic_confirmation"] : []),
        ],
        disabled_surfaces: [
          ...(catalogEnabled ? [] : [{ surface: "catalog", reason: "MCP_CATALOG_SCOPE_REQUIRED" }]),
          ...(researchEnabled ? [] : [{ surface: "research_reads", reason: "MCP_RESEARCH_UNAVAILABLE" }]),
          ...(controlEnabled ? [] : [{ surface: "research_run_control", reason: "DELEGATED_EXECUTION_PENDING" }]),
          ...(googleSyncEnabled ? [] : [{ surface: "google_sync_planning", reason: "GOOGLE_TRANSPORT_DISABLED" }]),
        ],
        google_external_transport: transport,
        mcp_access_auth_profile: profile,
        exact_readback_required: true,
        canonical_mutation_available_through_mcp: researchEnabled,
        // These describe wired operations, not a grant to the current caller.
        source_or_artifact_content_mutation_available: ingestEnabled,
        model_dispatch_available: runEnabled || hasTool("eliotr_recover"),
      };
    },
    async catalog(input: Parameters<GeminiMcpToolDependencies["catalog"]>[0], context: McpToolCallContext): Promise<unknown> {
      if (!catalogEnabled || !env.projectCatalog || !context.verified_access || !input.project_id) {
        throw new GeminiMcpToolError("MCP_CATALOG_SCOPE_REQUIRED", "A verified service and explicit delegated project are required");
      }
      return env.projectCatalog(input, context);
    },
    mcp_auth_profile: profile,
    ...(researchEnabled ? { research: env.research } : {}),
    ...(diagnosticEnabled ? { mcpClientDiagnosticConsume: env.mcpClientDiagnosticConsume } : {}),
    ...(env.workspaceCandidateStore === undefined ? {} : { workspaceCandidateStore: env.workspaceCandidateStore }),
  } as const;
  return {
    server_version: "0.3.0",
    deployment_generation: env.DEPLOYMENT_GENERATION,
    listTools: () => tools,
    callTool: (name, input, context) =>
      callGeminiMcpTool(toolDependencies, name, input, context),
  };
}

export async function handleGeminiMcp(
  request: Request,
  env: WorkspaceMcpRuntime,
  _executionContext: ExecutionContext,
  dependencies: GeminiMcpHttpDependencies = {},
): Promise<Response> {
  const trace = traceId(request);
  const url = new URL(request.url);
  let hostname: string;
  let profile: McpAccessAuthProfile;
  let configuredClients: readonly McpServiceClient[] = [];
  try {
    hostname = requiredHostname(env.MCP_HOSTNAME);
    // Validate the selected external transport before authentication so an
    // unknown or mixed deployment cannot be probed through the auth boundary.
    googleTransport(env);
    profile = accessAuthProfile(env.MCP_ACCESS_AUTH_PROFILE);
    if (profile === "service-token") {
      configuredClients = readMcpServiceClients(
        env.MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID, env.MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS,
      );
      if (configuredClients.length === 0 && dependencies.accessVerifier === undefined) {
        throw new AccessVerificationError("ACCESS_CONFIG_INVALID", "MCP requires a configured service Client ID", true);
      }
      if (configuredClients.some((client) => !client.legacy)) {
        requiredAccessTeamDomain(env.MCP_ACCESS_TEAM_DOMAIN);
        requiredAccessAudience(env.MCP_ACCESS_AUDIENCE, env.ACCESS_AUDIENCE);
      }
    } else if (env.MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID !== undefined || env.MCP_ACCESS_SERVICE_TOKEN_CLIENT_IDS !== undefined) {
      throw new AccessVerificationError(
        "ACCESS_CONFIG_INVALID",
        "Managed OAuth MCP profile must not configure service-token Client IDs",
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
      configuredClients.map((client) => client.client_id),
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

  let context: McpToolCallContext | Response;
  try {
    context = await authenticatedContext(
      identity, trace, profile, configuredClients,
      env.MCP_ACCESS_TEAM_DOMAIN, env.MCP_ACCESS_AUDIENCE, env.DEPLOYMENT_GENERATION,
    );
  } catch {
    return jsonError(503, "MCP_AUTHENTICATION_UNAVAILABLE", trace, true);
  }
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
