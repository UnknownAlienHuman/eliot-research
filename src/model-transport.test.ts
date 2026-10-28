import { beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryError } from "./library";
import type { ModelSpec } from "./models";

vi.mock("agents/models/ai-sdk", () => ({ createAI: vi.fn() }));

import { createAI } from "agents/models/ai-sdk";
import type * as agentsSdk from "agents/models/ai-sdk";
import { AssistantWireCapture, modelFailure, reportedProviderUsage, resolveModelTransport } from "./model-transport";
import type { AssistantWire } from "./model-transport";
import { Output, streamText } from "ai";
import type { LanguageModelUsage } from "ai";
import { z } from "zod";

const createAIMock = vi.mocked(createAI);

const BASE = {
  contextTokens: 1_048_576,
  maxOutputTokens: 8192,
  inputMicrousdPerMillion: 150000,
  cachedMicrousdPerMillion: 30000,
  outputMicrousdPerMillion: 500000,
  checkedOn: "2026-10-26",
  enabled: true,
} as const;

const NATIVE = {
  ...BASE,
  route: "workers-ai:@cf/zai-org/glm-5.3-flash",
  id: "@cf/zai-org/glm-5.3-flash",
  label: "GLM 5.3 Flash",
  nativeReasoningEffort: "low",
} as ModelSpec;

const DOTS: ModelSpec = {
  ...BASE,
  route: "gateway:openrouter/dots-studio/dots-3-note-preview:free",
  id: "dots-studio/dots-3-note-preview:free",
  label: "Dots 3 Note Preview",
  maxOutputTokens: 460800,
  outputReserveTokens: 8192,
  structuredOutputs: true,
  responseFormat: true,
  reasoning: { enabled: false },
};

const INKLING: ModelSpec = {
  ...BASE,
  route: "gateway:openrouter/thinkingmachines/inkling:free",
  id: "thinkingmachines/inkling:free",
  label: "Inkling",
  maxOutputTokens: 262144,
  outputReserveTokens: 8192,
  structuredOutputs: false,
  responseFormat: false,
};

const NEMOTRON: ModelSpec = {
  ...BASE,
  route: "gateway:openrouter/nvidia/nemotron-3.5-super-vl:free",
  id: "nvidia/nemotron-3.5-super-vl:free",
  label: "Nemotron 3.5 Super VL",
  maxOutputTokens: 131072,
  outputReserveTokens: 8192,
  structuredOutputs: true,
  responseFormat: true,
};
const COMMAND_CODE: ModelSpec = { ...INKLING, route: "gateway:command-code/proxy-alias", id: "native-model-id", responseFormat: false };

function makeEnv(gatewayId: string | null) {
  const prepared: string[] = [];
  const DB = {
    prepare(sql: string) {
      prepared.push(sql);
      return { first: async () => ({ gatewayId }) };
    },
  } as unknown as Env["DB"];
  return { env: { AI: {} as unknown as Env["AI"], DB }, prepared };
}

describe("resolveModelTransport", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("resolves native without a settings lookup and passes the model through untouched", async () => {
    const sdkModel = { fake: "native-model" };
    const languageModel = vi.fn().mockReturnValue(sdkModel);
    createAIMock.mockReturnValue({ languageModel } as unknown as ReturnType<typeof createAI>);
    const seen = makeEnv(null);
    const out = await resolveModelTransport(seen.env, NATIVE, "chat-1");
    expect(out).toBe(sdkModel);
    expect(createAIMock).toHaveBeenCalledWith({ binding: seen.env.AI });
    expect(languageModel).toHaveBeenCalledWith(NATIVE.id, { reasoningEffort: "low", sessionAffinity: "chat-1" });
    expect(seen.prepared).toEqual([]);
  });

  it("rejects external before invocation without a valid gateway or exact route binding", async () => {
    const languageModel = vi.fn();
    createAIMock.mockReturnValue({ languageModel } as unknown as ReturnType<typeof createAI>);
    const mismatched: ModelSpec = { ...DOTS, route: "gateway:openrouter/other:free" };
    const cases: Array<{ gatewayId: string | null; model: ModelSpec }> = [
      { gatewayId: null, model: DOTS },
      { gatewayId: "default", model: DOTS },
      { gatewayId: "Bad Slug!", model: DOTS },
      { gatewayId: "my-gw", model: mismatched },
    ];
    for (const c of cases) {
      const seen = makeEnv(c.gatewayId);
      let err: unknown;
      try {
        await resolveModelTransport(seen.env, c.model, "chat-1");
        expect.unreachable();
      } catch (e) { err = e; }
      expect(err).toBeInstanceOf(LibraryError);
      expect((err as LibraryError).code).toBe("unavailable");
      expect((err as LibraryError).status).toBe(503);
    }
    expect(languageModel).not.toHaveBeenCalled();
    expect(createAIMock).not.toHaveBeenCalled();
  });

  it("passes a vendor object with exact gateway options and no credentials", async () => {
    const sdkModel = { fake: "external-model" };
    const languageModel = vi.fn().mockReturnValue(sdkModel);
    createAIMock.mockReturnValue({ languageModel } as unknown as ReturnType<typeof createAI>);
    const seen = makeEnv("my-gw");
    const out = await resolveModelTransport(seen.env, DOTS, "chat-1");
    expect(out).toBe(sdkModel);
    expect(createAIMock).toHaveBeenCalledWith({ binding: seen.env.AI });
    expect(languageModel).toHaveBeenCalledTimes(1);
    const firstCall = languageModel.mock.calls[0];
    if (!firstCall) throw new Error("expected languageModel call");
    const passed = firstCall[0] as { doStream?: unknown; modelId?: unknown };
    expect(typeof passed).toBe("object");
    expect(typeof passed.doStream).toBe("function");
    expect(passed.modelId).toBe("dots-studio/dots-3-note-preview:free");
    const options = firstCall[1] as Record<string, unknown>;
    expect(options.sessionAffinity).toBe("chat-1");
    expect(options.headers).toEqual({
      "cf-aig-no-wholesale": "true",
      "cf-aig-max-attempts": "1",
      "cf-aig-skip-cache": "true",
      "cf-aig-collect-log": "false",
    });
    expect(options.gateway).toEqual({ id: "my-gw", skipCache: true, collectLog: false, retries: { maxAttempts: 1 } });
    expect(options.vendorKey).toBe("gateway");
    expect(seen.prepared.some((sql) => sql.includes("model_gateway_id"))).toBe(true);
    const serialized = JSON.stringify({ modelId: passed.modelId, options }).toLowerCase();
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("apikey");
    expect(serialized).not.toContain("bearer");
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("reasoningeffort");
    expect(serialized).not.toContain("fallback");
    expect(serialized).not.toContain("byokalias");
    expect(serialized).not.toContain("dynamic");
  });
});

describe("reportedProviderUsage", () => {
  it("leaves Command Code cost currency unknown without mutating raw or changing OpenRouter USD", () => {
    const raw = Object.freeze({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.25 });
    const usage: LanguageModelUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15,
      inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: undefined, cacheWriteTokens: undefined },
      outputTokenDetails: { textTokens: 5, reasoningTokens: undefined }, raw };
    expect(reportedProviderUsage(usage, COMMAND_CODE.route)).toEqual({ inputTokens: 10, outputTokens: 5,
      totalTokens: 15, cachedTokens: null, reasoningTokens: null, costUsd: null });
    expect(reportedProviderUsage(usage)?.costUsd).toBe(0.25);
    expect(reportedProviderUsage(usage, DOTS.route)?.costUsd).toBe(0.25);
    expect(usage.raw).toBe(raw);
    expect(usage.raw?.cost).toBe(0.25);
  });
});

describe("modelFailure", () => {
  it("keeps external errors static and redacts provider details", () => {
    const err = new Error("provider 401: bad key sk-live-SECRET123");
    const text = modelFailure(err, DOTS);
    expect(text).toBe("External model request failed. Check the Gateway connection and provider status; no retry was started.");
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("401");
  });

  it("bounds native errors and falls back without an Error", () => {
    const err = new Error("x".repeat(500));
    err.name = "AI_RetryError";
    const bounded = modelFailure(err, NATIVE);
    expect(bounded.length).toBeLessThanOrEqual(300);
    expect(bounded.startsWith("AI_RetryError: ")).toBe(true);
    expect(modelFailure("boom", NATIVE)).toBe("Model stream failed.");
    expect(modelFailure(undefined, NATIVE)).toBe("Model stream failed.");
  });

  it("surfaces a typed HTTP status for external failures without raw details", () => {
    const rateLimited = new Error("irrelevant provider text");
    (rateLimited as unknown as Record<string, unknown>).statusCode = 429;
    expect(modelFailure(rateLimited, DOTS)).toBe(
      "External model request failed (HTTP 429). Check the Gateway connection and provider status; no retry was started.");
    const nested = new Error("outer", { cause: Object.assign(new Error("inner"), { statusCode: 503 }) });
    expect(modelFailure(nested, DOTS)).toBe(
      "External model request failed (HTTP 503). Check the Gateway connection and provider status; no retry was started.");
    const badStatus = new Error("bad");
    (badStatus as unknown as Record<string, unknown>).statusCode = "429";
    expect(modelFailure(badStatus, DOTS)).toBe(
      "External model request failed. Check the Gateway connection and provider status; no retry was started.");
    const named = new Error("outer", { cause: new TypeError("inner detail") });
    const namedText = modelFailure(named, DOTS);
    expect(namedText).toContain("(cause: TypeError)");
    expect(namedText).not.toContain("inner detail");
  });

  it("adds only fixed field names for a 400 without raw provider text", () => {
    const bad = new Error("outer sk-live-SECRET123");
    (bad as unknown as Record<string, unknown>).statusCode = 400;
    (bad as unknown as Record<string, unknown>).responseBody = JSON.stringify({ error: {
      message: "Invalid 'messages[0].reasoning_content': sk-live-SECRET123 and DROP TABLE secrets; plus bogus-field",
      param: "messages",
      code: "secret-code-123", type: "secret-type",
    } });
    (bad as unknown as Record<string, unknown>).data = { error: { param: "reasoning_content",
      message: "bad 'thought_signature' plus sk-live-SECRET123" } };
    const text = modelFailure(bad, DOTS);
    expect(text.startsWith("External model request failed (HTTP 400). Check the Gateway connection and provider status; no retry was started."));
    expect(text).toContain("Validation mentions fields: messages, reasoning_content, thought_signature.");
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("sk-live");
    expect(text).not.toContain("DROP TABLE");
    expect(text).not.toContain("bogus-field");
    expect(text).not.toContain("secret-code-123");
    expect(text).not.toContain("secret-type");
    expect(text).not.toContain("Invalid");
    const other = new Error("outer");
    (other as unknown as Record<string, unknown>).statusCode = 502;
    (other as unknown as Record<string, unknown>).responseBody = JSON.stringify({ error: { message: "bad messages" } });
    expect(modelFailure(other, DOTS)).toBe(
      "External model request failed (HTTP 502). Check the Gateway connection and provider status; no retry was started.");
  });
});

describe("real SDK streamText over a fake binding (contract fixture, no provider)", () => {
  const schema = z.object({ sentences: z.array(z.string()) });
  async function useRealSDK() {
    const realAgents = await vi.importActual<typeof agentsSdk>("agents/models/ai-sdk");
    createAIMock.mockImplementation(((settings: unknown) => realAgents.createAI(settings as never)) as typeof createAI);
  }
  function sse(chunks: string[]) {
    return chunks.map((c) => "data: " + c + "\n\n").join("") + "data: [DONE]\n\n";
  }
  function fragmentedSse(chunks: string[]) {
    const bytes = new TextEncoder().encode(sse(chunks));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }
  function chunk(delta: unknown, finish: string | null, usage?: unknown) {
    return JSON.stringify({ id: "t1", object: "chat.completion.chunk", created: 1, model: "fake",
      choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) });
  }
  function usageOnly(usage: unknown) {
    return JSON.stringify({ id: "t1", object: "chat.completion.chunk", created: 1, model: "fake", choices: [], usage });
  }
  function fakeBinding(body: string) {
    const wire: { url?: unknown; init?: { headers?: Record<string, string>; body?: unknown }; calls: number } = { calls: 0 };
    const fakeFetch = async (url: unknown, init: { headers?: Record<string, string>; body?: unknown }) => {
      wire.url = url;
      wire.init = init;
      wire.calls += 1;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    return { binding: { fetch: fakeFetch }, wire };
  }
  function rawCapture(capture: AssistantWireCapture) {
    return { include: { rawChunks: true },
      onChunk: ({ chunk }: { chunk: { type: string; rawValue?: unknown } }) => {
        if (chunk.type === "raw") capture.push(chunk.rawValue);
      } };
  }
  function runStructured(model: unknown, abortSignal?: AbortSignal, onError?: (event: { error: unknown }) => void,
    capture?: AssistantWireCapture) {
    return streamText({ model: model as Parameters<typeof streamText>[0]["model"],
      output: Output.object({ schema, name: "cited_answer" }),
      instructions: "rules", messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 64, maxRetries: 0, ...(abortSignal ? { abortSignal } : {}), ...(onError ? { onError } : {}), ...(capture ? rawCapture(capture) : {}) });
  }
  function sentBody(wire: { init?: { body?: unknown } }) {
    return JSON.parse(String(wire.init?.body)) as { model?: unknown; provider?: unknown; reasoning?: unknown; response_format?: unknown; messages?: Array<{ role?: unknown; content?: unknown }> };
  }
  function assertProviderNative(wire: { url?: unknown; init?: { headers?: Record<string, string> }; calls?: number }) {
    expect(wire.calls).toBe(1);
    expect(String(wire.url)).toContain("/ai-gateway/gateways/my-gw/openrouter/v1/chat/completions");
    const headers = wire.init?.headers ?? {};
    expect(Object.keys(headers).some((k) => k.toLowerCase() === "authorization")).toBe(false);
    expect(headers["cf-aig-no-wholesale"]).toBe("true");
    expect(headers["cf-aig-max-attempts"]).toBe("1");
    expect(headers["cf-aig-skip-cache"]).toBe("true");
    expect(headers["cf-aig-collect-log"]).toBe("false");
  }

  function fakeCommandCode(response: Response, afterDispatch?: () => void) {
    const fetch = vi.fn(async (..._args: unknown[]) => {
      afterDispatch?.();
      return response;
    });
    const gateway = vi.fn(), run = vi.fn(), catalogRun = vi.fn();
    const binding = { fetch, gateway, run: catalogRun } as unknown as Env["AI"];
    return { binding, gateway, run, fetch, catalogRun };
  }
  const commandCodeModel = (binding: Env["AI"], assistantHistory?: AssistantWire[]) => resolveModelTransport(
    { AI: binding, DB: makeEnv("my-gw").env.DB }, COMMAND_CODE, "cc-session", assistantHistory);

  it("uses one keyless custom-provider request with the native id and local JSON validation", async () => {
    createAIMock.mockClear();
    const seen = fakeCommandCode(new Response(sse([
      chunk({ content: JSON.stringify({ sentences: ["original source"] }) }, "stop"),
      usageOnly({ prompt_tokens: 10 }),
    ]), { headers: { "content-type": "text/event-stream" } }));
    const model = await commandCodeModel(seen.binding);
    const result = streamText({ model, output: Output.object({ schema }), instructions: "Return the JSON schema requested by the caller.",
      messages: [{ role: "user", content: "hi" }], maxOutputTokens: 64, maxRetries: 0,
      providerOptions: { commandCode: { provider: { allow_fallbacks: true }, response_format: { type: "json_object" } } } });
    await expect(result.output).resolves.toEqual({ sentences: ["original source"] });
    expect((await result.totalUsage).inputTokens).toBe(10);
    expect((await result.totalUsage).outputTokens).toBeUndefined();
    expect(seen.fetch).toHaveBeenCalledTimes(1);
    expect(seen.fetch.mock.contexts[0]).toBe(seen.binding);
    const url = seen.fetch.mock.calls[0]?.[0];
    expect(url).toBe('https://workers-binding.ai/ai-gateway/gateways/my-gw/custom-command-code/v1/chat/completions');
    const init = seen.fetch.mock.calls[0]?.[1] as { method?: unknown; headers?: unknown; body?: unknown };
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json", "x-session-affinity": "cc-session",
      "cf-aig-no-wholesale": "true", "cf-aig-max-attempts": "1", "cf-aig-skip-cache": "true", "cf-aig-collect-log": "false" });
    const sent = JSON.parse(String(init.body)) as { model?: unknown; stream?: unknown; stream_options?: unknown };
    expect(sent).toMatchObject({ model: COMMAND_CODE.id, stream: true, stream_options: { include_usage: true } });
    expect(sent).not.toHaveProperty("provider");
    expect(sent).not.toHaveProperty("response_format");
    expect(JSON.stringify({ url, headers: init.headers, body: sent }).toLowerCase()).not.toMatch(/authorization|bearer|api[-_]?key|proxy-alias/);
    expect(createAIMock).not.toHaveBeenCalled();
    expect(seen.gateway).not.toHaveBeenCalled();
    expect(seen.run).not.toHaveBeenCalled();
    expect(seen.catalogRun).not.toHaveBeenCalled();
  });

  it("does not fabricate missing reasoning fields for bare assistant history", async () => {
    await useRealSDK();
    const seen = fakeCommandCode(new Response(sse([
      chunk({ content: JSON.stringify({ sentences: ["ok"] }) }, "stop"),
    ]), { headers: { "content-type": "text/event-stream" } }));
    const capture = new AssistantWireCapture();
    const model = await commandCodeModel(seen.binding, [{ content: "previous answer" }]);
    const history: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: "first" },
      { role: "assistant", content: "previous answer" },
      { role: "user", content: "second" },
    ];
    const frozen = JSON.parse(JSON.stringify(history)) as unknown;
    const result = streamText({ model: model as Parameters<typeof streamText>[0]["model"], messages: history,
      output: Output.object({ schema: z.object({ sentences: z.array(z.string()) }) }), maxOutputTokens: 64, maxRetries: 0, ...rawCapture(capture) });
    await expect(result.output).resolves.toEqual({ sentences: ["ok"] });
    expect(seen.fetch).toHaveBeenCalledTimes(1);
    expect(history).toEqual(frozen);
    const sent = JSON.parse(String((seen.fetch.mock.calls[0]?.[1] as { body?: unknown }).body)) as { messages?: Array<Record<string, unknown>> };
    expect(sent.messages?.[0]).toEqual({ role: "user", content: "first" });
    expect(sent.messages?.[1]).toEqual({ role: "assistant", content: "previous answer" });
    expect(sent.messages?.[1]).not.toHaveProperty("reasoning_content");
    expect(sent.messages?.[1]).not.toHaveProperty("reasoning");
    expect(sent.messages?.[1]).not.toHaveProperty("reasoning_details");
    expect(sent.messages?.[2]).toEqual({ role: "user", content: "second" });
    expect(capture.message()).toEqual({ content: '{"sentences":["ok"]}' });
  });

  it("replays captured assistant messages in order without rewriting opaque protocol fields", async () => {
    await useRealSDK();
    const seen = fakeCommandCode(new Response(sse([
      chunk({ content: JSON.stringify({ sentences: ["current"] }) }, "stop"),
    ]), { headers: { "content-type": "text/event-stream" } }));
    const firstWire: AssistantWire = {
      content: "first answer",
      reasoning_content: "first reasoning",
      reasoning_details: [{ id: "reason-1", index: 0, type: "reasoning.text", text: "first" }],
    };
    const secondWire: AssistantWire = {
      content: "second answer",
      reasoning: "second reasoning",
      reasoning_details: [{ id: "opaque-2", index: 1, type: "reasoning.encrypted",
        signature: "opaque-signature/+:keep", data: "opaque-data/+/==:keep" }],
    };
    const assistantHistory = [firstWire, secondWire];
    const frozenHistory = JSON.stringify(assistantHistory);
    const model = await commandCodeModel(seen.binding, assistantHistory);
    const history = [
      { role: "user" as const, content: "first question" },
      { role: "assistant" as const, content: "first answer" },
      { role: "user" as const, content: "second question" },
      { role: "assistant" as const, content: "second answer" },
      { role: "user" as const, content: "current question" },
    ];
    const result = streamText({ model: model as Parameters<typeof streamText>[0]["model"], messages: history,
      output: Output.object({ schema }), maxOutputTokens: 64, maxRetries: 0 });
    await expect(result.output).resolves.toEqual({ sentences: ["current"] });
    await result.totalUsage;

    expect(seen.fetch).toHaveBeenCalledTimes(1);
    const init = seen.fetch.mock.calls[0]?.[1] as { body?: unknown } | undefined;
    const sent = JSON.parse(String(init?.body)) as { messages?: Array<Record<string, unknown>> };
    expect(sent.messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", ...firstWire },
      { role: "user", content: "second question" },
      { role: "assistant", ...secondWire },
      { role: "user", content: "current question" },
    ]);
    expect(assistantHistory).toEqual(JSON.parse(frozenHistory) as AssistantWire[]);
  });

  it("captures raw content and actual reasoning fields across fragmented UTF-8 SSE", async () => {
    await useRealSDK();
    const rawContent = '{"sentences":["Привет, café 🧪"]}';
    const seen = fakeCommandCode(fragmentedSse([
      chunk({ role: "assistant", content: '{"sentences":["Привет, ', reasoning_content: "мысль ", reasoning: "reason " }, null),
      chunk({ content: 'café 🧪"]}', reasoning_content: "задача 🧠", reasoning: "detail 🧭" }, "stop"),
    ]));
    const capture = new AssistantWireCapture();
    const model = await commandCodeModel(seen.binding, []);
    const result = runStructured(model, undefined, undefined, capture);
    await expect(result.output).resolves.toEqual({ sentences: ["Привет, café 🧪"] });
    await result.totalUsage;

    expect(seen.fetch).toHaveBeenCalledTimes(1);
    expect(capture.message()).toEqual({
      content: rawContent,
      reasoning_content: "мысль задача 🧠",
      reasoning: "reason detail 🧭",
    });
  });

  it("captures a clean assistant response as content-only when reasoning is absent", async () => {
    await useRealSDK();
    const rawContent = '{"sentences":["plain"]}';
    const seen = fakeCommandCode(new Response(sse([
      chunk({ role: "assistant", content: rawContent }, "stop"),
    ]), { headers: { "content-type": "text/event-stream" } }));
    const capture = new AssistantWireCapture();
    const model = await commandCodeModel(seen.binding, []);
    const result = runStructured(model, undefined, undefined, capture);
    await expect(result.output).resolves.toEqual({ sentences: ["plain"] });
    await result.totalUsage;

    expect(capture.message()).toEqual({ content: rawContent });
    expect(capture.message()).not.toHaveProperty("reasoning_content");
    expect(capture.message()).not.toHaveProperty("reasoning");
    expect(capture.message()).not.toHaveProperty("reasoning_details");
    expect(seen.fetch).toHaveBeenCalledTimes(1);
  });

  it("merges cumulative reasoning details by ID and index while preserving opaque signature and data", async () => {
    await useRealSDK();
    const rawContent = '{"sentences":["ok"]}';
    const opaqueDetail = { id: "opaque-2", index: 1, type: "reasoning.encrypted",
      signature: "opaque-signature/+:keep", data: "opaque-data/+/==:keep" };
    const seen = fakeCommandCode(new Response(sse([
      chunk({ role: "assistant", content: rawContent,
        reasoning_details: [{ id: "reason-1", index: 0, type: "reasoning.text", text: "a" }, opaqueDetail] }, null),
      chunk({ reasoning_details: [{ id: "reason-1", index: 0, type: "reasoning.text", text: "ab" }, opaqueDetail] }, null),
      chunk({ reasoning_details: [{ index: 0, text: "ab" }] }, "stop"),
    ]), { headers: { "content-type": "text/event-stream" } }));
    const capture = new AssistantWireCapture();
    const model = await commandCodeModel(seen.binding, []);
    const result = runStructured(model, undefined, undefined, capture);
    await expect(result.output).resolves.toEqual({ sentences: ["ok"] });
    await result.totalUsage;

    expect(capture.message()).toEqual({
      content: rawContent,
      reasoning_details: [
        { id: "reason-1", index: 0, type: "reasoning.text", text: "ab" },
        opaqueDetail,
      ],
    });
    expect(capture.message()?.reasoning_details?.[0]).toMatchObject({ text: "ab" });
    expect(capture.message()?.reasoning_details?.[1]).toEqual(opaqueDetail);
    expect(seen.fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves a shorter incremental reasoning detail that matches the previous prefix", async () => {
    const seen = fakeCommandCode(fragmentedSse([
      chunk({ role: "assistant", content: '{"sentences":["ok"]}',
        reasoning_details: [{ id: "detail-1", index: 0, type: "reasoning.text", text: "analysis" }] }, null),
      chunk({ reasoning_details: [{ index: 0, text: "anal" }] }, "stop"),
    ]));
    const capture = new AssistantWireCapture();
    const model = await commandCodeModel(seen.binding, []);
    const result = runStructured(model, undefined, undefined, capture);
    await expect(result.output).resolves.toEqual({ sentences: ["ok"] });
    await result.totalUsage;
    expect(capture.message()).toEqual({
      content: '{"sentences":["ok"]}',
      reasoning_details: [{ id: "detail-1", index: 0, type: "reasoning.text", text: "analysisanal" }],
    });
    expect(seen.fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the SDK raw JSON hook without requiring a transport sentinel", async () => {
    const rawContent = '{"sentences":["SDK owns framing"]}';
    const seen = fakeCommandCode(new Response("data: " + chunk({ role: "assistant", content: rawContent }, "stop") + "\n\n",
      { headers: { "content-type": "text/event-stream" } }));
    const capture = new AssistantWireCapture();
    const model = await commandCodeModel(seen.binding, []);
    const result = runStructured(model, undefined, undefined, capture);
    await expect(result.output).resolves.toEqual({ sentences: ["SDK owns framing"] });
    expect(await result.finishReason).toBe("stop");
    expect(capture.message()).toEqual({ content: rawContent });
    expect(seen.fetch).toHaveBeenCalledTimes(1);
  });

  it("publishes AssistantWire only from valid finished SDK raw JSON", async () => {
    await useRealSDK();
    const rawContent = '{"sentences":["partial"]}';
    const abortController = new AbortController();
    const overLimitContent = JSON.stringify({ sentences: ["ok"], padding: "x".repeat(1024 * 1024) });
    const cases: Array<{ name: string; response: Response; signal?: AbortSignal; afterDispatch?: () => void }> = [
      {
        name: "terminal choice error",
        response: new Response(sse([
          chunk({ role: "assistant", content: rawContent }, null),
          JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "error",
            error: { message: "synthetic terminal provider failure", type: "server_error" } }] }),
        ]), { headers: { "content-type": "text/event-stream" } }),
      },
      {
        name: "provider error",
        response: new Response(sse([
          chunk({ role: "assistant", content: rawContent }, null),
          JSON.stringify({ error: { message: "synthetic provider failure", type: "server_error" } }),
        ]), { headers: { "content-type": "text/event-stream" } }),
      },
      {
        name: "malformed event",
        response: new Response(sse([
          chunk({ role: "assistant", content: rawContent }, null),
          "{malformed-json",
        ]), { headers: { "content-type": "text/event-stream" } }),
      },
      {
        name: "incomplete stream",
        response: new Response(sse([chunk({ role: "assistant", content: rawContent }, null)]),
          { headers: { "content-type": "text/event-stream" } }),
      },
      {
        name: "invalid choices",
        response: new Response(sse([JSON.stringify({ choices: [null] })]),
          { headers: { "content-type": "text/event-stream" } }),
      },
      {
        name: "reasoning without answer content",
        response: new Response(sse([chunk({ reasoning_content: "private reasoning only" }, "stop")]),
          { headers: { "content-type": "text/event-stream" } }),
      },
      {
        name: "aborted stream",
        response: new Response(sse([chunk({ role: "assistant", content: rawContent }, "stop")]),
          { headers: { "content-type": "text/event-stream" } }),
        signal: abortController.signal,
        afterDispatch: () => abortController.abort(),
      },
      {
        name: "capture over 1 MiB",
        response: new Response(sse([chunk({ role: "assistant", content: overLimitContent }, "stop")]),
          { headers: { "content-type": "text/event-stream" } }),
      },
    ];

    for (const scenario of cases) {
      const capture = new AssistantWireCapture();
      const seen = fakeCommandCode(scenario.response, scenario.afterDispatch);
      const model = await commandCodeModel(seen.binding, []);
      const result = runStructured(model, scenario.signal, () => {}, capture);
      await Promise.allSettled([result.output, result.totalUsage]);

      expect(capture.message(), scenario.name).toBeUndefined();
      expect(seen.fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps existing reasoning fields, user/system messages and history-free bodies unchanged", async () => {
    const seen = fakeCommandCode(new Response(sse([
      chunk({ content: JSON.stringify({ sentences: ["ok"] }) }, "stop"),
    ]), { headers: { "content-type": "text/event-stream" } }));
    const model = (await commandCodeModel(seen.binding)) as unknown as { config: { fetch: typeof fetch;
      transformRequestBody: (body: Record<string, unknown>) => Record<string, unknown> } };
    const withReasoning = [
      { role: "assistant", content: "a", reasoning_content: "kept" },
      { role: "assistant", content: "b", reasoning_details: [{ type: "x" }] },
    ];
    await model.config.fetch("https://api.commandcode.ai/provider/v1/chat/completions", { method: "POST",
      body: JSON.stringify(model.config.transformRequestBody({ model: "x", stream: true, messages: withReasoning })) });
    const kept = JSON.parse(String((seen.fetch.mock.calls[0]?.[1] as { body?: unknown }).body)) as { messages?: unknown };
    expect(kept.messages).toEqual(withReasoning);
    seen.fetch.mockClear();
    const plain = [
      { role: "system", content: "rules" },
      { role: "user", content: "hi" },
    ];
    await model.config.fetch("https://api.commandcode.ai/provider/v1/chat/completions", { method: "POST",
      body: JSON.stringify(model.config.transformRequestBody({ model: "x", stream: true, messages: plain })) });
    const untouched = JSON.parse(String((seen.fetch.mock.calls[0]?.[1] as { body?: unknown }).body)) as { messages?: unknown };
    expect(untouched.messages).toEqual(plain);
    seen.fetch.mockClear();
    await model.config.fetch("https://api.commandcode.ai/provider/v1/chat/completions", { method: "POST",
      body: JSON.stringify(model.config.transformRequestBody({ model: "x", stream: true })) });
    const noHistory = JSON.parse(String((seen.fetch.mock.calls[0]?.[1] as { body?: unknown }).body)) as { messages?: unknown };
    expect(noHistory).not.toHaveProperty("messages");
  });

  it.each([
    { spec: DOTS, id: "dots-studio/dots-3-note-preview:free" },
    { spec: NEMOTRON, id: "nvidia/nemotron-3.5-super-vl:free" },
  ])("streams structured output on the provider-native path with mapped usage ($id)", async ({ spec, id }) => {
    await useRealSDK();
    const textPayload = JSON.stringify({ sentences: ["Hello world"] });
    const body = sse([
      chunk({ role: "assistant", content: textPayload }, null),
      chunk({}, "stop"),
      usageOnly({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 }, total_tokens: 15 }),
    ]);
    const seen = fakeBinding(body);
    const model = await resolveModelTransport(
      { AI: seen.binding as unknown as Env["AI"], DB: makeEnv("my-gw").env.DB }, spec, "sess");
    const result = runStructured(model);
    await expect(result.output).resolves.toEqual({ sentences: ["Hello world"] });
    const usage = await result.totalUsage;
    expect(usage?.inputTokens).toBe(10);
    expect(usage?.inputTokenDetails?.cacheReadTokens).toBe(2);
    expect(usage?.inputTokenDetails?.noCacheTokens).toBe(8);
    expect(usage?.outputTokens).toBe(5);
    expect(usage?.outputTokenDetails?.reasoningTokens).toBe(3);
    expect(usage?.outputTokenDetails?.textTokens).toBeUndefined();
    expect(reportedProviderUsage(usage)).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedTokens: 2, reasoningTokens: 3, costUsd: null });
    assertProviderNative(seen.wire);
    const sent = sentBody(seen.wire);
    expect(sent.model).toBe(id);
    expect(sent.provider).toEqual({ allow_fallbacks: false, require_parameters: true });
    if (spec.route === DOTS.route) expect(sent.reasoning).toEqual({ enabled: false });
    else expect(sent).not.toHaveProperty("reasoning");
    const format = sent.response_format as { type?: unknown; json_schema?: { name?: unknown; schema?: unknown } };
    expect(format.type).toBe("json_schema");
    expect(format.json_schema?.name).toBe("cited_answer");
    expect(JSON.stringify(format.json_schema?.schema)).toContain("sentences");
  });

  it("keeps partial usage unknown instead of zeroing missing counts", async () => {
    await useRealSDK();
    const body = sse([
      chunk({ role: "assistant", content: JSON.stringify({ sentences: ["partial"] }) }, null),
      chunk({}, "stop"),
      usageOnly({ prompt_tokens: 10 }),
    ]);
    const seen = fakeBinding(body);
    const model = await resolveModelTransport(
      { AI: seen.binding as unknown as Env["AI"], DB: makeEnv("my-gw").env.DB }, DOTS, "sess");
    const result = runStructured(model);
    await expect(result.output).resolves.toEqual({ sentences: ["partial"] });
    const usage = await result.totalUsage;
    expect(usage?.inputTokens).toBe(10);
    expect(usage?.outputTokens).toBeUndefined();
    expect(usage?.inputTokenDetails?.cacheReadTokens).toBeUndefined();
    expect(usage?.outputTokenDetails?.reasoningTokens).toBeUndefined();
    expect(reportedProviderUsage(usage)).toEqual({ inputTokens: 10, outputTokens: null, totalTokens: null, cachedTokens: null, reasoningTokens: null, costUsd: null });
    assertProviderNative(seen.wire);
  });

  it("keeps contradictory usage unknown instead of deriving zero", async () => {
    await useRealSDK();
    const cases: Array<{ name: string; usage: unknown }> = [
      { name: "total-below-prompt", usage: { prompt_tokens: 10, total_tokens: 5 } },
      { name: "reasoning-above-output", usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 7 }, total_tokens: 15 } },
      { name: "reasoning-above-derived-output", usage: { prompt_tokens: 10, completion_tokens_details: { reasoning_tokens: 12 }, total_tokens: 20 } },
    ];
    for (const c of cases) {
      const body = sse([
        chunk({ role: "assistant", content: JSON.stringify({ sentences: ["ok"] }) }, null),
        chunk({}, "stop"),
        usageOnly(c.usage),
      ]);
      const seen = fakeBinding(body);
      const model = await resolveModelTransport(
        { AI: seen.binding as unknown as Env["AI"], DB: makeEnv("my-gw").env.DB }, DOTS, "sess-" + c.name);
      const result = runStructured(model);
      await expect(result.output).resolves.toEqual({ sentences: ["ok"] });
      const usage = await result.totalUsage;
      expect(usage?.inputTokens).toBe(10);
      expect(usage?.outputTokens).toBeUndefined();
      expect(usage?.outputTokenDetails?.reasoningTokens).toBeUndefined();
      expect(seen.wire.calls).toBe(1);
    }
  });

  it("strips response_format the contract forbids and still parses plain JSON", async () => {
    await useRealSDK();
    const noUsage = sse([chunk({ role: "assistant", content: JSON.stringify({ sentences: ["ok"] }) }, "stop")]);
    const seen = fakeBinding(noUsage);
    const model = await resolveModelTransport(
      { AI: seen.binding as unknown as Env["AI"], DB: makeEnv("my-gw").env.DB }, INKLING, "sess");
    const result = runStructured(model);
    await expect(result.output).resolves.toEqual({ sentences: ["ok"] });
    const usage = await result.totalUsage;
    expect(usage?.inputTokens).toBeUndefined();
    expect(usage?.outputTokens).toBeUndefined();
    assertProviderNative(seen.wire);
    const sent = sentBody(seen.wire);
    expect(sent.model).toBe("thinkingmachines/inkling:free");
    expect(sent.provider).toEqual({ allow_fallbacks: false, require_parameters: true });
    expect(sent).not.toHaveProperty("reasoning");
    expect("response_format" in sent).toBe(false);
    // The explicit schema instruction is the caller codec job (chat/distill add
    // z.toJSONSchema when model.responseFormat is false); transport only strips.
    expect(sent.messages).toEqual([{ role: "system", content: "rules" }, { role: "user", content: "hi" }]);
  });

  it("keeps response_format json_object when the entry allows it without structured outputs", async () => {
    await useRealSDK();
    const allowed = { ...INKLING, responseFormat: true };
    const noUsage = sse([chunk({ role: "assistant", content: JSON.stringify({ sentences: ["ok"] }) }, "stop")]);
    const seen = fakeBinding(noUsage);
    const model = await resolveModelTransport(
      { AI: seen.binding as unknown as Env["AI"], DB: makeEnv("my-gw").env.DB }, allowed, "sess");
    const result = runStructured(model);
    await expect(result.output).resolves.toEqual({ sentences: ["ok"] });
    assertProviderNative(seen.wire);
    const sent = sentBody(seen.wire);
    expect(sent.model).toBe("thinkingmachines/inkling:free");
    expect(sent.provider).toEqual({ allow_fallbacks: false, require_parameters: true });
    expect(sent.response_format).toEqual({ type: "json_object" });
    expect(sent.messages).toEqual([{ role: "system", content: "rules" }, { role: "user", content: "hi" }]);
  });

  it("surfaces provider errors bounded with a single binding call", async () => {
    await useRealSDK();
    const errBody = sse([JSON.stringify({ error: { message: "provider exploded", type: "provider_error" } })]);
    const seen = fakeBinding(errBody);
    const model = await resolveModelTransport(
      { AI: seen.binding as unknown as Env["AI"], DB: makeEnv("my-gw").env.DB }, DOTS, "sess");
    let streamError: unknown;
    const result = runStructured(model, undefined, ({ error }) => { streamError = error; });
    await Promise.allSettled([result.output, result.totalUsage]);

    expect(streamError).toBeInstanceOf(Error);
    expect((streamError as Error).name).toBe("AI_StreamProviderError");
    expect((streamError as Error & { data?: unknown }).data).toEqual({
      message: "provider exploded",
      type: "provider_error",
    });
    const text = modelFailure(streamError, DOTS);
    expect(text.startsWith("External model request failed (cause: AI_StreamProviderError)")).toBe(true);
    expect(text).toContain("no retry was started.");
    expect(text).not.toContain("provider exploded");
    expect(text.length).toBeLessThanOrEqual(200);
    expect(seen.wire.calls).toBe(1);
  });

  it("names a standard mid-stream error type without echoing raw payload", async () => {
    await useRealSDK();
    const secretBody = sse([JSON.stringify({ error: { message: "sk-live-SECRET123 invalid payload DROP TABLE", type: "invalid_request_error", code: "secret-code-123", param: "messages" } })]);
    const seen = fakeBinding(secretBody);
    const model = await resolveModelTransport(
      { AI: seen.binding as unknown as Env["AI"], DB: makeEnv("my-gw").env.DB }, DOTS, "sess");
    let streamError: unknown;
    const result = runStructured(model, undefined, ({ error }) => { streamError = error; });
    await Promise.allSettled([result.output, result.totalUsage]);

    expect(streamError).toBeInstanceOf(Error);
    expect((streamError as Error).name).toBe("AI_StreamProviderError");
    expect((streamError as Error & { data?: unknown }).data).toEqual({
      message: "sk-live-SECRET123 invalid payload DROP TABLE",
      type: "invalid_request_error",
      code: "secret-code-123",
      param: "messages",
    });
    const text = modelFailure(streamError, DOTS);
    expect(text).toContain("(cause: AI_StreamProviderError:invalid_request_error)");
    expect(text).toContain("no retry was started.");
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("sk-live");
    expect(text).not.toContain("DROP TABLE");
    expect(text).not.toContain("secret-code-123");
    expect(text).not.toContain("messages");
    expect(text).not.toContain("invalid payload");
    expect(seen.wire.calls).toBe(1);
  });
});
