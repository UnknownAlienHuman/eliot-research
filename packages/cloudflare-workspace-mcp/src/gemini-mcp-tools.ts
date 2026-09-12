import type {
  GeminiMcpToolName,
  McpToolCallContext,
  McpToolCallResult,
  McpToolDefinition,
} from "./gemini-mcp-protocol.js";
import {
  GOOGLE_ACTIONS,
  WORKSPACE_GOOGLE_PRODUCTS,
  STRICT_EMPTY_KEYS,
  SYNC_DIRECTIONS,
  GeminiMcpToolError,
  decodeCatalogInput,
  strictRecord,
  type GeminiMcpToolDependencies,
} from "./gemini-mcp-tool-common.js";
import {
  confirmClientDiagnostic,
  MCP_CLIENT_DIAGNOSTIC_TOOL_NAME,
} from "./gemini-mcp-client-diagnostics.js";
import { createPlan, validateReceipt } from "./gemini-mcp-google-sync.js";
import { createWorkspacePlan, validateWorkspaceReceipt } from "./workspace-mcp-google-sync.js";

export type { GeminiMcpToolDependencies, GoogleExternalTransport } from "./gemini-mcp-tool-common.js";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const candidateLedgerAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const clientDiagnosticAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export const GEMINI_MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "eliotr_system_status",
    description: "Read bounded ELIOT Research readiness and enabled integration contours without secrets.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: readOnlyAnnotations,
  },
  {
    name: "eliotr_catalog",
    description: "List bounded ELIOT projects and authoritative LIVE source heads. Results are navigation metadata, not evidence.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        project_id: { type: "string", maxLength: 256 },
        cursor: { type: "string", maxLength: 2048 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      },
    },
    annotations: readOnlyAnnotations,
  },
  {
    name: MCP_CLIENT_DIAGNOSTIC_TOOL_NAME,
    description: "Consume one server-issued MCP client diagnostic challenge and return its exact observation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["challenge_id", "challenge_token"],
      properties: {
        challenge_id: { type: "string", minLength: 1, maxLength: 256 },
        challenge_token: { type: "string", minLength: 1, maxLength: 1024 },
      },
    },
    annotations: clientDiagnosticAnnotations,
  },
  {
    name: "eliotr_create_google_sync_plan",
    description: "Create a candidate-only plan for an official Google Workspace or gcloud MCP action. This tool never performs the Google action.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["google_product", "action", "direction"],
      properties: {
        protocol: { type: "string", enum: ["eliotr.google-sync.plan.v2"] },
        idempotency_key: { type: "string", maxLength: 256 },
        google_product: { type: "string", enum: WORKSPACE_GOOGLE_PRODUCTS },
        action: { type: "string", enum: GOOGLE_ACTIONS },
        direction: { type: "string", enum: SYNC_DIRECTIONS },
        source_ref: { type: "string", maxLength: 256 },
        target_ref: { type: "string", maxLength: 2048 },
        google_project_id: { type: "string", maxLength: 256 },
        expected_revision: { type: "string", maxLength: 256 },
        payload_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        dry_run: { const: true, default: true },
      },
    },
    annotations: candidateLedgerAnnotations,
  },
  {
    name: "eliotr_validate_google_sync_receipt",
    description: "Validate a normalized exact-readback receipt from an official Google tool. A valid receipt remains a candidate transport observation and does not mutate ELIOT authority.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["plan", "receipt"],
      properties: {
        plan: { type: "object" },
        receipt: { type: "object" },
      },
    },
    annotations: candidateLedgerAnnotations,
  },
] as const;

export async function callGeminiMcpTool(
  dependencies: GeminiMcpToolDependencies,
  name: GeminiMcpToolName,
  input: unknown,
  context: McpToolCallContext,
): Promise<McpToolCallResult> {
  try {
    switch (name) {
      case "eliotr_system_status":
        strictRecord(input, STRICT_EMPTY_KEYS, "system status input");
        return { structuredContent: await dependencies.systemStatus(context) };
      case "eliotr_catalog":
        return { structuredContent: await dependencies.catalog(decodeCatalogInput(input), context) };
      case MCP_CLIENT_DIAGNOSTIC_TOOL_NAME:
        return { structuredContent: await confirmClientDiagnostic(dependencies, input, context) };
      case "eliotr_create_google_sync_plan":
        return { structuredContent: await (typeof input === "object" && input !== null && (input as Record<string, unknown>).protocol === "eliotr.google-sync.plan.v2"
          ? createWorkspacePlan(input, dependencies, context)
          : createPlan(input, dependencies, context)) };
      case "eliotr_validate_google_sync_receipt":
        return { structuredContent: await (typeof input === "object" && input !== null && typeof (input as Record<string, unknown>).plan === "object" && (input as { plan: Record<string, unknown> }).plan?.protocol === "eliotr.google-sync.plan.v2"
          ? validateWorkspaceReceipt(input, dependencies, context)
          : validateReceipt(input, dependencies, context)) };
    }
  } catch (error) {
    if (error instanceof GeminiMcpToolError) {
      return {
        isError: true,
        structuredContent: {
          protocol: "eliotr.mcp.tool-error.v1",
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          canonical_eliot_state_changed: false,
        },
      };
    }
    return {
      isError: true,
      structuredContent: {
        protocol: "eliotr.mcp.tool-error.v1",
        code: "INTERNAL_TOOL_ERROR",
        message: "Tool execution failed",
        retryable: true,
        canonical_eliot_state_changed: false,
      },
    };
  }
}
