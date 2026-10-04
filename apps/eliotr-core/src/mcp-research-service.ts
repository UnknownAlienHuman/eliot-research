import { createIngestApplication } from "./ingest-composition.js";
import { prepareBundleRequest, discoverBundleRequest, completeBundleRequest, commitBundleRequest } from "./ingest-http.js";
import { VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import { loadScopeAuthority } from "@eliotr/cloudflare-evidence";
import { authorizeProjectClientGrant } from "@eliotr/cloudflare-navigation";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { readCatalog } from "./catalog-service.js";
import { createProjectOwnerService } from "./project-owner-service.js";
import { inputIdentifier, normalizeUpdate } from "./project-owner-contract.js";
import { readResponseBodyWithinBytes, RuntimeLimitError } from "@eliotr/platform-cloudflare";
import { GeminiMcpToolError, MAX_MCP_RESPONSE_BYTES, MCP_RESEARCH_TOOLS, type McpResearchToolCall, type McpToolCallContext } from "@eliotr/cloudflare-workspace-mcp";
import { createResearchQueryService, createResearchRunService, parseResearchRunRequest, parseResearchQueryRequest } from "./research-session.js";
import { mapError as mapHttpError } from "./http-errors.js";
import { createEvidenceService } from "./evidence-service.js";
import { reopenOwnerArtifactDraft, reopenOwnerArtifactSection, reopenOwnerArtifactSectionCitations } from "./research-artifact-reauthorization-http.js";
import { prepareArtifactReadReauthorization } from "./research-artifact-reauthorization-http.js";
import { readMcpSourcePage } from "./mcp-source-reader.js";
import { cancelResearchRun, recoverResearchRun } from "./research-run-control.js";
import { readReadiness } from "./readiness.js";
import { ExternalAgentTaskError } from "@eliotr/cloudflare-workflows";
import { callExternalAgentTaskTool, isExternalAgentTaskToolName } from "./mcp-external-agent-task.js";
import type { Env } from "./env.js";

function invalid(message: string): never { throw new GeminiMcpToolError("INPUT_INVALID", message); }
function requiredManagedProjectId(projectId: string | undefined): string {
  if (projectId === undefined) invalid("project_id must identify one explicit project");
  return projectId;
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("Tool arguments must be an object");
  return value as Record<string, unknown>;
}
function ref(value: unknown): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) invalid("A strict versioned reference is required");
  return parsed.data;
}
function range(value: unknown): { readonly start: number; readonly end: number } | undefined {
  if (value === undefined) return undefined;
  const r = record(value);
  if (Object.keys(r).length !== 2 || !Number.isSafeInteger(r.start) || !Number.isSafeInteger(r.end) ||
      (r.start as number) < 0 || (r.end as number) <= (r.start as number)) invalid("Range must contain byte offsets start < end");
  return { start: r.start as number, end: r.end as number };
}
function bindHeader(headers: Headers, name: string, value: string): void {
  const existing = headers.get(name);
  if (existing !== null && existing !== value) invalid("Tool arguments conflict with request headers");
  try { headers.set(name, value); } catch { invalid("Header-bound tool argument is invalid"); }
}

const MANAGED_OAUTH_TOOLS = new Set([
  "eliotr_query", "eliotr_run", "eliotr_run_status", "eliotr_report", "eliotr_section",
  "eliotr_citations", "eliotr_verify", "eliotr_open", "eliotr_source_read",
]);

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

async function requireProjectSnapshot(
  env: Env,
  scopeId: string,
  scopeRevision: number,
  projectId: string,
): Promise<void> {
  const scope = await loadScopeAuthority(env.CORE_DB, { id: scopeId, revision: scopeRevision });
  if (scope?.snapshot.resolved_scope_expression.kind !== "PROJECT" ||
      scope.snapshot.resolved_scope_expression.project_id !== projectId) {
    throw new GeminiMcpToolError("MCP_PROJECT_SCOPE_MISMATCH", "The requested record belongs to another project scope");
  }
}

async function requireRunProject(env: Env, context: AuthenticatedRequestContext,
  workflowInstanceId: string, projectId: string): Promise<void> {
  const row = await env.CORE_DB.prepare(
    "SELECT r.scope_snapshot_id,r.scope_snapshot_revision FROM research_workflow_run r " +
    "WHERE r.operation_id=?1 AND (r.principal_ref=?2 OR EXISTS (SELECT 1 FROM owner_machine_run_origin o " +
    "WHERE o.operation_id=r.operation_id AND o.reader_principal_ref=?2)) LIMIT 1",
  ).bind(workflowInstanceId, context.principal_ref)
    .first<{ scope_snapshot_id: string; scope_snapshot_revision: number }>();
  if (row === null) throw new GeminiMcpToolError("MCP_PROJECT_SCOPE_MISMATCH", "The requested run is unavailable in this project");
  await requireProjectSnapshot(env, row.scope_snapshot_id, row.scope_snapshot_revision, projectId);
}

async function requireArtifactProject(env: Env, context: AuthenticatedRequestContext,
  artifact: VersionedRef, projectId: string, operation: "report" | "evidence"): Promise<void> {
  const read = await prepareArtifactReadReauthorization(env, context, artifact, operation);
  await requireProjectSnapshot(env, read.original_scope_snapshot_ref.id,
    read.original_scope_snapshot_ref.revision, projectId);
  await read.requireCurrent();
}

async function requireEvidenceProject(env: Env, context: AuthenticatedRequestContext,
  scopeRef: VersionedRef, handleRef: VersionedRef, projectId: string): Promise<void> {
  await requireProjectSnapshot(env, scopeRef.id, scopeRef.revision, projectId);
  const handle = await env.CORE_DB.prepare(
    "SELECT scope_snapshot_id,scope_snapshot_revision FROM evidence_handle WHERE handle_id=?1 AND revision=?2 LIMIT 1",
  ).bind(handleRef.id, handleRef.revision)
    .first<{ scope_snapshot_id: string; scope_snapshot_revision: number }>();
  if (handle === null || handle.scope_snapshot_id !== scopeRef.id || handle.scope_snapshot_revision !== scopeRef.revision) {
    throw new GeminiMcpToolError("MCP_PROJECT_SCOPE_MISMATCH", "The requested evidence is unavailable in this project");
  }
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

const BODY_HEADERS = ["content-type", "content-length", "content-range", "x-eliotr-artifact-ref",
  "x-eliotr-section-ref", "x-eliotr-section-object-ref", "x-eliotr-section-sha256", "x-eliotr-evidence-handle",
  "x-eliotr-excerpt-sha256", "x-eliotr-verification-receipt", "x-eliotr-deployment-generation"] as const;

/** Preserve response bytes, not Uint8Array's numeric-key JSON representation. No truncation or HTML. */
async function responseBody(response: Response): Promise<unknown> {
  if (!response.ok) throw new GeminiMcpToolError("MCP_RESEARCH_RESPONSE_INVALID", "Research body response was unsuccessful");
  const bytes = await readResponseBodyWithinBytes(response, { label: "mcp.research.body", max_bytes: MAX_MCP_RESPONSE_BYTES });
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new GeminiMcpToolError("MCP_RESEARCH_BODY_NOT_UTF8", "Research body is not valid UTF-8"); }
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return { protocol: "eliotr.mcp.http-body.v1", status: response.status,
    headers: Object.fromEntries(BODY_HEADERS.flatMap((name) => {
      const value = response.headers.get(name); return value === null ? [] : [[name, value]];
    })),
    body: { encoding: "utf-8", text, byte_length: bytes.byteLength,
      sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("") },
  };
}

function mapError(request: Request, error: unknown): never {
  if (error instanceof GeminiMcpToolError) throw error;
  if (error instanceof ExternalAgentTaskError) {
    throw new GeminiMcpToolError(error.code,
      "External agent task request could not be completed under its exact lease and authority", error.retryable);
  }
  if (error instanceof RuntimeLimitError) throw new GeminiMcpToolError("MCP_RESEARCH_LIMIT", "Research response exceeds the MCP envelope; use a smaller query or evidence byte range");
  if (error instanceof RangeError) throw new GeminiMcpToolError("EVIDENCE_RANGE_INVALID", "Evidence range is outside the excerpt or splits a UTF-8 code point");
  // Preserve application error codes/retryability through the same HTTP classifier; do not
  // echo a storage/provider message or turn a denied/stale request into a generic retry.
  mapHttpError(request, error, (_request, _status, code, _title, retryable) => {
    throw new GeminiMcpToolError(code, "Research request could not be completed under its exact input and authority", retryable);
  });
  throw new GeminiMcpToolError("MCP_RESEARCH_UNAVAILABLE", "Research service is temporarily unavailable", true);
}

/** Only delegates to existing S11/S12 HTTP application services; no HTTP loopback or second engine. */
export function createMcpResearchToolCall(env: Env, request: Request): McpResearchToolCall {
  return async (name, input, toolContext) => {
    try {
      const args = record(input);
      const managedOAuth = toolContext.verified_actor?.auth_profile === "managed-oauth";
      if (managedOAuth && !MANAGED_OAUTH_TOOLS.has(name)) {
        throw new GeminiMcpToolError("MCP_RESEARCH_UNAVAILABLE", "This Research operation is unavailable to Managed OAuth users");
      }
      if (!managedOAuth && name === "eliotr_source_read") {
        throw new GeminiMcpToolError("MCP_RESEARCH_UNAVAILABLE", "Exact source reads are available only to the owner profile");
      }
      const schema = MCP_RESEARCH_TOOLS[name].inputSchema;
      const schemaProperties = schema.properties as Record<string, unknown>;
      const allowedProperties = new Set(Object.keys(schemaProperties));
      const requiredProperties = (schema.required as readonly string[])
        .filter((key) => !managedOAuth || key !== "client_grant_id");
      if (managedOAuth) {
        allowedProperties.delete("client_grant_id");
        allowedProperties.add("project_id");
        if (!requiredProperties.includes("project_id")) requiredProperties.push("project_id");
      }
      if (Object.keys(args).some((key) => !allowedProperties.has(key)) ||
          requiredProperties.some((key) => !Object.hasOwn(args, key))) invalid("Tool arguments contain unknown or missing fields");
      const context = managedOAuth
        ? createManagedOAuthOwnerContext(env, request, toolContext, args)
        : serviceContext(env, request, toolContext, args);
      const projectId = managedOAuth ? inputIdentifier(args.project_id, "project_id") : undefined;
      if (managedOAuth && name !== "eliotr_source_read") {
        await requireOwnerProject(env, context, requiredManagedProjectId(projectId));
      }
      let execute: () => Promise<unknown>;
      switch (name) {
        case "eliotr_ingest_prepare":
        case "eliotr_ingest_discover":
        case "eliotr_ingest_complete_file":
        case "eliotr_ingest_commit": {
          const input = record(args.request);
          const body = name === "eliotr_ingest_prepare" ? { ...input, idempotency_key: args.idempotency_key } : input;
          if (name === "eliotr_ingest_prepare" && Object.hasOwn(input, "idempotency_key")) invalid("Use the top-level idempotency key");
          const parserRequest = new Request(context.request.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: request.signal });
          const ingest = createIngestApplication(env);
          execute = name === "eliotr_ingest_prepare" ? async () => ingest.prepareBundle(context, await prepareBundleRequest(parserRequest, 131072))
            : name === "eliotr_ingest_discover" ? async () => ingest.discoverBundle(context, await discoverBundleRequest(parserRequest, 131072))
            : name === "eliotr_ingest_commit" ? async () => ingest.commitBundle(context, await commitBundleRequest(parserRequest, 131072))
            : async () => ingest.completeBundleFile(context, await completeBundleRequest(parserRequest, 131072, inputIdentifier(args.operation_id, "operation_id")));
          break;
        }
        case "eliotr_ingest_status":
        case "eliotr_ingest_recovery": {
          const operationId = inputIdentifier(args.operation_id, "operation_id");
          const ingest = createIngestApplication(env);
          execute = name === "eliotr_ingest_status" ? () => ingest.getBundleStatus(context, operationId)
            : () => ingest.getBundleRecovery(context, operationId);
          break;
        }
        case "eliotr_project_attach": {
          const projectId = inputIdentifier(args.project_id, "project_id");
          const supplied = record(args.request);
          if (Object.keys(supplied).some((key) => !["title", "source_ids", "expected_revision"].includes(key))) {
            invalid("Project attachment request contains unknown fields");
          }
          const change = normalizeUpdate(supplied);
          const key = inputIdentifier(args.idempotency_key, "idempotency_key");
          execute = () => createProjectOwnerService({ database: env.CORE_DB, deployment_generation: env.DEPLOYMENT_GENERATION })
            .update(context, projectId, { ...change, idempotency_key: key });
          break;
        }
        case "eliotr_run": {
          const run = parseResearchRunRequest(args.request);
          if (managedOAuth && (run.scope_expression.kind !== "PROJECT" || run.scope_expression.project_id !== projectId)) {
            throw new GeminiMcpToolError("MCP_PROJECT_SCOPE_MISMATCH", "Research run scope must match project_id");
          }
          execute = () => createResearchRunService(env).run(context, run);
          break;
        }
        case "eliotr_query": {
          const query = parseResearchQueryRequest(args.request);
          if (query.product !== "FAST_SEARCH") invalid("Only model-free FAST_SEARCH is exposed through MCP");
          if (managedOAuth && (query.scope_expression.kind !== "PROJECT" || query.scope_expression.project_id !== projectId)) {
            throw new GeminiMcpToolError("MCP_PROJECT_SCOPE_MISMATCH", "Search scope must match project_id");
          }
          execute = () => createResearchQueryService(env).query(context, query);
          break;
        }
        case "eliotr_recover":
        case "eliotr_cancel":
        case "eliotr_run_status": {
          const operation = args.workflow_instance_id;
          if (typeof operation !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(operation)) {
            invalid("A valid workflow_instance_id is required");
          }
          execute = name === "eliotr_recover" ? () => recoverResearchRun(env, context, operation, {})
            : name === "eliotr_cancel" ? () => cancelResearchRun(env, context, operation, {})
            : async () => {
              const status = await createResearchRunService(env).runStatus(context, operation);
              if (managedOAuth) await requireRunProject(env, context, operation, requiredManagedProjectId(projectId));
              return status;
            };
          break;
        }
        case "eliotr_task_pull":
        case "eliotr_task_progress":
        case "eliotr_task_result":
        case "eliotr_task_status": {
          if (!isExternalAgentTaskToolName(name)) invalid("External task tool identity is invalid");
          execute = async () => {
            const grant = await authorizeProjectClientGrant(env.CORE_DB, context, { operation: "run" });
            const result = await callExternalAgentTaskTool(
              env, context, grant.grant, name, args, "MCP_WRITE",
            );
            await grant.requireGrantCurrent();
            return result;
          };
          break;
        }
        case "eliotr_report": {
          const artifact = ref(args.artifact_ref);
          if (managedOAuth) await requireArtifactProject(env, context, artifact, requiredManagedProjectId(projectId), "report");
          execute = () => reopenOwnerArtifactDraft(env, context, artifact);
          break;
        }
        case "eliotr_section": {
          const artifact = ref(args.artifact_ref); const section = ref(args.section_ref);
          if (managedOAuth) await requireArtifactProject(env, context, artifact, requiredManagedProjectId(projectId), "report");
          execute = async () => responseBody(await reopenOwnerArtifactSection(env, context, artifact, section));
          break;
        }
        case "eliotr_citations": {
          const artifact = ref(args.artifact_ref); const section = ref(args.section_ref);
          if (managedOAuth) await requireArtifactProject(env, context, artifact, requiredManagedProjectId(projectId), "evidence");
          execute = () => reopenOwnerArtifactSectionCitations(env, context, artifact, section);
          break;
        }
        case "eliotr_verify": {
          const verify = { scope_snapshot_ref: ref(args.scope_snapshot_ref), handle_ref: ref(args.handle_ref) };
          if (managedOAuth) await requireEvidenceProject(env, context, verify.scope_snapshot_ref, verify.handle_ref, requiredManagedProjectId(projectId));
          execute = () => createEvidenceService(env).verify(context, verify);
          break;
        }
        case "eliotr_open": {
          const handle = ref(args.handle_ref); const selected = range(args.range);
          if (managedOAuth) {
            const row = await env.CORE_DB.prepare(
              "SELECT scope_snapshot_id,scope_snapshot_revision FROM evidence_handle WHERE handle_id=?1 AND revision=?2 LIMIT 1",
            ).bind(handle.id, handle.revision)
              .first<{ scope_snapshot_id: string; scope_snapshot_revision: number }>();
            if (row === null) throw new GeminiMcpToolError("MCP_PROJECT_SCOPE_MISMATCH", "The requested evidence is unavailable in this project");
            await requireProjectSnapshot(env, row.scope_snapshot_id, row.scope_snapshot_revision, requiredManagedProjectId(projectId));
          }
          execute = async () => responseBody(await createEvidenceService(env).open(context, handle, selected));
          break;
        }
        case "eliotr_source_read": {
          if (!managedOAuth) throw new GeminiMcpToolError("MCP_RESEARCH_UNAVAILABLE", "Exact source reads are available only to the owner profile");
          const sourceRevision = inputIdentifier(args.source_revision_ref, "source_revision_ref");
          const pageBytes = args.page_bytes === undefined ? undefined : args.page_bytes;
          if (pageBytes !== undefined && (!Number.isSafeInteger(pageBytes) || (pageBytes as number) < 1 || (pageBytes as number) > 24 * 1024)) {
            invalid("page_bytes must be in [1, 24576]");
          }
          if (args.cursor !== undefined && (typeof args.cursor !== "string" || args.cursor.length > 2048)) invalid("cursor is invalid");
          execute = () => readMcpSourcePage(env, context, {
            project_id: requiredManagedProjectId(projectId), source_revision_ref: sourceRevision,
            ...(pageBytes === undefined ? {} : { page_bytes: pageBytes as number }),
            ...(args.cursor === undefined ? {} : { cursor: args.cursor as string }),
          });
          break;
        }
      }
      if (!(await readReadiness(env)).ready) throw new GeminiMcpToolError("SCHEMA_NOT_READY", "Required migrations are not applied", true);
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
      const operation = name === "eliotr_run" ? "run" : name === "eliotr_recover" ? "recover" : name === "eliotr_cancel" ? "cancel" : name === "eliotr_run_status" ? "status" : name === "eliotr_query" ? "query" : name === "eliotr_report" || name === "eliotr_section" ? "report" : "evidence";
      const lease = await authorizeProjectClientGrant(env.CORE_DB, context, { operation });
      const result = await execute();
      // Exact readers fence sources/purge before returning. Do not refresh a delegation after their writes.
      await lease.requireGrantCurrent();
      serviceContext(env, request, toolContext, args);
      return result;
    } catch (error) { mapError(request, error); }
  };
}
