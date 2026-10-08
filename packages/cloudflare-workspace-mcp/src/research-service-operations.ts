import { VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import { ExternalAgentTaskError } from "@eliotr/cloudflare-workflows";
import { readResponseBodyWithinBytes, RuntimeLimitError } from "@eliotr/platform-cloudflare";
import {
  GeminiMcpToolError,
} from "./gemini-mcp-tool-common.js";
import { MAX_MCP_RESPONSE_BYTES } from "./gemini-mcp-protocol.js";
import type { McpResearchToolName } from "./gemini-mcp-research-tools.js";
import type {
  McpResearchApplicationOperations,
  McpResearchPreparedOperation,
} from "./research-application-dispatch.js";

type IngestName = Extract<McpResearchToolName,
  "eliotr_ingest_prepare" | "eliotr_ingest_discover" | "eliotr_ingest_complete_file" |
  "eliotr_ingest_commit" | "eliotr_ingest_status" | "eliotr_ingest_recovery">;
type RunControlName = Extract<McpResearchToolName, "eliotr_recover" | "eliotr_cancel" | "eliotr_run_status">;
type ExternalTaskName = Extract<McpResearchToolName,
  "eliotr_task_pull" | "eliotr_task_progress" | "eliotr_task_result" | "eliotr_task_status">;

export type McpResearchIngestCommand =
  | { readonly kind: "body"; readonly request: Request; readonly operation_id?: unknown }
  | { readonly kind: "status"; readonly operation_id: string };

export interface McpResearchSourceReadInput {
  readonly project_id: string;
  readonly source_revision_ref: string;
  readonly page_bytes?: number;
  readonly cursor?: string;
}

interface ProjectScopeIdentity {
  readonly kind: string;
  readonly project_id?: string;
}

/**
 * Core supplies only authenticated service and authority ports. This package owns MCP argument
 * decoding and operation sequencing; it never creates actor identity or decides project access.
 */
export interface McpResearchServiceOperationPorts<Context, RunRequest, QueryRequest, ProjectUpdate,
  FastSearchResult extends object> {
  readonly input_identifier: (value: unknown, label: string) => string;
  readonly require_project_id: (projectId: string | undefined) => string;
  readonly parse_run_request: (value: unknown) => RunRequest;
  readonly run_scope_identity: (request: RunRequest) => ProjectScopeIdentity;
  readonly parse_query_request: (value: unknown) => QueryRequest;
  readonly query_product: (request: QueryRequest) => string;
  readonly query_scope_identity: (request: QueryRequest) => ProjectScopeIdentity;
  readonly normalize_project_update: (value: Record<string, unknown>) => ProjectUpdate;
  readonly create_ingest_parser_request: (context: Context, body: Record<string, unknown>) => Request;
  readonly is_external_agent_task_name: (name: ExternalTaskName) => boolean;

  readonly prepare_ingest: (
    context: Context, name: IngestName, command: McpResearchIngestCommand,
  ) => McpResearchPreparedOperation;
  readonly prepare_project_attach: (
    context: Context, projectId: string, update: ProjectUpdate, idempotencyKey: string,
  ) => McpResearchPreparedOperation;
  readonly execute_run: (context: Context, request: RunRequest) => Promise<unknown>;
  readonly execute_query: (context: Context, request: QueryRequest) => Promise<FastSearchResult>;
  readonly execute_run_control: (context: Context, name: RunControlName, workflowInstanceId: string) => Promise<unknown>;
  readonly require_run_project: (context: Context, workflowInstanceId: string, projectId: string) => Promise<void>;
  readonly execute_external_task: (
    context: Context, name: ExternalTaskName, args: Record<string, unknown>,
  ) => Promise<unknown>;
  readonly require_artifact_project: (
    context: Context, artifact: VersionedRef, projectId: string, operation: "report" | "evidence",
  ) => Promise<void>;
  readonly execute_report: (context: Context, artifact: VersionedRef) => Promise<unknown>;
  readonly execute_section: (context: Context, artifact: VersionedRef, section: VersionedRef) => Promise<Response>;
  readonly execute_citations: (context: Context, artifact: VersionedRef, section: VersionedRef) => Promise<unknown>;
  readonly require_evidence_project: (
    context: Context, scope: VersionedRef, handle: VersionedRef, projectId: string,
  ) => Promise<void>;
  readonly execute_verify: (
    context: Context, input: { readonly scope_snapshot_ref: VersionedRef; readonly handle_ref: VersionedRef },
  ) => Promise<unknown>;
  readonly require_open_handle_project: (context: Context, handle: VersionedRef, projectId: string) => Promise<void>;
  readonly execute_open: (
    context: Context, handle: VersionedRef, selected: { readonly start: number; readonly end: number } | undefined,
  ) => Promise<Response>;
  readonly execute_source_read: (context: Context, input: McpResearchSourceReadInput) => Promise<unknown>;
}

export function mcpResearchInvalid(message: string): never {
  throw new GeminiMcpToolError("INPUT_INVALID", message);
}

function invalid(message: string): never {
  return mcpResearchInvalid(message);
}

export function mcpResearchRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("Tool arguments must be an object");
  return value as Record<string, unknown>;
}

export function mcpResearchVersionedRef(value: unknown): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) invalid("A strict versioned reference is required");
  return parsed.data;
}

export function mcpResearchRange(value: unknown): { readonly start: number; readonly end: number } | undefined {
  if (value === undefined) return undefined;
  const range = mcpResearchRecord(value);
  if (Object.keys(range).length !== 2 || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
      (range.start as number) < 0 || (range.end as number) <= (range.start as number)) {
    invalid("Range must contain byte offsets start < end");
  }
  return { start: range.start as number, end: range.end as number };
}

export function mcpResearchBindHeader(headers: Headers, name: string, value: string): void {
  const existing = headers.get(name);
  if (existing !== null && existing !== value) invalid("Tool arguments conflict with request headers");
  try { headers.set(name, value); } catch { invalid("Header-bound tool argument is invalid"); }
}

export interface McpFastSearchResponseShape {
  readonly synthesis_status: "NOT_REQUESTED";
  readonly synthesis_note: string;
}

const MCP_FAST_SEARCH_SYNTHESIS_NOTE =
  "FAST_SEARCH returns retrieved evidence and trace references; it does not generate an answer.";

export function mcpFastSearchResponse<Result extends object>(result: Result): Result & McpFastSearchResponseShape {
  return {
    ...result,
    synthesis_status: "NOT_REQUESTED",
    synthesis_note: MCP_FAST_SEARCH_SYNTHESIS_NOTE,
  };
}

const BODY_HEADERS = ["content-type", "content-length", "content-range", "x-eliotr-artifact-ref",
  "x-eliotr-section-ref", "x-eliotr-section-object-ref", "x-eliotr-section-sha256", "x-eliotr-evidence-handle",
  "x-eliotr-excerpt-sha256", "x-eliotr-verification-receipt", "x-eliotr-deployment-generation"] as const;

/** Preserve the exact bounded response bytes and selected headers in the versioned MCP envelope. */
export async function mcpResearchResponseBody(response: Response): Promise<unknown> {
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

export function mapMcpResearchServiceError(
  error: unknown,
  mapHttpError: (error: unknown) => never,
): never {
  if (error instanceof GeminiMcpToolError) throw error;
  if (error instanceof ExternalAgentTaskError) {
    throw new GeminiMcpToolError(error.code,
      "External agent task request could not be completed under its exact lease and authority", error.retryable);
  }
  if (error instanceof RuntimeLimitError) {
    throw new GeminiMcpToolError("MCP_RESEARCH_LIMIT", "Research response exceeds the MCP envelope; use a smaller query or evidence byte range");
  }
  if (error instanceof RangeError) {
    throw new GeminiMcpToolError("EVIDENCE_RANGE_INVALID", "Evidence range is outside the excerpt or splits a UTF-8 code point");
  }
  return mapHttpError(error);
}

function prepared(execute: () => Promise<unknown>): McpResearchPreparedOperation {
  return { execute };
}

export function createMcpResearchServiceOperations<Context, RunRequest, QueryRequest, ProjectUpdate,
  FastSearchResult extends object>(
  ports: McpResearchServiceOperationPorts<Context, RunRequest, QueryRequest, ProjectUpdate, FastSearchResult>,
): McpResearchApplicationOperations<Context> {
  return {
    ingest: async (name, args, actor) => {
      let command: McpResearchIngestCommand;
      if (name === "eliotr_ingest_prepare" || name === "eliotr_ingest_discover" ||
          name === "eliotr_ingest_complete_file" || name === "eliotr_ingest_commit") {
        const input = mcpResearchRecord(args.request);
        const body = name === "eliotr_ingest_prepare" ? { ...input, idempotency_key: args.idempotency_key } : input;
        if (name === "eliotr_ingest_prepare" && Object.hasOwn(input, "idempotency_key")) invalid("Use the top-level idempotency key");
        const request = ports.create_ingest_parser_request(actor.context, body);
        command = name === "eliotr_ingest_complete_file"
          ? { kind: "body", request, operation_id: args.operation_id }
          : { kind: "body", request };
      } else {
        command = { kind: "status", operation_id: ports.input_identifier(args.operation_id, "operation_id") };
      }
      return ports.prepare_ingest(actor.context, name, command);
    },
    project_attach: async (_name, args, actor) => {
      const projectId = ports.input_identifier(args.project_id, "project_id");
      const supplied = mcpResearchRecord(args.request);
      if (Object.keys(supplied).some((key) => !["title", "source_ids", "expected_revision"].includes(key))) {
        invalid("Project attachment request contains unknown fields");
      }
      const update = ports.normalize_project_update(supplied);
      const idempotencyKey = ports.input_identifier(args.idempotency_key, "idempotency_key");
      return ports.prepare_project_attach(actor.context, projectId, update, idempotencyKey);
    },
    run: async (_name, args, actor) => {
      const request = ports.parse_run_request(args.request);
      const scope = ports.run_scope_identity(request);
      if (actor.managed_oauth && (scope.kind !== "PROJECT" || scope.project_id !== actor.project_id)) {
        throw new GeminiMcpToolError("MCP_PROJECT_SCOPE_MISMATCH", "Research run scope must match project_id");
      }
      return prepared(() => ports.execute_run(actor.context, request));
    },
    query: async (_name, args, actor) => {
      const request = ports.parse_query_request(args.request);
      if (ports.query_product(request) !== "FAST_SEARCH") invalid("Only model-free FAST_SEARCH is exposed through MCP");
      const scope = ports.query_scope_identity(request);
      if (actor.managed_oauth && (scope.kind !== "PROJECT" || scope.project_id !== actor.project_id)) {
        throw new GeminiMcpToolError("MCP_PROJECT_SCOPE_MISMATCH", "Search scope must match project_id");
      }
      return prepared(async () => mcpFastSearchResponse(await ports.execute_query(actor.context, request)));
    },
    run_control: async (name, args, actor) => {
      const operation = args.workflow_instance_id;
      if (typeof operation !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(operation)) {
        invalid("A valid workflow_instance_id is required");
      }
      return prepared(async () => {
        const result = await ports.execute_run_control(actor.context, name, operation);
        if (name === "eliotr_run_status" && actor.managed_oauth) {
          await ports.require_run_project(actor.context, operation, ports.require_project_id(actor.project_id));
        }
        return result;
      });
    },
    external_task: async (name, args, actor) => {
      if (!ports.is_external_agent_task_name(name)) invalid("External task tool identity is invalid");
      return prepared(() => ports.execute_external_task(actor.context, name, args));
    },
    report: async (_name, args, actor) => {
      const artifact = mcpResearchVersionedRef(args.artifact_ref);
      if (actor.managed_oauth) {
        await ports.require_artifact_project(actor.context, artifact,
          ports.require_project_id(actor.project_id), "report");
      }
      return prepared(() => ports.execute_report(actor.context, artifact));
    },
    section: async (_name, args, actor) => {
      const artifact = mcpResearchVersionedRef(args.artifact_ref);
      const section = mcpResearchVersionedRef(args.section_ref);
      if (actor.managed_oauth) {
        await ports.require_artifact_project(actor.context, artifact,
          ports.require_project_id(actor.project_id), "report");
      }
      return prepared(async () => mcpResearchResponseBody(await ports.execute_section(actor.context, artifact, section)));
    },
    citations: async (_name, args, actor) => {
      const artifact = mcpResearchVersionedRef(args.artifact_ref);
      const section = mcpResearchVersionedRef(args.section_ref);
      if (actor.managed_oauth) {
        await ports.require_artifact_project(actor.context, artifact,
          ports.require_project_id(actor.project_id), "evidence");
      }
      return prepared(() => ports.execute_citations(actor.context, artifact, section));
    },
    verify: async (_name, args, actor) => {
      const input = { scope_snapshot_ref: mcpResearchVersionedRef(args.scope_snapshot_ref),
        handle_ref: mcpResearchVersionedRef(args.handle_ref) };
      if (actor.managed_oauth) {
        await ports.require_evidence_project(actor.context, input.scope_snapshot_ref, input.handle_ref,
          ports.require_project_id(actor.project_id));
      }
      return prepared(() => ports.execute_verify(actor.context, input));
    },
    open: async (_name, args, actor) => {
      const handle = mcpResearchVersionedRef(args.handle_ref);
      const selected = mcpResearchRange(args.range);
      if (actor.managed_oauth) {
        await ports.require_open_handle_project(actor.context, handle, ports.require_project_id(actor.project_id));
      }
      return prepared(async () => mcpResearchResponseBody(await ports.execute_open(actor.context, handle, selected)));
    },
    source_read: async (_name, args, actor) => {
      if (!actor.managed_oauth) {
        throw new GeminiMcpToolError("MCP_RESEARCH_UNAVAILABLE", "Exact source reads are available only to the owner profile");
      }
      const sourceRevision = ports.input_identifier(args.source_revision_ref, "source_revision_ref");
      const pageBytes = args.page_bytes;
      if (pageBytes !== undefined && (typeof pageBytes !== "number" || !Number.isSafeInteger(pageBytes) ||
          pageBytes < 1 || pageBytes > 24 * 1024)) invalid("page_bytes must be in [1, 24576]");
      if (args.cursor !== undefined && (typeof args.cursor !== "string" || args.cursor.length > 2048)) invalid("cursor is invalid");
      const input: McpResearchSourceReadInput = {
        project_id: ports.require_project_id(actor.project_id),
        source_revision_ref: sourceRevision,
        ...(pageBytes === undefined ? {} : { page_bytes: pageBytes as number }),
        ...(args.cursor === undefined ? {} : { cursor: args.cursor as string }),
      };
      return prepared(() => ports.execute_source_read(actor.context, input));
    },
  };
}
