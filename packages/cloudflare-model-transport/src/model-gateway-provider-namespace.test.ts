import { describe, expect, it } from "vitest";
import { modelGatewayCustomProviderRoutingId, modelGatewayObservedProviderMatches } from "./model-gateway-provider-namespace.js";
import { modelGatewayProviderNativePath } from "./model-gateway-provider-native-request.js";

describe("custom provider credential and transport namespaces", () => {
  it.each(["custom-opencode-go", "custom-opencode-zen", "custom-compatible-fixture"])(
    "adds one transport prefix to the stable %s raw slug and preserves endpoint suffixes", canonical => {
      const transport = modelGatewayCustomProviderRoutingId(canonical);
      expect(transport).toBe(`custom-${canonical}`);
      const base = canonical === "custom-opencode-go" ? "https://opencode.ai/inference/go/openai/v1" : "https://provider.example/tenant/v1";
      for (const [api, suffix] of [["custom-responses", "/responses"], ["custom-chat-completions", "/chat/completions"],
        ["custom-anthropic-messages", "/v1/messages"]] as const) {
        const path = modelGatewayProviderNativePath(api, canonical);
        expect(path).toBe(`/${transport}${suffix}`);
        const before = `${base}${suffix}`;
        const after = `${base}${path.slice(`/${transport}`.length)}`;
        expect(after).toBe(before);
      }
      expect(modelGatewayObservedProviderMatches(transport, canonical)).toBe(true);
      expect(modelGatewayObservedProviderMatches(canonical, canonical)).toBe(false);
      expect(modelGatewayObservedProviderMatches(canonical, canonical, "failed-history")).toBe(true);
      expect(modelGatewayObservedProviderMatches(`custom-${transport}`, canonical, "failed-history")).toBe(false);
      expect(modelGatewayObservedProviderMatches("unrelated-provider", canonical, "failed-history")).toBe(false);
    },
  );

  it.each(["opencode-go", "custom-opencode-go/other", "custom-opencode-go?alias=other", "custom-"])(
    "rejects invalid custom routing identity %s", provider => {
      expect(() => modelGatewayCustomProviderRoutingId(provider)).toThrow();
    },
  );

  it("keeps native provider observations exact without custom-provider aliases", () => {
    expect(modelGatewayObservedProviderMatches("openrouter", "openrouter")).toBe(true);
    expect(modelGatewayObservedProviderMatches("custom-openrouter", "openrouter", "failed-history")).toBe(false);
  });
});
