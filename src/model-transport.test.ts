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

describe("explicit anonymous SDK transport", () => {
  const root = "https://api.example.com/provider";
  const modelFor = (protocol?: NonNullable<ModelSpec["apiProtocol"]>): ModelSpec => ({
    route: "gateway:fixture/opaque-priced-id", id: "opaque-priced-id", label: "Anonymous fixture", contextTokens: 64000,
    maxOutputTokens: 8192, outputReserveTokens: 8192, enabled: true, checkedOn: "2026-11-09",
    routing: { provider: { id: "fixture", type: "openai-compatible", baseUrl: root, gatewaySlug: null, gatewayPath: "", enabled: true, authMode: "anonymous" }, gatewayId: null },
    ...(protocol === undefined ? {} : { apiProtocol: protocol, apiBaseUrl: root + "/v1" }),
  });
  it.each([undefined, "openai-chat", "openai-responses", "anthropic", "google"] as const)("serializes %s directly without AI, ambient credentials, redirects or changed output capacity", async protocol => {
    const controller = new AbortController(), model = modelFor(protocol);
    const network = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: { message: "PRIVATE" } }, { status: 401 }));
    try {
      const transport = await resolveModelTransport({ DB: {} as Env["DB"] }, model, "chat-fixture");
      const options = { model: transport, prompt: "Offline", maxOutputTokens: 16, maxRetries: 0, abortSignal: controller.signal,
        headers: { authorization: "SECRET", cookie: "SECRET", "cf-aig-authorization": "SECRET", "x-api-key": "SECRET", "x-goog-api-key": "SECRET" } };
      if (protocol === "google") await expect(streamText(options).text).rejects.toThrow();
      else await expect(generateText(options)).rejects.toThrow();
      expect(network).toHaveBeenCalledTimes(1);
      const request = network.mock.calls[0];
      if (!request) throw new Error("Direct request missing.");
      const url = new URL(String(request[0])), init = request[1];
      expect(url.origin).toBe("https://api.example.com"); expect(url.pathname.startsWith("/provider/")).toBe(true);
      expect([...url.searchParams.keys()]).toEqual(protocol === "google" ? ["alt"] : []);
      expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "manual", signal: controller.signal });
      expect(init?.signal).toBe(controller.signal);
      const headers = new Headers(init?.headers);
      for (const name of headers.keys()) expect(["content-type", "user-agent", "x-session-affinity", "anthropic-version", "anthropic-beta"]).toContain(name);
      expect(JSON.stringify([...headers])).not.toContain("SECRET");
      const body = JSON.parse(String(init?.body));
      expect(protocol === "google" ? body.generationConfig.maxOutputTokens : protocol === "openai-responses" ? body.max_output_tokens : body.max_tokens).toBe(16);
      expect(modelFailure({ statusCode: 401, responseBody: "PRIVATE" }, model)).toContain("selected provider and its status");
      expect(modelFailure({ statusCode: 401, responseBody: "PRIVATE" }, model)).not.toContain("PRIVATE");
    } finally { network.mockRestore(); }
  });

  it.each([undefined, "1"])("rejects streamed wire overflow before SDK parsing with content-length=%s", async length => {
    const cancel = vi.fn(), controller = new AbortController();
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(new Uint8Array(16 * 1024 * 1024 + 1)); }, cancel,
    }), { headers: length === undefined ? {} : { "content-length": length } }));
    const onResponseBytes = vi.fn();
    try {
      const transport = await resolveModelTransport({ DB: {} as Env["DB"] }, modelFor(), "chat-fixture", { onResponseBytes });
      await expect(generateText({ model: transport, prompt: "Offline", maxOutputTokens: 16, maxRetries: 0, abortSignal: controller.signal })).rejects.toThrow();
      expect(network).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledTimes(1);
      expect(onResponseBytes).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });

  it("cancels an outstanding raw response on the owned signal and rejects redirects without a second request", async () => {
    const controller = new AbortController(), cancel = vi.fn();
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new ReadableStream({ pull() { controller.abort(); }, cancel })));
    try {
      let transport = await resolveModelTransport({ DB: {} as Env["DB"] }, modelFor(), "chat-fixture");
      await expect(generateText({ model: transport, prompt: "Offline", maxRetries: 0, abortSignal: controller.signal })).rejects.toThrow();
      expect(cancel).toHaveBeenCalled(); expect(network).toHaveBeenCalledTimes(1);
      network.mockClear().mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }));
      transport = await resolveModelTransport({ DB: {} as Env["DB"] }, modelFor(), "chat-fixture");
      await expect(generateText({ model: transport, prompt: "Offline", maxRetries: 0, abortSignal: new AbortController().signal })).rejects.toThrow();
      expect(network).toHaveBeenCalledTimes(1);
    } finally { network.mockRestore(); }
  });

  it.each(["https://127.0.0.1/provider", "https://private.internal/provider"])("rejects private roots before HTTP even when metadata uses public URLs: %s", async baseUrl => {
    const model = modelFor();
    if (!model.routing) throw new Error("Routing missing."); model.routing.provider.baseUrl = baseUrl;
    model.routing.provider.modelsUrl = "https://catalogue.example.com/models";
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No private egress"));
    try { await expect(resolveModelTransport({ DB: {} as Env["DB"] }, model, "chat-fixture")).rejects.toThrow(); expect(network).not.toHaveBeenCalled(); }
    finally { network.mockRestore(); }
  });

  it("requires a structured operation counter and applies its reservation before SDK response parsing", async () => {
    const model = modelFor();
    await expect(resolveModelTransport({ DB: {} as Env["DB"] }, model, "distill-fixture", { structuredOutput: true })).rejects.toThrow("materialization counter");
    const counter = { used: 16 * 1024 * 1024 - 1, blocks: new Map(), rangeReads: 0 };
    const { reserve } = await import("./context");
    const charge = vi.fn((bytes: number) => reserve(counter, 12 * (bytes + 64)));
    const cancel = vi.fn(), network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('{"not":"a complete structured response"}')); }, cancel,
    })));
    try {
      const transport = await resolveModelTransport({ DB: {} as Env["DB"] }, model, "distill-fixture", { structuredOutput: true, onResponseBytes: charge });
      await expect(generateText({ model: transport, prompt: "Offline", maxRetries: 0, abortSignal: new AbortController().signal })).rejects.toThrow();
      expect(charge).toHaveBeenCalledTimes(1); expect(cancel).toHaveBeenCalledTimes(1); expect(network).toHaveBeenCalledTimes(1);
      expect(counter.used).toBe(16 * 1024 * 1024 - 1);
    } finally { network.mockRestore(); }
  });
});

describe.each([undefined, "openai-chat"] as const)("Kilo paired OFF with compatible protocol %s", protocol => {
  it.each([
    { name: "published paired OFF", optional: true, effort: "none", structured: true, freshChat: false, official: true, off: true },
    { name: "ordinary fresh Chat", optional: true, effort: "none", structured: false, freshChat: true, official: true, off: true },
    { name: "caller without fresh Chat flag", optional: true, effort: "none", structured: false, freshChat: undefined, official: true, off: false },
    { name: "caller declining fresh Chat policy", optional: true, effort: "none", structured: false, freshChat: false, official: true, off: false },
    { name: "fresh Chat with unknown snapshot", optional: undefined, effort: undefined, structured: false, freshChat: true, official: true, off: false },
    { name: "fresh Chat without paired provenance", optional: true, effort: undefined, structured: false, freshChat: true, official: true, off: false },
    { name: "old optional flag without provenance", optional: true, effort: undefined, structured: true, freshChat: false, official: true, off: false },
    { name: "old unknown snapshot", optional: undefined, effort: undefined, structured: true, freshChat: false, official: true, off: false },
    { name: "marker without optional flag", optional: undefined, effort: "none", structured: true, freshChat: false, official: true, off: false },
    { name: "mandatory profile", optional: false, effort: "minimal", structured: true, freshChat: false, official: true, off: false },
    { name: "inconsistent optional/minimal", optional: true, effort: "minimal", structured: true, freshChat: false, official: true, off: false },
    { name: "other provider root", optional: true, effort: "none", structured: true, freshChat: false, official: false, off: false },
  ] as const)("serializes only the verified control: $name", async ({ optional, effort, structured, freshChat, official, off }) => {
    const root = official ? "https://ai-gateway.kilo.ai/api/v1" : "https://api.commandcode.ai/provider/v1";
    const model: ModelSpec = { route: "gateway:fixture/opaque", id: "opaque", label: "Offline fixture", contextTokens: 131072,
      maxOutputTokens: 8192, outputReserveTokens: 8192, responseFormat: true, structuredOutputs: true, supportsTemperature: true,
      checkedOn: "2026-11-09", enabled: true, ...(optional === undefined ? {} : { optionalReasoning: optional }),
      ...(effort === undefined ? {} : { structuredReasoningEffort: effort }),
      ...(protocol === undefined ? {} : { apiProtocol: protocol, apiBaseUrl: root }),
      routing: { gatewayId: "offline-kilo", provider: { id: "fixture", type: "openai-compatible", baseUrl: root,
        gatewaySlug: "custom-fixture", gatewayPath: "v1", enabled: true } } };
    const bodies: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "offline", object: "chat.completion", created: 0, model: model.id,
        choices: [{ index: 0, message: { role: "assistant", content: "Offline response." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    });
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No external request."));
    try {
      const transport = await resolveModelTransport({ AI: { fetch } as unknown as Env["AI"], DB: {} as Env["DB"] }, model,
        "distill-fixture", { structuredOutput: structured, ...(freshChat === undefined ? {} : { freshChat }) });
      delete model.structuredReasoningEffort; model.optionalReasoning = !optional;
      await generateText({ model: transport, prompt: "Offline fixture.", maxOutputTokens: 4096, maxRetries: 0 });
      expect(fetch).toHaveBeenCalledTimes(1); expect(network).not.toHaveBeenCalled();
      expect(bodies[0]).toMatchObject({ max_tokens: 4096, temperature: 0 });
      if (off) expect(bodies[0]?.reasoning).toEqual({ enabled: false, effort: "none" });
      else expect(bodies[0]).not.toHaveProperty("reasoning");
      expect(bodies[0]).not.toHaveProperty("provider");
    } finally { network.mockRestore(); }
  });
});

describe("native Responses reasoning classification", () => {
  it.each([undefined, false, true])("uses the pinned SDK classification only for frozen capability=%s", async supportsReasoning => {
    const root = "https://opencode.ai/inference/go";
    const model: ModelSpec = { route: "gateway:fixture/opaque-alias", id: "opaque-alias", label: "Offline alias",
      contextTokens: 1048576, contextWindowTokens: 1048576, maxOutputTokens: 65536, outputReserveTokens: 8192,
      supportsTemperature: true, checkedOn: "2026-11-09", enabled: true, apiProtocol: "openai-responses", apiBaseUrl: root + "/openai/v1",
      ...(supportsReasoning === undefined ? {} : { supportsReasoning }),
      routing: { gatewayId: "fixture", provider: { id: "fixture", type: "openai-compatible", baseUrl: root,
        gatewaySlug: "custom-opencode-go", gatewayPath: "", keyAlias: "named-fixture", enabled: true } } };
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 400 }));
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No external inference in this fixture."));
    try {
      const transport = await resolveModelTransport({ AI: { fetch } as unknown as Env["AI"], DB: {} as Env["DB"] }, model, "chat-fixture");
      model.supportsReasoning = supportsReasoning !== true; // Later metadata cannot alter the captured classification.
      await expect(generateText({ model: transport, instructions: "System fixture.", prompt: "Offline fixture.",
        temperature: 0, topP: 0.8, maxOutputTokens: 8192, maxRetries: 0,
        providerOptions: { openai: { metadata: { fixture: "preserved" }, textVerbosity: "low", include: ["message.output_text.logprobs"],
          store: true, conversation: "must-be-removed", previousResponseId: "must-be-removed" } } })).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1); expect(network).not.toHaveBeenCalled();
      const request = fetch.mock.calls[0];
      if (!request) throw new Error("The pinned SDK did not serialize a request.");
      expect(String(request[0])).toBe("https://workers-binding.ai/ai-gateway/gateways/fixture/custom-opencode-go/openai/v1/responses");
      const body = JSON.parse(String(request[1]?.body));
      expect(body).toMatchObject({ model: "opaque-alias", max_output_tokens: 8192, store: false,
        metadata: { fixture: "preserved" }, text: { verbosity: "low" } });
      expect(body.input[0].role).toBe(supportsReasoning === true ? "developer" : "system");
      if (supportsReasoning === true) {
        expect(body).not.toHaveProperty("temperature"); expect(body).not.toHaveProperty("top_p");
        expect(body.include).toContain("reasoning.encrypted_content");
      } else {
        expect(body).toMatchObject({ temperature: 0, top_p: 0.8 });
        expect(body.include).not.toContain("reasoning.encrypted_content");
      }
      expect(body.include).toContain("message.output_text.logprobs");
      for (const field of ["reasoning", "forceReasoning", "conversation", "previous_response_id"]) expect(body).not.toHaveProperty(field);
      const headers = new Headers(request[1]?.headers);
      expect(headers.get("cf-aig-byok-alias")).toBe("named-fixture");
      expect(headers.get("x-opencode-session")).toBe("chat-fixture");
      expect(headers.get("x-session-affinity")).toBe("chat-fixture");
      expect(headers.get("user-agent")).toBe("EliotResearch/0.1.0"); expect(headers.has("authorization")).toBe(false);
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

describe.each(["openrouter", "opencode-go"])("Gateway bad-request parameter diagnostics: %s", providerId => {
  const provider = { id: providerId, type: "openai-compatible" as const,
    gatewaySlug: providerId === "openrouter" ? "openrouter" : "custom-opencode-go", gatewayPath: "v1",
    enabled: true, baseUrl: providerId === "openrouter" ? "https://openrouter.ai/api/v1" : "https://opencode.ai/inference/go" };
  const model: ModelSpec = { route: `gateway:${providerId}/fixture`, id: "fixture", label: "Offline failure fixture",
    contextTokens: 64000, maxOutputTokens: 8192, checkedOn: "2026-11-08", enabled: true,
    routing: { provider, gatewayId: "fixture" } };
  const secret = "PRIVATE_SECRET: arbitrary provider prose mentions reasoning, temperature and response_format";
  const generic = "External model request failed (HTTP 400). Check the Gateway connection and provider status; no retry was started.";
  const body = (param: unknown) => JSON.stringify({ error: { message: secret, param } });
  const wrapped = (raw: string, param?: unknown) => JSON.stringify({ error: { message: secret, param, metadata: { raw } } });
  const coded = (...codes: unknown[]) => JSON.stringify({ errors: codes.map(code => ({ code, message: secret })), message: secret });

  it.each([2005, 2044, 7003].flatMap(code => [false, true].map(cause => ({ code, cause }))))(
    "projects only agreed numeric code $code from direct/immediate cause=$cause", ({ code, cause }) => {
      const failure = { statusCode: 400, responseBody: coded(code, code) };
      const reason = modelFailure(cause ? new Error(secret, { cause: failure }) : { ...failure, message: secret }, model);
      expect(reason).toBe(`External model request failed (HTTP 400). Error response reported code ${code}. No retry was started.`);
      expect(reason).not.toContain(secret);
    });

  it("keeps absent, malformed, unknown, string, fractional, mixed and oversized codes generic", () => {
    const valid = coded(2044), boundary = valid + " ".repeat(4096 - valid.length);
    expect(modelFailure({ statusCode: 400, responseBody: boundary }, model))
      .toBe("External model request failed (HTTP 400). Error response reported code 2044. No retry was started.");
    for (const responseBody of [undefined, null, "", 2044, "{", "null", "[]", coded(), coded(9999), coded("2044"), coded(2044.5),
      coded(2044, 2005), coded(2044, 9999), JSON.stringify({ errors: [null] }), JSON.stringify({ errors: [{ code: null }] }),
      JSON.stringify({ errors: { code: 2044 } }), JSON.stringify({ error: { errors: [{ code: 2044 }] } }),
      wrapped(coded(2044)), boundary + " "]) {
      expect(modelFailure({ statusCode: 400, responseBody, message: secret }, model)).toBe(generic);
    }
  });

  it("requires code agreement in every available direct and immediate cause body without deeper traversal", () => {
    const direct = { statusCode: 400, responseBody: coded(2044) };
    expect(modelFailure(Object.assign(new Error(secret, { cause: direct }), direct), model))
      .toBe("External model request failed (HTTP 400). Error response reported code 2044. No retry was started.");
    for (const responseBody of [coded(2005), coded("2044"), coded(9999), coded(), "{", null, coded(2044) + " ".repeat(4097)]) {
      expect(modelFailure(Object.assign(new Error(secret, { cause: { responseBody } }), direct), model)).toBe(generic);
      expect(modelFailure(Object.assign(new Error(secret, { cause: direct }), { statusCode: 400, responseBody }), model)).toBe(generic);
    }
    const deeper = Object.assign(new Error(secret, { cause: new Error(secret, { cause: direct }) }), { statusCode: 400 });
    expect(modelFailure(deeper, model)).toBe(generic);
    expect(modelFailure({ statusCode: 400, cause: direct }, model)).toBe(generic);
  });

  it("keeps all three parameter categories ahead of codes and leaves other statuses/native failures unchanged", () => {
    for (const [param, category] of [["reasoning", "reasoning"], ["temperature", "temperature"], ["response_format", "structured-output format"]]) {
      const responseBody = JSON.stringify({ error: { param, message: secret }, errors: [{ code: 2044, message: secret }] });
      expect(modelFailure({ statusCode: 400, responseBody }, model))
        .toBe(`External model request failed (HTTP 400). Error response identified the ${category} parameter. Check the selected model's published controls; no retry was started.`);
    }
    for (const statusCode of [401, 403, 404, 429]) {
      expect(modelFailure({ statusCode, responseBody: coded(2044) }, model)).toBe(modelFailure({ statusCode }, model));
    }
    expect(modelFailure({ statusCode: 400, responseBody: coded(2044) }, { ...model, route: "workers-ai:fixture" }))
      .toBe("Model stream failed (HTTP 400).");
  });

  it.each([
    { param: "reasoning", category: "reasoning", nested: false, cause: false },
    { param: "reasoning.effort", category: "reasoning", nested: true, cause: false },
    { param: "reasoning_effort", category: "reasoning", nested: false, cause: true },
    { param: "temperature", category: "temperature", nested: true, cause: true },
    { param: "temperature", category: "temperature", nested: false, cause: false },
    { param: "response_format", category: "structured-output format", nested: false, cause: false },
    { param: "response_format.json_schema", category: "structured-output format", nested: true, cause: false },
  ])("projects only the fixed category for $param", ({ param, category, nested, cause }) => {
    const failure = { statusCode: 400, responseBody: nested ? wrapped(body(param)) : body(param) };
    const reason = modelFailure(cause ? new Error(secret, { cause: failure }) : { ...failure, message: secret }, model);
    expect(reason).toBe("External model request failed (HTTP 400). Error response identified the " + category + " parameter. Check the selected model's published controls; no retry was started.");
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
      .toContain("Error response identified the reasoning parameter.");
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

  it("does not require provider routing, while other statuses and native failures stay generic", () => {
    const failure = { statusCode: 400, responseBody: body("reasoning") };
    const unrouted = { ...model };
    delete unrouted.routing;
    expect(modelFailure(failure, unrouted)).toContain("Error response identified the reasoning parameter.");
    expect(modelFailure(failure, { ...model, routing: { provider: { ...provider, baseUrl: "https://vendor.example/api/v1" }, gatewayId: "fixture" } }))
      .toContain("Error response identified the reasoning parameter.");
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
