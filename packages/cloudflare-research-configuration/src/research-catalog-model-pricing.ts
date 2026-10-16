const SOURCE_URL = "https://models.dev/api.json" as const;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_JSON_DEPTH = 128;
const MAX_PRICE_TOKEN_LENGTH = 512;
const MAX_PRICE_EXPONENT = 512;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

const SOURCE_PROVIDER_BY_LOGICAL_PROVIDER = {
  "opencode-go": "opencode-go",
  "opencode-zen": "opencode",
  openai: "openai",
  anthropic: "anthropic",
  openrouter: "openrouter",
} as const;

export type ResearchCatalogModelPricingProviderId = keyof typeof SOURCE_PROVIDER_BY_LOGICAL_PROVIDER;
export type ResearchCatalogAdvertisedApiMode = "chat" | "responses" | "messages" | "unsupported";

export type ResearchCatalogModelPricingFailureCode =
  | "UNSUPPORTED_PROVIDER"
  | "INVALID_MODEL_ID"
  | "SOURCE_UNAVAILABLE"
  | "SOURCE_ABORTED"
  | "SOURCE_REDIRECT_REJECTED"
  | "SOURCE_HTTP_ERROR"
  | "SOURCE_TOO_LARGE"
  | "SOURCE_INVALID"
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_ID_MISMATCH"
  | "MODEL_NOT_FOUND"
  | "MODEL_ID_MISMATCH"
  | "INVALID_PRICING"
  | "UNSUPPORTED_PRICING"
  | "INVALID_MODEL_METADATA"
  | "INVALID_OBSERVED_AT"
  | "DIGEST_UNAVAILABLE";

export class ResearchCatalogModelPricingError extends Error {
  public readonly code: ResearchCatalogModelPricingFailureCode;

  public constructor(code: ResearchCatalogModelPricingFailureCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ResearchCatalogModelPricingError";
    this.code = code;
  }
}

export interface ResearchCatalogModelPricingRates {
  /** Exact decimal USD per 1,000 input tokens; sourced from the published input price. */
  readonly input: string;
  /** Exact decimal USD per 1,000 output tokens; sourced from the published output price. */
  readonly output: string;
  /** Exact decimal USD per 1,000 cache-read tokens, or null when the source omits it. */
  readonly cache_read: string | null;
}

export interface ResearchCatalogAdvertisedCapabilities {
  /** These flags describe public catalog metadata only; they are not qualification or access evidence. */
  readonly status: "advertised_unverified";
  readonly api_mode: ResearchCatalogAdvertisedApiMode;
  readonly api_mode_reason: "google_sdk_unsupported" | "sdk_not_advertised" | "sdk_unsupported" | null;
  readonly attachment: boolean | null;
  readonly reasoning: boolean | null;
  readonly tool_call: boolean | null;
  readonly structured_output: boolean | null;
  readonly temperature: boolean | null;
  readonly input_modalities: readonly string[] | null;
  readonly output_modalities: readonly string[] | null;
  readonly context_limit: number | null;
  readonly input_limit: number | null;
  readonly output_limit: number | null;
}

export interface ResearchCatalogModelPricingObservation {
  readonly source_url: typeof SOURCE_URL;
  /** SHA-256 of the complete bounded UTF-8 source response bytes. */
  readonly source_sha256: string;
  /** SHA-256 of the exact selected model JSON record, including its internal source whitespace. */
  readonly model_record_sha256: string;
  readonly observed_at: string;
  /** The caller-facing logical provider ID, including opencode-zen for models.dev's opencode key. */
  readonly provider_id: ResearchCatalogModelPricingProviderId;
  readonly model_id: string;
  readonly rates_usd_per_1k_tokens: ResearchCatalogModelPricingRates;
  readonly advertised_sdk: string | null;
  readonly advertised_api_base: string | null;
  readonly advertised_capabilities: ResearchCatalogAdvertisedCapabilities;
}

export interface ReadVerifiedCatalogModelPricingInput {
  readonly provider_id: string;
  readonly model_id: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

interface JsonSpan {
  readonly start: number;
  readonly end: number;
}

function skipWhitespace(source: string, offset: number): number {
  while (source[offset] === " " || source[offset] === "\t" || source[offset] === "\n" || source[offset] === "\r") {
    offset += 1;
  }
  return offset;
}

function skipString(source: string, start: number): number {
  let escaped = false;
  for (let offset = start + 1; offset < source.length; offset += 1) {
    const character = source[offset];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === "\"") return offset + 1;
  }
  fail("SOURCE_INVALID", "catalog contains an unterminated JSON string");
}

function skipJsonValue(source: string, start: number): number {
  const offset = skipWhitespace(source, start);
  const first = source[offset];
  if (first === "\"") return skipString(source, offset);
  if (first === "{" || first === "[") {
    const stack: string[] = [first === "{" ? "}" : "]"];
    let cursor = offset + 1;
    while (cursor < source.length && stack.length > 0) {
      const character = source[cursor];
      if (character === "\"") cursor = skipString(source, cursor);
      else if (character === "{") {
        stack.push("}");
        cursor += 1;
      } else if (character === "[") {
        stack.push("]");
        cursor += 1;
      } else if (character === "}" || character === "]") {
        if (stack.pop() !== character) fail("SOURCE_INVALID", "catalog JSON containers do not match");
        cursor += 1;
      } else {
        cursor += 1;
      }
      if (stack.length > MAX_JSON_DEPTH) fail("SOURCE_INVALID", "catalog JSON exceeds the nesting bound");
    }
    if (stack.length !== 0) fail("SOURCE_INVALID", "catalog contains an unterminated JSON container");
    return cursor;
  }
  let cursor = offset;
  while (cursor < source.length && !/[\s,\]}]/u.test(source[cursor] ?? "")) cursor += 1;
  return cursor;
}

function findObjectPropertySpan(source: string, object: JsonSpan, property: string): JsonSpan | undefined {
  let cursor = skipWhitespace(source, object.start);
  if (source[cursor] !== "{") fail("SOURCE_INVALID", "selected JSON value is not an object");
  cursor += 1;
  const seen = new Set<string>();
  let selected: JsonSpan | undefined;
  while (true) {
    cursor = skipWhitespace(source, cursor);
    if (source[cursor] === "}") return selected;
    if (source[cursor] !== "\"") fail("SOURCE_INVALID", "catalog object key is malformed");
    const keyEnd = skipString(source, cursor);
    let key: string;
    try {
      key = JSON.parse(source.slice(cursor, keyEnd)) as string;
    } catch (cause) {
      fail("SOURCE_INVALID", "catalog object key is malformed", cause);
    }
    if (seen.has(key)) fail("SOURCE_INVALID", "selected catalog object contains duplicate keys");
    seen.add(key);
    cursor = skipWhitespace(source, keyEnd);
    if (source[cursor] !== ":") fail("SOURCE_INVALID", "catalog object member is malformed");
    const start = skipWhitespace(source, cursor + 1);
    const end = skipJsonValue(source, start);
    if (key === property) selected = { start, end };
    cursor = skipWhitespace(source, end);
    if (source[cursor] === ",") cursor += 1;
    else if (source[cursor] !== "}") fail("SOURCE_INVALID", "catalog object is malformed");
  }
}

function assertUniqueJsonKeys(source: string, value: JsonSpan, depth = 0): void {
  if (depth > MAX_JSON_DEPTH) fail("SOURCE_INVALID", "selected model JSON exceeds the nesting bound");
  const start = skipWhitespace(source, value.start);
  if (source[start] !== "{" && source[start] !== "[") return;
  if (source[start] === "{") {
    let cursor = skipWhitespace(source, start + 1);
    const seen = new Set<string>();
    while (source[cursor] !== "}") {
      const keyEnd = skipString(source, cursor);
      const key = JSON.parse(source.slice(cursor, keyEnd)) as string;
      if (seen.has(key)) fail("SOURCE_INVALID", "selected model contains duplicate JSON object keys");
      seen.add(key);
      cursor = skipWhitespace(source, keyEnd);
      const itemStart = skipWhitespace(source, cursor + 1);
      const itemEnd = skipJsonValue(source, itemStart);
      assertUniqueJsonKeys(source, { start: itemStart, end: itemEnd }, depth + 1);
      cursor = skipWhitespace(source, itemEnd);
      if (source[cursor] === ",") cursor = skipWhitespace(source, cursor + 1);
      else break;
    }
    return;
  }
  let cursor = skipWhitespace(source, start + 1);
  while (source[cursor] !== "]") {
    const itemEnd = skipJsonValue(source, cursor);
    assertUniqueJsonKeys(source, { start: cursor, end: itemEnd }, depth + 1);
    cursor = skipWhitespace(source, itemEnd);
    if (source[cursor] === ",") cursor = skipWhitespace(source, cursor + 1);
    else break;
  }
}

function fail(code: ResearchCatalogModelPricingFailureCode, message: string, cause?: unknown): never {
  throw new ResearchCatalogModelPricingError(code, message, cause);
}

function asRecord(value: unknown, label: string, code: ResearchCatalogModelPricingFailureCode): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code, label + " is not an object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code, label + " is not a plain object");
  return value as Record<string, unknown>;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function pricePerThousand(raw: string | undefined, label: string): string {
  if (raw === undefined) fail("INVALID_PRICING", label + " is absent from the public cost record");
  if (raw.length > MAX_PRICE_TOKEN_LENGTH) {
    fail("UNSUPPORTED_PRICING", label + " exceeds the decimal precision bound");
  }
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/u.exec(raw);
  const numericValue = Number(raw);
  if (match === null || !Number.isFinite(numericValue)) {
    fail("INVALID_PRICING", label + " is not a finite nonnegative decimal price");
  }
  const exponent = match[3] === undefined ? 0 : Number(match[3]);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_PRICE_EXPONENT) {
    fail("UNSUPPORTED_PRICING", label + " uses an unsupported decimal exponent");
  }
  const fraction = match[2] ?? "";
  const digits = (match[1] + fraction).replace(/^0+/u, "");
  if (digits.length === 0) return "0";

  const scale = fraction.length - exponent + 3;
  if (scale <= 0) return digits + "0".repeat(-scale);
  if (scale >= digits.length) {
    const fraction = ("0".repeat(scale - digits.length) + digits).replace(/0+$/u, "");
    return fraction.length === 0 ? "0" : "0." + fraction;
  }
  const split = digits.length - scale;
  const whole = digits.slice(0, split);
  const decimal = digits.slice(split).replace(/0+$/u, "");
  return decimal.length === 0 ? whole : whole + "." + decimal;
}

function parseRates(model: Record<string, unknown>, modelSource: string): ResearchCatalogModelPricingRates {
  if (!hasOwn(model, "cost")) fail("INVALID_PRICING", "the selected model has no published cost record");
  const cost = asRecord(model.cost, "model cost", "INVALID_PRICING");
  const modelSpan = { start: 0, end: modelSource.length };
  const costSpan = findObjectPropertySpan(modelSource, modelSpan, "cost");
  if (costSpan === undefined) fail("INVALID_PRICING", "the selected model has no published cost record");
  const costSource = modelSource.slice(costSpan.start, costSpan.end);
  const costSourceSpan = { start: 0, end: costSource.length };
  const supportedKeys = new Set(["input", "output", "cache_read"]);
  if (Object.keys(cost).some((key) => !supportedKeys.has(key))) {
    fail("UNSUPPORTED_PRICING", "the selected model uses tiered or additional charge structures");
  }
  if (!hasOwn(cost, "input") || !hasOwn(cost, "output")) {
    fail("INVALID_PRICING", "published input and output prices are both required");
  }
  const inputSpan = findObjectPropertySpan(costSource, costSourceSpan, "input");
  const outputSpan = findObjectPropertySpan(costSource, costSourceSpan, "output");
  const cacheReadSpan = hasOwn(cost, "cache_read")
    ? findObjectPropertySpan(costSource, costSourceSpan, "cache_read")
    : undefined;
  return Object.freeze({
    input: pricePerThousand(inputSpan === undefined ? undefined : costSource.slice(inputSpan.start, inputSpan.end), "input price"),
    output: pricePerThousand(outputSpan === undefined ? undefined : costSource.slice(outputSpan.start, outputSpan.end), "output price"),
    cache_read: hasOwn(cost, "cache_read")
      ? pricePerThousand(cacheReadSpan === undefined ? undefined : costSource.slice(cacheReadSpan.start, cacheReadSpan.end), "cache-read price")
      : null,
  });
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | null {
  if (!hasOwn(record, key)) return null;
  if (typeof record[key] !== "boolean") fail("INVALID_MODEL_METADATA", "model " + key + " capability is malformed");
  return record[key] as boolean;
}

function optionalModalities(
  rawModalities: unknown,
  key: "input" | "output",
): readonly string[] | null {
  if (rawModalities === undefined) return null;
  const modalities = asRecord(rawModalities, "model modalities", "INVALID_MODEL_METADATA");
  if (!hasOwn(modalities, key)) return null;
  const values = modalities[key];
  if (!Array.isArray(values) || values.length > 32 ||
      values.some((value) => typeof value !== "string" || value.length === 0 || value.length > 64)) {
    fail("INVALID_MODEL_METADATA", "model " + key + " modalities are malformed");
  }
  return Object.freeze((values as string[]).slice());
}

function optionalLimit(rawLimit: unknown, key: "context" | "input" | "output"): number | null {
  if (rawLimit === undefined) return null;
  const limits = asRecord(rawLimit, "model limits", "INVALID_MODEL_METADATA");
  if (!hasOwn(limits, key)) return null;
  const value = limits[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("INVALID_MODEL_METADATA", "model " + key + " limit is not a nonnegative safe integer");
  }
  return value;
}

function optionalProviderString(provider: Record<string, unknown> | null, key: "npm" | "api"): string | null {
  if (provider === null || !hasOwn(provider, key)) return null;
  const value = provider[key];
  if (typeof value !== "string" || value.length < 1 || value.length > 512) {
    fail("INVALID_MODEL_METADATA", "model provider " + key + " metadata is malformed");
  }
  if (key === "api") {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch (cause) {
      fail("INVALID_MODEL_METADATA", "model provider API base is not a URL", cause);
    }
    if (parsed.protocol !== "https:" || parsed.hostname.length === 0 ||
        parsed.username.length > 0 || parsed.password.length > 0 || parsed.search.length > 0 || parsed.hash.length > 0) {
      fail("INVALID_MODEL_METADATA", "model provider API base is not an HTTPS base URL");
    }
  }
  return value;
}

function apiMode(sdk: string | null): {
  readonly mode: ResearchCatalogAdvertisedApiMode;
  readonly reason: ResearchCatalogAdvertisedCapabilities["api_mode_reason"];
} {
  if (sdk === "@ai-sdk/openai-compatible" || sdk === "@openrouter/ai-sdk-provider") return { mode: "chat", reason: null };
  if (sdk === "@ai-sdk/openai") return { mode: "responses", reason: null };
  if (sdk === "@ai-sdk/anthropic") return { mode: "messages", reason: null };
  if (sdk === null) return { mode: "unsupported", reason: "sdk_not_advertised" };
  if (sdk === "@ai-sdk/google") return { mode: "unsupported", reason: "google_sdk_unsupported" };
  return { mode: "unsupported", reason: "sdk_unsupported" };
}

function parseAdvertisedCapabilities(
  model: Record<string, unknown>,
  sdk: string | null,
): ResearchCatalogAdvertisedCapabilities {
  const selectedApiMode = apiMode(sdk);
  return Object.freeze({
    status: "advertised_unverified",
    api_mode: selectedApiMode.mode,
    api_mode_reason: selectedApiMode.reason,
    attachment: optionalBoolean(model, "attachment"),
    reasoning: optionalBoolean(model, "reasoning"),
    tool_call: optionalBoolean(model, "tool_call"),
    structured_output: optionalBoolean(model, "structured_output"),
    temperature: optionalBoolean(model, "temperature"),
    input_modalities: optionalModalities(model.modalities, "input"),
    output_modalities: optionalModalities(model.modalities, "output"),
    context_limit: optionalLimit(model.limit, "context"),
    input_limit: optionalLimit(model.limit, "input"),
    output_limit: optionalLimit(model.limit, "output"),
  });
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Preserve the validation or transport error that caused cancellation.
  }
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  const contentType = response.headers.get("content-type");
  if (contentType === null || contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    await cancelBody(response);
    fail("SOURCE_INVALID", "public catalog response is not application/json");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) {
      await cancelBody(response);
      fail("SOURCE_INVALID", "public catalog content length is malformed");
    }
    if (!Number.isSafeInteger(Number(contentLength)) || Number(contentLength) > MAX_RESPONSE_BYTES) {
      await cancelBody(response);
      fail("SOURCE_TOO_LARGE", "public catalog exceeds the 8 MiB response bound");
    }
  }
  if (response.body === null) fail("SOURCE_INVALID", "public catalog response body is missing");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) fail("SOURCE_INVALID", "public catalog yielded non-byte data");
      total += item.value.byteLength;
      if (!Number.isSafeInteger(total) || total > MAX_RESPONSE_BYTES) {
        fail("SOURCE_TOO_LARGE", "public catalog exceeds the 8 MiB response bound");
      }
      chunks.push(item.value.slice());
    }
    complete = true;
  } finally {
    if (!complete) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the original stream or size error.
      }
    }
    reader.releaseLock();
  }
  if (total < 1) fail("SOURCE_INVALID", "public catalog response body is empty");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  try {
    const input = bytes.slice().buffer as ArrayBuffer;
    const digest = await globalThis.crypto.subtle.digest("SHA-256", input);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch (cause) {
    fail("DIGEST_UNAVAILABLE", "SHA-256 is unavailable for the public catalog observation", cause);
  }
}

/**
 * Read exact public model metadata. Returned API modes and feature flags are
 * catalog advertisements only, not account access, billing, or qualification proof.
 */
export async function readVerifiedCatalogModelPricing(
  input: ReadVerifiedCatalogModelPricingInput,
): Promise<ResearchCatalogModelPricingObservation> {
  if (typeof input !== "object" || input === null || typeof input.provider_id !== "string" ||
      !Object.prototype.hasOwnProperty.call(SOURCE_PROVIDER_BY_LOGICAL_PROVIDER, input.provider_id)) {
    fail("UNSUPPORTED_PROVIDER", "logical provider is not supported by this reader");
  }
  const sourceProviderId = SOURCE_PROVIDER_BY_LOGICAL_PROVIDER[
    input.provider_id as ResearchCatalogModelPricingProviderId
  ];
  if (typeof input.model_id !== "string" || !MODEL_ID_PATTERN.test(input.model_id)) {
    fail("INVALID_MODEL_ID", "model ID is not a valid exact catalog identity");
  }

  const fetcher = input.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetcher(SOURCE_URL, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (cause) {
    fail(input.signal?.aborted ? "SOURCE_ABORTED" : "SOURCE_UNAVAILABLE",
      "public catalog request failed without retry", cause);
  }

  if (response.redirected || (response.url !== "" && response.url !== SOURCE_URL) ||
      (response.status >= 300 && response.status < 400)) {
    await cancelBody(response);
    fail("SOURCE_REDIRECT_REJECTED", "public catalog redirects are rejected");
  }
  if (response.status !== 200) {
    await cancelBody(response);
    fail("SOURCE_HTTP_ERROR", "public catalog did not return HTTP 200");
  }

  const bytes = await readBoundedResponse(response);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    fail("SOURCE_INVALID", "public catalog is not valid UTF-8", cause);
  }

  const sourceSha = await sha256Hex(bytes);
  let catalogValue: unknown;
  try {
    catalogValue = JSON.parse(source) as unknown;
  } catch (cause) {
    fail("SOURCE_INVALID", "public catalog is not valid JSON", cause);
  }
  const catalog = asRecord(catalogValue, "public catalog root", "SOURCE_INVALID");
  const fullSpan = { start: 0, end: source.length };
  const sourceProviderSpan = findObjectPropertySpan(source, fullSpan, sourceProviderId);
  if (sourceProviderSpan === undefined) fail("PROVIDER_NOT_FOUND", "the requested source provider is absent from the public catalog");
  const provider = asRecord(catalog[sourceProviderId], "source provider", "SOURCE_INVALID");
  if (provider.id !== sourceProviderId) {
    fail("PROVIDER_ID_MISMATCH", "the source provider record does not match its exact catalog key");
  }
  const modelsSpan = findObjectPropertySpan(source, sourceProviderSpan, "models");
  if (modelsSpan === undefined) fail("MODEL_NOT_FOUND", "the source provider has no model catalog");
  const models = asRecord(provider.models, "source provider models", "SOURCE_INVALID");
  const modelSpan = findObjectPropertySpan(source, modelsSpan, input.model_id);
  if (modelSpan === undefined) fail("MODEL_NOT_FOUND", "the exact model ID is absent from the selected source provider");
  const exactModelRecord = source.slice(modelSpan.start, modelSpan.end);
  assertUniqueJsonKeys(source, modelSpan);
  const model = asRecord(models[input.model_id], "selected model", "SOURCE_INVALID");
  if (model.id !== input.model_id) fail("MODEL_ID_MISMATCH", "selected model record ID does not match the exact requested ID");

  const providerMetadataSpan = findObjectPropertySpan(source, modelSpan, "provider");
  const providerMetadata = hasOwn(model, "provider")
    ? asRecord(model.provider, "model provider metadata", "INVALID_MODEL_METADATA")
    : null;
  if (providerMetadata !== null && providerMetadataSpan !== undefined) {
    findObjectPropertySpan(source, providerMetadataSpan, "npm");
  }
  const sdk = optionalProviderString(providerMetadata, "npm") ?? optionalProviderString(provider, "npm");
  const apiBase = optionalProviderString(providerMetadata, "api") ?? optionalProviderString(provider, "api");
  const rates = parseRates(model, exactModelRecord);
  const capabilities = parseAdvertisedCapabilities(model, sdk);

  let observedAt: string;
  try {
    const observedDate = (input.now ?? (() => new Date()))();
    if (!(observedDate instanceof Date) || !Number.isFinite(observedDate.getTime())) {
      fail("INVALID_OBSERVED_AT", "observation clock did not return a valid Date");
    }
    observedAt = observedDate.toISOString();
  } catch (cause) {
    if (cause instanceof ResearchCatalogModelPricingError) throw cause;
    fail("INVALID_OBSERVED_AT", "observation timestamp could not be read", cause);
  }

  const modelRecordSha = await sha256Hex(new TextEncoder().encode(exactModelRecord));
  return Object.freeze({
    source_url: SOURCE_URL,
    source_sha256: sourceSha,
    model_record_sha256: modelRecordSha,
    observed_at: observedAt,
    provider_id: input.provider_id as ResearchCatalogModelPricingProviderId,
    model_id: input.model_id,
    rates_usd_per_1k_tokens: rates,
    advertised_sdk: sdk,
    advertised_api_base: apiBase,
    advertised_capabilities: capabilities,
  });
}
