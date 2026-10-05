import { describe, expect, it, vi } from "vitest";
import {
  AccessVerificationError,
  createCloudflareAccessVerifier,
} from "./access.js";

const TEAM_DOMAIN = "https://eliotr-example.cloudflareaccess.com";
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

  it("aborts a JWKS request that never returns response headers", async () => {
    const { sign } = await fixture();
    let requestSignal: AbortSignal | undefined;
    let fetchCount = 0;
    const verifier = createCloudflareAccessVerifier({
      team_domain: TEAM_DOMAIN,
      audience: AUDIENCE,
      jwks_fetch_timeout_ms: 15,
      jwks_failure_cooldown_seconds: 1,
    }, {
      now: () => NOW_MS,
      fetch: ((_input: RequestInfo | URL, init?: RequestInit) => {
        fetchCount += 1;
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }) as typeof fetch,
    });
    const startedAt = Date.now();
    await expect(verifier.verify(requestWith(await sign())))
      .rejects.toMatchObject({ code: "ACCESS_JWKS_UNAVAILABLE", retryable: true });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchCount).toBe(1);
  });

  it("cancels a partially read JWKS body when its deadline expires", async () => {
    const { sign } = await fixture();
    let cancelCount = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"keys":['));
      },
      cancel() { cancelCount += 1; },
    });
    const response = new Response(body, { headers: { "content-type": "application/json" } });
    const verifier = createCloudflareAccessVerifier({
      team_domain: TEAM_DOMAIN,
      audience: AUDIENCE,
      jwks_fetch_timeout_ms: 15,
    }, {
      now: () => NOW_MS,
      fetch: async () => response,
    });
    await expect(verifier.verify(requestWith(await sign())))
      .rejects.toMatchObject({ code: "ACCESS_JWKS_UNAVAILABLE", retryable: true });
    expect(cancelCount).toBe(1);
    expect(response.body?.locked).toBe(false);
  });

  it("cancels a late response body when an injected fetch ignores abort", async () => {
    const { sign } = await fixture();
    let resolveFetch: ((response: Response) => void) | undefined;
    let cancelCount = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("late")); },
      cancel() { cancelCount += 1; },
    });
    const verifier = createCloudflareAccessVerifier({
      team_domain: TEAM_DOMAIN,
      audience: AUDIENCE,
      jwks_fetch_timeout_ms: 15,
    }, {
      now: () => NOW_MS,
      fetch: ((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })) as typeof fetch,
    });
    await expect(verifier.verify(requestWith(await sign())))
      .rejects.toMatchObject({ code: "ACCESS_JWKS_UNAVAILABLE" });
    expect(resolveFetch).toBeDefined();
    resolveFetch?.(new Response(body, { headers: { "content-type": "application/json" } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelCount).toBe(1);
  });

  it("joins concurrent refreshes and bounds fetches and timers during a request flood", async () => {
    const { sign } = await fixture();
    const now = NOW_MS;
    let fetchCount = 0;
    const verifier = createCloudflareAccessVerifier({
      team_domain: TEAM_DOMAIN,
      audience: AUDIENCE,
      jwks_fetch_timeout_ms: 20,
      jwks_failure_cooldown_seconds: 1,
    }, {
      now: () => now,
      fetch: ((_input: RequestInfo | URL, _init?: RequestInit) => {
        fetchCount += 1;
        return new Promise<Response>(() => undefined);
      }) as typeof fetch,
    });
    const token = await sign();
    vi.useFakeTimers();
    try {
      const pending = Array.from({ length: 64 }, () => verifier.verify(requestWith(token)));
      const resultsPromise = Promise.allSettled(pending);
      expect(fetchCount).toBe(1);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(20);
      expect(vi.getTimerCount()).toBe(0);
      const results = await resultsPromise;
      expect(results).toHaveLength(64);
      for (const result of results) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.reason).toMatchObject({ code: "ACCESS_JWKS_UNAVAILABLE" });
        }
      }
      const burst = await Promise.allSettled(
        Array.from({ length: 64 }, () => verifier.verify(requestWith(token))),
      );
      expect(burst).toHaveLength(64);
      expect(fetchCount).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers with a healthy JWKS refresh after the bounded failure cooldown", async () => {
    const { publicJwk, sign } = await fixture();
    let now = NOW_MS;
    let fetchCount = 0;
    const verifier = createCloudflareAccessVerifier({
      team_domain: TEAM_DOMAIN,
      audience: AUDIENCE,
      jwks_fetch_timeout_ms: 15,
      jwks_failure_cooldown_seconds: 1,
    }, {
      now: () => now,
      fetch: ((_input: RequestInfo | URL, _init?: RequestInit) => {
        fetchCount += 1;
        if (fetchCount === 1) return new Promise<Response>(() => undefined);
        return Promise.resolve(new Response(JSON.stringify({ keys: [publicJwk] }), {
          headers: { "content-type": "application/json" },
        }));
      }) as typeof fetch,
    });
    const request = requestWith(await sign());
    await expect(verifier.verify(request))
      .rejects.toMatchObject({ code: "ACCESS_JWKS_UNAVAILABLE" });
    await expect(verifier.verify(request))
      .rejects.toMatchObject({ code: "ACCESS_JWKS_UNAVAILABLE" });
    expect(fetchCount).toBe(1);

    now += 1_000;
    await expect(verifier.verify(request)).resolves.toMatchObject({ principal_ref: "human-subject" });
    expect(fetchCount).toBe(2);
  });

  it("refreshes an expired JWKS before accepting a rotated signing key", async () => {
    const previous = await fixture();
    const rotated = await fixture();
    let now = NOW_MS;
    let fetchCount = 0;
    const verifier = createCloudflareAccessVerifier({
      team_domain: TEAM_DOMAIN,
      audience: AUDIENCE,
      jwks_cache_ttl_seconds: 1,
    }, {
      now: () => now,
      fetch: async () => {
        fetchCount += 1;
        return new Response(JSON.stringify({ keys: [fetchCount === 1 ? previous.publicJwk : rotated.publicJwk] }), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(verifier.verify(requestWith(await previous.sign())))
      .resolves.toMatchObject({ principal_ref: "human-subject" });
    now += 1_000;
    await expect(verifier.verify(requestWith(await rotated.sign())))
      .resolves.toMatchObject({ principal_ref: "human-subject" });
    expect(fetchCount).toBe(2);
  });

  it("coalesces an unknown-kid refresh flood and cools down after a healthy refresh", async () => {
    const { publicJwk, sign } = await fixture();
    let now = NOW_MS;
    let fetchCount = 0;
    const verifier = createCloudflareAccessVerifier({
      team_domain: TEAM_DOMAIN,
      audience: AUDIENCE,
      unknown_kid_refresh_cooldown_seconds: 1,
    }, {
      now: () => now,
      fetch: async () => {
        fetchCount += 1;
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    await verifier.verify(requestWith(await sign()));
    now += 1_000;
    const unknownToken = await sign({}, { kid: "unknown-kid" });
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const burst = await Promise.allSettled(
        Array.from({ length: 64 }, () => verifier.verify(requestWith(unknownToken))),
      );
      expect(fetchCount).toBe(2);
      expect(timeoutSpy.mock.calls.filter((call) => call[1] === 5_000)).toHaveLength(1);
      for (const result of burst) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.reason).toMatchObject({ code: "ACCESS_JWT_KEY_UNKNOWN" });
        }
      }

      const cooledDown = await Promise.allSettled(
        Array.from({ length: 64 }, () => verifier.verify(requestWith(unknownToken))),
      );
      expect(cooledDown).toHaveLength(64);
      expect(fetchCount).toBe(2);
      expect(timeoutSpy.mock.calls.filter((call) => call[1] === 5_000)).toHaveLength(1);
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
