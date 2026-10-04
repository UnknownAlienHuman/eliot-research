import { describe, expect, it } from "vitest";
import type { ModelCallInput } from "./model-gateway-execution-contract.js";
import {
  canonicalModelGatewayJson,
  modelGatewayDynamicRouteTarget,
  modelGatewayRequestParametersSha256,
  modelGatewaySha256,
  type ModelGatewayRequestCapabilitiesV1,
  type ModelGatewayTransportPolicyV1,
} from "./model-gateway-request.js";
import {
  prepareModelGatewayBindingRequest,
  prepareModelGatewayHttpRequest,
} from "./model-gateway-http-request.js";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";

const ACCOUNT_ID = "a".repeat(32);
const BASE_URL = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/eliotr-reasoning`;
const CAPABILITIES: ModelGatewayRequestCapabilitiesV1 = {
  max_output_tokens_field: "max_completion_tokens",
  reasoning_efforts: ["low", "max"],
};
const BYOK_POLICY: ModelGatewayTransportPolicyV1 = {
  version: 1,
  transport: "cloudflare-ai-gateway",
  api: "compat-chat-completions",
  provider: "workers-ai",
  model: "@cf/zai-org/glm-5.3-flash",
  billing: { mode: "byok", alias: "glm" },
  capabilities: CAPABILITIES,
};

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

async function fixture() {
  const deploymentBase: Omit<ModelRouteDeployment, "parameters_digest"> = {
    route_ref: "dynamic/eliotr-balanced",
    route_version: "route-1",
    prompt_generation: input.prompt_generation,
    schema_generation: input.schema_generation,
    pricing_snapshot_ref: "pricing-1",
  };
  const parameters = {
    max_completion_tokens: 32,
    reasoning_effort: "max",
    stream: false,
  };
  const deployment: ModelRouteDeployment = {
    ...deploymentBase,
    parameters_digest: await modelGatewayRequestParametersSha256(parameters, CAPABILITIES),
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

  it("projects the selected token key and pins BYOK to its alias without wholesale billing", async () => {
    const { deployment, compiled } = await fixture();
    const request = await prepareModelGatewayHttpRequest(
      input,
      deployment,
      compiled,
      BASE_URL,
      "gateway-secret",
      BYOK_POLICY,
    );
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body.max_completion_tokens).toBe(32);
    expect(body).not.toHaveProperty("max_tokens");
    expect(request.parameters_sha256).toBe(deployment.parameters_digest);
    expect(request.headers["cf-aig-byok-alias"]).toBe("glm");
    expect(request.headers["cf-aig-no-wholesale"]).toBe("true");
    expect(request.headers["cf-aig-authorization"]).toBe("Bearer gateway-secret");
    expect(request.headers).not.toHaveProperty("authorization");
    expect(request.url).toBe(`${BASE_URL}/compat/chat/completions`);
  });

  it("rejects a reasoning effort outside selected capabilities before provider dispatch", async () => {
    const { deployment, compiled } = await fixture();
    const policy = {
      ...BYOK_POLICY,
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

  it("rejects provider-native API and token-field ambiguity before transport", async () => {
    const { deployment, compiled } = await fixture();
    await expect(prepareModelGatewayHttpRequest(
      input,
      deployment,
      compiled,
      BASE_URL,
      "gateway-secret",
      { ...BYOK_POLICY, api: "openai-responses" },
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
      BYOK_POLICY,
    )).rejects.toMatchObject({ code: "MODEL_GATEWAY_REQUEST_INVALID" });
  });

  it("rejects BYOK on the native binding path before invoking it", async () => {
    const { deployment, compiled } = await fixture();
    await expect(prepareModelGatewayBindingRequest(
      input,
      deployment,
      compiled,
      BASE_URL,
      BYOK_POLICY,
    )).rejects.toMatchObject({ code: "MODEL_GATEWAY_REQUEST_INVALID" });
  });
});
