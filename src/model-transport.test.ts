import { beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryError } from "./library";
import { MODELS, type ModelSpec } from "./models";

vi.mock("agents/models/ai-sdk", () => ({ createAI: vi.fn() }));

import { createAI } from "agents/models/ai-sdk";
import type * as agentsSdk from "agents/models/ai-sdk";
import { modelFailure, reportedProviderUsage, resolveModelTransport } from "./model-transport";
import { Output, streamText } from "ai";
import { z } from "zod";

const createAIMock = vi.mocked(createAI);

function mustFind(route: string): ModelSpec {
  const found = MODELS.find((item) => item.route === route);
  if (!found) throw new Error("test fixture model missing: " + route);
  return found;
}

const NATIVE = mustFind("workers-ai:@cf/zai-org/glm-5.3-flash");

const DOTS = mustFind("gateway:openrouter/dots-studio/dots-3-note-preview:free");
const INKLING = mustFind("gateway:openrouter/thinkingmachines/inkling:free");
const NEMOTRON = mustFind("gateway:openrouter/nvidia/nemotron-3.5-super-vl:free");

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
  function runStructured(model: unknown) {
    return streamText({ model: model as Parameters<typeof streamText>[0]["model"],
      output: Output.object({ schema, name: "cited_answer" }),
      instructions: "rules", messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 64, maxRetries: 0 });
  }
  function sentBody(wire: { init?: { body?: unknown } }) {
    return JSON.parse(String(wire.init?.body)) as { model?: unknown; provider?: unknown; response_format?: unknown; messages?: Array<{ role?: unknown; content?: unknown }> };
  }
  function assertProviderNative(wire: { url?: unknown; init?: { headers?: Record<string, string> }; calls?: number }) {
    expect(wire.calls).toBe(1);
    expect(String(wire.url)).toContain("/ai-gateway/gateways/my-gw/openrouter/v1/chat/completions");
    const headers = wire.init?.headers ?? {};
    expect(Object.keys(headers).some((k) => k.toLowerCase() === "authorization")).toBe(false);
  }

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
    expect("response_format" in sent).toBe(false);
    // The explicit schema instruction is the caller codec job (chat/distill add
    // z.toJSONSchema when model.responseFormat is false); transport only strips.
    expect(sent.messages).toEqual([{ role: "system", content: "rules" }, { role: "user", content: "hi" }]);
  });

  it("surfaces provider errors bounded with a single binding call", async () => {
    await useRealSDK();
    const errBody = sse([JSON.stringify({ error: { message: "provider exploded", type: "provider_error" } })]);
    const seen = fakeBinding(errBody);
    const model = await resolveModelTransport(
      { AI: seen.binding as unknown as Env["AI"], DB: makeEnv("my-gw").env.DB }, DOTS, "sess");
    const result = runStructured(model);
    let err: unknown;
    try {
      await result.output;
      await result.totalUsage;
      expect.unreachable();
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    const text = modelFailure(err, DOTS);
    expect(text.startsWith("External model request failed (cause: ")).toBe(true);
    expect(text).toContain("no retry was started.");
    expect(text).not.toContain("provider exploded");
    expect(text.length).toBeLessThanOrEqual(200);
    expect(seen.wire.calls).toBe(1);
  });
});
