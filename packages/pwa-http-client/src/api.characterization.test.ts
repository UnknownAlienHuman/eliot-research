import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, isAuthorizationLoss, requestApi, requestApiBytes } from "./api.js";

/**
 * Characterization of the current same-origin transport, frozen before the C1 authorization hook
 * refactor. These assertions pin real behavior of the code being extracted, including the window
 * side effect. C1 replaces the global dispatch with an injected observation and must update this file
 * deliberately rather than mechanically.
 */

const JSON_RESPONSE = { "content-type": "application/json" };
const EVENT_NAME = "eliotr:authorization-cleared";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_RESPONSE });
}

beforeEach(() => {
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("characterization: untrusted response bodies fail closed", () => {
  it("never decodes an HTML login page as a successful API response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>login</html>", {
      status: 200, headers: { "content-type": "text/html" },
    })));
    await expect(requestApi("/api/v1/system/health")).rejects.toMatchObject({
      code: "API_RESPONSE_SCHEMA_MISMATCH", status: 502,
    });
  });

  it("rejects a body that is not valid UTF-8", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([255]), {
      status: 200, headers: JSON_RESPONSE,
    })));
    await expect(requestApi("/api/v1/system/health")).rejects.toMatchObject({
      code: "MALFORMED_JSON_RESPONSE", status: 502,
    });
  });

  it("rejects a truncated JSON document", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{", { status: 200, headers: JSON_RESPONSE })));
    await expect(requestApi("/api/v1/system/health")).rejects.toMatchObject({
      code: "MALFORMED_JSON_RESPONSE", status: 502,
    });
  });

  it("bounds the streamed body and rejects an oversized response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(512 * 1024 + 1), {
      status: 200, headers: JSON_RESPONSE,
    })));
    await expect(requestApi("/api/v1/system/health")).rejects.toMatchObject({
      code: "API_RESPONSE_TOO_LARGE", status: 502,
    });
  });

  it("bounds an oversized body by chunk count even inside the byte budget", async () => {
    const chunk = new Uint8Array(1024);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 4097; index += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: JSON_RESPONSE })));
    await expect(requestApi("/api/v1/system/health")).rejects.toMatchObject({
      code: "API_RESPONSE_TOO_LARGE", status: 502,
    });
  });

  it("rejects a redirect by refusing to navigate away from the current document", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
      status: 302, headers: { location: "https://login.example/" },
    })));
    await expect(requestApi("/api/v1/system/health")).rejects.toMatchObject({
      code: "ACCESS_SESSION_REQUIRED", status: 401,
    });
  });
});

describe("characterization: authorization loss emits exactly one legacy event", () => {
  it("dispatches the window event once for a 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      type: "urn:eliotr:problem:access_required", title: "Sign in", status: 401,
      code: "ACCESS_REQUIRED", trace_id: "trace-1", retryable: false,
    }, 401)));
    await expect(requestApi("/api/v1/system/session")).rejects.toMatchObject({ status: 401 });
    expect(window.dispatchEvent).toHaveBeenCalledTimes(1);
    expect((window.dispatchEvent as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBeInstanceOf(Event);
    expect((window.dispatchEvent as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.type).toBe(EVENT_NAME);
  });

  it("dispatches the window event once for an access loss encoded as 403", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      type: "urn:eliotr:problem:access_revoked", title: "Access lost", status: 403,
      code: "ACCESS_REVOKED", trace_id: "trace-2", retryable: false,
    }, 403)));
    await expect(requestApi("/api/v1/system/session")).rejects.toMatchObject({ status: 403 });
    expect(window.dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch the window event for a policy denial", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      type: "urn:eliotr:problem:denied", title: "Read denied", status: 403,
      code: "DENIED", trace_id: "trace-3", retryable: false,
    }, 403)));
    await expect(requestApi("/api/v1/system/session")).rejects.toMatchObject({ status: 403 });
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });

  it("keeps the authorization split on the predicate itself", () => {
    const loss = new ApiRequestError({ status: 401, code: "ACCESS_REQUIRED", message: "" });
    const accessDenied = new ApiRequestError({ status: 403, code: "ACCESS_REVOKED", message: "" });
    const policyDenied = new ApiRequestError({ status: 403, code: "DENIED", message: "" });
    expect(isAuthorizationLoss(loss)).toBe(true);
    expect(isAuthorizationLoss(accessDenied)).toBe(true);
    expect(isAuthorizationLoss(policyDenied)).toBe(false);
  });
});

describe("characterization: cancellation and deadline behavior", () => {
  it("reports a missed deadline as an aborted request distinct from a network failure", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    const pending = expect(requestApi("/api/v1/system/health")).rejects.toMatchObject({
      code: "API_REQUEST_ABORTED", status: 503, retryable: true,
    });
    await vi.advanceTimersByTimeAsync(30_001);
    await pending;
  });

  it("reports a failed transport as unreachable rather than aborted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network down"); }));
    await expect(requestApi("/api/v1/system/health")).rejects.toMatchObject({
      code: "API_UNREACHABLE", status: 503, retryable: true,
    });
  });

  it("keeps a late caller abort from consuming a successful response", async () => {
    // The deadline wrapper races the real reader, so a body that never settles cannot be read at all.
    // This pins the guard the extraction must keep: an abort must reject the request rather than let
    // the caller signal fall through to a response nobody consumes.
    let internalAborted = false;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      init.signal?.addEventListener("abort", () => { internalAborted = true; }, { once: true });
      const body = new ReadableStream<Uint8Array>({ start() {} });
      return new Response(body, { status: 200, headers: JSON_RESPONSE });
    }));
    const controller = new AbortController();
    const pending = expect(requestApi("/api/v1/system/health", { signal: controller.signal }))
      .rejects.toMatchObject({ code: "API_REQUEST_ABORTED", status: 503, retryable: true });
    controller.abort();
    await pending;
    expect(internalAborted).toBe(true);
  });
});

describe("characterization: problem bodies fail closed on drift", () => {
  it("rejects a problem whose status disagrees with the HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      type: "urn:eliotr:problem:drift", title: "Drift", status: 500,
      code: "DRIFT", trace_id: "trace-4", retryable: false,
    }, 503)));
    await expect(requestApi("/api/v1/system/session")).rejects.toMatchObject({
      code: "MALFORMED_API_PROBLEM", status: 503,
    });
  });

  it("rejects a problem with a missing retryable flag", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      type: "urn:eliotr:problem:drift", title: "Drift", status: 503,
      code: "DRIFT", trace_id: "trace-5",
    }, 503)));
    await expect(requestApi("/api/v1/system/session")).rejects.toMatchObject({
      code: "MALFORMED_API_PROBLEM", status: 503,
    });
  });
});

describe("characterization: path policy", () => {
  it.each([
    ["an absolute foreign origin", "https://elsewhere.example/api/v1/system/health"],
    ["a protocol relative origin", "//elsewhere.example/api/v1/system/health"],
    ["a backslash path separator", "/api/v1/system" + String.fromCharCode(92) + "health"],
    ["an encoded parent segment", "/api/v1/%2e%2e/system/health"],
    ["a fragment marker", "/api/v1/system/health#section"],
    ["a control character", "/api/v1/system" + String.fromCharCode(0) + "/health"],
  ])("refuses to send a request for %s", async (_label, path) => {
    const fetcher = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetcher);
    await expect(requestApi(path)).rejects.toMatchObject({
      code: "API_PATH_INVALID", status: 400,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("characterization: bounded binary transport", () => {
  it("accepts a bounded text object and rejects an unexpected media type", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("evidence bytes", {
      status: 200, headers: { "content-type": "application/json" },
    })));
    await expect(requestApiBytes("/api/v1/library/content", undefined, 1024, "text/plain"))
      .rejects.toMatchObject({ code: "API_RESPONSE_SCHEMA_MISMATCH", status: 502 });
  });

  it("cannot reject a 206 from a whole object read because the current single reader accepts 200 and 206", async () => {
    // Honest characterization of the current legacy transport. One bounded reader serves both whole
    // and partial responses, so a server side Range answer cannot be distinguished from a whole
    // answer by status alone. C1 separates requestWholeObject (200 only) from requestObjectRange
    // (206 only, with Content-Range validation), and must replace this expectation deliberately.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("partial", {
      status: 206, headers: { "content-type": "text/plain" },
    })));
    await expect(requestApiBytes("/api/v1/library/content", undefined, 1024, "text/plain"))
      .resolves.toMatchObject({ bytes: new Uint8Array([...new TextEncoder().encode("partial")]) });
  });

  it("rejects an unexpected completion status from the bounded reader", async () => {
    // A 415 carries a typed problem body, which is the only non 200 or 206 completion the server can
    // emit with a body, so this pins the status policy without constructing a bodiless response.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      type: "urn:eliotr:problem:unsupported", title: "Range not supported", status: 415,
      code: "RANGE_UNSUPPORTED", trace_id: "trace-6", retryable: false,
    }, 415)));
    await expect(requestApiBytes("/api/v1/library/content", undefined, 1024, "text/plain"))
      .rejects.toMatchObject({ code: "RANGE_UNSUPPORTED", status: 415 });
  });
});
