import {
  readResponseBodyWithinBytes,
  RuntimeLimitError,
} from "@eliotr/platform-cloudflare";
import {
  canonicalModelGatewayJson,
} from "./model-gateway-request.js";
import {
  CustomProviderRestError,
  customProviderRestFailure,
  type CustomProviderRestEffect,
  type CustomProviderRestEnvelope,
} from "./custom-provider-rest-contract.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_API_MESSAGES = 100;
const MAX_API_MESSAGE_BYTES = 4 * 1024;
const ENVELOPE_KEYS = new Set([
  "errors", "messages", "result", "result_info", "success",
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export async function readCustomProviderRestEnvelope(
  response: Response,
  effect: CustomProviderRestEffect,
): Promise<CustomProviderRestEnvelope> {
  const raw = await readJson(response, effect);
  const value = exactObject(raw, "Cloudflare API envelope", effect);
  if (typeof value.success !== "boolean") {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_RESPONSE_INVALID",
      "Cloudflare API success flag is invalid",
      { effect },
    );
  }
  decodeMessages(value.errors, "errors", effect);
  decodeMessages(value.messages, "messages", effect);
  if (!response.ok) {
    const ambiguous = effect === "CREATE" &&
      (response.status === 409 || response.status >= 500);
    customProviderRestFailure(
      "CUSTOM_PROVIDER_HTTP_FAILED",
      `Cloudflare custom-provider control plane returned HTTP ${boundedStatus(response.status)}`,
      {
        retryable: response.status >= 500,
        effect: ambiguous ? "CREATE" : "NONE",
        http_status: response.status,
      },
    );
  }
  if (
    value.success !== true ||
    (Array.isArray(value.errors) && value.errors.length !== 0)
  ) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_API_FAILED",
      "Cloudflare custom-provider control plane rejected the request",
      { effect },
    );
  }
  if (!("result" in value)) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_RESPONSE_INVALID",
      "Cloudflare API result is missing",
      { effect },
    );
  }
  return Object.freeze({
    result: value.result,
    result_info: value.result_info,
  });
}

async function readJson(
  response: Response,
  effect: CustomProviderRestEffect,
): Promise<unknown> {
  let bytes: Uint8Array;
  try {
    bytes = await readResponseBodyWithinBytes(response, {
      label: "cloudflare.custom-provider.response",
      max_bytes: MAX_RESPONSE_BYTES,
    });
  } catch (error) {
    if (error instanceof CustomProviderRestError) throw error;
    if (error instanceof RuntimeLimitError) {
      switch (error.code) {
        case "LIMIT_EXCEEDED":
        case "STREAM_CHUNK_LIMIT_EXCEEDED":
          return customProviderRestFailure(
            "CUSTOM_PROVIDER_RESPONSE_TOO_LARGE",
            "Cloudflare custom-provider response exceeds its byte bound",
            { effect },
          );
        case "INVALID_CONTENT_LENGTH":
        case "STREAM_CHUNK_INVALID":
          return customProviderRestFailure(
            "CUSTOM_PROVIDER_RESPONSE_INVALID",
            "Cloudflare custom-provider response body is invalid",
            { effect },
          );
      }
    }
    customProviderRestFailure(
      "CUSTOM_PROVIDER_TRANSPORT_FAILED",
      "Cloudflare custom-provider response body could not be read",
      { retryable: true, effect, cause: error },
    );
  }

  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_RESPONSE_INVALID",
      "Cloudflare custom-provider response is not valid UTF-8",
      { effect },
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_RESPONSE_INVALID",
      "Cloudflare custom-provider response is not valid JSON",
      { effect },
    );
  }
}

function decodeMessages(
  raw: unknown,
  label: string,
  effect: CustomProviderRestEffect,
): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw) || raw.length > MAX_API_MESSAGES) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_RESPONSE_INVALID",
      `Cloudflare API ${label} is invalid`,
      { effect },
    );
  }
  for (const entry of raw) {
    if (
      encoder.encode(canonicalModelGatewayJson(entry)).byteLength >
      MAX_API_MESSAGE_BYTES
    ) {
      customProviderRestFailure(
        "CUSTOM_PROVIDER_RESPONSE_INVALID",
        `Cloudflare API ${label} exceeds its bound`,
        { effect },
      );
    }
  }
}

function exactObject(
  raw: unknown,
  label: string,
  effect: CustomProviderRestEffect,
): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_RESPONSE_INVALID",
      `${label} must be a plain object`,
      { effect },
    );
  }
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_RESPONSE_INVALID",
      `${label} must be a plain object`,
      { effect },
    );
  }
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !ENVELOPE_KEYS.has(key))) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_RESPONSE_INVALID",
      `${label} contains unsupported fields`,
      { effect },
    );
  }
  return value;
}

function boundedStatus(status: number): number {
  return Number.isSafeInteger(status) && status >= 100 && status <= 599
    ? status
    : 500;
}
