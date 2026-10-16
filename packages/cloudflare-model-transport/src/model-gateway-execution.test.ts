import { describe, expect, it } from "vitest";
import type { ModelCallInput, ModelGatewayExecutionDependencies } from "./model-gateway-execution-contract.js";
import {
  canonicalModelGatewayJson,
  modelGatewayDynamicRouteTarget,
  modelGatewayRequestParametersSha256,
  modelGatewaySha256,
  type ModelGatewayTransportPolicyV1,
} from "./model-gateway-request.js";
import { executeObservedModelGatewayCall, isModelGatewayPromptCompileFailure } from "./model-gateway-execution.js";
import { ModelGatewayExecutionError } from "./model-gateway-execution-contract.js";
import { decodeModelGatewayOpenRouterBody } from "./model-gateway-openrouter-response.js";
import { decodeDynamicRouteFingerprint } from "@eliotr/platform-cloudflare";

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
  it("keeps model and provider identity grammars separate at response and fingerprint boundaries", () => {
    const model = "~openai/gpt-astra-latest";
    const body = { id: "completion-1", object: "chat.completion", created: 1, model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "answer" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    expect(decodeModelGatewayOpenRouterBody(body, bytes).response_model).toBe(model);
    expect(() => decodeModelGatewayOpenRouterBody({ ...body, id: "~completion" }, bytes)).toThrow();
    const deployment = { route_ref: "dynamic/eliotr-balanced", route_version: "v1", prompt_generation: "p1",
      schema_generation: "s1", parameters_digest: "a".repeat(64), pricing_snapshot_ref: "price-1" };
    expect(decodeDynamicRouteFingerprint({ "cf-aig-provider": "openrouter", "cf-aig-model": model }, deployment).exact_model_id).toBe(model);
    expect(() => decodeDynamicRouteFingerprint({ "cf-aig-provider": "~openrouter", "cf-aig-model": model }, deployment)).toThrow();
  });
  it("binds compiler non-dispatch proof to the exact call and discards it at transport", async () => {
    const parameters = { max_tokens: 32, stream: false };
    const deployment = { route_ref: "dynamic/eliotr-balanced" as const, route_version: "route-1",
      prompt_generation: input.prompt_generation, schema_generation: input.schema_generation,
      parameters_digest: await modelGatewayRequestParametersSha256(parameters), pricing_snapshot_ref: "pricing-1" };
    let providerCalls = 0;
    const dependencies: ModelGatewayExecutionDependencies = {
      reasoning_gateway_base_url: BASE_URL,
      deployments: { resolve: async () => deployment },
      prompts: { compile: async () => { throw new Error("REQUIRED_CONTEXT_BYTE_BUDGET_EXCEEDED"); } },
      binding_transport: { fetch: async () => { providerCalls += 1; throw new Error("unknown remote outcome"); } },
      outputs: { putImmutable: async () => ({}) },
      fingerprints: { putImmutable: async () => ({}), getLatest: async () => null },
      pricing: { quote: async () => ({}) },
    };
    const failure: unknown = await executeObservedModelGatewayCall(dependencies, input).catch((cause: unknown) => cause);
    expect(isModelGatewayPromptCompileFailure(failure, input)).toBe(true);
    expect(isModelGatewayPromptCompileFailure(failure, { ...input })).toBe(false);
    expect(isModelGatewayPromptCompileFailure(new ModelGatewayExecutionError(
      "MODEL_GATEWAY_PROMPT_COMPILE_FAILED", "code without provenance"), input)).toBe(false);
    expect(providerCalls).toBe(0);

    const target = await modelGatewayDynamicRouteTarget(deployment);
    const body = { model: target.model, messages: [{ role: "system", content: "trusted instruction" },
      { role: "user", content: "controlled input" }], ...parameters };
    const remote: ModelGatewayExecutionDependencies = { ...dependencies,
      prompts: { compile: async () => ({ request_body: body,
        request_body_sha256: await modelGatewaySha256(canonicalModelGatewayJson(body)), request_timeout_ms: 5000 }) },
      binding_transport: { fetch: async () => { providerCalls += 1; throw failure; } },
    };
    const transported: unknown = await executeObservedModelGatewayCall(remote, input).catch((cause: unknown) => cause);
    expect(transported).toMatchObject({ code: "MODEL_GATEWAY_TRANSPORT_FAILED" });
    expect(isModelGatewayPromptCompileFailure(transported, input)).toBe(false);
    expect(providerCalls).toBe(1);
  });

  it.each(["expected/model-1", "~openai/gpt-astra-latest"])("rejects response aliases for %s before output, fingerprint or pricing writes", async expectedModel => {
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
      model: expectedModel,
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
            "cf-aig-provider": "expected-provider",
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
