import { streamText, type LanguageModelUsage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { resolveModelTransport, safeEmptyCompletionLog } from "./model-transport";
import { DEFAULT_MODEL, MODELS, modelInputLimit, modelOutputLimit, modelOutputReserve, modelTokenLimit, type ModelSpec } from "./models";
import { chatModelMessages, estimateModelInput } from "./model-input";

it("joins only adjacent user input while retaining evidence, Unicode and assistant history verbatim", () => {
  const messages = [
    { role: "system", content: "Instructions stay separate." },
    { role: "user", content: "[S1:3] Источник 🧪\r\n" },
    { role: "user", content: "Derived orientation." },
    { role: "user", content: "Earlier question?" },
    { role: "assistant", content: "Earlier answer [S1:3]." },
  ] as const;
  const before = structuredClone(messages);
  expect(chatModelMessages(messages, "Новый вопрос?\n")).toEqual([
    { role: "user", content: "[S1:3] Источник 🧪\r\n\n\nDerived orientation.\n\nEarlier question?" },
    { role: "assistant", content: "Earlier answer [S1:3]." },
    { role: "user", content: "Новый вопрос?\n" },
  ]);
  expect(messages).toEqual(before);
  const question = "Новый вопрос?\n", instructions = messages[0].content;
  const raw = [...messages.filter(message => message.role !== "system"), { role: "user", content: question }];
  expect(estimateModelInput({ instructions, messages: raw }, { joinUserMessages: true }))
    .toBe(estimateModelInput({ instructions, messages: chatModelMessages(messages, question) }));
});

it("captures the pinned Anthropic default near the estimated input boundary while accounting remains unknown", async () => {
  const provider = { id: "fixture", type: "openai-compatible" as const, gatewaySlug: "fixture", gatewayPath: "v1", enabled: true, baseUrl: "https://vendor.example/api" };
  const model: ModelSpec = { route: "gateway:fixture/claude-fixture", id: "claude-fixture", label: "Offline boundary fixture",
    contextTokens: 64000, contextWindowTokens: 64000, maxOutputTokens: null, outputReserveTokens: 8192,
    checkedOn: "2026-11-04", enabled: true, routing: { provider, gatewayId: "fixture" }, apiProtocol: "anthropic", apiBaseUrl: provider.baseUrl };
  const inputBudget = modelInputLimit(model), instructions = "Offline boundary capture.";
  const framing = estimateModelInput({ instructions, messages: [{ role: "user", content: "" }] });
  const messages = [{ role: "user" as const, content: "x".repeat((inputBudget - framing) * 3) }];
  const estimate = estimateModelInput({ instructions, messages });
  expect(estimate).toBe(inputBudget);
  expect(modelOutputLimit(model, estimate)).toBeUndefined();
  let captured: Record<string, unknown> | undefined;
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body));
    throw new Error("Offline capture only, no upstream request.");
  });
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external request."));
  try {
    const transport = await resolveModelTransport({ AI: { fetch } as unknown as Env["AI"], DB: {} as Env["DB"] }, model, "boundary-capture");
    await expect(streamText({ model: transport, instructions, messages, maxRetries: 0 }).text).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1); expect(network).not.toHaveBeenCalled();
    expect(captured?.max_tokens).toBe(128000);
    expect(estimate + Number(captured?.max_tokens)).toBeGreaterThan(model.contextWindowTokens ?? Infinity);
    expect(model.maxOutputTokens).toBeNull(); expect(modelTokenLimit(model)).toBeNull();
  } finally { network.mockRestore(); }
});

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


describe("empty completion log projection", () => {
  const base = { turnId: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", model: { id: "test-model", route: "gateway:openrouter/test-model" }, finishReason: "stop", usage: undefined };
  it.each(["gen-1234567890", "gen-3bhGkxlo4XFrqiabUM7NDtwDzWwG", "chatcmpl-123"])("admits bounded opaque ID %s without claiming an exhaustive provider contract", (id) => {
    expect(safeEmptyCompletionLog({ ...base, response: { id, modelId: "test-model", timestamp: new Date(1000) } }))
      .toMatchObject({ responseId: id, responseIdPresent: true, responseModelId: "test-model", responseTimestamp: "1970-01-01T00:00:01.000Z" });
  });
  it.each(["INPUT_SECRET", "aitxt-generated", "gen-", "gen-SECRET\nINPUT", "gen-secret/key", "chatcmpl-<secret>", "gen-" + "x".repeat(125)])("omits unknown or malformed ID %s", (id) => {
    const projection = safeEmptyCompletionLog({ ...base, response: { id } });
    expect(projection.responseId).toBeNull(); expect(projection.responseIdPresent).toBe(true);
    expect(JSON.stringify(projection)).not.toContain(id);
  });
  it.each(["INPUT_SECRET\nPRIVATE", "other-model"])("omits response model when selected ID contradicts its valid route", (id) => {
    const projection = safeEmptyCompletionLog({ ...base, model: { ...base.model, id }, response: { modelId: id } });
    expect(projection.modelRoute).toBe(base.model.route); expect(projection.responseModelId).toBeNull();
    expect(JSON.stringify(projection)).not.toContain(id);
  });
  it("never reads private response fields or raw usage and rejects malformed scalar metadata", () => {
    const forbidden = vi.fn(() => { throw new Error("PRIVATE_SECRET"); });
    const response = { id: "INPUT_SECRET", modelId: "UPSTREAM_MODEL_SECRET", timestamp: new Date(NaN) };
    for (const name of ["headers", "body", "messages", "reasoning", "providerMetadata"])
      Object.defineProperty(response, name, { get: forbidden });
    const usage = { inputTokens: -1, outputTokens: NaN, totalTokens: Infinity,
      inputTokenDetails: { cacheReadTokens: "USAGE_SECRET" }, outputTokenDetails: { reasoningTokens: 1.5 } };
    Object.defineProperty(usage, "raw", { get: forbidden });
    const projection = safeEmptyCompletionLog({ ...base, response, usage: usage as unknown as LanguageModelUsage });
    expect(projection).toMatchObject({ responseId: null, responseModelId: null, responseTimestamp: null, usagePresent: true,
      usage: { inputTokens: null, cachedTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null } });
    expect(forbidden).not.toHaveBeenCalled(); expect(JSON.stringify(projection)).not.toContain("SECRET");
    expect(safeEmptyCompletionLog({ ...base, turnId: "TURN_SECRET", model: { id: "MODEL_SECRET", route: "ROUTE_SECRET" }, finishReason: "FINISH_SECRET", response: undefined }))
      .toMatchObject({ turnId: null, modelRoute: null, finishReason: null, responseAvailable: false, responseIdPresent: false, responseId: null, usagePresent: false });
  });
  it.each([undefined, null, {}, { id: 123, timestamp: "TIMESTAMP_SECRET" }])("handles absent response metadata without inventing values", (response) => {
    expect(safeEmptyCompletionLog({ ...base, response })).toMatchObject({ responseId: null, responseIdPresent: false,
      responseModelId: null, responseTimestamp: null, usagePresent: false,
      usage: { inputTokens: null, cachedTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null } });
  });
});
