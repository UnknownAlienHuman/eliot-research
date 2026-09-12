import type { AccessVerifier } from "@eliotr/cloudflare-access";
import {
  MCP_DIAGNOSTIC_PROTOCOL,
  type McpDiagnosticConsumeInput,
  type McpDiagnosticConsumeResult,
} from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import {
  confirmClientDiagnostic,
  MCP_CLIENT_DIAGNOSTIC_TOOL_NAME,
  type McpClientDiagnosticToolDependencies,
} from "./gemini-mcp-client-diagnostics.js";
import { handleGeminiMcp, type WorkspaceMcpRuntime } from "./gemini-mcp.js";
import {
  callGeminiMcpTool,
  GEMINI_MCP_TOOLS,
  type GeminiMcpToolDependencies,
} from "./gemini-mcp-tools.js";
import { GeminiMcpToolError } from "./gemini-mcp-tool-common.js";
import type {
  McpToolCallContext,
  McpVerifiedActorContext,
} from "./gemini-mcp-protocol.js";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");
const ACTOR_EXPIRY = "2026-09-12T12:10:00.000Z";
const CHALLENGE_INPUT: McpDiagnosticConsumeInput = {
  challenge_id: "challenge-1",
  challenge_token: "opaque-token-1",
};

function progressingClock(): () => number {
  let calls = 0;
  return () => calls++ === 0 ? NOW : NOW + 120_000;
}

function serviceActor(overrides: Partial<McpVerifiedActorContext> = {}): McpVerifiedActorContext {
  return Object.freeze({
    actor_ref: "gemini-spark",
    credential_generation: "credential-1",
    authentication_method: "service_token",
    expires_at: ACTOR_EXPIRY,
    auth_profile: "service-token",
    deployment_generation: "generation-1",
    ...overrides,
  });
}

function serviceContext(
  overrides: Partial<Omit<McpToolCallContext, "verified_actor">> = {},
  actorOverrides: Partial<McpVerifiedActorContext> = {},
): McpToolCallContext {
  return Object.freeze({
    principal_ref: "gemini-spark",
    trace_id: "trace-1",
    deployment_generation: "generation-1",
    ...overrides,
    verified_actor: serviceActor(actorOverrides),
  });
}

function confirmedResult(
  input: McpDiagnosticConsumeInput,
  context: McpToolCallContext,
): McpDiagnosticConsumeResult {
  return {
    protocol: MCP_DIAGNOSTIC_PROTOCOL,
    status: "CONFIRMED",
    challenge_id: input.challenge_id,
    observation_ref: "observation-1",
    observed_at: "2026-09-12T12:01:00.000Z",
    auth_profile: "service-token",
    deployment_generation: context.deployment_generation,
    trace_id: context.trace_id,
  };
}

function diagnosticDependencies(
  overrides: Partial<McpClientDiagnosticToolDependencies> = {},
): McpClientDiagnosticToolDependencies {
  return {
    mcp_auth_profile: "service-token",
    deployment_generation: "generation-1",
    now: progressingClock(),
    mcpClientDiagnosticConsume: async (input, context) => confirmedResult(input, context),
    ...overrides,
  };
}

function toolDependencies(
  overrides: Partial<GeminiMcpToolDependencies> = {},
): GeminiMcpToolDependencies {
  return {
    google_transport: "gemini-mcp",
    now: progressingClock(),
    async systemStatus() { return { ready: true }; },
    async catalog() { return { projects: [] }; },
    mcp_auth_profile: "service-token",
    deployment_generation: "generation-1",
    ...overrides,
  };
}

function httpEnvironment(callback?: WorkspaceMcpRuntime["mcpClientDiagnosticConsume"]): WorkspaceMcpRuntime {
  return {
    ENVIRONMENT: "development",
    DEPLOYMENT_GENERATION: "generation-1",
    GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp",
    MCP_HOSTNAME: "mcp.example",
    MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: "client.access",
    readReadiness: async () => ({ ready: true, blocking_reason_codes: [] }),
    ...(callback === undefined ? {} : { mcpClientDiagnosticConsume: callback }),
  };
}

const accessVerifier: AccessVerifier = {
  async verify() {
    return {
      principal_ref: "client.access",
      credential_generation: "credential-1",
      authentication_method: "service_token" as const,
      expires_at: ACTOR_EXPIRY,
    };
  },
};

function httpRequest(method: string, params?: Record<string, unknown>): Request {
  return new Request("https://mcp.example/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
      "cf-ray": "trace-http",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      ...(params === undefined ? {} : { params }),
    }),
  });
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe("MCP client diagnostic confirmation tool", () => {
  it("declares the strict one-shot input and non-idempotent annotations", () => {
    const definition = GEMINI_MCP_TOOLS.find((tool) => tool.name === MCP_CLIENT_DIAGNOSTIC_TOOL_NAME);
    expect(definition).toMatchObject({
      name: MCP_CLIENT_DIAGNOSTIC_TOOL_NAME,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["challenge_id", "challenge_token"],
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    });
  });

  it("calls the trusted callback only with a valid context and returns public DTO fields", async () => {
    const context = serviceContext();
    let received: McpDiagnosticConsumeInput | undefined;
    const result = await confirmClientDiagnostic(diagnosticDependencies({
      mcpClientDiagnosticConsume: async (input, receivedContext) => {
        received = input;
        expect(receivedContext).not.toBe(context);
        expect(Object.isFrozen(receivedContext)).toBe(true);
        expect(receivedContext.verified_actor === undefined || Object.isFrozen(receivedContext.verified_actor)).toBe(true);
        return confirmedResult(input, receivedContext);
      },
    }), CHALLENGE_INPUT, context);

    expect(received).toEqual(CHALLENGE_INPUT);
    expect(result).toEqual(confirmedResult(CHALLENGE_INPUT, context));
    expect(Object.keys(result).sort()).toEqual([
      "auth_profile",
      "challenge_id",
      "deployment_generation",
      "observation_ref",
      "observed_at",
      "protocol",
      "status",
      "trace_id",
    ]);
    expect(JSON.stringify(result)).not.toContain("challenge_token");
    expect(JSON.stringify(result)).not.toContain("credential_generation");
    expect(JSON.stringify(result)).not.toContain("actor_ref");
  });

  it("rejects strict-input violations before invoking the callback", async () => {
    let called = false;
    const response = await callGeminiMcpTool(
      toolDependencies({
        mcpClientDiagnosticConsume: async (input, context) => {
          called = true;
          return confirmedResult(input, context);
        },
      }),
      MCP_CLIENT_DIAGNOSTIC_TOOL_NAME,
      { ...CHALLENGE_INPUT, unexpected: true },
      serviceContext(),
    );

    expect(response).toMatchObject({
      isError: true,
      structuredContent: {
        protocol: "eliotr.mcp.tool-error.v1",
        code: "INPUT_INVALID",
        retryable: false,
      },
    });
    expect(called).toBe(false);
  });

  it("returns a typed unavailable error when the callback is missing", async () => {
    const response = await callGeminiMcpTool(
      toolDependencies(),
      MCP_CLIENT_DIAGNOSTIC_TOOL_NAME,
      CHALLENGE_INPUT,
      serviceContext(),
    );

    expect(response).toMatchObject({
      isError: true,
      structuredContent: {
        code: "MCP_CLIENT_DIAGNOSTIC_UNAVAILABLE",
        retryable: true,
        message: "Client diagnostic confirmation is unavailable",
      },
    });
  });

  it.each([
    ["missing actor", { ...serviceContext(), verified_actor: undefined } as unknown as McpToolCallContext],
    ["expired actor", serviceContext({}, { expires_at: "2026-09-12T12:00:00.000Z" })],
    ["actor mismatch", serviceContext({ principal_ref: "other-actor" })],
    ["deployment mismatch", serviceContext({ deployment_generation: "generation-2" })],
  ])("refuses confirmation for %s before callback", async (_label, context) => {
    let called = false;
    const response = await callGeminiMcpTool(
      toolDependencies({
        mcpClientDiagnosticConsume: async (input, receivedContext) => {
          called = true;
          return confirmedResult(input, receivedContext);
        },
      }),
      MCP_CLIENT_DIAGNOSTIC_TOOL_NAME,
      CHALLENGE_INPUT,
      context,
    );
    expect(response).toMatchObject({
      isError: true,
      structuredContent: { code: "MCP_CLIENT_DIAGNOSTIC_UNAVAILABLE", retryable: true },
    });
    expect(called).toBe(false);
  });

  it("rejects profile mismatch and callback failures without serializing internal details", async () => {
    let called = false;
    const mismatch = await callGeminiMcpTool(
      toolDependencies({
        mcp_auth_profile: "managed-oauth",
        mcpClientDiagnosticConsume: async (input, receivedContext) => {
          called = true;
          return confirmedResult(input, receivedContext);
        },
      }),
      MCP_CLIENT_DIAGNOSTIC_TOOL_NAME,
      CHALLENGE_INPUT,
      serviceContext(),
    );
    expect(mismatch).toMatchObject({
      isError: true,
      structuredContent: { code: "MCP_CLIENT_DIAGNOSTIC_UNAVAILABLE" },
    });
    expect(called).toBe(false);

    const replay = await callGeminiMcpTool(
      toolDependencies({
        mcpClientDiagnosticConsume: async () => {
          throw new GeminiMcpToolError(
            "MCP_DIAGNOSTIC_CHALLENGE_REPLAY",
            "Challenge has already been confirmed",
          );
        },
      }),
      MCP_CLIENT_DIAGNOSTIC_TOOL_NAME,
      CHALLENGE_INPUT,
      serviceContext(),
    );
    expect(replay).toMatchObject({
      isError: true,
      structuredContent: {
        code: "MCP_DIAGNOSTIC_CHALLENGE_REPLAY",
        retryable: false,
        message: "Challenge has already been confirmed",
      },
    });

    const failed = await callGeminiMcpTool(
      toolDependencies({
        mcpClientDiagnosticConsume: async () => {
          throw new Error("private diagnostic database detail");
        },
      }),
      MCP_CLIENT_DIAGNOSTIC_TOOL_NAME,
      CHALLENGE_INPUT,
      serviceContext(),
    );
    expect(failed).toMatchObject({
      isError: true,
      structuredContent: {
        code: "MCP_CLIENT_DIAGNOSTIC_UNAVAILABLE",
        message: "Client diagnostic confirmation is unavailable",
      },
    });
    expect(JSON.stringify(failed)).not.toContain("private diagnostic database detail");
  });

  it("rejects callback output that is not the exact public result binding", async () => {
    const response = await callGeminiMcpTool(
      toolDependencies({
        mcpClientDiagnosticConsume: async (input, context) => ({
          ...confirmedResult(input, context),
          challenge_token: "must-not-escape",
        } as unknown as McpDiagnosticConsumeResult),
      }),
      MCP_CLIENT_DIAGNOSTIC_TOOL_NAME,
      CHALLENGE_INPUT,
      serviceContext(),
    );
    expect(response).toMatchObject({
      isError: true,
      structuredContent: { code: "MCP_CLIENT_DIAGNOSTIC_UNAVAILABLE" },
    });
    expect(JSON.stringify(response)).not.toContain("must-not-escape");
  });

  it("requires observed_at to be inside the consume interval and before actor expiry", async () => {
    const response = await callGeminiMcpTool(
      toolDependencies({
        mcpClientDiagnosticConsume: async (input, context) => ({
          ...confirmedResult(input, context),
          observed_at: "2026-09-12T12:11:00.000Z",
        }),
      }),
      MCP_CLIENT_DIAGNOSTIC_TOOL_NAME,
      CHALLENGE_INPUT,
      serviceContext(),
    );
    expect(response).toMatchObject({
      isError: true,
      structuredContent: { code: "MCP_CLIENT_DIAGNOSTIC_UNAVAILABLE", retryable: true },
    });
  });
});

describe("MCP client diagnostic HTTP advertisement", () => {
  it("advertises and enables the surface only when the callback is wired", async () => {
    const withoutCallback = await handleGeminiMcp(
      httpRequest("tools/list"),
      httpEnvironment(),
      {} as ExecutionContext,
      { accessVerifier, now: () => NOW },
    );
    const withoutBody = await responseBody(withoutCallback);
    const withoutTools = (withoutBody.result as { tools: readonly { name: string }[] }).tools;
    expect(withoutTools.map((tool) => tool.name)).not.toContain(MCP_CLIENT_DIAGNOSTIC_TOOL_NAME);

    const callback = async (input: McpDiagnosticConsumeInput, context: McpToolCallContext) =>
      confirmedResult(input, context);
    const withCallback = await handleGeminiMcp(
      httpRequest("tools/list"),
      httpEnvironment(callback),
      {} as ExecutionContext,
      { accessVerifier, now: progressingClock() },
    );
    const withBody = await responseBody(withCallback);
    const withTools = (withBody.result as { tools: readonly { name: string }[] }).tools;
    expect(withTools.map((tool) => tool.name)).toContain(MCP_CLIENT_DIAGNOSTIC_TOOL_NAME);

    const statusResponse = await handleGeminiMcp(
      httpRequest("tools/call", {
        name: "eliotr_system_status",
        arguments: {},
      }),
      httpEnvironment(callback),
      {} as ExecutionContext,
      { accessVerifier, now: progressingClock() },
    );
    const statusBody = await responseBody(statusResponse);
    const status = (statusBody.result as { structuredContent: { enabled_surfaces: readonly string[] } }).structuredContent;
    expect(status.enabled_surfaces).toContain("client_diagnostic_confirmation");
  });

  it("keeps a hidden direct call explicitly unavailable when no callback is wired", async () => {
    const response = await handleGeminiMcp(
      httpRequest("tools/call", {
        name: MCP_CLIENT_DIAGNOSTIC_TOOL_NAME,
        arguments: CHALLENGE_INPUT,
      }),
      httpEnvironment(),
      {} as ExecutionContext,
      { accessVerifier, now: () => NOW },
    );
    const value = await responseBody(response);
    expect(value).toMatchObject({
      result: {
        structuredContent: {
          code: "MCP_CLIENT_DIAGNOSTIC_UNAVAILABLE",
          retryable: true,
        },
      },
    });
  });

  it("returns only the validated public confirmation after a wired HTTP call", async () => {
    const callback = async (input: McpDiagnosticConsumeInput, context: McpToolCallContext) =>
      confirmedResult(input, context);
    const response = await handleGeminiMcp(
      httpRequest("tools/call", {
        name: MCP_CLIENT_DIAGNOSTIC_TOOL_NAME,
        arguments: CHALLENGE_INPUT,
      }),
      httpEnvironment(callback),
      {} as ExecutionContext,
      { accessVerifier, now: progressingClock() },
    );
    const value = await responseBody(response);
    expect(value).toMatchObject({
      result: {
        structuredContent: {
          protocol: MCP_DIAGNOSTIC_PROTOCOL,
          status: "CONFIRMED",
          challenge_id: CHALLENGE_INPUT.challenge_id,
          auth_profile: "service-token",
          deployment_generation: "generation-1",
          trace_id: "trace-http",
        },
      },
    });
    expect(JSON.stringify(value)).not.toContain("challenge_token");
    expect(JSON.stringify(value)).not.toContain("credential_generation");
    expect(JSON.stringify(value)).not.toContain("actor_ref");
  });
});
