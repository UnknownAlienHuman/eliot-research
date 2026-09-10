import { describe, expect, it } from "vitest";
import { createCloudflareAccessVerifier } from "@eliotr/platform-cloudflare";
import type { Env } from "../src/env.js";
import { handleHttp } from "../src/http.js";

const issuer = "https://owner-test.cloudflareaccess.com";
const audience = "owner-test-audience";
const now = Math.floor(Date.now() / 1000);
const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "test-key", alg: "RS256", use: "sig" };
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
async function signed(fields: Record<string, unknown> = {}) {
  const data = `${encode({ alg: "RS256", typ: "JWT", kid: "test-key" })}.${encode({ iss: issuer, aud: [audience],
    sub: "verified-owner", type: "app", iat: now, exp: now + 3600, ...fields })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(data));
  return `${data}.${base64url(new Uint8Array(signature))}`;
}
const verifier = createCloudflareAccessVerifier({ team_domain: issuer, audience, clock_skew_seconds: 0 }, {
  async fetch(input) { expect(String(input)).toBe(`${issuer}/cdn-cgi/access/certs`); return Response.json({ keys: [jwk] }); },
  now: () => now * 1000,
});
const environment = { DEPLOYMENT_GENERATION: "signed-session-test" } as Env;
async function call(token?: string, suffix = "", method = "GET") {
  return handleHttp(new Request(`https://research.example/api/v1/system/session${suffix}`, {
    method, ...(token ? { headers: { "Cf-Access-Jwt-Assertion": token } } : {}),
  }), environment, {} as ExecutionContext, { accessVerifier: verifier,
    applicationFactory: () => { throw new Error("Session introspection must not compose or access a database"); } });
}

describe("owner identity introspection using real signature verification", () => {
  it("returns only verified identity, generation and expiry without a database or token", async () => {
    const token = await signed(); const response = await call(token);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text(); expect(text).not.toContain(token);
    const result = JSON.parse(text);
    expect(result).toMatchObject({ deployment_generation: "signed-session-test", data: {
      protocol: "eliotr.owner-session.v1", principal_ref: "verified-owner", client_class: "owner_pwa",
      credential_generation: `cf-access-jwt:test-key:${now}`, expires_at: new Date((now + 3600) * 1000).toISOString(),
    } });
    expect(Object.keys(result.data).sort()).toEqual(["client_class", "credential_generation", "expires_at", "principal_ref", "protocol"]);
  });
  it("rejects a correctly signed service token", async () => {
    const response = await call(await signed({ sub: "", common_name: "service.access" }));
    expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ code: "PRINCIPAL_CLASS_DENIED" });
  });
  it("rejects missing, forged, expired, wrong-issuer and wrong-audience tokens", async () => {
    const token = await signed(); const pieces = token.split(".");
    pieces[2] = `${pieces[2]?.startsWith("A") ? "B" : "A"}${pieces[2]?.slice(1)}`;
    for (const candidate of [undefined, "forged.token.signature", pieces.join("."), await signed({ exp: now - 1, iat: now - 100 }),
      await signed({ iss: "https://another.cloudflareaccess.com" }), await signed({ aud: ["other"] })]) {
      const response = await call(candidate); expect(response.status).toBe(401);
      expect(await response.json()).not.toHaveProperty("data");
    }
  });
  it("does not widen the route to extra queries or other methods", async () => {
    expect((await call(await signed(), "?principal=attacker")).status).toBe(400);
    expect((await call(await signed(), "", "POST")).status).toBe(405);
  });
});
