import { describe, expect, it, vi } from "vitest";
import { ModelGatewayExecutionError } from "@eliotr/cloudflare-ai";
import type { ResearchModelGatewayBinding } from "@eliotr/cloudflare-research";
import { createResearchModelGatewayRuntime } from "../../../packages/cloudflare-research/src/research-model-gateway-runtime.js";
import type { Env } from "../src/env.js";
import { composeResearchModelGatewayConfiguration } from "../src/research-prepared-model-transport.js";

const ACCOUNT_ID = "a".repeat(32);
const BASE_URL = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/eliotr-reasoning`;
const ENDPOINT = `${BASE_URL}/compat/chat/completions`;
const GATEWAY_LOG = {
  id: "research-runtime-test-log",
  provider: "workers-ai",
  model: "@cf/zai-org/glm-5.3-flash",
  path: ENDPOINT,
  duration: 1,
  status_code: 200,
  success: true,
  cached: false,
  request_size: 0,
  request_head_complete: false,
  response_size: 0,
  response_head_complete: false,
  created_at: new Date(0),
} satisfies AiGatewayLog;

function gateway(url: string) {
  return { getUrl: async () => url, getLog: async () => GATEWAY_LOG, run: async () => new Response("unexpected") };
}

type NativeGateway = ReturnType<ResearchModelGatewayBinding["gateway"]>;

// Exact LEGACY_POLICY tuple from packages/cloudflare-model-transport/src/model-gateway-http-request.test.ts.
const WORKERS_AI_POLICY = {
  version: 1 as const,
  transport: "cloudflare-ai-gateway" as const,
  api: "compat-chat-completions" as const,
  provider: "workers-ai",
  model: "@cf/zai-org/glm-5.3-flash",
  billing: { mode: "unified" as const },
  capabilities: {
    max_output_tokens_field: "max_completion_tokens" as const,
    reasoning_efforts: ["low", "max"] as const,
  },
};

const INVALID_WORKERS_AI_BYOK_POLICY = {
  version: 1 as const,
  transport: "cloudflare-ai-gateway" as const,
  api: "compat-chat-completions" as const,
  provider: "workers-ai",
  model: "@cf/zai-org/glm-5.3-flash",
  billing: { mode: "byok" as const, alias: "glm" },
  capabilities: {
    max_output_tokens_field: "max_completion_tokens" as const,
    reasoning_efforts: ["low", "max"] as const,
  },
};

function requestInit(): RequestInit {
  return {
    method: "POST",
    redirect: "error",
    headers: { "cf-aig-request-timeout": "1000" },
    body: "{}",
  };
}

describe("research model gateway runtime", () => {
  it("drains native response bytes before reading a log published only at stream completion", async () => {
    const metadata = { budget_reservation_ref: "budget-one", evidence_pack_ref: "pack-one:1",
      output_object_ref: "output-one", prompt_generation: "prompt-one", schema_generation: "schema-one" };
    let finished = false, pulls = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) {
      if (pulls++ === 0) controller.enqueue(new TextEncoder().encode("complete"));
      else { finished = true; controller.close(); }
    } });
    const nativeRun = vi.fn(async () => new Response(stream, { headers: { "cf-aig-log-id": GATEWAY_LOG.id } }));
    const getLog = vi.fn(async () => {
      if (!finished) throw new Error("Gateway cannot publish this log until the response stream finishes");
      return { ...GATEWAY_LOG, metadata };
    });
    const runtime = createResearchModelGatewayRuntime({ reasoning_gateway_base_url: BASE_URL,
      transport_policy: WORKERS_AI_POLICY, ai_gateway_binding: {
        run: nativeRun, gateway: () => ({ ...gateway(BASE_URL), getLog }),
      } });
    const response = await runtime.binding_transport.fetch(ENDPOINT, { ...requestInit(), body: JSON.stringify({ model: "dynamic/eliotr-balanced" }), headers: {
      "cf-aig-request-timeout": "1000", "cf-aig-collect-log": "true", "cf-aig-collect-log-payload": "false",
      "cf-aig-skip-cache": "true", "cf-aig-max-attempts": "1", "cf-aig-metadata": JSON.stringify(metadata),
    } });
    expect(await response.text()).toBe("complete");
    expect(nativeRun).toHaveBeenCalledTimes(1);
    expect(getLog).toHaveBeenCalledTimes(1);
    expect(response.headers.get("cf-aig-model")).toBe(WORKERS_AI_POLICY.model);
  });

  it("keeps cancellation active while native log readback is pending after the body was drained", async () => {
    const controller = new AbortController();
    let announceLog!: () => void;
    const logStarted = new Promise<void>(resolve => { announceLog = resolve; });
    const nativeRun = vi.fn(async () => new Response("complete", { headers: { "cf-aig-log-id": GATEWAY_LOG.id } }));
    const runtime = createResearchModelGatewayRuntime({ reasoning_gateway_base_url: BASE_URL,
      transport_policy: WORKERS_AI_POLICY, signal: controller.signal, ai_gateway_binding: {
        run: nativeRun, gateway: () => ({ ...gateway(BASE_URL), getLog: async () => {
          announceLog(); return new Promise<AiGatewayLog>(() => {});
        } }),
      } });
    const pending = runtime.binding_transport.fetch(ENDPOINT, { ...requestInit(), body: JSON.stringify({ model: "dynamic/eliotr-balanced" }), headers: {
      "cf-aig-request-timeout": "1000", "cf-aig-collect-log": "true", "cf-aig-collect-log-payload": "false",
      "cf-aig-skip-cache": "true", "cf-aig-max-attempts": "1", "cf-aig-metadata": JSON.stringify({
        budget_reservation_ref: "budget-one", evidence_pack_ref: "pack-one:1", output_object_ref: "output-one",
        prompt_generation: "prompt-one", schema_generation: "schema-one",
      }),
    } });
    await logStarted;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(nativeRun).toHaveBeenCalledTimes(1);
  });

  it.each(["server-held-external-token", " bearer"])(
    "prefers the native binding for builtin calls regardless of external credential %s", (token) => {
      const native = { gateway: vi.fn() };
      const env = { AI: native, AI_GATEWAY_REASONING_URL: BASE_URL, ELIOTR_MODEL_GATEWAY_TOKEN: token } as unknown as Env;
      const configured = composeResearchModelGatewayConfiguration(env);
      expect(configured.ai_gateway_binding).toBe(native);
      expect(configured).not.toHaveProperty("gateway_token");
      expect(configured).not.toHaveProperty("fetch");
      expect(native.gateway).not.toHaveBeenCalled();
    },
  );

  it("selects external HTTP credentials by provider and never falls back across providers", () => {
    const native = { gateway: vi.fn() };
    const env = { AI: native, AI_GATEWAY_REASONING_URL: BASE_URL,
      ELIOTR_MODEL_GATEWAY_TOKEN: "server-held-external-token" } as unknown as Env;
    expect(composeResearchModelGatewayConfiguration(env, "openrouter")).toEqual({
      reasoning_gateway_base_url: BASE_URL, gateway_token: "server-held-external-token",
    });
    expect(() => composeResearchModelGatewayConfiguration({ ...env, ELIOTR_MODEL_GATEWAY_TOKEN: undefined }, "openrouter"))
      .toThrow(expect.objectContaining({ code: "WORKFLOW_CREDENTIALS_MISSING" }));
    expect(() => composeResearchModelGatewayConfiguration({ ...env, ELIOTR_MODEL_GATEWAY_TOKEN: " bearer" }, "openrouter"))
      .toThrow(expect.objectContaining({ code: "WORKFLOW_CREDENTIALS_INVALID" }));
    expect(() => composeResearchModelGatewayConfiguration({ ...env, AI: undefined } as unknown as Env, "workers-ai"))
      .toThrow(expect.objectContaining({ code: "WORKFLOW_CREDENTIALS_MISSING" }));
    expect(native.gateway).not.toHaveBeenCalled();
  });

  it("still rejects explicitly mixing native binding with a token or custom HTTP fetch", () => {
    const native = { gateway: vi.fn() };
    const fetcher = vi.fn();
    for (const extra of [{ gateway_token: "server-held-token" }, { fetch: fetcher }]) {
      expect(() => createResearchModelGatewayRuntime({ reasoning_gateway_base_url: BASE_URL,
        ai_gateway_binding: native, ...extra } as never)).toThrowError(ModelGatewayExecutionError);
    }
    expect(native.gateway).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retains the canonical HTTP policy and rejects invalid BYOK and native binding alias fallback", async () => {
    let fetchCalls = 0;
    const http = createResearchModelGatewayRuntime({
      reasoning_gateway_base_url: BASE_URL,
      gateway_token: "server-held-token",
      transport_policy: WORKERS_AI_POLICY,
      fetch: async (_url, init) => {
        fetchCalls += 1;
        expect(new Headers(init?.headers).get("cf-aig-byok-alias")).toBeNull();
        expect(new Headers(init?.headers).get("cf-aig-no-wholesale")).toBeNull();
        return new Response("ok");
      },
    });
    expect(http.transport_policy).toEqual(WORKERS_AI_POLICY);
    await http.transport.fetch(ENDPOINT, requestInit());
    expect(fetchCalls).toBe(1);

    let bindingCalls = 0;
    expect(() => createResearchModelGatewayRuntime({
      reasoning_gateway_base_url: BASE_URL,
      transport_policy: INVALID_WORKERS_AI_BYOK_POLICY,
      ai_gateway_binding: {
        gateway: () => ({ ...gateway(BASE_URL), run: async () => { bindingCalls += 1; return new Response("unexpected"); } }),
      },
    })).toThrowError(ModelGatewayExecutionError);
    expect(bindingCalls).toBe(0);

    const binding = createResearchModelGatewayRuntime({
      reasoning_gateway_base_url: BASE_URL,
      ai_gateway_binding: {
        gateway: () => ({ ...gateway(BASE_URL), run: async () => { bindingCalls += 1; return new Response("unexpected"); } }),
      },
    });
    await expect(binding.binding_transport.fetch(ENDPOINT, {
      ...requestInit(),
      headers: {
        "cf-aig-request-timeout": "1000",
        "cf-aig-byok-alias": "glm",
        "cf-aig-no-wholesale": "true",
      },
    })).rejects.toMatchObject({ code: "MODEL_GATEWAY_REQUEST_INVALID" });
    expect(bindingCalls).toBe(0);
  });

  it("uses the account-bound Worker gateway without a token and preserves request policy", async () => {
    let invocation: Parameters<NativeGateway["run"]>[0] | undefined;
    let options: Parameters<NativeGateway["run"]>[1] | undefined;
    let calls = 0;
    const metadata = {
      budget_reservation_ref: "budget-one", evidence_pack_ref: "pack-one:1", output_object_ref: "output-one",
      prompt_generation: "prompt-one", schema_generation: "schema-one",
    };
    const canonicalHeaders = {
      "cf-aig-collect-log": "true",
      "cf-aig-collect-log-payload": "false",
      "cf-aig-skip-cache": "true",
      "cf-aig-metadata": JSON.stringify(metadata),
      "cf-aig-request-timeout": "1000",
      "cf-aig-max-attempts": "1",
    };
    const controller = new AbortController();
    const runtime = createResearchModelGatewayRuntime({
      reasoning_gateway_base_url: BASE_URL,
      ai_gateway_binding: { gateway(gatewayId) {
        expect(gatewayId).toBe("eliotr-reasoning");
        return {
          getUrl: async () => BASE_URL,
          getLog: async () => { throw new Error("fingerprinted response does not need a log read"); },
          async run(request, requestOptions) {
            calls += 1;
            invocation = request;
            options = requestOptions;
            return new Response('{"ok":true}', { headers: {
              "cf-aig-log-id": "binding-log", "cf-aig-provider": "controlled", "cf-aig-model": "controlled",
            } });
          },
        };
      } },
    });
    const query = { model: "dynamic/eliotr-balanced", messages: [{ role: "user", content: "fixture" }] };
    const response = await runtime.binding_transport.fetch(ENDPOINT, {
      ...requestInit(), signal: controller.signal, body: JSON.stringify(query), headers: canonicalHeaders,
    });
    expect(calls).toBe(1);
    expect(invocation).toEqual({ provider: "compat", endpoint: "chat/completions", headers: {}, query });
    if (invocation === undefined || Array.isArray(invocation)) throw new Error("expected one Universal request");
    expect(invocation.query).toEqual(query);
    expect(options?.gateway).toEqual({ id: "eliotr-reasoning", collectLog: true, skipCache: true, metadata,
      requestTimeoutMs: 1000, retries: { maxAttempts: 1 } });
    expect(options?.extraHeaders).toEqual(canonicalHeaders);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(runtime).not.toHaveProperty("credentials");
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("binding did not return a Response");
    expect(await response.text()).toBe('{"ok":true}');
    expect(response.headers.get("cf-aig-log-id")).toBe("binding-log");
  });

  it("does not invoke a binding in another account or after cancellation during account readback", async () => {
    let calls = 0;
    const controller = new AbortController();
    for (const cancel of [false, true]) {
      const runtime = createResearchModelGatewayRuntime({
        reasoning_gateway_base_url: BASE_URL, signal: controller.signal,
        ai_gateway_binding: { gateway: () => ({
          getUrl: async () => { if (cancel) controller.abort(); return cancel ? BASE_URL : BASE_URL.replace(ACCOUNT_ID, "b".repeat(32)); },
          getLog: async () => { throw new Error("denied account cannot read model logs"); },
          run: async () => { calls += 1; return new Response("unexpected"); },
        }) },
      });
      await expect(runtime.binding_transport.fetch(ENDPOINT, requestInit()))
        .rejects.toMatchObject(cancel ? { name: "AbortError" } : { code: "MODEL_GATEWAY_REQUEST_INVALID" });
    }
    expect(calls).toBe(0);
  });

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
    expect(requestedInit?.redirect).toBe("manual");
    expect(requestedInit?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(requestedInit?.headers).get("cf-aig-request-timeout")).toBe("1000");
  });

  it("does not follow an upstream redirect or expose its body", async () => {
    let calls = 0;
    const runtime = createResearchModelGatewayRuntime({ reasoning_gateway_base_url: BASE_URL,
      gateway_token: "server-held-token", fetch: async (_url, init) => {
        calls += 1;
        expect(init?.redirect).toBe("manual");
        return new Response("untrusted redirect body", { status: 302, headers: { location: "https://other.example/" } });
      } });
    await expect(runtime.transport.fetch(ENDPOINT, requestInit())).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
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
    await expect(runtime.transport.fetch(ENDPOINT, { ...requestInit(), redirect: "manual" }))
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
