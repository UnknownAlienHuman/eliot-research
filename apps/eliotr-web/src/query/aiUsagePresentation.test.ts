import { describe, expect, it } from "vitest";
import type { AiUsageObservation } from "./aiUsagePresentation";
import { aiUsagePresentation } from "./aiUsagePresentation";

const base = {
  protocol: "eliotr.ai-usage-observation.v2",
  period_start: "2026-10-16T00:00:00.000Z",
  period_end: "2026-10-17T00:00:00.000Z",
  free_allocation_neurons: 10_000,
  observed_at: "2026-10-16T15:00:00.000Z",
  provider_analytics_scope: "aiInferenceAdaptiveGroups",
  pricing_reference_url: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
} as const;

describe("AI usage presentation", () => {
  it("keeps the known free allocation while unavailable measurements stay unknown", () => {
    const value: AiUsageObservation = { ...base, status: "unavailable", usage_neurons: null,
      remaining_neurons: null, unavailability_reason: "analytics_access_unavailable" };
    expect(aiUsagePresentation(value, false)).toMatchObject({
      freeAllocation: 10_000, used: null, remaining: null,
    });
  });

  it("preserves measured zero and never reuses a stale measurement after a failed read", () => {
    const value: AiUsageObservation = { ...base, status: "available", usage_neurons: 0,
      remaining_neurons: 10_000, unavailability_reason: null };
    expect(aiUsagePresentation(value, false)).toMatchObject({ used: 0, remaining: 10_000 });
    expect(aiUsagePresentation(value, true)).toMatchObject({
      freeAllocation: 10_000, used: null, remaining: null,
    });
  });
});
