import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { handleHttp } from "../src/http.js";
import { db, runtime, setupOrientationDatabase, verifier } from "./orientation-fixture.js";
import { oauthTestClaims, oauthTestKeys, oauthTestTokenResponse } from "../../../packages/google-drive-exchange/src/oauth-test-fixture.js";

beforeAll(setupOrientationDatabase);

const ORIGIN = "https://research.example";
const BEGIN_PATH = "/api/v1/google/oauth/begin";
const CALLBACK_PATH = "/oauth/google/callback";
const RECONNECT_PATH = "/api/v1/google/oauth/reconnect";
const DISCONNECT_PATH = "/api/v1/google/connection/disconnect";

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
    GOOGLE_OAUTH_CONNECTION_ID: `connection-g2-${crypto.randomUUID()}`,
    GOOGLE_OAUTH_REDIRECT_URI: `${ORIGIN}${CALLBACK_PATH}`,
    GOOGLE_OAUTH_GOOGLE_SUBJECT: "123456789",
    GOOGLE_OAUTH_GOOGLE_EMAIL: "exchange@example.com",
    GOOGLE_OAUTH_PRODUCTION_EVIDENCE_REF: "operator-attestation-1",
    ...overrides,
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function begin(env: ReturnType<typeof googleEnv>, owner: string, operation: string) {
  const response = await handleHttp(new Request(`${ORIGIN}${BEGIN_PATH}`, {
    method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "x-eliotr-csrf": "1" },
    body: JSON.stringify({ operation_ref: operation }),
  }), env as never, {} as ExecutionContext, { accessVerifier: verifier(owner) as never });
  expect(response.status).toBe(200);
  const body = await json(response);
  const data = body.data as { authorization_url: string };
  const authorizationUrl = new URL(data.authorization_url);
  return { state: authorizationUrl.searchParams.get("state") ?? "", nonce: authorizationUrl.searchParams.get("nonce") ?? "", env };
}

function callbackRequest(query: string, signal?: AbortSignal): Request {
  return new Request(`${ORIGIN}${CALLBACK_PATH}?${query}`, { method: "GET", ...(signal ? { signal } : {}) });
}

function lifecycleRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers: {
    "content-type": "application/json", origin: ORIGIN, "x-eliotr-csrf": "1",
  }, body: JSON.stringify(body) });
}

describe("G2 owner-only Google OAuth callback over real HTTP/D1/crypto", () => {
  let callbackNonce = "N".repeat(43);
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        const token = await oauthTestKeys();
        const claims = await oauthTestClaims(callbackNonce, undefined, Math.floor(Date.now() / 1000) * 1000);
        return new Response(JSON.stringify(oauthTestTokenResponse(await token.sign(claims))), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (url === "https://www.googleapis.com/oauth2/v3/certs") {
        const token = await oauthTestKeys();
        return new Response(JSON.stringify({ keys: [token.jwk] }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected provider", { status: 500 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("finishes a begin intent through the real RSA/JWKS path and redirects without promoting AUTHORIZING", async () => {
    const env = googleEnv();
    const started = await begin(env, "g2-owner-happy", "g2-happy");
    callbackNonce = started.nonce;
    const response = await handleHttp(callbackRequest(`state=${started.state}&code=code-fixture&scope=openid%20email&authuser=0&prompt=consent`), env as never,
      {} as ExecutionContext, { accessVerifier: verifier("g2-owner-happy") as never });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/#eliotr-google-oauth=authorized`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    const row = await db.prepare("SELECT state FROM google_oauth_intent WHERE principal_id=?1 AND operation_ref=?2").bind("g2-owner-happy", "g2-happy").first<{ state: string }>();
    expect(row?.state).toBe("ADMITTED");
    const connection = await db.prepare("SELECT state FROM google_exchange_connection WHERE connection_id IN (SELECT json_extract(configuration_json,'$.connection_id') FROM google_oauth_intent WHERE principal_id=?1 AND operation_ref=?2)").bind("g2-owner-happy", "g2-happy").first<{ state: string }>();
    expect(connection?.state).toBe("AUTHORIZING");
    const replay = await handleHttp(callbackRequest(`state=${started.state}&code=code-fixture&scope=openid%20email&authuser=0&prompt=consent`), env as never,
      {} as ExecutionContext, { accessVerifier: verifier("g2-owner-happy") as never });
    expect(replay.status).toBe(303);
    expect(replay.headers.get("location")).toBe(`${ORIGIN}/#eliotr-google-oauth=authorized`);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("denies provider consent without token/JWKS calls and uses a fixed fragment", async () => {
    const env = googleEnv();
    const started = await begin(env, "g2-owner-denied", "g2-denied");
    const response = await handleHttp(callbackRequest(`state=${started.state}&error=access_denied`), env as never,
      {} as ExecutionContext, { accessVerifier: verifier("g2-owner-denied") as never });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/#eliotr-google-oauth=denied`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    const row = await db.prepare("SELECT state FROM google_oauth_intent WHERE principal_id=?1 AND operation_ref=?2").bind("g2-owner-denied", "g2-denied").first<{ state: string }>();
    expect(row?.state).toBe("DENIED");
  });

  it("rejects a pinned-issuer or extra-parameter callback before durable/provider effects", async () => {
    const env = googleEnv();
    const started = await begin(env, "g2-owner-invalid", "g2-invalid");
    for (const query of [
      `iss=${encodeURIComponent("https://evil.example")}&state=${started.state}&code=code-fixture`,
      `iss=${encodeURIComponent("https://accounts.google.com")}&state=${started.state}&code=code-fixture&extra=x`,
      `state=${started.state}&code=code-fixture&error_description=unexpected`,
      `state=${started.state}&error=access_denied&scope=openid`,
    ]) {
      const response = await handleHttp(callbackRequest(query), env as never, {} as ExecutionContext, { accessVerifier: verifier("g2-owner-invalid") as never });
      expect(response.status).toBe(400);
      expect((await json(response)).code).toBe("GOOGLE_OAUTH_CALLBACK_INVALID");
    }
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    const row = await db.prepare("SELECT state FROM google_oauth_intent WHERE principal_id=?1 AND operation_ref=?2").bind("g2-owner-invalid", "g2-invalid").first<{ state: string }>();
    expect(row?.state).toBe("PENDING");
  });

  it("normalizes malformed callbacks before checking D1 readiness", async () => {
    const env = { ...googleEnv(), CORE_DB: { prepare: () => { throw new Error("readiness must not run"); } } };
    const response = await handleHttp(callbackRequest("state=short&code=code-fixture"), env as never,
      {} as ExecutionContext, { accessVerifier: verifier("g2-owner-invalid-before-readiness") as never });
    expect(response.status).toBe(400);
    expect((await json(response)).code).toBe("GOOGLE_OAUTH_CALLBACK_INVALID");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("returns 401 when Access currentness is revoked and keeps the callback pending", async () => {
    const env = googleEnv();
    const started = await begin(env, "g2-owner-revoked", "g2-revoked");
    let calls = 0;
    const flapping = {
      async verify() {
        calls += 1;
        if (calls > 1) throw new Error("revoked");
        return { principal_ref: "g2-owner-revoked", credential_generation: "credential-v1", authentication_method: "cloudflare_access", expires_at: new Date(Date.now() + 3600000).toISOString() } as const;
      },
    };
    const response = await handleHttp(callbackRequest(`iss=${encodeURIComponent("https://accounts.google.com")}&state=${started.state}&code=code-fixture`), env as never,
      {} as ExecutionContext, { accessVerifier: flapping as never });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Cloudflare Access");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("maps an aborted callback to a retry fragment without exposing the callback query", async () => {
    const env = googleEnv();
    const started = await begin(env, "g2-owner-timeout", "g2-timeout");
    const controller = new AbortController(); controller.abort();
    const response = await handleHttp(callbackRequest(`iss=${encodeURIComponent("https://accounts.google.com")}&state=${started.state}&error=access_denied`, controller.signal), env as never,
      {} as ExecutionContext, { accessVerifier: verifier("g2-owner-timeout") as never });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/#eliotr-google-oauth=retry`);
    expect(response.headers.get("location")).not.toContain("state=");
  });

  it("serves reconnect and disconnect through owner HTTP with stale-fence rejection and replay", async () => {
    const env = googleEnv(); const owner = "g3-http-owner";
    const started = await begin(env, owner, "g3-http-initial"); callbackNonce = started.nonce;
    const initial = await handleHttp(callbackRequest(`state=${started.state}&code=code-fixture`), env as never,
      {} as ExecutionContext, { accessVerifier: verifier(owner) as never });
    expect(initial.status).toBe(303);
    const connectionId = (env as never as { GOOGLE_OAUTH_CONNECTION_ID: string }).GOOGLE_OAUTH_CONNECTION_ID;
    const first = await db.prepare("SELECT credential_generation,credential_revision FROM google_exchange_connection WHERE connection_id=?1")
      .bind(connectionId).first<{ credential_generation: string; credential_revision: number }>();
    expect(first).not.toBeNull();
    const stale = await handleHttp(lifecycleRequest(RECONNECT_PATH, { operation_ref: "g3-http-stale",
      expected_credential_generation: first?.credential_generation, expected_credential_revision: (first?.credential_revision ?? 0) + 1 }), env as never,
      {} as ExecutionContext, { accessVerifier: verifier(owner) as never });
    expect(stale.status).toBe(409);
    const reconnectBody = { operation_ref: "g3-http-reconnect", expected_credential_generation: first?.credential_generation,
      expected_credential_revision: first?.credential_revision };
    const reconnect = await handleHttp(lifecycleRequest(RECONNECT_PATH, reconnectBody), env as never,
      {} as ExecutionContext, { accessVerifier: verifier(owner) as never });
    expect(reconnect.status).toBe(200);
    const reconnectData = (await json(reconnect)).data as { protocol: string; authorization_url: string };
    expect(reconnectData.protocol).toBe("eliotr.google-oauth-start.v1");
    const reconnectUrl = new URL(reconnectData.authorization_url); callbackNonce = reconnectUrl.searchParams.get("nonce") ?? "";
    const completed = await handleHttp(callbackRequest(`state=${reconnectUrl.searchParams.get("state")}&code=code-fixture`), env as never,
      {} as ExecutionContext, { accessVerifier: verifier(owner) as never });
    expect(completed.status).toBe(303);
    const latest = await db.prepare("SELECT credential_generation,credential_revision FROM google_exchange_connection WHERE connection_id=?1")
      .bind(connectionId).first<{ credential_generation: string; credential_revision: number }>();
    expect(latest?.credential_revision).toBe((first?.credential_revision ?? 0) + 1);
    const disconnectBody = { operation_ref: "g3-http-disconnect", expected_credential_generation: latest?.credential_generation,
      expected_credential_revision: latest?.credential_revision };
    const disconnect = await handleHttp(lifecycleRequest(DISCONNECT_PATH, disconnectBody), env as never,
      {} as ExecutionContext, { accessVerifier: verifier(owner) as never });
    expect(disconnect.status).toBe(200);
    const disconnected = await json(disconnect); expect((disconnected.data as Record<string, unknown>).state).toBe("REVOKED");
    const replay = await handleHttp(lifecycleRequest(DISCONNECT_PATH, disconnectBody), env as never,
      {} as ExecutionContext, { accessVerifier: verifier(owner) as never });
    expect(replay.status).toBe(200); expect((await json(replay)).data).toEqual(disconnected.data);
    const changed = await handleHttp(lifecycleRequest(DISCONNECT_PATH, { ...disconnectBody,
      expected_credential_revision: (latest?.credential_revision ?? 0) + 1 }), env as never,
      {} as ExecutionContext, { accessVerifier: verifier(owner) as never });
    expect(changed.status).toBe(409);
  });
});
