import { createIngestApplication } from "./ingest-composition.js";
import { prepareBundleRequest, discoverBundleRequest, completeBundleRequest, commitBundleRequest } from "./ingest-http.js";
import type { VersionedRef } from "@eliotr/contracts";
import { loadScopeAuthority } from "@eliotr/cloudflare-evidence";
import { authorizeProjectClientGrant } from "@eliotr/cloudflare-navigation";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { readCatalog } from "@eliotr/cloudflare-navigation";
import { createProjectOwnerService } from "@eliotr/cloudflare-navigation";
import { inputIdentifier, normalizeUpdate } from "./project-owner-contract.js";
import { GeminiMcpToolError, type McpResearchToolCall, type McpToolCallContext } from "@eliotr/cloudflare-workspace-mcp";
import {
  createMcpResearchServiceOperations,
  mapMcpResearchServiceError,
  mcpFastSearchResponse,
  mcpResearchBindHeader as bindHeader,
  mcpResearchInvalid as invalid,
} from "@eliotr/cloudflare-workspace-mcp/research-service-operations.js";
import {
  createMcpResearchProjectMembership,
  type McpResearchProjectMembership,
} from "@eliotr/cloudflare-workspace-mcp/research-project-membership.js";
import { createMcpResearchApplicationDispatch } from "@eliotr/cloudflare-workspace-mcp/research-application-dispatch.js";
import { createResearchQueryService, createResearchRunService, parseResearchRunRequest, parseResearchQueryRequest } from "./research-session.js";
import type { McpFastSearchQueryResult } from "./research-session.js";
import { mapError as mapHttpError } from "./http-errors.js";
import { createEvidenceService } from "./evidence-service.js";
import { reopenOwnerArtifactDraft, reopenOwnerArtifactSection, reopenOwnerArtifactSectionCitations } from "./research-artifact-reauthorization-http.js";
import { prepareArtifactReadReauthorization } from "./research-artifact-reauthorization-http.js";
import { readMcpSourcePage } from "./mcp-source-reader.js";
import { cancelResearchRun, recoverResearchRun } from "./research-run-control.js";
import { readReadiness } from "./readiness.js";
import { callExternalAgentTaskTool, isExternalAgentTaskToolName } from "./mcp-external-agent-task.js";
import type { Env } from "./env.js";

function requiredManagedProjectId(projectId: string | undefined): string {
  if (projectId === undefined) invalid("project_id must identify one explicit project");
  return projectId;
}

export interface McpFastSearchResponse extends McpFastSearchQueryResult {
  readonly synthesis_status: "NOT_REQUESTED";
  readonly synthesis_note: string;
}

export { mcpFastSearchResponse };

function mcpAccessIssuer(env: Env): string {
  const raw = env.MCP_ACCESS_TEAM_DOMAIN;
  if (typeof raw !== "string" || raw.trim() !== raw || raw.length === 0) {
    throw new GeminiMcpToolError("MCP_MANAGED_OAUTH_IDENTITY_INVALID", "Managed OAuth identity is unavailable");
  }
  let issuer: URL;
  try { issuer = new URL(raw); }
  catch { throw new GeminiMcpToolError("MCP_MANAGED_OAUTH_IDENTITY_INVALID", "Managed OAuth identity is unavailable"); }
  if (issuer.protocol !== "https:" || issuer.username !== "" || issuer.password !== "" || issuer.port !== "" ||
      issuer.pathname !== "/" || issuer.search !== "" || issuer.hash !== "" ||
      !issuer.hostname.endsWith(".cloudflareaccess.com")) {
    throw new GeminiMcpToolError("MCP_MANAGED_OAUTH_IDENTITY_INVALID", "Managed OAuth identity is unavailable");
  }
  return issuer.origin;
}

/** Build the ordinary owner_pwa Core context from the current verified Managed OAuth user. */
export function createManagedOAuthOwnerContext(
  env: Env,
  request: Request,
  tool: McpToolCallContext,
  args: Record<string, unknown>,
): AuthenticatedRequestContext {
  const identity = tool.verified_access;
  const verified = tool.verified_actor;
  const now = Date.now();
  const expires = identity === undefined ? NaN : Date.parse(identity.expires_at);
  if (!identity || !verified || verified.auth_profile !== "managed-oauth" ||
      identity.authentication_method !== "cloudflare_access" ||
      typeof identity.principal_ref !== "string" || identity.principal_ref.length === 0 ||
      typeof identity.credential_generation !== "string" || identity.credential_generation.length === 0 ||
      identity.credential_generation.length > 256 ||
      tool.principal_ref !== identity.principal_ref || verified.actor_ref !== identity.principal_ref ||
      verified.authentication_method !== identity.authentication_method ||
      verified.credential_generation !== identity.credential_generation || verified.expires_at !== identity.expires_at ||
      verified.deployment_generation !== env.DEPLOYMENT_GENERATION ||
      tool.deployment_generation !== env.DEPLOYMENT_GENERATION || identity.issuer !== mcpAccessIssuer(env) ||
      !Number.isSafeInteger(expires) || new Date(expires).toISOString() !== identity.expires_at ||
      expires <= now || request.signal.aborted) {
    throw new GeminiMcpToolError("MCP_MANAGED_OAUTH_IDENTITY_INVALID", "A current verified MCP user identity is required");
  }
  if (typeof args.project_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(args.project_id)) {
    invalid("project_id must identify one explicit project");
  }
  const headers = new Headers();
  for (const name of ["idempotency-key"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (args.idempotency_key !== undefined) {
    if (typeof args.idempotency_key !== "string" || args.idempotency_key.length < 1 ||
        args.idempotency_key.length > 256 || /[\u0000-\u0020\u007f]/u.test(args.idempotency_key)) {
      invalid("idempotency_key is invalid");
    }
    bindHeader(headers, "idempotency-key", args.idempotency_key);
  }
  return {
    request: new Request(request.url, { method: "POST", headers, signal: request.signal }),
    principal_ref: identity.principal_ref,
    client_class: "owner_pwa",
    credential_generation: identity.credential_generation,
    trace_id: tool.trace_id,
    access: {
      principal_ref: identity.principal_ref,
      credential_generation: identity.credential_generation,
      expires_at: identity.expires_at,
      issuer: identity.issuer,
      authentication_method: identity.authentication_method,
    },
  };
}

async function requireOwnerProject(
  env: Env,
  context: AuthenticatedRequestContext,
  projectId: string,
): Promise<void> {
  const catalog = await readCatalog(env.CORE_DB, context, { project_id: projectId, limit: 1 }, env.DEPLOYMENT_GENERATION);
  if (!catalog.projects.some((project) => project.id === projectId)) {
    throw new GeminiMcpToolError("MCP_PROJECT_SCOPE_DENIED", "The project is not currently readable by this user");
  }
}

async function requireArtifactProject(env: Env, context: AuthenticatedRequestContext,
  artifact: VersionedRef, projectId: string, operation: "report" | "evidence",
  membership: McpResearchProjectMembership): Promise<void> {
  const read = await prepareArtifactReadReauthorization(env, context, artifact, operation);
  await membership.require_project_snapshot(read.original_scope_snapshot_ref, projectId);
  await read.requireCurrent();
}

/** Internal bridge after dedicated MCP Access verification. No tool argument can supply an actor. */
function serviceContext(env: Env, request: Request, tool: McpToolCallContext,
  args: Record<string, unknown>): AuthenticatedRequestContext {
  const identity = tool.verified_access;
  const verified = tool.verified_actor;
  if (!identity || !verified || verified.auth_profile !== "service-token" ||
      identity.authentication_method !== "service_token" || !identity.issuer ||
      verified.authentication_method !== identity.authentication_method ||
      verified.credential_generation !== identity.credential_generation || verified.expires_at !== identity.expires_at ||
      verified.actor_ref !== tool.principal_ref || verified.deployment_generation !== env.DEPLOYMENT_GENERATION ||
      tool.deployment_generation !== env.DEPLOYMENT_GENERATION || !Number.isFinite(Date.parse(identity.expires_at)) ||
      Date.parse(identity.expires_at) <= Date.now() || request.signal.aborted) {
    throw new GeminiMcpToolError("CLIENT_GRANT_IDENTITY_INVALID", "A current verified MCP service identity is required");
  }
  if (typeof args.client_grant_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(args.client_grant_id)) {
    invalid("client_grant_id must be an owner-issued project grant locator");
  }
  const headers = new Headers();
  for (const name of ["idempotency-key", "x-eliotr-client-grant"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  bindHeader(headers, "x-eliotr-client-grant", args.client_grant_id);
  if (args.idempotency_key !== undefined) {
    if (typeof args.idempotency_key !== "string" || args.idempotency_key.length < 1 || args.idempotency_key.length > 256 ||
        /[\u0000-\u0020\u007f]/u.test(args.idempotency_key)) invalid("idempotency_key is invalid");
    bindHeader(headers, "idempotency-key", args.idempotency_key);
  }
  return { request: new Request(request.url, { method: "POST", headers, signal: request.signal }),
    principal_ref: identity.principal_ref, client_class: "trusted_agent", credential_generation: identity.credential_generation,
    trace_id: tool.trace_id, access: identity };
}

function mapError(request: Request, error: unknown): never {
  return mapMcpResearchServiceError(error, (mapped) => {
    // Preserve application error codes/retryability through the same HTTP classifier; do not
    // echo a storage/provider message or turn a denied/stale request into a generic retry.
    mapHttpError(request, mapped, (_request, _status, code, _title, retryable) => {
      throw new GeminiMcpToolError(code, "Research request could not be completed under its exact input and authority", retryable);
    });
    throw new GeminiMcpToolError("MCP_RESEARCH_UNAVAILABLE", "Research service is temporarily unavailable", true);
  });
}

/** Only delegates to existing S11/S12 HTTP application services; no HTTP loopback or second engine. */
export function createMcpResearchToolCall(env: Env, request: Request): McpResearchToolCall {
  const projectMembership = createMcpResearchProjectMembership({
    database: env.CORE_DB,
    read_scope_authority: (scope) => loadScopeAuthority(env.CORE_DB, scope),
  });
  return createMcpResearchApplicationDispatch<AuthenticatedRequestContext>({
    resolve_actor: async (name, args, toolContext) => {
      const managedOAuth = toolContext.verified_actor?.auth_profile === "managed-oauth";
      const context = managedOAuth
        ? createManagedOAuthOwnerContext(env, request, toolContext, args)
        : serviceContext(env, request, toolContext, args);
      const projectId = managedOAuth ? inputIdentifier(args.project_id, "project_id") : undefined;
      return { context, managed_oauth: managedOAuth, ...(projectId === undefined ? {} : { project_id: projectId }) };
    },
    require_owner_project: (actor) => requireOwnerProject(
      env, actor.context, requiredManagedProjectId(actor.project_id),
    ),
    operations: createMcpResearchServiceOperations({
      input_identifier: inputIdentifier,
      require_project_id: requiredManagedProjectId,
      parse_run_request: parseResearchRunRequest,
      run_scope_identity: (run) => run.scope_expression,
      parse_query_request: parseResearchQueryRequest,
      query_product: (query) => query.product,
      query_scope_identity: (query) => query.scope_expression,
      normalize_project_update: normalizeUpdate,
      create_ingest_parser_request: (context, body) => new Request(context.request.url, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        signal: context.request.signal,
      }),
      is_external_agent_task_name: isExternalAgentTaskToolName,
      prepare_ingest: (context, name, command) => {
        const ingest = createIngestApplication(env);
        if (command.kind === "status") {
          return { execute: () => name === "eliotr_ingest_status"
            ? ingest.getBundleStatus(context, command.operation_id)
            : ingest.getBundleRecovery(context, command.operation_id) };
        }
        if (name === "eliotr_ingest_prepare") return { execute: async () => ingest.prepareBundle(context, await prepareBundleRequest(command.request, 131072)) };
        if (name === "eliotr_ingest_discover") return { execute: async () => ingest.discoverBundle(context, await discoverBundleRequest(command.request, 131072)) };
        if (name === "eliotr_ingest_commit") return { execute: async () => ingest.commitBundle(context, await commitBundleRequest(command.request, 131072)) };
        return { execute: async () => ingest.completeBundleFile(context,
          await completeBundleRequest(command.request, 131072, inputIdentifier(command.operation_id, "operation_id"))) };
      },
      prepare_project_attach: (context, projectId, change, idempotencyKey) => {
        const service = createProjectOwnerService({ database: env.CORE_DB, deployment_generation: env.DEPLOYMENT_GENERATION });
        return { execute: () => service.update(context, projectId, { ...change, idempotency_key: idempotencyKey }) };
      },
      execute_run: (context, run) => createResearchRunService(env).run(context, run),
      execute_query: (context, query) => createResearchQueryService(env).queryForMcp(context, query),
      execute_run_control: (context, name, operation) => name === "eliotr_recover"
        ? recoverResearchRun(env, context, operation, {})
        : name === "eliotr_cancel"
          ? cancelResearchRun(env, context, operation, {})
          : createResearchRunService(env).runStatus(context, operation),
      require_run_project: (context, operation, projectId) =>
        projectMembership.require_run_project(context.principal_ref, operation, projectId),
      execute_external_task: async (context, name, args) => {
        const grant = await authorizeProjectClientGrant(env.CORE_DB, context, { operation: "run" });
        const result = await callExternalAgentTaskTool(env, context, grant.grant, name, args, "MCP_WRITE");
        await grant.requireGrantCurrent();
        return result;
      },
      require_artifact_project: (context, artifact, projectId, operation) =>
        requireArtifactProject(env, context, artifact, projectId, operation, projectMembership),
      execute_report: (context, artifact) => reopenOwnerArtifactDraft(env, context, artifact),
      execute_section: (context, artifact, section) => reopenOwnerArtifactSection(env, context, artifact, section),
      execute_citations: (context, artifact, section) => reopenOwnerArtifactSectionCitations(env, context, artifact, section),
      require_evidence_project: (context, scope, handle, projectId) =>
        projectMembership.require_evidence_project(scope, handle, projectId),
      execute_verify: (context, input) => createEvidenceService(env).verify(context, input),
      require_open_handle_project: (_context, handle, projectId) =>
        projectMembership.require_open_handle_project(handle, projectId),
      execute_open: (context, handle, selected) => createEvidenceService(env).open(context, handle, selected),
      execute_source_read: (context, input) => readMcpSourcePage(env, context, input),
    }),
    execute_with_currentness: async (name, args, actor, prepared, toolContext) => {
      const { context, managed_oauth: managedOAuth, project_id: projectId } = actor;
      const execute = prepared.execute;
        if (isExternalAgentTaskToolName(name)) {
          const result = await execute();
          serviceContext(env, request, toolContext, args);
          return result;
        }
        if (name === "eliotr_project_attach" || name.startsWith("eliotr_ingest_")) {
          // These services fence their own mutation/namespace authority and readback. They do not
          // borrow the read-only wrapper's project scope or renew an originating grant.
          const result = await execute();
          serviceContext(env, request, toolContext, args);
          return result;
        }
        if (managedOAuth) {
          const result = await execute();
          if (name !== "eliotr_source_read") {
            await requireOwnerProject(env, context, requiredManagedProjectId(projectId));
          }
          createManagedOAuthOwnerContext(env, request, toolContext, args);
          return result;
        }
        const operationKind = name === "eliotr_run" ? "run" : name === "eliotr_recover" ? "recover" : name === "eliotr_cancel" ? "cancel" : name === "eliotr_run_status" ? "status" : name === "eliotr_query" ? "query" : name === "eliotr_report" || name === "eliotr_section" ? "report" : "evidence";
        const lease = await authorizeProjectClientGrant(env.CORE_DB, context, { operation: operationKind });
        const result = await execute();
        // Exact readers fence sources/purge before returning. Do not refresh a delegation after their writes.
        await lease.requireGrantCurrent();
        serviceContext(env, request, toolContext, args);
        return result;
    },
    require_readiness: async () => {
      if (!(await readReadiness(env)).ready) throw new GeminiMcpToolError("SCHEMA_NOT_READY", "Required migrations are not applied", true);
    },
    map_error: (error) => mapError(request, error),
  });
}
