import { describe, it, expect } from "vitest";
import { createAiUsageObservation } from "./ai-usage-http.js";

describe("createAiUsageObservation", () => {
  it("returns unavailable when analytics token is not configured", async () => {
    const observation = await createAiUsageObservation({
      gatewayUrl: "https://gateway.ai.cloudflare.com/v1/bc10e9f02aa57f4adc5a7a48ad1bacff/eliotr-reasoning",
      analyticsToken: undefined,
    });

    expect(observation.protocol).toBe("eliotr.ai-usage-observation.v2");
    expect(observation.free_allocation_neurons).toBe(10_000);
    expect(observation.usage_neurons).toBeNull();
    expect(observation.remaining_neurons).toBeNull();
    expect(observation.status).toBe("unavailable");
    expect(observation.unavailability_reason).toBe("Analytics API token is not configured");
    expect(observation.provider_analytics_scope).toBe("aiInferenceAdaptiveGroups");
    expect(observation.pricing_reference_url).toBe(
      "https://developers.cloudflare.com/workers-ai/platform/pricing/",
    );
    expect(typeof observation.observed_at).toBe("string");
    expect(new Date(observation.observed_at).toISOString()).toBe(observation.observed_at);
    expect(typeof observation.period_start).toBe("string");
    expect(typeof observation.period_end).toBe("string");
  });

  it("returns unavailable when account ID cannot be derived from gateway URL", async () => {
    const observation = await createAiUsageObservation({
      gatewayUrl: "https://example.com/no-account-id",
      analyticsToken: "some-token",
    });

    expect(observation.status).toBe("unavailable");
    expect(observation.unavailability_reason).toBe(
      "Cloudflare account ID could not be derived from gateway URL",
    );
  });

  it("returns available with actual neurons when Analytics API returns data", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      expect(url).toBe("https://api.cloudflare.com/client/v4/graphql");
      const body = JSON.parse(init?.body as string);
      expect(body.query).toContain("Time!");
      expect(body.query).not.toContain("DateTime!");
      expect(body.variables.account).toBe("bc10e9f02aa57f4adc5a7a48ad1bacff");
      return new Response(
        JSON.stringify({
          data: {
            viewer: {
              accounts: [{
                aiInferenceAdaptiveGroups: [{
                  sum: { totalNeurons: 218.1863660812378 },
                }],
              }],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    try {
      const observation = await createAiUsageObservation({
        gatewayUrl: "https://gateway.ai.cloudflare.com/v1/bc10e9f02aa57f4adc5a7a48ad1bacff/eliotr-reasoning",
        analyticsToken: "test-token",
      });
      expect(observation.status).toBe("available");
      expect(observation.usage_neurons).toBeCloseTo(218.1863660812378, 5);
      expect(observation.remaining_neurons).toBeCloseTo(10000 - 218.1863660812378, 5);
      expect(observation.unavailability_reason).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns unavailable when Analytics API returns errors", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          errors: [{ message: "Authentication error" }],
          data: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    try {
      const observation = await createAiUsageObservation({
        gatewayUrl: "https://gateway.ai.cloudflare.com/v1/bc10e9f02aa57f4adc5a7a48ad1bacff/eliotr-reasoning",
        analyticsToken: "bad-token",
      });
      expect(observation.status).toBe("unavailable");
      expect(observation.usage_neurons).toBeNull();
      expect(observation.remaining_neurons).toBeNull();
      expect(observation.unavailability_reason).not.toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns unavailable when Analytics API returns non-OK status", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response("Unauthorized", { status: 401 });
    };
    try {
      const observation = await createAiUsageObservation({
        gatewayUrl: "https://gateway.ai.cloudflare.com/v1/bc10e9f02aa57f4adc5a7a48ad1bacff/eliotr-reasoning",
        analyticsToken: "bad-token",
      });
      expect(observation.status).toBe("unavailable");
      expect(observation.usage_neurons).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns available with 0 neurons when account has no usage groups", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          data: {
            viewer: {
              accounts: [{
                aiInferenceAdaptiveGroups: [],
              }],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    try {
      const observation = await createAiUsageObservation({
        gatewayUrl: "https://gateway.ai.cloudflare.com/v1/bc10e9f02aa57f4adc5a7a48ad1bacff/eliotr-reasoning",
        analyticsToken: "test-token",
      });
      expect(observation.status).toBe("available");
      expect(observation.usage_neurons).toBe(0);
      expect(observation.remaining_neurons).toBe(10000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
