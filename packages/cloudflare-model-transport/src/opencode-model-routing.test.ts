import { describe, expect, it } from "vitest";
import { planOpenCodeModelRoute, type OpenCodeModelRouteInput } from "./opencode-model-routing.js";

function input(provider = "opencode-go"): OpenCodeModelRouteInput {
  return { provider_id: provider, provider_slug: `custom-${provider}`, model_id: "exact-model",
    advertised_sdk: "@ai-sdk/openai", advertised_api_base: `https://opencode.ai/inference${provider === "opencode-go" ? "/go" : ""}/openai/v1`,
    registered_provider: { slug: `custom-${provider}`, base_url: "https://opencode.ai" } };
}

describe("OpenCode model-specific routing plan", () => {
  it.each(["opencode-go", "opencode-zen"])("routes all three SDKs through a single %s base with unchanged credential identity", provider => {
    const product = provider === "opencode-go" ? "/inference/go" : "/inference";
    for (const [sdk, family, suffix, api] of [
      ["@ai-sdk/openai", "/openai/v1", "/responses", "custom-responses"],
      ["@ai-sdk/openai-compatible", "/openai/v1", "/chat/completions", "custom-chat-completions"],
      ["@ai-sdk/anthropic", "/anthropic/v1", "/messages", "custom-anthropic-messages"],
    ] as const) {
      for (const basePath of ["", product, `${product}${family}`]) {
        const plan = planOpenCodeModelRoute({ ...input(provider), advertised_sdk: sdk,
          advertised_api_base: `https://opencode.ai${product}${family}`,
          registered_provider: { slug: `custom-${provider}`, base_url: `https://opencode.ai${basePath}` } });
        expect(plan.status).toBe("eligible_unverified");
        if (plan.status !== "eligible_unverified") throw new Error("route missing");
        expect(plan.api).toBe(api);
        expect(plan.provider_slug).toBe(`custom-${provider}`);
        expect(plan.expected_upstream_url).toBe(`https://opencode.ai${product}${family}${suffix}`);
        expect(plan.gateway_path).toBe(`/custom-custom-${provider}${`${product}${family}${suffix}`.slice(basePath.length)}`);
        expect(`${plan.registered_base_url}${plan.gateway_path.slice(`/custom-custom-${provider}`.length)}`).toBe(plan.expected_upstream_url);
        expect(new Request(`https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/eliotr-reasoning${plan.gateway_path}`).url)
          .toContain(`/custom-custom-${provider}/`);
      }
    }
  });

  it("does not send Anthropic Messages under an OpenAI-specific registered base", () => {
    expect(planOpenCodeModelRoute({ ...input(), advertised_sdk: "@ai-sdk/anthropic",
      advertised_api_base: "https://opencode.ai/inference/go/anthropic/v1",
      registered_provider: { slug: "custom-opencode-go", base_url: "https://opencode.ai/inference/go/openai/v1" } }))
      .toEqual({ status: "blocked", reason: "REGISTERED_BASE_INCOMPATIBLE" });
  });

  it.each(["@ai-sdk/google", "@ai-sdk/systemone", "unknown", null])("does not invent a codec for %s", sdk => {
    expect(planOpenCodeModelRoute({ ...input(), advertised_sdk: sdk })).toEqual({ status: "blocked", reason: "SDK_UNSUPPORTED" });
  });

  it.each(["https://wrong.example/inference/go/openai/v1", "https://opencode.ai/inference/anthropic/v1",
    "https://opencode.ai/inference/go/openai/v1?key=private", "https://opencode.ai/inference/go/openai/v1#fragment"])(
    "rejects mismatched advertised API base %s", base => {
      expect(planOpenCodeModelRoute({ ...input(), advertised_api_base: base }).status).toBe("blocked");
    },
  );

  it("requires actual registered metadata and preserves opaque model IDs", () => {
    expect(planOpenCodeModelRoute({ ...input(), registered_provider: null })).toEqual({ status: "blocked", reason: "REGISTERED_BASE_UNVERIFIED" });
    expect(planOpenCodeModelRoute({ ...input(), model_id: "~vendor/model-alias" })).toMatchObject({ status: "eligible_unverified", model_id: "~vendor/model-alias" });
    expect(planOpenCodeModelRoute({ ...input(), registered_provider: { slug: "opencode-go", base_url: "https://opencode.ai" } }))
      .toEqual({ status: "blocked", reason: "CREDENTIAL_NAMESPACE_MISMATCH" });
    expect(planOpenCodeModelRoute({ ...input(), provider_slug: "custom-custom-opencode-go" }))
      .toEqual({ status: "blocked", reason: "CREDENTIAL_NAMESPACE_MISMATCH" });
  });
});
