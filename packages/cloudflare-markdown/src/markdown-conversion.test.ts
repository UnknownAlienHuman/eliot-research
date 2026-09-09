import { describe, expect, it, vi } from "vitest";
import { createWorkersAiMarkdownConversionAdapter } from "./markdown-conversion.js";
import { MARKDOWN_CONVERSION_MAX_INPUT_BYTES } from "./markdown-conversion-contract.js";
import type {
  MarkdownConversionInput,
  WorkersAiMarkdownBinding,
} from "./markdown-conversion-contract.js";

const context = {
  operation_id: "operation-1",
  attempt_id: "attempt-1",
  input_sha256: "a".repeat(64),
  profile_generation: "markdown-profile-1",
} as const;

function input(overrides: Partial<MarkdownConversionInput> = {}): MarkdownConversionInput {
  return {
    name: "source.pdf",
    blob: new Blob(["raw"], { type: "application/octet-stream" }),
    context,
    bounds: { max_output_bytes: 1024, max_tokens: 100, timeout_ms: 1000 },
    ...overrides,
  };
}

function binding(result: unknown): WorkersAiMarkdownBinding {
  return { toMarkdown: vi.fn(async () => result) };
}

describe("Workers AI Markdown Conversion binding", () => {
  it("records a strict current documented result and detected MIME", async () => {
    const ai = binding({ id: "result-1", name: "source.pdf", format: "markdown", mimetype: "application/pdf", tokens: 3, data: "# Extracted\n" });
    const result = await createWorkersAiMarkdownConversionAdapter(ai).convert(input());
    expect(result).toMatchObject({ disposition: "CONVERTED", provider_result_id: "result-1", name: "source.pdf", detected_mime: "application/pdf", format: "markdown", tokens: 3, data: "# Extracted\n", data_bytes: 12 });
    expect(result).toMatchObject({ data_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(ai.toMarkdown).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ id: "result-1", name: "source.pdf", format: "error", mimetype: "application/pdf", error: "provider failed" }, "PROVIDER_ERROR"],
    [{ id: "result-1", name: "source.pdf", format: "markdown", mimetype: "application/pdf", tokens: 1, data: "ok", extra: true }, "RESPONSE_INVALID"],
    [{ id: "result-1", name: "source.pdf", format: "markdown", mimetype: "application/pdf", tokens: 1, data: "   " }, "EMPTY_OUTPUT"],
  ] as const)("returns a typed failure for provider/shape/content case %#", async (response, code) => {
    const result = await createWorkersAiMarkdownConversionAdapter(binding(response)).convert(input());
    expect(result).toMatchObject({ disposition: "FAILED", code });
  });

  it("does not accept a detected MIME field from the stale pinned spelling", async () => {
    const result = await createWorkersAiMarkdownConversionAdapter(binding({
      id: "result-1", name: "source.pdf", format: "markdown", mimeType: "application/pdf", tokens: 1, data: "ok",
    })).convert(input());
    expect(result).toMatchObject({ disposition: "FAILED", code: "RESPONSE_INVALID" });
  });

  it("rejects unknown conversion options before the provider call", async () => {
    const ai = binding({ id: "result-1", name: "source.pdf", format: "markdown", mimetype: "application/pdf", tokens: 1, data: "ok" });
    const result = await createWorkersAiMarkdownConversionAdapter(ai).convert(input({
      conversion_options: { output: { format: "markdown" }, unsupported: true } as never,
    }));
    expect(result).toMatchObject({ disposition: "FAILED", code: "INPUT_INVALID" });
    expect(ai.toMarkdown).not.toHaveBeenCalled();
  });

  it("returns INPUT_INVALID when bounds are absent instead of throwing", async () => {
    const ai = binding({ id: "result-1", name: "source.pdf", format: "markdown", mimetype: "application/pdf", tokens: 1, data: "ok" });
    const result = await createWorkersAiMarkdownConversionAdapter(ai).convert(input({ bounds: undefined as never }));
    expect(result).toMatchObject({ disposition: "FAILED", code: "INPUT_INVALID" });
    expect(ai.toMarkdown).not.toHaveBeenCalled();
  });

  it.each([
    new Blob([]),
    new Blob(["x".repeat(MARKDOWN_CONVERSION_MAX_INPUT_BYTES + 1)]),
  ])("rejects empty or over-bound input blobs before the provider call", async (blob) => {
    const ai = binding({ id: "result-1", name: "source.pdf", format: "markdown", mimetype: "application/pdf", tokens: 1, data: "ok" });
    const result = await createWorkersAiMarkdownConversionAdapter(ai).convert(input({ blob }));
    expect(result).toMatchObject({ disposition: "FAILED", code: "INPUT_INVALID" });
    expect(ai.toMarkdown).not.toHaveBeenCalled();
  });

  it("snapshots identity, bounds, and options before awaiting the provider", async () => {
    let resolveProvider: (value: unknown) => void = () => undefined;
    let receivedOptions: unknown;
    const ai: WorkersAiMarkdownBinding = {
      toMarkdown: vi.fn((_file, options) => {
        receivedOptions = options?.conversionOptions;
        return new Promise<unknown>((resolve) => { resolveProvider = resolve; });
      }),
    };
    const mutableContext = { ...context } as { operation_id: string; attempt_id: string; input_sha256: string; profile_generation: string };
    const mutableBounds = { max_output_bytes: 1024, max_tokens: 100, timeout_ms: 1000 };
    const mutableOptions = { output: { format: "markdown" as "markdown" | "text" } };
    const request = input({ context: mutableContext, bounds: mutableBounds, conversion_options: mutableOptions });
    const pending = createWorkersAiMarkdownConversionAdapter(ai).convert(request);
    mutableContext.operation_id = "changed-after-dispatch";
    mutableBounds.max_output_bytes = 1;
    mutableOptions.output.format = "text";
    resolveProvider({ id: "result-1", name: "source.pdf", format: "markdown", mimetype: "application/pdf", tokens: 1, data: "ok" });
    const result = await pending;
    expect(result).toMatchObject({ disposition: "CONVERTED", context });
    expect(receivedOptions).toEqual({ output: { format: "markdown" } });
  });

  it("enforces caller output and token bounds without retrying", async () => {
    const ai = binding({ id: "result-1", name: "source.pdf", format: "markdown", mimetype: "application/pdf", tokens: 101, data: "ok" });
    const result = await createWorkersAiMarkdownConversionAdapter(ai).convert(input({ bounds: { max_output_bytes: 1, max_tokens: 100, timeout_ms: 1000 } }));
    expect(result).toMatchObject({ disposition: "FAILED", code: "TOKEN_LIMIT_EXCEEDED" });
    expect(ai.toMarkdown).toHaveBeenCalledTimes(1);
    const oversized = await createWorkersAiMarkdownConversionAdapter(binding({ id: "result-1", name: "source.pdf", format: "markdown", mimetype: "application/pdf", tokens: 1, data: "too long" })).convert(input({ bounds: { max_output_bytes: 1, max_tokens: 100, timeout_ms: 1000 } }));
    expect(oversized).toMatchObject({ disposition: "FAILED", code: "OUTPUT_LIMIT_EXCEEDED" });
  });

  it("returns abort and timeout outcomes without invoking hidden retries", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const ai = binding({ id: "never", name: "source.pdf", format: "markdown", mimetype: "application/pdf", tokens: 1, data: "ok" });
    const before = await createWorkersAiMarkdownConversionAdapter(ai).convert(input({ signal: aborted.signal }));
    expect(before).toMatchObject({ disposition: "FAILED", code: "ABORTED" });
    expect(ai.toMarkdown).not.toHaveBeenCalled();

    const pending: WorkersAiMarkdownBinding = { toMarkdown: vi.fn(() => new Promise<unknown>(() => undefined)) };
    const after = await createWorkersAiMarkdownConversionAdapter(pending).convert(input({ bounds: { max_output_bytes: 1024, max_tokens: 100, timeout_ms: 5 } }));
    expect(after).toMatchObject({ disposition: "FAILED", code: "TIMEOUT" });
    expect(pending.toMarkdown).toHaveBeenCalledTimes(1);
  });
});
