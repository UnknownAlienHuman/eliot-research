// Adapted to the extracted C3-C factories. Transport, error construction, epoch and the
// operation-reference mint arrive as caller-owned collaborators.
import { describe, expect, it, vi } from "vitest";
import { createGoogleOAuthApi } from "./google";
import type { LegacyErrorDetails, LegacyErrorFactory, LegacyHttpAdapter } from "../legacy/http";
import type { EpochPort } from "../transport/client";

const SAFE_AUTHORIZATION_URL =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&response_type=code&scope=openid";

const beginEnvelope = (data: unknown) => ({
  data,
  trace_id: "trace-google-1",
  deployment_generation: "deploy-1",
});

const validData = {
  protocol: "eliotr.google-oauth-start.v1",
  authorization_url: SAFE_AUTHORIZATION_URL,
  expires_at: "2026-10-09T12:10:00.000Z",
  intent_id: "intent-1",
};

class LegacyError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly traceId: string | null;
  public readonly retryable: boolean;
  public constructor(details: LegacyErrorDetails) {
    super(details.message);
    this.name = "LegacyError";
    this.status = details.status;
    this.code = details.code;
    this.traceId = details.traceId;
    this.retryable = details.retryable;
  }
}

const errors: LegacyErrorFactory = (details) => new LegacyError(details);

function liveEpoch() {
  let closed = false;
  const stamp = {};
  const epoch: EpochPort = {
    capture: () => (closed ? undefined : stamp),
    isCurrent: (capture: unknown) => !closed && capture === stamp,
  };
  return { epoch, close: () => { closed = true; } };
}

type GoogleHttp = Pick<LegacyHttpAdapter, "requestApi">;

function googleHttp(respond: (path: string, init?: RequestInit) => Promise<unknown>) {
  const requestApi = vi.fn<LegacyHttpAdapter["requestApi"]>(async (path, init) => respond(String(path), init));
  return { http: { requestApi } as GoogleHttp, requestApi };
}

function makeApi(respond: (path: string, init?: RequestInit) => Promise<unknown>) {
  const { epoch, close } = liveEpoch();
  const { http, requestApi } = googleHttp(respond);
  return { api: createGoogleOAuthApi(http, errors, epoch, { mint: () => "op-ref-1" }), requestApi, close };
}

function deadApi() {
  const { http, requestApi } = googleHttp(async () => beginEnvelope(validData));
  const epoch: EpochPort = { capture: () => undefined, isCurrent: () => false };
  return { api: createGoogleOAuthApi(http, errors, epoch, { mint: () => "op-ref-1" }), requestApi };
}
function beginUrlWithQuery(extra: string): string {
  return SAFE_AUTHORIZATION_URL + extra;
}

describe("moved Google callback outcome reader", () => {
  it("rejects a closed epoch before minting a default operation identity", async () => {
    const mint = vi.fn(() => "op-ref-1");
    const requestApi = vi.fn(async () => beginEnvelope(validData));
    const epoch: EpochPort = { capture: () => undefined, isCurrent: () => false };
    const api = createGoogleOAuthApi({ requestApi }, errors, epoch, { mint });
    await expect(api.beginGoogleOAuth()).rejects.toMatchObject({ code: "API_SESSION_CLOSED" });
    expect(mint).not.toHaveBeenCalled();
    expect(requestApi).not.toHaveBeenCalled();
  });
  it("reads only the fixed server callback vocabulary", () => {
    const { api } = makeApi(async () => beginEnvelope(validData));
    expect(api.readGoogleOAuthCallbackOutcome("#eliotr-google-oauth=authorized")).toBe("authorized");
    expect(api.readGoogleOAuthCallbackOutcome("#eliotr-google-oauth=denied")).toBe("denied");
  });

  it("returns null for an unsupported or foreign fragment", () => {
    const { api } = makeApi(async () => beginEnvelope(validData));
    expect(api.readGoogleOAuthCallbackOutcome("#eliotr-google-oauth=bogus")).toBeNull();
    expect(api.readGoogleOAuthCallbackOutcome("#state=authorized")).toBeNull();
  });
});

describe("createGoogleOAuthApi", () => {
  it("accepts a strict envelope on the exact Google origin and path", async () => {
    const { api } = makeApi(async () => beginEnvelope(validData));
    const { begin } = await api.beginGoogleOAuth("op-ref-1");
    expect(begin).toEqual({
      protocol: "eliotr.google-oauth-start.v1",
      authorizationUrl: SAFE_AUTHORIZATION_URL,
      expiresAt: "2026-10-09T12:10:00.000Z",
      intentId: "intent-1",
    });
  });

  it("rejects an authorization URL that carries a secret", async () => {
    const { api } = makeApi(async () => beginEnvelope({
      ...validData,
      authorization_url: beginUrlWithQuery("&client_secret=leaked"),
    }));
    await expect(api.beginGoogleOAuth("op-ref-1")).rejects.toThrow(/unexpected secret/);
  });

  it("rejects an authorization URL on a foreign host", async () => {
    const { api } = makeApi(async () => beginEnvelope({
      ...validData,
      authorization_url: SAFE_AUTHORIZATION_URL.replace("accounts.google.com", "evil.example"),
    }));
    await expect(api.beginGoogleOAuth("op-ref-1")).rejects.toThrow();
  });

  it("rejects an unknown begin data field", async () => {
    const { api } = makeApi(async () => beginEnvelope({ ...validData, extra: 1 }));
    await expect(api.beginGoogleOAuth("op-ref-1")).rejects.toThrow(/has missing or unknown fields/);
  });

  it("rejects an invalid operation reference before any request", async () => {
    const { api, requestApi } = makeApi(async () => beginEnvelope(validData));
    await expect(api.beginGoogleOAuth("bad ref")).rejects.toThrow(/Invalid OAuth operation reference/);
    expect(requestApi).not.toHaveBeenCalled();
  });

  it("mints through the injected supplier and never mints a replacement for a caller ref", async () => {
    const mint = vi.fn(() => "op-ref-1");
    const { http, requestApi } = googleHttp(async () => beginEnvelope(validData));
    const api = createGoogleOAuthApi(http, errors, liveEpoch().epoch, { mint });
    await api.beginGoogleOAuth();
    expect(mint).toHaveBeenCalledTimes(1);
    expect(api.newGoogleOAuthOperationRef()).toBe("op-ref-1");
    expect(mint).toHaveBeenCalledTimes(2);
    expect(requestApi).toHaveBeenCalledTimes(1);
  });

  // Effect identity: one operation reference is replayed across a failed attempt and a retry,
  // so no second intent is created for one logical begin.
  it("reuses one operation reference across a retry after an invalid envelope", async () => {
    const bodies: string[] = [];
    let call = 0;
    const { http } = googleHttp(async (_path, init) => {
      bodies.push(String(init?.body));
      call += 1;
      if (call === 1) return { ...beginEnvelope(validData), unexpected: true };
      return beginEnvelope(validData);
    });
    const api = createGoogleOAuthApi(http, errors, liveEpoch().epoch, { mint: () => "op-ref-1" });
    const ref = api.newGoogleOAuthOperationRef();
    await expect(api.beginGoogleOAuth(ref)).rejects.toThrow();
    const second = await api.beginGoogleOAuth(ref);
    expect(second.operationRef).toBe(ref);
    expect(bodies).toHaveLength(2);
    expect(new Set(bodies).size).toBe(1);
  });

  it("fails closed on a closed epoch without dispatching the request", async () => {
    const { api, requestApi } = deadApi();
    await expect(api.beginGoogleOAuth("op-ref-1")).rejects.toMatchObject({ code: "API_SESSION_CLOSED" });
    expect(requestApi).not.toHaveBeenCalled();
  });

  it("propagates a rejected read through the caller's error path", async () => {
    const { api } = makeApi(async () => { throw new Error("network"); });
    await expect(api.beginGoogleOAuth("op-ref-1")).rejects.toThrow(/network/);
  });
});
