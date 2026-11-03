import type { LanguageModelUsage } from "ai";
import { describe, expect, it } from "vitest";
import { turnUsageProjection } from "./chat-usage";

function sdkUsage(inputTokens: number | undefined, cached: number | undefined, outputTokens: number | undefined,
  raw?: LanguageModelUsage["raw"]): LanguageModelUsage {
  return { inputTokens, outputTokens, totalTokens: undefined,
    inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: cached, cacheWriteTokens: undefined },
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined }, ...(raw === undefined ? {} : { raw }) };
}
const provider = { inputTokens: 8, cachedTokens: 3, outputTokens: 5, totalTokens: 13, reasoningTokens: 2 };
const reported = sdkUsage(8, 3, 5, { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13,
  prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 }, unrelated: "not retained" });

describe("post-stream usage projection", () => {
  it.each([
    { name: "dispatched without a report retains unknown usage and reservation", dispatched: true, usage: undefined, expected: {} },
    { name: "reported missing counts stay null", dispatched: true, usage: sdkUsage(undefined, undefined, undefined),
      expected: { providerUsage: null, inputTokens: null, cachedTokens: null, outputTokens: null } },
    { name: "reported zeros including cache are known zero", dispatched: true,
      usage: sdkUsage(0, 0, 0, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
        prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } }),
      expected: { providerUsage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0 }, inputTokens: 0, cachedTokens: 0, outputTokens: 0 } },
    { name: "nonzero cache and safe provider fields remain reported", dispatched: true, usage: reported,
      expected: { providerUsage: provider, inputTokens: 8, cachedTokens: 3, outputTokens: 5 } },
    { name: "unreported cache is unknown despite known input and output", dispatched: true, usage: sdkUsage(8, undefined, 5),
      expected: { providerUsage: null, inputTokens: 8, cachedTokens: null, outputTokens: 5 } },
    { name: "undispatched without a report has zero usage and limit", dispatched: false, usage: undefined,
      expected: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, tokenLimit: 0 } },
    { name: "undispatched with a report retains provider telemetry while zeroing usage and limit", dispatched: false, usage: reported,
      expected: { providerUsage: provider, inputTokens: 0, cachedTokens: 0, outputTokens: 0, tokenLimit: 0 } },
  ])("$name", ({ dispatched, usage, expected }) => {
    const before = structuredClone(usage);
    const patch = turnUsageProjection(dispatched, usage);
    expect(patch).toStrictEqual(expected);
    expect(usage).toStrictEqual(before);
    const retained = { inputTokens: null, cachedTokens: null, outputTokens: null, tokenLimit: 1234, providerUsage: provider };
    const result = { ...retained, ...patch };
    expect(result.tokenLimit).toBe(dispatched ? 1234 : 0);
    if (dispatched && usage === undefined) expect(result).toStrictEqual(retained);
  });
});
