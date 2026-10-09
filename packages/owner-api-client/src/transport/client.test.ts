import { describe, expect, it, vi } from "vitest";
import { createOwnerApiClient, type AuthorizationLoss, type OwnerClientPorts, type EpochPort } from "./client";
import { createSessionEpoch } from "./session/epoch";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const problem = (status: number, code: string) => json(status, { type: "urn:eliotr:problem:access", title: "Access needs review", status, code, trace_id: "trace-1", retryable: false });
function timers() {
  let next = 0; const jobs = new Map<number, () => void>();
  return {
    setTimeout: vi.fn((callback: () => void) => { next += 1; jobs.set(next, callback); return next; }),
    clearTimeout: vi.fn((handle: unknown) => { jobs.delete(handle as number); }),
    fire() { const callback = jobs.values().next().value; if (!callback) throw new Error("No deadline"); callback(); },
    size: () => jobs.size,
  };
}
function ports(fetcher: typeof fetch, clock = timers(), epoch?: EpochPort, onAuthorizationLoss?: (observation: AuthorizationLoss) => void): OwnerClientPorts {
  return { fetch: fetcher, timers: clock, baseUrl: "https://owner.test", ...(epoch === undefined ? {} : { epoch }), ...(onAuthorizationLoss === undefined ? {} : { onAuthorizationLoss }) };
}
describe("injected owner transport", () => {
  it("uses a root-relative manual/no-store/same-origin request with no retry", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(200, { ok: true })); const clock = timers();
    const client = createOwnerApiClient(ports(fetcher, clock));
    await expect(client.requestJson("/api/v1/system/health")).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const call = fetcher.mock.calls[0]; if (!call) throw new Error("No request");
    expect(call[0]).toBe("/api/v1/system/health");
    expect(call[1]).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store", redirect: "manual" });
    expect(new Headers(call[1]?.headers).get("accept")).toBe("application/json"); expect(clock.size()).toBe(0);
  });
  it("retains the network cause and removes the caller listener and timer", async () => {
    const cause = new Error("network"); const signal = new AbortController().signal; const remove = vi.spyOn(signal, "removeEventListener");
    const clock = timers(); const client = createOwnerApiClient(ports(async () => { throw cause; }, clock));
    const error = await client.requestJson("/api/v1/read", { signal }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "API_UNREACHABLE", cause }); expect(clock.size()).toBe(0); expect(remove).toHaveBeenCalledTimes(1);
  });
  it("bounds a hostile never-ending fetch by deadline", async () => {
    const clock = timers(); const client = createOwnerApiClient(ports(() => new Promise<Response>(() => {}), clock));
    const outcome = client.requestJson("/api/v1/read", { timeoutMs: 25 }).catch((error: unknown) => error);
    clock.fire(); expect(await outcome).toMatchObject({ code: "API_REQUEST_DEADLINE" }); expect(clock.size()).toBe(0);
  });
  it("preserves caller reason and does not dispatch a pre-aborted request", async () => {
    const caller = new AbortController(); const reason = new Error("left route"); const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const client = createOwnerApiClient(ports(fetcher)); const outcome = client.requestJson("/api/v1/read", { signal: caller.signal }).catch((error: unknown) => error);
    caller.abort(reason); expect(await outcome).toMatchObject({ code: "API_REQUEST_ABORTED", cause: reason });
    await expect(client.requestJson("/api/v1/read", { signal: caller.signal })).rejects.toMatchObject({ code: "API_REQUEST_ABORTED", cause: reason });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects a held old-session response after a newer epoch opens", async () => {
    const epoch = createSessionEpoch(); const held = deferred<Response>(); const client = createOwnerApiClient(ports(() => held.promise, timers(), epoch));
    const outcome = client.requestJson("/api/v1/read").catch((error: unknown) => error);
    epoch.close(); epoch.advance(); held.resolve(json(200, { private: "old" }));
    expect(await outcome).toMatchObject({ code: "API_SESSION_CLOSED" });
  });
  it("only ACCESS_403 reports auth loss, once, preserving the typed problem", async () => {
    const observed: AuthorizationLoss[] = [];
    for (const code of ["SOURCE_QUARANTINED", "ACCESS_SCOPE_DENIED"]) {
      const client = createOwnerApiClient(ports(async () => problem(403, code), timers(), undefined, value => { observed.push(value); }));
      await expect(client.requestJson("/api/v1/read")).rejects.toMatchObject({ code, status: 403, traceId: "trace-1" });
    }
    expect(observed).toHaveLength(1); expect(observed[0]).toMatchObject({ code: "ACCESS_SCOPE_DENIED", current: true });
  });
  it("preserves auth failure when the observer synchronously closes the epoch", async () => {
    const epoch = createSessionEpoch(); const client = createOwnerApiClient(ports(async () => problem(401, "ACCESS_SESSION_REQUIRED"), timers(), epoch, () => { epoch.close(); }));
    await expect(client.requestJson("/api/v1/read")).rejects.toMatchObject({ status: 401, code: "ACCESS_SESSION_REQUIRED" });
  });
  it("disposal settles outstanding requests even when fetch ignores abort", async () => {
    const clock = timers(); const client = createOwnerApiClient(ports(() => new Promise<Response>(() => {}), clock));
    const outcome = client.requestJson("/api/v1/read").catch((error: unknown) => error); client.dispose(); client.dispose();
    expect(await outcome).toMatchObject({ code: "API_SESSION_CLOSED" }); expect(clock.size()).toBe(0);
    await expect(client.requestJson("/api/v1/read")).rejects.toMatchObject({ code: "API_SESSION_CLOSED" });
  });
  it("keeps the deadline cause when a hostile body cancel throws", async () => {
    const clock = timers(); const reading = deferred<void>();
    const stream = new ReadableStream<Uint8Array>({ pull() { reading.resolve(); return new Promise<void>(() => {}); }, cancel() { throw new Error("hostile cancel"); } });
    const client = createOwnerApiClient(ports(async () => new Response(stream, { headers: { "content-type": "application/json" } }), clock));
    const outcome = client.requestJson("/api/v1/read").catch((error: unknown) => error); await reading.promise; await Promise.resolve(); await Promise.resolve();
    clock.fire(); expect(await outcome).toMatchObject({ code: "API_REQUEST_DEADLINE" }); expect(clock.size()).toBe(0); expect(stream.locked).toBe(false);
  });
  it("whole-object entry discards untyped method/body overrides and freezes media policy", async () => {
    const held = deferred<Response>(); const fetcher = vi.fn<typeof fetch>(() => held.promise); const client = createOwnerApiClient(ports(fetcher));
    const object = { expectedContentType: "text/plain" }; const hostile = { method: "POST", body: "write", headers: {} };
    const result = client.requestWholeObject("/api/v1/object", object, hostile); object.expectedContentType = "application/json";
    held.resolve(new Response("text", { headers: { "content-type": "text/plain" } }));
    expect(new TextDecoder().decode((await result).bytes)).toBe("text"); expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET" }); expect(fetcher.mock.calls[0]?.[1]?.body).toBeUndefined();
  });
  it("requires exact Range and endpoint-approved validator, with no whole fallback", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("bc", { status: 206, headers: { "content-type": "text/plain", "content-range": "bytes 1-2/4", etag: '"v1"' } }));
    const client = createOwnerApiClient(ports(fetcher));
    const result = await client.requestObjectRange("/api/v1/object", { expectedContentType: "text/plain", requestedStart: 1, requestedEnd: 2, expectedTotal: 4, expectedETag: '"v1"', conditional: "if-match" });
    expect(new TextDecoder().decode(result.bytes)).toBe("bc"); const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("range")).toBe("bytes=1-2"); expect(headers.get("if-match")).toBe('"v1"');
  });
  it("rejects protected-header conflict before deadline creation or dispatch", async () => {
    const clock = timers(); const fetcher = vi.fn<typeof fetch>(async () => json(200, {})); const client = createOwnerApiClient(ports(fetcher, clock));
    await expect(client.requestJson("/api/v1/write", { method: "POST", body: "{}", idempotencyKey: "same-operation", headers: { "idempotency-key": "different" } })).rejects.toMatchObject({ code: "API_HEADER_CONFLICT" });
    expect(fetcher).not.toHaveBeenCalled(); expect(clock.setTimeout).not.toHaveBeenCalled();
  });
});
