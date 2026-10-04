import { describe, expect, it } from "vitest";
import {
  modelGatewayRequestParametersSha256,
  type ModelCallInput,
  type ModelGatewayPromptCompilerPort,
} from "@eliotr/cloudflare-ai";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import { bindQualificationPromptCompiler } from "./research-model-qualification-dispatch.js";

const capabilities = Object.freeze({
  max_output_tokens_field: "max_completion_tokens" as const,
  reasoning_efforts: Object.freeze(["max"] as const),
});
const body = Object.freeze({
  model: "dynamic/eliotr-balanced--deployment",
  messages: Object.freeze([]),
  max_completion_tokens: 32,
  reasoning_effort: "max",
  stream: false,
});

async function deployment(): Promise<ModelRouteDeployment> {
  return {
    route_ref: "dynamic/eliotr-balanced",
    route_version: "route-v3",
    prompt_generation: "prompt-v3",
    schema_generation: "schema-v3",
    parameters_digest: await modelGatewayRequestParametersSha256(body, capabilities),
    pricing_snapshot_ref: "pricing-v3",
  };
}

const compiler: ModelGatewayPromptCompilerPort = {
  async compile() {
    return {
      request_body: body,
      request_body_sha256: "a".repeat(64),
      request_timeout_ms: 1_000,
    };
  },
};

describe("qualification prompt parameter digest", () => {
  it("checks the final request with the same selected token-field and effort capabilities", async () => {
    const bound = bindQualificationPromptCompiler(compiler, capabilities);

    await expect(bound.compile({} as ModelCallInput, await deployment())).resolves.toMatchObject({
      request_body: { max_completion_tokens: 32, reasoning_effort: "max" },
    });
  });

  it("does not accept a completion-token request under the legacy max_tokens projection", async () => {
    const bound = bindQualificationPromptCompiler(compiler);

    await expect(bound.compile({} as ModelCallInput, await deployment())).rejects.toMatchObject({
      code: "MODEL_GATEWAY_REQUEST_INVALID",
    });
  });

  it("fails closed when the exact selected path does not support the requested effort", async () => {
    const bound = bindQualificationPromptCompiler(compiler, {
      max_output_tokens_field: "max_completion_tokens",
      reasoning_efforts: ["low"],
    });

    await expect(bound.compile({} as ModelCallInput, await deployment())).rejects.toMatchObject({
      code: "MODEL_GATEWAY_REQUEST_INVALID",
    });
  });
});
