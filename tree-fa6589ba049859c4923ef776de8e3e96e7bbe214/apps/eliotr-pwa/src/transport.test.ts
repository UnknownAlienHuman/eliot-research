import { afterEach, describe, expect, it, vi } from "vitest";
import { requestApi } from "./api.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("same-origin PWA transport", () => {
  it("never calls an arbitrary origin or follows a login redirect", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://login.example" } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(requestApi("https://elsewhere.example/api/v1/test")).rejects.toMatchObject({ code: "API_PATH_INVALID" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(requestApi("/api/v1/test")).rejects.toMatchObject({ code: "ACCESS_SESSION_REQUIRED" });
    expect(fetcher.mock.calls).toHaveLength(1);
  });
  it.each([
    ["text/html", "<html>login</html>", "API_RESPONSE_SCHEMA_MISMATCH"],
    ["application/json", new Uint8Array([255]), "MALFORMED_JSON_RESPONSE"],
    ["application/json", "{", "MALFORMED_JSON_RESPONSE"],
    ["application/json", "x".repeat(512 * 1024 + 1), "API_RESPONSE_TOO_LARGE"],
  ])("rejects untrusted response body %s", async (type, body, code) => {
    vi.stubGlobal("fetch", async () => new Response(body, { headers: { "content-type": type } }));
    await expect(requestApi("/api/v1/test")).rejects.toMatchObject({ code });
  });
  it("bounds stalled connection and stalled stream even when transport ignores abort", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const connection = expect(requestApi("/api/v1/test")).rejects.toMatchObject({ code: "API_REQUEST_ABORTED" });
    await vi.advanceTimersByTimeAsync(30001); await connection;
    let cancelled = false;
    vi.stubGlobal("fetch", async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      headers: { "content-type": "application/json" },
    }));
    const stream = expect(requestApi("/api/v1/test")).rejects.toMatchObject({ code: "API_REQUEST_ABORTED" });
    await vi.advanceTimersByTimeAsync(30001); await stream;
    expect(cancelled).toBe(true);
  });
  it("preserves typed problems and sends no-store same-origin requests", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe("manual"); expect(init.credentials).toBe("same-origin"); expect(init.cache).toBe("no-store");
      return Response.json({ type: "urn:eliotr:problem:denied", code: "DENIED", title: "Read denied", status: 403,
        trace_id: "trace-id", retryable: false }, { status: 403 });
    });
    await expect(requestApi("/api/v1/test")).rejects.toMatchObject({ code: "DENIED", status: 403, traceId: "trace-id", retryable: false });
  });
});
