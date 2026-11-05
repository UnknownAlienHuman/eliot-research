// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useParams } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Reader, SourcesPane } from "./Library";
import type { SourceSelection } from "../shared/api";

vi.mock("./Understanding", () => ({ SourceUnderstanding: () => null }));
vi.mock("./Ocr", () => ({ SourceOcr: () => null }));

const TEXT = "Before.\n\nТочный текст\n\nAfter.";
const selected = new TextDecoder().decode(new TextEncoder().encode(TEXT).subarray(9, 28));
const path = (source = "s1", revision = "r1") => `/p/p1/source/${source}?revisionId=${revision}&start=9&end=28`;
let root: Root, host: HTMLDivElement;
let router: ReturnType<typeof createMemoryRouter>;
let requests: string[];
let respond: (url: URL) => Promise<Response>;
let sourceResponse: ((url: URL) => Promise<Response>) | undefined;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const failure = (part: string) => json({ error: { message: `Temporary ${part} failure.` } }, 503);
function success(url: URL) {
  const revision = url.pathname.split("/")[3];
  return url.pathname.endsWith("/text") ? new Response(TEXT + " " + revision) : json({ blocks: [] });
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function open() {
  router = createMemoryRouter([{ path: "/p/:projectId/source/:sourceId", element: <Reader replacingSources={new Set()} beginReplacement={() => false} endReplacement={() => {}} onUseQuestion={() => {}} /> }], { initialEntries: [path()] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>); });
  await settle();
}
function retry() {
  const button = [...host.querySelectorAll("button")].find(button => button.textContent === "Retry readable text");
  expect(button, "A failed citation read must have an explicit recovery action").toBeDefined();
  if (!button) throw new Error("Missing Retry readable text");
  return button;
}
async function click(button: HTMLButtonElement) { await act(async () => { button.click(); }); await settle(); }
async function navigate(source: string, revision: string) { await act(async () => { await router.navigate(path(source, revision)); }); await settle(); }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  requests = []; respond = async url => success(url); sourceResponse = undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET");
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    requests.push(url.pathname);
    const match = url.pathname.match(/^\/api\/sources\/(s[12])$/);
    if (match) {
      if (sourceResponse) return sourceResponse(url);
      const id = match[1], current = id === "s1" ? "r1" : "r3";
      return json({ source: { id, title: "Source " + id, kind: "text", currentRevisionId: current, revisionId: current, readableState: "readable", distillState: "none", originalFilename: null, error: null },
        revisions: (id === "s1" ? ["r1", "r2"] : ["r3"]).map((id, index) => ({ id, revisionNo: index + 1, readableState: "readable", createdAt: 0, error: null })) });
    }
    return respond(url);
  }));
});
afterEach(async () => { await act(async () => root.unmount()); router?.dispose(); host.remove(); vi.unstubAllGlobals(); });

describe("Reader failed citation recovery", () => {
  it.each(["text", "outline"])("retries a failed %s GET without changing the revision or UTF-8 range", async part => {
    let failures = 2, reads = 0;
    respond = async url => {
      if (url.pathname.endsWith("/" + part)) { reads++; if (failures-- > 0) return failure(part); }
      return success(url);
    };
    await open();
    expect(host.textContent).toContain(`Temporary ${part} failure.`);
    await click(retry());
    expect(reads).toBe(2);
    expect(retry().disabled).toBe(false);
    await click(retry());
    expect(host.querySelector("pre")?.textContent).toBe(TEXT + " r1");
    expect(host.querySelector("mark")?.textContent).toBe(selected);
    expect(host.textContent).not.toContain(`Temporary ${part} failure.`);
    expect(reads).toBe(3);
    expect(router.state.location.search).toBe("?revisionId=r1&start=9&end=28");
  });

  it.each(["http", "malformed"])("does not expose another revision's text under the previous revision after an outline %s failure", async mode => {
    await open();
    expect(host.querySelector("pre")?.textContent).toBe(TEXT + " r1");
    respond = async url => url.pathname === "/api/revisions/r2/outline" ? (mode === "http" ? failure("outline") : json({ blocks: [null] })) : success(url);
    await navigate("s1", "r2");
    expect(host.querySelector("[role=alert]")).not.toBeNull();
    let release: ((response: Response) => void) | undefined;
    respond = async url => url.pathname === "/api/revisions/r1/text" ? new Promise(resolve => { release = resolve; }) : success(url);
    await navigate("s1", "r1");
    // While revalidation is pending, any retained text must belong to the selected revision.
    expect(host.querySelector("pre")?.textContent).toBe(TEXT + " r1");
    expect(host.querySelector("mark")?.textContent).toBe(selected);
    await act(async () => { release?.(new Response(TEXT + " r1")); }); await settle();
  });

  it.each(["revision", "source"])("ignores a departed retry after switching %s", async destination => {
    let failed = false, release: ((response: Response) => void) | undefined;
    respond = async url => {
      if (url.pathname === "/api/revisions/r1/text") {
        if (!failed) { failed = true; return failure("text"); }
        return new Promise(resolve => { release = resolve; }); // Deliberately ignores AbortSignal.
      }
      return success(url);
    };
    await open();
    const button = retry();
    await act(async () => { button.click(); button.click(); }); await settle();
    expect(retry().disabled).toBe(true);
    expect(requests.filter(path => path === "/api/revisions/r1/text")).toHaveLength(2);
    const target = destination === "source" ? "r3" : "r2";
    await navigate(destination === "source" ? "s2" : "s1", target);
    expect(host.querySelector("pre")?.textContent).toBe(TEXT + " " + target);
    await act(async () => { release?.(new Response("stale revision text")); }); await settle();
    expect(host.querySelector("pre")?.textContent).toBe(TEXT + " " + target);
    expect(host.querySelector("mark")?.textContent).toBe(selected);
    expect(host.textContent).not.toContain("Temporary text failure.");
  });
});

describe("Reader historical passage navigation", () => {
  it.each(["pending", "failed"])("keeps the cited revision when clearing a passage during a %s metadata read", async state => {
    await open();
    const historical = "d795f9c9-10d0-435c-8e3e-c244aca85ded";
    let release: ((response: Response) => void) | undefined;
    const historicalSource = () => json({
      source: { id: "s1", title: "Source s1", kind: "text", currentRevisionId: "r1", revisionId: "r1", readableState: "readable", error: null },
      revisions: ["r1", "r2", historical].map((id, index) => ({ id, revisionNo: index + 1, readableState: "readable", createdAt: 0, error: null })),
    });
    sourceResponse = async () => state === "pending"
      ? new Promise(resolve => { release = resolve; }) : failure("source status");
    // A Studio citation may target a revision outside the Reader's cached history page.
    await navigate("s1", historical);
    const clear = [...host.querySelectorAll("a")].find(link => link.textContent === "Clear passage");
    expect(clear).toBeDefined();
    expect(clear?.getAttribute("href")).toBe(`/p/p1/source/s1?revisionId=${historical}`);
    const readsBeforeClear = requests.filter(url => url === "/api/revisions/r1/text").length;
    await act(async () => { clear?.click(); }); await settle();
    expect(router.state.location.search).toBe(`?revisionId=${historical}`);
    expect(host.querySelector("mark")).toBeNull();
    expect(host.querySelector("pre")?.textContent).toBe("");
    if (state === "pending") {
      await act(async () => { release?.(historicalSource()); }); await settle();
    } else {
      sourceResponse = async () => historicalSource();
      const retry = [...host.querySelectorAll("button")].find(button => button.textContent === "Retry source status");
      expect(retry).toBeDefined();
      if (retry) await click(retry);
    }
    expect(host.querySelector("pre")?.textContent).toBe(TEXT + " " + historical);
    expect(host.querySelector("mark")).toBeNull();
    expect(requests.filter(url => url === "/api/revisions/r1/text")).toHaveLength(readsBeforeClear);
    sourceResponse = async () => historicalSource();
    await act(async () => { await router.navigate(-1); }); await settle();
    expect(router.state.location.search).toBe(`?revisionId=${historical}&start=9&end=28`);
    expect(host.querySelector("mark")?.textContent).toBe(selected);
    await act(async () => { await router.navigate(1); }); await settle();
    expect(router.state.location.search).toBe(`?revisionId=${historical}`);
    expect(host.querySelector("mark")).toBeNull();
    expect(host.querySelector("pre")?.textContent).toBe(TEXT + " " + historical);
  });
});


describe("Reader replacement source list", () => {
  it.each(["current", "departed", "other project", "loading project", "failed refresh"])("refreshes the current source link after a confirmed replacement in a %s Reader", async view => {
    let currentRevision = "r1", release: (() => void) | undefined, listReads = 0;
    let releaseList: (() => void) | undefined, staleListSignal: AbortSignal | null | undefined;
    let refreshFailure = view === "failed refresh";
    const stayed = view === "current" || view === "failed refresh";
    const row = (id: string) => ({ id, title: "Source " + id, kind: "text", enabled: true, currentRevisionId: id === "s1" ? currentRevision : "r3",
      revisionId: id === "s1" ? currentRevision : "r3", readableState: "readable", distillState: id === "s1" && currentRevision === "r1" ? "done" : "none",
      claimCount: id === "s1" && currentRevision === "r1" ? 2 : 0, originalFilename: null, error: null });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (init?.method === "POST") {
        expect(url.pathname).toBe("/api/projects/p1/sources/file");
        const form = init.body as FormData;
        expect(form.get("sourceId")).toBe("s1");
        const revisionId = String(form.get("revisionId"));
        return new Promise<Response>(resolve => { release = () => {
          currentRevision = revisionId; resolve(json({ sourceId: "s1", revisionId }));
        }; });
      }
      expect(init?.method ?? "GET").toBe("GET");
      if (/^\/api\/projects\/p[12]\/sources$/.test(url.pathname)) {
        listReads++;
        if (currentRevision !== "r1" && refreshFailure) { refreshFailure = false; return failure("sources"); }
        const response = json(url.searchParams.has("cursor") ? { sources: [row("s2")], nextCursor: null } : { sources: [row("s1")], nextCursor: "second" });
        if (view === "loading project" && url.pathname === "/api/projects/p2/sources" && !releaseList) {
          staleListSignal = init?.signal;
          return new Promise<Response>(resolve => { releaseList = () => resolve(response); });
        }
        return response;
      }
      if (url.pathname.startsWith("/api/sources/")) {
        const id = url.pathname.split("/")[3] ?? "";
        return json({ source: row(id), revisions: (id === "s1" ? [...new Set(["r1", currentRevision])] : ["r3"])
          .map((id, index) => ({ id, revisionNo: index + 1, readableState: "readable", createdAt: 0, error: null })) });
      }
      expect(url.pathname).toMatch(/^\/api\/revisions\/[^/]+\/(?:text|outline)$/);
      return success(url);
    }));
    function Workspace() {
      const { projectId = "p1" } = useParams();
      const [selection, setSelection] = useState<SourceSelection>({ scopeMode: "explicit", sourceIds: ["s1", "s2"] });
      return <><SourcesPane projectId={projectId} selection={selection} onSelectionChange={setSelection} />
        <Reader replacingSources={new Set()} beginReplacement={() => true} endReplacement={() => {}} onUseQuestion={() => {}} /></>;
    }
    router = createMemoryRouter([{ path: "/p/:projectId/source/:sourceId", element: <Workspace /> }], { initialEntries: [path()] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    await act(async () => { root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>); }); await settle();
    const more = [...host.querySelectorAll("button")].find(button => button.textContent === "Load more sources");
    if (!more) throw new Error("Missing source pagination");
    await click(more); await settle();
    expect(host.querySelectorAll(".er-sources-pane__row")).toHaveLength(2);
    expect(host.querySelector(".er-sources-pane__row")?.textContent).toContain("Ready · 2 claims");
    const sourceLink = () => host.querySelector<HTMLAnchorElement>(".er-sources-pane__row-title");
    expect(sourceLink()?.getAttribute("href")).toBe("/p/p1/source/s1?revisionId=r1");
    const fileInput = host.querySelector<HTMLInputElement>("#er-lib-replace");
    if (!fileInput) throw new Error("Missing replacement input");
    Object.defineProperty(fileInput, "files", { configurable: true, value: [new File(["New source text"], "replacement.md", { type: "text/markdown" })] });
    await act(async () => { fileInput.dispatchEvent(new Event("change", { bubbles: true })); });
    const upload = [...host.querySelectorAll("button")].find(button => button.textContent === "Upload new revision");
    if (!upload) throw new Error("Missing upload action");
    await click(upload);
    expect(release).toBeDefined();
    if (view === "departed") await navigate("s2", "r3");
    if (view === "other project" || view === "loading project") {
      await act(async () => { await router.navigate(path("s2", "r3").replace("/p/p1/", "/p/p2/")); }); await settle();
      const nextPage = [...host.querySelectorAll("button")].find(button => button.textContent === "Load more sources");
      if (view === "other project") {
        if (!nextPage) throw new Error("Missing other-project pagination");
        await click(nextPage); await settle();
      } else {
        expect(releaseList).toBeDefined();
        expect(sourceLink()).toBeNull();
      }
    }
    const project = view === "other project" || view === "loading project" ? "p2" : "p1";
    const readsBefore = listReads;
    await act(async () => { release?.(); }); await settle(); await settle();
    if (releaseList) { await act(async () => { releaseList?.(); }); await settle(); }
    if (view === "failed refresh") {
      expect(host.textContent).toContain("Temporary sources failure.");
      expect(host.querySelector("pre")?.textContent).toBe(TEXT + " " + currentRevision);
      expect(host.querySelectorAll(".er-sources-pane__row")).toHaveLength(2);
      const retryList = [...host.querySelectorAll(".er-sources-pane button")].find(button => button.textContent === "Retry");
      expect(retryList, "A failed refresh must be recoverable even when all pages were loaded").toBeDefined();
      if (!(retryList instanceof HTMLButtonElement)) throw new Error("Missing source-list retry");
      await click(retryList); await settle();
      expect(host.textContent).not.toContain("Temporary sources failure.");
    }
    expect(sourceLink()?.getAttribute("href")).toBe("/p/" + project + "/source/s1?revisionId=" + currentRevision);
    expect(host.querySelector(".er-sources-pane__original")?.getAttribute("href")).toBe("/api/revisions/" + currentRevision + "/original");
    expect(host.querySelector(".er-sources-pane__row")?.textContent).toContain("Not analyzed");
    expect(host.querySelectorAll(".er-sources-pane__row")).toHaveLength(view === "loading project" ? 1 : 2);
    expect([...host.querySelectorAll<HTMLInputElement>(".er-sources-pane__checkbox input")].every(input => input.checked)).toBe(true);
    expect(listReads - readsBefore).toBe(view === "loading project" ? 1 : view === "failed refresh" ? 3 : 2);
    if (releaseList) expect(staleListSignal?.aborted).toBe(true);
    expect(router.state.location.pathname).toBe("/p/" + project + "/source/" + (stayed ? "s1" : "s2"));
    expect(host.querySelector("pre")?.textContent).toBe(TEXT + " " + (stayed ? currentRevision : "r3"));
    await act(async () => { await router.navigate(path("s1", "r1")); }); await settle();
    expect(host.querySelector("mark")?.textContent).toBe(selected);
    expect(host.querySelector("pre")?.textContent).toBe(TEXT + " r1");
    client.clear();
  });
});
