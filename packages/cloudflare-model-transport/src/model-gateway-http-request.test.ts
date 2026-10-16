import { describe, expect, it } from "vitest";
import type { ModelCallInput } from "./model-gateway-execution-contract.js";
import { ModelGatewayExecutionError } from "./model-gateway-execution-contract.js";
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
import { readBoundedBody } from "./model-gateway-response.js";
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

  it("accepts current OpenRouter SDK nullable usage fields without weakening identity or billing guards", async () => {
    const body = {
      id: "openrouter-sdk-nullable-usage",
      object: "chat.completion",
      created: 1,
      model: OPENROUTER_POLICY.model,
      service_tier: null,
      system_fingerprint: null,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
      usage: {
        prompt_tokens: 34,
        completion_tokens: 74,
        total_tokens: 108,
        prompt_tokens_details: null,
        completion_tokens_details: {
          accepted_prediction_tokens: null,
          audio_tokens: null,
          image_tokens: 0,
          reasoning_tokens: null,
          rejected_prediction_tokens: null,
        },
        cost: null,
        cost_details: null,
        is_byok: true,
        server_tool_use_details: {
          tool_calls_executed: null,
          tool_calls_requested: 0,
          web_search_requests: null,
        },
      },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const stored = await decodeModelGatewayProviderBody(bytes, "openrouter-chat-completions");
    expect(stored.assistant_content).toBe("ok");
    expect(stored.response_model).toBe(OPENROUTER_POLICY.model);
    expect(stored.usage).toEqual({ input_tokens: 34, output_tokens: 74, total_tokens: 108 });

    await expect(decodeModelGatewayProviderBody(new TextEncoder().encode(JSON.stringify({
      ...body, usage: { ...body.usage, total_tokens: 107 },
    })), "openrouter-chat-completions")).rejects.toMatchObject({ code: "MODEL_GATEWAY_RESPONSE_INVALID" });
    await expect(decodeModelGatewayProviderBody(new TextEncoder().encode(JSON.stringify({
      ...body, usage: { ...body.usage, server_tool_use_details: { web_search_requests: 1 } },
    })), "openrouter-chat-completions")).rejects.toMatchObject({ code: "MODEL_GATEWAY_RESPONSE_INVALID" });
    await expect(decodeModelGatewayProviderBody(new TextEncoder().encode(JSON.stringify({
      ...body, usage: { ...body.usage, cost_details: {
        upstream_inference_prompt_cost: 0,
        upstream_inference_completions_cost: 0,
        server_tool_cost: 0.01,
      } },
    })), "openrouter-chat-completions")).rejects.toMatchObject({ code: "MODEL_GATEWAY_RESPONSE_INVALID" });
    await expect(decodeModelGatewayProviderBody(new TextEncoder().encode(JSON.stringify({
      ...body, provider: "unverified-provider-field",
    })), "openrouter-chat-completions")).rejects.toMatchObject({ code: "MODEL_GATEWAY_RESPONSE_INVALID" });
    const { deployment } = await fixture(OPENROUTER_POLICY);
    const wrongModel = new Response(JSON.stringify({ ...body, model: "another/model" }), {
      status: 200,
      headers: { "content-type": "application/json", "cf-aig-log-id": "openrouter-wrong-model" },
    });
    await expect(decodeModelGatewayProviderNativeResponse(
      wrongModel, deployment, 4096, OPENROUTER_POLICY,
    )).rejects.toMatchObject({ code: "MODEL_GATEWAY_RESPONSE_INVALID" });
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

describe("model gateway bounded body reader", () => {
  const FINGERPRINT_HEADERS = {
    "cf-aig-provider": "workers-ai",
    "cf-aig-model": LEGACY_POLICY.model,
    "cf-aig-log-id": "bounded-body-log",
  };

  // A producer that mutates and reuses one 1-byte chunk buffer. The shared
  // reader must snapshot each chunk, so two offered letters arrive as AB.
  // The former private loop pushed the producer's live buffer and produced BB.
  function reusingProducer(letters: number): ReadableStream<Uint8Array> {
    const shared = new Uint8Array(1);
    let emitted = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= letters) {
          controller.close();
          return;
        }
        shared[0] = 0x41 + emitted;
        controller.enqueue(shared);
        emitted += 1;
      },
    });
  }

  // A cancellation that never settles, proving the bounded failure is not held
  // open by, or relabelled by, its own cleanup.
  function pendingCancelStream(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
      },
      pull() {},
      cancel() {
        return new Promise<void>(() => {});
      },
    });
  }

  function bodyError(response: Response, maximumBytes: number) {
    return readBoundedBody(response, maximumBytes, true).then(
      () => undefined,
      (error: unknown) => error as { code?: string; safe_response_reason?: string; message?: string },
    );
  }

  it("snapshots a reused chunk buffer instead of returning the producer's final bytes", async () => {
    const response = new Response(null, {
      status: 200,
      headers: { "content-type": "application/json", ...FINGERPRINT_HEADERS },
    });
    Object.defineProperty(response, "body", { value: reusingProducer(2), configurable: true });
    const bytes = await readBoundedBody(response, 16, true);
    expect(new TextDecoder().decode(bytes)).toBe("AB");
  });

  it("returns its byte-budget failure without waiting for pending cancellation", async () => {
    const response = new Response(null, {
      status: 200,
      headers: { "content-type": "application/json", ...FINGERPRINT_HEADERS },
    });
    Object.defineProperty(response, "body", { value: pendingCancelStream(), configurable: true });
    const failure = await bodyError(response, 4);
    expect(failure?.safe_response_reason).toBe("BODY_TOO_LARGE");
    expect(failure?.message).toBe("AI Gateway response exceeds its byte budget");
  });

  it("cancels the unused body and keeps the declared header reason when Content-Length is oversized", async () => {
    let cancelCalls = 0;
    const response = new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": "8",
        ...FINGERPRINT_HEADERS,
      },
    });
    Object.defineProperty(response, "body", { value: new ReadableStream<Uint8Array>({
      cancel() { cancelCalls += 1; return Promise.resolve(); },
    }), configurable: true });
    const failure = await bodyError(response, 2);
    expect(failure?.safe_response_reason).toBe("BODY_TOO_LARGE");
    expect(failure?.message).toBe("AI Gateway response exceeds its byte budget");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelCalls).toBe(1);
  });

  it("rejects a malformed Content-Length header with the declared shape reason", async () => {
    const response = new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": "not-a-number",
        ...FINGERPRINT_HEADERS,
      },
    });
    const failure = await bodyError(response, 4096);
    expect(failure?.safe_response_reason).toBe("BODY_SHAPE_INVALID");
    expect(failure?.message).toBe("AI Gateway content-length is invalid");
  });

  it("rejects an infinite empty-chunk flood on the shared chunk ceiling", async () => {
    const response = new Response(null, {
      status: 200,
      headers: { "content-type": "application/json", ...FINGERPRINT_HEADERS },
    });
    Object.defineProperty(response, "body", { value: new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(0)); },
    }), configurable: true });
    const failure = await bodyError(response, 4096);
    expect(failure?.safe_response_reason).toBe("BODY_TOO_LARGE");
  });

  it("releases the reader lock after a successful bounded read", async () => {
    const response = new Response(null, {
      status: 200,
      headers: { "content-type": "application/json", ...FINGERPRINT_HEADERS },
    });
    Object.defineProperty(response, "body", { value: reusingProducer(2), configurable: true });
    await readBoundedBody(response, 16, false);
    expect(() => response.body?.getReader()).not.toThrow();
  });

  it("keeps the reader lock released after a bounded failure", async () => {
    const response = new Response(null, {
      status: 200,
      headers: { "content-type": "application/json", ...FINGERPRINT_HEADERS },
    });
    Object.defineProperty(response, "body", { value: pendingCancelStream(), configurable: true });
    await bodyError(response, 4);
    expect(() => response.body?.getReader()).not.toThrow();
  });

  it("rethrows a non-byte chunk as a shape failure that names the reader as its cause", async () => {
    const response = new Response(null, {
      status: 200,
      headers: { "content-type": "application/json", ...FINGERPRINT_HEADERS },
    });
    Object.defineProperty(response, "body", { value: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue("not bytes" as unknown as Uint8Array);
        controller.close();
      },
    }), configurable: true });
    const failure = await bodyError(response, 16);
    expect(failure?.safe_response_reason).toBe("BODY_SHAPE_INVALID");
    expect(failure?.message).toBe("AI Gateway response body could not be read");
  });

  it("keeps the empty-body and missing-body domain distinctions", async () => {
    const present = new Response(null, {
      status: 200,
      headers: { "content-type": "application/json", ...FINGERPRINT_HEADERS },
    });
    Object.defineProperty(present, "body", { value: new ReadableStream<Uint8Array>({
      start(controller) { controller.close(); },
    }), configurable: true });
    const empty = await bodyError(present, 4096);
    expect(empty?.safe_response_reason).toBe("BODY_SHAPE_INVALID");
    expect(empty?.message).toBe("AI Gateway response body is empty");
    // A malformed Content-Length is still a header failure, so the header
    // preflight keeps precedence over the null-body distinction restored above.
    const missingWithBadHeader = new Response(null, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": "-1",
        ...FINGERPRINT_HEADERS,
      },
    });
    Object.defineProperty(missingWithBadHeader, "body", { value: null, configurable: true });
    const headerWins = await bodyError(missingWithBadHeader, 4096);
    expect(headerWins?.message).toBe("AI Gateway content-length is invalid");
    const absent = new Response(null, {
      status: 200,
      headers: { "content-type": "application/json", ...FINGERPRINT_HEADERS },
    });
    Object.defineProperty(absent, "body", { value: null, configurable: true });
    const missing = await bodyError(absent, 4096);
    expect(missing?.safe_response_reason).toBe("BODY_SHAPE_INVALID");
    expect(missing?.message).toBe("AI Gateway response body is missing");
  });

  it("keeps the native reader's byte-budget reason and its empty-body message", async () => {
    const { deployment } = await fixture(OPENROUTER_POLICY);
    const bare = new Response("", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cf-aig-provider": OPENROUTER_POLICY.provider,
        "cf-aig-model": OPENROUTER_POLICY.model,
        "cf-aig-log-id": "bounded-body-log",
      },
    });
    Object.defineProperty(bare, "body", { value: new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(4)); },
    }), configurable: true });
    const failure = await decodeModelGatewayProviderNativeResponse(bare, deployment, 2, OPENROUTER_POLICY).catch((error: unknown) => error);
    expect((failure as { code?: string }).code).toBe("MODEL_GATEWAY_RESPONSE_INVALID");
    expect((failure as { message?: string }).message).toBe("provider response exceeds its byte budget");
    const empty = new Response("", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cf-aig-provider": OPENROUTER_POLICY.provider,
        "cf-aig-model": OPENROUTER_POLICY.model,
        "cf-aig-log-id": "bounded-body-log",
      },
    });
    const emptyFailure = await decodeModelGatewayProviderNativeResponse(empty, deployment, 4096, OPENROUTER_POLICY).catch((error: unknown) => error);
    expect((emptyFailure as { code?: string }).code).toBe("MODEL_GATEWAY_RESPONSE_INVALID");
    expect((emptyFailure as { message?: string }).message).toBe("provider response body is empty");
  });

  it("keeps the compatibility decoder decoding a real chat completion end to end", async () => {
    const { deployment } = await fixture();
    const body = { id: "compat-1", object: "chat.completion", created: 1, model: LEGACY_POLICY.model,
      service_tier: "default", choices: [{ index: 0, finish_reason: "stop", message: {
        role: "assistant", content: "{\"answer\":\"ok\"}", reasoning_content: "private reasoning",
      } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, neurons: 0.25 } };
    const decoded = await decodeSelectedModelGatewayResponse(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", ...FINGERPRINT_HEADERS },
      }),
      deployment,
      4096,
      LEGACY_POLICY,
    );
    expect(decoded.assistant_content).toBe("{\"answer\":\"ok\"}");
    expect(decoded.log_id).toBe("bounded-body-log");
    expect(decoded.usage).toEqual({ input_tokens: 2, output_tokens: 3, total_tokens: 5 });
  });
});

describe("model gateway bounded body reader contract regressions", () => {
  const HEADERS = {
    "cf-aig-provider": "workers-ai",
    "cf-aig-model": LEGACY_POLICY.model,
    "cf-aig-log-id": "regression-log",
  };

  const NATIVE_HEADERS = {
    "cf-aig-provider": OPENROUTER_POLICY.provider,
    "cf-aig-model": OPENROUTER_POLICY.model,
    "cf-aig-log-id": "regression-log",
  };

  // Resolve the settled value of a promise as unknown, so a rejected result
  // keeps its own error type instead of unioning with the success type.
  type SettledFailure = {
    readonly name?: string;
    readonly code?: string;
    readonly safe_response_reason?: string;
    readonly message?: string;
    readonly cause?: unknown;
  };

  function settleFailure<T>(value: Promise<T>): Promise<SettledFailure> {
    return value.then(
      () => ({}),
      (error: unknown) => error as SettledFailure,
    );
  }

  function gatewayFailure(body: ReadableStream<Uint8Array> | null, maximumBytes = 4096) {
    const response = new Response(null, {
      status: 200,
      headers: { "content-type": "application/json", ...HEADERS },
    });
    Object.defineProperty(response, "body", { value: body, configurable: true });
    return settleFailure(readBoundedBody(response, maximumBytes, true));
  }

  async function providerFailure(
    body: ReadableStream<Uint8Array> | null,
    maximumBytes: number,
  ) {
    const { deployment } = await fixture(OPENROUTER_POLICY);
    const response = new Response(null, {
      status: 200,
      headers: { "content-type": "application/json", ...NATIVE_HEADERS },
    });
    Object.defineProperty(response, "body", { value: body, configurable: true });
    return settleFailure(decodeModelGatewayProviderNativeResponse(
      response,
      deployment,
      maximumBytes,
      OPENROUTER_POLICY,
    ));
  }

  // A raw ReadableStream rejection is not a RuntimeLimitError. The private loop
  // classified it as a Gateway read exception, so the consumer kept its domain
  // error class. A bare rethrow would escape that effect surface.
  it("classifies a generic stream read rejection as a Gateway domain failure with its original cause", async () => {
    const boom = new TypeError("stream boom");
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(boom);
      },
    });
    const failure = await gatewayFailure(failing);
    expect(failure?.name).toBe("ModelGatewayExecutionError");
    expect(failure?.code).toBe("MODEL_GATEWAY_RESPONSE_INVALID");
    expect(failure?.safe_response_reason).toBe("BODY_SHAPE_INVALID");
    expect(failure?.message).toBe("AI Gateway response body could not be read");
    expect(failure?.cause).toBe(boom);
  });

  // An already-ModelGatewayExecutionError cause passed through unchanged under
  // the private loop. The shared reader must not relabel it.
  it("passes an existing ModelGatewayExecutionError through unchanged", async () => {
    const domainError = new ModelGatewayExecutionError(
      "MODEL_GATEWAY_POLICY_REJECTED",
      "policy rejected by upstream",
      { safe_response_reason: "BODY_JSON_INVALID" },
    );
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(domainError);
      },
    });
    const failure = await gatewayFailure(failing);
    expect(failure).toBe(domainError);
  });

  it("distinguishes a null body from a zero-length body", async () => {
    const absent = await gatewayFailure(null);
    expect(absent?.message).toBe("AI Gateway response body is missing");
    const present = await gatewayFailure(new ReadableStream<Uint8Array>({
      start(controller) { controller.close(); },
    }));
    expect(present?.message).toBe("AI Gateway response body is empty");
  });

  it("keeps the header preflight ahead of the null-body distinction", async () => {
    const response = new Response(null, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": "not-a-number",
        ...HEADERS,
      },
    });
    Object.defineProperty(response, "body", { value: null, configurable: true });
    const failure = await settleFailure(readBoundedBody(response, 4096, true));
    expect(failure?.message).toBe("AI Gateway content-length is invalid");
  });

  it("keeps the provider path from reporting a stream chunk as a content-length failure", async () => {
    const response = new Response(null, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cf-aig-provider": OPENROUTER_POLICY.provider,
        "cf-aig-model": OPENROUTER_POLICY.model,
        "cf-aig-log-id": "regression-log",
      },
    });
    Object.defineProperty(response, "body", { value: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue("not bytes" as unknown as Uint8Array);
        controller.close();
      },
    }), configurable: true });
    const failure = await providerFailure(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue("not bytes" as unknown as Uint8Array);
        controller.close();
      },
    }), 4096);
    expect(failure?.message).toBe("provider response body could not be read");
    expect((failure?.cause as { code?: string } | undefined)?.code).toBe("STREAM_CHUNK_INVALID");
  });

  it("classifies a generic provider stream rejection as a domain failure", async () => {
    const boom = new RangeError("provider stream boom");
    const failure = await providerFailure(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(boom);
      },
    }), 4096);
    expect(failure?.name).toBe("ModelGatewayExecutionError");
    expect(failure?.code).toBe("MODEL_GATEWAY_RESPONSE_INVALID");
    expect(failure?.safe_response_reason).toBe("BODY_SHAPE_INVALID");
    expect(failure?.message).toBe("provider response body could not be read");
    expect(failure?.cause).toBe(boom);
  });
});
