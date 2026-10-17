import { describe, expect, it } from "vitest";
import { decodeModelGatewayProviderBody } from "./model-gateway-provider-native-response.js";

// Official Responses object, fetched 2026-10-17:
// https://developers.openai.com/api/reference/resources/responses/methods/create
const fixture = () => ({
  id: "response-fixture", object: "response", created_at: 1, status: "completed", error: null,
  model: "exact-selected-model", store: false,
  output: [{ id: "message-fixture", type: "message", role: "assistant", status: "completed",
    phase: "final_answer", content: [{ type: "output_text", annotations: [], logprobs: [], text: '{"connected":true}' }] }],
  usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
});
const bytes = (body: unknown) => new TextEncoder().encode(JSON.stringify(body));

describe("documented Responses body metadata", () => {
  it.each(["openai-responses", "custom-responses"] as const)("accepts documented metadata for %s without rewriting evidence bytes", async api => {
    const original = bytes(fixture());
    const decoded = await decodeModelGatewayProviderBody(original, api);
    expect(decoded.assistant_content).toBe('{"connected":true}');
    expect(decoded.response_model).toBe("exact-selected-model");
    expect(decoded.usage).toEqual({ input_tokens: 2, output_tokens: 3, total_tokens: 5 });
    expect(decoded.body_bytes).toEqual(original);
    expect(decoded.body_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("retains the documented boolean store observation without inferring retention policy", async () => {
    const body = { ...fixture(), store: true };
    expect((await decodeModelGatewayProviderBody(bytes(body))).assistant_content).toBe('{"connected":true}');
  });

  it.each([undefined, null])("accepts an omitted or null message phase: %s", async phase => {
    const body = fixture();
    Object.assign(body.output[0] ?? {}, { phase });
    expect((await decodeModelGatewayProviderBody(bytes(body))).assistant_content).toBe('{"connected":true}');
  });

  it.each(["body", "message", "content"])("keeps unknown %s fields rejected", async target => {
    const body = fixture();
    Object.assign(target === "body" ? body : target === "message" ? body.output[0] ?? {} : body.output[0]?.content[0] ?? {},
      { unsupported_field: true });
    await expect(decodeModelGatewayProviderBody(bytes(body))).rejects.toMatchObject({ code: "MODEL_GATEWAY_RESPONSE_INVALID" });
  });

  it.each([null, "false", 0])("rejects an invalid store flag: %s", async store => {
    await expect(decodeModelGatewayProviderBody(bytes({ ...fixture(), store })))
      .rejects.toMatchObject({ code: "MODEL_GATEWAY_RESPONSE_INVALID" });
  });

  it.each(["commentary", "unknown"])("does not promote %s to a final answer", async phase => {
    const body = fixture();
    Object.assign(body.output[0] ?? {}, { phase });
    await expect(decodeModelGatewayProviderBody(bytes(body))).rejects.toMatchObject({ code: "MODEL_GATEWAY_RESPONSE_INVALID" });
  });

  it.each([null, [{}]])("rejects malformed or unrequested logprobs: %s", async logprobs => {
    const body = fixture();
    Object.assign(body.output[0]?.content[0] ?? {}, { logprobs });
    await expect(decodeModelGatewayProviderBody(bytes(body))).rejects.toMatchObject({ code: "MODEL_GATEWAY_RESPONSE_INVALID" });
  });
});
