import { streamText } from "ai";
import { describe, expect, it, vi } from "vitest";
import { resolveModelTransport } from "./model-transport";
import { DEFAULT_MODEL, MODELS, modelOutputLimit, modelOutputReserve, type ModelSpec } from "./models";

describe("native fallback reasoning request", () => {
  it.each([32768, 4096, null])("forwards low and the published %s output maximum through the installed adapter", async (capacity) => {
    const fallback = MODELS.find((entry) => entry.route === DEFAULT_MODEL);
    if (!fallback) throw new Error("The built-in native model fallback is missing.");
    const model = { ...fallback, maxOutputTokens: capacity };
    expect(model).toMatchObject({
      id: "@cf/zai-org/glm-5.3-flash",
      contextTokens: 1_048_576,
      outputReserveTokens: 8192,
      nativeReasoningEffort: "low",
    });
    expect(modelOutputReserve(model)).toBe(Math.min(8192, capacity ?? 8192));

    let captured: { model: string; inputs: Record<string, unknown>; options: Record<string, unknown> } | undefined;
    const run = vi.fn(async (modelId: string, inputs: Record<string, unknown>, options: Record<string, unknown>) => {
      captured = { model: modelId, inputs, options };
      const chunk = (value: unknown) => "data: " + JSON.stringify(value) + "\n\n";
      const base = { id: "request-capture", object: "chat.completion.chunk", created: 0, model: modelId };
      return new Response(
        chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Captured without inference." }, finish_reason: null }] }) +
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
        chunk({ ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) +
        "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const AI = { run } as unknown as Env["AI"];
    const transport = await resolveModelTransport({ AI, DB: {} as Env["DB"] }, model, "native-reasoning-test");
    const maxOutputTokens = modelOutputLimit(model, 1024);
    const result = await streamText({ model: transport, prompt: "Capture the native request only.",
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }), maxRetries: 0 }).text;

    expect(result).toBe("Captured without inference.");
    expect(run).toHaveBeenCalledTimes(1);
    expect(captured?.model).toBe(model.id);
    expect(captured?.inputs).toMatchObject({
      reasoning_effort: "low",
      stream: true,
      stream_options: { include_usage: true },
    });
    if (capacity === null) expect(captured?.inputs).not.toHaveProperty("max_tokens");
    else expect(captured?.inputs.max_tokens).toBe(capacity);
    expect(captured?.inputs).not.toHaveProperty("max_completion_tokens");
    expect(captured?.inputs.reasoning_effort).not.toBe("max");
    expect((captured?.inputs.chat_template_kwargs as Record<string, unknown> | undefined)?.enable_thinking).not.toBe(false);
    expect(captured?.options.returnRawResponse).toBe(true);
  });
});

describe.each([
  { protocol: undefined, name: "legacy compatible", modelId: "fixture-output", field: "max_tokens", fallback: undefined },
  { protocol: undefined, name: "OpenRouter", modelId: "fixture-output", field: "max_tokens", fallback: undefined },
  { protocol: "openai-chat", name: "Chat Completions", modelId: "fixture-output", field: "max_tokens", fallback: undefined },
  { protocol: "openai-responses", name: "Responses", modelId: "fixture-output", field: "max_output_tokens", fallback: undefined },
  { protocol: "anthropic", name: "Anthropic unknown non-Claude", modelId: "fixture-output", field: "max_tokens", fallback: 4096 },
  { protocol: "anthropic", name: "Anthropic unknown Claude", modelId: "claude-fixture-output", field: "max_tokens", fallback: 128000 },
  { protocol: "google", name: "Google", modelId: "gemini-fixture-output", field: "maxOutputTokens", fallback: undefined },
] as const)("$name pinned request body", ({ protocol, name, modelId, field, fallback }) => {
  it.each([32768, 4096, null])("captures published maximum %s without inference", async (capacity) => {
    const router = name === "OpenRouter";
    const provider = { id: router ? "openrouter" : "fixture", type: "openai-compatible" as const,
      gatewaySlug: router ? "openrouter" : "fixture", gatewayPath: "v1", enabled: true,
      baseUrl: router ? "https://openrouter.ai/api/v1" : "https://vendor.example/api" };
    const model: ModelSpec = { route: `gateway:${provider.id}/${modelId}`, id: modelId, label: name,
      contextTokens: 64000, maxOutputTokens: capacity, outputReserveTokens: 8192,
      checkedOn: "2026-11-04", enabled: true, routing: { provider, gatewayId: "fixture" },
      ...(protocol === undefined ? {} : { apiProtocol: protocol, apiBaseUrl: provider.baseUrl + "/v1" }) };
    let captured: Record<string, unknown> | undefined;
    const stop = new Error("Stopped after local request capture.");
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      throw stop;
    });
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request."));
    try {
      const transport = await resolveModelTransport({ AI: { fetch } as unknown as Env["AI"], DB: {} as Env["DB"] }, model, "output-capture");
      const maxOutputTokens = modelOutputLimit(model, 1024);
      await expect(streamText({ model: transport, prompt: "Capture only.",
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }), maxRetries: 0 }).text).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(network).not.toHaveBeenCalled();
      if (!captured) throw new Error("The pinned transport did not reach the local request capture.");
      const body = protocol === "google" ? captured.generationConfig as Record<string, unknown> : captured;
      const expected = capacity ?? fallback;
      if (expected === undefined) expect(body).not.toHaveProperty(field);
      else expect(body[field]).toBe(expected);
      expect(model.maxOutputTokens).toBe(capacity);
    } finally { network.mockRestore(); }
  });
});
