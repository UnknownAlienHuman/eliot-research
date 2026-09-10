import { describe, expect, it } from "vitest";
import { ModelGatewayExecutionError } from "@eliotr/cloudflare-ai";
import { createResearchModelGatewayRuntime } from "../../../packages/cloudflare-research/src/research-model-gateway-runtime.js";

const ACCOUNT_ID = "a".repeat(32);
const BASE_URL = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/eliotr-reasoning`;
const ENDPOINT = `${BASE_URL}/compat/chat/completions`;

function requestInit(): RequestInit {
  return {
    method: "POST",
    redirect: "error",
    headers: { "cf-aig-request-timeout": "1000" },
    body: "{}",
  };
}

describe("research model gateway runtime", () => {
  it("keeps the server credential and exact endpoint while returning a bounded response", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const runtime = createResearchModelGatewayRuntime({
      reasoning_gateway_base_url: BASE_URL,
      gateway_token: "server-held-token",
      fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
        requestedUrl = String(url);
        requestedInit = init;
        return new Response("{\"ok\":true}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    expect(runtime.endpoint).toBe(ENDPOINT);
    await expect(runtime.credentials.readGatewayToken()).resolves.toBe("server-held-token");
    const response = await runtime.transport.fetch(ENDPOINT, requestInit());
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("gateway runtime did not return a Response");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("{\"ok\":true}");
    expect(requestedUrl).toBe(ENDPOINT);
    expect(requestedInit?.method).toBe("POST");
    expect(requestedInit?.redirect).toBe("error");
    expect(requestedInit?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(requestedInit?.headers).get("cf-aig-request-timeout")).toBe("1000");
  });

  it("rejects a noncanonical destination or request before invoking fetch", async () => {
    let fetchCalls = 0;
    const runtime = createResearchModelGatewayRuntime({
      reasoning_gateway_base_url: BASE_URL,
      gateway_token: "server-held-token",
      fetch: async () => {
        fetchCalls += 1;
        return new Response("unexpected");
      },
    });
    await expect(runtime.transport.fetch(`${ENDPOINT}/other`, requestInit()))
      .rejects.toMatchObject({ code: "MODEL_GATEWAY_REQUEST_INVALID" });
    await expect(runtime.transport.fetch(ENDPOINT, { ...requestInit(), method: "GET" }))
      .rejects.toMatchObject({ code: "MODEL_GATEWAY_REQUEST_INVALID" });
    await expect(runtime.transport.fetch(ENDPOINT, { ...requestInit(), headers: {} }))
      .rejects.toMatchObject({ code: "MODEL_GATEWAY_REQUEST_INVALID" });
    expect(fetchCalls).toBe(0);
    expect(() => createResearchModelGatewayRuntime({ reasoning_gateway_base_url: BASE_URL, gateway_token: " bearer" }))
      .toThrowError(ModelGatewayExecutionError);
  });

  it("cancels an in-flight bounded response when the invocation signal aborts", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
      cancel: () => { cancelled = true; },
    });
    const runtime = createResearchModelGatewayRuntime({
      reasoning_gateway_base_url: BASE_URL,
      gateway_token: "server-held-token",
      signal: controller.signal,
      fetch: async () => new Response(body, { status: 200 }),
    });
    const pending = runtime.transport.fetch(ENDPOINT, requestInit());
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
  });

  it("does not invoke fetch when an invocation is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    let fetchCalls = 0;
    const runtime = createResearchModelGatewayRuntime({
      reasoning_gateway_base_url: BASE_URL,
      gateway_token: "server-held-token",
      signal: controller.signal,
      fetch: async () => {
        fetchCalls += 1;
        return new Response("unexpected");
      },
    });
    await expect(runtime.transport.fetch(ENDPOINT, requestInit())).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchCalls).toBe(0);
  });

  it("cancels while response headers are still pending and enforces the success body bound", async () => {
    const headerController = new AbortController();
    let headerFetchCalls = 0;
    const headerRuntime = createResearchModelGatewayRuntime({
      reasoning_gateway_base_url: BASE_URL,
      gateway_token: "server-held-token",
      signal: headerController.signal,
      fetch: async () => {
        headerFetchCalls += 1;
        return new Promise<Response>(() => undefined);
      },
    });
    const pendingHeaders = headerRuntime.transport.fetch(ENDPOINT, requestInit());
    await Promise.resolve();
    headerController.abort();
    await expect(pendingHeaders).rejects.toMatchObject({ name: "AbortError" });
    expect(headerFetchCalls).toBe(1);

    const oversized = new Uint8Array(256 * 1024 + 1);
    const boundRuntime = createResearchModelGatewayRuntime({
      reasoning_gateway_base_url: BASE_URL,
      gateway_token: "server-held-token",
      fetch: async () => new Response(oversized, { status: 200 }),
    });
    await expect(boundRuntime.transport.fetch(ENDPOINT, requestInit())).rejects.toMatchObject({ name: "AbortError" });
  });

  it("returns a completed buffered response even if the parent aborts afterward", async () => {
    const controller = new AbortController();
    const runtime = createResearchModelGatewayRuntime({
      reasoning_gateway_base_url: BASE_URL,
      gateway_token: "server-held-token",
      signal: controller.signal,
      fetch: async () => new Response("complete", { status: 200 }),
    });
    const response = await runtime.transport.fetch(ENDPOINT, requestInit());
    controller.abort();
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("gateway runtime did not return a Response");
    expect(await response.text()).toBe("complete");
  });
});
