import { describe, expect, it, vi } from "vitest";
import {
  createNativeWebSearchMarkdownCaptureAdapter,
  NATIVE_WEB_SEARCH_CAPTURE_CONTENT_TYPE,
  type NativeWebSearchCaptureSelection,
  type NativeWebSearchMarkdownCaptureInput,
  type NativeWebSearchRawCaptureOwnerPort,
  type NativeWebSearchRawCaptureReceipt,
} from "./native-web-search-capture.js";
import type { NativeWebSearchDiscovered } from "./native-web-search.js";

const sourceUrl = "https://example.org/research";
const markdown = "# Captured page\n\nPage bytes only.\n";

function selection(timeoutMs = 100): NativeWebSearchCaptureSelection {
  return {
    search: { gateway_id: "research-search", provider: "exa", byok_alias: "research_key", timeout_ms: 100 },
    browser_markdown: { timeout_ms: timeoutMs, max_markdown_bytes: 4096, redirect_policy: "exact_url_only" },
  };
}

function discovery(url = sourceUrl): NativeWebSearchDiscovered {
  return {
    protocol: "eliotr.native-web-search.v1",
    disposition: "DISCOVERED",
    selected_gateway_id: "research-search",
    selected_provider: "exa",
    requested_query: "find a source",
    requested_limit: 2,
    dispatch_state: "RESPONSE_RECEIVED",
    paid_effect: "UNKNOWN",
    locators: [{ url, description: "Discovery text must not become source bytes" }],
    omissions: [],
  };
}

function input(overrides: Partial<NativeWebSearchMarkdownCaptureInput> = {}): NativeWebSearchMarkdownCaptureInput {
  return {
    attempt: {
      operation_id: "research-op-1",
      stage: "ACQUIRE_AND_CAPTURE",
      attempt_ref: "attempt-1",
      input_sha256: "a".repeat(64),
    },
    discovery: discovery(),
    locator_index: 0,
    ...overrides,
  };
}

function browserResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    success: true,
    result: markdown,
    meta: { status: 200, title: "Captured page", finalUrl: sourceUrl },
    ...overrides,
  }), { headers: { "content-type": "application/json" } });
}

function browser(quickAction: (...args: never[]) => Promise<Response>) {
  return { quickAction } as unknown as Pick<BrowserRun, "quickAction">;
}

function owner(options: { readonly throwAfterWrite?: boolean } = {}) {
  let stored: NativeWebSearchRawCaptureReceipt | null = null;
  let storedBody = "";
  const captureRawFile = vi.fn(async (request: Parameters<NativeWebSearchRawCaptureOwnerPort["captureRawFile"]>[0]) => {
    storedBody = await new Response(request.body).text();
    stored = {
      protocol: "eliotr.raw-file-capture.v1",
      disposition: "CAPTURED",
      capture_id: `raw-capture-${"b".repeat(48)}`,
      idempotency_key: request.idempotency_key,
      original_file_name: request.original_file_name,
      content_sha256: request.content_sha256,
      size_bytes: request.size_bytes,
      content_type: request.content_type,
      captured_at: "2026-10-09T12:00:00.000Z",
    };
    if (options.throwAfterWrite === true) throw new Error("simulated lost owner ACK");
    return stored;
  });
  const readRawFileByIdempotency = vi.fn(async (key: string) => stored?.idempotency_key === key ? stored : null);
  const port: NativeWebSearchRawCaptureOwnerPort = { captureRawFile, readRawFileByIdempotency };
  return { port, captureRawFile, readRawFileByIdempotency, body: () => storedBody };
}

describe("native Web Search Browser Run raw capture adapter", () => {
  it("captures only strict Markdown result bytes through the owner port and verifies exact readback", async () => {
    const raw = owner();
    const quickAction = vi.fn(async (_action: string, _options: unknown) => browserResponse());
    const adapter = createNativeWebSearchMarkdownCaptureAdapter({
      browser: browser(quickAction as never), owner: raw.port, selection: selection(),
    });

    const result = await adapter.capture(input());

    expect(result).toMatchObject({
      disposition: "CAPTURED",
      selected_gateway_id: "research-search",
      selected_provider: "exa",
      requested_url: sourceUrl,
      final_url: sourceUrl,
      browser_dispatch_state: "RESPONSE_RECEIVED",
      paid_effect: "UNKNOWN",
      capture: { content_type: NATIVE_WEB_SEARCH_CAPTURE_CONTENT_TYPE, size_bytes: new TextEncoder().encode(markdown).byteLength },
    });
    expect(quickAction).toHaveBeenCalledTimes(1);
    expect(quickAction).toHaveBeenCalledWith("markdown", expect.objectContaining({
      url: sourceUrl,
      allowRequestPattern: [`^${sourceUrl.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`],
      allowResourceTypes: ["document"],
      setJavaScriptEnabled: false,
      cacheTTL: 0,
    }));
    expect(raw.captureRawFile).toHaveBeenCalledTimes(1);
    expect(raw.readRawFileByIdempotency).toHaveBeenCalledTimes(2);
    expect(raw.body()).toBe(markdown);
    expect(raw.body()).not.toContain("Discovery text must not become source bytes");
  });

  it("rejects redirects before raw capture and does not convert discovery metadata into source bytes", async () => {
    const raw = owner();
    const quickAction = vi.fn(async () => browserResponse({
      meta: {
        status: 200,
        title: "redirected",
        finalUrl: "https://example.org/other",
        redirectChain: [{ url: sourceUrl, status: 302, headers: { location: "/other" } }],
      },
    }));
    const adapter = createNativeWebSearchMarkdownCaptureAdapter({
      browser: browser(quickAction as never), owner: raw.port, selection: selection(),
    });

    await expect(adapter.capture(input())).resolves.toMatchObject({
      disposition: "FAILED",
      code: "REDIRECT_NOT_ALLOWED",
      browser_dispatch_state: "RESPONSE_RECEIVED",
      paid_effect: "UNKNOWN",
    });
    expect(quickAction).toHaveBeenCalledTimes(1);
    expect(raw.captureRawFile).not.toHaveBeenCalled();
  });

  it("rejects Browser Run's empty redirectChain marker even when the final URL matches", async () => {
    const raw = owner();
    const quickAction = vi.fn(async () => browserResponse({
      meta: { status: 200, title: "redirected back", finalUrl: sourceUrl, redirectChain: [] },
    }));
    const adapter = createNativeWebSearchMarkdownCaptureAdapter({
      browser: browser(quickAction as never), owner: raw.port, selection: selection(),
    });

    await expect(adapter.capture(input())).resolves.toMatchObject({
      disposition: "FAILED",
      code: "REDIRECT_NOT_ALLOWED",
      browser_dispatch_state: "RESPONSE_RECEIVED",
      paid_effect: "UNKNOWN",
    });
    expect(quickAction).toHaveBeenCalledTimes(1);
    expect(raw.captureRawFile).not.toHaveBeenCalled();
  });

  it("marks a dispatched timeout unknown and recovery performs only exact capture readback", async () => {
    const raw = owner();
    const quickAction = vi.fn(() => new Promise<Response>(() => undefined));
    const adapter = createNativeWebSearchMarkdownCaptureAdapter({
      browser: browser(quickAction as never), owner: raw.port, selection: selection(5),
    });

    await expect(adapter.capture(input())).resolves.toMatchObject({
      disposition: "UNKNOWN",
      code: "TIMEOUT",
      browser_dispatch_state: "OUTCOME_UNKNOWN",
      paid_effect: "UNKNOWN",
    });
    await expect(adapter.recoverStartedAttempt(input())).resolves.toMatchObject({
      disposition: "UNKNOWN",
      code: "CAPTURE_READBACK_UNAVAILABLE",
      browser_dispatch_state: "OUTCOME_UNKNOWN",
    });
    expect(quickAction).toHaveBeenCalledTimes(1);
    expect(raw.captureRawFile).not.toHaveBeenCalled();
  });

  it("settles a lost raw-capture ACK only when the same idempotency key reads back exactly", async () => {
    const raw = owner({ throwAfterWrite: true });
    const quickAction = vi.fn(async () => browserResponse());
    const adapter = createNativeWebSearchMarkdownCaptureAdapter({
      browser: browser(quickAction as never), owner: raw.port, selection: selection(),
    });

    await expect(adapter.capture(input())).resolves.toMatchObject({
      disposition: "CAPTURED",
      browser_dispatch_state: "RESPONSE_RECEIVED",
      capture: { content_type: NATIVE_WEB_SEARCH_CAPTURE_CONTENT_TYPE },
    });
    expect(quickAction).toHaveBeenCalledTimes(1);
    expect(raw.captureRawFile).toHaveBeenCalledTimes(1);
    expect(raw.readRawFileByIdempotency).toHaveBeenCalledTimes(2);
  });

  it("rejects non-HTTPS and literal private locators before Browser Run dispatch", async () => {
    const raw = owner();
    const quickAction = vi.fn(async () => browserResponse());
    const adapter = createNativeWebSearchMarkdownCaptureAdapter({
      browser: browser(quickAction as never), owner: raw.port, selection: selection(),
    });

    await expect(adapter.capture(input({ discovery: discovery("http://example.org/page") })))
      .resolves.toMatchObject({ disposition: "FAILED", code: "INPUT_INVALID", browser_dispatch_state: "NOT_STARTED" });
    await expect(adapter.capture(input({ discovery: discovery("https://127.0.0.1/private") })))
      .resolves.toMatchObject({ disposition: "FAILED", code: "INPUT_INVALID", browser_dispatch_state: "NOT_STARTED" });
    expect(quickAction).not.toHaveBeenCalled();
    expect(raw.captureRawFile).not.toHaveBeenCalled();
  });
});
