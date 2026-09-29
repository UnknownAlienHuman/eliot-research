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
  const declared = response.headers.get("content-length");
  if (declared !== null && !/^(?:0|[1-9][0-9]*)$/u.test(declared)) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_RESPONSE_INVALID",
      "Cloudflare custom-provider response has malformed content-length",
      { effect },
    );
  }
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_RESPONSE_TOO_LARGE",
      "Cloudflare custom-provider response exceeds its byte bound",
      { effect },
    );
  }

  let bytes: Uint8Array;
  try {
    if (response.body === null) {
      const text = await response.text();
      bytes = encoder.encode(text);
      if (bytes.byteLength > MAX_RESPONSE_BYTES) {
        customProviderRestFailure(
          "CUSTOM_PROVIDER_RESPONSE_TOO_LARGE",
          "Cloudflare custom-provider response exceeds its byte bound",
          { effect },
        );
      }
    } else {
      bytes = await readStream(response.body, effect);
    }
  } catch (error) {
    if (error instanceof CustomProviderRestError) throw error;
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

async function readStream(
  stream: ReadableStream<Uint8Array>,
  effect: CustomProviderRestEffect,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (!(chunk.value instanceof Uint8Array)) {
      await cancelQuietly(reader, "invalid response chunk");
      customProviderRestFailure(
        "CUSTOM_PROVIDER_RESPONSE_INVALID",
        "Cloudflare custom-provider response returned a non-byte chunk",
        { effect },
      );
    }
    total += chunk.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await cancelQuietly(reader, "response too large");
      customProviderRestFailure(
        "CUSTOM_PROVIDER_RESPONSE_TOO_LARGE",
        "Cloudflare custom-provider response exceeds its byte bound",
        { effect },
      );
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function cancelQuietly(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: string,
): Promise<void> {
  try { await reader.cancel(reason); } catch { /* preserve the primary failure */ }
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
