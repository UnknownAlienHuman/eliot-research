import { describe, expect, it } from "vitest";
import {
  modelGatewayProviderNativeRequest,
} from "./model-gateway-provider-native-request.js";
import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
  validateModelGatewayTransportPolicy,
  type ModelGatewayTransportPolicyV1,
} from "./model-gateway-request.js";

const OPENROUTER_POLICY: ModelGatewayTransportPolicyV1 = {
  version: 1,
  transport: "cloudflare-ai-gateway",
  api: "openrouter-chat-completions",
  provider: "openrouter",
  model: "stealth/space-bunny-alpha",
  billing: { mode: "byok", alias: "openrouter-test-key" },
  capabilities: { max_output_tokens_field: "max_tokens", reasoning_efforts: ["low"] },
};

const FREE_ONLY_POLICY: ModelGatewayTransportPolicyV1 = {
  ...OPENROUTER_POLICY,
  billing: { mode: "byok", alias: "openrouter-test-key", free_only: true },
};

const BODY = {
  model: OPENROUTER_POLICY.model,
  messages: [
    { role: "system", content: "trusted system" },
    { role: "user", content: "bounded request" },
  ],
  max_tokens: 32,
  stream: false,
};

describe("OpenRouter free-only transport policy", () => {
  it("sets zero price ceilings and disables fallback without adding model alternatives", () => {
    const request = modelGatewayProviderNativeRequest(BODY, FREE_ONLY_POLICY);
    expect(request).toMatchObject({
      model: OPENROUTER_POLICY.model,
      provider: {
        allow_fallbacks: false,
        max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
      },
    });
    expect(request).not.toHaveProperty("models");
  });

  it("preserves the previous OpenRouter body bytes when free-only is omitted", async () => {
    const request = modelGatewayProviderNativeRequest(BODY, OPENROUTER_POLICY);
    const legacyBytes = canonicalModelGatewayJson(BODY);
    const requestBytes = canonicalModelGatewayJson(request);
    expect(requestBytes).toBe(legacyBytes);
    await expect(modelGatewaySha256(requestBytes)).resolves.toBe(await modelGatewaySha256(legacyBytes));
  });

  it("accepts only literal true on OpenRouter BYOK and fails closed elsewhere", () => {
    expect(validateModelGatewayTransportPolicy(FREE_ONLY_POLICY).billing).toEqual({
      mode: "byok",
      alias: "openrouter-test-key",
      free_only: true,
    });
    expect(() => validateModelGatewayTransportPolicy({
      ...OPENROUTER_POLICY,
      billing: { mode: "byok", alias: "openrouter-test-key", free_only: false },
    })).toThrow("model gateway free-only policy must be explicitly true");
    expect(() => validateModelGatewayTransportPolicy({
      ...OPENROUTER_POLICY,
      billing: { mode: "unified", free_only: true },
    })).toThrow("contains unsupported field free_only");

    const mismatchedPolicy: ModelGatewayTransportPolicyV1 = {
      ...FREE_ONLY_POLICY,
      provider: "other-provider",
    };
    expect(() => modelGatewayProviderNativeRequest({}, mismatchedPolicy))
      .toThrow("free-only billing requires the OpenRouter-native endpoint");
    expect(() => validateModelGatewayTransportPolicy({
      version: 1,
      transport: "cloudflare-ai-gateway",
      api: "openai-chat-completions",
      provider: "openai",
      model: "openai/gpt-4.1-mini",
      billing: { mode: "byok", alias: "default", free_only: true },
      capabilities: { max_output_tokens_field: "max_tokens", reasoning_efforts: ["low"] },
    })).toThrow("free-only billing requires the OpenRouter-native endpoint");
  });
});
