import { describe, expect, it } from "vitest";
import type { ModelCallInput } from "./model-gateway-execution-contract.js";
import {
  canonicalModelGatewayJson,
  modelGatewayDynamicRouteTarget,
  modelGatewayRequestParametersSha256,
  modelGatewaySha256,
  validateModelGatewayTransportPolicy,
  type ModelGatewayRequestCapabilitiesV1,
  type ModelGatewayTransportPolicyV1,
} from "./model-gateway-request.js";
import {
  prepareModelGatewayBindingRequest,
  prepareModelGatewayHttpRequest,
} from "./model-gateway-http-request.js";
import {
  decodeModelGatewayProviderBody,
  decodeModelGatewayProviderNativeResponse,
} from "./model-gateway-provider-native-response.js";
import { decodeSelectedModelGatewayResponse } from "./model-gateway-response.js";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";

const ACCOUNT_ID = "a".repeat(32);
const BASE_URL = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/eliotr-reasoning`;
const CAPABILITIES: ModelGatewayRequestCapabilitiesV1 = {
  max_output_tokens_field: "max_completion_tokens",
  reasoning_efforts: ["low", "max"],
};
const LEGACY_POLICY: ModelGatewayTransportPolicyV1 = {
  version: 1,
  transport: "cloudflare-ai-gateway",
  api: "compat-chat-completions",
  provider: "workers-ai",
  model: "@cf/zai-org/glm-5.3-flash",
  billing: { mode: "unified" },
  capabilities: CAPABILITIES,
};
const OPENAI_CHAT_POLICY: ModelGatewayTransportPolicyV1 = {
  version: 1,
  transport: "cloudflare-ai-gateway",
  api: "openai-chat-completions",
  provider: "openai",
  model: "openai/gpt-4.1-mini",
  billing: { mode: "byok", alias: "research-key" },
  capabilities: CAPABILITIES,
};
const OPENAI_RESPONSES_POLICY: ModelGatewayTransportPolicyV1 = {
  version: 1,
  transport: "cloudflare-ai-gateway",
  api: "openai-responses",
  provider: "openai",
  model: "openai/gpt-4.1-mini",
  billing: { mode: "byok", alias: "default" },
  capabilities: { max_output_tokens_field: "max_output_tokens", reasoning_efforts: ["low", "max"] },
};
const ANTHROPIC_POLICY: ModelGatewayTransportPolicyV1 = {
  version: 1,
  transport: "cloudflare-ai-gateway",
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  billing: { mode: "byok", alias: "default" },
  capabilities: { max_output_tokens_field: "max_tokens", reasoning_efforts: ["low", "max"] },
};
const OPENROUTER_POLICY: ModelGatewayTransportPolicyV1 = {
  version: 1,
  transport: "cloudflare-ai-gateway",
  api: "openrouter-chat-completions",
  provider: "openrouter",
  model: "stealth/space-bunny-alpha",
  billing: { mode: "byok", alias: "openrouter-test-key" },
  capabilities: {
    max_output_tokens_field: "max_tokens",
    reasoning_efforts: ["low", "max"],
    response_format_normalization: "json-schema-to-json-object",
  },
};
const JSON_SCHEMA_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "research_report",
    strict: true,
    schema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
  },
} as const;

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

async function fixture(
  policy: ModelGatewayTransportPolicyV1 = LEGACY_POLICY,
  responseFormat?: unknown,
) {
  const deploymentBase: Omit<ModelRouteDeployment, "parameters_digest"> = {
    route_ref: "dynamic/eliotr-balanced",
    route_version: "route-1",
    prompt_generation: input.prompt_generation,
    schema_generation: input.schema_generation,
    pricing_snapshot_ref: "pricing-1",
  };
  const parameters = {
    max_tokens: 32,
    reasoning_effort: "max",
    ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
    stream: false,
  };
  const deployment: ModelRouteDeployment = {
    ...deploymentBase,
    parameters_digest: await modelGatewayRequestParametersSha256(parameters, policy.capabilities, policy.api),
  };
  const target = await modelGatewayDynamicRouteTarget(deployment);
  const requestBody = {
    model: target.model,
    messages: [
      { role: "system", content: "trusted instruction" },
      { role: "user", content: "controlled fixture" },
    ],
    max_tokens: 32,
    reasoning_effort: "max",
    ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
    stream: false,
  };
  const compiled = {
    request_body: requestBody,
    request_body_sha256: await modelGatewaySha256(canonicalModelGatewayJson(requestBody)),
    request_timeout_ms: 5000,
  };
  return { deployment, compiled };
}

describe("model gateway transport policy", () => {
  it("preserves legacy max_tokens while rejecting an unselected API token key", async () => {
    await expect(modelGatewayRequestParametersSha256({
      max_tokens: 32,
      stream: false,
    })).resolves.toMatch(/^[a-f0-9]{64}$/u);
    await expect(modelGatewayRequestParametersSha256({
      max_completion_tokens: 32,
      stream: false,
    })).rejects.toMatchObject({ code: "MODEL_GATEWAY_REQUEST_INVALID" });
  });

  it("projects OpenAI Chat requests and pins a named BYOK alias without wholesale billing", async () => {
    const { deployment, compiled } = await fixture(OPENAI_CHAT_POLICY);
    const request = await prepareModelGatewayHttpRequest(
      input,
      deployment,
      compiled,
      BASE_URL,
      "gateway-secret",
      OPENAI_CHAT_POLICY,
    );
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body.max_completion_tokens).toBe(32);
    expect(body).not.toHaveProperty("max_tokens");
    expect(request.parameters_sha256).toBe(deployment.parameters_digest);
    expect(request.headers["cf-aig-byok-alias"]).toBe("research-key");
    expect(request.headers["cf-aig-no-wholesale"]).toBe("true");
    expect(request.headers["cf-aig-authorization"]).toBe("Bearer gateway-secret");
    expect(request.headers).not.toHaveProperty("authorization");
    expect(request.url).toBe(`${BASE_URL}/openai/chat/completions`);
  });

  it("normalizes selected OpenRouter JSON schema before both parameter hashing and dispatch", async () => {
    const { deployment, compiled } = await fixture(OPENROUTER_POLICY, JSON_SCHEMA_FORMAT);
    const request = await prepareModelGatewayHttpRequest(
      input,
      deployment,
      compiled,
      BASE_URL,
      "gateway-secret",
      OPENROUTER_POLICY,
    );
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(request.url).toBe(`${BASE_URL}/openrouter/chat/completions`);
    expect(body).toMatchObject({
      model: "stealth/space-bunny-alpha",
      response_format: { type: "json_object" },
    });
    expect(body).not.toHaveProperty("response_format.json_schema");
    expect(request.parameters_sha256).toBe(deployment.parameters_digest);
    expect(request.headers["cf-aig-byok-alias"]).toBe("openrouter-test-key");
    expect(request.headers["cf-aig-no-wholesale"]).toBe("true");
    expect(request.headers).not.toHaveProperty("authorization");
  });

  it("applies the same explicit JSON-object capability to OpenAI Chat", async () => {
    const policy: ModelGatewayTransportPolicyV1 = {
      ...OPENAI_CHAT_POLICY,
      capabilities: {
        ...OPENAI_CHAT_POLICY.capabilities,
        response_format_normalization: "json-schema-to-json-object",
      },
    };
    const { deployment, compiled } = await fixture(policy, JSON_SCHEMA_FORMAT);
    const request = await prepareModelGatewayHttpRequest(
      input,
      deployment,
      compiled,
      BASE_URL,
      "gateway-secret",
      policy,
    );
    expect(JSON.parse(request.body)).toMatchObject({ response_format: { type: "json_object" } });
    expect(request.parameters_sha256).toBe(deployment.parameters_digest);
  });

  it("decodes selected compatibility responses as strict ChatCompletion", async () => {
    const { deployment } = await fixture();
    const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: {
      "content-type": "application/json", "cf-aig-provider": "workers-ai",
      "cf-aig-model": LEGACY_POLICY.model, "cf-aig-log-id": "compat-log-1",
    } });
    const body = { id: "compat-1", object: "chat.completion", created: 1, model: LEGACY_POLICY.model,
      service_tier: "default", choices: [{ index: 0, finish_reason: "stop", message: {
        role: "assistant", content: "{\"answer\":\"ok\"}", reasoning_content: "private reasoning",
      } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, neurons: 0.25 } };
    for (const policy of [undefined, LEGACY_POLICY]) {
      const decoded = await decodeSelectedModelGatewayResponse(response(body), deployment, 4096, policy);
      expect(decoded.assistant_content).toBe("{\"answer\":\"ok\"}");
      expect(decoded.fingerprint).toMatchObject({ provider: "workers-ai", exact_model_id: LEGACY_POLICY.model });
      expect(decoded.log_id).toBe("compat-log-1");
      expect(decoded.usage).toEqual({ input_tokens: 2, output_tokens: 3, total_tokens: 5 });
    }
    const costBody = { ...body, service_tier: undefined, usage: { ...body.usage, neurons: undefined, cost: 0, is_byok: true,
      cost_details: { upstream_inference_prompt_cost: 0, upstream_inference_completions_cost: 0,
        upstream_inference_cost: 0, server_tool_cost: 0 }, server_tool_use: { web_search_requests: 0 } } };
    await expect(decodeSelectedModelGatewayResponse(response(costBody), deployment, 4096))
      .rejects.toMatchObject({ code: "MODEL_GATEWAY_RESPONSE_INVALID" });
    const choice = body.choices[0];
    if (choice === undefined) throw new Error("compatibility fixture must contain one choice");
    const toolBody = { ...body, choices: [{ ...choice, message: { ...choice.message, tool_calls: [] } }] };
    await expect(decodeSelectedModelGatewayResponse(response(toolBody), deployment, 4096, LEGACY_POLICY))
      .rejects.toMatchObject({ code: "MODEL_GATEWAY_RESPONSE_INVALID" });
  });

  it("decodes OpenRouter Chat output with its response-scoped provider, model, usage, and log id", async () => {
    const { deployment } = await fixture(OPENROUTER_POLICY);
    const body = JSON.stringify({
      id: "openrouter-response-1",
      object: "chat.completion",
      created: 1,
      model: OPENROUTER_POLICY.model,
      choices: [{ index: 0, finish_reason: "stop", native_finish_reason: "stop",
        message: { role: "assistant", content: "{\"answer\":\"ok\"}", reasoning: "private reasoning",
          reasoning_details: [{ type: "reasoning.text", text: "not answer text" }] } }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5,
        prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 1 },
        cost: 0, is_byok: true, cost_details: { upstream_inference_prompt_cost: 0,
          upstream_inference_completions_cost: 0, upstream_inference_cost: 0, server_tool_cost: 0 },
        server_tool_use: { web_search_requests: 0 } },
    });
    const response = new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cf-aig-provider": "openrouter",
        "cf-aig-model": OPENROUTER_POLICY.model,
        "cf-aig-log-id": "openrouter-log-1",
      },
    });
    const decoded = await decodeSelectedModelGatewayResponse(
      response,
      deployment,
      4096,
      OPENROUTER_POLICY,
    );
    expect(decoded.assistant_content).toBe("{\"answer\":\"ok\"}");
    expect(decoded.assistant_content).not.toContain("private reasoning");
    expect(decoded.fingerprint).toMatchObject({ provider: "openrouter", exact_model_id: OPENROUTER_POLICY.model });
    expect(decoded.log_id).toBe("openrouter-log-1");
    expect(decoded.usage).toEqual({ input_tokens: 2, output_tokens: 3, total_tokens: 5 });
    expect(new TextDecoder().decode(decoded.body_bytes)).toBe(body);
    const stored = await decodeModelGatewayProviderBody(new TextEncoder().encode(body));
    expect(stored.assistant_content).toBe(decoded.assistant_content);
    expect(new TextDecoder().decode(stored.body_bytes)).toBe(body);

    const refusal = new Response(JSON.stringify({
      id: "openrouter-response-refusal",
      object: "chat.completion",
      created: 1,
      model: OPENROUTER_POLICY.model,
      choices: [{ index: 0, finish_reason: "stop", native_finish_reason: "stop",
        message: { role: "assistant", refusal: "blocked", content: null } }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cf-aig-provider": "openrouter",
        "cf-aig-model": OPENROUTER_POLICY.model,
        "cf-aig-log-id": "openrouter-log-refusal",
      },
    });
    await expect(decodeModelGatewayProviderNativeResponse(
      refusal,
      deployment,
      4096,
      OPENROUTER_POLICY,
    )).rejects.toMatchObject({ code: "MODEL_GATEWAY_POLICY_REJECTED" });
  });

  it("accepts native output without optional provider/model headers while enforcing the body model and log id", async () => {
    const { deployment } = await fixture(OPENROUTER_POLICY);
    const response = new Response(JSON.stringify({
      id: "openrouter-response-no-identity-headers",
      object: "chat.completion",
      created: 1,
      model: OPENROUTER_POLICY.model,
      choices: [{ index: 0, finish_reason: "stop", native_finish_reason: "stop",
        message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cf-aig-log-id": "openrouter-log-no-identity-headers",
      },
    });
    const decoded = await decodeModelGatewayProviderNativeResponse(
      response,
      deployment,
      4096,
      OPENROUTER_POLICY,
    );
    expect(decoded.assistant_content).toBe("ok");
    expect(decoded.log_id).toBe("openrouter-log-no-identity-headers");
    expect(decoded.fingerprint).toMatchObject({ provider: "openrouter", exact_model_id: OPENROUTER_POLICY.model });
  });

  it("rejects an optional provider header when it contradicts the selected provider", async () => {
    const { deployment } = await fixture(OPENROUTER_POLICY);
    const response = new Response(JSON.stringify({
      id: "openrouter-response-provider-mismatch",
      object: "chat.completion",
      created: 1,
      model: OPENROUTER_POLICY.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cf-aig-provider": "different-provider",
        "cf-aig-log-id": "openrouter-log-provider-mismatch",
      },
    });
    await expect(decodeModelGatewayProviderNativeResponse(
      response,
      deployment,
      4096,
      OPENROUTER_POLICY,
    )).rejects.toMatchObject({ code: "MODEL_GATEWAY_RESPONSE_INVALID" });
  });

  it("rejects unrequested OpenRouter tool use before it can be priced as ordinary tokens", async () => {
    const { deployment } = await fixture(OPENROUTER_POLICY);
    const response = new Response(JSON.stringify({
      id: "openrouter-response-tool-use",
      object: "chat.completion",
      created: 1,
      model: OPENROUTER_POLICY.model,
      choices: [{ index: 0, finish_reason: "stop", native_finish_reason: "stop",
        message: { role: "assistant", content: "no tool requested" } }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5,
        server_tool_use: { web_search_requests: 1 } },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cf-aig-provider": "openrouter",
        "cf-aig-model": OPENROUTER_POLICY.model,
        "cf-aig-log-id": "openrouter-log-tool-use",
      },
    });
    await expect(decodeModelGatewayProviderNativeResponse(
      response,
      deployment,
      4096,
      OPENROUTER_POLICY,
    )).rejects.toMatchObject({ code: "MODEL_GATEWAY_RESPONSE_INVALID" });
  });

  it("accepts the documented minimal OpenRouter response without optional native_finish_reason", async () => {
    const { deployment } = await fixture(OPENROUTER_POLICY);
    const body = JSON.stringify({
      id: "openrouter-minimal-response",
      object: "chat.completion",
      created: 1,
      model: OPENROUTER_POLICY.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    });
    const response = new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cf-aig-provider": "openrouter",
        "cf-aig-model": OPENROUTER_POLICY.model,
        "cf-aig-log-id": "openrouter-minimal-log",
      },
    });
    const live = await decodeModelGatewayProviderNativeResponse(response, deployment, 4096, OPENROUTER_POLICY);
    const stored = await decodeModelGatewayProviderBody(
      new TextEncoder().encode(body),
      "openrouter-chat-completions",
    );
    expect(live.assistant_content).toBe("ok");
    expect(stored.assistant_content).toBe("ok");
    expect(new TextDecoder().decode(stored.body_bytes)).toBe(body);
  });

  it("preserves schema bytes when the optional normalizer is omitted and rejects it on schema-only APIs", async () => {
    const noNormalization: ModelGatewayTransportPolicyV1 = {
      ...OPENROUTER_POLICY,
      capabilities: {
        max_output_tokens_field: "max_tokens",
        reasoning_efforts: ["low", "max"],
      },
    };
    const { deployment, compiled } = await fixture(noNormalization, JSON_SCHEMA_FORMAT);
    const request = await prepareModelGatewayHttpRequest(
      input,
      deployment,
      compiled,
      BASE_URL,
      "gateway-secret",
      noNormalization,
    );
    expect(JSON.parse(request.body)).toMatchObject({ response_format: JSON_SCHEMA_FORMAT });
    await expect(modelGatewayRequestParametersSha256({
      max_tokens: 32,
      response_format: { type: "text" },
      stream: false,
    }, OPENROUTER_POLICY.capabilities, OPENROUTER_POLICY.api)).rejects.toMatchObject({
      code: "MODEL_GATEWAY_REQUEST_INVALID",
    });

    for (const policy of [
      { ...ANTHROPIC_POLICY, capabilities: { ...ANTHROPIC_POLICY.capabilities,
        response_format_normalization: "json-schema-to-json-object" as const } },
      { ...OPENAI_RESPONSES_POLICY, capabilities: { ...OPENAI_RESPONSES_POLICY.capabilities,
        response_format_normalization: "json-schema-to-json-object" as const } },
      { ...LEGACY_POLICY, capabilities: { ...LEGACY_POLICY.capabilities,
        response_format_normalization: "json-schema-to-json-object" as const } },
    ]) {
      expect(() => validateModelGatewayTransportPolicy(policy))
        .toThrow("JSON schema response format normalization requires a documented JSON-object-capable Chat API");
    }
    expect(() => validateModelGatewayTransportPolicy({
      ...OPENROUTER_POLICY,
      capabilities: { ...OPENROUTER_POLICY.capabilities, response_format_normalization: null },
    })).toThrow("response format normalization is unsupported");
  });

  it("maps OpenAI Responses parameters and omits the default alias while still forbidding fallback", async () => {
    const { deployment, compiled } = await fixture(OPENAI_RESPONSES_POLICY);
    const request = await prepareModelGatewayHttpRequest(
      input,
      deployment,
      compiled,
      BASE_URL,
      "gateway-secret",
      OPENAI_RESPONSES_POLICY,
    );
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(request.url).toBe(`${BASE_URL}/openai/responses`);
    expect(body).toMatchObject({
      model: OPENAI_RESPONSES_POLICY.model,
      max_output_tokens: 32,
      reasoning: { effort: "max" },
      stream: false,
      store: false,
    });
    expect(body).toHaveProperty("input");
    expect(body).not.toHaveProperty("messages");
    expect(request.parameters_sha256).toBe(deployment.parameters_digest);
    expect(request.headers).not.toHaveProperty("cf-aig-byok-alias");
    expect(request.headers["cf-aig-no-wholesale"]).toBe("true");
  });

  it("maps Anthropic Messages, forwards effort without assuming adaptive thinking, and uses the native version header", async () => {
    const { deployment, compiled } = await fixture(ANTHROPIC_POLICY);
    const request = await prepareModelGatewayHttpRequest(
      input,
      deployment,
      compiled,
      BASE_URL,
      "gateway-secret",
      ANTHROPIC_POLICY,
    );
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(request.url).toBe(`${BASE_URL}/anthropic/v1/messages`);
    expect(body).toMatchObject({
      model: ANTHROPIC_POLICY.model,
      max_tokens: 32,
      output_config: { effort: "max" },
    });
    expect(body).not.toHaveProperty("thinking");
    expect(body.system).toBe("trusted instruction");
    expect(body.messages).toEqual([{ role: "user", content: "controlled fixture" }]);
    expect(request.headers["anthropic-version"]).toBe("2023-06-01");
    expect(request.headers).not.toHaveProperty("cf-aig-byok-alias");
    expect(request.headers["cf-aig-no-wholesale"]).toBe("true");
  });

  it("rejects a reasoning effort outside selected capabilities before provider dispatch", async () => {
    const { deployment, compiled } = await fixture(OPENAI_CHAT_POLICY);
    const policy = {
      ...OPENAI_CHAT_POLICY,
      capabilities: {
        ...CAPABILITIES,
        reasoning_efforts: ["low"] as const,
      },
    };
    await expect(prepareModelGatewayHttpRequest(
      input,
      deployment,
      compiled,
      BASE_URL,
      "gateway-secret",
      policy,
    )).rejects.toMatchObject({ code: "MODEL_GATEWAY_REQUEST_INVALID" });
  });

  it("rejects API/token capability mismatch and ambiguous token fields before transport", async () => {
    const { deployment, compiled } = await fixture(OPENAI_CHAT_POLICY);
    await expect(prepareModelGatewayHttpRequest(
      input,
      deployment,
      compiled,
      BASE_URL,
      "gateway-secret",
      { ...OPENAI_CHAT_POLICY, api: "openai-responses" },
    )).rejects.toMatchObject({ code: "MODEL_GATEWAY_REQUEST_INVALID" });

    const body = {
      ...(compiled.request_body as Record<string, unknown>),
      max_completion_tokens: 32,
    };
    const bothFields = {
      ...compiled,
      request_body: body,
      request_body_sha256: await modelGatewaySha256(canonicalModelGatewayJson(body)),
    };
    await expect(prepareModelGatewayHttpRequest(
      input,
      deployment,
      bothFields,
      BASE_URL,
      "gateway-secret",
      OPENAI_CHAT_POLICY,
    )).rejects.toMatchObject({ code: "MODEL_GATEWAY_REQUEST_INVALID" });
  });

  it("rejects BYOK on the native binding path before invoking it", async () => {
    const { deployment, compiled } = await fixture(OPENAI_CHAT_POLICY);
    await expect(prepareModelGatewayBindingRequest(
      input,
      deployment,
      compiled,
      BASE_URL,
      OPENAI_CHAT_POLICY,
    )).rejects.toMatchObject({ code: "MODEL_GATEWAY_REQUEST_INVALID" });
  });
});
