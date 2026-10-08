import { describe, expect, it } from "vitest";
import {
  bindResearchSelectedModelTransport,
  ResearchSelectedModelTransportError,
  resolveResearchSelectedModelTransport,
  type ResearchSelectedModelTransportConfiguration,
} from "@eliotr/cloudflare-research-runtime/research-selected-model-transport.js";

const policy = Object.freeze({
  version: 1,
  transport: "cloudflare-ai-gateway",
  api: "compat-chat-completions",
  provider: "zai",
  model: "glm-5.3-flash",
  billing: Object.freeze({ mode: "unified" }),
  capabilities: Object.freeze({
    max_output_tokens_field: "max_completion_tokens",
    reasoning_efforts: Object.freeze(["low", "high", "max"]),
  }),
});

const selection = Object.freeze({
  stage: "SYNTHESIZE",
  route_ref: "dynamic/eliotr-balanced",
  route_version: "route-v3",
  candidate_ref: "candidate-3",
  candidate_sha256: "a".repeat(64),
  qualification_ref: "qualification-3",
  qualification_sha256: "b".repeat(64),
  transport_policy: policy,
});

function snapshot(overrides: Partial<ResearchSelectedModelTransportConfiguration> = {}) {
  return {
    mode: "snapshot-v2" as const,
    model_selections: [selection],
    ...overrides,
  };
}

describe("resolveResearchSelectedModelTransport", () => {
  it("returns the exact stage selection and its immutable transport capabilities", () => {
    const resolved = resolveResearchSelectedModelTransport({
      run_configuration: snapshot(),
      stage: "SYNTHESIZE",
    });

    expect(resolved?.selection).toBe(selection);
    expect(resolved?.transport_policy).toMatchObject({ provider: "zai", model: "glm-5.3-flash" });
    expect(resolved?.request_capabilities).toEqual(policy.capabilities);
  });

  it("preserves legacy-installed behavior but refuses a missing snapshot stage", () => {
    expect(resolveResearchSelectedModelTransport({ stage: "SYNTHESIZE" })).toBeUndefined();
    expect(resolveResearchSelectedModelTransport({
      run_configuration: { mode: "legacy-installed", model_selections: [] },
      stage: "SYNTHESIZE",
    })).toBeUndefined();

    expect(() => resolveResearchSelectedModelTransport({
      run_configuration: snapshot({ model_selections: [] }),
      stage: "AUDIT_CLAIMS",
    })).toThrowError(ResearchSelectedModelTransportError);
    expect(() => resolveResearchSelectedModelTransport({
      run_configuration: snapshot({ model_selections: [] }),
      stage: "AUDIT_CLAIMS",
    })).toThrow("snapshot has no selected model for AUDIT_CLAIMS");
  });

  it("rejects malformed policy, duplicate stages, and invalid provider/API combinations", () => {
    expect(() => resolveResearchSelectedModelTransport({
      run_configuration: snapshot({ model_selections: [selection, selection] }),
      stage: "SYNTHESIZE",
    })).toThrow("snapshot has duplicate selected models");

    const malformed = { ...selection, transport_policy: { ...policy, model: "" } };
    expect(() => resolveResearchSelectedModelTransport({
      run_configuration: snapshot({ model_selections: [malformed] }),
      stage: "SYNTHESIZE",
    })).toThrow("snapshot selected transport policy is invalid");

    const mismatchedApi = { ...selection, transport_policy: { ...policy, api: "openai-responses" } };
    expect(() => resolveResearchSelectedModelTransport({
      run_configuration: snapshot({ model_selections: [mismatchedApi] }),
      stage: "SYNTHESIZE",
    })).toThrow("snapshot selected transport policy is invalid");
  });
});

describe("bindResearchSelectedModelTransport", () => {
  it("requires HTTP gateway credentials for a provider-native BYOK selection", () => {
    const nativePolicy = {
      ...policy,
      api: "openrouter-chat-completions",
      provider: "openrouter",
      model: "stealth/space-bunny-alpha",
      billing: {
        mode: "byok",
        alias: `eliotr-${"c".repeat(48)}`,
        free_only: true,
      },
    };
    const selected = resolveResearchSelectedModelTransport({
      run_configuration: snapshot({ model_selections: [{
        ...selection,
        candidate_kind: "provider-native-v1",
        transport_policy: nativePolicy,
      }] }),
      stage: "SYNTHESIZE",
    });
    const bindingGateway = {
      reasoning_gateway_base_url: "https://gateway.example.invalid",
      ai_gateway_binding: { gateway: () => undefined },
    } as never;

    expect(() => bindResearchSelectedModelTransport(bindingGateway, selected))
      .toThrow("selected BYOK alias requires the configured HTTP AI Gateway credential route");
  });

  it("binds the saved policy without manufacturing provider credentials", () => {
    const selected = resolveResearchSelectedModelTransport({
      run_configuration: snapshot(),
      stage: "SYNTHESIZE",
    });
    const gateway = {
      reasoning_gateway_base_url: "https://gateway.example.invalid",
      gateway_token: "server-owned-gateway-token",
    } as const;
    const bound = bindResearchSelectedModelTransport(gateway, selected);

    expect(bound).toMatchObject({
      gateway_token: gateway.gateway_token,
      transport_policy: { provider: "zai", model: "glm-5.3-flash" },
    });
    expect(bound).not.toHaveProperty("Authorization");
  });
});
