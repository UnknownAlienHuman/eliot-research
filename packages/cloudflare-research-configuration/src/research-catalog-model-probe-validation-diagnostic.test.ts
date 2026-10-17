import { describe, expect, it } from "vitest";
import { ModelGatewayExecutionError } from "@eliotr/cloudflare-ai";
import { decodeModelGatewayProviderBody } from "@eliotr/cloudflare-model-transport/model-gateway-provider-native-response.js";
import { catalogModelProbeValidationMessage } from "./research-catalog-model-probe-validation-diagnostic.js";

async function rejectedBody(body: unknown): Promise<unknown> {
  try {
    await decodeModelGatewayProviderBody(new TextEncoder().encode(JSON.stringify(body)), "custom-responses");
  } catch (cause) { return cause; }
  throw new Error("fixture should fail strict decoder validation");
}

const privateText = "private-prompt-key-response\nSECRET";
const response = { object: "response", id: "response-id", created_at: 1, model: "exact-model", status: "completed",
  output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: privateText }] }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };

describe("safe catalog probe decoder diagnostics", () => {
  it("retains a static validation message from the actual strict decoder", async () => {
    const cause = await rejectedBody({ ...response, status: "in_progress" });
    expect(cause).toMatchObject({ code: "MODEL_GATEWAY_RESPONSE_INVALID", safe_response_reason: "BODY_SHAPE_INVALID" });
    expect(catalogModelProbeValidationMessage(cause)).toBe("OpenAI Responses result is not a completed successful response");
  });

  it.each(["root", "output", "content"] as const)("withholds a provider-controlled %s field name and all private values", async location => {
    const body = structuredClone(response);
    const output = body.output[0];
    const content = output?.content[0];
    if (output === undefined || content === undefined) throw new Error("invalid test fixture");
    if (location === "root") Object.assign(body, { [privateText]: privateText });
    if (location === "output") Object.assign(output, { [privateText]: privateText });
    if (location === "content") Object.assign(content, { [privateText]: privateText });
    const cause = await rejectedBody(body);
    expect(cause).toBeInstanceOf(ModelGatewayExecutionError);
    expect((cause as Error).message).toContain(privateText);
    const message = catalogModelProbeValidationMessage(cause);
    expect(message).toBe(`OpenAI Responses${location === "root" ? "" : ` ${location} item`} contains an unsupported field (name withheld)`);
    expect(message).not.toContain(privateText);
    expect(new TextEncoder().encode(message).byteLength).toBeLessThanOrEqual(192);
  });

  it("normalizes a non-object output item without returning indices or response data", async () => {
    const cause = await rejectedBody({ ...response, output: [privateText] });
    expect(catalogModelProbeValidationMessage(cause)).toBe("OpenAI Responses output item must be a plain object");
  });

  it.each([
    new Error("OpenAI Responses output is invalid"),
    new ModelGatewayExecutionError("MODEL_GATEWAY_RESPONSE_INVALID", privateText, { cause: { body: privateText } }),
    new ModelGatewayExecutionError("MODEL_GATEWAY_RESPONSE_INVALID", "OpenAI Responses output is invalid\n" + privateText),
    new ModelGatewayExecutionError("MODEL_GATEWAY_RESPONSE_INVALID", "OpenAI Responses contains unsupported field " + privateText.repeat(1000)),
    new ModelGatewayExecutionError("MODEL_GATEWAY_REQUEST_INVALID", "OpenAI Responses output is invalid"),
    { message: "OpenAI Responses output is invalid", body: privateText },
  ])("fails closed for arbitrary, oversized or non-decoder errors", cause => {
    expect(catalogModelProbeValidationMessage(cause)).toBe("UNCLASSIFIED");
  });
});
