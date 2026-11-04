// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Reader } from "./Library";

vi.mock("./Understanding", () => ({ SourceUnderstanding: () => null }));
vi.mock("./Ocr", () => ({ SourceOcr: () => null }));

const TEXT = "Before.\n\nТочный текст\n\nAfter.";
const selected = new TextDecoder().decode(new TextEncoder().encode(TEXT).subarray(9, 28));
const path = (source = "s1", revision = "r1") => `/p/p1/source/${source}?revisionId=${revision}&start=9&end=28`;
let root: Root, host: HTMLDivElement;
let router: ReturnType<typeof createMemoryRouter>;
let requests: string[];
let respond: (url: URL) => Promise<Response>;
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
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  requests = []; respond = async url => success(url);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET");
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    requests.push(url.pathname);
    const match = url.pathname.match(/^\/api\/sources\/(s[12])$/);
    if (match) {
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
