import { describe, expect, it } from "vitest";
import {
  AccessVerificationError,
  createCloudflareAccessVerifier,
} from "./access.js";

const TEAM_DOMAIN = "https://eliotr.cloudflareaccess.com";
const AUDIENCE = "eliotr-app-aud";
const NOW_MS = Date.UTC(2026, 7, 29, 12, 0, 0);
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function encodeJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function fixture() {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicJwk = {
    ...await crypto.subtle.exportKey("jwk", pair.publicKey),
    kid: "kid-1",
    alg: "RS256",
    use: "sig",
    key_ops: ["verify"],
  };

  async function sign(
    payloadOverrides: Readonly<Record<string, unknown>> = {},
    headerOverrides: Readonly<Record<string, unknown>> = {},
  ): Promise<string> {
    const header = encodeJson({ alg: "RS256", kid: "kid-1", typ: "JWT", ...headerOverrides });
    const payload = encodeJson({
      iss: TEAM_DOMAIN,
      aud: [AUDIENCE],
      sub: "human-subject",
      exp: NOW_SECONDS + 600,
      nbf: NOW_SECONDS - 10,
      iat: NOW_SECONDS - 10,
      type: "app",
      ...payloadOverrides,
    });
    const signingInput = new TextEncoder().encode(`${header}.${payload}`);
    const signature = await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      pair.privateKey,
      signingInput,
    );
    return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
  }

  return { publicJwk, sign };
}

function requestWith(token: string, extraHeaders: HeadersInit = {}): Request {
  return new Request("https://research.example/api/v1/system/health", {
    headers: { "cf-access-jwt-assertion": token, ...Object.fromEntries(new Headers(extraHeaders)) },
  });
}

describe("Cloudflare Access verifier", () => {
  it("verifies RS256, issuer, audience, times and classifies configured service subjects", async () => {
    const { publicJwk, sign } = await fixture();
    let fetchCount = 0;
    const verifier = createCloudflareAccessVerifier({
      team_domain: TEAM_DOMAIN,
      audience: AUDIENCE,
      allowed_service_principal_common_names: ["service-client.access"],
    }, {
      now: () => NOW_MS,
      fetch: async () => {
        fetchCount += 1;
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    const human = await verifier.verify(requestWith(await sign()));
    const service = await verifier.verify(requestWith(await sign({
      sub: "",
      common_name: "service-client.access",
      nbf: undefined,
    })));
    expect(human).toEqual(expect.objectContaining({
      principal_ref: "human-subject",
      authentication_method: "cloudflare_access",
      credential_generation: `cf-access-jwt:kid-1:${NOW_SECONDS - 10}`,
    }));
    expect(service).toEqual(expect.objectContaining({
      principal_ref: "service-client.access",
      authentication_method: "service_token",
    }));
    expect(fetchCount).toBe(1);
  });

  it("never treats raw service-token headers as an origin authentication proof", async () => {
    const verifier = createCloudflareAccessVerifier({
      team_domain: TEAM_DOMAIN,
      audience: AUDIENCE,
    }, { fetch: async () => new Response("unreachable"), now: () => NOW_MS });
    const request = new Request("https://research.example/", {
      headers: {
        "cf-access-client-id": "client-id",
        "cf-access-client-secret": "client-secret",
      },
    });
    await expect(verifier.verify(request)).rejects.toMatchObject({
      code: "ACCESS_JWT_MISSING",
    });
  });

  it("uses signed common_name for service principals and applies an optional allowlist", async () => {
    const { publicJwk, sign } = await fixture();
    const verifier = createCloudflareAccessVerifier({
      team_domain: TEAM_DOMAIN,
      audience: AUDIENCE,
      allowed_service_principal_common_names: ["allowed.access"],
    }, {
      now: () => NOW_MS,
      fetch: async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
        headers: { "content-type": "application/json" },
      }),
    });
    await expect(verifier.verify(requestWith(await sign({
      sub: "",
      common_name: "denied.access",
      nbf: undefined,
    })))).rejects.toMatchObject({ code: "ACCESS_SERVICE_PRINCIPAL_DENIED" });
  });

  it.each([
    [{ iss: "https://wrong.cloudflareaccess.com" }, "ACCESS_JWT_ISSUER_INVALID"],
    [{ aud: ["wrong-audience"] }, "ACCESS_JWT_AUDIENCE_INVALID"],
    [{ exp: NOW_SECONDS - 120 }, "ACCESS_JWT_EXPIRED"],
    [{ nbf: NOW_SECONDS + 120 }, "ACCESS_JWT_NOT_YET_VALID"],
    [{ iat: NOW_SECONDS + 120 }, "ACCESS_JWT_ISSUED_IN_FUTURE"],
    [{ type: "org" }, "ACCESS_JWT_TYPE_INVALID"],
  ] as const)("rejects invalid claims %#", async (overrides, code) => {
    const { publicJwk, sign } = await fixture();
    const verifier = createCloudflareAccessVerifier({
      team_domain: TEAM_DOMAIN,
      audience: AUDIENCE,
    }, {
      now: () => NOW_MS,
      fetch: async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
        headers: { "content-type": "application/json" },
      }),
    });
    await expect(verifier.verify(requestWith(await sign(overrides)))).rejects.toMatchObject({ code });
  });

  it("rejects tampered signatures and algorithm substitution", async () => {
    const { publicJwk, sign } = await fixture();
    const verifier = createCloudflareAccessVerifier({
      team_domain: TEAM_DOMAIN,
      audience: AUDIENCE,
    }, {
      now: () => NOW_MS,
      fetch: async () => new Response(JSON.stringify({ keys: [publicJwk] }), {
        headers: { "content-type": "application/json" },
      }),
    });
    const token = await sign();
    const segments = token.split(".");
    const payload = encodeJson({
      iss: TEAM_DOMAIN,
      aud: [AUDIENCE],
      sub: "attacker",
      exp: NOW_SECONDS + 600,
      iat: NOW_SECONDS - 10,
      type: "app",
    });
    await expect(verifier.verify(requestWith(`${segments[0]}.${payload}.${segments[2]}`)))
      .rejects.toMatchObject({ code: "ACCESS_JWT_SIGNATURE_INVALID" });
    await expect(verifier.verify(requestWith(await sign({}, { alg: "none" }))))
      .rejects.toMatchObject({ code: "ACCESS_JWT_ALGORITHM_DENIED" });
  });

  it("bounds tokens and JWKS before parsing or key import", async () => {
    const verifier = createCloudflareAccessVerifier({
      team_domain: TEAM_DOMAIN,
      audience: AUDIENCE,
      max_token_bytes: 1024,
      max_jwks_bytes: 1024,
    }, { now: () => NOW_MS, fetch: async () => new Response("{}") });
    await expect(verifier.verify(requestWith(`a.${"b".repeat(1100)}.c`)))
      .rejects.toBeInstanceOf(AccessVerificationError);

    const { sign } = await fixture();
    const oversizedJwksVerifier = createCloudflareAccessVerifier({
      team_domain: TEAM_DOMAIN,
      audience: AUDIENCE,
      max_jwks_bytes: 1024,
    }, {
      now: () => NOW_MS,
      fetch: async () => new Response("x".repeat(2048), {
        headers: { "content-type": "application/json" },
      }),
    });
    await expect(oversizedJwksVerifier.verify(requestWith(await sign())))
      .rejects.toMatchObject({ code: "ACCESS_JWKS_INVALID" });
  });
});
