import { describe, expect, it } from "vitest";
import { modelGatewayRequestParametersSha256, type ModelGatewayTransportPolicyV1 } from "@eliotr/cloudflare-ai";
import { selectResearchOwnerPrompt } from "@eliotr/cloudflare-research-stages";
import { createResearchOwnerRoutePlan } from "@eliotr/cloudflare-research-configuration/research-owner-route-plan.js";

const transportPolicy: ModelGatewayTransportPolicyV1 = Object.freeze({
  version: 1,
  transport: "cloudflare-ai-gateway",
  api: "compat-chat-completions",
  provider: "zai",
  model: "glm-5.3-flash",
  billing: Object.freeze({ mode: "unified" }),
  capabilities: Object.freeze({
    max_output_tokens_field: "max_completion_tokens",
    reasoning_efforts: Object.freeze(["low", "high", "max"] as const),
  }),
});

const routeDefinition = Object.freeze([
  Object.freeze({ id: "primary", provider: "zai", model: "glm-5.3-flash" }),
]);
const jsonObjectOpenRouterPolicy: ModelGatewayTransportPolicyV1 = Object.freeze({
  version: 1,
  transport: "cloudflare-ai-gateway",
  api: "openrouter-chat-completions",
  provider: "openrouter",
  model: "stealth/space-bunny-alpha",
  billing: Object.freeze({ mode: "byok", alias: "openrouter-test-key" }),
  capabilities: Object.freeze({
    max_output_tokens_field: "max_tokens",
    reasoning_efforts: Object.freeze(["low", "max"] as const),
    response_format_normalization: "json-schema-to-json-object" as const,
  }),
});

describe("createResearchOwnerRoutePlan parameters digest", () => {
  it("hashes the selected wire token field and selected reasoning effort", async () => {
    const plan = await createResearchOwnerRoutePlan({
      route_ref: "dynamic/eliotr-balanced",
      route_version: "route-v3",
      pricing_snapshot_ref: "pricing-v3",
      stage: "SYNTHESIZE",
      max_tokens: 72,
      reasoning_effort: "max",
      transport_policy: transportPolicy,
      route_definition: routeDefinition,
    });
    const responseFormat = selectResearchOwnerPrompt("SYNTHESIZE", "json_schema").response_format;
    const expected = await modelGatewayRequestParametersSha256({
      model: "dynamic/eliotr-balanced",
      messages: [],
      max_tokens: 72,
      reasoning_effort: "max",
      ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
      stream: false,
    }, transportPolicy.capabilities);
    const legacyField = await modelGatewayRequestParametersSha256({
      model: "dynamic/eliotr-balanced",
      messages: [],
      max_tokens: 72,
      ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
      stream: false,
    });

    expect(plan.deployment.parameters_digest).toBe(expected);
    expect(plan.deployment.parameters_digest).not.toBe(legacyField);
  });

  it("rejects reasoning values outside the exact selected capability before route compilation", async () => {
    await expect(createResearchOwnerRoutePlan({
      route_ref: "dynamic/eliotr-balanced",
      route_version: "route-v3",
      pricing_snapshot_ref: "pricing-v3",
      stage: "SYNTHESIZE",
      max_tokens: 72,
      reasoning_effort: "high",
      transport_policy: {
        ...transportPolicy,
        capabilities: {
          max_output_tokens_field: "max_completion_tokens",
          reasoning_efforts: ["low"] as const,
        },
      },
      route_definition: routeDefinition,
    })).rejects.toThrow("reasoning_effort is unsupported");
  });

  it("keeps legacy routes on the historical max_tokens parameter projection", async () => {
    const plan = await createResearchOwnerRoutePlan({
      route_ref: "dynamic/eliotr-balanced",
      route_version: "route-v3",
      pricing_snapshot_ref: "pricing-v3",
      stage: "SYNTHESIZE",
      max_tokens: 72,
      route_definition: routeDefinition,
    });
    const responseFormat = selectResearchOwnerPrompt("SYNTHESIZE", "json_schema").response_format;
    const expected = await modelGatewayRequestParametersSha256({
      model: "dynamic/eliotr-balanced",
      messages: [],
      max_tokens: 72,
      ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
      stream: false,
    });

    expect(plan.deployment.parameters_digest).toBe(expected);
  });

  it("hashes the selected JSON-object response format before planning the OpenRouter route", async () => {
    const plan = await createResearchOwnerRoutePlan({
      route_ref: "dynamic/eliotr-balanced",
      route_version: "route-v4",
      pricing_snapshot_ref: "pricing-v4",
      stage: "SYNTHESIZE",
      max_tokens: 72,
      reasoning_effort: "max",
      transport_policy: jsonObjectOpenRouterPolicy,
      route_definition: [{ id: "primary", provider: "openrouter", model: "stealth/space-bunny-alpha" }],
    });
    const responseFormat = selectResearchOwnerPrompt("SYNTHESIZE", "json_schema").response_format;
    const parameters = {
      model: "dynamic/eliotr-balanced",
      messages: [],
      max_completion_tokens: 72,
      reasoning_effort: "max",
      ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
      stream: false,
    };
    const expected = await modelGatewayRequestParametersSha256(
      parameters,
      jsonObjectOpenRouterPolicy.capabilities,
      jsonObjectOpenRouterPolicy.api,
    );
    const schemaPreserving = await modelGatewayRequestParametersSha256(
      parameters,
      {
        max_output_tokens_field: "max_tokens",
        reasoning_efforts: ["low", "max"],
      },
      jsonObjectOpenRouterPolicy.api,
    );

    expect(plan.deployment.parameters_digest).toBe(expected);
    expect(plan.deployment.parameters_digest).not.toBe(schemaPreserving);
  });
});
