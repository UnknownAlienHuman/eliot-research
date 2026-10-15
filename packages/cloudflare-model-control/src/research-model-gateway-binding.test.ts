import { describe, expect, it, vi } from "vitest";
import { createResearchModelGatewayBindingFetch, type ResearchModelGatewayBinding } from "./research-model-gateway-binding.js";

const base = `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/eliotr-reasoning`;
const endpoint = `${base}/compat/chat/completions`;
const metadata = {
  budget_reservation_ref: "budget-one", evidence_pack_ref: "pack-one:1", output_object_ref: "output-one",
  prompt_generation: "prompt-one", schema_generation: "schema-one",
};
function headers() {
  return {
    "cf-aig-collect-log": "true", "cf-aig-collect-log-payload": "false", "cf-aig-skip-cache": "true",
    "cf-aig-metadata": JSON.stringify(metadata), "cf-aig-request-timeout": "180000", "cf-aig-max-attempts": "1",
  };
}
function fixture() {
  const getLog = vi.fn(async () => ({ id: "log-one", status_code: 200, cached: false,
    provider: "workers-ai", model: "@cf/zai-org/glm-5.3-flash", metadata } as AiGatewayLog));
  const run = vi.fn<ResearchModelGatewayBinding["run"]>(async (_model, _inputs, options) => {
    // The official native SDK serializes gateway options separately from extraHeaders.
    expect(options.gateway).toEqual({ id: "eliotr-reasoning", collectLog: true, skipCache: true,
      metadata, requestTimeoutMs: 180000, retries: { maxAttempts: 1 } });
    expect(options.extraHeaders["cf-aig-collect-log-payload"]).toBe("false");
    return new Response("{}", { headers: { "cf-aig-log-id": "log-one" } });
  });
  const binding: ResearchModelGatewayBinding = { gateway: () => ({ getUrl: async () => base, getLog }), run };
  return { fetch: createResearchModelGatewayBindingFetch(binding, endpoint), run, getLog };
}
const body = JSON.stringify({ model: "dynamic/eliotr-balanced", messages: [{ role: "user", content: "test" }] });

describe("native AI Gateway policy transport", () => {
  it("uses native gateway options and verifies observed identity from response-scoped metadata", async () => {
    const subject = fixture();
    const response = await subject.fetch(endpoint, { method: "POST", body, headers: headers() });
    expect(subject.run).toHaveBeenCalledOnce();
    expect(subject.getLog).toHaveBeenCalledWith("log-one");
    expect(response.headers.get("cf-aig-provider")).toBe("workers-ai");
    expect(response.headers.get("cf-aig-model")).toBe("@cf/zai-org/glm-5.3-flash");
  });

  it("refuses payload logging or provider retries before inference", async () => {
    for (const change of [{ "cf-aig-collect-log-payload": "true" }, { "cf-aig-max-attempts": "2" }]) {
      const subject = fixture();
      await expect(subject.fetch(endpoint, { method: "POST", body, headers: { ...headers(), ...change } }))
        .rejects.toMatchObject({ code: "MODEL_GATEWAY_REQUEST_INVALID" });
      expect(subject.run).not.toHaveBeenCalled();
    }
  });
});
