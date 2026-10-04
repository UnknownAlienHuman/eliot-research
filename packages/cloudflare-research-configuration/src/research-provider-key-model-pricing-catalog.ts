const EXACT_MODEL_ID = "stealth/space-bunny-alpha" as const;
export const RESEARCH_PROVIDER_KEY_MODEL_PRICING_SOURCE_URL =
  "https://openrouter.ai/api/v1/models/stealth/space-bunny-alpha/endpoints" as const;

const MAX_RESPONSE_BYTES = 32_768;
const MAX_ENDPOINTS = 64;
const FETCH_TIMEOUT_MS = 8_000;
const REQUIRED_PARAMETERS = ["max_tokens", "reasoning_effort", "response_format"] as const;
const DATA_KEYS = new Set(["id", "name", "created", "description", "architecture", "endpoints"]);
const ENDPOINT_KEYS = new Set([
  "name", "model_id", "model_name", "context_length", "pricing", "provider_name", "tag", "quantization",
  "max_completion_tokens", "max_prompt_tokens", "supported_parameters", "supports_tool_choice", "status",
  "uptime_last_30m", "uptime_last_5m", "uptime_last_1d", "supports_implicit_caching", "native_tools",
  "supports_voice_cloning", "supports_multiple_audio_references", "supports_image_reference", "latency_last_30m",
  "throughput_last_30m",
]);
const PRICING_KEYS = new Set(["prompt", "completion", "discount"]);

export type ResearchProviderKeyModelPricingCatalogFailureCode = "FREE_PRICE_NOT_PROVEN" | "FREE_PRICE_NOT_ZERO";

export class ResearchProviderKeyModelPricingCatalogError extends Error {
  public readonly code: ResearchProviderKeyModelPricingCatalogFailureCode;
  public readonly retryable: boolean;

  public constructor(code: ResearchProviderKeyModelPricingCatalogFailureCode, message: string, retryable = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchProviderKeyModelPricingCatalogError";
    this.code = code;
    this.retryable = retryable;
  }
}

function fail(
  code: ResearchProviderKeyModelPricingCatalogFailureCode,
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new ResearchProviderKeyModelPricingCatalogError(code, message, retryable, cause);
}

function exactRecord(value: unknown, label: string, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("FREE_PRICE_NOT_PROVEN", `${label} is not an object`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.has(key))) fail("FREE_PRICE_NOT_PROVEN", `${label} contains unsupported fields`);
  return record;
}

function exactKeys(record: Record<string, unknown>, expected: ReadonlySet<string>, label: string): void {
  const keys = Object.keys(record);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) fail("FREE_PRICE_NOT_PROVEN", `${label} has an unsupported shape`);
}

function assertNoSunsetOrDisableMarker(record: Record<string, unknown>, label: string): void {
  for (const [key, value] of Object.entries(record)) {
    if (!/(?:sunset|deprecat|retir|end[_-]?of[_-]?life|disabled)/iu.test(key)) continue;
    if (value !== null && value !== false && value !== 0 && value !== "") fail("FREE_PRICE_NOT_PROVEN", `${label} contains a sunset or disabled marker`);
  }
}

function zeroDecimal(value: unknown): boolean {
  return typeof value === "string" && /^0(?:\.0{1,12})?$/u.test(value);
}

function parsePricing(value: unknown): void {
  const pricing = exactRecord(value, "endpoint pricing", PRICING_KEYS);
  exactKeys(pricing, PRICING_KEYS, "endpoint pricing");
  if (!zeroDecimal(pricing.prompt) || !zeroDecimal(pricing.completion)) {
    fail("FREE_PRICE_NOT_ZERO", "OpenRouter reports a nonzero or unsupported prompt/completion rate");
  }
  if (typeof pricing.discount !== "number" || !Number.isFinite(pricing.discount) || pricing.discount !== 0) {
    fail("FREE_PRICE_NOT_ZERO", "OpenRouter reports a nonzero or unsupported pricing adjustment");
  }
}

function parseCatalog(bytes: Uint8Array): void {
  let decoded: string;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (cause) { fail("FREE_PRICE_NOT_PROVEN", "OpenRouter pricing response is not UTF-8", false, cause); }
  let raw: unknown;
  try { raw = JSON.parse(decoded); }
  catch (cause) { fail("FREE_PRICE_NOT_PROVEN", "OpenRouter pricing response is not JSON", false, cause); }
  const root = exactRecord(raw, "OpenRouter response", new Set(["data"]));
  exactKeys(root, new Set(["data"]), "OpenRouter response");
  const data = exactRecord(root.data, "OpenRouter model data", DATA_KEYS);
  exactKeys(data, DATA_KEYS, "OpenRouter model data");
  if (data.id !== EXACT_MODEL_ID || !Array.isArray(data.endpoints) || data.endpoints.length < 1 || data.endpoints.length > MAX_ENDPOINTS) {
    fail("FREE_PRICE_NOT_PROVEN", "OpenRouter model or endpoint identity is unsupported");
  }
  if (typeof data.description !== "string" || /(?:sunset|deprecat|retir|end\s+of\s+life)/iu.test(data.description)) {
    fail("FREE_PRICE_NOT_PROVEN", "OpenRouter model description indicates unsupported or sunset status");
  }

  for (const rawEndpoint of data.endpoints) {
    const endpoint = exactRecord(rawEndpoint, "OpenRouter endpoint", ENDPOINT_KEYS);
    exactKeys(endpoint, ENDPOINT_KEYS, "OpenRouter endpoint");
    assertNoSunsetOrDisableMarker(endpoint, "OpenRouter endpoint");
    if (endpoint.model_id !== EXACT_MODEL_ID || endpoint.provider_name !== "Stealth" || endpoint.tag !== "stealth") {
      fail("FREE_PRICE_NOT_PROVEN", "OpenRouter returned an unselected endpoint for the pinned model");
    }
    if (typeof endpoint.status !== "number" || !Number.isFinite(endpoint.status)) {
      fail("FREE_PRICE_NOT_PROVEN", "OpenRouter endpoint status is missing or malformed");
    }
    const supportedParameters = endpoint.supported_parameters;
    if (!Array.isArray(supportedParameters) ||
        REQUIRED_PARAMETERS.some((parameter) => !supportedParameters.includes(parameter))) {
      fail("FREE_PRICE_NOT_PROVEN", "OpenRouter endpoint does not support the selected native request shape");
    }
    parsePricing(endpoint.pricing);
  }
}

/** Revalidate persisted response bytes with the same fixed-catalog rules as a fresh response. */
export function assertVerifiedZeroPriceCatalogBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_RESPONSE_BYTES) {
    fail("FREE_PRICE_NOT_PROVEN", "OpenRouter pricing response exceeds its byte bound");
  }
  parseCatalog(bytes);
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)) {
    fail("FREE_PRICE_NOT_PROVEN", "OpenRouter pricing response exceeds its byte bound");
  }
  const age = response.headers.get("age");
  if (age !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(age) || Number(age) > 0)) {
    fail("FREE_PRICE_NOT_PROVEN", "OpenRouter pricing response was served from a stale cache");
  }
  const contentType = response.headers.get("content-type");
  if (contentType === null || contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    fail("FREE_PRICE_NOT_PROVEN", "OpenRouter pricing response has an unsupported content type");
  }
  if (response.body === null) fail("FREE_PRICE_NOT_PROVEN", "OpenRouter pricing response body is missing");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) fail("FREE_PRICE_NOT_PROVEN", "OpenRouter response yielded non-byte data");
      total += item.value.byteLength;
      if (!Number.isSafeInteger(total) || total > MAX_RESPONSE_BYTES) fail("FREE_PRICE_NOT_PROVEN", "OpenRouter pricing response exceeds its byte bound");
      chunks.push(item.value.slice());
    }
    complete = true;
  } finally {
    if (!complete) {
      try { await reader.cancel(); } catch { /* Preserve the original read error. */ }
    }
    reader.releaseLock();
  }
  if (total < 1) fail("FREE_PRICE_NOT_PROVEN", "OpenRouter pricing response body is empty");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Read and validate the exact fixed OpenRouter catalog; returned bytes are the persisted provenance. */
export async function readVerifiedZeroPriceCatalog(): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await globalThis.fetch(RESEARCH_PROVIDER_KEY_MODEL_PRICING_SOURCE_URL, {
      method: "GET",
      headers: { accept: "application/json", "cache-control": "no-cache", pragma: "no-cache" },
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status !== 200 || response.redirected || (response.status >= 300 && response.status < 400) ||
        (response.url !== "" && response.url !== RESEARCH_PROVIDER_KEY_MODEL_PRICING_SOURCE_URL)) {
      fail("FREE_PRICE_NOT_PROVEN", "OpenRouter pricing metadata request did not return the fixed source");
    }
    const bytes = await readBoundedResponse(response);
    assertVerifiedZeroPriceCatalogBytes(bytes);
    return bytes;
  } catch (cause) {
    if (cause instanceof ResearchProviderKeyModelPricingCatalogError) throw cause;
    fail("FREE_PRICE_NOT_PROVEN", "OpenRouter pricing metadata is unavailable", true, cause);
  } finally {
    clearTimeout(timeout);
  }
}
