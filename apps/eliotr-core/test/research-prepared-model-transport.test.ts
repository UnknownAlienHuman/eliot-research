import { describe, expect, it } from "vitest";
import {
  canonicalModelGatewayJson,
  type ModelGatewayTransportPolicyV1,
} from "@eliotr/cloudflare-ai";
import type { ResearchModelGatewayRuntimeConfig } from "@eliotr/cloudflare-research";
import {
  bindConfiguredServiceModelProviderAlias,
  bindResearchPreparedModelTransportPolicy,
  parseResearchPreparedModelTransportPolicies,
  RESEARCH_PREPARED_MODEL_TRANSPORT_PROTOCOL,
  ResearchPreparedModelTransportError,
  resolveResearchPreparedModelTransportPolicy,
  type ResearchPreparedModelTransportSelectionV1,
} from "../src/research-prepared-model-transport.js";
import type { ConfiguredServiceModelProviderBinding } from "@eliotr/cloudflare-model-control/service-model-provider-service.js";

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
const responsesPolicy: ModelGatewayTransportPolicyV1 = Object.freeze({
  version: 1,
  transport: "cloudflare-ai-gateway",
  api: "openai-responses",
  provider: "openai",
  model: "openai/gpt-4.1-mini",
  billing: Object.freeze({ mode: "byok", alias: "named-research-key" }),
  capabilities: Object.freeze({
    max_output_tokens_field: "max_output_tokens",
    reasoning_efforts: Object.freeze(["low", "high", "max"] as const),
  }),
});
const responsesSelection: ResearchPreparedModelTransportSelectionV1 = Object.freeze({
  stage: "SYNTHESIZE",
  route_ref: "dynamic/eliotr-balanced",
  route_version: "route-v4",
  provider: responsesPolicy.provider,
  model: responsesPolicy.model,
  transport_policy: responsesPolicy,
});
const anthropicPolicy: ModelGatewayTransportPolicyV1 = Object.freeze({
  version: 1,
  transport: "cloudflare-ai-gateway",
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  billing: Object.freeze({ mode: "byok", alias: "default" }),
  capabilities: Object.freeze({
    max_output_tokens_field: "max_tokens",
    reasoning_efforts: Object.freeze(["low", "medium", "high", "max"] as const),
  }),
});
const anthropicSelection: ResearchPreparedModelTransportSelectionV1 = Object.freeze({
  stage: "AUDIT_CLAIMS",
  route_ref: "dynamic/eliotr-audit-verifier",
  route_version: "route-v2",
  provider: anthropicPolicy.provider,
  model: anthropicPolicy.model,
  transport_policy: anthropicPolicy,
});
const openrouterPolicy: ModelGatewayTransportPolicyV1 = Object.freeze({
  version: 1,
  transport: "cloudflare-ai-gateway",
  api: "openrouter-chat-completions",
  provider: "openrouter",
  model: "stealth/space-bunny-alpha",
  billing: Object.freeze({ mode: "byok", alias: "openrouter-project-key" }),
  capabilities: Object.freeze({
    max_output_tokens_field: "max_tokens",
    reasoning_efforts: Object.freeze(["low", "max"] as const),
    response_format_normalization: "json-schema-to-json-object" as const,
  }),
});
const openrouterSelection: ResearchPreparedModelTransportSelectionV1 = Object.freeze({
  stage: "SYNTHESIZE",
  route_ref: "dynamic/eliotr-balanced",
  route_version: "route-v5",
  provider: openrouterPolicy.provider,
  model: openrouterPolicy.model,
  transport_policy: openrouterPolicy,
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

  it("accepts exact native provider policies for distinct prepared stages", () => {
    const parsed = parseResearchPreparedModelTransportPolicies(envelope([
      responsesSelection,
      anthropicSelection,
    ]));
    expect(parsed?.model_selections.map((row) => [row.stage, row.transport_policy.api])).toEqual([
      ["SYNTHESIZE", "openai-responses"],
      ["AUDIT_CLAIMS", "anthropic-messages"],
    ]);
    expect(parsed?.model_selections[0]?.transport_policy.billing).toEqual({ mode: "byok", alias: "named-research-key" });
  });

  it("preserves the selected OpenRouter response-format normalizer in the exact saved envelope", () => {
    const parsed = parseResearchPreparedModelTransportPolicies(envelope([openrouterSelection]));
    expect(parsed?.model_selections[0]?.transport_policy.api).toBe("openrouter-chat-completions");
    expect(parsed?.model_selections[0]?.transport_policy.capabilities.response_format_normalization)
      .toBe("json-schema-to-json-object");
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

  it("rejects identity conflicts, duplicate or unordered stages, and API/capability mismatches", () => {
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
      { ...responsesSelection, transport_policy: {
        ...responsesPolicy,
        capabilities: { ...responsesPolicy.capabilities, max_output_tokens_field: "max_completion_tokens" },
      } } as unknown as ResearchPreparedModelTransportSelectionV1,
    ]))).toThrow("prepared model transport policy is invalid");
    expect(() => parseResearchPreparedModelTransportPolicies(envelope([
      { ...responsesSelection, transport_policy: { ...responsesPolicy, provider: "anthropic" } } as ResearchPreparedModelTransportSelectionV1,
    ]))).toThrow("prepared model transport policy is invalid");
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

describe("bindConfiguredServiceModelProviderAlias", () => {
  it("binds only the registered exact model and changes only the BYOK alias", () => {
    const registered: ConfiguredServiceModelProviderBinding = Object.freeze({
      owner_id: "owner-1",
      operation_id: "a9f79914-a0a5-4f27-9e81-3b9b6c403a61",
      provider_id: "openrouter",
      provider_slug: "openrouter",
      model_registration_mode: "explicit_allowlist",
      model_ids: Object.freeze([openrouterPolicy.model]),
      alias: "eliotr-" + "a".repeat(48),
      provider_config_id: "provider-config-1",
      metadata_sha256: "b".repeat(64),
      created_at: "2026-10-15T14:00:00.000Z",
    });

    const bound = bindConfiguredServiceModelProviderAlias(openrouterSelection, registered, {
      provider: "openrouter", model: openrouterPolicy.model,
    });

    expect(bound).toMatchObject({
      ...openrouterSelection,
      transport_policy: {
        ...openrouterPolicy,
        billing: { mode: "byok", alias: registered.alias },
      },
    });
    expect(bound?.transport_policy).toEqual({
      ...openrouterPolicy,
      billing: { mode: "byok", alias: registered.alias },
    });
  });

  it("fails before dispatch when the global record does not authorize the exact prepared model", () => {
    const registered: ConfiguredServiceModelProviderBinding = Object.freeze({
      owner_id: "owner-1",
      operation_id: "a9f79914-a0a5-4f27-9e81-3b9b6c403a61",
      provider_id: "openrouter",
      provider_slug: "openrouter",
      model_registration_mode: "explicit_allowlist",
      model_ids: Object.freeze(["another/model:free"]),
      alias: "eliotr-" + "a".repeat(48),
      provider_config_id: "provider-config-1",
      metadata_sha256: "b".repeat(64),
      created_at: "2026-10-15T14:00:00.000Z",
    });

    expect(() => bindConfiguredServiceModelProviderAlias(openrouterSelection, registered, {
      provider: "openrouter", model: openrouterPolicy.model,
    })).toThrowError(ResearchPreparedModelTransportError);
    expect(() => bindConfiguredServiceModelProviderAlias(undefined, registered, {
      provider: "openrouter", model: openrouterPolicy.model,
    })).toThrowError(ResearchPreparedModelTransportError);
  });

  it("binds one exact server-prepared model through a catalog-managed credential without treating the catalog as qualification", () => {
    const catalogBinding: ConfiguredServiceModelProviderBinding = Object.freeze({
      owner_id: "owner-1",
      operation_id: "a9f79914-a0a5-4f27-9e81-3b9b6c403a61",
      provider_id: "openrouter",
      provider_slug: "openrouter",
      model_registration_mode: "catalog_managed",
      model_ids: Object.freeze([]),
      alias: "eliotr-" + "a".repeat(48),
      provider_config_id: "provider-config-1",
      metadata_sha256: "b".repeat(64),
      created_at: "2026-10-15T14:00:00.000Z",
    });

    const bound = bindConfiguredServiceModelProviderAlias(openrouterSelection, catalogBinding, {
      provider: "openrouter", model: openrouterPolicy.model,
    });

    expect(bound?.transport_policy.billing).toEqual({ mode: "byok", alias: catalogBinding.alias });
    expect(() => bindConfiguredServiceModelProviderAlias(openrouterSelection, catalogBinding, {
      provider: "openrouter", model: "another/model:free",
    })).toThrowError(ResearchPreparedModelTransportError);
  });
});

describe("bindResearchPreparedModelTransportPolicy", () => {
  it("binds unified transport and refuses BYOK without the direct gateway credential route", () => {
    const unified = parseResearchPreparedModelTransportPolicies(envelope())?.model_selections[0];
    expect(bindResearchPreparedModelTransportPolicy(httpGateway(), unified).transport_policy)
      .toEqual(unifiedPolicy);

    const byok: ResearchPreparedModelTransportSelectionV1 = {
      ...responsesSelection,
      transport_policy: {
        ...responsesPolicy,
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
