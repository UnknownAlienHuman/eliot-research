import { beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryError } from "./library";
import { MODELS, type ModelSpec } from "./models";

vi.mock("agents/models/ai-sdk", () => ({ createAI: vi.fn() }));

import { createAI } from "agents/models/ai-sdk";
import type * as agentsSdk from "agents/models/ai-sdk";
import { modelFailure, resolveModelTransport } from "./model-transport";
import { Output, streamText } from "ai";
import { z } from "zod";

const createAIMock = vi.mocked(createAI);

function mustFind(route: string): ModelSpec {
  const found = MODELS.find((item) => item.route === route);
  if (!found) throw new Error("test fixture model missing: " + route);
  return found;
}

const NATIVE = mustFind("workers-ai:@cf/zai-org/glm-5.3-flash");
const EXTERNAL = mustFind("gateway:google/gemini-2.5-flash");

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

  it("rejects external before invocation without a valid gateway", async () => {
    const languageModel = vi.fn();
    createAIMock.mockReturnValue({ languageModel } as unknown as ReturnType<typeof createAI>);
    const ids: Array<string | null> = [null, "default", "Bad Slug!"];
    for (const gatewayId of ids) {
      const seen = makeEnv(gatewayId);
      let err: unknown;
      try {
        await resolveModelTransport(seen.env, EXTERNAL, "chat-1");
        expect.unreachable();
      } catch (e) { err = e; }
      expect(err).toBeInstanceOf(LibraryError);
      expect((err as LibraryError).code).toBe("unavailable");
      expect((err as LibraryError).status).toBe(503);
    }
    expect(languageModel).not.toHaveBeenCalled();
    expect(createAIMock).not.toHaveBeenCalled();
  });

  it("passes exact gateway options without auth, retry expansion, or reasoning", async () => {
    const sdkModel = { fake: "external-model" };
    const languageModel = vi.fn().mockReturnValue(sdkModel);
    createAIMock.mockReturnValue({ languageModel } as unknown as ReturnType<typeof createAI>);
    const seen = makeEnv("my-gw");
    const out = await resolveModelTransport(seen.env, EXTERNAL, "chat-1");
    expect(out).toBe(sdkModel);
    expect(createAIMock).toHaveBeenCalledWith({ binding: seen.env.AI });
    expect(languageModel).toHaveBeenCalledWith("google/gemini-2.5-flash", {
      sessionAffinity: "chat-1",
      headers: {
        "cf-aig-no-wholesale": "true",
        "cf-aig-max-attempts": "1",
        "cf-aig-skip-cache": "true",
        "cf-aig-collect-log": "false",
      },
      gateway: { id: "my-gw", skipCache: true, collectLog: false, retries: { maxAttempts: 1 } },
    });
    expect(seen.prepared.some((sql) => sql.includes("model_gateway_id"))).toBe(true);
    const options = languageModel.mock.calls[0] ? languageModel.mock.calls[0][1] : {};
    const serialized = JSON.stringify(options).toLowerCase();
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("reasoningeffort");
    expect(serialized).not.toContain("fallback");
    expect(serialized).not.toContain("byokalias");
    expect(serialized).not.toContain("dynamic");
  });
});

describe("modelFailure", () => {
  it("keeps external errors static and redacts provider details", () => {
    const err = new Error("provider 401: bad key sk-live-SECRET123");
    const text = modelFailure(err, EXTERNAL);
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
    return JSON.stringify({ id: "t1", object: "chat.completion.chunk", created: 1, model: "fake",
      choices: [], usage });
  }
  function fakeBinding(body: string) {
    const wire: { model?: unknown; options?: { extraHeaders?: Record<string, string>; gateway?: unknown }; calls: number } = { calls: 0 };
    const run = async (model: unknown, _input: unknown, options: { extraHeaders?: Record<string, string>; gateway?: unknown }) => {
      wire.calls += 1;
      wire.model = model;
      wire.options = options;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    return { binding: { run }, wire };
  }
  function runStructured(model: unknown) {
    return streamText({ model: model as Parameters<typeof streamText>[0]["model"],
      output: Output.object({ schema, name: "cited_answer" }),
      instructions: "rules", messages: [{ role: "user", content: "hi" }],
      maxOutputTokens: 64, maxRetries: 0 });
  }

  it("streams structured output and maps SDK usage on the external catalog path", async () => {
    await useRealSDK();
    const textPayload = JSON.stringify({ sentences: ["Hello world"] });
    const body = sse([
      chunk({ role: "assistant", content: textPayload }, null),
      chunk({}, "stop"),
      usageOnly({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
    ]);
    const captured = fakeBinding(body);
    const model = await resolveModelTransport(
      { AI: captured.binding as unknown as Env["AI"], DB: makeEnv("my-gw").env.DB }, EXTERNAL, "sess");
    const result = runStructured(model);
    await expect(result.output).resolves.toEqual({ sentences: ["Hello world"] });
    const usage = await result.totalUsage;
    expect(usage?.inputTokens).toBe(10);
    expect(usage?.outputTokens).toBe(5);
    expect(captured.wire.model).toBe("google/gemini-2.5-flash");
    // sessionAffinity is sent as the x-session-affinity header by the installed
    // SDK (documented on ModelOptions); the binding path stays keyless.
    expect(captured.wire.options?.extraHeaders).toEqual({
      "cf-aig-no-wholesale": "true",
      "cf-aig-max-attempts": "1",
      "cf-aig-skip-cache": "true",
      "cf-aig-collect-log": "false",
      "x-session-affinity": "sess",
    });
    expect(Object.keys(captured.wire.options?.extraHeaders ?? {}).some((k) => k.toLowerCase() === "authorization")).toBe(false);
    expect(captured.wire.options?.gateway).toEqual({
      id: "my-gw", skipCache: true, collectLog: false, retries: { maxAttempts: 1 },
    });
    expect(captured.wire.calls).toBe(1);
  });

  it("keeps absent usage undefined and surfaces provider errors bounded", async () => {
    await useRealSDK();
    const noUsage = sse([chunk({ role: "assistant", content: JSON.stringify({ sentences: ["ok"] }) }, "stop")]);
    const okCaptured = fakeBinding(noUsage);
    const okModel = await resolveModelTransport(
      { AI: okCaptured.binding as unknown as Env["AI"], DB: makeEnv("my-gw").env.DB }, EXTERNAL, "sess");
    const okResult = runStructured(okModel);
    await expect(okResult.output).resolves.toEqual({ sentences: ["ok"] });
    const usage = await okResult.totalUsage;
    expect(usage?.inputTokens).toBeUndefined();
    expect(usage?.outputTokens).toBeUndefined();
    expect(okCaptured.wire.model).toBe("google/gemini-2.5-flash");
    expect(okCaptured.wire.calls).toBe(1);
    const errBody = sse([JSON.stringify({ error: { message: "provider exploded", type: "provider_error" } })]);
    const errCaptured = fakeBinding(errBody);
    const errModel = await resolveModelTransport(
      { AI: errCaptured.binding as unknown as Env["AI"], DB: makeEnv("my-gw").env.DB }, EXTERNAL, "sess");
    const errResult = runStructured(errModel);
    let err: unknown;
    try {
      await errResult.output;
      await errResult.totalUsage;
      expect.unreachable();
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(modelFailure(err, EXTERNAL)).toBe("External model request failed. Check the Gateway connection and provider status; no retry was started.");
    expect(errCaptured.wire.calls).toBe(1);
  });
});
