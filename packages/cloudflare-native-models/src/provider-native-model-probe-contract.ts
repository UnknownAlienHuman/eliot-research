import {
  canonicalModelGatewayJson,
  decodeModelGatewayProviderBody,
  modelGatewayRequestParametersSha256,
  modelGatewaySha256,
  type ModelGatewayTransportPolicyV1,
} from "@eliotr/cloudflare-ai";

function invalidProbeResponse(message: string, cause?: unknown): never {
  throw new Error(message, cause === undefined ? undefined : { cause });
}

export const PROVIDER_NATIVE_MODEL_PROBE_PROMPT =
  'Return only this JSON object: {"connected":true,"qualification_purpose":"structured-output-connectivity"}.' as const;

export const PROVIDER_NATIVE_MODEL_PROBE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["connected", "qualification_purpose"]),
  properties: Object.freeze({
    connected: Object.freeze({ const: true }),
    qualification_purpose: Object.freeze({ const: "structured-output-connectivity" }),
  }),
});

export interface ProviderNativeModelProbeInputDigestsV1 {
  readonly probe_prompt_sha256: string;
  readonly probe_schema_sha256: string;
}

export interface ProviderNativeModelProbeRequestDigestsV1 extends ProviderNativeModelProbeInputDigestsV1 {
  readonly request_body_sha256: string;
  readonly request_parameters_sha256: string;
}

export async function providerNativeModelProbeInputDigests(): Promise<ProviderNativeModelProbeInputDigestsV1> {
  return Object.freeze({
    probe_prompt_sha256: await modelGatewaySha256(new TextEncoder().encode(PROVIDER_NATIVE_MODEL_PROBE_PROMPT)),
    probe_schema_sha256: await modelGatewaySha256(
      new TextEncoder().encode(canonicalModelGatewayJson(PROVIDER_NATIVE_MODEL_PROBE_SCHEMA)),
    ),
  });
}

export async function inspectProviderNativeModelProbeRequest(
  rawBytes: Uint8Array,
  policy: ModelGatewayTransportPolicyV1,
): Promise<ProviderNativeModelProbeRequestDigestsV1> {
  if (!(rawBytes instanceof Uint8Array) || rawBytes.byteLength < 1 || rawBytes.byteLength > 32_768) {
    invalidProbeResponse("native connectivity request bytes are missing or oversized");
  }
  let request: unknown;
  try { request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBytes)) as unknown; }
  catch (cause) { invalidProbeResponse("native connectivity request is not valid UTF-8 JSON", cause); }
  if (typeof request !== "object" || request === null || Array.isArray(request) ||
      (Object.getPrototypeOf(request) !== Object.prototype && Object.getPrototypeOf(request) !== null)) {
    invalidProbeResponse("native connectivity request must be a plain JSON object");
  }
  const body = request as Record<string, unknown>;
  if (body.model !== policy.model || body.stream === true || !Array.isArray(body.messages) || body.messages.length !== 1) {
    invalidProbeResponse("native connectivity request model, stream mode, or message count is invalid");
  }
  const message = body.messages[0];
  if (typeof message !== "object" || message === null || Array.isArray(message) ||
      (Object.getPrototypeOf(message) !== Object.prototype && Object.getPrototypeOf(message) !== null)) {
    invalidProbeResponse("native connectivity request message is malformed");
  }
  const messageRecord = message as Record<string, unknown>;
  if (Object.keys(messageRecord).length !== 2 || messageRecord.role !== "user" ||
      messageRecord.content !== PROVIDER_NATIVE_MODEL_PROBE_PROMPT) {
    invalidProbeResponse("native connectivity request does not contain the fixed probe prompt");
  }
  const responseFormat = body.response_format;
  if (typeof responseFormat !== "object" || responseFormat === null || Array.isArray(responseFormat) ||
      (Object.getPrototypeOf(responseFormat) !== Object.prototype && Object.getPrototypeOf(responseFormat) !== null) ||
      Object.keys(responseFormat).length !== 1 || (responseFormat as Record<string, unknown>).type !== "json_object") {
    invalidProbeResponse("native connectivity request does not require JSON object output");
  }
  const provider = body.provider;
  if (typeof provider !== "object" || provider === null || Array.isArray(provider) ||
      (Object.getPrototypeOf(provider) !== Object.prototype && Object.getPrototypeOf(provider) !== null)) {
    invalidProbeResponse("native connectivity request lacks the OpenRouter free-only provider cap");
  }
  const providerRecord = provider as Record<string, unknown>;
  const maxPrice = providerRecord.max_price;
  if (Object.keys(providerRecord).length !== 2 || providerRecord.allow_fallbacks !== false ||
      typeof maxPrice !== "object" || maxPrice === null || Array.isArray(maxPrice) ||
      (Object.getPrototypeOf(maxPrice) !== Object.prototype && Object.getPrototypeOf(maxPrice) !== null) ||
      Object.keys(maxPrice).length !== 4 ||
      Object.values(maxPrice).some((amount) => amount !== 0) ||
      !["prompt", "completion", "request", "image"].every((key) => Object.hasOwn(maxPrice, key))) {
    invalidProbeResponse("native connectivity request does not enforce the exact zero-price no-fallback cap");
  }
  let parametersSha: string;
  try {
    const parameterBody = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "provider"));
    parametersSha = await modelGatewayRequestParametersSha256(parameterBody, policy.capabilities, policy.api);
  }
  catch (cause) { invalidProbeResponse("native connectivity request parameters are invalid", cause); }
  const probeDigests = await providerNativeModelProbeInputDigests();
  return Object.freeze({
    ...probeDigests,
    request_body_sha256: await modelGatewaySha256(rawBytes),
    request_parameters_sha256: parametersSha,
  });
}

export async function assertProviderNativeModelProbeResponse(
  responseBodyBytes: Uint8Array,
  expected: Readonly<{ model: string; input_tokens: number; output_tokens: number }>,
): Promise<void> {
  let decoded: Awaited<ReturnType<typeof decodeModelGatewayProviderBody>>;
  try {
    decoded = await decodeModelGatewayProviderBody(responseBodyBytes, "openrouter-chat-completions");
  } catch (cause) {
    invalidProbeResponse("native connectivity response is not a valid OpenRouter response", cause);
  }
  if (decoded.response_model !== expected.model || decoded.usage.input_tokens !== expected.input_tokens ||
      decoded.usage.output_tokens !== expected.output_tokens) {
    invalidProbeResponse("native connectivity response model or usage differs from its receipt");
  }
  let output: unknown;
  try { output = JSON.parse(decoded.assistant_content) as unknown; }
  catch (cause) {
    invalidProbeResponse("native connectivity response is not a structured JSON object", cause);
  }
  if (typeof output !== "object" || output === null || Array.isArray(output) ||
      (Object.getPrototypeOf(output) !== Object.prototype && Object.getPrototypeOf(output) !== null)) {
    invalidProbeResponse("native connectivity result is not a plain JSON object");
  }
  const result = output as Record<string, unknown>;
  if (Object.keys(result).length !== 2 || result.connected !== true ||
      result.qualification_purpose !== "structured-output-connectivity") {
    invalidProbeResponse("native connectivity result does not match its exact purpose schema");
  }
}
