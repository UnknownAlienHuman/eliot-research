import type {
  GeminiMcpToolName,
  McpToolCallContext,
  McpToolCallResult,
  McpToolDefinition,
} from "./gemini-mcp-protocol.js";
import {
  GOOGLE_ACTIONS,
  GOOGLE_PRODUCTS,
  STRICT_EMPTY_KEYS,
  SYNC_DIRECTIONS,
  GeminiMcpToolError,
  decodeCatalogInput,
  strictRecord,
  type GeminiMcpToolDependencies,
  type GoogleExternalTransport,
} from "./gemini-mcp-tool-common.js";
import { createPlan, validateReceipt } from "./gemini-mcp-google-sync.js";

export type { GeminiMcpToolDependencies, GoogleExternalTransport } from "./gemini-mcp-tool-common.js";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
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
    name: "eliotr_create_google_sync_plan",
    description: "Create a candidate-only plan for an official Google Workspace or gcloud MCP action. This tool never performs the Google action.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["google_product", "action", "direction"],
      properties: {
        google_product: { type: "string", enum: GOOGLE_PRODUCTS },
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
    annotations: readOnlyAnnotations,
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
    annotations: readOnlyAnnotations,
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
      case "eliotr_create_google_sync_plan":
        return { structuredContent: await createPlan(input, dependencies, context) };
      case "eliotr_validate_google_sync_receipt":
        return { structuredContent: await validateReceipt(input, dependencies, context) };
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
