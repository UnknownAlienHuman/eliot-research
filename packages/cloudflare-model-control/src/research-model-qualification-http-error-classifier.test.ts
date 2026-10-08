import { describe, expect, it } from "vitest";
import {
  ModelGatewayExecutionError,
  decodeModelGatewayProviderNativeResponse,
  type ModelGatewaySafeResponseReason,
  type ModelGatewayTransportPolicyV1,
} from "@eliotr/cloudflare-ai";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import {
  qualificationFailureTitle,
  responseInvalidReason,
  typedUpstreamStatus,
} from "./research-model-qualification-http-error-classifier.js";

const policy: ModelGatewayTransportPolicyV1 = Object.freeze({
  version: 1,
  transport: "cloudflare-ai-gateway",
  api: "openai-chat-completions",
  provider: "openai",
  model: "openai/test-model",
  billing: Object.freeze({ mode: "byok", alias: "configured-key" }),
  capabilities: Object.freeze({ max_output_tokens_field: "max_completion_tokens", reasoning_efforts: Object.freeze(["low"] as const) }),
});

const deployment = Object.freeze({
  route_ref: "dynamic/eliotr-balanced" as const,
  route_version: "route-v1",
  prompt_generation: "prompt-v1",
  schema_generation: "schema-v1",
  parameters_digest: "a".repeat(64),
  pricing_snapshot_ref: "pricing-v1",
}) as ModelRouteDeployment;

async function decodeFailure(response: Response): Promise<unknown> {
  try {
    await decodeModelGatewayProviderNativeResponse(response, deployment, 4096, policy);
  } catch (cause) {
    return cause;
  }
  throw new Error("expected the provider response decoder to reject the fixture");
}

describe("qualification HTTP error classifier response reasons", () => {
  it("projects a real malformed provider response through a bounded reason without leaking its body or cause", async () => {
    const failure = await decodeFailure(new Response('{"private_payload":"sensitive-marker",', {
      status: 200,
      headers: { "content-type": "application/json", "cf-aig-log-id": "log-test-1" },
    }));

    expect(failure).toBeInstanceOf(ModelGatewayExecutionError);
    expect(failure).toMatchObject({
      code: "MODEL_GATEWAY_RESPONSE_INVALID",
      safe_response_reason: "BODY_JSON_INVALID",
    });
    const reason = responseInvalidReason(failure);
    const title = qualificationFailureTitle(undefined, [], reason, undefined);
    expect(reason).toBe("BODY_JSON_INVALID");
    expect(title).toBe("Document model qualification could not complete (response reason BODY_JSON_INVALID)");
    expect(title).not.toContain("sensitive-marker");
  });

  it("distinguishes selected-model identity rejection from malformed provider JSON", async () => {
    const failure = await decodeFailure(new Response(JSON.stringify({
      id: "chatcmpl-test-1",
      object: "chat.completion",
      created: 1,
      model: "fallback/model",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "answer" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), {
      status: 200,
      headers: { "content-type": "application/json", "cf-aig-log-id": "log-test-1" },
    }));

    expect(failure).toMatchObject({
      code: "MODEL_GATEWAY_RESPONSE_INVALID",
      safe_response_reason: "MODEL_ID_INVALID",
    });
    expect(responseInvalidReason(failure)).toBe("MODEL_ID_INVALID");
  });

  it("accepts only the finite typed reason and retains legacy exact-message classification", () => {
    const hostile = new ModelGatewayExecutionError(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "provider body contains sensitive-marker",
      {
        safe_response_reason: "NOT_A_REASON" as ModelGatewaySafeResponseReason,
        cause: new Error("authorization=private-marker"),
      },
    );
    const legacy = new ModelGatewayExecutionError(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response must be application/json",
    );

    expect(responseInvalidReason(hostile)).toBe("UNCLASSIFIED");
    expect(responseInvalidReason(legacy)).toBe("CONTENT_TYPE_INVALID");
    expect(qualificationFailureTitle(undefined, [], responseInvalidReason(hostile), undefined))
      .toBe("Document model qualification could not complete (response reason UNCLASSIFIED)");
  });

  it("uses only the carried numeric HTTP status and leaves policy refusals code-only", () => {
    const upstream = new ModelGatewayExecutionError(
      "MODEL_GATEWAY_UPSTREAM_REJECTED",
      "sensitive upstream body",
      { http_status: 502, cause: new Error("private provider response") },
    );
    const refusal = new ModelGatewayExecutionError("MODEL_GATEWAY_POLICY_REJECTED", "private refusal detail");

    expect(typedUpstreamStatus(upstream)).toBe(502);
    expect(qualificationFailureTitle(typedUpstreamStatus(upstream), [], undefined, undefined))
      .toBe("Document model qualification could not complete (upstream HTTP 502)");
    expect(responseInvalidReason(refusal)).toBeUndefined();
    expect(typedUpstreamStatus(refusal)).toBeUndefined();
  });
});
