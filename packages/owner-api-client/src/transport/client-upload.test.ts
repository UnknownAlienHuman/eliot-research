import { describe, expect, it, vi } from "vitest";
import { createOwnerApiClient, type BinaryUploadOptions } from "./client";
import { createSessionEpoch } from "./session/epoch";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
function setup(fetcher: typeof fetch) {
  const jobs = new Map<number, () => void>(); let next = 0;
  const timers = { setTimeout: vi.fn((callback: () => void) => { jobs.set(++next, callback); return next; }), clearTimeout: vi.fn((handle: unknown) => { jobs.delete(handle as number); }) };
  const epoch = createSessionEpoch();
  return { epoch, jobs, timers, client: createOwnerApiClient({ fetch: fetcher, baseUrl: "https://owner.test", timers, epoch }) };
}
const response = (status = 200) => new Response('{"data":"receipt"}', { status, headers: { "content-type": "application/json" } });
const input = (): BinaryUploadOptions => ({ method: "POST", bytes: new Uint8Array([1, 2, 3]), maximumBytes: 3, contentType: "application/octet-stream", idempotencyKey: "capture-1" });

describe("explicit bounded binary upload", () => {
  it("freezes exact bytes and preserves protected media, identity, CSRF and status policy", async () => {
    const held = deferred<Response>(); const fetcher = vi.fn<typeof fetch>(() => held.promise); const { client, jobs } = setup(fetcher);
    const selected = input(); const outcome = client.requestBinaryJson("/api/v1/ingest/raw", { ...selected, acceptedStatuses: [201] });
    selected.bytes.fill(9); held.resolve(response(201));
    await expect(outcome).resolves.toEqual({ data: "receipt" });
    const init = fetcher.mock.calls[0]?.[1]; const headers = new Headers(init?.headers);
    expect(Array.from(init?.body as Uint8Array)).toEqual([1, 2, 3]);
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", redirect: "manual", cache: "no-store" });
    expect(headers.get("content-type")).toBe("application/octet-stream"); expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("x-eliotr-csrf")).toBe("1"); expect(headers.get("idempotency-key")).toBe("capture-1");
    expect(fetcher).toHaveBeenCalledTimes(1); expect(jobs.size).toBe(0);
  });
  it("rejects hostile media, CSRF and operation overrides before dispatch or deadline", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response()); const { client, timers } = setup(fetcher);
    for (const headers of [{ "content-type": "application/json" }, { "x-eliotr-csrf": "0" }, { "idempotency-key": "other" }]) {
      await expect(client.requestBinaryJson("/api/v1/ingest/raw", { ...input(), headers })).rejects.toMatchObject({ code: "API_HEADER_CONFLICT" });
    }
    expect(fetcher).not.toHaveBeenCalled(); expect(timers.setTimeout).not.toHaveBeenCalled();
  });
  it("requires explicit positive bounds, MIME and upload method before dispatch", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response()); const { client, timers } = setup(fetcher);
    const invalid = [{ maximumBytes: 2 }, { maximumBytes: 0 }, { maximumBytes: undefined }, { contentType: "text/plain\r\nx: y" }, { method: "GET" }, { bytes: "mutable body" }];
    for (const overrides of invalid) await expect(client.requestBinaryJson("/api/v1/ingest/raw", { ...input(), ...overrides } as unknown as BinaryUploadOptions)).rejects.toMatchObject({ code: "API_UPLOAD_INVALID" });
    expect(fetcher).not.toHaveBeenCalled(); expect(timers.setTimeout).not.toHaveBeenCalled();
  });
  it("discards late upload receipt after shared epoch replacement", async () => {
    const held = deferred<Response>(); const fetcher = vi.fn<typeof fetch>(() => held.promise); const { client, epoch, jobs } = setup(fetcher);
    const outcome = client.requestBinaryJson("/api/v1/ingest/raw", input());
    epoch.close(); epoch.advance(); held.resolve(response());
    await expect(outcome).rejects.toMatchObject({ code: "API_SESSION_CLOSED" }); expect(fetcher).toHaveBeenCalledTimes(1); expect(jobs.size).toBe(0);
  });
  it("bounds an unresponsive binary PUT using the same deadline path with no retry", async () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => {})); const { client, jobs } = setup(fetcher);
    const outcome = client.requestBinaryJson("/api/v1/ingest/bundles/parts", { ...input(), method: "PUT", timeoutMs: 10 });
    const fire = jobs.values().next().value; if (!fire) throw new Error("Missing deadline"); fire();
    await expect(outcome).rejects.toMatchObject({ code: "API_REQUEST_DEADLINE" }); expect(fetcher).toHaveBeenCalledTimes(1); expect(jobs.size).toBe(0);
  });
  it("keeps JSON entry string-only and enforces the selected upload response status", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(201)); const { client } = setup(fetcher);
    await expect(client.requestBinaryJson("/api/v1/ingest/raw", input())).rejects.toMatchObject({ code: "API_STATUS_INVALID" });
    await expect(client.requestJson("/api/v1/write", { method: "POST", body: new Uint8Array([1]) as unknown as string })).rejects.toMatchObject({ code: "API_REQUEST_INVALID" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
