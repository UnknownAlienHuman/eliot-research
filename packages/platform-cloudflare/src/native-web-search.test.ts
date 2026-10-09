import { describe, expect, it, vi } from "vitest";
import {
  createNativeWebSearchAdapter,
  NATIVE_WEB_SEARCH_MAX_QUERY_CHARACTERS,
  type NativeWebSearchBindingRequest,
  type NativeWebSearchProfile,
} from "./native-web-search.js";

function profile(overrides: Partial<NativeWebSearchProfile> = {}): NativeWebSearchProfile {
  return {
    gateway_id: "research-search",
    provider: "exa",
    byok_alias: "research_key",
    timeout_ms: 100,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function request(overrides: Partial<{ query: string; limit: number; signal: AbortSignal }> = {}) {
  return { query: "find primary source", limit: 3, ...overrides };
}

describe("native AI.websearch discovery adapter", () => {
  it("calls only the selected gateway/provider profile and returns locators with unknown paid effect", async () => {
    const nativeCall = vi.fn(async (_input: NativeWebSearchBindingRequest) => jsonResponse({
      items: [{ url: "https://example.org/paper", title: "Paper", description: "Discovery snippet" }],
      metadata: { query: "provider query", requestId: "gateway-request-1", latencyMs: 12 },
    }));
    const result = await createNativeWebSearchAdapter({ websearch: nativeCall }, profile())
      .discover(request());

    expect(nativeCall).toHaveBeenCalledTimes(1);
    expect(nativeCall).toHaveBeenCalledWith({
      gatewayId: "research-search",
      query: "find primary source",
      provider: "exa",
      limit: 3,
      byokAlias: "research_key",
    });
    expect(result).toMatchObject({
      disposition: "DISCOVERED",
      selected_provider: "exa",
      selected_gateway_id: "research-search",
      requested_query: "find primary source",
      provider_metadata: {
        query: "provider query",
        request_id: "gateway-request-1",
        latency_ms: 12,
      },
      locators: [{ url: "https://example.org/paper", title: "Paper", description: "Discovery snippet" }],
      paid_effect: "UNKNOWN",
      dispatch_state: "RESPONSE_RECEIVED",
    });
    expect(result).not.toHaveProperty("evidence");
  });

  it("reports no-hit only for a valid explicit empty items array and does not fabricate provider query metadata", async () => {
    const nativeCall = vi.fn(async () => jsonResponse({ items: [], metadata: { requestId: "gateway-request-2" } }));
    const result = await createNativeWebSearchAdapter({ websearch: nativeCall }, profile())
      .discover(request());

    expect(result).toMatchObject({
      disposition: "NO_HIT",
      locators: [],
      omissions: [],
      paid_effect: "UNKNOWN",
      dispatch_state: "RESPONSE_RECEIVED",
      provider_metadata: { request_id: "gateway-request-2" },
    });
    expect(result).not.toHaveProperty("provider_metadata.query");
  });

  it("records malformed rows as indexed omissions and retains later valid locators", async () => {
    const result = await createNativeWebSearchAdapter({
      websearch: async () => jsonResponse({
        items: [null, { url: "javascript:alert(1)" }, { url: "https://example.org/valid" }],
      }),
    }, profile()).discover(request());

    expect(result).toMatchObject({
      disposition: "DISCOVERED",
      locators: [{ url: "https://example.org/valid" }],
      omissions: [
        { item_index: 0, reason: "ITEM_NOT_OBJECT" },
        { item_index: 1, reason: "ITEM_URL_INVALID" },
      ],
    });
  });

  it("does not reinterpret an all-omitted response as no-hit", async () => {
    const result = await createNativeWebSearchAdapter({
      websearch: async () => jsonResponse({ items: [{ url: "https://user:secret@example.org/" }] }),
    }, profile()).discover(request());

    expect(result).toMatchObject({
      disposition: "FAILED",
      code: "ALL_ITEMS_OMITTED",
      dispatch_state: "RESPONSE_RECEIVED",
      paid_effect: "UNKNOWN",
      omissions: [{ item_index: 0, reason: "ITEM_URL_INVALID" }],
    });
  });

  it("returns unsupported and pre-aborted outcomes without making a provider call", async () => {
    const unsupported = await createNativeWebSearchAdapter({}, profile()).discover(request());
    const controller = new AbortController();
    controller.abort();
    const nativeCall = vi.fn(async () => jsonResponse({ items: [] }));
    const aborted = await createNativeWebSearchAdapter({ websearch: nativeCall }, profile())
      .discover(request({ signal: controller.signal }));

    expect(unsupported).toMatchObject({ disposition: "FAILED", code: "UNSUPPORTED_RUNTIME", dispatch_state: "NOT_STARTED", paid_effect: "NONE" });
    expect(aborted).toMatchObject({ disposition: "FAILED", code: "ABORTED", dispatch_state: "NOT_STARTED", paid_effect: "NONE" });
    expect(nativeCall).not.toHaveBeenCalled();
  });

  it("marks thrown and timed-out dispatches unknown and never retries them", async () => {
    const thrownCall = vi.fn(async (): Promise<Response> => { throw new Error("provider unavailable"); });
    const thrown = await createNativeWebSearchAdapter({ websearch: thrownCall }, profile())
      .discover(request());
    const pendingCall = vi.fn(() => new Promise<Response>(() => undefined));
    const timedOut = await createNativeWebSearchAdapter({ websearch: pendingCall }, profile({ timeout_ms: 5 }))
      .discover(request());

    expect(thrown).toMatchObject({ disposition: "FAILED", code: "DISPATCH_OUTCOME_UNKNOWN", dispatch_state: "OUTCOME_UNKNOWN", paid_effect: "UNKNOWN" });
    expect(timedOut).toMatchObject({ disposition: "FAILED", code: "TIMEOUT", dispatch_state: "OUTCOME_UNKNOWN", paid_effect: "UNKNOWN" });
    expect(thrownCall).toHaveBeenCalledTimes(1);
    expect(pendingCall).toHaveBeenCalledTimes(1);
  });

  it("keeps HTTP failures and malformed responses distinct from a successful no-hit", async () => {
    const httpFailure = await createNativeWebSearchAdapter({
      websearch: async () => jsonResponse({ error: "not authorized" }, 401),
    }, profile()).discover(request());
    const malformed = await createNativeWebSearchAdapter({
      websearch: async () => jsonResponse({ results: [] }),
    }, profile()).discover(request());

    expect(httpFailure).toMatchObject({ disposition: "FAILED", code: "HTTP_FAILURE", http_status: 401, paid_effect: "UNKNOWN" });
    expect(malformed).toMatchObject({ disposition: "FAILED", code: "RESPONSE_INVALID", paid_effect: "UNKNOWN" });
  });

  it("rejects invalid query bounds and provider result overflow without clipping or dispatch", async () => {
    const nativeCall = vi.fn(async () => jsonResponse({ items: [] }));
    const adapter = createNativeWebSearchAdapter({ websearch: nativeCall }, profile());
    const invalid = await adapter.discover(request({ query: "q".repeat(NATIVE_WEB_SEARCH_MAX_QUERY_CHARACTERS + 1) }));
    const overflow = await createNativeWebSearchAdapter({
      websearch: async () => jsonResponse({ items: [
        { url: "https://example.org/1" },
        { url: "https://example.org/2" },
      ] }),
    }, profile()).discover(request({ limit: 1 }));

    expect(invalid).toMatchObject({ disposition: "FAILED", code: "INPUT_INVALID", dispatch_state: "NOT_STARTED", paid_effect: "NONE" });
    expect(overflow).toMatchObject({ disposition: "FAILED", code: "RESULT_LIMIT_EXCEEDED", paid_effect: "UNKNOWN" });
    expect(nativeCall).not.toHaveBeenCalled();
  });

  it("enforces the existing bounded response reader's byte ceiling", async () => {
    const oversized = new Response(" ".repeat(256 * 1024 + 1));
    const result = await createNativeWebSearchAdapter({ websearch: async () => oversized }, profile())
      .discover(request());

    expect(result).toMatchObject({ disposition: "FAILED", code: "RESPONSE_TOO_LARGE", dispatch_state: "RESPONSE_RECEIVED", paid_effect: "UNKNOWN" });
  });
});
