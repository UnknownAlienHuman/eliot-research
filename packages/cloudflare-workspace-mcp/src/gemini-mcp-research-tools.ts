import { ScopeExpressionSchema, VersionedRefSchema } from "@eliotr/contracts";
import type { McpToolCallContext, McpToolDefinition } from "./gemini-mcp-protocol.js";

const identifier = { type: "string", minLength: 1, maxLength: 256,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$" } as const;
const ref = VersionedRefSchema.toJSONSchema();
// Move the existing recursive schema under this tool's $defs, without changing its vocabulary.
const scope = JSON.parse(JSON.stringify(ScopeExpressionSchema.toJSONSchema(), (key, value: unknown) => {
  if (key === "$schema") return undefined;
  return key === "$ref" && typeof value === "string" && value.startsWith("#")
    ? `#/$defs/scope${value.slice(1)}` : value;
})) as Readonly<Record<string, unknown>>;
const grant = { client_grant_id: { ...identifier,
  description: "Owner-issued project grant locator, never a credential." } };
const annotations = (idempotent: boolean) => ({
  // Search persists its scope/result; reopening reports and evidence issues read authority/receipts.
  readOnlyHint: false, destructiveHint: false, idempotentHint: idempotent, openWorldHint: false,
}) as const;

/** One registry for names, discovery schemas and dispatch. Only implemented consumers; cancellation is an explicit destructive control. */
export const MCP_RESEARCH_TOOLS = {
  eliotr_run: {
    name: "eliotr_run",
    description: "Create one Research workflow as the signed service actor within one explicit project. Requires run permission and exact owner-approved spend sponsorship. Returns the existing investigation reference and workflow ID; poll eliotr_run_status separately. May dispatch paid stages. Retain the same key and body after an uncertain response; never invent another run. Uses installed qualifications; it does not renew owner qualification probes.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["client_grant_id", "idempotency_key", "request"],
      properties: { ...grant,
        idempotency_key: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$" },
        request: { type: "object", additionalProperties: false,
          required: ["query", "product", "scope_expression", "literals", "evidence_grade", "budget_ref", "max_results"],
          properties: { query: { type: "string", minLength: 1 }, product: { const: "RESEARCH" },
            scope_expression: { type: "object", additionalProperties: false, required: ["kind", "project_id"],
              properties: { kind: { const: "PROJECT" }, project_id: identifier } },
            literals: { type: "array", maxItems: 0 }, evidence_grade: { enum: ["E0", "E1", "E2"] },
            budget_ref: { const: "research-budget-v1" }, max_results: { type: "integer", minimum: 1, maximum: 16 },
            request_version: { const: "eliotr.research-run-request.v2" }, inquiry_protocol_ref: ref },
          dependentRequired: { request_version: ["inquiry_protocol_ref"], inquiry_protocol_ref: ["request_version"] } } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  eliotr_query: {
    name: "eliotr_query",
    description: "Run project-authorized FAST_SEARCH through the HTTP query service. Returns original evidence pack and trace references, not a generated answer. Persisted work is replayed only with the same idempotency key, request and current authority. No model dispatch.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["client_grant_id", "idempotency_key", "request"],
      $defs: { scope },
      properties: { ...grant,
        idempotency_key: { type: "string", minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u0020\\u007f]+$" },
        request: { type: "object", additionalProperties: false,
          required: ["query", "product", "scope_expression", "literals", "evidence_grade", "budget_ref", "max_results"],
          properties: {
            query: { type: "string", minLength: 1, description: "Original question; the MCP JSON envelope is limited to 128 KiB." },
            product: { const: "FAST_SEARCH" }, scope_expression: { $ref: "#/$defs/scope" },
            literals: { type: "array", maxItems: 0 }, evidence_grade: { const: "E0" },
            budget_ref: { const: "retrieval-fast-v1" }, max_results: { type: "integer", minimum: 1, maximum: 16 },
          },
        },
      },
    },
    annotations: annotations(true),
  },
  eliotr_cancel: {
    name: "eliotr_cancel",
    description: "Stop one known explicit-project Research run with separate cancel permission: a grantor-authored run or your own machine run under its exact originating grant revision. Regrant never transfers control of an old machine run. Uses the same HTTP cancellation command and action key. Returns CANCELLED only after durable confirmation; completed runs conflict. Never resumes/restarts or dispatches models. Native termination may remain unconfirmed after canonical cancellation. On uncertain errors keep the same run, grant and idempotency key.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["client_grant_id", "workflow_instance_id", "idempotency_key"],
      properties: { ...grant, workflow_instance_id: { type: "string", minLength: 1, maxLength: 128,
        pattern: "^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$" },
        idempotency_key: { type: "string", minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u0020\\u007f]+$" } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  eliotr_recover: {
    name: "eliotr_recover",
    description: "Recover the same known project Research run with explicit recover permission and fingerprint-bound owner spend sponsorship: a grantor-authored run or your own machine run under its exact originating grant revision. Reuses existing checkpoints and the single run/stage action journal; does not create a new run or renew expired execution. Remaining authorized stages may call models, including the first audit. On an uncertain response keep the same run, grant and idempotency key; never substitute another action.",
    inputSchema: { type: "object", additionalProperties: false,
      required: ["client_grant_id", "workflow_instance_id", "idempotency_key"],
      properties: { ...grant, workflow_instance_id: { type: "string", minLength: 1, maxLength: 128,
        pattern: "^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$" },
        idempotency_key: { type: "string", minLength: 1, maxLength: 256, pattern: "^[^\\u0000-\\u0020\\u007f]+$" } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  eliotr_run_status: {
    name: "eliotr_run_status",
    description: "Read a known grantor-authored project run or your own machine run under its original delegation revision with status permission. A refreshed token may read after execution expiry; current project/source rights are still required. Returns the unchanged HTTP run-status DTO, not a new run. Only separate report permission permits discovery of a completed DRAFT reference through exact historical readback; this may issue read authority. No model, restart or execution renewal.",
    inputSchema: { type: "object", additionalProperties: false, required: ["client_grant_id", "workflow_instance_id"],
      properties: { ...grant, workflow_instance_id: { type: "string", minLength: 1, maxLength: 128,
        pattern: "^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$" } } },
    annotations: annotations(false),
  },
  eliotr_report: {
    name: "eliotr_report",
    description: "Reopen a known grantor-authored project DRAFT or your own machine DRAFT under its original delegation revision. Requires report permission. Refreshing your token or expiry of execution does not require restarting the run; expired/revoked/regranted read authority is rejected. Returns the same versioned HTTP reauthorization envelope, preserving hashes, freshness and DRAFT status. Issues fresh read authority, no model or artifact mutation.",
    inputSchema: { type: "object", additionalProperties: false, required: ["client_grant_id", "artifact_ref"],
      properties: { ...grant, artifact_ref: ref } },
    annotations: annotations(false),
  },
  eliotr_section: {
    name: "eliotr_section",
    description: "Read an exact saved report section with report permission. Wraps the HTTP body as strict UTF-8 with original identity/hash headers and a separate transport-body digest. Never substitutes newer source text. Issues fresh read authority; no models.",
    inputSchema: { type: "object", additionalProperties: false, required: ["client_grant_id", "artifact_ref", "section_ref"],
      properties: { ...grant, artifact_ref: ref, section_ref: ref } },
    annotations: annotations(false),
  },
  eliotr_citations: {
    name: "eliotr_citations",
    description: "Reopen saved section citations with BOTH report and evidence permissions. Returns the existing HTTP envelope pairing original references with fresh authorized handles. Preserve audit verdicts and coverage; this does not prove every claim. Issues read grants/handles; no models.",
    inputSchema: { type: "object", additionalProperties: false, required: ["client_grant_id", "artifact_ref", "section_ref"],
      properties: { ...grant, artifact_ref: ref, section_ref: ref } },
    annotations: annotations(false),
  },
  eliotr_verify: {
    name: "eliotr_verify",
    description: "Resolve an existing evidence handle against its exact scope and canonical bytes. Requires evidence permission and the handle's original delegation revision. Returns the same HTTP resolved evidence and handle; may persist a verification receipt. No model call.",
    inputSchema: { type: "object", additionalProperties: false, required: ["client_grant_id", "scope_snapshot_ref", "handle_ref"],
      properties: { ...grant, scope_snapshot_ref: ref, handle_ref: ref } },
    annotations: annotations(false),
  },
  eliotr_open: {
    name: "eliotr_open",
    description: "Open exact UTF-8 evidence bytes with evidence permission. Optional range is [start,end) in bytes. Returns original HTTP status/identity/verification headers and a separate digest of returned bytes, not a new evidence ID. May persist a verification receipt; no models.",
    inputSchema: { type: "object", additionalProperties: false, required: ["client_grant_id", "handle_ref"],
      properties: { ...grant, handle_ref: ref, range: { type: "object", additionalProperties: false,
        required: ["start", "end"], properties: { start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 1 } } } } },
    annotations: annotations(false),
  },
} as const satisfies Readonly<Record<string, Omit<McpToolDefinition, "name"> & { readonly name: string }>>;

export type McpResearchToolName = keyof typeof MCP_RESEARCH_TOOLS;
export const MCP_RESEARCH_TOOL_NAMES = Object.freeze(Object.keys(MCP_RESEARCH_TOOLS) as McpResearchToolName[]);
export function isMcpResearchTool(name: string): name is McpResearchToolName {
  return Object.hasOwn(MCP_RESEARCH_TOOLS, name);
}
export type McpResearchToolCall = (
  name: McpResearchToolName, input: unknown, context: McpToolCallContext,
) => Promise<unknown>;
