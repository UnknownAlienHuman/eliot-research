import { applyD1Migrations } from "cloudflare:test";
import { env as workerEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_CLIENT_DIAGNOSTIC_TOOL_NAME } from "@eliotr/cloudflare-workspace-mcp";
import {
  MCP_DIAGNOSTIC_PROTOCOL,
  type McpDiagnosticChallengeResult,
  type McpDiagnosticLatestStatus,
} from "@eliotr/contracts";
import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { OWNER_E2E_AUDIENCE, OWNER_E2E_ISSUER } from "../src/env.js";

const runtime = workerEnv as unknown as Env & {
  readonly CORE_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  readonly SEARCH_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

interface AccessPublicJwk extends JsonWebKey {
  readonly kid: string;
}

interface SigningFixture {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: AccessPublicJwk;
}

interface RoundtripFixture {
  readonly tag: string;
  readonly deploymentGeneration: string;
  readonly ownerSubject: string;
  readonly mcpSubject: string;
  readonly ownerJwksUrl: string;
  readonly owner: SigningFixture;
  readonly mcp: SigningFixture;
  readonly mcpIssuer: string;
  readonly mcpAudience: string;
  readonly mcpHostname: string;
  readonly ownerToken: string;
  readonly mcpToken: string;
  readonly wrongAudienceToken: string;
  readonly mcpTrace: string;
  readonly tokenIssuedAt: number;
  readonly tokenExpiresAt: number;
  readonly environment: Env;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function jsonSegment(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function signingFixture(kid: string): Promise<SigningFixture> {
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }, true, ["sign", "verify"]);
  return {
    kid,
    privateKey: pair.privateKey,
    publicJwk: {
      ...await crypto.subtle.exportKey("jwk", pair.publicKey),
      kid,
      alg: "RS256",
      use: "sig",
    },
  };
}

async function sign(fixture: SigningFixture, claims: Record<string, unknown>): Promise<string> {
  const header = jsonSegment({ alg: "RS256", kid: fixture.kid, typ: "JWT" });
  const payload = jsonSegment(claims);
  const signingInput = new TextEncoder().encode(`${header}.${payload}`);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    fixture.privateKey,
    signingInput,
  );
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

function targetUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function makeFixture(): Promise<RoundtripFixture> {
  const tag = crypto.randomUUID().replaceAll("-", "");
  const tokenIssuedAt = Math.floor(Date.now() / 1000) - 5;
  const tokenExpiresAt = tokenIssuedAt + 3600;
  const owner = await signingFixture(`owner-${tag}`);
  const mcp = await signingFixture(`mcp-${tag}`);
  const ownerJwksPort = 30000 + (Number.parseInt(tag.slice(0, 6), 16) % 30000);
  const ownerJwksUrl = `http://127.0.0.1:${ownerJwksPort}/cdn-cgi/access/certs`;
  const mcpIssuer = `https://mcp-${tag}.cloudflareaccess.com`;
  const mcpAudience = `mcp-audience-${tag}`;
  const mcpHostname = `mcp-${tag}.example`;
  const deploymentGeneration = `diagnostic-roundtrip-${tag}`;
  const ownerSubject = `owner-${tag}`;
  const mcpSubject = `mcp-subject-${tag}`;
  const commonClaims = {
    exp: tokenExpiresAt,
    iat: tokenIssuedAt,
    type: "app",
  };
  const ownerToken = await sign(owner, {
    ...commonClaims,
    iss: OWNER_E2E_ISSUER,
    aud: [OWNER_E2E_AUDIENCE],
    sub: ownerSubject,
  });
  const mcpToken = await sign(mcp, {
    ...commonClaims,
    iss: mcpIssuer,
    aud: [mcpAudience],
    sub: mcpSubject,
  });
  const wrongAudienceToken = await sign(mcp, {
    ...commonClaims,
    iss: mcpIssuer,
    aud: [OWNER_E2E_AUDIENCE],
    sub: mcpSubject,
  });
  const environment = {
    ...runtime,
    ENVIRONMENT: "development",
    DEPLOYMENT_GENERATION: deploymentGeneration,
    AI_GATEWAY_REASONING_URL: "https://example.invalid/reasoning",
    AI_GATEWAY_RETRIEVAL_URL: "https://example.invalid/retrieval",
    ACCESS_TEAM_DOMAIN: OWNER_E2E_ISSUER,
    ACCESS_AUDIENCE: OWNER_E2E_AUDIENCE,
    ACCESS_TEST_JWKS_URL: ownerJwksUrl,
    ACCESS_SERVICE_PRINCIPALS: "",
    MCP_HOSTNAME: mcpHostname,
    MCP_ACCESS_TEAM_DOMAIN: mcpIssuer,
    MCP_ACCESS_AUDIENCE: mcpAudience,
    MCP_ACCESS_AUTH_PROFILE: "managed-oauth",
    MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: undefined,
    GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp",
  } as unknown as Env;
  return {
    tag,
    deploymentGeneration,
    ownerSubject,
    mcpSubject,
    ownerJwksUrl,
    owner,
    mcp,
    mcpIssuer,
    mcpAudience,
    mcpHostname,
    ownerToken,
    mcpToken,
    wrongAudienceToken,
    mcpTrace: `mcp-trace-${tag}`,
    tokenIssuedAt,
    tokenExpiresAt,
    environment,
  };
}

function ownerRequest(method: "GET" | "POST", token: string): Request {
  const headers = new Headers({
    "cf-access-jwt-assertion": token,
    origin: "https://research.example",
  });
  if (method === "POST") {
    headers.set("content-type", "application/json");
    headers.set("x-eliotr-csrf", "1");
  }
  return new Request("https://research.example/api/v1/system/mcp-diagnostics", {
    method,
    headers,
    ...(method === "POST" ? { body: "{}" } : {}),
  });
}

function mcpRequest(
  fixture: RoundtripFixture,
  token: string,
  message: Record<string, unknown>,
  origin?: string,
): Request {
  const headers = new Headers({
    "cf-access-jwt-assertion": token,
    "cf-ray": fixture.mcpTrace,
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18",
  });
  if (origin !== undefined) headers.set("origin", origin);
  return new Request(`https://${fixture.mcpHostname}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });
}

async function document(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function mcpToolCall(challenge: McpDiagnosticChallengeResult): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: MCP_CLIENT_DIAGNOSTIC_TOOL_NAME,
      arguments: {
        challenge_id: challenge.challenge_id,
        challenge_token: challenge.challenge_token,
      },
    },
  };
}

describe("default Worker MCP client diagnostic roundtrip", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("issues through owner Access, confirms through managed MCP, and replays from durable state", async () => {
    await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
    await applyD1Migrations(runtime.SEARCH_DB, runtime.SEARCH_MIGRATIONS);
    const fixture = await makeFixture();
    const mcpCertsUrl = `${fixture.mcpIssuer}/cdn-cgi/access/certs`;
    const jwksFetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = targetUrl(input);
      if (url === fixture.ownerJwksUrl) return jsonResponse({ keys: [fixture.owner.publicJwk] });
      if (url === mcpCertsUrl) return jsonResponse({ keys: [fixture.mcp.publicJwk] });
      throw new Error(`unexpected Access JWKS URL: ${url}`);
    });
    vi.stubGlobal("fetch", jwksFetch);
    const invoke = (request: Request): Promise<Response> => worker.fetch(
      request,
      fixture.environment,
      {} as ExecutionContext,
    );

    const issuedResponse = await invoke(ownerRequest("POST", fixture.ownerToken));
    const issuedDocument = await document(issuedResponse);
    expect(issuedResponse.status, JSON.stringify(issuedDocument)).toBe(201);
    const issued = issuedDocument.data as McpDiagnosticChallengeResult;
    expect(issued).toMatchObject({
      protocol: MCP_DIAGNOSTIC_PROTOCOL,
      status: "ISSUED",
      auth_profile: "managed-oauth",
      deployment_generation: fixture.deploymentGeneration,
    });
    expect(typeof issued.challenge_token).toBe("string");

    const initializeResponse = await invoke(mcpRequest(fixture, fixture.mcpToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "eliotr-roundtrip-test", version: "1" },
      },
    }));
    const initializeDocument = await document(initializeResponse);
    expect(initializeResponse.status, JSON.stringify(initializeDocument)).toBe(200);
    expect(initializeDocument).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18" },
    });

    const listResponse = await invoke(mcpRequest(fixture, fixture.mcpToken, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    }));
    const listDocument = await document(listResponse);
    expect(listResponse.status, JSON.stringify(listDocument)).toBe(200);
    const listedTools = ((listDocument.result as { tools: readonly { name: string }[] }).tools ?? [])
      .map((tool) => tool.name);
    expect(listedTools).toContain(MCP_CLIENT_DIAGNOSTIC_TOOL_NAME);

    const deniedAudienceResponse = await invoke(mcpRequest(fixture, fixture.wrongAudienceToken, mcpToolCall(issued)));
    const deniedAudienceDocument = await document(deniedAudienceResponse);
    expect(deniedAudienceResponse.status, JSON.stringify(deniedAudienceDocument)).toBe(401);
    expect(deniedAudienceDocument).toMatchObject({
      protocol: "eliotr.mcp.http-error.v1",
      code: "MCP_AUTHENTICATION_FAILED",
    });

    const browserResponse = await invoke(mcpRequest(
      fixture,
      fixture.mcpToken,
      mcpToolCall(issued),
      "https://browser.example",
    ));
    const browserDocument = await document(browserResponse);
    expect(browserResponse.status, JSON.stringify(browserDocument)).toBe(403);
    expect(browserDocument).toMatchObject({
      protocol: "eliotr.mcp.http-error.v1",
      code: "MCP_BROWSER_ORIGIN_DENIED",
    });

    const beforeResponse = await invoke(ownerRequest("GET", fixture.ownerToken));
    const beforeDocument = await document(beforeResponse);
    expect(beforeResponse.status, JSON.stringify(beforeDocument)).toBe(200);
    expect(beforeDocument.data).toMatchObject({ status: "ISSUED", challenge_id: issued.challenge_id });

    const consumeResponse = await invoke(mcpRequest(fixture, fixture.mcpToken, mcpToolCall(issued)));
    const consumeDocument = await document(consumeResponse);
    expect(consumeResponse.status, JSON.stringify(consumeDocument)).toBe(200);
    const consumeResult = (consumeDocument.result as { structuredContent: Record<string, unknown>; isError: boolean });
    expect(consumeResult.isError).toBe(false);
    expect(consumeResult.structuredContent).toMatchObject({
      protocol: MCP_DIAGNOSTIC_PROTOCOL,
      status: "CONFIRMED",
      challenge_id: issued.challenge_id,
      auth_profile: "managed-oauth",
      deployment_generation: fixture.deploymentGeneration,
      trace_id: fixture.mcpTrace,
    });
    expect(JSON.stringify(consumeDocument).includes(issued.challenge_token)).toBe(false);
    expect(JSON.stringify(consumeDocument).includes(fixture.mcpSubject)).toBe(false);

    const row = await runtime.CORE_DB.prepare(
      "SELECT state,owner_principal_ref,auth_profile,deployment_generation,verified_actor_ref,verified_credential_generation,verified_authentication_method,verified_expires_at,trace_id,observation_ref FROM mcp_client_diagnostic_challenge WHERE challenge_id=?1",
    ).bind(issued.challenge_id).first<{
      readonly state: string;
      readonly owner_principal_ref: string;
      readonly auth_profile: string;
      readonly deployment_generation: string;
      readonly verified_actor_ref: string;
      readonly verified_credential_generation: string;
      readonly verified_authentication_method: string;
      readonly verified_expires_at: string;
      readonly trace_id: string;
      readonly observation_ref: string;
    }>();
    expect(row).toMatchObject({
      state: "CONFIRMED",
      owner_principal_ref: fixture.ownerSubject,
      auth_profile: "managed-oauth",
      deployment_generation: fixture.deploymentGeneration,
      verified_credential_generation: `cf-access-jwt:${fixture.mcp.kid}:${fixture.tokenIssuedAt}`,
      verified_authentication_method: "cloudflare_access",
      verified_expires_at: new Date(fixture.tokenExpiresAt * 1000).toISOString(),
      trace_id: fixture.mcpTrace,
    });
    expect(row?.verified_actor_ref).toMatch(/^mcp-actor-[a-f0-9]{64}$/u);
    expect(row?.verified_actor_ref).not.toBe(fixture.ownerSubject);
    expect(row?.observation_ref).toMatch(/^mcp-diagnostic-observation-/u);

    const confirmedResponse = await invoke(ownerRequest("GET", fixture.ownerToken));
    const confirmedDocument = await document(confirmedResponse);
    expect(confirmedResponse.status, JSON.stringify(confirmedDocument)).toBe(200);
    const confirmed = confirmedDocument.data as McpDiagnosticLatestStatus;
    expect(confirmed).toMatchObject({
      protocol: MCP_DIAGNOSTIC_PROTOCOL,
      status: "CONFIRMED",
      challenge_id: issued.challenge_id,
      auth_profile: "managed-oauth",
      deployment_generation: fixture.deploymentGeneration,
      observation_ref: row?.observation_ref,
      trace_id: fixture.mcpTrace,
    });
    expect(JSON.stringify(confirmedDocument)).not.toContain(issued.challenge_token);
    expect(JSON.stringify(confirmedDocument)).not.toContain(fixture.ownerSubject);
    expect(JSON.stringify(confirmedDocument)).not.toContain(fixture.mcpSubject);
    expect(confirmed).not.toHaveProperty("verified_actor_ref");
    expect(confirmed).not.toHaveProperty("verified_credential_generation");
    expect(confirmed).not.toHaveProperty("verified_authentication_method");

    const replayResponse = await invoke(mcpRequest(fixture, fixture.mcpToken, mcpToolCall(issued)));
    const replayDocument = await document(replayResponse);
    expect(replayResponse.status, JSON.stringify(replayDocument)).toBe(200);
    const replayResult = replayDocument.result as { structuredContent: Record<string, unknown>; isError: boolean };
    expect(replayResult.isError).toBe(true);
    expect(replayResult.structuredContent).toMatchObject({
      protocol: "eliotr.mcp.tool-error.v1",
      code: "MCP_CLIENT_DIAGNOSTIC_CHALLENGE_REPLAY",
      canonical_eliot_state_changed: false,
    });
    expect(JSON.stringify(replayDocument)).not.toContain(issued.challenge_token);
    expect(await runtime.CORE_DB.prepare(
      "SELECT COUNT(*) AS count FROM mcp_client_diagnostic_challenge WHERE owner_principal_ref=?1",
    ).bind(fixture.ownerSubject).first<number>("count")).toBe(1);
  }, 30_000);

  it("uses the legacy service-token profile when omitted and does not advertise diagnostics", async () => {
    await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
    await applyD1Migrations(runtime.SEARCH_DB, runtime.SEARCH_MIGRATIONS);
    const fixture = await makeFixture();
    const serviceClientId = `service-${fixture.tag}.access`;
    const serviceToken = await sign(fixture.mcp, {
      exp: fixture.tokenExpiresAt,
      iat: fixture.tokenIssuedAt,
      type: "app",
      iss: fixture.mcpIssuer,
      aud: [fixture.mcpAudience],
      sub: "",
      common_name: serviceClientId,
    });
    const legacyEnvironment = {
      ...fixture.environment,
      MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: serviceClientId,
    } as { -readonly [Key in keyof Env]?: Env[Key] } & Record<string, unknown>;
    delete legacyEnvironment.MCP_ACCESS_AUTH_PROFILE;
    expect(Object.hasOwn(legacyEnvironment, "MCP_ACCESS_AUTH_PROFILE")).toBe(false);

    const mcpCertsUrl = `${fixture.mcpIssuer}/cdn-cgi/access/certs`;
    const jwksFetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = targetUrl(input);
      if (url === mcpCertsUrl) return jsonResponse({ keys: [fixture.mcp.publicJwk] });
      throw new Error(`unexpected Access JWKS URL: ${url}`);
    });
    vi.stubGlobal("fetch", jwksFetch);
    const invoke = (request: Request): Promise<Response> => worker.fetch(
      request,
      legacyEnvironment as unknown as Env,
      {} as ExecutionContext,
    );
    const beforeRows = await runtime.CORE_DB.prepare(
      "SELECT COUNT(*) AS count FROM mcp_client_diagnostic_challenge WHERE owner_principal_ref=?1",
    ).bind(serviceClientId).first<number>("count");
    expect(beforeRows).toBe(0);

    const listResponse = await invoke(mcpRequest(fixture, serviceToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    }));
    const listDocument = await document(listResponse);
    expect(listResponse.status, JSON.stringify(listDocument)).toBe(200);
    const listedTools = ((listDocument.result as { tools: readonly { name: string }[] }).tools ?? [])
      .map((tool) => tool.name);
    expect(listedTools).not.toContain(MCP_CLIENT_DIAGNOSTIC_TOOL_NAME);
    const afterRows = await runtime.CORE_DB.prepare(
      "SELECT COUNT(*) AS count FROM mcp_client_diagnostic_challenge WHERE owner_principal_ref=?1",
    ).bind(serviceClientId).first<number>("count");
    expect(afterRows).toBe(0);
  }, 30_000);
});
