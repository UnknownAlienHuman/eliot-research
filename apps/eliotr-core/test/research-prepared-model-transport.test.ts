import { describe, expect, it } from "vitest";
import {
  canonicalModelGatewayJson,
  type ModelGatewayTransportPolicyV1,
} from "@eliotr/cloudflare-ai";
import type { ResearchModelGatewayRuntimeConfig } from "@eliotr/cloudflare-research";
import {
  bindResearchPreparedModelTransportPolicy,
  parseResearchPreparedModelTransportPolicies,
  RESEARCH_PREPARED_MODEL_TRANSPORT_PROTOCOL,
  ResearchPreparedModelTransportError,
  resolveResearchPreparedModelTransportPolicy,
  type ResearchPreparedModelTransportSelectionV1,
} from "../src/research-prepared-model-transport.js";

const unifiedPolicy: ModelGatewayTransportPolicyV1 = Object.freeze({
  version: 1,
  transport: "cloudflare-ai-gateway",
  api: "compat-chat-completions",
  provider: "zai",
  model: "@cf/zai-org/glm-5.3-flash",
  billing: Object.freeze({ mode: "unified" }),
  capabilities: Object.freeze({
    max_output_tokens_field: "max_completion_tokens",
    reasoning_efforts: Object.freeze(["low", "high", "max"] as const),
  }),
});

const selection: ResearchPreparedModelTransportSelectionV1 = Object.freeze({
  stage: "SYNTHESIZE",
  route_ref: "dynamic/eliotr-balanced",
  route_version: "route-v3",
  provider: "zai",
  model: "@cf/zai-org/glm-5.3-flash",
  transport_policy: unifiedPolicy,
});

function envelope(
  rows: readonly ResearchPreparedModelTransportSelectionV1[] = [selection],
): string {
  return canonicalModelGatewayJson({
    protocol: RESEARCH_PREPARED_MODEL_TRANSPORT_PROTOCOL,
    model_selections: rows,
  });
}

function httpGateway(): ResearchModelGatewayRuntimeConfig {
  return {
    reasoning_gateway_base_url: "https://gateway.example.invalid/account/eliotr-reasoning",
    gateway_token: "server-held-test-token",
  };
}

describe("parseResearchPreparedModelTransportPolicies", () => {
  it("preserves the legacy path only when the server variable is absent", () => {
    expect(parseResearchPreparedModelTransportPolicies(undefined)).toBeUndefined();
    expect(() => parseResearchPreparedModelTransportPolicies("")).toThrowError(
      ResearchPreparedModelTransportError,
    );
  });

  it("accepts a canonical exact policy and freezes its server-owned selections", () => {
    const parsed = parseResearchPreparedModelTransportPolicies(envelope());
    expect(parsed?.model_selections).toEqual([selection]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.model_selections)).toBe(true);
    expect(Object.isFrozen(parsed?.model_selections[0]?.transport_policy)).toBe(true);
  });

  it("rejects noncanonical, oversized, unknown-field, and secret-bearing envelopes", () => {
    expect(() => parseResearchPreparedModelTransportPolicies(JSON.stringify({
      protocol: RESEARCH_PREPARED_MODEL_TRANSPORT_PROTOCOL,
      model_selections: [selection],
    }))).toThrow("not canonical");
    expect(() => parseResearchPreparedModelTransportPolicies(" ".repeat(65_537))).toThrow("byte bound");
    expect(() => parseResearchPreparedModelTransportPolicies(envelope([
      { ...selection, access_token: "must-not-be-accepted" } as ResearchPreparedModelTransportSelectionV1,
    ]))).toThrow("unsupported field access_token");
    expect(() => parseResearchPreparedModelTransportPolicies(envelope([
      { ...selection, transport_policy: { ...unifiedPolicy, api_key: "secret" } } as unknown as ResearchPreparedModelTransportSelectionV1,
    ]))).toThrow("prepared model transport policy is invalid");
  });

  it("rejects identity conflicts, duplicate or unordered stages, and unsupported APIs", () => {
    expect(() => parseResearchPreparedModelTransportPolicies(envelope([
      { ...selection, provider: "other-provider" },
    ]))).toThrow("identity differs");
    expect(() => parseResearchPreparedModelTransportPolicies(envelope([selection, selection])))
      .toThrow("duplicated");
    expect(() => parseResearchPreparedModelTransportPolicies(envelope([
      { ...selection, stage: "AUDIT_CLAIMS" },
      { ...selection, stage: "ANALYZE_BRANCHES" },
    ]))).toThrow("canonical stage order");
    expect(() => parseResearchPreparedModelTransportPolicies(envelope([
      { ...selection, transport_policy: { ...unifiedPolicy, api: "openai-responses" } } as ResearchPreparedModelTransportSelectionV1,
    ]))).toThrow("not supported by the qualification response path");
  });
});

describe("resolveResearchPreparedModelTransportPolicy", () => {
  it("resolves only an exact stage, route revision, provider and model tuple", () => {
    const parsed = parseResearchPreparedModelTransportPolicies(envelope());
    expect(resolveResearchPreparedModelTransportPolicy(parsed, {
      stage: "SYNTHESIZE",
      route_ref: "dynamic/eliotr-balanced",
      route_version: "route-v3",
      provider: "zai",
      model: "@cf/zai-org/glm-5.3-flash",
    })).toEqual(selection);
    expect(resolveResearchPreparedModelTransportPolicy(undefined, {
      stage: "SYNTHESIZE",
      route_ref: "dynamic/eliotr-balanced",
      route_version: "route-v3",
      provider: "zai",
      model: "@cf/zai-org/glm-5.3-flash",
    })).toBeUndefined();
  });

  it.each([
    ["stage", { stage: "AUDIT_CLAIMS" as const }],
    ["route", { route_ref: "dynamic/other" }],
    ["route revision", { route_version: "route-v4" }],
    ["provider", { provider: "another-provider" }],
    ["model", { model: "another-model" }],
  ])("fails closed when the exact prepared %s differs", (_label, change) => {
    const parsed = parseResearchPreparedModelTransportPolicies(envelope());
    expect(() => resolveResearchPreparedModelTransportPolicy(parsed, {
      stage: "SYNTHESIZE",
      route_ref: "dynamic/eliotr-balanced",
      route_version: "route-v3",
      provider: "zai",
      model: "@cf/zai-org/glm-5.3-flash",
      ...change,
    })).toThrowError(ResearchPreparedModelTransportError);
  });

  it("requires a stage row whenever the operator-defined envelope is present", () => {
    const parsed = parseResearchPreparedModelTransportPolicies(envelope());
    expect(() => resolveResearchPreparedModelTransportPolicy(parsed, {
      stage: "AUDIT_CLAIMS",
      route_ref: "dynamic/eliotr-audit-verifier",
      route_version: "route-v3",
      provider: "zai",
      model: "@cf/zai-org/glm-5.3-flash",
    })).toThrow("missing for AUDIT_CLAIMS");
  });
});

describe("bindResearchPreparedModelTransportPolicy", () => {
  it("binds unified transport and refuses BYOK without the direct gateway credential route", () => {
    const unified = parseResearchPreparedModelTransportPolicies(envelope())?.model_selections[0];
    expect(bindResearchPreparedModelTransportPolicy(httpGateway(), unified).transport_policy)
      .toEqual(unifiedPolicy);

    const byok: ResearchPreparedModelTransportSelectionV1 = {
      ...selection,
      transport_policy: {
        ...unifiedPolicy,
        billing: { mode: "byok", alias: "operator-provider-key" },
      },
    };
    const bindingGateway = {
      reasoning_gateway_base_url: "https://gateway.example.invalid/account/eliotr-reasoning",
      ai_gateway_binding: {},
    } as unknown as ResearchModelGatewayRuntimeConfig;
    expect(() => bindResearchPreparedModelTransportPolicy(bindingGateway, byok))
      .toThrow("requires the configured HTTP AI Gateway credential route");
    expect(bindResearchPreparedModelTransportPolicy(httpGateway(), byok).transport_policy)
      .toEqual(byok.transport_policy);
  });
});
