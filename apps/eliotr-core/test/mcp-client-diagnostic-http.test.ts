import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AccessVerifier } from "@eliotr/cloudflare-access";
import type { Env } from "../src/env.js";
import { handleHttp } from "../src/http.js";

const runtime = env as unknown as Env & {
  readonly CORE_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
  readonly SEARCH_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};
const ORIGIN = "https://research.example";
const PATH = "/api/v1/system/mcp-diagnostics";

async function prepareDatabase(): Promise<void> {
  await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
  await applyD1Migrations(runtime.SEARCH_DB, runtime.SEARCH_MIGRATIONS);
}

function environment(overrides: Partial<Env> = {}): Env {
  return {
    ...runtime,
    ENVIRONMENT: "development",
    DEPLOYMENT_GENERATION: "diagnostic-http-generation",
    MCP_ACCESS_AUTH_PROFILE: "managed-oauth",
    ...overrides,
  } as Env;
}

function verifier(
  principalRef: string,
  method: "cloudflare_access" | "service_token" = "cloudflare_access",
): AccessVerifier {
  return {
    async verify() {
      return {
        principal_ref: principalRef,
        credential_generation: `owner-credential-${principalRef}`,
        authentication_method: method,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      };
    },
  };
}

function request(
  method: "GET" | "POST",
  options: {
    readonly query?: string;
    readonly origin?: string | null;
    readonly csrf?: string;
    readonly body?: unknown;
  } = {},
): Request {
  const headers = new Headers();
  if (options.origin !== null) headers.set("origin", options.origin ?? ORIGIN);
  if (options.csrf !== undefined) headers.set("x-eliotr-csrf", options.csrf);
  if (method === "POST") {
    headers.set("content-type", "application/json");
    return new Request(`${ORIGIN}${PATH}${options.query ?? ""}`, {
      method,
      headers,
      body: JSON.stringify(options.body ?? {}),
    });
  }
  return new Request(`${ORIGIN}${PATH}${options.query ?? ""}`, { method, headers });
}

async function call(
  method: "GET" | "POST",
  owner: string,
  options: Parameters<typeof request>[1] = {},
  env: Env = environment(),
  methodAuth: "cloudflare_access" | "service_token" = "cloudflare_access",
): Promise<{ readonly response: Response; readonly document: Record<string, unknown> }> {
  const response = await handleHttp(
    request(method, options),
    env,
    {} as ExecutionContext,
    { accessVerifier: verifier(owner, methodAuth) },
  );
  return { response, document: await response.json() as Record<string, unknown> };
}

async function diagnosticCount(owner?: string): Promise<number> {
  const row = owner === undefined
    ? await runtime.CORE_DB.prepare("SELECT COUNT(*) AS count FROM mcp_client_diagnostic_challenge").first<{ readonly count: number }>()
    : await runtime.CORE_DB.prepare("SELECT COUNT(*) AS count FROM mcp_client_diagnostic_challenge WHERE owner_principal_ref=?1").bind(owner).first<{ readonly count: number }>();
  return row?.count ?? -1;
}

function data(document: Record<string, unknown>): Record<string, unknown> {
  return document.data as Record<string, unknown>;
}

describe("owner MCP client diagnostic HTTP routes", () => {
  it("issues an owner challenge and returns a token-free latest read", async () => {
    await prepareDatabase();
    const owner = `http-owner-${crypto.randomUUID()}`;
    const issued = await call("POST", owner, { csrf: "1", body: {} });
    expect(issued.response.status, JSON.stringify(issued.document)).toBe(201);
    const issuedData = data(issued.document);
    expect(issuedData).toMatchObject({
      protocol: "eliotr.mcp.client-diagnostic.v1",
      status: "ISSUED",
      auth_profile: "managed-oauth",
      deployment_generation: "diagnostic-http-generation",
    });
    expect(typeof issuedData.challenge_token).toBe("string");

    const latest = await call("GET", owner, { csrf: "1" });
    expect(latest.response.status, JSON.stringify(latest.document)).toBe(200);
    expect(data(latest.document)).toMatchObject({
      status: "ISSUED",
      challenge_id: issuedData.challenge_id,
    });
    expect(latest.document).not.toHaveProperty("challenge_token");
    expect(JSON.stringify(latest.document)).not.toContain(String(issuedData.challenge_token));

    const browserLatest = await call("GET", owner, { origin: null });
    expect(browserLatest.response.status, JSON.stringify(browserLatest.document)).toBe(200);
    expect(data(browserLatest.document)).toMatchObject({
      status: "ISSUED",
      challenge_id: issuedData.challenge_id,
    });
    expect(await diagnosticCount(owner)).toBe(1);
  });

  it("denies service principals and all malformed or cross-origin owner inputs before a row", async () => {
    await prepareDatabase();
    const serviceOwner = `http-service-${crypto.randomUUID()}`;
    const denied = await call("POST", serviceOwner, { csrf: "1", body: {} }, environment(), "service_token");
    expect(denied.response.status).toBe(403);
    expect(denied.document).toMatchObject({ code: "PRINCIPAL_CLASS_DENIED" });
    expect(await diagnosticCount(serviceOwner)).toBe(0);

    const owner = `http-invalid-${crypto.randomUUID()}`;
    const foreignGet = await call("GET", owner, { origin: "https://evil.example" });
    expect(foreignGet.response.status).toBe(403);
    expect(foreignGet.document).toMatchObject({ code: "MCP_DIAGNOSTIC_ORIGIN_FORBIDDEN" });
    expect(await diagnosticCount(owner)).toBe(0);
    const cases = [
      { options: { query: "?unexpected=1", csrf: "1", body: {} }, code: "UNKNOWN_QUERY_PARAMETER" },
      { options: { csrf: "1", body: { unexpected: true } }, code: "MCP_DIAGNOSTIC_INPUT_INVALID" },
      { options: { body: {} }, code: "MCP_DIAGNOSTIC_CSRF_REQUIRED" },
      { options: { csrf: "1", origin: "https://evil.example", body: {} }, code: "MCP_DIAGNOSTIC_ORIGIN_FORBIDDEN" },
    ] as const;
    for (const item of cases) {
      const result = await call("POST", owner, item.options);
      expect(result.response.status, JSON.stringify(result.document)).toBeGreaterThanOrEqual(400);
      expect(result.document).toMatchObject({ code: item.code });
    }
    expect(await diagnosticCount(owner)).toBe(0);
  });

  it("requires an explicit selected MCP profile and keeps latest empty as typed 404", async () => {
    await prepareDatabase();
    const owner = `http-config-${crypto.randomUUID()}`;
    const missingEnvironment = { ...environment() } as { -readonly [Key in keyof Env]?: Env[Key] } & Record<string, unknown>;
    delete missingEnvironment.MCP_ACCESS_AUTH_PROFILE;
    const missing = await call("POST", owner, { csrf: "1", body: {} }, missingEnvironment as unknown as Env);
    expect(missing.response.status).toBe(503);
    expect(missing.document).toMatchObject({ code: "MCP_DIAGNOSTIC_CONFIG_INVALID", retryable: true });
    expect(await diagnosticCount(owner)).toBe(0);

    const malformed = await call("GET", owner, { csrf: "1" }, environment({ MCP_ACCESS_AUTH_PROFILE: "hybrid" as never }));
    expect(malformed.response.status).toBe(503);
    expect(malformed.document).toMatchObject({ code: "MCP_DIAGNOSTIC_CONFIG_INVALID", retryable: true });
    expect(await diagnosticCount(owner)).toBe(0);

    const empty = await call("GET", `http-empty-${crypto.randomUUID()}`, { csrf: "1" });
    expect(empty.response.status).toBe(404);
    expect(empty.document).toMatchObject({ code: "MCP_DIAGNOSTIC_CHALLENGE_NOT_FOUND" });
  });
});
