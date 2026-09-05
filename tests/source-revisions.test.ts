import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeSourceRevisions, readSourceRevisionsPage } from "../apps/eliotr-pwa/src/source-revisions-api.js";
import { renderSourceRevisions } from "../apps/eliotr-pwa/src/source-revisions-panel.js";
const envelope = () => ({ deployment_generation: "deploy-1", trace_id: "trace-1", data: {
  protocol: "eliotr.source-revisions.v1", source_id: "source-1", head_revision_ref: "revision-2", readiness_basis: "RECORDED_ONLY",
  observed_at: "2026-09-05T12:00:00.000Z", revisions: [{ source_revision_ref: "revision-2", content_sha256: "a".repeat(64),
    captured_at: "2026-09-01T12:00:00.000Z", admitted_at: "2026-09-02T12:00:00.000Z", quality_state: "standard", currentness_state: "unknown",
    readiness: [{ source_revision_ref: "revision-2", channel: "lexical_ready", state: "ready", generation: "projection-1",
      receipt_ref: "receipt-1", reason_codes: [] as string[], observed_at: "2026-09-02T12:00:00.000Z" }] }] },
});
afterEach(() => vi.unstubAllGlobals());
describe("source history PWA boundary", () => {
  it("decodes only the expected source and deployment and retains recorded readiness provenance", () => {
    const page = decodeSourceRevisions(envelope(), "source-1", "deploy-1");
    expect(page.revisions[0]?.readiness[0]).toEqual(envelope().data.revisions[0]?.readiness[0]);
    expect(() => decodeSourceRevisions(envelope(), "other", "deploy-1")).toThrow();
    expect(() => decodeSourceRevisions(envelope(), "source-1", "deploy-2")).toThrow();
  });
  it("rejects unknown fields, invented authority, invalid dates/hashes and unbounded data", () => {
    const changes: ((value: ReturnType<typeof envelope>) => void)[] = [
      (value) => Object.assign(value, { secret: "not-allowed" }),
      (value) => Object.assign(value.data, { granted: true }),
      (value) => { value.data.protocol = "other"; },
      (value) => { value.data.readiness_basis = "VERIFIED"; },
      (value) => { value.data.observed_at = "yesterday"; },
      (value) => { value.trace_id = ""; },
      (value) => { value.data.revisions = Array(11).fill(value.data.revisions[0]); },
      (value) => Object.assign(value.data.revisions[0] ?? {}, { snippet: "unverified content" }),
      (value) => { if (value.data.revisions[0]) value.data.revisions[0].content_sha256 = "not-a-sha"; },
      (value) => { if (value.data.revisions[0]) value.data.revisions[0].admitted_at = "today"; },
      (value) => { if (value.data.revisions[0]) value.data.revisions[0].currentness_state = "verified"; },
      (value) => { if (value.data.revisions[0]) value.data.revisions[0].quality_state = "perfect"; },
      (value) => Object.assign(value.data, { next_cursor: "bad=value" }),
      (value) => Object.assign(value.data, { revisions: [], next_cursor: "cursor" }),
    ];
    for (const mutate of changes) { const value = envelope(); mutate(value); expect(() => decodeSourceRevisions(value, "source-1", "deploy-1")).toThrow(); }
  });
  it("rejects duplicate revisions and out-of-order pages", () => {
    const value = envelope(); const row = value.data.revisions[0]; if (!row) throw new Error("fixture");
    value.data.revisions.push(row);
    expect(() => decodeSourceRevisions(value, "source-1", "deploy-1")).toThrow();
    value.data.revisions[1] = { ...row, source_revision_ref: "revision-3", readiness: [] };
    expect(() => decodeSourceRevisions(value, "source-1", "deploy-1")).toThrow();
  });
  it("rejects readiness for another revision, repeated channels/reasons, unknown states and overlong reasons", () => {
    const changes = [
      { source_revision_ref: "other-revision" }, { state: "verified" }, { channel: "made-up" },
      { reason_codes: ["DUP", "DUP"] }, { receipt_ref: "x".repeat(257) },
      { reason_codes: Array.from({ length: 17 }, (_, n) => `reason-${n}`) },
      { reason_codes: ["a".repeat(256), "b".repeat(256), "c".repeat(256), "d".repeat(256)] },
    ];
    for (const change of changes) {
      const value = envelope(); Object.assign(value.data.revisions[0]?.readiness[0] ?? {}, change);
      expect(() => decodeSourceRevisions(value, "source-1", "deploy-1")).toThrow();
    }
    const value = envelope(); const first = value.data.revisions[0]?.readiness[0];
    if (!first) throw new Error("fixture"); value.data.revisions[0]?.readiness.push(first);
    expect(() => decodeSourceRevisions(value, "source-1", "deploy-1")).toThrow();
  });
  it("shows missing channels as not recorded, not not_requested or ready, and never claims evidence resolution", () => {
    const rendered = renderSourceRevisions(decodeSourceRevisions(envelope(), "source-1", "deploy-1"));
    expect(rendered).toContain("Current head"); expect(rendered).toContain("Content SHA-256");
    expect(rendered).toContain("<dt>exact_ready</dt><dd>Not recorded</dd>");
    expect(rendered).toContain("receipt-1"); expect(rendered).toContain("does not validate the current index or resolve evidence");
    const value = envelope(); if (value.data.revisions[0]) value.data.revisions[0].readiness = [];
    expect(renderSourceRevisions(decodeSourceRevisions(value, "source-1", "deploy-1"))).not.toContain("not_requested");
  });
  it("escapes all rendered metadata even if a caller bypasses transport decoding", () => {
    const page = decodeSourceRevisions(envelope(), "source-1", "deploy-1");
    const row = page.revisions[0]; if (!row) throw new Error("fixture");
    const rendered = renderSourceRevisions({ ...page, revisions: [{ ...row, source_revision_ref: '<img src=x onerror="alert(1)">' }] });
    expect(rendered).not.toContain("<img"); expect(rendered).toContain("&lt;img");
  });
  it("uses fixed owner-only path, encoded IDs, bounded limit and no-store credentials", async () => {
    const fetched = vi.fn(async () => Response.json(envelope())); vi.stubGlobal("fetch", fetched);
    await readSourceRevisionsPage("source-1", "deploy-1", "cursor");
    expect(fetched.mock.calls[0]).toMatchObject(["/api/v1/library/revisions?source_id=source-1&limit=10&cursor=cursor",
      { credentials: "same-origin", cache: "no-store", redirect: "manual" }]);
    await expect(readSourceRevisionsPage("bad source", "deploy-1")).rejects.toThrow();
    await expect(readSourceRevisionsPage("source-1", "deploy-1", "bad=c")).rejects.toThrow();
    expect(fetched).toHaveBeenCalledTimes(1);
  });
  it("rejects cursor loops, typed denial, redirects and HTML without fallback", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ ...envelope(), data: { ...envelope().data, next_cursor: "cursor" } }));
    await expect(readSourceRevisionsPage("source-1", "deploy-1", "cursor")).rejects.toThrow();
    const denial = { type: "urn:eliotr:problem:library_source_not_found", title: "Readable source not found", status: 404,
      code: "LIBRARY_SOURCE_NOT_FOUND", trace_id: "trace-1", retryable: false };
    vi.stubGlobal("fetch", async () => Response.json(denial, { status: 404 }));
    await expect(readSourceRevisionsPage("source-1", "deploy-1")).rejects.toMatchObject({ status: 404, code: "LIBRARY_SOURCE_NOT_FOUND" });
    for (const response of [new Response("<html>login</html>", { headers: { "content-type": "text/html" } }), new Response(null, { status: 302 })]) {
      vi.stubGlobal("fetch", async () => response); await expect(readSourceRevisionsPage("source-1", "deploy-1")).rejects.toThrow();
    }
  });
  it("honors cancellation and clears authorization even on a malformed denied response", async () => {
    const abort = new AbortController(); vi.stubGlobal("fetch", () => new Promise(() => {}));
    const request = readSourceRevisionsPage("source-1", "deploy-1", undefined, abort.signal); abort.abort();
    await expect(request).rejects.toMatchObject({ code: "API_REQUEST_ABORTED" });
    const dispatch = vi.fn(); vi.stubGlobal("window", { dispatchEvent: dispatch });
    vi.stubGlobal("fetch", async () => new Response("denied", { status: 403 }));
    await expect(readSourceRevisionsPage("source-1", "deploy-1")).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledOnce();
  });
});
