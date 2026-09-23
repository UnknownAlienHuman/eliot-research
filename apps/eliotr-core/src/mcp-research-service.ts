import { VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import { authorizeProjectClientGrant } from "@eliotr/cloudflare-navigation";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { readResponseBodyWithinBytes, RuntimeLimitError } from "@eliotr/platform-cloudflare";
import { GeminiMcpToolError, MAX_MCP_RESPONSE_BYTES, MCP_RESEARCH_TOOLS, type McpResearchToolCall, type McpToolCallContext } from "@eliotr/cloudflare-workspace-mcp";
import { createResearchQueryService, createResearchRunService, parseResearchQueryRequest } from "./research-session.js";
import { mapError as mapHttpError } from "./http-errors.js";
import { createEvidenceService } from "./evidence-service.js";
import { reopenOwnerArtifactDraft, reopenOwnerArtifactSection, reopenOwnerArtifactSectionCitations } from "./research-artifact-reauthorization-http.js";
import { cancelResearchRun, recoverResearchRun } from "./research-run-control.js";
import { readReadiness } from "./readiness.js";
import type { Env } from "./env.js";

function invalid(message: string): never { throw new GeminiMcpToolError("INPUT_INVALID", message); }
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
      const schema = MCP_RESEARCH_TOOLS[name].inputSchema;
      if (Object.keys(args).some((key) => !Object.hasOwn(schema.properties, key)) ||
          schema.required.some((key) => !Object.hasOwn(args, key))) invalid("Tool arguments contain unknown or missing fields");
      const context = serviceContext(env, request, toolContext, args);
      let execute: () => Promise<unknown>;
      switch (name) {
        case "eliotr_query": {
          const query = parseResearchQueryRequest(args.request);
          if (query.product !== "FAST_SEARCH") invalid("Only model-free FAST_SEARCH is exposed through MCP");
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
            : () => createResearchRunService(env).runStatus(context, operation);
          break;
        }
        case "eliotr_report": {
          const artifact = ref(args.artifact_ref);
          execute = () => reopenOwnerArtifactDraft(env, context, artifact);
          break;
        }
        case "eliotr_section": {
          const artifact = ref(args.artifact_ref); const section = ref(args.section_ref);
          execute = async () => responseBody(await reopenOwnerArtifactSection(env, context, artifact, section));
          break;
        }
        case "eliotr_citations": {
          const artifact = ref(args.artifact_ref); const section = ref(args.section_ref);
          execute = () => reopenOwnerArtifactSectionCitations(env, context, artifact, section);
          break;
        }
        case "eliotr_verify": {
          const verify = { scope_snapshot_ref: ref(args.scope_snapshot_ref), handle_ref: ref(args.handle_ref) };
          execute = () => createEvidenceService(env).verify(context, verify);
          break;
        }
        case "eliotr_open": {
          const handle = ref(args.handle_ref); const selected = range(args.range);
          execute = async () => responseBody(await createEvidenceService(env).open(context, handle, selected));
          break;
        }
      }
      if (!(await readReadiness(env)).ready) throw new GeminiMcpToolError("SCHEMA_NOT_READY", "Required migrations are not applied", true);
      const operation = name === "eliotr_recover" ? "recover" : name === "eliotr_cancel" ? "cancel" : name === "eliotr_run_status" ? "status" : name === "eliotr_query" ? "query" : name === "eliotr_report" || name === "eliotr_section" ? "report" : "evidence";
      const lease = await authorizeProjectClientGrant(env.CORE_DB, context, { operation });
      const result = await execute();
      // Exact readers fence sources/purge before returning. Do not refresh a delegation after their writes.
      await lease.requireGrantCurrent();
      serviceContext(env, request, toolContext, args);
      return result;
    } catch (error) { mapError(request, error); }
  };
}
