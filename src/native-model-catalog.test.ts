import { describe, expect, it } from "vitest";
import { nativeModel } from "./native-model-catalog";

type NativeRow = Awaited<ReturnType<Ai["models"]>>[number];
// Shape observed from the real AI binding, including array/object property
// values that the pinned Cloudflare declaration incorrectly calls strings.
const row = (properties: unknown[]): NativeRow => ({ id: "catalogue-uuid", name: "@cf/vendor/new-chat-model",
  task: { name: "Text Generation" }, properties } as unknown as NativeRow);

describe("Workers AI catalogue metadata", () => {
  it("uses the callable name and token units from live properties, preserving an unknown output capacity", () => {
    expect(nativeModel(row([
      { property_id: "context_window", value: "1048576" },
      { property_id: "price", value: [
        { unit: "per M input tokens", price: 0.15, currency: "USD" },
        { unit: "per M cached input tokens", price: 0.03, currency: "USD" },
        { unit: "per M output tokens", price: 0.5, currency: "USD" },
      ] },
      { property_id: "reasoning_effort", value: { supported_efforts: ["max", "high", "low"] } },
    ]), "2026-10-27")).toMatchObject({ id: "@cf/vendor/new-chat-model",
      route: "workers-ai:@cf/vendor/new-chat-model", contextTokens: 1048576,
      maxOutputTokens: null, outputReserveTokens: 8192, nativeReasoningEffort: "low",
      inputMicrousdPerMillion: 150000, cachedMicrousdPerMillion: 30000, outputMicrousdPerMillion: 500000 });
  });

  it("keeps unsupported units, currency and absent cache prices unknown", () => {
    const model = nativeModel(row([{ property_id: "price", value: [
      { unit: "per M input tokens", price: 0, currency: "USD" },
      { unit: "per M output tokens", price: 1, currency: "EUR" },
      { unit: "per neuron", price: 0.01, currency: "USD" },
    ] }]), "2026-10-27");
    expect(model).toMatchObject({ contextTokens: null, inputMicrousdPerMillion: 0,
      cachedMicrousdPerMillion: null, outputMicrousdPerMillion: null });
    expect(model?.nativeReasoningEffort).toBeUndefined();
  });

  it("does not choose one of contradictory property entries", () => {
    expect(nativeModel(row([
      { property_id: "context_window", value: "1048576" },
      { property_id: "context_window", value: "128000" },
    ]), "2026-10-27")?.contextTokens).toBeNull();
  });
});
