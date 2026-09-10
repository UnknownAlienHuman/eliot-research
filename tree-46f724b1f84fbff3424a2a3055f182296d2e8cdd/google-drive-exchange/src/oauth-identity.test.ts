import { beforeAll, describe, expect, it, vi } from "vitest";
import { verifyGoogleIdentity } from "./oauth-identity.js";
import { exchangeGoogleCode, GOOGLE_JWKS_URL } from "./oauth-transport.js";
import { oauthBase64, oauthBounded, oauthConfiguration } from "./oauth-types.js";
import { OAUTH_TEST_TIME, oauthTestClaims, oauthTestConfiguration, oauthTestIntent, oauthTestKeys, oauthTestTokenResponse } from "./oauth-test-fixture.js";
let signing: Awaited<ReturnType<typeof oauthTestKeys>>;
let fixture: Awaited<ReturnType<typeof oauthTestIntent>>;
beforeAll(async () => { signing = await oauthTestKeys(); fixture = await oauthTestIntent(); });
const signal = () => new AbortController().signal;
const verify = (token: string, fetchImpl: typeof fetch = async () => Response.json({ keys: [signing.jwk] }), now = () => OAUTH_TEST_TIME) =>
  verifyGoogleIdentity({ token, accessToken: "access-fixture", code: "code-fixture", nonce: fixture.proof.nonce,
    intent: fixture.intent, signal: signal(), fetchImpl, now });

describe("Google authorization-code OIDC verification", () => {
  it("verifies real RSA signatures against the fixed key endpoint and exact dedicated identity", async () => {
    const fetched = vi.fn<typeof fetch>(async () => Response.json({ keys: [signing.jwk] }));
    await verify(await signing.sign(await oauthTestClaims(fixture.proof.nonce)), fetched);
    expect(fetched).toHaveBeenCalledOnce();
    expect(fetched.mock.calls[0]?.[0]).toBe(GOOGLE_JWKS_URL);
    expect(fetched.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit", redirect: "manual", cache: "no-store" });
    expect(JSON.stringify(fetched.mock.calls)).not.toContain("access-fixture");
  });
  it.each([
    ["issuer", { iss: "https://attacker.example" }], ["audience", { aud: "other-client" }],
    ["multiple audiences", { aud: ["test-client.apps.googleusercontent.com", "attacker"] }],
    ["authorized party", { azp: "attacker" }], ["nonce", { nonce: "wrong" }], ["subject", { sub: "other" }],
    ["email", { email: "other@example.com" }], ["verified flag", { email_verified: "true" }],
    ["unverified email", { email_verified: false }], ["expired", { exp: OAUTH_TEST_TIME / 1000 }],
    ["future", { iat: OAUTH_TEST_TIME / 1000 + 61 }], ["old", { iat: OAUTH_TEST_TIME / 1000 - 61 }],
    ["future not-before", { nbf: OAUTH_TEST_TIME / 1000 + 1 }], ["noninteger", { exp: "9999999999" }],
    ["missing access hash", { at_hash: undefined }], ["overlong validity", { exp: OAUTH_TEST_TIME / 1000 + 7201 }], ["unknown claim", { privileged: true }],
  ])("rejects %s without accepting a provider-signed wrong binding", async (_label, mutation) => {
    await expect(verify(await signing.sign({ ...await oauthTestClaims(fixture.proof.nonce), ...mutation })))
      .rejects.toMatchObject({ code: "GOOGLE_OAUTH_IDENTITY_REJECTED" });
  });
  it("accepts Google's legacy issuer and a single matching audience, but still verifies signatures", async () => {
    await verify(await signing.sign({ ...await oauthTestClaims(fixture.proof.nonce), iss: "accounts.google.com",
      aud: [fixture.intent.configuration.oauth_client_id], azp: fixture.intent.configuration.oauth_client_id }));
  });
  it("rejects forged signatures and JWT-provided key URLs before trusting claims", async () => {
    const token = await signing.sign(await oauthTestClaims(fixture.proof.nonce));
    const last = token.lastIndexOf(".");
    await expect(verify(`${token.slice(0, last + 1)}${token[last + 1] === "A" ? "B" : "A"}${token.slice(last + 2)}`)).rejects.toThrow();
    const fetched = vi.fn<typeof fetch>();
    for (const header of [{ alg: "none", kid: "test-key" }, { alg: "HS256", kid: "test-key" },
      { alg: "RS256", kid: "test-key", jku: "https://attacker.example" }, { alg: "RS256", kid: "test-key", crit: ["x"] }]) {
      await expect(verify(await signing.sign(await oauthTestClaims(fixture.proof.nonce), header), fetched)).rejects.toThrow();
    }
    expect(fetched).not.toHaveBeenCalled();
  });
  it("checks mandatory access and optional code half-hashes rather than trusting token adjacency", async () => {
    const half = async (text: string) => oauthBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).slice(0, 16));
    const claims = { ...await oauthTestClaims(fixture.proof.nonce), at_hash: await half("access-fixture"), c_hash: await half("code-fixture") };
    await verify(await signing.sign(claims));
    for (const name of ["at_hash", "c_hash"]) await expect(verify(await signing.sign({ ...claims, [name]: "forged" }))).rejects.toThrow();
  });
  it("rejects duplicate/unknown/private/weak/inappropriate signing keys", async () => {
    const token = await signing.sign(await oauthTestClaims(fixture.proof.nonce));
    for (const keys of [[signing.jwk, signing.jwk], [{ ...signing.jwk, kid: "another" }],
      [{ ...signing.jwk, d: "private" }], [{ ...signing.jwk, n: "AAAA" }], [{ ...signing.jwk, e: "Aw" }],
      [{ ...signing.jwk, use: "enc" }], [{ ...signing.jwk, alg: "HS256" }], [{ ...signing.jwk, key_ops: ["sign"] }], []]) {
      await expect(verify(token, async () => Response.json({ keys }))).rejects.toThrow();
    }
  });
  it("rejects redirects, HTML, malformed/oversized key responses and post-read expiry", async () => {
    const token = await signing.sign(await oauthTestClaims(fixture.proof.nonce));
    for (const response of [new Response(null, { status: 302 }), new Response("login", { headers: { "content-type": "text/html" } }),
      new Response("{invalid", { headers: { "content-type": "application/json" } }),
      new Response("{}", { headers: { "content-type": "application/json", "content-length": "32769" } })]) {
      await expect(verify(token, async () => response)).rejects.toThrow();
    }
    let time = OAUTH_TEST_TIME;
    await expect(verify(token, async () => { time += 600000; return Response.json({ keys: [signing.jwk] }); }, () => time)).rejects.toThrow();
  });
  it("bounds token size and canonical base64url before a key fetch", async () => {
    const fetched = vi.fn<typeof fetch>();
    for (const token of ["a.b.c.d", "x".repeat(16385), "=.a.b", "not-a-jwt", "a.b.c"]) await expect(verify(token, fetched)).rejects.toThrow();
    expect(fetched).not.toHaveBeenCalled();
  });
});

describe("bounded authorization-code exchange", () => {
  const exchange = (fetchImpl: typeof fetch) => exchangeGoogleCode({ configuration: oauthTestConfiguration(), clientSecret: "client-secret",
    code: "code-fixture", verifier: "V".repeat(43), signal: signal(), fetchImpl });
  it("sends the exact server code/redirect/PKCE in one form POST without URLs containing secrets", async () => {
    const fetched = vi.fn<typeof fetch>(async () => Response.json(oauthTestTokenResponse("signed-token")));
    expect((await exchange(fetched)).refresh_token).toBe("refresh-fixture"); expect(fetched).toHaveBeenCalledOnce();
    expect(fetched.mock.calls[0]?.[0]).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(fetched.mock.calls[0]?.[1]?.body as string);
    expect(body.get("grant_type")).toBe("authorization_code"); expect(body.get("code_verifier")).toBe("V".repeat(43));
    expect(body.get("redirect_uri")).toBe(oauthTestConfiguration().redirect_uri);
  });
  it("requires offline refresh grant and exactly the narrow scopes; no coercion or guessed fields", async () => {
    const base = oauthTestTokenResponse("signed-token");
    for (const change of [{ refresh_token: undefined }, { id_token: undefined }, { scope: undefined },
      { scope: `${base.scope} https://www.googleapis.com/auth/gmail.readonly` }, { scope: "openid email" },
      { token_type: "mac" }, { expires_in: "3600" }, { refresh_token: "secret\nheader" }, { extra: "unknown" },
      { refresh_token_expires_in: 0 }]) await expect(exchange(async () => Response.json({ ...base, ...change }))).rejects.toThrow();
  });
  it("never retries or reflects rejected/uncertain upstream messages", async () => {
    for (const response of [new Response(null, { status: 302 }), Response.json({ error: "invalid_grant", error_description: "client-secret" }, { status: 400 }),
      Response.json({ secret: "client-secret" }, { status: 500 }), new Response("{}", { headers: { "content-type": "text/html" } })]) {
      const fetched = vi.fn<typeof fetch>(async () => response);
      await expect(exchange(fetched)).rejects.not.toHaveProperty("message", expect.stringContaining("client-secret")); expect(fetched).toHaveBeenCalledOnce();
    }
  });
  it("deadline covers an uncooperative fetch and cancels a streaming body", async () => {
    const abort = new AbortController(); let requestSignal: AbortSignal | undefined;
    const request = oauthBounded(abort.signal, Date.now() + 30, Date.now, (inner) => exchangeGoogleCode({ configuration: oauthTestConfiguration(),
      clientSecret: "secret", code: "code", verifier: "V".repeat(43), signal: inner, fetchImpl: async (_url, init) => {
        requestSignal = init?.signal ?? undefined; return new Promise(() => {});
      } }));
    await expect(request).rejects.toThrow(); expect(requestSignal?.aborted).toBe(true);
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    await expect(oauthBounded(signal(), Date.now() + 30, Date.now, (inner) => exchangeGoogleCode({ configuration: oauthTestConfiguration(),
      clientSecret: "secret", code: "code", verifier: "V".repeat(43), signal: inner,
      fetchImpl: async () => new Response(stream, { headers: { "content-type": "application/json" } }) }))).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
  it("rejects Testing/unattested or unsafe redirects while allowing an explicit development loopback", () => {
    const config = oauthTestConfiguration();
    for (const change of [{ oauth_publishing_status: "Testing" }, { production_evidence_ref: "" },
      { redirect_uri: "http://research.example/oauth" }, { redirect_uri: "https://research.example/../callback" },
      { redirect_uri: "https://research.example/callback?next=evil" }, { redirect_uri: "https://user:pass@research.example/callback" }]) {
      expect(() => oauthConfiguration({ ...config, ...change } as typeof config)).toThrow();
    }
    expect(oauthConfiguration({ ...config, environment: "development", redirect_uri: "http://127.0.0.1:8787/oauth/callback" }).environment).toBe("development");
  });
});
