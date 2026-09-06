import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, requestApi } from "./api.js";
import { beginGoogleOAuth, decodeGoogleOAuthBeginEnvelope } from "./google-oauth-api.js";

const begin = (overrides: Record<string, unknown> = {}) => ({
  data: {
    protocol: "eliotr.google-oauth-start.v1",
    authorization_url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=y",
    expires_at: "2026-09-06T01:00:00.000Z",
    intent_id: "intent-1",
    ...overrides,
  },
  trace_id: "trace-1",
  deployment_generation: "generation-1",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Google OAuth begin decoder", () => {
  it("accepts the exact begin envelope", () => {
    expect(decodeGoogleOAuthBeginEnvelope(begin()).intentId).toBe("intent-1");
  });

  it.each([
    ["extra field", { unexpected: true }],
    ["missing intent", { intent_id: undefined }],
    ["wrong protocol", { protocol: "eliotr.google-oauth-start.v0" }],
    ["http authorization URL", { authorization_url: "http://accounts.google.com/o/oauth2/v2/auth" }],
    ["wrong host", { authorization_url: "https://evil.example/auth" }],
    ["secret in URL", { authorization_url: "https://accounts.google.com/o/oauth2/v2/auth?code=secret" }],
    ["refresh in URL", { authorization_url: "https://accounts.google.com/o/oauth2/v2/auth?refresh_token=secret" }],
    ["non-canonical expiry", { expires_at: "2026-09-06 01:00:00" }],
    ["bad intent id", { intent_id: "not an id!" }],
  ])("rejects %s", (_label, patch) => {
    const value = begin();
    const data = { ...value.data };
    for (const [key, entry] of Object.entries(patch)) {
      if (entry === undefined) delete (data as Record<string, unknown>)[key];
      else (data as Record<string, unknown>)[key] = entry;
    }
    expect(() => decodeGoogleOAuthBeginEnvelope({ ...value, data })).toThrow(ApiRequestError);
  });

  it("rejects envelope-level unknown fields", () => {
    expect(() => decodeGoogleOAuthBeginEnvelope({ ...begin(), unexpected: true })).toThrow(ApiRequestError);
  });
});

describe("Google OAuth begin transport", () => {
  it("posts same-origin with the CSRF header and a single operation field", async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(_url).toBe("/api/v1/google/oauth/begin");
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("same-origin");
      const headers = new Headers(init.headers);
      expect(headers.get("x-eliotr-csrf")).toBe("1");
      expect(Object.keys(JSON.parse(String(init.body)))).toEqual(["operation_ref"]);
      return Response.json(begin());
    });
    vi.stubGlobal("fetch", fetcher);
    const first = await beginGoogleOAuth("operation-1");
    expect(first.operationRef).toBe("operation-1");
    expect(first.begin.intentId).toBe("intent-1");
    const retry = await beginGoogleOAuth(first.operationRef);
    expect(retry.begin).toEqual(first.begin);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid operation reference before any request", async () => {
    const fetcher = vi.fn(async () => Response.json(begin()));
    vi.stubGlobal("fetch", fetcher);
    await expect(beginGoogleOAuth("not an id!")).rejects.toMatchObject({ code: "API_PATH_INVALID" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never touches browser storage", async () => {
    const fetcher = vi.fn(async () => Response.json(begin()));
    vi.stubGlobal("fetch", fetcher);
    const setItem = vi.fn();
    const storage = { setItem, getItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", storage);
    await beginGoogleOAuth("operation-2");
    expect(setItem).not.toHaveBeenCalled();
  });

  it("preserves typed begin problems", async () => {
    vi.stubGlobal("fetch", async () => Response.json({
      type: "urn:eliotr:problem:google_oauth_not_configured",
      title: "Missing",
      status: 503,
      code: "GOOGLE_OAUTH_NOT_CONFIGURED",
      trace_id: "trace-9",
      retryable: true,
    }, { status: 503, headers: { "content-type": "application/json" } }));
    await expect(beginGoogleOAuth("operation-3")).rejects.toMatchObject({
      code: "GOOGLE_OAUTH_NOT_CONFIGURED",
      status: 503,
      retryable: true,
    });
  });

  it("uses requestApi path fencing", async () => {
    await expect(requestApi("https://elsewhere.example/api/v1/google/oauth/begin")).rejects.toMatchObject({
      code: "API_PATH_INVALID",
    });
  });
});
