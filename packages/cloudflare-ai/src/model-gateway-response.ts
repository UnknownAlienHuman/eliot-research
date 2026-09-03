import {
  decodeDynamicRouteFingerprint,
  type ModelRouteDeployment,
} from "@eliotr/platform-cloudflare";
import {
  modelGatewayExecutionFailure,
  type DecodedModelGatewayResponse,
  type ModelGatewayUsageObservation,
} from "./model-gateway-execution-contract.js";
import { modelGatewaySha256 } from "./model-gateway-request.js";

const RESPONSE_KEYS = new Set([
  "choices",
  "created",
  "id",
  "model",
  "object",
  "service_tier",
  "system_fingerprint",
  "usage",
]);
const CHOICE_KEYS = new Set(["finish_reason", "index", "logprobs", "message"]);
const MESSAGE_KEYS = new Set(["annotations", "content", "refusal", "role"]);
const USAGE_KEYS = new Set([
  "completion_tokens",
  "completion_tokens_details",
  "prompt_tokens",
  "prompt_tokens_details",
  "total_tokens",
]);
const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const LOG_ID = /^[A-Za-z0-9._:@/-]{1,256}$/u;

function exactObject(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      `${label} must be a plain object`,
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      `${label} must be a plain object`,
    );
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_RESPONSE_INVALID",
        `${label} contains unsupported field ${key}`,
      );
    }
  }
  return record;
}

function boundedString(
  value: unknown,
  label: string,
  maximumBytes = 256 * 1024,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    new TextEncoder().encode(value).byteLength > maximumBytes ||
    /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      `${label} is invalid`,
    );
  }
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      `${label} must be a non-negative safe integer`,
    );
  }
  return value;
}

function header(
  headers: Headers,
  name: string,
  required: boolean,
): string | undefined {
  const value = headers.get(name);
  if (value === null) {
    if (required) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_RESPONSE_INVALID",
        `AI Gateway response is missing ${name}`,
      );
    }
    return undefined;
  }
  if (
    value.length < 1 ||
    value.length > 256 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      `AI Gateway response header ${name} is invalid`,
    );
  }
  return value;
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/u.test(rawLength)) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_RESPONSE_INVALID",
        "AI Gateway content-length is invalid",
      );
    }
    const declaredLength = Number(rawLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maximumBytes) {
      modelGatewayExecutionFailure(
        "MODEL_GATEWAY_RESPONSE_INVALID",
        "AI Gateway response exceeds the reserved output byte budget",
      );
    }
  }
  if (response.body === null) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response body is missing",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel("response byte budget exceeded");
        modelGatewayExecutionFailure(
          "MODEL_GATEWAY_RESPONSE_INVALID",
          "AI Gateway response exceeds the reserved output byte budget",
        );
      }
      chunks.push(next.value);
    }
  } catch (cause) {
    if (cause instanceof Error && cause.name === "ModelGatewayExecutionError") {
      throw cause;
    }
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response body could not be read",
      { cause },
    );
  }
  if (length < 1) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response body is empty",
    );
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function decodeUsage(raw: unknown): ModelGatewayUsageObservation {
  const usage = exactObject(raw, USAGE_KEYS, "AI Gateway response usage");
  const inputTokens = nonnegativeInteger(
    usage.prompt_tokens,
    "AI Gateway response usage.prompt_tokens",
  );
  const outputTokens = nonnegativeInteger(
    usage.completion_tokens,
    "AI Gateway response usage.completion_tokens",
  );
  const totalTokens = nonnegativeInteger(
    usage.total_tokens,
    "AI Gateway response usage.total_tokens",
  );
  if (inputTokens + outputTokens !== totalTokens) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response token totals do not reconcile",
    );
  }
  return Object.freeze({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  });
}

function decodeAssistantContent(rawChoices: unknown): string {
  if (!Array.isArray(rawChoices) || rawChoices.length !== 1) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response must contain exactly one choice",
    );
  }
  const choice = exactObject(rawChoices[0], CHOICE_KEYS, "AI Gateway response choice");
  if (choice.index !== 0) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response choice index must be zero",
    );
  }
  if (choice.finish_reason === "length") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_OUTPUT_TRUNCATED",
      "AI Gateway response reached the model output limit",
    );
  }
  if (choice.finish_reason !== "stop") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response did not finish with stop",
    );
  }
  if (choice.logprobs !== undefined && choice.logprobs !== null) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response logprobs were not requested",
    );
  }
  const message = exactObject(
    choice.message,
    MESSAGE_KEYS,
    "AI Gateway response choice.message",
  );
  if (message.role !== "assistant") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response role must be assistant",
    );
  }
  if (message.refusal !== undefined && message.refusal !== null) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response contains a provider refusal",
    );
  }
  if (
    message.annotations !== undefined &&
    (!Array.isArray(message.annotations) || message.annotations.length !== 0)
  ) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response contains unsupported annotations",
    );
  }
  return boundedString(message.content, "AI Gateway response assistant content");
}

export async function decodeModelGatewayResponse(
  response: Response,
  deployment: ModelRouteDeployment,
  maximumBytes: number,
): Promise<DecodedModelGatewayResponse> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 256 * 1024) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "reserved output byte budget is invalid",
    );
  }
  const contentType = response.headers.get("content-type");
  if (contentType === null || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response must be application/json",
    );
  }
  const fingerprint = decodeDynamicRouteFingerprint(response.headers, deployment);
  const logId = header(response.headers, "cf-aig-log-id", true);
  if (logId === undefined || !LOG_ID.test(logId)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway log identifier is invalid",
    );
  }
  const cacheStatus = header(response.headers, "cf-aig-cache-status", false);
  if (cacheStatus !== undefined && /hit/iu.test(cacheStatus)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway returned a cache hit despite explicit cache bypass",
    );
  }
  const successfulStep = header(response.headers, "cf-aig-step", false);
  const bodyBytes = await readBoundedBody(response, maximumBytes);
  let rawBody: unknown;
  try {
    rawBody = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes));
  } catch (cause) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response is not valid UTF-8 JSON",
      { cause },
    );
  }
  const body = exactObject(rawBody, RESPONSE_KEYS, "AI Gateway response");
  boundedString(body.id, "AI Gateway response id", 256);
  if (body.object !== "chat.completion") {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response object is not chat.completion",
    );
  }
  nonnegativeInteger(body.created, "AI Gateway response created");
  const responseModel = boundedString(body.model, "AI Gateway response model", 256);
  if (!IDENTIFIER.test(responseModel)) {
    modelGatewayExecutionFailure(
      "MODEL_GATEWAY_RESPONSE_INVALID",
      "AI Gateway response model is not a bounded model identifier",
    );
  }
  const assistantContent = decodeAssistantContent(body.choices);
  const usage = decodeUsage(body.usage);
  return Object.freeze({
    body_bytes: bodyBytes,
    body_sha256: await modelGatewaySha256(bodyBytes),
    assistant_content: assistantContent,
    response_model: responseModel,
    usage,
    fingerprint,
    log_id: logId,
    ...(cacheStatus === undefined ? {} : { cache_status: cacheStatus }),
    ...(successfulStep === undefined ? {} : { successful_step: successfulStep }),
  });
}
