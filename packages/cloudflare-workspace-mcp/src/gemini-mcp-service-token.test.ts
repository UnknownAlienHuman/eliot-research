import { createCloudflareAccessVerifier, type AccessVerifier } from "@eliotr/cloudflare-access";
import { describe, expect, it } from "vitest";
import { authenticatedContext, handleGeminiMcp, type WorkspaceMcpRuntime } from "./gemini-mcp.js";

const CLIENT_ID = "00000000000000000000000000000000.access";
const TEAM_DOMAIN = "https://team-example.cloudflareaccess.com";
const MANAGED_AUDIENCE = "managed-mcp-audience";
const NOW_MS = Date.parse("2026-09-04T13:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function encodeJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function signedFixture() {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const publicJwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "mcp-kid", alg: "RS256", use: "sig", key_ops: ["verify"] };
  async function sign(subject: string, audience: string, commonName?: string): Promise<string> {
    const header = encodeJson({ alg: "RS256", kid: "mcp-kid", typ: "JWT" });
    const payload = encodeJson({ iss: TEAM_DOMAIN, aud: [audience], sub: subject, exp: NOW_SECONDS + 600,
      iat: NOW_SECONDS - 10, type: "app", ...(commonName === undefined ? {} : { common_name: commonName }) });
    const input = new TextEncoder().encode(`${header}.${payload}`);
    const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, pair.privateKey, input);
    return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
  }
  return { publicJwk, sign };
}

function signedVerifier(publicJwk: JsonWebKey, audience: string, allowedServiceNames?: readonly string[]): AccessVerifier {
  return createCloudflareAccessVerifier({ team_domain: TEAM_DOMAIN, audience,
    ...(allowedServiceNames === undefined ? {} : { allowed_service_principal_common_names: allowedServiceNames }) }, {
    now: () => NOW_MS,
    fetch: async () => new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { "content-type": "application/json" } }),
  });
}

function environment(clientId: string = CLIENT_ID): WorkspaceMcpRuntime {
  return {
    ENVIRONMENT: "development",
    DEPLOYMENT_GENERATION: "generation-1",
    GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp",
    MCP_HOSTNAME: "mcp.example",
    MCP_ACCESS_TEAM_DOMAIN: "https://team-example.cloudflareaccess.com",
    MCP_ACCESS_AUDIENCE: "mcp-audience",
    MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: clientId,
    readReadiness: async () => ({ ready: true, blocking_reason_codes: [] }),
  };
}

function managedEnvironment(audience = "managed-mcp-audience"): WorkspaceMcpRuntime {
  return {
    ENVIRONMENT: "development",
    DEPLOYMENT_GENERATION: "generation-1",
    GOOGLE_EXTERNAL_TRANSPORT: "gemini-mcp",
    MCP_HOSTNAME: "mcp.example",
    MCP_ACCESS_AUTH_PROFILE: "managed-oauth",
    MCP_ACCESS_TEAM_DOMAIN: "https://team-example.cloudflareaccess.com",
    MCP_ACCESS_AUDIENCE: audience,
    ACCESS_AUDIENCE: "ordinary-api-audience",
    readReadiness: async () => ({ ready: true, blocking_reason_codes: [] }),
  };
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

function requestWithToken(token: string): Request {
  const input = request();
  input.headers.set("cf-access-jwt-assertion", token);
  return input;
}

function toolRequest(name: string, args: Record<string, unknown>, token?: string): Request {
  const headers = new Headers({
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18",
  });
  if (token !== undefined) headers.set("cf-access-jwt-assertion", token);
  return new Request("https://mcp.example/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
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
  it("preserves the verified service-token identity beside the compatibility actor", async () => {
    const result = await authenticatedContext({
      principal_ref: CLIENT_ID,
      credential_generation: "service-credential-7",
      authentication_method: "service_token",
      expires_at: "2026-09-04T14:00:00.000Z",
    }, "trace-service", "service-token", CLIENT_ID, TEAM_DOMAIN, "mcp-audience", "generation-7");
    expect(result).toMatchObject({
      principal_ref: "gemini-spark",
      trace_id: "trace-service",
      deployment_generation: "generation-7",
      verified_actor: {
        actor_ref: "gemini-spark",
        credential_generation: "service-credential-7",
        authentication_method: "service_token",
        expires_at: "2026-09-04T14:00:00.000Z",
        auth_profile: "service-token",
        deployment_generation: "generation-7",
      },
    });
    if (result instanceof Response) throw new Error("service identity was unexpectedly denied");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.verified_actor)).toBe(true);
  });

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

  it("preserves exact service-token Client ID compatibility through the signed verifier", async () => {
    const fixture = await signedFixture();
    const signed = signedVerifier(fixture.publicJwk, "mcp-audience", [CLIENT_ID]);
    const accepted = await handleGeminiMcp(
      requestWithToken(await fixture.sign("", "mcp-audience", CLIENT_ID)),
      environment(),
      {} as ExecutionContext,
      { accessVerifier: signed },
    );
    expect(accepted.status).toBe(200);

    const nameInsteadOfId = await handleGeminiMcp(
      requestWithToken(await fixture.sign("", "mcp-audience", "gemini-spark")),
      environment(),
      {} as ExecutionContext,
      { accessVerifier: signed },
    );
    expect(nameInsteadOfId.status).toBe(403);
    expect(await body(nameInsteadOfId)).toMatchObject({ code: "MCP_AUTHENTICATION_FAILED" });
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

describe("Gemini MCP managed-oauth profile", () => {
  function managedVerifier(subject: string, authenticationMethod: "cloudflare_access" | "service_token" = "cloudflare_access"): AccessVerifier {
    return {
      async verify() {
        return {
          principal_ref: subject,
          credential_generation: "managed-credential-1",
          authentication_method: authenticationMethod,
          expires_at: "2026-09-04T14:00:00.000Z",
        };
      },
    };
  }

  it("hashes the verified actor tuple into a stable, distinct, non-PII principal", async () => {
    const args = {
      google_product: "drive",
      action: "read",
      direction: "google_to_eliot_candidate",
      target_ref: "file-1",
      payload_sha256: "a".repeat(64),
    };
    const alice = await handleGeminiMcp(toolRequest("eliotr_create_google_sync_plan", args), managedEnvironment(), {} as ExecutionContext, {
      accessVerifier: managedVerifier("alice@example.com"),
    });
    const aliceRepeat = await handleGeminiMcp(toolRequest("eliotr_create_google_sync_plan", args), managedEnvironment(), {} as ExecutionContext, {
      accessVerifier: managedVerifier("alice@example.com"),
    });
    const bob = await handleGeminiMcp(toolRequest("eliotr_create_google_sync_plan", args), managedEnvironment(), {} as ExecutionContext, {
      accessVerifier: managedVerifier("bob@example.com"),
    });
    const aliceBody = await body(alice);
    const aliceRepeatBody = await body(aliceRepeat);
    const bobBody = await body(bob);
    const alicePlan = JSON.stringify(aliceBody);
    const bobPlan = JSON.stringify(bobBody);
    expect(alice.status).toBe(200);
    expect(aliceRepeat.status).toBe(200);
    expect(bob.status).toBe(200);
    expect(alicePlan).not.toContain("alice@example.com");
    expect(bobPlan).not.toContain("bob@example.com");
    expect(aliceBody).toMatchObject({ result: { structuredContent: { plan_id: expect.any(String) } } });
    expect(aliceRepeatBody).toMatchObject({ result: { structuredContent: { plan_id: expect.any(String) } } });
    expect(bobBody).toMatchObject({ result: { structuredContent: { plan_id: expect.any(String) } } });
    expect((aliceBody.result as { structuredContent: { plan_id: string } }).structuredContent.plan_id)
      .toBe((aliceRepeatBody.result as { structuredContent: { plan_id: string } }).structuredContent.plan_id);
    expect((aliceBody.result as { structuredContent: { plan_id: string } }).structuredContent.plan_id)
      .not.toBe((bobBody.result as { structuredContent: { plan_id: string } }).structuredContent.plan_id);
  });

  it("keeps the server-derived Workspace tool scope fixed after managed authentication", async () => {
    const listRequest = new Request("https://mcp.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const response = await handleGeminiMcp(listRequest, managedEnvironment(), {} as ExecutionContext, {
      accessVerifier: managedVerifier("alice@example.com"),
    });
    expect(response.status).toBe(200);
    const listedBody = await body(response);
    expect(JSON.stringify(listedBody)).not.toContain("eliotr_catalog");
    const catalog = await handleGeminiMcp(toolRequest("eliotr_catalog", {}), managedEnvironment(), {} as ExecutionContext, {
      accessVerifier: managedVerifier("alice@example.com"),
    });
    expect(catalog.status).toBe(200);
    expect(JSON.stringify(await body(catalog))).toContain("MCP_CATALOG_SCOPE_REQUIRED");
  });

  it("rejects a service-token JWT in the managed-oauth profile", async () => {
    const response = await handleGeminiMcp(request(), managedEnvironment(), {} as ExecutionContext, {
      accessVerifier: managedVerifier(CLIENT_ID, "service_token"),
    });
    expect(response.status).toBe(403);
    expect(await body(response)).toMatchObject({ code: "MCP_MANAGED_OAUTH_CREDENTIAL_DENIED" });
  });

  it("fails closed for a mixed profile or an unknown profile", async () => {
    const mixed = await handleGeminiMcp(request(), {
      ...managedEnvironment(),
      MCP_ACCESS_SERVICE_TOKEN_CLIENT_ID: CLIENT_ID,
    }, {} as ExecutionContext, { accessVerifier: managedVerifier("alice") });
    expect(mixed.status).toBe(503);
    expect(await body(mixed)).toMatchObject({ code: "MCP_CONFIGURATION_UNAVAILABLE" });

    const unknown = await handleGeminiMcp(request(), {
      ...managedEnvironment(), MCP_ACCESS_AUTH_PROFILE: "hybrid",
    }, {} as ExecutionContext, { accessVerifier: managedVerifier("alice") });
    expect(unknown.status).toBe(503);
    expect(await body(unknown)).toMatchObject({ code: "MCP_CONFIGURATION_UNAVAILABLE" });
  });

  it("requires a dedicated managed audience distinct from ordinary Access", async () => {
    const response = await handleGeminiMcp(request(), managedEnvironment("ordinary-api-audience"), {} as ExecutionContext, {
      accessVerifier: managedVerifier("alice"),
    });
    expect(response.status).toBe(503);
    expect(await body(response)).toMatchObject({ code: "MCP_CONFIGURATION_UNAVAILABLE" });
  });

  it("preserves managed credential evidence without exposing the verified subject", async () => {
    const result = await authenticatedContext({
      principal_ref: "alice@example.com",
      credential_generation: "managed-credential-9",
      authentication_method: "cloudflare_access",
      expires_at: "2026-09-04T14:00:00.000Z",
    }, "trace-managed", "managed-oauth", "", TEAM_DOMAIN, MANAGED_AUDIENCE, "generation-9");
    if (result instanceof Response) throw new Error("managed identity was unexpectedly denied");
    expect(result.verified_actor).toMatchObject({
      credential_generation: "managed-credential-9",
      authentication_method: "cloudflare_access",
      expires_at: "2026-09-04T14:00:00.000Z",
      auth_profile: "managed-oauth",
      deployment_generation: "generation-9",
    });
    expect(result.verified_actor?.actor_ref).toMatch(/^mcp-actor-[a-f0-9]{64}$/u);
    expect(result.verified_actor?.actor_ref).not.toContain("alice@example.com");
    expect(result.verified_actor?.actor_ref).toBe(result.principal_ref);
  });

  it("rejects an incomplete verifier identity before tool dispatch", async () => {
    const result = await authenticatedContext({
      principal_ref: "alice@example.com",
      authentication_method: "cloudflare_access",
    } as never, "trace-invalid", "managed-oauth", "", TEAM_DOMAIN, MANAGED_AUDIENCE, "generation-9");
    expect(result).toMatchObject({ status: 401 });
  });

  it("rejects outer whitespace and explicit ports in the configured Access team origin", async () => {
    for (const team of [" https://team-example.cloudflareaccess.com", "https://team-example.cloudflareaccess.com:8443"]) {
      const response = await handleGeminiMcp(request(), {
        ...managedEnvironment(), MCP_ACCESS_TEAM_DOMAIN: team,
      }, {} as ExecutionContext, { accessVerifier: managedVerifier("alice") });
      expect(response.status).toBe(503);
      expect(await body(response)).toMatchObject({ code: "MCP_CONFIGURATION_UNAVAILABLE" });
    }
  });

  it("uses the real signed Access verifier for two managed actors and rejects cross-actor replay", async () => {
    const fixture = await signedFixture();
    const verifier = signedVerifier(fixture.publicJwk, MANAGED_AUDIENCE);
    const aliceToken = await fixture.sign("alice@example.com", MANAGED_AUDIENCE);
    const bobToken = await fixture.sign("bob@example.com", MANAGED_AUDIENCE);
    const args = { google_product: "drive", action: "read", direction: "google_to_eliot_candidate",
      target_ref: "file-1", payload_sha256: "a".repeat(64) };
    const planned = await handleGeminiMcp(toolRequest("eliotr_create_google_sync_plan", args, aliceToken), managedEnvironment(), {} as ExecutionContext, { accessVerifier: verifier });
    expect(planned.status).toBe(200);
    const plannedBody = await body(planned);
    const plan = (plannedBody.result as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(JSON.stringify(plannedBody)).not.toContain("alice@example.com");
    const replay = await handleGeminiMcp(toolRequest("eliotr_validate_google_sync_receipt", {
      plan,
      receipt: { connector: "google-workspace", google_product: "drive", action: "read", resource_id: "file-1",
        observed_revision: "r1", observed_at: "2026-09-04T13:01:00.000Z", readback_performed: true,
        readback_payload_sha256: "a".repeat(64) },
    }, bobToken), managedEnvironment(), {} as ExecutionContext, { accessVerifier: verifier });
    expect(replay.status).toBe(200);
    expect(await body(replay)).toMatchObject({ result: { structuredContent: {
      disposition: "OBSERVED_MISMATCH", reason_codes: expect.arrayContaining(["PLAN_ID_MISMATCH"]),
      canonical_eliot_state_changed: false,
    } } });
  });

  it("rejects a wrong ordinary audience and owner JWT through the signed verifier", async () => {
    const fixture = await signedFixture();
    const verifier = signedVerifier(fixture.publicJwk, MANAGED_AUDIENCE);
    const wrongAudience = await fixture.sign("alice@example.com", "ordinary-api-audience");
    const deniedAudience = await handleGeminiMcp(requestWithToken(wrongAudience), managedEnvironment(), {} as ExecutionContext, { accessVerifier: verifier });
    expect(deniedAudience.status).toBe(401);
    const ownerToken = await fixture.sign("owner@example.com", "managed-mcp-audience");
    const deniedOwner = await handleGeminiMcp(requestWithToken(ownerToken), environment(), {} as ExecutionContext, { accessVerifier: signedVerifier(fixture.publicJwk, "managed-mcp-audience", [CLIENT_ID]) });
    expect(deniedOwner.status).toBe(403);
  });
});
