import { generateText, experimental_streamTextLowMemory, Output, streamText, type LanguageModelUsage } from "ai";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { modelFailure, resolveModelTransport, safeEmptyCompletionLog } from "./model-transport";
import { DEFAULT_MODEL, MODELS, modelInputLimit, modelOutputLimit, modelOutputReserve, modelTokenLimit, requestedOutputLimit, type ModelSpec } from "./models";
import { chatModelMessages, estimateModelInput } from "./model-input";
import { nativeModel } from "./native-model-catalog";
import { extractionSchema } from "./workflows/distill";
import { z } from "zod";

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    constructor(_ctx: unknown, readonly env: Env) {}
  },
}));

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
  it("preserves native doGenerate JSON Mode with the structured-output flag at the offline binding", async () => {
    const modelId = "@cf/zai-org/glm-5.3-flash";
    type NativeRow = Awaited<ReturnType<Ai["models"]>>[number];
    const discovered = nativeModel({ name: modelId, task: { name: "Text Generation" }, properties: [
      { property_id: "context_window", value: "1048576" },
      { property_id: "reasoning_effort", value: { supported_efforts: ["low", "high", "max"] } },
    ] } as unknown as NativeRow, "2026-11-07");
    if (!discovered || discovered.contextTokens === null) throw new Error("The current native Flash fixture did not resolve.");
    const model: ModelSpec = { ...discovered, contextTokens: discovered.contextTokens };
    const output = Output.object({ schema: extractionSchema(["[S1:1]"]) });
    const format = await output.responseFormat;
    if (format?.type !== "json" || !format.schema) throw new Error("The real SDK did not produce the extraction schema.");
    const expectedAdapterEnvelope = { type: "json_schema", json_schema: { name: "response", strict: true,
      schema: format.schema as Record<string, unknown> } } satisfies
      Extract<NonNullable<AiModels["@cf/zai-org/glm-5.3-flash"]["inputs"]["response_format"]>, { type: "json_schema" }>;
    // agents@0.30.1: ai-sdk-DRPh2rRa.js adds strict; images-xaDv2Fqe.js
    // prepareChatCompletionsRequest removes only strict for Workers AI (jsonSchemaStrict:false).
    // The pinned Flash ResponseFormatJSONSchema type makes strict optional, not a runtime requirement.
    const expectedBindingEnvelope = { type: "json_schema", json_schema: {
      name: expectedAdapterEnvelope.json_schema.name, schema: expectedAdapterEnvelope.json_schema.schema,
    } } satisfies NonNullable<AiModels["@cf/zai-org/glm-5.3-flash"]["inputs"]["response_format"]>;
    type SchemaNode = { type?: string; minItems?: number; maxItems?: number; anyOf?: unknown[];
      properties?: Record<string, SchemaNode>; items?: SchemaNode };
    let calls = 0, captured: Record<string, unknown> | undefined;
    // Plain fake binding: retain only safe properties, never mock-call copies of source/messages or headers.
    const run = async (id: string, inputs: Record<string, unknown>, options: Record<string, unknown>) => {
      calls++;
      const response = inputs.response_format as { type?: string; json_schema?: { name?: string; strict?: boolean; schema?: SchemaNode } } | undefined;
      const scope = response?.json_schema?.schema?.properties?.guide?.items?.properties?.scope;
      captured = { modelId: id, stream: inputs.stream ?? "omitted", nonStreaming: inputs.stream === undefined || inputs.stream === false,
        hasStreamOptions: Object.hasOwn(inputs, "stream_options"), reasoningEffort: inputs.reasoning_effort,
        responseFormatType: response?.type, schemaName: response?.json_schema?.name,
        schemaStrictPresent: Object.hasOwn(response?.json_schema ?? {}, "strict"),
        exactPinnedEnvelope: isDeepStrictEqual(inputs.response_format, expectedBindingEnvelope),
        onlyDocumentedStrictRemoval: isDeepStrictEqual({ ...response,
          json_schema: { ...response?.json_schema, strict: true } }, expectedAdapterEnvelope),
        scopeType: scope?.type, scopeMinItems: scope?.minItems, scopeMaxItems: scope?.maxItems, scopeItemType: scope?.items?.type,
        scopeNullableBranch: scope?.anyOf !== undefined, itemNullableBranch: scope?.items?.anyOf !== undefined,
        hasMaxTokens: Object.hasOwn(inputs, "max_tokens"), hasMaxCompletionTokens: Object.hasOwn(inputs, "max_completion_tokens"),
        returnRawResponse: options.returnRawResponse === true };
      throw new Error("Offline native boundary reached; inference is disabled.");
    };
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external request."));
    try {
      const transport = await resolveModelTransport({ AI: { run } as unknown as Env["AI"], DB: {} as Env["DB"] },
        model, "native-generate-extraction", { structuredOutput: true });
      const maxOutputTokens = modelOutputLimit(model, 1024);
      const options = { model: transport, instructions: "Capture the native structured request only.",
        messages: [{ role: "user" as const, content: "The method uses normalization. Its source passage is retained." },
          { role: "user" as const, content: "Return only the requested structured output." }],
        output, maxRetries: 0, ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) };
      expect(model.maxOutputTokens).toBeNull();
      expect(options).not.toHaveProperty("maxOutputTokens");
      await expect(generateText(options)).rejects.toThrow(); // Real ai@7.0.152; only AI.run is intercepted.
      expect(calls).toBe(1);
      expect(network).not.toHaveBeenCalled();
      expect(captured).toMatchObject({ modelId, nonStreaming: true, hasStreamOptions: false, reasoningEffort: "high",
        responseFormatType: "json_schema", schemaName: "response", schemaStrictPresent: false,
        exactPinnedEnvelope: true, onlyDocumentedStrictRemoval: true,
        scopeType: "array", scopeMinItems: 0, scopeMaxItems: 1, scopeItemType: "object",
        scopeNullableBranch: false, itemNullableBranch: false, hasMaxTokens: false, hasMaxCompletionTokens: false, returnRawResponse: true });
      expect(captured?.stream).toBe("omitted");
    } finally { network.mockRestore(); }
  });

  it("forwards an explicit job output budget to native AI.run without inference", async () => {
    const seed = MODELS.find((entry) => entry.route === DEFAULT_MODEL);
    if (!seed) throw new Error("The built-in native model fallback is missing.");
    const model = { ...seed, maxOutputTokens: null };
    const instructions = "Capture the native output budget only.";
    const messages = [{ role: "user" as const, content: "Offline request." }];
    const estimate = estimateModelInput({ instructions, messages });
    const appliedOutputTokens = requestedOutputLimit(model, estimate, 8192);
    let captured: { modelId: string; maxTokens: unknown } | undefined;
    const run = vi.fn(async (modelId: string, inputs: Record<string, unknown>) => {
      captured = { modelId, maxTokens: inputs.max_tokens };
      throw new Error("Offline native boundary reached; inference is disabled.");
    });
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external request."));
    try {
      const transport = await resolveModelTransport({ AI: { run } as unknown as Env["AI"], DB: {} as Env["DB"] }, model, "chat-output-budget");
      await expect(streamText({ model: transport, instructions, messages, maxOutputTokens: appliedOutputTokens, maxRetries: 0 }).text)
        .rejects.toThrow();
      expect(appliedOutputTokens).toBe(8192);
      expect(run).toHaveBeenCalledTimes(1);
      expect(captured).toEqual({ modelId: model.id, maxTokens: appliedOutputTokens });
      expect(model.maxOutputTokens).toBeNull();
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });

  it("keeps native text requests identical while complete JSON decoding retains 33 candidates", async () => {
    const seed = MODELS.find(model => model.route === DEFAULT_MODEL);
    if (!seed) throw new Error("The native factory fixture is missing.");
    const model = { ...seed, nativeReasoningEffort: "low" as const };
    const schema = z.object({ candidates: z.array(z.object({ quoteBlock: z.literal("[S1:1]"),
      kind: z.literal("method").optional(), statement: z.string().min(1).max(1200) }).strict()).max(32) }).strict();
    const value = { candidates: Array.from({ length: 33 }, (_, index) => ({ quoteBlock: "[S1:1]", kind: "method",
      statement: `Configuration ${index + 1} preserves the residual path through ${index + 1} projection layers.` })) };
    const schemaText = JSON.stringify(z.toJSONSchema(schema));
    const instructions = "Return one JSON object conforming to this schema: " + schemaText;
    const messages = [{ role: "user" as const, content: value.candidates.map(candidate => candidate.statement).join("\n") }];
    const maxOutputTokens = requestedOutputLimit(model, estimateModelInput({ instructions, messages, schema: z.toJSONSchema(schema) }), 8192);
    const requests: { modelId: string; inputs: Record<string, unknown> }[] = [];
    const run = async (modelId: string, inputs: Record<string, unknown>) => {
      requests.push({ modelId, inputs: JSON.parse(JSON.stringify(inputs)) as Record<string, unknown> });
      const frame = (data: unknown) => "data: " + JSON.stringify(data) + "\n\n";
      return new Response(frame({ choices: [{ index: 0, delta: { content: JSON.stringify(value) }, finish_reason: null }] })
        + frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
        + frame({ choices: [], usage: { prompt_tokens: 101, completion_tokens: 17, total_tokens: 118 } })
        + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    };
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external request."));
    try {
      for (const mode of ["object", "json"] as const) {
        const spec = mode === "json" ? Output.json() : Output.object({ schema });
        let finalParses = 0, ends = 0, final: unknown;
        const output = { ...spec, parseCompleteOutput(...args: Parameters<typeof spec.parseCompleteOutput>) {
          finalParses++; return spec.parseCompleteOutput(...args);
        } };
        const transport = await resolveModelTransport({ AI: { run } as unknown as Env["AI"], DB: {} as Env["DB"] },
          model, "offline-compact-complete-json", { structuredOutput: true });
        const result = experimental_streamTextLowMemory({ model: transport, output, instructions, messages,
          maxOutputTokens, maxRetries: 0, streamRetries: 0, onEnd: event => { ends++; final = event.output; } });
        expect("output" in result).toBe(false);
        await result.consumeStream();
        expect(finalParses).toBe(1); expect(ends).toBe(1);
        expect(final).toEqual(mode === "json" ? value : undefined);
        expect(await result.finishReason).toBe("stop");
        await expect(result.consumeStream()).rejects.toMatchObject({ name: "AI_StreamAlreadyConsumedError" });
      }
      expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]);
      expect(requests[0]?.modelId).toBe(model.id);
      expect(requests[0]?.inputs).toMatchObject({ stream: true, max_tokens: 8192, reasoning_effort: "low" });
      expect(requests[0]?.inputs).not.toHaveProperty("response_format");
      expect((requests[0]?.inputs.messages as { content: string }[]).some(message => message.content.includes(schemaText))).toBe(true);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });

  it.each(["many small chunks", "legacy response with DONE", "non-SSE JSON fallback", "legacy response with truncated EOF",
    "invalid schema", "truncated JSON", "reported usage then error", "no finish or usage", "HTTP 408"] as const)(
    "uses the real pinned single-consumer SDK and final v4 validation: %s", async mode => {
      const seed = MODELS.find(model => model.route === DEFAULT_MODEL);
      if (!seed) throw new Error("The native factory fixture is missing.");
      const model = { ...seed, nativeReasoningEffort: "high" as const, maxOutputTokens: null };
      const schema = extractionSchema(["[S1:1]"]), schemaText = JSON.stringify(z.toJSONSchema(schema));
      const value = { claims: Array.from({ length: mode === "many small chunks" ? 32 : 1 }, () => ({ quoteBlock: "[S1:1]", kind: "method",
        statement: "The method preserves source evidence. ".repeat(20), task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null })),
        guide: ["The method retains evidence.", "The source describes a method.", "The source retains its passage."]
          .map(assertion => ({ labels: ["[S1:1]"], scope: [], assertion })),
        questions: ["Which method?", "Which evidence?", "Which passage?"], glossary: [] };
      const invalid = { ...value, guide: value.guide.map(item => ({ ...item, scope: null })) };
      const text = mode === "invalid schema" ? JSON.stringify(invalid) : JSON.stringify(value);
      const wireText = mode === "truncated JSON" || mode === "no finish or usage" ? text.slice(0, -6) : text;
      const usage = { prompt_tokens: 71, completion_tokens: 19, total_tokens: 90, prompt_tokens_details: { cached_tokens: 0 } };
      const privateBody = "Private provider body must not escape";
      let calls = 0, sourceChunks = 0, ends = 0, final: unknown, streamError: unknown, reported: LanguageModelUsage | undefined;
      let finish: string | undefined, rawFinish: string | undefined, capture: Record<string, unknown> | undefined;
      const run = async (id: string, inputs: Record<string, unknown>) => {
        calls++;
        capture = { modelId: id, stream: inputs.stream, includeUsage: (inputs.stream_options as { include_usage?: boolean })?.include_usage,
          effort: inputs.reasoning_effort, hasResponseFormat: Object.hasOwn(inputs, "response_format"),
          unknownOutputOmitted: !Object.hasOwn(inputs, "max_tokens") && !Object.hasOwn(inputs, "max_completion_tokens"),
          fullSchemaPrompt: (inputs.messages as Array<{ content: unknown }>).some(item => typeof item.content === "string" && item.content.includes(schemaText)) };
        if (mode === "HTTP 408") return new Response(JSON.stringify({ error: { message: privateBody } }), { status: 408, headers: { "content-type": "application/json" } });
        if (mode === "non-SSE JSON fallback") return new Response(JSON.stringify({ response: text, usage }),
          { headers: { "content-type": "application/json" } });
        const base = { id: "offline-low-memory", object: "chat.completion.chunk", created: 0, model: id };
        const frame = (data: unknown) => "data: " + JSON.stringify(data) + "\n\n";
        const chunks: string[] = [];
        if (mode === "legacy response with DONE" || mode === "legacy response with truncated EOF") {
          chunks.push(frame({ response: text, usage }));
          sourceChunks = chunks.length;
          if (mode === "legacy response with DONE") chunks.push("data: [DONE]\n\n");
        } else {
          for (let at = 0; at < wireText.length; at += 16) chunks.push(frame({ ...base, choices: [{ index: 0, delta: { content: wireText.slice(at, at + 16) }, finish_reason: null }] }));
          sourceChunks = chunks.length;
          if (mode !== "no finish or usage") {
            chunks.push(frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: mode === "truncated JSON" ? "length" : "stop" }] }), frame({ ...base, choices: [], usage }));
            if (mode === "reported usage then error") chunks.push(frame({ error: { message: privateBody, statusCode: 408 } }));
            chunks.push("data: [DONE]\n\n");
          }
        }
        let at = 0;
        return new Response(new ReadableStream({ pull(controller) {
          const chunk = chunks[at++];
          if (chunk === undefined) controller.close(); else controller.enqueue(new TextEncoder().encode(chunk));
        } }), { headers: { "content-type": "text/event-stream" } });
      };
      const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external request."));
      try {
        const transport = await resolveModelTransport({ AI: { run } as unknown as Env["AI"], DB: {} as Env["DB"] }, model, "offline-native-k3", { structuredOutput: true });
        const result = experimental_streamTextLowMemory({ model: transport, output: Output.object({ schema }),
          instructions: "Return one JSON object conforming to this schema: " + schemaText,
          messages: [{ role: "user", content: "The method retains evidence." }], maxRetries: 0, streamRetries: 0,
          onEnd: event => { ends++; final = event.output; },
          onChunk: ({ chunk }) => { if (chunk.type === "finish-step") { reported = chunk.usage; finish = chunk.finishReason; rawFinish = chunk.rawFinishReason; } },
          onError: ({ error }) => { streamError = error; } });
        expect("output" in result).toBe(false); // Inspect the public facade, never read a content getter.
        await result.consumeStream({ onError: error => { streamError = error; } });
        expect(calls).toBe(1); expect(network).not.toHaveBeenCalled();
        expect(capture).toEqual({ modelId: model.id, stream: true, includeUsage: true, effort: "high", hasResponseFormat: false, unknownOutputOmitted: true, fullSchemaPrompt: true });
        if (mode === "many small chunks" || mode === "legacy response with DONE" || mode === "non-SSE JSON fallback") {
          if (mode === "many small chunks") expect(sourceChunks).toBeGreaterThan(1000);
          expect(ends).toBe(1); expect(final).toEqual(value); expect(streamError).toBeUndefined();
          expect(finish).toBe("stop"); expect(rawFinish).toBe("stop");
          expect(await result.finishReason).toBe("stop"); expect(await result.rawFinishReason).toBe("stop");
        } else if (mode === "legacy response with truncated EOF") {
          // Valid JSON can pass Output.object while missing terminal framing still forbids a successful stop.
          expect(ends).toBe(1); expect(final).toEqual(value);
          expect(finish).toBe("error"); expect(rawFinish).toBe("stream-truncated");
          expect(await result.finishReason).toBe("error"); expect(await result.rawFinishReason).toBe("stream-truncated");
        } else if (mode === "invalid schema" || mode === "truncated JSON") { expect(ends).toBe(1); expect(final).toBeUndefined(); }
        else if (mode === "reported usage then error" || mode === "HTTP 408") {
          expect(streamError).toBeDefined();
          const reason = modelFailure(streamError, model);
          expect(reason).not.toContain(privateBody);
          if (mode === "HTTP 408") { expect(reason).toBe("Model stream failed (HTTP 408)."); expect(ends).toBe(0); }
        } else { expect(finish).toBe("error"); expect(rawFinish).toBe("stream-truncated"); expect(final).toBeUndefined(); }
        if (mode === "no finish or usage" || mode === "HTTP 408") {
          expect(reported?.raw).toBeUndefined(); expect(reported?.inputTokens).toBeUndefined(); expect(reported?.outputTokens).toBeUndefined();
        } else {
          expect(reported).toMatchObject({ inputTokens: 71, outputTokens: 19, raw: usage });
          expect(await result.totalUsage).toMatchObject({ inputTokens: 71, outputTokens: 19, raw: usage });
        }
        await expect(result.consumeStream()).rejects.toMatchObject({ name: "AI_StreamAlreadyConsumedError" });
      } finally { network.mockRestore(); }
    });

  it.each([32768, 4096, null])("forwards explicit legacy low and the published %s output maximum through the installed adapter", async (capacity) => {
    const fallback = MODELS.find((entry) => entry.route === DEFAULT_MODEL);
    if (!fallback) throw new Error("The built-in native model fallback is missing.");
    expect(fallback).not.toHaveProperty("nativeReasoningEffort");
    const model = { ...fallback, maxOutputTokens: capacity, nativeReasoningEffort: "low" as const, openRouterReasoningEffort: "high",
      structuredReasoningEffort: "minimal" as const, openRouterReasoningEfforts: ["minimal"] };
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
    const transport = await resolveModelTransport({ AI, DB: {} as Env["DB"] }, model, "native-reasoning-test", { freshChat: true });
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
    expect(captured?.inputs).not.toHaveProperty("reasoning");
    expect((captured?.inputs.chat_template_kwargs as Record<string, unknown> | undefined)?.enable_thinking).not.toBe(false);
    expect(captured?.options.returnRawResponse).toBe(true);
  });
});

describe("fresh native reasoning effort request", () => {
  it.each([
    { name: "advertised high", supportedEfforts: ["low", "high", "max"], expected: "high" },
    { name: "absent metadata", supportedEfforts: null, expected: undefined },
    { name: "unsupported high", supportedEfforts: ["low", "max"], expected: undefined },
  ])("submits $name as the actual native SDK field", async ({ supportedEfforts, expected }) => {
    type NativeRow = Awaited<ReturnType<Ai["models"]>>[number];
    const properties: unknown[] = [{ property_id: "context_window", value: "1048576" }];
    if (supportedEfforts !== null) properties.push({ property_id: "reasoning_effort", value: { supported_efforts: supportedEfforts } });
    const discovered = nativeModel({ id: "catalogue-uuid", name: "@cf/zai-org/glm-5.3", task: { name: "Text Generation" }, properties } as unknown as NativeRow, "2026-11-07");
    if (!discovered || discovered.contextTokens === null) throw new Error("The native GLM fixture did not resolve.");
    const model: ModelSpec = { ...discovered, contextTokens: discovered.contextTokens };
    let captured: { inputs: Record<string, unknown> } | undefined;
    const run = vi.fn(async (modelId: string, inputs: Record<string, unknown>) => {
      captured = { inputs };
      const chunk = (value: unknown) => "data: " + JSON.stringify(value) + "\n\n";
      const base = { id: "fresh-native-reasoning", object: "chat.completion.chunk", created: 0, model: modelId };
      return new Response(
        chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Captured without inference." }, finish_reason: null }] }) +
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
        chunk({ ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) +
        "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const transport = await resolveModelTransport({ AI: { run } as unknown as Env["AI"], DB: {} as Env["DB"] }, model, "fresh-native-reasoning");
    await expect(streamText({ model: transport, prompt: "Capture the native request only.", maxRetries: 0 }).text)
      .resolves.toBe("Captured without inference.");
    expect(run).toHaveBeenCalledTimes(1);
    if (expected === undefined) {
      expect(discovered).not.toHaveProperty("nativeReasoningEffort");
      expect(captured?.inputs).not.toHaveProperty("reasoning_effort");
    } else {
      expect(discovered.nativeReasoningEffort).toBe(expected);
      expect(captured?.inputs.reasoning_effort).toBe(expected);
    }
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

describe("mandatory minimal structured reasoning request", () => {
  it("sends reasoning:{effort:'minimal'} only for structured OpenRouter jobs and leaves chat untouched", async () => {
    const provider = { id: "openrouter", type: "openai-compatible" as const,
      gatewaySlug: "openrouter", gatewayPath: "v1", enabled: true,
      baseUrl: "https://openrouter.ai/api/v1", dataCollection: "deny" as const };
    const base: ModelSpec = { route: "gateway:openrouter/fixture-mandatory-minimal", id: "fixture-mandatory-minimal", label: "Mandatory minimal fixture",
      contextTokens: 64000, maxOutputTokens: 8192, outputReserveTokens: 8192, responseFormat: true, structuredOutputs: true,
      checkedOn: "2026-11-08", enabled: true, routing: { provider, gatewayId: "fixture" } };
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      throw new Error("Stopped after local request capture.");
    });
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request."));
    try {
      const structured = await resolveModelTransport({ AI: { fetch } as unknown as Env["AI"], DB: {} as Env["DB"] },
        { ...base, structuredReasoningEffort: "minimal" as const }, "mandatory-minimal-structured", { structuredOutput: true });
      await expect(streamText({ model: structured, prompt: "Capture structured only.", maxRetries: 0 }).text).rejects.toThrow();
      expect(bodies[0]?.reasoning).toEqual({ effort: "minimal" });
      expect(bodies[0]).not.toHaveProperty("reasoning_effort");
      expect(bodies[0]?.provider).toMatchObject({ allow_fallbacks: false, require_parameters: true, data_collection: "deny" });

      const chat = await resolveModelTransport({ AI: { fetch } as unknown as Env["AI"], DB: {} as Env["DB"] },
        { ...base, structuredReasoningEffort: "minimal" }, "mandatory-minimal-chat");
      await expect(streamText({ model: chat, prompt: "Capture chat only.", maxRetries: 0 }).text).rejects.toThrow();
      expect(bodies[1]).not.toHaveProperty("reasoning");
      expect(bodies[1]).not.toHaveProperty("reasoning_effort");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it("leaves reasoning unset for mutually inconsistent optional and mandatory flags", async () => {
    const provider = { id: "openrouter", type: "openai-compatible" as const,
      gatewaySlug: "openrouter", gatewayPath: "v1", enabled: true,
      baseUrl: "https://openrouter.ai/api/v1", dataCollection: "deny" as const };
    const model: ModelSpec = { route: "gateway:openrouter/fixture-inconsistent", id: "fixture-inconsistent", label: "Inconsistent fixture",
      contextTokens: 64000, maxOutputTokens: 8192, outputReserveTokens: 8192, responseFormat: true, structuredOutputs: true,
      optionalReasoning: true, structuredReasoningEffort: "minimal" as const,
      checkedOn: "2026-11-08", enabled: true, routing: { provider, gatewayId: "fixture" } };
    let captured: Record<string, unknown> | undefined;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      throw new Error("Stopped after local request capture.");
    });
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request."));
    try {
      const transport = await resolveModelTransport({ AI: { fetch } as unknown as Env["AI"], DB: {} as Env["DB"] }, model, "inconsistent-structured", { structuredOutput: true });
      await expect(streamText({ model: transport, prompt: "Capture inconsistent only.", maxRetries: 0 }).text).rejects.toThrow();
      expect(captured).not.toHaveProperty("reasoning");
      expect(captured).not.toHaveProperty("reasoning_effort");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
});


describe.each([
  { path: "native Gateway adapter", gatewaySlug: "openrouter", apiProtocol: undefined },
  { path: "published Chat Completions", gatewaySlug: "custom-fixture", apiProtocol: "openai-chat" },
  { path: "legacy compatible Gateway", gatewaySlug: "custom-fixture", apiProtocol: undefined },
] as const)("owner-selected OpenRouter reasoning via $path", ({ gatewaySlug, apiProtocol }) => {
  it("uses published mandatory minimal only when the fresh-chat caller opts in", async () => {
    const provider = { id: "fixture-router", type: "openai-compatible" as const, gatewaySlug, gatewayPath: "v1",
      enabled: true, baseUrl: "https://openrouter.ai/api/v1", dataCollection: "deny" as const };
    const model = Object.freeze({ route: "gateway:fixture-router/provider/chat-fixture", id: "provider/chat-fixture", label: "Frozen chat fixture",
      contextTokens: 64000, maxOutputTokens: 8192, outputReserveTokens: 8192, checkedOn: "2026-11-09", enabled: true,
      structuredReasoningEffort: "minimal", openRouterReasoningEfforts: ["high", "minimal"],
      routing: { provider, gatewayId: "fixture" },
      ...(apiProtocol === undefined ? {} : { apiProtocol, apiBaseUrl: provider.baseUrl }) } satisfies ModelSpec);
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      throw new Error("Stopped after local request capture.");
    });
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request."));
    try {
      for (const freshChat of [undefined, false, true]) {
        const transport = await resolveModelTransport({ AI: { fetch } as unknown as Env["AI"], DB: {} as Env["DB"] }, model,
          "fresh-chat-minimal", freshChat === undefined ? {} : { freshChat });
        await expect(streamText({ model: transport, prompt: "Capture only.", maxOutputTokens: 8192, maxRetries: 0 }).text).rejects.toThrow();
        const body = bodies.at(-1);
        if (freshChat === true) expect(body?.reasoning).toEqual({ effort: "minimal" });
        else expect(body).not.toHaveProperty("reasoning");
        expect(body).toMatchObject({ max_tokens: 8192, provider: { allow_fallbacks: false, require_parameters: true, data_collection: "deny" } });
        expect(body).not.toHaveProperty("reasoning_effort");
      }
      expect(fetch).toHaveBeenCalledTimes(3); expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });

  it("prioritizes frozen high in both ordinal budgets, preserves optional metadata and leaves chat untouched", async () => {
    const provider = { id: "fixture-router", type: "openai-compatible" as const, gatewaySlug, gatewayPath: "v1",
      enabled: true, baseUrl: "https://openrouter.ai/api/v1", dataCollection: "deny" as const };
    const base: ModelSpec = { route: "gateway:fixture-router/provider/fixture", id: "provider/fixture", label: "Offline effort fixture",
      contextTokens: 64000, contextWindowTokens: 64000, maxOutputTokens: 16384, outputReserveTokens: 8192,
      checkedOn: "2026-11-08", enabled: true, responseFormat: true, structuredOutputs: true,
      structuredReasoningEffort: "minimal", openRouterReasoningEfforts: ["minimal", "high"],
      routing: { provider, gatewayId: "fixture" },
      ...(apiProtocol === undefined ? {} : { apiProtocol, apiBaseUrl: provider.baseUrl }) };
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      throw new Error("Stopped after local request capture.");
    });
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request."));
    const env = { AI: { fetch } as unknown as Env["AI"], DB: {} as Env["DB"] };
    try {
      for (const effort of [undefined, "high"]) {
        const spec: ModelSpec = { ...base, ...(effort === undefined ? {} : { openRouterReasoningEffort: effort }) };
        const transport = await resolveModelTransport(env, spec, "owner-effort", { structuredOutput: true });
        for (const budget of [8192, 4096]) {
          await expect(generateText({ model: transport, prompt: "Capture only.", maxRetries: 0,
            output: Output.object({ schema: z.object({ value: z.string() }) }),
            maxOutputTokens: requestedOutputLimit(spec, 1024, budget) })).rejects.toThrow();
          expect(bodies.at(-1)).toMatchObject({ reasoning: { effort: effort ?? "minimal" }, max_tokens: budget,
            provider: { allow_fallbacks: false, require_parameters: true, data_collection: "deny" } });
          expect(bodies.at(-1)).not.toHaveProperty("reasoning_effort");
        }
      }
      const optional: ModelSpec = { ...base, optionalReasoning: true, openRouterReasoningEffort: "high" };
      delete optional.structuredReasoningEffort;
      const structured = await resolveModelTransport(env, optional, "optional-owner-effort", { structuredOutput: true });
      await expect(generateText({ model: structured, prompt: "Capture only.", maxOutputTokens: 4096, maxRetries: 0 })).rejects.toThrow();
      expect(bodies.at(-1)?.reasoning).toEqual({ effort: "high" });
      expect(optional.optionalReasoning).toBe(true);
      const chat = await resolveModelTransport(env, optional, "chat-owner-effort");
      await expect(generateText({ model: chat, prompt: "Capture chat only.", maxOutputTokens: 8192, maxRetries: 0 })).rejects.toThrow();
      expect(bodies.at(-1)).not.toHaveProperty("reasoning");
      expect(bodies.at(-1)).not.toHaveProperty("reasoning_effort");
      expect(fetch).toHaveBeenCalledTimes(6);
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
});

describe("fresh chat unsupported reasoning metadata", () => {
  it.each([
    { name: "missing marker", marker: false, profiles: ["minimal"], optional: false },
    { name: "missing published choices", marker: true, profiles: undefined, optional: false },
    { name: "minimal not published", marker: true, profiles: ["high"], optional: false },
    { name: "contradictory optional marker", marker: true, profiles: ["minimal"], optional: true },
    { name: "optional reasoning", marker: false, profiles: ["minimal"], optional: true },
    { name: "Flint unknown choices", marker: false, profiles: undefined, optional: false },
    { name: "non-OpenRouter root", marker: true, profiles: ["minimal"], optional: false },
  ])("leaves reasoning unset for $name", async ({ name, marker, profiles, optional }) => {
    const provider = { id: name === "Flint unknown choices" ? "openrouter" : "fixture-router", type: "openai-compatible" as const, gatewaySlug: "openrouter", gatewayPath: "v1",
      enabled: true, baseUrl: name === "non-OpenRouter root" ? "https://vendor.example.com/api/v1" : "https://openrouter.ai/api/v1" };
    const id = name === "Flint unknown choices" ? "recursive/flint-v1.0:free" : "provider/chat-fixture";
    const model: ModelSpec = { route: "gateway:" + provider.id + "/" + id, id, label: "Unsupported chat fixture",
      contextTokens: 64000, maxOutputTokens: 8192, checkedOn: "2026-11-09", enabled: true,
      ...(marker ? { structuredReasoningEffort: "minimal" } : {}),
      ...(profiles === undefined ? {} : { openRouterReasoningEfforts: profiles }), ...(optional ? { optionalReasoning: true } : {}),
      routing: { provider, gatewayId: "fixture" } };
    let body: Record<string, unknown> | undefined;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      throw new Error("Stopped after local request capture.");
    });
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request."));
    try {
      const transport = await resolveModelTransport({ AI: { fetch } as unknown as Env["AI"], DB: {} as Env["DB"] }, model, "unsupported-chat", { freshChat: true });
      await expect(streamText({ model: transport, prompt: "Capture only.", maxOutputTokens: 8192, maxRetries: 0 }).text).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1); expect(body).not.toHaveProperty("reasoning");
      expect(body).not.toHaveProperty("reasoning_effort"); expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
});

describe("OpenRouter bad-request parameter diagnostics", () => {
  const provider = { id: "openrouter", type: "openai-compatible" as const, gatewaySlug: "openrouter", gatewayPath: "v1",
    enabled: true, baseUrl: "https://openrouter.ai/api/v1", dataCollection: "deny" as const };
  const model: ModelSpec = { route: "gateway:openrouter/fixture", id: "fixture", label: "Offline failure fixture",
    contextTokens: 64000, maxOutputTokens: 8192, checkedOn: "2026-11-08", enabled: true,
    routing: { provider, gatewayId: "fixture" } };
  const secret = "PRIVATE_SECRET: arbitrary provider prose mentions reasoning, temperature and response_format";
  const generic = "External model request failed (HTTP 400). Check the Gateway connection and provider status; no retry was started.";
  const body = (param: unknown) => JSON.stringify({ error: { message: secret, param } });
  const wrapped = (raw: string, param?: unknown) => JSON.stringify({ error: { message: secret, param, metadata: { raw } } });

  it.each([
    { param: "reasoning", category: "reasoning", nested: false, cause: false },
    { param: "reasoning.effort", category: "reasoning", nested: true, cause: false },
    { param: "reasoning_effort", category: "reasoning", nested: false, cause: true },
    { param: "temperature", category: "temperature", nested: true, cause: true },
    { param: "response_format", category: "structured-output format", nested: false, cause: false },
    { param: "response_format.json_schema", category: "structured-output format", nested: true, cause: false },
  ])("projects only the fixed category for $param", ({ param, category, nested, cause }) => {
    const failure = { statusCode: 400, responseBody: nested ? wrapped(body(param)) : body(param) };
    const reason = modelFailure(cause ? new Error(secret, { cause: failure }) : { ...failure, message: secret }, model);
    expect(reason).toBe("External model request failed (HTTP 400). Provider identified the " + category + " parameter. Check the selected model's published controls; no retry was started.");
    expect(reason).not.toContain(secret);
  });

  it("keeps absent, malformed, oversized and unknown structured parameters generic", () => {
    for (const responseBody of [
      undefined, body(undefined), "{", body(["reasoning"]), body("reasoning.max_tokens"),
      JSON.stringify({ error: { param: "reasoning", message: secret + "x".repeat(4096) } }),
      wrapped("{"), wrapped("x".repeat(4097)), wrapped(wrapped(body("reasoning"))),
    ]) {
      expect(modelFailure({ statusCode: 400, responseBody, message: secret }, model)).toBe(generic);
    }
  });

  it("requires agreement across the wrapper, direct body and immediate cause", () => {
    const direct = { statusCode: 400, responseBody: body("reasoning") };
    expect(modelFailure(Object.assign(new Error(secret, { cause: direct }), direct), model))
      .toContain("Provider identified the reasoning parameter.");
    for (const responseBody of [wrapped(body("temperature"), "reasoning"), wrapped(body("reasoning"), "unknown")]) {
      expect(modelFailure({ statusCode: 400, responseBody }, model)).toBe(generic);
    }
    for (const cause of [
      { statusCode: 400, responseBody: body("temperature") },
      { statusCode: 400, responseBody: body("unknown") },
      { statusCode: 400, responseBody: "{" },
      { statusCode: 401, responseBody: body("reasoning") },
    ]) {
      expect(modelFailure(Object.assign(new Error(secret, { cause }), direct), model)).toBe(generic);
    }
  });

  it("preserves generic failures without the frozen official route and for other statuses", () => {
    const failure = { statusCode: 400, responseBody: body("reasoning") };
    const unrouted = { ...model };
    delete unrouted.routing;
    expect(modelFailure(failure, unrouted)).toBe(generic);
    expect(modelFailure(failure, { ...model, routing: { provider: { ...provider, baseUrl: "https://vendor.example/api/v1" }, gatewayId: "fixture" } })).toBe(generic);
    expect(modelFailure({ ...failure, statusCode: 401 }, model)).toBe("External model request failed (HTTP 401). Check the Gateway connection and provider status; no retry was started.");
    expect(modelFailure(failure, { ...model, route: "workers-ai:fixture" })).toBe("Model stream failed (HTTP 400).");
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
