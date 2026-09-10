import type { AccessVerifier } from "@eliotr/platform-cloudflare";
import { describe, expect, it } from "vitest";
import type { Env } from "./env.js";
import { handleGeminiMcp } from "./gemini-mcp.js";
import {
  GEMINI_MCP_TOOL_NAMES,
  handleGeminiMcpProtocol,
  type GeminiMcpServerDependencies,
  type McpToolCallContext,
} from "./gemini-mcp-protocol.js";
import {
  callGeminiMcpTool,
  GEMINI_MCP_TOOLS,
  type GeminiMcpToolDependencies,
} from "./gemini-mcp-tools.js";

const context: McpToolCallContext = {
  principal_ref: "gemini-spark",
  trace_id: "trace-1",
  deployment_generation: "generation-1",
};

function request(
  body: unknown,
  protocolVersion?: string,
  url = "https://mcp.example/mcp",
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (protocolVersion !== undefined) headers.set("mcp-protocol-version", protocolVersion);
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function server(): GeminiMcpServerDependencies {
  return {
    server_version: "test",
    deployment_generation: "generation-1",
    listTools: () => GEMINI_MCP_TOOLS,
    async callTool(name, input, callContext) {
      return callGeminiMcpTool(toolDependencies("gemini-mcp"), name, input, callContext);
    },
  };
}

function toolDependencies(
  googleTransport: "disabled" | "gemini-mcp" | "drive-exchange",
): GeminiMcpToolDependencies {
  return {
    google_transport: googleTransport,
    now: () => Date.parse("2026-08-30T12:00:00.000Z"),
    async systemStatus() { return { ready: true }; },
    async catalog(input) { return { projects: [], sources: [], input }; },
  };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe("Gemini Spark MCP protocol", () => {
  it("negotiates MCP 2025-06-18 and exposes only the bounded tool allow-list", async () => {
    const initialized = await handleGeminiMcpProtocol(request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "gemini-cli", version: "test" },
      },
    }), server(), context);
    expect(initialized.status).toBe(200);
    expect(await body(initialized)).toMatchObject({
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
      },
    });

    const listed = await handleGeminiMcpProtocol(request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    }, "2025-06-18"), server(), context);
    const listedBody = await body(listed);
    const result = listedBody.result as { tools: readonly { name: string }[] };
    expect(result.tools.map((tool) => tool.name)).toEqual(GEMINI_MCP_TOOL_NAMES);
    expect(result.tools.every((tool) => !tool.name.includes("database"))).toBe(true);
  });

  it("rejects JSON-RPC batching and subsequent requests without the protocol header", async () => {
    const batch = await handleGeminiMcpProtocol(request([{
      jsonrpc: "2.0", id: 1, method: "ping",
    }]), server(), context);
    expect(batch.status).toBe(400);
    expect(await body(batch)).toMatchObject({ error: { code: -32600 } });

    const missingHeader = await handleGeminiMcpProtocol(request({
      jsonrpc: "2.0", id: 2, method: "tools/list",
    }), server(), context);
    expect(missingHeader.status).toBe(400);
    expect(await body(missingHeader)).toMatchObject({ error: { code: -32600 } });
  });

  it("creates a plan but refuses direct Google effects", async () => {
    const denied = await callGeminiMcpTool(
      toolDependencies("gemini-mcp"),
      "eliotr_create_google_sync_plan",
      {
        google_product: "drive",
        action: "update",
        direction: "eliot_to_google",
        dry_run: false,
      },
      context,
    );
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({
      code: "DIRECT_EFFECT_DENIED",
      canonical_eliot_state_changed: false,
    });

    const planned = await callGeminiMcpTool(
      toolDependencies("gemini-mcp"),
      "eliotr_create_google_sync_plan",
      {
        google_product: "drive",
        action: "update",
        direction: "eliot_to_google",
        payload_sha256: "a".repeat(64),
      },
      context,
    );
    expect(planned.isError).toBeUndefined();
    expect(planned.structuredContent).toMatchObject({
      connector: "google-workspace",
      confirmation_required: true,
      effect_ceiling: "NO_EXTERNAL_EFFECT",
      exact_readback_required: true,
      eliot_authority_changed: false,
    });
  });

  it("blocks Gemini orchestration while Drive Exchange owns the transport", async () => {
    const result = await callGeminiMcpTool(
      toolDependencies("drive-exchange"),
      "eliotr_create_google_sync_plan",
      {
        google_product: "sheets",
        action: "append",
        direction: "eliot_to_google",
      },
      context,
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: "GOOGLE_TRANSPORT_DISABLED" },
    });
  });

  it("keeps a validated Google readback candidate-only", async () => {
    const dependencies = toolDependencies("gemini-mcp");
    const planned = await callGeminiMcpTool(
      dependencies,
      "eliotr_create_google_sync_plan",
      {
        google_product: "sheets",
        action: "append",
        direction: "eliot_to_google",
        payload_sha256: "b".repeat(64),
      },
      context,
    );
    const plan = planned.structuredContent as Record<string, unknown>;
    const validated = await callGeminiMcpTool(
      dependencies,
      "eliotr_validate_google_sync_receipt",
      {
        plan,
        receipt: {
          connector: "google-workspace",
          google_product: "sheets",
          action: "append",
          resource_id: "sheet-1",
          observed_revision: "revision-2",
          observed_at: "2026-08-30T12:01:00.000Z",
          readback_performed: true,
          readback_payload_sha256: "b".repeat(64),
        },
      },
      context,
    );
    expect(validated.structuredContent).toMatchObject({
      validated: true,
      disposition: "OBSERVED_MATCH",
      candidate_only: true,
      google_readback_performed_by_eliotr: false,
      canonical_eliot_state_changed: false,
      authority_reconciliation_required: true,
    });
  });
});

describe("Gemini Spark MCP HTTP boundary", () => {
  const environment = {
    DEPLOYMENT_GENERATION: "generation-1",
    ENVIRONMENT: "development",
    GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp",
    MCP_HOSTNAME: "mcp.example",
  } as unknown as Env;
  const executionContext = {} as ExecutionContext;

  it("is reachable only on the dedicated MCP hostname", async () => {
    let verificationCalled = false;
    const verifier: AccessVerifier = {
      async verify() {
        verificationCalled = true;
        throw new Error("must not verify a wrong-host request");
      },
    };
    const response = await handleGeminiMcp(
      request(
        { jsonrpc: "2.0", id: 1, method: "ping" },
        "2025-06-18",
        "https://research.example/mcp",
      ),
      environment,
      executionContext,
      { accessVerifier: verifier },
    );
    expect(response.status).toBe(404);
    expect(verificationCalled).toBe(false);
    expect(await body(response)).toMatchObject({ code: "MCP_ROUTE_NOT_FOUND" });
  });

  it("requires the exact signed Gemini service principal", async () => {
    const ownerVerifier: AccessVerifier = {
      async verify() {
        return {
          principal_ref: "owner@example.com",
          credential_generation: "owner-1",
          authentication_method: "cloudflare_access",
          expires_at: "2026-08-30T13:00:00.000Z",
        };
      },
    };
    const response = await handleGeminiMcp(
      request({ jsonrpc: "2.0", id: 1, method: "ping" }, "2025-06-18"),
      environment,
      executionContext,
      { accessVerifier: ownerVerifier },
    );
    expect(response.status).toBe(403);
    expect(await body(response)).toMatchObject({ code: "MCP_SERVICE_PRINCIPAL_DENIED" });
  });

  it("rejects browser-originated requests even with a valid service identity", async () => {
    const validVerifier: AccessVerifier = {
      async verify() {
        return {
          principal_ref: "gemini-spark",
          credential_generation: "service-1",
          authentication_method: "service_token",
          expires_at: "2026-08-30T13:00:00.000Z",
        };
      },
    };
    const browserRequest = request({ jsonrpc: "2.0", id: 1, method: "ping" }, "2025-06-18");
    browserRequest.headers.set("origin", "https://attacker.example");
    const response = await handleGeminiMcp(
      browserRequest,
      environment,
      executionContext,
      { accessVerifier: validVerifier },
    );
    expect(response.status).toBe(403);
    expect(await body(response)).toMatchObject({ code: "MCP_BROWSER_ORIGIN_DENIED" });
  });
});
