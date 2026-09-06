import type { AccessVerifier } from "@eliotr/platform-cloudflare";
import { describe, expect, it } from "vitest";
import type { Env } from "./env.js";
import { handleGeminiMcp } from "./gemini-mcp.js";

const CLIENT_ID = "0123456789abcdef0123456789abcdef.access";

function environment(clientId: string = CLIENT_ID): Env {
  return {
    ENVIRONMENT: "development",
    DEPLOYMENT_GENERATION: "generation-1",
    GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp",
    MCP_HOSTNAME: "mcp.example",
    MCP_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    MCP_ACCESS_AUDIENCE: "mcp-audience",
    MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: clientId,
  } as unknown as Env;
}

function request(): Request {
  return new Request("https://mcp.example/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    }),
  });
}

function verifier(principalRef: string): AccessVerifier {
  return {
    async verify() {
      return {
        principal_ref: principalRef,
        credential_generation: "service-credential-1",
        authentication_method: "service_token" as const,
        expires_at: "2026-09-04T14:00:00.000Z",
      };
    },
  };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe("Gemini MCP Access service-token identity", () => {
  it("admits the exact signed Access Client ID", async () => {
    const response = await handleGeminiMcp(
      request(),
      environment(),
      {} as ExecutionContext,
      { accessVerifier: verifier(CLIENT_ID) },
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
  });

  it("rejects the human-readable token name in place of the signed Client ID", async () => {
    const response = await handleGeminiMcp(
      request(),
      environment(),
      {} as ExecutionContext,
      { accessVerifier: verifier("gemini-spark") },
    );
    expect(response.status).toBe(403);
    expect(await body(response)).toMatchObject({
      code: "MCP_SERVICE_PRINCIPAL_DENIED",
    });
  });

  it("fails closed when the configured Client ID is blank or malformed", async () => {
    const blank = await handleGeminiMcp(
      request(),
      environment(""),
      {} as ExecutionContext,
    );
    expect(blank.status).toBe(503);
    expect(await body(blank)).toMatchObject({
      code: "MCP_CONFIGURATION_UNAVAILABLE",
    });

    const malformed = await handleGeminiMcp(
      request(),
      environment("gemini-spark"),
      {} as ExecutionContext,
      { accessVerifier: verifier("gemini-spark") },
    );
    expect(malformed.status).toBe(503);
    expect(await body(malformed)).toMatchObject({
      code: "MCP_CONFIGURATION_UNAVAILABLE",
    });
  });
});


describe("MCP catalog cannot impersonate an owner read policy", () => {
  async function invoke(method: string, params?: Record<string, unknown>) {
    const input = new Request("https://mcp.example/mcp", { method: "POST", headers: {
      "content-type": "application/json", "mcp-protocol-version": "2025-06-18",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }) });
    // No CORE_DB binding is supplied: neither listing nor an unadvertised catalog call may read it.
    return handleGeminiMcp(input, environment(), {} as ExecutionContext, { accessVerifier: verifier(CLIENT_ID) });
  }
  it("does not advertise a catalog without explicit service-scope authority", async () => {
    const response = await invoke("tools/list");
    expect(response.status).toBe(200);
    const value = await body(response);
    expect(JSON.stringify(value)).not.toContain('"name":"eliotr_catalog"');
    expect(JSON.stringify(value)).toContain('"name":"eliotr_system_status"');
  });
  it("denies direct calls to the hidden tool before any database operation", async () => {
    const response = await invoke("tools/call", { name: "eliotr_catalog", arguments: {} });
    expect(response.status).toBe(200);
    const value = await body(response);
    expect(JSON.stringify(value)).toContain("MCP_CATALOG_SCOPE_REQUIRED");
    expect(JSON.stringify(value)).not.toContain('"projects"');
  });
});
