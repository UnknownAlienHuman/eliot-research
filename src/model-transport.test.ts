import { streamText } from "ai";
import { describe, expect, it, vi } from "vitest";
import { resolveModelTransport } from "./model-transport";
import { DEFAULT_MODEL, MODELS, modelOutputLimit } from "./models";

describe("native fallback reasoning request", () => {
  it("forwards low through the installed AI SDK adapter and preserves the fallback bounds", async () => {
    const model = MODELS.find((entry) => entry.route === DEFAULT_MODEL);
    if (!model) throw new Error("The built-in native model fallback is missing.");
    expect(model).toMatchObject({
      id: "@cf/zai-org/glm-5.3-flash",
      contextTokens: 1_048_576,
      outputReserveTokens: 8192,
      nativeReasoningEffort: "low",
    });
    expect(modelOutputLimit(model)).toBe(8192);

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
    const result = await streamText({ model: transport, prompt: "Capture the native request only.", maxOutputTokens: modelOutputLimit(model), maxRetries: 0 }).text;

    expect(result).toBe("Captured without inference.");
    expect(run).toHaveBeenCalledTimes(1);
    expect(captured?.model).toBe(model.id);
    expect(captured?.inputs).toMatchObject({
      reasoning_effort: "low",
      max_tokens: 8192,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(captured?.inputs.reasoning_effort).not.toBe("max");
    expect((captured?.inputs.chat_template_kwargs as Record<string, unknown> | undefined)?.enable_thinking).not.toBe(false);
    expect(captured?.options.returnRawResponse).toBe(true);
  });
});
