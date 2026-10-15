import { ModelGatewayExecutionError } from "@eliotr/cloudflare-ai";
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
function fixture(options: { readonly logId?: string; readonly responseLogId?: string } = {}) {
  const logId = options.logId ?? "log-one";
  const responseLogId = options.responseLogId ?? logId;
  const getLog = vi.fn(async () => ({ id: logId, status_code: 200, cached: false,
    provider: "workers-ai", model: "@cf/zai-org/glm-5.3-flash", metadata,
    path: "/compat/chat/completions", duration: 1, success: true, request_size: 0,
    response_size: 2, request_head_complete: false, response_head_complete: false,
    created_at: new Date("2026-10-15T00:00:00.000Z"),
  } satisfies AiGatewayLog));
  const run = vi.fn<ReturnType<ResearchModelGatewayBinding["gateway"]>["run"]>(async (request, options) => {
    expect(request).toEqual({ provider: "compat", endpoint: "chat/completions", headers: {}, query: JSON.parse(body) });
    expect(options?.gateway).toEqual({ collectLog: true, skipCache: true, metadata });
    expect(options?.extraHeaders?.["cf-aig-collect-log-payload"]).toBe("false");
    expect(options?.extraHeaders?.["cf-aig-request-timeout"]).toBe("180000");
    expect(options?.extraHeaders?.["cf-aig-max-attempts"]).toBe("1");
    return new Response("{}", { headers: { "cf-aig-log-id": responseLogId } });
  });
  const binding: ResearchModelGatewayBinding = { gateway: () => ({ getUrl: async () => base, getLog, run }) };
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

  it("rejects a log readback correlated to a different response id with safe typed diagnostics", async () => {
    const subject = fixture({ logId: "log-two", responseLogId: "log-one" });
    const failure = await subject.fetch(endpoint, { method: "POST", body, headers: headers() })
      .then(() => undefined, (cause: unknown) => cause);

    expect(subject.getLog).toHaveBeenCalledWith("log-one");
    expect(failure).toBeInstanceOf(ModelGatewayExecutionError);
    expect(failure).toMatchObject({
      code: "MODEL_GATEWAY_RESPONSE_INVALID",
      http_status: 200,
      safe_response_reason: "LOG_CORRELATION_INVALID",
      cause: expect.objectContaining({
        name: "ModelGatewayExecutionError",
        safe_response_reason: "LOG_CORRELATION_INVALID",
      }),
    });
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
