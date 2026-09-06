import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeLibraryPage, readLibraryPage, LIBRARY_PAGE_SIZE } from "../apps/eliotr-pwa/src/library-api.js";
import { renderLibrary } from "../apps/eliotr-pwa/src/library-panel.js";
const envelope = () => ({ deployment_generation: "deploy-1", trace_id: "trace-1", data: {
  projects: [{ id: "project-1", title: "Project 1", generation: "1" }],
  sources: [{ id: "source-1", title: "Source 1", readiness_ref: "readiness:source-1:revision-1" }],
} });
afterEach(() => vi.unstubAllGlobals());
describe("Library wire boundary", () => {
  it("decodes a generation-bound page and preserves provenance identifiers", () => {
    expect(decodeLibraryPage(envelope(), "deploy-1")).toEqual({ ...envelope().data, generation: "deploy-1", trace: "trace-1" });
    expect(() => decodeLibraryPage(envelope(), "deploy-2")).toThrow();
  });
  it("rejects unknown fields, oversized pages, duplicate/unordered IDs and cross-source readiness", () => {
    const changes: ((value: ReturnType<typeof envelope>) => void)[] = [
      (value) => Object.assign(value, { token: "secret" }),
      (value) => Object.assign(value.data, { unexpected: true }),
      (value) => Object.assign(value.data.sources[0] ?? {}, { snippet: "unverified text" }),
      (value) => { value.data.sources = Array(LIBRARY_PAGE_SIZE + 1).fill(value.data.sources[0]); },
      (value) => { value.data.sources.push({ id: "source-1", title: "Duplicate", readiness_ref: "readiness:source-1:revision-2" }); },
      (value) => { value.data.sources.push({ id: "source-0", title: "Unordered", readiness_ref: "readiness:source-0:revision-0" }); },
      (value) => { value.data.sources[0] = { id: "source-1", title: "Bad ref", readiness_ref: "readiness:other:revision-1" }; },
      (value) => { value.data.sources[0] = { id: "source-1", title: "x".repeat(4097), readiness_ref: "readiness:source-1:revision-1" }; },
      (value) => { value.data.projects[0] = { id: "project-1", title: "bad\u0000title", generation: "1" }; },
      (value) => { value.trace_id = ""; },
      (value) => Object.assign(value.data, { next_cursor: "bad=c" }),
      (value) => Object.assign(value.data, { projects: [], sources: [], next_cursor: "cursor" }),
    ];
    for (const change of changes) { const value = envelope(); change(value); expect(() => decodeLibraryPage(value)).toThrow(); }
  });
  it("escapes source/project metadata and never turns readiness refs into ready claims", () => {
    const value = envelope();
    value.data.sources[0] = { id: "source-1", title: '<img src=x onerror="alert(1)">', readiness_ref: "readiness:source-1:revision-1" };
    const rendered = renderLibrary(decodeLibraryPage(value));
    expect(rendered).not.toContain("<img"); expect(rendered).toContain("&lt;img");
    expect(rendered).toContain("Search readiness not checked");
    expect(rendered).toContain('data-source="0"');
  });
  it("uses only the fixed catalog path, bounded limit, credentials and no-store", async () => {
    const fetched = vi.fn(async () => Response.json(envelope())); vi.stubGlobal("fetch", fetched);
    await readLibraryPage({ project: "project-1", cursor: "oldCursor", generation: "deploy-1" });
    expect(fetched.mock.calls[0]).toMatchObject(["/api/v1/research/catalog?limit=20&project_id=project-1&cursor=oldCursor",
      { credentials: "same-origin", cache: "no-store", redirect: "manual" }]);
    await readLibraryPage({ project: "https://attacker.example/" });
    expect(fetched.mock.calls[1]?.[0]).toBe("/api/v1/research/catalog?limit=20&project_id=https%3A%2F%2Fattacker.example%2F");
    await expect(readLibraryPage({ project: "invalid project" })).rejects.toThrow();
    expect(fetched).toHaveBeenCalledTimes(2);
  });
  it("rejects cursor loops, expired pages, auth errors, HTML and redirects", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ ...envelope(), data: { ...envelope().data, next_cursor: "cursor" } }));
    await expect(readLibraryPage({ cursor: "cursor" })).rejects.toThrow();
    for (const response of [new Response("<html>login</html>", { headers: { "content-type": "text/html" } }),
      new Response(null, { status: 302, headers: { location: "https://login.example/" } })]) {
      vi.stubGlobal("fetch", async () => response); await expect(readLibraryPage()).rejects.toThrow();
    }
    const problem = { type: "urn:eliotr:problem:catalog_cursor_stale", title: "Catalog changed", status: 409,
      code: "CATALOG_CURSOR_STALE", trace_id: "trace-1", retryable: true };
    vi.stubGlobal("fetch", async () => Response.json(problem, { status: 409 }));
    await expect(readLibraryPage()).rejects.toMatchObject({ code: "CATALOG_CURSOR_STALE", retryable: true, traceId: "trace-1" });
  });
  it("cancels a pending network read rather than displaying its eventual result", async () => {
    const controller = new AbortController(); vi.stubGlobal("fetch", () => new Promise(() => {}));
    const operation = readLibraryPage({}, controller.signal); controller.abort();
    await expect(operation).rejects.toMatchObject({ code: "API_REQUEST_ABORTED" });
  });
  it("clears private panels on denied or redirected responses even when the body is malformed", async () => {
    const dispatch = vi.fn(); vi.stubGlobal("window", { dispatchEvent: dispatch });
    for (const response of [new Response("<html>deny</html>", { status: 403, headers: { "content-type": "text/html" } }),
      new Response(null, { status: 401 }), new Response(null, { status: 302, headers: { location: "https://login.example/" } })]) {
      vi.stubGlobal("fetch", async () => response);
      await expect(readLibraryPage()).rejects.toThrow();
    }
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(dispatch.mock.calls.every(([event]) => event.type === "eliotr:authorization-cleared")).toBe(true);
  });

});
