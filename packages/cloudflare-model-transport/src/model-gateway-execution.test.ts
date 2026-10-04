import { describe, expect, it } from "vitest";
import type { ModelCallInput, ModelGatewayExecutionDependencies } from "./model-gateway-execution-contract.js";
import {
  canonicalModelGatewayJson,
  modelGatewayDynamicRouteTarget,
  modelGatewayRequestParametersSha256,
  modelGatewaySha256,
  type ModelGatewayTransportPolicyV1,
} from "./model-gateway-request.js";
import { executeObservedModelGatewayCall } from "./model-gateway-execution.js";

const BASE_URL = `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/eliotr-reasoning`;
const input: ModelCallInput = {
  route_ref: "dynamic/eliotr-balanced",
  prompt_generation: "prompt-1",
  schema_generation: "schema-1",
  evidence_pack: {
    pack_ref: { id: "pack-1", revision: 1 },
    scope_snapshot_ref: { id: "scope-1", revision: 1 },
    resolved_evidence: [],
    omitted_candidates: [],
    trace_ref: { id: "trace-1", revision: 1 },
    total_utf8_bytes: 0,
  },
  output_object_ref: "output-1",
  max_input_bytes: 16_384,
  max_output_bytes: 4096,
  budget_reservation_ref: "budget-1",
};

describe("model gateway selected identity", () => {
  it("rejects provider/model fallback before immutable output, fingerprint, or pricing writes", async () => {
    const parameters = { max_tokens: 32, stream: false };
    const deployment = {
      route_ref: "dynamic/eliotr-balanced",
      route_version: "route-1",
      prompt_generation: input.prompt_generation,
      schema_generation: input.schema_generation,
      parameters_digest: await modelGatewayRequestParametersSha256(parameters),
      pricing_snapshot_ref: "pricing-1",
    } as const;
    const target = await modelGatewayDynamicRouteTarget(deployment);
    const body = {
      model: target.model,
      messages: [
        { role: "system", content: "trusted instruction" },
        { role: "user", content: "controlled evidence" },
      ],
      ...parameters,
    };
    const compiled = {
      request_body: body,
      request_body_sha256: await modelGatewaySha256(canonicalModelGatewayJson(body)),
      request_timeout_ms: 5000,
    };
    const transportPolicy: ModelGatewayTransportPolicyV1 = {
      version: 1,
      transport: "cloudflare-ai-gateway",
      api: "compat-chat-completions",
      provider: "expected-provider",
      model: "expected/model-1",
      billing: { mode: "unified" },
      capabilities: { max_output_tokens_field: "max_tokens", reasoning_efforts: [] },
    };
    let outputWrites = 0;
    let fingerprintWrites = 0;
    let pricingCalls = 0;
    const dependencies: ModelGatewayExecutionDependencies = {
      reasoning_gateway_base_url: BASE_URL,
      transport_policy: transportPolicy,
      credentials: { readGatewayToken: async () => "gateway-token" },
      transport: {
        fetch: async () => new Response(JSON.stringify({
          id: "completion-1",
          object: "chat.completion",
          created: 1,
          model: "fallback/model-2",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "answer" } }],
          usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cf-aig-provider": "fallback-provider",
            "cf-aig-model": "fallback/model-2",
            "cf-aig-log-id": "log-1",
          },
        }),
      },
      deployments: { resolve: async () => deployment },
      prompts: { compile: async () => compiled },
      outputs: { putImmutable: async () => { outputWrites += 1; return {}; } },
      fingerprints: {
        putImmutable: async () => { fingerprintWrites += 1; return {}; },
        getLatest: async () => null,
      },
      pricing: { quote: async () => { pricingCalls += 1; return {}; } },
    };

    await expect(executeObservedModelGatewayCall(dependencies, input)).rejects.toMatchObject({
      code: "MODEL_GATEWAY_RESPONSE_INVALID",
    });
    expect(outputWrites).toBe(0);
    expect(fingerprintWrites).toBe(0);
    expect(pricingCalls).toBe(0);
  });
});
