// Safe decoding helpers for Cloudflare usage source responses.
// Status alone never proves a missing OAuth scope, unsupported endpoint, or
// entitlement restriction. Those labels require a separately verified body
// shape and documented code; raw response bodies and URLs are never returned.

export const DEFAULT_USAGE_SOURCE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
export const MAX_USAGE_SOURCE_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

const TOP_LEVEL_FIELDS = Object.freeze(["success", "errors", "messages", "result", "result_info"]);
const INFO_FIELDS = Object.freeze(["count", "page", "per_page", "total_count"]);
const RESPONSE_INFO_FIELDS = Object.freeze(["code", "documentation_url", "message", "source"]);
const RESPONSE_SOURCE_FIELDS = Object.freeze(["pointer"]);

export class UsageSourceDecodeError extends Error {
  constructor(code, classification, httpStatus, message) {
    super(message);
    this.name = "UsageSourceDecodeError";
    this.code = code;
    this.classification = classification;
    this.httpStatus = httpStatus;
  }
}

function decodeFailure(code, classification, httpStatus, message) {
  return new UsageSourceDecodeError(code, classification, httpStatus, message);
}

function keysOf(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  try {
    return Object.keys(value);
  } catch {
    return [];
  }
}

function includesExact(list, value) {
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === value) return true;
  }
  return false;
}

function validateOnlyKnownFields(keys, allowed, httpStatus, message) {
  for (let i = 0; i < keys.length; i += 1) {
    if (!includesExact(allowed, keys[i])) {
      throw decodeFailure("MALFORMED", "malformed-data", httpStatus, message);
    }
  }
}

function hasKey(keys, key) {
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i] === key) return true;
  }
  return false;
}

function validateResponseInfoList(value, httpStatus) {
  if (!Array.isArray(value) || value.length > 100) {
    throw decodeFailure("MALFORMED", "malformed-data", httpStatus, "Cloudflare usage source response was malformed");
  }
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    const entryKeys = keysOf(entry);
    if (entryKeys.length === 0 || entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw decodeFailure("MALFORMED", "malformed-data", httpStatus, "Cloudflare usage source response was malformed");
    }
    validateOnlyKnownFields(entryKeys, RESPONSE_INFO_FIELDS, httpStatus, "Cloudflare usage source response was malformed");
    if (!hasKey(entryKeys, "code") || !Number.isInteger(entry["code"]) || entry["code"] < 1000 ||
      !hasKey(entryKeys, "message") || typeof entry["message"] !== "string") {
      throw decodeFailure("MALFORMED", "malformed-data", httpStatus, "Cloudflare usage source response was malformed");
    }
    if (hasKey(entryKeys, "documentation_url") && typeof entry["documentation_url"] !== "string") {
      throw decodeFailure("MALFORMED", "malformed-data", httpStatus, "Cloudflare usage source response was malformed");
    }
    if (hasKey(entryKeys, "source")) {
      const source = entry["source"];
      const sourceKeys = keysOf(source);
      if (source === null || typeof source !== "object" || Array.isArray(source)) {
        throw decodeFailure("MALFORMED", "malformed-data", httpStatus, "Cloudflare usage source response was malformed");
      }
      validateOnlyKnownFields(sourceKeys, RESPONSE_SOURCE_FIELDS, httpStatus, "Cloudflare usage source response was malformed");
      if (hasKey(sourceKeys, "pointer") && typeof source["pointer"] !== "string") {
        throw decodeFailure("MALFORMED", "malformed-data", httpStatus, "Cloudflare usage source response was malformed");
      }
    }
  }
  return value.length;
}

function decodeResultInfo(value, httpStatus) {
  if (value === undefined) return null;
  const keys = keysOf(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw decodeFailure("MALFORMED", "malformed-data", httpStatus, "Cloudflare usage source response was malformed");
  }
  validateOnlyKnownFields(keys, INFO_FIELDS, httpStatus, "Cloudflare usage source response was malformed");
  const decoded = {};
  for (let i = 0; i < INFO_FIELDS.length; i += 1) {
    const key = INFO_FIELDS[i];
    if (!hasKey(keys, key)) continue;
    const valueAtKey = value[key];
    const min = key === "page" ? 1 : key === "per_page" ? 10 : 0;
    const max = key === "per_page" ? 10000 : Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(valueAtKey) || valueAtKey < min || valueAtKey > max) {
      throw decodeFailure("MALFORMED", "malformed-data", httpStatus, "Cloudflare usage source response was malformed");
    }
    decoded[key] = valueAtKey;
  }
  return Object.freeze(decoded);
}

async function readBoundedUtf8Body(response, maxBytes, httpStatus) {
  let body;
  try {
    body = response?.body;
  } catch {
    throw decodeFailure("HTTP_BODY_READ_UNKNOWN", "unknown-transport-or-response-gap", httpStatus, "Cloudflare usage source response body could not be read");
  }
  if (body === null || typeof body !== "object") {
    throw decodeFailure("MALFORMED", "malformed-data", httpStatus, "Cloudflare usage source response was malformed");
  }
  let getReader;
  try {
    getReader = body.getReader;
  } catch {
    throw decodeFailure("HTTP_BODY_READ_UNKNOWN", "unknown-transport-or-response-gap", httpStatus, "Cloudflare usage source response body could not be read");
  }
  if (typeof getReader !== "function") {
    throw decodeFailure("MALFORMED", "malformed-data", httpStatus, "Cloudflare usage source response was malformed");
  }
  let reader;
  try {
    reader = Reflect.apply(getReader, body, []);
  } catch {
    throw decodeFailure("HTTP_BODY_READ_UNKNOWN", "unknown-transport-or-response-gap", httpStatus, "Cloudflare usage source response body could not be read");
  }
  if (reader === null || typeof reader !== "object") {
    throw decodeFailure("MALFORMED", "malformed-data", httpStatus, "Cloudflare usage source response was malformed");
  }
  let read;
  try {
    read = reader.read;
  } catch {
    throw decodeFailure("HTTP_BODY_READ_UNKNOWN", "unknown-transport-or-response-gap", httpStatus, "Cloudflare usage source response body could not be read");
  }
  if (typeof read !== "function") {
    throw decodeFailure("MALFORMED", "malformed-data", httpStatus, "Cloudflare usage source response was malformed");
  }

  const chunks = [];
  let totalBytes = 0;
  while (true) {
    let part;
    try {
      part = await Reflect.apply(read, reader, []);
    } catch {
      throw decodeFailure("HTTP_BODY_READ_UNKNOWN", "unknown-transport-or-response-gap", httpStatus, "Cloudflare usage source response body could not be read");
    }
    if (part === null || typeof part !== "object") {
      throw decodeFailure("MALFORMED", "malformed-data", httpStatus, "Cloudflare usage source response was malformed");
    }
    let done;
    let chunk;
    try {
      done = part.done;
      if (done !== true) chunk = part.value;
    } catch {
      throw decodeFailure("HTTP_BODY_READ_UNKNOWN", "unknown-transport-or-response-gap", httpStatus, "Cloudflare usage source response body could not be read");
    }
    if (typeof done !== "boolean") {
      throw decodeFailure("MALFORMED", "malformed-data", httpStatus, "Cloudflare usage source response was malformed");
    }
    if (done) break;
    if (!(chunk instanceof Uint8Array)) {
      throw decodeFailure("MALFORMED", "malformed-data", httpStatus, "Cloudflare usage source response was malformed");
    }
    let chunkLength;
    let chunkSnapshot;
    try {
      chunkLength = chunk.byteLength;
      if (chunkLength <= maxBytes - totalBytes) {
        // Snapshot each chunk before another stream turn can detach or alter
        // the provider-owned view retained in the accumulator.
        chunkSnapshot = new Uint8Array(chunk);
      }
      if (chunkSnapshot !== undefined && chunkSnapshot.byteLength !== chunkLength) {
        throw new Error("chunk size changed during snapshot");
      }
    } catch {
      throw decodeFailure("HTTP_BODY_READ_UNKNOWN", "unknown-transport-or-response-gap", httpStatus, "Cloudflare usage source response body could not be read");
    }
    if (chunkLength > maxBytes - totalBytes) {
      try {
        if (typeof reader.cancel === "function") await reader.cancel();
      } catch {
        // Cancellation is best-effort; the oversize response remains rejected.
      }
      throw decodeFailure("MALFORMED", "malformed-data", httpStatus, "Cloudflare usage source response exceeded its byte limit");
    }
    chunks[chunks.length] = chunkSnapshot;
    totalBytes += chunkLength;
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    bytes.set(chunks[i], offset);
    offset += chunks[i].byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw decodeFailure("MALFORMED", "malformed-data", httpStatus, "Cloudflare usage source response was malformed");
  }
}

/**
 * Classify an HTTP status without guessing why access failed.
 *
 * Returns null for success (2xx). For failures, the descriptor contains only
 * a safe code, generic classification, numeric status, and fixed diagnostic.
 * A 403 never asserts a missing owner approval or a particular permission.
 */
export function classifyCloudflareUsageHttpStatus(status) {
  if (Number.isInteger(status) && status >= 200 && status <= 299) return null;

  if (!Number.isInteger(status) || status < 100 || status > 599) {
    return Object.freeze({
      code: "HTTP_STATUS_UNKNOWN",
      classification: "unknown-transport-or-response-gap",
      httpStatus: null,
      message: "Cloudflare usage source response had no valid HTTP status",
    });
  }

  let code = "HTTP_STATUS_ERROR";
  let classification = "http-error";
  if (status === 401) {
    code = "HTTP_UNAUTHENTICATED";
    classification = "authentication-failure";
  } else if (status === 403) {
    code = "HTTP_FORBIDDEN";
    classification = "authorization-denial";
  } else if (status === 404) {
    code = "HTTP_NOT_FOUND";
    classification = "not-found";
  }
  const statusText = `HTTP ${status}`;
  let message;
  if (status === 401) message = `Cloudflare usage source authentication failed (${statusText})`;
  else if (status === 403) message = `Cloudflare usage source authorization was denied (${statusText})`;
  else if (status === 404) message = `Cloudflare usage source resource was not found (${statusText})`;
  else message = `Cloudflare usage source request failed (${statusText})`;

  return Object.freeze({ code, classification, httpStatus: status, message });
}

/**
 * Status-check, byte-bound, and parse a Cloudflare JSON response.
 *
 * This helper deliberately validates JSON syntax only. It exposes the parsed
 * body for a caller's source-specific strict schema decoder, but never returns
 * raw response text or provider error text. Non-success HTTP statuses are
 * classified before reading the body.
 */
export async function decodeCloudflareUsageJson(response, {
  maxBytes = DEFAULT_USAGE_SOURCE_RESPONSE_MAX_BYTES,
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_USAGE_SOURCE_RESPONSE_MAX_BYTES) {
    throw decodeFailure("COLLECTION_INVALID", "configuration-error", null, "Cloudflare usage decoder byte limit is invalid");
  }
  let status = null;
  try {
    if (response !== null && typeof response === "object" && Number.isInteger(response.status)) {
      status = response.status;
    }
  } catch {
    // A hostile or broken platform response cannot contribute status evidence.
  }
  const statusFailure = classifyCloudflareUsageHttpStatus(status);
  if (statusFailure !== null) {
    throw new UsageSourceDecodeError(statusFailure.code, statusFailure.classification, statusFailure.httpStatus, statusFailure.message);
  }
  const text = await readBoundedUtf8Body(response, maxBytes, status);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw decodeFailure("MALFORMED", "malformed-data", status, "Cloudflare usage source response was malformed");
  }
  return Object.freeze({ httpStatus: status, body });
}

/**
 * Read and decode a bounded Cloudflare API envelope.
 *
 * The body is consumed as a stream and rejected before JSON parsing if its
 * UTF-8 byte size exceeds `maxBytes`. Cloudflare's standard `errors`,
 * `messages`, `result`, and list `result_info` fields are validated. Only the
 * `result` payload and a copied, validated `resultInfo` are returned; error
 * messages are never retained or exposed.
 */
export async function decodeCloudflareUsageResult(response, {
  expectedResultKind,
  maxBytes = DEFAULT_USAGE_SOURCE_RESPONSE_MAX_BYTES,
} = {}) {
  if (expectedResultKind !== "array" && expectedResultKind !== "object") {
    throw decodeFailure("COLLECTION_INVALID", "configuration-error", null, "Cloudflare usage decoder result kind is invalid");
  }
  const { httpStatus: status, body } = await decodeCloudflareUsageJson(response, { maxBytes });
  const keys = keysOf(body);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw decodeFailure("MALFORMED", "malformed-data", status, "Cloudflare usage source response was malformed");
  }
  validateOnlyKnownFields(keys, TOP_LEVEL_FIELDS, status, "Cloudflare usage source response was malformed");
  if (!hasKey(keys, "success") || typeof body["success"] !== "boolean" ||
    !hasKey(keys, "errors") || !hasKey(keys, "messages")) {
    throw decodeFailure("MALFORMED", "malformed-data", status, "Cloudflare usage source response was malformed");
  }

  const errorCount = validateResponseInfoList(body["errors"], status);
  validateResponseInfoList(body["messages"], status);
  const resultInfo = hasKey(keys, "result_info") ? decodeResultInfo(body["result_info"], status) : null;
  if (body["success"] !== true || errorCount > 0) {
    throw decodeFailure("HTTP_RESPONSE_ERROR", "provider-data-gap", status, "Cloudflare usage source returned an unsuccessful response");
  }
  if (!hasKey(keys, "result")) {
    throw decodeFailure("MALFORMED", "malformed-data", status, "Cloudflare usage source response was malformed");
  }
  const result = body["result"];
  const resultKindMatches = expectedResultKind === "array"
    ? Array.isArray(result)
    : result !== null && typeof result === "object" && !Array.isArray(result);
  if (!resultKindMatches) {
    throw decodeFailure("MALFORMED", "malformed-data", status, "Cloudflare usage source response was malformed");
  }
  return Object.freeze({ httpStatus: status, result, resultInfo });
}
