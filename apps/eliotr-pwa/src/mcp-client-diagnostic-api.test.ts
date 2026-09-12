import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MCP_DIAGNOSTIC_PROTOCOL,
  type McpDiagnosticChallengeResult,
  type McpDiagnosticLatestStatus,
} from "@eliotr/contracts";
import { ApiRequestError } from "./api.js";
import { getLatestMcpClientDiagnostic, issueMcpClientDiagnostic } from "./mcp-client-diagnostic-api.js";

const GENERATION = "diagnostic-http-generation";
const SECRET = "private-diagnostic-token-value";

const issued: McpDiagnosticChallengeResult = {
  protocol: MCP_DIAGNOSTIC_PROTOCOL,
  status: "ISSUED",
  challenge_id: "mcp-diagnostic-challenge-1",
  challenge_token: "opaque-challenge-token",
  issued_at: "2026-09-12T12:00:00.000Z",
  expires_at: "2026-09-12T13:00:00.000Z",
  deployment_generation: GENERATION,
  auth_profile: "managed-oauth",
};

const latest: McpDiagnosticLatestStatus = {
  protocol: MCP_DIAGNOSTIC_PROTOCOL,
  status: "ISSUED",
  challenge_id: issued.challenge_id,
  issued_at: issued.issued_at,
  expires_at: issued.expires_at,
  deployment_generation: GENERATION,
  auth_profile: issued.auth_profile,
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function envelope(data: unknown, deployment = GENERATION, trace = "trace-1", status = 200): Response {
  return response({ data, trace_id: trace, deployment_generation: deployment }, status);
}

function problem(status: number, code: string, retryable = false): Response {
  return response({
    type: "urn:eliotr:problem:mcp-diagnostic",
    title: "Client diagnostic request failed",
    status,
    code,
    trace_id: "trace-error",
    retryable,
  }, status);
}

afterEach(() => vi.unstubAllGlobals());

describe("owner MCP client diagnostic API", () => {
  it("issues with the exact owner POST body and CSRF header, accepting 201", async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/v1/system/mcp-diagnostics");
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("same-origin");
      const headers = new Headers(init.headers);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("x-eliotr-csrf")).toBe("1");
      expect(headers.get("origin")).toBeNull();
      expect(JSON.parse(String(init.body))).toEqual({});
      return envelope(issued, GENERATION, "trace-issue", 201);
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(issueMcpClientDiagnostic(GENERATION)).resolves.toEqual(issued);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reads latest with GET and accepts only the exact 200 response contract", async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/v1/system/mcp-diagnostics");
      expect(init.method).toBe("GET");
      const headers = new Headers(init.headers);
      expect(headers.get("content-type")).toBeNull();
      expect(headers.get("x-eliotr-csrf")).toBeNull();
      return envelope(latest, GENERATION, "trace-latest", 200);
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(getLatestMcpClientDiagnostic(GENERATION)).resolves.toEqual(latest);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown envelope/data fields without exposing a token", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(envelope({ ...issued, private_field: SECRET }, GENERATION, "trace-private", 201))
      .mockResolvedValueOnce(response({
        data: latest,
        trace_id: "trace-private",
        deployment_generation: GENERATION,
        private_field: SECRET,
      }, 200));
    vi.stubGlobal("fetch", fetcher);

    const issueFailure = await issueMcpClientDiagnostic(GENERATION).catch((error: unknown) => error);
    expect(issueFailure).toBeInstanceOf(ApiRequestError);
    expect(issueFailure).toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });
    expect((issueFailure as Error).message).not.toContain(SECRET);

    const latestFailure = await getLatestMcpClientDiagnostic(GENERATION).catch((error: unknown) => error);
    expect(latestFailure).toBeInstanceOf(ApiRequestError);
    expect(latestFailure).toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH" });
    expect((latestFailure as Error).message).not.toContain(SECRET);
  });

  it("rejects envelope and payload deployment drift as API_GENERATION_MISMATCH", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => envelope(latest, "foreign-generation")));
    await expect(getLatestMcpClientDiagnostic(GENERATION)).rejects.toMatchObject({
      status: 409,
      code: "API_GENERATION_MISMATCH",
      retryable: true,
    });

    vi.stubGlobal("fetch", vi.fn(async () => envelope({ ...latest, deployment_generation: "foreign-generation" })));
    await expect(getLatestMcpClientDiagnostic(GENERATION)).rejects.toMatchObject({
      status: 409,
      code: "API_GENERATION_MISMATCH",
      retryable: true,
    });
  });

  it("accepts the protocol maximum safe envelope metadata", async () => {
    const generation = `g${"a".repeat(255)}`;
    const trace = `t${"b".repeat(127)}`;
    vi.stubGlobal("fetch", vi.fn(async () => envelope({ ...latest, deployment_generation: generation }, generation, trace)));

    await expect(getLatestMcpClientDiagnostic(generation)).resolves.toMatchObject({
      deployment_generation: generation,
    });
  });

  it("maps only the typed empty-state 404 to null and propagates other errors", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(problem(404, "MCP_DIAGNOSTIC_CHALLENGE_NOT_FOUND"))
      .mockResolvedValueOnce(problem(404, "OTHER_NOT_FOUND"))
      .mockResolvedValueOnce(problem(503, "MCP_DIAGNOSTIC_D1_UNAVAILABLE", true));
    vi.stubGlobal("fetch", fetcher);

    await expect(getLatestMcpClientDiagnostic(GENERATION)).resolves.toBeNull();
    await expect(getLatestMcpClientDiagnostic(GENERATION)).rejects.toMatchObject({ status: 404, code: "OTHER_NOT_FOUND" });
    await expect(getLatestMcpClientDiagnostic(GENERATION)).rejects.toMatchObject({ status: 503, code: "MCP_DIAGNOSTIC_D1_UNAVAILABLE", retryable: true });
  });

  it("forwards caller cancellation to the authenticated transport", async () => {
    const controller = new AbortController();
    let forwardedSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn((_url: string, init: RequestInit) => {
      forwardedSignal = init.signal;
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetcher);

    const pending = getLatestMcpClientDiagnostic(GENERATION, controller.signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(forwardedSignal).toBeDefined();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ status: 503, code: "API_REQUEST_ABORTED" });
    expect(forwardedSignal?.aborted).toBe(true);
  });
});
