import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeLibraryPage, readLibraryPage, LIBRARY_PAGE_SIZE } from "../apps/eliotr-pwa/src/library-api.js";
import { renderLibrary } from "../apps/eliotr-pwa/src/library-panel.js";
import { isOwnerSessionUnexpired, readOwnerSession, type OwnerSession } from "../apps/eliotr-pwa/src/owner-session-api.js";
import {
  createOwnerNamespaceResumeCoordinator,
  type SourceNamespaceSummary,
} from "../apps/eliotr-pwa/src/source-namespace-api.js";
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
    value.data.projects[0] = { id: "project-1", title: '<svg onload="alert(1)">Project</svg>', generation: "1" };
    value.data.sources[0] = { id: "source-1", title: '<img src=x onerror="alert(1)">', readiness_ref: "readiness:source-1:revision-1" };
    const rendered = renderLibrary(decodeLibraryPage(value));
    expect(rendered).not.toContain("<img"); expect(rendered).not.toContain("<svg");
    expect(rendered).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(rendered).toContain("&lt;svg onload=&quot;alert(1)&quot;&gt;Project&lt;/svg&gt;");
    expect(rendered).toContain("Source details and versions");
    expect(rendered).toContain("Versions and recorded states");
    expect(rendered).not.toContain("readiness:source-1:revision-1");
    expect(rendered).not.toMatch(/\bready\b/iu);
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
    // 401 and 302 redirect clear the session even with malformed/empty bodies.
    // 403 with a malformed body is NOT an authorization loss: only an explicit
    // ACCESS_* code clears (resource/policy 403s must not wipe the session).
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls.every(([event]) => event.type === "eliotr:authorization-cleared")).toBe(true);
  });

});

describe("verified owner namespace resume lifecycle", () => {
  const sessionExpiry = "2030-01-01T00:00:00.000Z";
  const ownerSessionEnvelope = (generation = "deploy-1", credential = "credential-1") => ({
    deployment_generation: generation,
    trace_id: "trace-session",
    data: {
      protocol: "eliotr.owner-session.v1",
      principal_ref: "principal-owner",
      client_class: "owner_pwa",
      credential_generation: credential,
      expires_at: sessionExpiry,
    },
  });
  const row = (
    id: string,
    readAccess: "ACTIVE" | "EXPIRED",
    policyGeneration: number,
    expiresAt: string,
  ): SourceNamespaceSummary => ({
    source_namespace_id: id,
    title: `Workspace ${id}`,
    read_access: readAccess,
    read_policy_generation: policyGeneration,
    read_expires_at: expiresAt,
  });
  const catalogEnvelope = (namespaces: readonly SourceNamespaceSummary[], generation = "deploy-1") => ({
    deployment_generation: generation,
    trace_id: "trace-catalog",
    data: { protocol: "eliotr.owner-namespaces.v1", profiles: [], namespaces },
  });
  const renewalEnvelope = (id: string, title: string, policyGeneration: number, expiresAt = sessionExpiry, generation = "deploy-1") => ({
    deployment_generation: generation,
    trace_id: "trace-renewal",
    data: {
      protocol: "eliotr.owner-namespace-renewal.v1",
      source_namespace_id: id,
      title,
      read_policy_generation: policyGeneration,
      read_expires_at: expiresAt,
      read_access: "ACTIVE",
    },
  });
  const problem = (status = 409) => Response.json({
    type: "urn:eliotr:problem:namespace_read_policy_conflict",
    title: "Workspace access changed",
    status,
    code: "NAMESPACE_READ_POLICY_CONFLICT",
    trace_id: "trace-conflict",
    retryable: true,
  }, { status });

  it("verifies the owner session, restores every eligible workspace, and no-ops after refresh", async () => {
    let namespaces: SourceNamespaceSummary[] = [
      row("expired-1", "EXPIRED", 3, "2029-12-31T20:00:00.000Z"),
      row("active-short", "ACTIVE", 8, "2029-12-31T23:59:00.000Z"),
      row("already-covered", "ACTIVE", 2, "2030-01-01T00:00:01.000Z"),
      { source_namespace_id: "no-policy", title: "Workspace no-policy" },
    ];
    const requests: { path: string; method: string; init?: RequestInit }[] = [];
    const fetched = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      const method = init?.method ?? "GET";
      requests.push({ path, method, ...(init === undefined ? {} : { init }) });
      if (path === "/api/v1/system/session") return Response.json(ownerSessionEnvelope());
      if (path === "/api/v1/library/namespaces" && method === "GET") return Response.json(catalogEnvelope(namespaces));
      if (path.endsWith("/renew") && method === "POST") {
        const id = decodeURIComponent(path.split("/").at(-2) ?? "");
        const body = JSON.parse(String(init?.body)) as { expected_generation?: number };
        const prior = namespaces.find((item) => item.source_namespace_id === id);
        if (prior === undefined || prior.read_policy_generation === undefined) throw new Error("unexpected renewal target");
        if (body.expected_generation !== prior.read_policy_generation) throw new Error("renewal generation did not match catalog");
        namespaces = namespaces.map((item) => item.source_namespace_id === id
          ? row(id, "ACTIVE", prior.read_policy_generation + 1, sessionExpiry)
          : item);
        return Response.json(renewalEnvelope(id, prior.title, prior.read_policy_generation + 1));
      }
      throw new Error(`unexpected API request: ${method} ${path}`);
    });
    vi.stubGlobal("fetch", fetched);

    const session = await readOwnerSession("deploy-1");
    let currentSession: OwnerSession | undefined = session;
    const coordinator = createOwnerNamespaceResumeCoordinator({
      readCatalog: (generation, signal) => import("../apps/eliotr-pwa/src/source-namespace-api.js").then(({ readSourceNamespaces }) => readSourceNamespaces(generation, signal)),
      renewNamespace: async (...args) => {
        const { renewSourceNamespace } = await import("../apps/eliotr-pwa/src/source-namespace-api.js");
        return renewSourceNamespace(...args);
      },
      isCurrent: (binding) => currentSession === binding.session && binding.deploymentGeneration === "deploy-1" && isOwnerSessionUnexpired(binding.session),
    });

    const resumed = await coordinator.run(session, "deploy-1");
    expect(resumed.renewedNamespaceIds).toEqual(["expired-1", "active-short"]);
    expect(resumed.confirmedNamespaceIds).toEqual([]);
    expect(resumed.unresolvedNamespaceIds).toEqual([]);
    expect(resumed.catalog?.namespaces.find((item) => item.source_namespace_id === "expired-1"))
      .toMatchObject({ read_access: "ACTIVE", read_policy_generation: 4, read_expires_at: sessionExpiry });
    const renewRequests = requests.filter((request) => request.method === "POST");
    expect(renewRequests.map((request) => request.path)).toEqual([
      "/api/v1/library/namespaces/expired-1/renew",
      "/api/v1/library/namespaces/active-short/renew",
    ]);
    expect(renewRequests.map(({ init }) => JSON.parse(String(init?.body)))).toEqual([
      { expected_generation: 3 }, { expected_generation: 8 },
    ]);
    expect(renewRequests.every(({ init }) => (init?.headers as Record<string, string>)?.["x-eliotr-csrf"] === "1")).toBe(true);
    expect(requests.map(({ path }) => path)).toEqual([
      "/api/v1/system/session",
      "/api/v1/library/namespaces",
      "/api/v1/library/namespaces/expired-1/renew",
      "/api/v1/library/namespaces/active-short/renew",
    ]);
    expect(requests.some(({ path }) => /question|research|model|chat/iu.test(path))).toBe(false);

    const refreshed = await coordinator.run(session, "deploy-1");
    expect(refreshed.renewedNamespaceIds).toEqual([]);
    expect(refreshed.unresolvedNamespaceIds).toEqual([]);
    expect(requests.filter(({ method }) => method === "POST")).toHaveLength(2);
    currentSession = undefined;
  });

  it("coalesces the same session and discards an older credential/deployment completion", async () => {
    let deployment = "deploy-1";
    let activeSession: OwnerSession | undefined;
    let resolveFirstCatalog: ((value: Response) => void) | undefined;
    let catalogReads = 0;
    const firstCatalog = new Promise<Response>((resolve) => { resolveFirstCatalog = resolve; });
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
      const path = String(input);
      requests.push(path);
      if (path === "/api/v1/system/session") return Response.json(ownerSessionEnvelope(deployment, deployment === "deploy-1" ? "credential-1" : "credential-2"));
      if (path === "/api/v1/library/namespaces") {
        catalogReads += 1;
        if (catalogReads === 1) return firstCatalog;
        return Response.json(catalogEnvelope([row("covered", "ACTIVE", 2, "2030-01-02T00:00:00.000Z")], deployment));
      }
      throw new Error(`unexpected API request: ${path}`);
    });
    const session1 = await readOwnerSession("deploy-1");
    activeSession = session1;
    const coordinator = createOwnerNamespaceResumeCoordinator({
      readCatalog: (generation, signal) => import("../apps/eliotr-pwa/src/source-namespace-api.js").then(({ readSourceNamespaces }) => readSourceNamespaces(generation, signal)),
      renewNamespace: async (...args) => {
        const { renewSourceNamespace } = await import("../apps/eliotr-pwa/src/source-namespace-api.js");
        return renewSourceNamespace(...args);
      },
      isCurrent: (binding) => activeSession === binding.session && deployment === binding.deploymentGeneration && isOwnerSessionUnexpired(binding.session),
    });
    const oldCompletion = coordinator.run(session1, "deploy-1");
    const coalesced = coordinator.run(session1, "deploy-1");
    expect(coalesced).toBe(oldCompletion);
    await vi.waitFor(() => expect(catalogReads).toBe(1));

    deployment = "deploy-2";
    const session2 = await readOwnerSession("deploy-2");
    activeSession = session2;
    const currentCompletion = await coordinator.run(session2, "deploy-2");
    resolveFirstCatalog?.(Response.json(catalogEnvelope([row("stale", "EXPIRED", 1, "2029-12-31T00:00:00.000Z")], "deploy-1")));
    const stale = await oldCompletion;
    expect(currentCompletion.stale).toBe(false);
    expect(stale).toMatchObject({ stale: true, renewedNamespaceIds: [], confirmedNamespaceIds: [], unresolvedNamespaceIds: [] });
    expect(requests.some((path) => path.endsWith("/stale/renew"))).toBe(false);
    expect(requests.some((path) => /question|research|model|chat/iu.test(path))).toBe(false);
  });

  it("uses one exact readback after 409 and retains honest unresolved state when readback does not advance", async () => {
    const original = row("race", "ACTIVE", 5, "2029-12-31T23:00:00.000Z");
    let namespaces: SourceNamespaceSummary[] = [original];
    let advanceOnConflict = true;
    const requests: { path: string; method: string }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      const method = init?.method ?? "GET";
      requests.push({ path, method });
      if (path === "/api/v1/system/session") return Response.json(ownerSessionEnvelope());
      if (path === "/api/v1/library/namespaces" && method === "GET") return Response.json(catalogEnvelope(namespaces));
      if (path.endsWith("/race/renew")) {
        if (advanceOnConflict) namespaces = [row("race", "ACTIVE", 6, sessionExpiry)];
        return problem();
      }
      throw new Error(`unexpected API request: ${method} ${path}`);
    });
    const session = await readOwnerSession("deploy-1");
    const coordinator = createOwnerNamespaceResumeCoordinator({
      readCatalog: (generation, signal) => import("../apps/eliotr-pwa/src/source-namespace-api.js").then(({ readSourceNamespaces }) => readSourceNamespaces(generation, signal)),
      renewNamespace: async (...args) => {
        const { renewSourceNamespace } = await import("../apps/eliotr-pwa/src/source-namespace-api.js");
        return renewSourceNamespace(...args);
      },
      isCurrent: (binding) => binding.session === session && binding.deploymentGeneration === "deploy-1",
    });
    const confirmed = await coordinator.run(session, "deploy-1");
    expect(confirmed.confirmedNamespaceIds).toEqual(["race"]);
    expect(confirmed.unresolvedNamespaceIds).toEqual([]);
    expect(requests.map(({ method }) => method)).toEqual(["GET", "GET", "POST", "GET"]);

    namespaces = [original];
    advanceOnConflict = false;
    requests.length = 0;
    const staleReadback = await coordinator.run(session, "deploy-1");
    expect(staleReadback.confirmedNamespaceIds).toEqual([]);
    expect(staleReadback.unresolvedNamespaceIds).toEqual(["race"]);
    expect(staleReadback.renewedNamespaceIds).toEqual([]);
    expect(requests.filter(({ method }) => method === "POST")).toHaveLength(1);
    expect(requests.at(-1)?.path).toBe("/api/v1/library/namespaces");
  });

  it("does not claim a malformed renewal receipt as success", async () => {
    const staleRow = row("malformed", "EXPIRED", 11, "2029-12-31T00:00:00.000Z");
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/api/v1/system/session") return Response.json(ownerSessionEnvelope());
      if (path === "/api/v1/library/namespaces") return Response.json(catalogEnvelope([staleRow]));
      if (path.endsWith("/malformed/renew")) return Response.json(renewalEnvelope("malformed", staleRow.title, 13));
      throw new Error(`unexpected API request: ${path}`);
    });
    const session = await readOwnerSession("deploy-1");
    const coordinator = createOwnerNamespaceResumeCoordinator({
      readCatalog: (generation, signal) => import("../apps/eliotr-pwa/src/source-namespace-api.js").then(({ readSourceNamespaces }) => readSourceNamespaces(generation, signal)),
      renewNamespace: async (...args) => {
        const { renewSourceNamespace } = await import("../apps/eliotr-pwa/src/source-namespace-api.js");
        return renewSourceNamespace(...args);
      },
      isCurrent: (binding) => binding.session === session && binding.deploymentGeneration === "deploy-1",
    });
    const result = await coordinator.run(session, "deploy-1");
    expect(result.renewedNamespaceIds).toEqual([]);
    expect(result.unresolvedNamespaceIds).toEqual(["malformed"]);
    expect(requests.filter((request) => request.startsWith("POST "))).toHaveLength(1);
    expect(isOwnerSessionUnexpired({ ...session, expires_at: "2020-01-01T00:00:00.000Z" })).toBe(false);
  });
});
