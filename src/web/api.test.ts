import { afterEach, describe, expect, it, vi } from "vitest";
import { apiErrorMessage, apiJson, fetchMe } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("shared API helpers", () => {
  it("returns JSON and preserves request options, credentials overrides and signal identity", async () => {
    const response = Response.json({ text: "Кириллица 😀" });
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetch);
    const init: RequestInit = { method: "POST", credentials: "omit", cache: "no-store", signal: new AbortController().signal,
      headers: { "Content-Type": "application/json" }, body: "{}" };
    await expect(apiJson("/api/example", init)).resolves.toEqual({ text: "Кириллица 😀" });
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/example", init);
    expect(response.bodyUsed).toBe(true);
    fetch.mockResolvedValue(Response.json([]));
    await expect(apiJson("/api/defaults")).resolves.toEqual([]);
    expect(fetch).toHaveBeenLastCalledWith("/api/defaults", { credentials: "same-origin" });
  });

  it.each([
    ['{"error":{"message":"Specific failure"}}', "Specific failure"],
    ["<html>Unavailable</html>", "Request failed with status 503."],
    ["", "Request failed with status 503."],
    ["null", "Request failed with status 503."],
    ['{"message":"Different policy"}', "Request failed with status 503."],
    ['{"error":"Different policy"}', "Request failed with status 503."],
    ['{"error":{"message":""}}', "Request failed with status 503."],
    ['{"error":{"message":false}}', "Request failed with status 503."],
    ['{"error":{"message":0}}', "Request failed with status 503."],
    ['{"error":{"message":7}}', "7"],
    ['{"error":{"message":{}}}', "[object Object]"],
  ])("retains the existing JSON error policy for %s", async (body, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 503 })));
    await expect(apiJson("/api/example")).rejects.toThrow(message);
  });

  it("uses the actual status for unreadable errors and keeps a raw response's status", async () => {
    const response = new Response("broken JSON", { status: 409 });
    expect(await apiErrorMessage(response)).toBe("Request failed with status 409.");
    expect(response.status).toBe(409);
    expect(await apiErrorMessage(response)).toBe("Request failed with status 409.");
  });

  it.each([200, 204])("does not turn an empty/non-JSON success into a status error (%s)", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(status === 204 ? null : "not JSON", { status })));
    await expect(apiJson("/api/example")).rejects.toBeInstanceOf(SyntaxError);
  });

  it("passes abort and network failures through without retry or replacement", async () => {
    const abort = new AbortController(), failure = new DOMException("Cancelled", "AbortError");
    const fetch = vi.fn((_path: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(failure), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);
    const result = apiJson("/api/example", { signal: abort.signal });
    abort.abort();
    await expect(result).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1].signal).toBe(abort.signal);
    const offline = new TypeError("Offline");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(offline));
    await expect(apiJson("/api/example")).rejects.toBe(offline);
  });

  it("keeps the Access reader's separate status-only failure and request defaults", async () => {
    const response = Response.json({ error: { message: "API parser must not replace the Access status" } }, { status: 401 });
    const fetch = vi.fn().mockResolvedValue(response), signal = new AbortController().signal;
    vi.stubGlobal("fetch", fetch);
    await expect(fetchMe(signal)).rejects.toMatchObject({ message: "Request failed with status 401.", status: 401 });
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/me", {
      headers: { Accept: "application/json" }, cache: "no-store", credentials: "same-origin", signal,
    });
    expect(response.bodyUsed).toBe(false);
  });
});
