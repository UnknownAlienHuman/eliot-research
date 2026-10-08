import { canonicalModelGatewayJson } from "./model-gateway-request.js";
import {
  ProviderConfigRestError,
  providerConfigRestFailure,
  type ProviderConfigRestEffect,
} from "./provider-config-rest-contract.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_API_MESSAGES = 100;
const MAX_API_MESSAGE_BYTES = 4 * 1024;
const ENVELOPE_KEYS = new Set(["errors", "messages", "result", "result_info", "success"]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface ProviderConfigRestEnvelope {
  readonly result: unknown;
  readonly result_info: unknown;
}

export async function readProviderConfigRestEnvelope(
  response: Response,
  effect: ProviderConfigRestEffect,
): Promise<ProviderConfigRestEnvelope> {
  const raw = await readJson(response, effect);
  const envelope = exactObject(raw, effect);
  if (typeof envelope.success !== "boolean") {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_RESPONSE_INVALID",
      "Cloudflare provider-config success flag is invalid",
      { effect },
    );
  }
  messages(envelope.errors, "errors", effect);
  messages(envelope.messages, "messages", effect);
  if (!response.ok) {
    const ambiguous = effect === "CREATE" &&
      (response.status === 409 || response.status >= 500);
    providerConfigRestFailure(
      "PROVIDER_CONFIG_HTTP_FAILED",
      `Cloudflare provider-config control plane returned HTTP ${status(response.status)}`,
      {
        retryable: response.status >= 500,
        effect: ambiguous ? "CREATE" : "NONE",
        http_status: response.status,
      },
    );
  }
  if (envelope.success !== true ||
      (Array.isArray(envelope.errors) && envelope.errors.length !== 0)) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_API_FAILED",
      "Cloudflare provider-config control plane rejected the request",
      { effect },
    );
  }
  if (!("result" in envelope)) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_RESPONSE_INVALID",
      "Cloudflare provider-config result is missing",
      { effect },
    );
  }
  return Object.freeze({ result: envelope.result, result_info: envelope.result_info });
}

async function readJson(
  response: Response,
  effect: ProviderConfigRestEffect,
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && !/^(?:0|[1-9][0-9]*)$/u.test(declared)) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_RESPONSE_INVALID",
      "Cloudflare provider-config response has malformed content-length",
      { effect },
    );
  }
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_RESPONSE_TOO_LARGE",
      "Cloudflare provider-config response exceeds its byte bound",
      { effect },
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = response.body === null
      ? encoder.encode(await response.text())
      : await readStream(response.body, effect);
  } catch (error) {
    if (error instanceof ProviderConfigRestError) throw error;
    providerConfigRestFailure(
      "PROVIDER_CONFIG_TRANSPORT_FAILED",
      "Cloudflare provider-config response could not be read",
      { retryable: true, effect, cause: error },
    );
  }
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_RESPONSE_TOO_LARGE",
      "Cloudflare provider-config response exceeds its byte bound",
      { effect },
    );
  }
  let text: string;
  try { text = decoder.decode(bytes); }
  catch {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_RESPONSE_INVALID",
      "Cloudflare provider-config response is not valid UTF-8",
      { effect },
    );
  }
  try { return JSON.parse(text) as unknown; }
  catch {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_RESPONSE_INVALID",
      "Cloudflare provider-config response is not valid JSON",
      { effect },
    );
  }
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  effect: ProviderConfigRestEffect,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    if (!(part.value instanceof Uint8Array)) {
      await cancelQuietly(reader, "invalid response chunk");
      providerConfigRestFailure(
        "PROVIDER_CONFIG_RESPONSE_INVALID",
        "Cloudflare provider-config response returned a non-byte chunk",
        { effect },
      );
    }
    total += part.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await cancelQuietly(reader, "response too large");
      providerConfigRestFailure(
        "PROVIDER_CONFIG_RESPONSE_TOO_LARGE",
        "Cloudflare provider-config response exceeds its byte bound",
        { effect },
      );
    }
    chunks.push(part.value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function cancelQuietly(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: string,
): Promise<void> {
  try { await reader.cancel(reason); } catch { /* preserve primary failure */ }
}

function exactObject(raw: unknown, effect: ProviderConfigRestEffect): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_RESPONSE_INVALID",
      "Cloudflare provider-config envelope must be a plain object",
      { effect },
    );
  }
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_RESPONSE_INVALID",
      "Cloudflare provider-config envelope must be a plain object",
      { effect },
    );
  }
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !ENVELOPE_KEYS.has(key))) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_RESPONSE_INVALID",
      "Cloudflare provider-config envelope contains unsupported fields",
      { effect },
    );
  }
  return value;
}

function messages(raw: unknown, label: string, effect: ProviderConfigRestEffect): void {
  if (raw === undefined) return;
  if (!Array.isArray(raw) || raw.length > MAX_API_MESSAGES) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_RESPONSE_INVALID",
      `Cloudflare API ${label} is invalid`,
      { effect },
    );
  }
  for (const entry of raw) {
    if (encoder.encode(canonicalModelGatewayJson(entry)).byteLength > MAX_API_MESSAGE_BYTES) {
      providerConfigRestFailure(
        "PROVIDER_CONFIG_RESPONSE_INVALID",
        `Cloudflare API ${label} exceeds its bound`,
        { effect },
      );
    }
  }
}

function status(raw: number): number {
  return Number.isSafeInteger(raw) && raw >= 100 && raw <= 599 ? raw : 500;
}
