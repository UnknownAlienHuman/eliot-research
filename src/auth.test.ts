import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertOrigin, authenticate, AuthError } from "./auth";

const TEAM = "eliot-test.cloudflareaccess.com";
const ISSUER = `https://${TEAM}`;
const ORIGIN = "https://research.example.com";
const OWNER = "owner@example.com";
const TOKEN_NAME = "owner.access";
let key: CryptoKey;
let otherKey: CryptoKey;
let jwk: Awaited<ReturnType<typeof exportJWK>>;

function env(overrides: Partial<Env> = {}): Env {
  return {
    ELIOT_ACCESS_TEAM_DOMAIN: TEAM, ELIOT_ACCESS_AUD: "eliot-k0",
    ELIOT_OWNER_EMAIL: OWNER, ELIOT_OWNER_SERVICE_TOKEN: TOKEN_NAME,
    ELIOT_ORIGIN: ORIGIN, ELIOT_LOCAL_DEV: "0", ...overrides,
  } as Env;
}
function request(token?: string, url = `${ORIGIN}/api/me`): Request {
  return new Request(url, { headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} });
}
async function token(payload: Record<string, unknown> = { email: OWNER }, options: {
  issuer?: string; audience?: string; expiration?: number | null; signingKey?: CryptoKey;
} = {}): Promise<string> {
  const jwt = new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: "k0" })
    .setIssuer(options.issuer ?? ISSUER).setAudience(options.audience ?? "eliot-k0");
  if (options.expiration !== null) jwt.setExpirationTime(options.expiration ?? Math.floor(Date.now() / 1000) + 600);
  return jwt.sign(options.signingKey ?? key);
}
async function denied(jwt?: string, vars = env()): Promise<void> {
  await expect(authenticate(request(jwt), vars)).rejects.toMatchObject({ status: 403, code: "invalid" });
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  key = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  jwk = { ...await exportJWK(pair.publicKey), kid: "k0", alg: "RS256", use: "sig" };
});
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: URL) => {
    expect(String(url)).toBe(`${ISSUER}/cdn-cgi/access/certs`);
    return Response.json({ keys: [jwk] });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("Access JWT and owner resolution", () => {
  it("verifies the owner browser assertion through the remote JWKS path", async () => {
    expect(await authenticate(request(await token()), env())).toEqual({
      type: "owner", id: OWNER, email: OWNER, authentication: "access",
    });
  });
  it("accepts only the configured signed service-token common_name", async () => {
    expect(await authenticate(request(await token({ common_name: TOKEN_NAME, sub: "" })), env())).toEqual({
      type: "owner", id: TOKEN_NAME, authentication: "service-token",
    });
    await denied(await token({ common_name: "foreign.access" }));
  });
  it("rejects another owner email", async () => { await denied(await token({ email: "other@example.com" })); });
  it("rejects missing and malformed assertions", async () => { await denied(); await denied("not-a-jwt"); });
  it("rejects raw client credentials as proof", async () => {
    await expect(authenticate(new Request(ORIGIN, {
      headers: { "CF-Access-Client-Id": TOKEN_NAME, "CF-Access-Client-Secret": "unused" },
    }), env())).rejects.toBeInstanceOf(AuthError);
  });
  it("rejects a wrong signature", async () => { await denied(await token(undefined, { signingKey: otherKey })); });
  it("rejects unsigned algorithm substitution", async () => {
    const encode = (value: unknown) => btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    await denied(`${encode({ alg: "none" })}.${encode({ email: OWNER, iss: ISSUER, aud: "eliot-k0", exp: 9999999999 })}.`);
  });
  it("requires expiry and rejects an assertion expired one second ago", async () => {
    await denied(await token(undefined, { expiration: null }));
    await denied(await token(undefined, { expiration: Math.floor(Date.now() / 1000) - 1 }));
  });
  it("rejects wrong issuer and audience", async () => {
    await denied(await token(undefined, { issuer: "https://wrong.cloudflareaccess.com" }));
    await denied(await token(undefined, { audience: "wrong" }));
  });
  it("fails closed when production configuration is missing", async () => {
    await expect(authenticate(request(), env({ ELIOT_ACCESS_TEAM_DOMAIN: "" }))).rejects.toMatchObject({ status: 503 });
  });
});

describe("explicit local access", () => {
  const local = env({ ELIOT_LOCAL_DEV: "1", ELIOT_ACCESS_TEAM_DOMAIN: "", ELIOT_ACCESS_AUD: "", ELIOT_OWNER_EMAIL: "", ELIOT_OWNER_SERVICE_TOKEN: "" });
  it.each(["localhost", "127.0.0.1", "[::1]"])("works on %s without production Access variables", async (host) => {
    expect((await authenticate(request(undefined, `http://${host}:5173/api/me`), local)).authentication).toBe("local");
  });
  it("requires the explicit flag", async () => {
    await expect(authenticate(request(undefined, "http://localhost:5173/api/me"), env())).rejects.toMatchObject({ status: 403 });
  });
  it("rejects deployed hosts even with a valid JWT", async () => { await denied(await token(), env({ ELIOT_LOCAL_DEV: "1" })); });
  it("rejects lookalike hosts", async () => {
    await expect(authenticate(request(undefined, "http://localhost.example.com/api/me"), local)).rejects.toMatchObject({ status: 403 });
  });
  it("rejects an edge request carrying the local flag", async () => {
    await expect(authenticate(new Request("http://localhost/api/me", { headers: { "cf-ray": "edge-ray" } }), local)).rejects.toMatchObject({ status: 403 });
  });
});

describe("exact Origin", () => {
  it("allows ordinary reads", () => { expect(() => assertOrigin(new Request(ORIGIN), env())).not.toThrow(); });
  it.each([null, "https://foreign.example", "null", `${ORIGIN}/`])("rejects a mutation with Origin %s", (origin) => {
    expect(() => assertOrigin(new Request(ORIGIN, { method: "POST", headers: origin === null ? {} : { Origin: origin } }), env())).toThrow(AuthError);
  });
  it("accepts the exact configured mutation Origin", () => {
    expect(() => assertOrigin(new Request(ORIGIN, { method: "POST", headers: { Origin: ORIGIN } }), env())).not.toThrow();
  });
  it("requires exact Origin for WebSocket upgrades", () => {
    expect(() => assertOrigin(new Request(ORIGIN, { headers: { Upgrade: "websocket" } }), env())).toThrow(AuthError);
    expect(() => assertOrigin(new Request(ORIGIN, { headers: { Upgrade: "websocket", Origin: ORIGIN } }), env())).not.toThrow();
  });
  it("retains Origin checks for local mutations", () => {
    expect(() => assertOrigin(new Request("http://localhost:5173", { method: "POST" }), env({ ELIOT_LOCAL_DEV: "1" }))).toThrow(AuthError);
  });
});
