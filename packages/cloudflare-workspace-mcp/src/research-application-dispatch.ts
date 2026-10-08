import { GeminiMcpToolError } from "./gemini-mcp-tool-common.js";
import type { McpToolCallContext } from "./gemini-mcp-protocol.js";
import { MCP_RESEARCH_TOOLS, type McpResearchToolCall, type McpResearchToolName } from "./gemini-mcp-research-tools.js";

const MANAGED_OAUTH_TOOLS = new Set<McpResearchToolName>([
  "eliotr_query", "eliotr_run", "eliotr_run_status", "eliotr_report", "eliotr_section",
  "eliotr_citations", "eliotr_verify", "eliotr_open", "eliotr_source_read",
]);

export interface McpResearchApplicationDispatchActor<Context> {
  readonly context: Context;
  readonly managed_oauth: boolean;
  readonly project_id?: string;
}

export interface McpResearchPreparedOperation {
  readonly execute: () => Promise<unknown>;
}

type PrepareOperation<Context, Name extends McpResearchToolName> = (
  name: Name,
  args: Record<string, unknown>,
  actor: McpResearchApplicationDispatchActor<Context>,
) => Promise<McpResearchPreparedOperation>;

export interface McpResearchApplicationOperations<Context> {
  readonly ingest: PrepareOperation<Context, Extract<McpResearchToolName,
    "eliotr_ingest_prepare" | "eliotr_ingest_discover" | "eliotr_ingest_complete_file" |
    "eliotr_ingest_commit" | "eliotr_ingest_status" | "eliotr_ingest_recovery">>;
  readonly project_attach: PrepareOperation<Context, "eliotr_project_attach">;
  readonly run: PrepareOperation<Context, "eliotr_run">;
  readonly query: PrepareOperation<Context, "eliotr_query">;
  readonly run_control: PrepareOperation<Context, Extract<McpResearchToolName,
    "eliotr_recover" | "eliotr_cancel" | "eliotr_run_status">>;
  readonly external_task: PrepareOperation<Context, Extract<McpResearchToolName,
    "eliotr_task_pull" | "eliotr_task_progress" | "eliotr_task_result" | "eliotr_task_status">>;
  readonly report: PrepareOperation<Context, "eliotr_report">;
  readonly section: PrepareOperation<Context, "eliotr_section">;
  readonly citations: PrepareOperation<Context, "eliotr_citations">;
  readonly verify: PrepareOperation<Context, "eliotr_verify">;
  readonly open: PrepareOperation<Context, "eliotr_open">;
  readonly source_read: PrepareOperation<Context, "eliotr_source_read">;
}

export interface McpResearchApplicationDispatchPorts<Context> {
  readonly resolve_actor: (
    name: McpResearchToolName,
    args: Record<string, unknown>,
    tool_context: McpToolCallContext,
  ) => Promise<McpResearchApplicationDispatchActor<Context>>;
  readonly require_owner_project: (actor: McpResearchApplicationDispatchActor<Context>) => Promise<void>;
  readonly operations: McpResearchApplicationOperations<Context>;
  readonly execute_with_currentness: (
    name: McpResearchToolName,
    args: Record<string, unknown>,
    actor: McpResearchApplicationDispatchActor<Context>,
    operation: McpResearchPreparedOperation,
    tool_context: McpToolCallContext,
  ) => Promise<unknown>;
  readonly require_readiness: () => Promise<void>;
  readonly map_error: (error: unknown) => never;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GeminiMcpToolError("INPUT_INVALID", "Tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function validateToolArguments(
  name: McpResearchToolName,
  args: Record<string, unknown>,
  managedOAuth: boolean,
): void {
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
      requiredProperties.some((key) => !Object.hasOwn(args, key))) {
    throw new GeminiMcpToolError("INPUT_INVALID", "Tool arguments contain unknown or missing fields");
  }
}

function prepareOperation<Context>(
  name: McpResearchToolName,
  args: Record<string, unknown>,
  actor: McpResearchApplicationDispatchActor<Context>,
  operations: McpResearchApplicationOperations<Context>,
): Promise<McpResearchPreparedOperation> {
  switch (name) {
    case "eliotr_ingest_prepare":
    case "eliotr_ingest_discover":
    case "eliotr_ingest_complete_file":
    case "eliotr_ingest_commit":
    case "eliotr_ingest_status":
    case "eliotr_ingest_recovery":
      return operations.ingest(name, args, actor);
    case "eliotr_project_attach":
      return operations.project_attach(name, args, actor);
    case "eliotr_run":
      return operations.run(name, args, actor);
    case "eliotr_query":
      return operations.query(name, args, actor);
    case "eliotr_recover":
    case "eliotr_cancel":
    case "eliotr_run_status":
      return operations.run_control(name, args, actor);
    case "eliotr_task_pull":
    case "eliotr_task_progress":
    case "eliotr_task_result":
    case "eliotr_task_status":
      return operations.external_task(name, args, actor);
    case "eliotr_report":
      return operations.report(name, args, actor);
    case "eliotr_section":
      return operations.section(name, args, actor);
    case "eliotr_citations":
      return operations.citations(name, args, actor);
    case "eliotr_verify":
      return operations.verify(name, args, actor);
    case "eliotr_open":
      return operations.open(name, args, actor);
    case "eliotr_source_read":
      return operations.source_read(name, args, actor);
    default:
      throw new GeminiMcpToolError("MCP_RESEARCH_UNAVAILABLE", "This Research operation is unavailable");
  }
}

/**
 * Owns MCP research tool protocol dispatch while Core supplies real authorization,
 * application operations, readiness, and scope-currentness checks.
 */
export function createMcpResearchApplicationDispatch<Context>(
  ports: McpResearchApplicationDispatchPorts<Context>,
): McpResearchToolCall {
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
      validateToolArguments(name, args, managedOAuth);

      const actor = await ports.resolve_actor(name, args, toolContext);
      if (actor.managed_oauth && name !== "eliotr_source_read") {
        await ports.require_owner_project(actor);
      }
      const operation = await prepareOperation(name, args, actor, ports.operations);
      await ports.require_readiness();
      return await ports.execute_with_currentness(name, args, actor, operation, toolContext);
    } catch (error) {
      return ports.map_error(error);
    }
  };
}
