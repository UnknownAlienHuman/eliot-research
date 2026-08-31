import {
  RuntimeLimitError,
  readRequestBodyWithinBytes,
  serializeJsonWithinBytes,
} from "@eliotr/platform-cloudflare";

export const MCP_PROTOCOL_VERSION = "2025-06-18" as const;
export const MCP_COMPATIBLE_PROTOCOL_VERSIONS = [
  MCP_PROTOCOL_VERSION,
  "2025-03-26",
] as const;

export const GEMINI_MCP_TOOL_NAMES = [
  "eliotr_system_status",
  "eliotr_catalog",
  "eliotr_create_google_sync_plan",
  "eliotr_validate_google_sync_receipt",
] as const;

export type GeminiMcpToolName = typeof GEMINI_MCP_TOOL_NAMES[number];
export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface McpToolDefinition {
  readonly name: GeminiMcpToolName;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: {
    readonly readOnlyHint: true;
    readonly destructiveHint: false;
    readonly idempotentHint: true;
    readonly openWorldHint: false;
  };
}

export interface McpToolCallContext {
  readonly principal_ref: string;
  readonly trace_id: string;
  readonly deployment_generation: string;
}

export interface McpToolCallResult {
  readonly structuredContent: unknown;
  readonly isError?: boolean;
}

export interface GeminiMcpServerDependencies {
  readonly server_version: string;
  readonly deployment_generation: string;
  readonly callTool: (
    name: GeminiMcpToolName,
    input: unknown,
    context: McpToolCallContext,
  ) => Promise<McpToolCallResult>;
  readonly listTools: () => readonly McpToolDefinition[];
}

export class McpProtocolError extends Error {
  public readonly rpc_code: number;
  public readonly http_status: number;
  public readonly data: unknown;

  public constructor(
    rpcCode: number,
    message: string,
    httpStatus = 400,
    data?: unknown,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "McpProtocolError";
    this.rpc_code = rpcCode;
    this.http_status = httpStatus;
    this.data = data;
  }
}

const MAX_MCP_REQUEST_BYTES = 128 * 1024;
const MAX_MCP_RESPONSE_BYTES = 512 * 1024;
const MAX_METHOD_BYTES = 128;
const MAX_TOOL_NAME_BYTES = 128;
const SUPPORTED_VERSIONS = new Set<string>(MCP_COMPATIBLE_PROTOCOL_VERSIONS);
const REQUEST_KEYS = new Set(["jsonrpc", "id", "method", "params"]);

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new McpProtocolError(
      -32600,
      `${label} contains unsupported fields`,
      400,
      { unknown_fields: unknown.slice(0, 16) },
    );
  }
}

function decodeId(value: unknown): JsonRpcId | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.length > 0 && utf8Bytes(value) <= 256) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new McpProtocolError(-32600, "JSON-RPC id must be a bounded string or safe integer");
}

function decodeRequest(value: unknown): JsonRpcRequest {
  if (!isRecord(value)) {
    throw new McpProtocolError(-32600, "MCP request must be one JSON-RPC object");
  }
  assertOnlyKeys(value, REQUEST_KEYS, "JSON-RPC request");
  if (value.jsonrpc !== "2.0") {
    throw new McpProtocolError(-32600, "JSON-RPC version must be 2.0");
  }
  if (
    typeof value.method !== "string" ||
    value.method.length === 0 ||
    value.method !== value.method.trim() ||
    utf8Bytes(value.method) > MAX_METHOD_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value.method)
  ) {
    throw new McpProtocolError(-32600, "JSON-RPC method is invalid");
  }
  const id = decodeId(value.id);
  return {
    jsonrpc: "2.0",
    method: value.method,
    ...(id === undefined ? {} : { id }),
    ...(value.params === undefined ? {} : { params: value.params }),
  };
}

function jsonHeaders(protocolVersion?: string): Headers {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (protocolVersion !== undefined) {
    headers.set("mcp-protocol-version", protocolVersion);
  }
  return headers;
}

function jsonResponse(value: unknown, status = 200, protocolVersion?: string): Response {
  const body = serializeJsonWithinBytes(
    "gemini_mcp.response",
    value,
    MAX_MCP_RESPONSE_BYTES,
  );
  return new Response(body, { status, headers: jsonHeaders(protocolVersion) });
}

function rpcResult(id: JsonRpcId, result: unknown, protocolVersion?: string): Response {
  return jsonResponse({ jsonrpc: "2.0", id, result }, 200, protocolVersion);
}

function rpcError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  status: number,
  data?: unknown,
): Response {
  return jsonResponse({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  }, status);
}

function requireObjectParams(request: JsonRpcRequest, label: string): Record<string, unknown> {
  if (!isRecord(request.params)) {
    throw new McpProtocolError(-32602, `${label} params must be an object`);
  }
  return request.params;
}

function requireEmptyParams(request: JsonRpcRequest, label: string): void {
  if (request.params === undefined) return;
  const params = requireObjectParams(request, label);
  if (Object.keys(params).length !== 0) {
    throw new McpProtocolError(-32602, `${label} does not accept parameters`);
  }
}

function decodeInitializeVersion(request: JsonRpcRequest): string {
  const params = requireObjectParams(request, "initialize");
  const allowed = new Set(["protocolVersion", "capabilities", "clientInfo", "_meta"]);
  assertOnlyKeys(params, allowed, "initialize params");
  if (typeof params.protocolVersion !== "string") {
    throw new McpProtocolError(-32602, "initialize.protocolVersion is required");
  }
  if (!SUPPORTED_VERSIONS.has(params.protocolVersion)) {
    throw new McpProtocolError(
      -32602,
      "unsupported MCP protocol version",
      400,
      { supported_versions: MCP_COMPATIBLE_PROTOCOL_VERSIONS },
    );
  }
  if (!isRecord(params.capabilities) || !isRecord(params.clientInfo)) {
    throw new McpProtocolError(-32602, "initialize capabilities and clientInfo are required objects");
  }
  return params.protocolVersion;
}

function requireProtocolHeader(request: Request): string {
  const version = request.headers.get("mcp-protocol-version");
  if (version === null || !SUPPORTED_VERSIONS.has(version)) {
    throw new McpProtocolError(
      -32600,
      "MCP-Protocol-Version header is missing or unsupported",
      400,
      { supported_versions: MCP_COMPATIBLE_PROTOCOL_VERSIONS },
    );
  }
  return version;
}

function decodeToolCall(request: JsonRpcRequest): {
  readonly name: GeminiMcpToolName;
  readonly input: unknown;
} {
  const params = requireObjectParams(request, "tools/call");
  assertOnlyKeys(params, new Set(["name", "arguments", "_meta"]), "tools/call params");
  if (
    typeof params.name !== "string" ||
    utf8Bytes(params.name) > MAX_TOOL_NAME_BYTES ||
    !GEMINI_MCP_TOOL_NAMES.includes(params.name as GeminiMcpToolName)
  ) {
    throw new McpProtocolError(-32602, "unknown MCP tool name");
  }
  return {
    name: params.name as GeminiMcpToolName,
    input: params.arguments ?? {},
  };
}

function toolResultPayload(result: McpToolCallResult): Record<string, unknown> {
  let text: string;
  try {
    text = JSON.stringify(result.structuredContent);
  } catch (cause) {
    throw new McpProtocolError(-32603, "tool result is not JSON serializable", 500, undefined, cause);
  }
  return {
    content: [{ type: "text", text }],
    structuredContent: result.structuredContent,
    isError: result.isError ?? false,
  };
}

async function parseBody(request: Request): Promise<JsonRpcRequest> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new McpProtocolError(-32600, "MCP POST requires application/json", 415);
  }
  const bytes = await readRequestBodyWithinBytes(request, {
    label: "gemini_mcp.request",
    max_bytes: MAX_MCP_REQUEST_BYTES,
    max_chunks: 256,
  });
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new McpProtocolError(-32700, "MCP request is not valid UTF-8", 400, undefined, cause);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new McpProtocolError(-32700, "MCP request is not valid JSON", 400, undefined, cause);
  }
  if (Array.isArray(value)) {
    throw new McpProtocolError(-32600, "JSON-RPC batching is not supported by MCP 2025-06-18");
  }
  return decodeRequest(value);
}

export async function handleGeminiMcpProtocol(
  request: Request,
  dependencies: GeminiMcpServerDependencies,
  context: McpToolCallContext,
): Promise<Response> {
  if (request.method === "GET") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }

  let message: JsonRpcRequest | undefined;
  try {
    message = await parseBody(request);
    if (message.method === "initialize") {
      if (message.id === undefined) {
        throw new McpProtocolError(-32600, "initialize must be a JSON-RPC request");
      }
      const version = decodeInitializeVersion(message);
      return rpcResult(message.id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: "eliot-research",
          version: dependencies.server_version,
        },
        instructions:
          "ELIOT tools are bounded planning, catalog, and receipt-validation surfaces. " +
          "They do not mutate Google or canonical ELIOT state. Use official Google Workspace or " +
          "gcloud tools only after an ELIOT sync plan and exact post-action readback.",
      }, version);
    }

    const version = requireProtocolHeader(request);
    if (message.method === "notifications/initialized") {
      if (message.id !== undefined) {
        throw new McpProtocolError(-32600, "notifications/initialized must not include an id");
      }
      requireEmptyParams(message, "notifications/initialized");
      return new Response(null, { status: 202, headers: { "mcp-protocol-version": version } });
    }

    if (message.id === undefined) {
      return new Response(null, { status: 202, headers: { "mcp-protocol-version": version } });
    }

    if (message.method === "ping") {
      requireEmptyParams(message, "ping");
      return rpcResult(message.id, {}, version);
    }
    if (message.method === "tools/list") {
      requireEmptyParams(message, "tools/list");
      return rpcResult(message.id, { tools: dependencies.listTools() }, version);
    }
    if (message.method === "resources/list") {
      requireEmptyParams(message, "resources/list");
      return rpcResult(message.id, { resources: [] }, version);
    }
    if (message.method === "prompts/list") {
      requireEmptyParams(message, "prompts/list");
      return rpcResult(message.id, { prompts: [] }, version);
    }
    if (message.method === "tools/call") {
      const call = decodeToolCall(message);
      const result = await dependencies.callTool(call.name, call.input, context);
      return rpcResult(message.id, toolResultPayload(result), version);
    }
    return rpcError(message.id, -32601, "Method not found", 404);
  } catch (error) {
    if (error instanceof McpProtocolError) {
      return rpcError(message?.id ?? null, error.rpc_code, error.message, error.http_status, error.data);
    }
    if (error instanceof RuntimeLimitError) {
      const requestFailure = error.label.startsWith("gemini_mcp.request");
      return rpcError(
        message?.id ?? null,
        requestFailure ? -32600 : -32603,
        requestFailure ? "MCP request exceeds its bounded envelope" : "MCP response exceeds its bounded envelope",
        requestFailure ? 413 : 500,
      );
    }
    return rpcError(message?.id ?? null, -32603, "Internal MCP error", 500);
  }
}
