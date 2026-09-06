import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { handleHttp } from "../src/http.js";
import { db, runtime, setupOrientationDatabase, verifier } from "./orientation-fixture.js";

beforeAll(setupOrientationDatabase);

const ORIGIN = "https://research.example";
const BEGIN_PATH = "/api/v1/google/oauth/begin";

function keyBytes(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...raw));
}

function googleEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    ...runtime,
    ENVIRONMENT: "production",
    DEPLOYMENT_GENERATION: "test-generation",
    GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "client-secret-value",
    GOOGLE_TOKEN_ENCRYPTION_KEY: keyBytes(),
    GOOGLE_TOKEN_KEY_VERSION: "1",
    GOOGLE_OAUTH_CONNECTION_ID: "connection-g1",
    GOOGLE_OAUTH_REDIRECT_URI: "https://research.example/oauth/google/callback",
    GOOGLE_OAUTH_GOOGLE_SUBJECT: "123456789",
    GOOGLE_OAUTH_GOOGLE_EMAIL: "exchange@example.com",
    GOOGLE_OAUTH_PRODUCTION_EVIDENCE_REF: "operator-attestation-1",
    ...overrides,
  };
}

function beginRequest(
  body: unknown,
  init: { origin?: string | null; csrf?: boolean; method?: string; contentType?: string } = {},
): Request {
  const { origin = ORIGIN, csrf = true, method = "POST", contentType = "application/json" } = init;
  const headers: Record<string, string> = {};
  if (contentType !== "") headers["content-type"] = contentType;
  if (origin !== null) headers["origin"] = origin;
  if (csrf) headers["x-eliotr-csrf"] = "1";
  if (method === "GET" || method === "HEAD") {
    return new Request(`${ORIGIN}${BEGIN_PATH}`, { method, headers });
  }
  return new Request(`${ORIGIN}${BEGIN_PATH}`, {
    method,
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function post(
  body: unknown,
  options: {
    owner?: string;
    method?: "cloudflare_access" | "service_token";
    env?: ReturnType<typeof googleEnv>;
    requestInit?: Parameters<typeof beginRequest>[1];
    verifierOverride?: { verify: (request: Request) => Promise<never> } | ReturnType<typeof verifier>;
  } = {},
) {
  const auth = options.verifierOverride ?? verifier(options.owner ?? "g1-owner", options.method ?? "cloudflare_access");
  const response = await handleHttp(
    beginRequest(body, options.requestInit),
    (options.env ?? googleEnv()) as typeof runtime,
    {} as ExecutionContext,
    { accessVerifier: auth as never },
  );
  const document = (await response.json()) as Record<string, unknown>;
  return { response, document };
}

const intentCount = async (owner: string, operation?: string) => {
  const row = operation === undefined
    ? await db.prepare("SELECT COUNT(*) AS n FROM google_oauth_intent WHERE principal_id=?1").bind(owner).first<{ n: number }>()
    : await db.prepare("SELECT COUNT(*) AS n FROM google_oauth_intent WHERE principal_id=?1 AND operation_ref=?2").bind(owner, operation).first<{ n: number }>();
  return row?.n ?? -1;
};
const credentialCount = async () =>
  (await db.prepare("SELECT COUNT(*) AS n FROM google_exchange_connection").bind().first<{ n: number }>())?.n ?? -1;
const generationCount = async () =>
  (await db.prepare("SELECT COUNT(*) AS n FROM exchange_generation").bind().first<{ n: number }>())?.n ?? -1;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("unexpected provider call", { status: 500 })));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("G1 owner-only Google OAuth begin over real HTTP/D1/crypto", () => {
  it("admits a pending intent and returns a stable start receipt without provider or credential effects", async () => {
    const before = { credentials: await credentialCount(), generations: await generationCount() };
    const { response, document } = await post({ operation_ref: "g1-happy" }, { owner: "g1-happy-owner" });
    expect(response.status, JSON.stringify(document)).toBe(200);
    const data = document.data as Record<string, unknown>;
    expect(data.protocol).toBe("eliotr.google-oauth-start.v1");
    expect(typeof data.intent_id).toBe("string");
    const url = new URL(data.authorization_url as string);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe("test-client.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe("https://research.example/oauth/google/callback");
    expect(url.searchParams.get("login_hint")).toBe("exchange@example.com");
    const skew = Date.parse(data.expires_at as string) - Date.now();
    expect(skew).toBeGreaterThan(590000);
    expect(skew).toBeLessThanOrEqual(600000);
    expect(await intentCount("g1-happy-owner", "g1-happy")).toBe(1);
    expect(await credentialCount()).toBe(before.credentials);
    expect(await generationCount()).toBe(before.generations);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    const serialized = JSON.stringify(document);
    for (const secret of ["client-secret-value", "refresh", "access-fixture", "code-fixture"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("replays the same operation_ref to the identical pending receipt after a lost response", async () => {
    const env = googleEnv();
    const first = await post({ operation_ref: "g1-lost" }, { owner: "g1-lost-owner", env: env as never });
    expect(first.response.status).toBe(200);
    const second = await post({ operation_ref: "g1-lost" }, { owner: "g1-lost-owner", env: env as never });
    expect(second.response.status).toBe(200);
    expect(second.document.data).toEqual(first.document.data);
    expect(await intentCount("g1-lost-owner", "g1-lost")).toBe(1);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("allows only one intent among concurrent begins with the same operation_ref", async () => {
    const env = googleEnv();
    const auth = verifier("g1-race-owner");
    const outcomes = await Promise.all([
      post({ operation_ref: "g1-race" }, { owner: "g1-race-owner", env: env as never, verifierOverride: auth as never }),
      post({ operation_ref: "g1-race" }, { owner: "g1-race-owner", env: env as never, verifierOverride: auth as never }),
    ]);
    for (const outcome of outcomes) expect(outcome.response.status).toBe(200);
    expect(outcomes[0]?.document.data).toEqual(outcomes[1]?.document.data);
    expect(await intentCount("g1-race-owner", "g1-race")).toBe(1);
  });

  it("isolates the same operation_ref between different owners", async () => {
    const first = await post({ operation_ref: "g1-shared-op" }, { owner: "g1-owner-a" });
    const second = await post({ operation_ref: "g1-shared-op" }, { owner: "g1-owner-b" });
    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    expect((first.document.data as { intent_id: string }).intent_id).not.toBe(
      (second.document.data as { intent_id: string }).intent_id,
    );
  });

  it("rejects forged owner/session/config body fields with zero durable effects", async () => {
    for (const body of [
      { operation_ref: "g1-forged-1", principal_id: "attacker" },
      { operation_ref: "g1-forged-2", session_generation: "attacker-session" },
      { operation_ref: "g1-forged-3", configuration: { connection_id: "attacker" } },
      { operation_ref: "g1-forged-4", oauth_client_id: "attacker.apps.googleusercontent.com" },
    ]) {
      const { response, document } = await post(body, { owner: "g1-forged-owner" });
      expect(response.status, JSON.stringify(document)).toBe(400);
      expect(await intentCount("g1-forged-owner")).toBe(0);
    }
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("denies service principals on the owner-only begin route", async () => {
    const { response, document } = await post({ operation_ref: "g1-service" }, { owner: "g1-service-client", method: "service_token" });
    expect(response.status).toBe(403);
    expect(document.code).toBe("PRINCIPAL_CLASS_DENIED");
    expect(await intentCount("g1-service-client")).toBe(0);
  });

  it("enforces same-origin and CSRF before any durable effect", async () => {
    const missing = await post({ operation_ref: "g1-csrf-1" }, { owner: "g1-csrf-owner", requestInit: { origin: null } });
    expect(missing.response.status).toBe(400);
    const wrong = await post({ operation_ref: "g1-csrf-2" }, { owner: "g1-csrf-owner", requestInit: { origin: "https://evil.example" } });
    expect(wrong.response.status).toBe(403);
    const noToken = await post({ operation_ref: "g1-csrf-3" }, { owner: "g1-csrf-owner", requestInit: { csrf: false } });
    expect(noToken.response.status).toBe(400);
    const wrongToken = await handleHttp(
      new Request(`${ORIGIN}${BEGIN_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, "x-eliotr-csrf": "0" },
        body: JSON.stringify({ operation_ref: "g1-csrf-4" }),
      }),
      googleEnv() as never,
      {} as ExecutionContext,
      { accessVerifier: verifier("g1-csrf-owner") as never },
    );
    expect(wrongToken.status).toBe(400);
    expect(await intentCount("g1-csrf-owner")).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("rejects unknown and maximum+1 body fields", async () => {
    for (const body of [
      { operation_ref: "g1-shape-1", extra: true },
      { operation_ref: "x".repeat(257) },
      { operation_ref: "" },
      { operation_ref: 42 },
      {},
      { operation_ref: ["g1-shape-2"] },
    ]) {
      const { response } = await post(body, { owner: "g1-shape-owner" });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const malformed = await post("{not json", { owner: "g1-shape-owner", requestInit: { contentType: "application/json" } });
    expect(malformed.response.status).toBe(400);
    const wrongMethod = await post({ operation_ref: "g1-shape-get" }, { owner: "g1-shape-owner", requestInit: { method: "GET" } });
    expect([404, 405]).toContain(wrongMethod.response.status);
    expect(await intentCount("g1-shape-owner")).toBe(0);
  });

  it("rejects unknown query parameters before intent creation with zero rows", async () => {
    const owner = "g1-query-unknown-owner";
    const auth = verifier(owner);
    for (const query of ["?unknown=1", "?operation_ref=g1-query-unknown&extra=1", "?%00=1"]) {
      const response = await handleHttp(
        new Request(`${ORIGIN}${BEGIN_PATH}${query}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN, "x-eliotr-csrf": "1" },
          body: JSON.stringify({ operation_ref: "g1-query-unknown" }),
        }),
        googleEnv() as never,
        {} as ExecutionContext,
        { accessVerifier: auth as never },
      );
      const document = (await response.json()) as Record<string, unknown>;
      expect(response.status, `${query}: ${JSON.stringify(document)}`).toBe(400);
      expect(document.code).toBe("UNKNOWN_QUERY_PARAMETER");
    }
    expect(await intentCount(owner)).toBe(0);
    expect(await intentCount(owner, "g1-query-unknown")).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("rejects duplicate query parameters before intent creation with zero rows", async () => {
    const owner = "g1-query-duplicate-owner";
    const auth = verifier(owner);
    for (const query of ["?a=1&a=2", "?operation_ref=x&operation_ref=y", "?x=1&x=1"]) {
      const response = await handleHttp(
        new Request(`${ORIGIN}${BEGIN_PATH}${query}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN, "x-eliotr-csrf": "1" },
          body: JSON.stringify({ operation_ref: "g1-query-duplicate" }),
        }),
        googleEnv() as never,
        {} as ExecutionContext,
        { accessVerifier: auth as never },
      );
      const document = (await response.json()) as Record<string, unknown>;
      expect(response.status, `${query}: ${JSON.stringify(document)}`).toBe(400);
      expect(document.code).toBe("UNKNOWN_QUERY_PARAMETER");
    }
    expect(await intentCount(owner)).toBe(0);
    expect(await intentCount(owner, "g1-query-duplicate")).toBe(0);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("fails closed without durable effects when server config or Production attestation is invalid", async () => {
    const cases: Record<string, string | undefined>[] = [
      { GOOGLE_CLIENT_ID: undefined },
      { GOOGLE_CLIENT_SECRET: undefined },
      { GOOGLE_TOKEN_ENCRYPTION_KEY: undefined },
      { GOOGLE_TOKEN_ENCRYPTION_KEY: "short" },
      { GOOGLE_OAUTH_CONNECTION_ID: undefined },
      { GOOGLE_OAUTH_REDIRECT_URI: "http://research.example/oauth/google/callback" },
      { GOOGLE_OAUTH_REDIRECT_URI: "https://attacker.example/callback" },
      { GOOGLE_OAUTH_GOOGLE_SUBJECT: undefined },
      { GOOGLE_OAUTH_GOOGLE_EMAIL: "not-an-email" },
      { GOOGLE_OAUTH_PRODUCTION_EVIDENCE_REF: undefined },
      { GOOGLE_OAUTH_PRODUCTION_EVIDENCE_REF: "" },
    ];
    let index = 0;
    for (const patch of cases) {
      index += 1;
      const owner = `g1-config-owner-${index}`;
      const { response, document } = await post({ operation_ref: `g1-config-${index}` }, { owner, env: googleEnv(patch) as never });
      expect(response.status, `${index}: ${JSON.stringify(document)}`).toBe(503);
      expect(await intentCount(owner)).toBe(0);
    }
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("rejects a revoked owner session rechecked after authentication", async () => {
    let calls = 0;
    const flapping = {
      async verify() {
        calls += 1;
        if (calls > 1) {
          const { AccessVerificationError } = await import("@eliotr/platform-cloudflare");
          throw new AccessVerificationError("ACCESS_JWT_EXPIRED", "owner session revoked", false);
        }
        return {
          principal_ref: "g1-revoked-owner",
          credential_generation: "credential-v1",
          authentication_method: "cloudflare_access",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        } as const;
      },
    };
    const { response, document } = await post({ operation_ref: "g1-revoked" }, { owner: "g1-revoked-owner", verifierOverride: flapping as never });
    expect(response.status, JSON.stringify(document)).toBe(401);
    expect(await intentCount("g1-revoked-owner", "g1-revoked")).toBe(0);
  });

  it("caps unexpired pending intents per owner", async () => {
    const owner = "g1-cap-owner";
    const env = googleEnv();
    for (let index = 0; index < 16; index += 1) {
      const { response } = await post({ operation_ref: `g1-cap-${index}` }, { owner, env: env as never });
      expect(response.status).toBe(200);
    }
    const overflow = await post({ operation_ref: "g1-cap-overflow" }, { owner, env: env as never });
    expect(overflow.response.status).toBe(409);
    expect(await intentCount(owner)).toBe(16);
  });

  it("persists only digests and ciphertext, never proof secrets", async () => {
    const { response, document } = await post({ operation_ref: "g1-secrets" }, { owner: "g1-secrets-owner" });
    expect(response.status).toBe(200);
    const data = document.data as { authorization_url: string };
    const state = new URL(data.authorization_url).searchParams.get("state") ?? "";
    const row = await db
      .prepare("SELECT * FROM google_oauth_intent WHERE principal_id=?1 AND operation_ref=?2")
      .bind("g1-secrets-owner", "g1-secrets")
      .first<Record<string, unknown>>();
    expect(row).toBeDefined();
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(state);
    expect(serialized).not.toContain("client-secret-value");
    for (const secret of ["refresh", "access-fixture", "code-fixture"]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
