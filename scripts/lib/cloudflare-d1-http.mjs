import { URL } from "node:url";
import { TextEncoder } from "node:util";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MAX_SQL_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const UTF8 = new TextEncoder();

export class CloudflareD1HttpError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CloudflareD1HttpError";
    this.code = code;
    this.status = options.status ?? null;
  }
}

function fail(code, message, options) {
  throw new CloudflareD1HttpError(code, message, options);
}

function boundedIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail("D1_HTTP_INPUT_INVALID", `${label} is not a bounded Cloudflare identifier`);
  }
  return value;
}

function apiUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (cause) {
    fail("D1_HTTP_INPUT_INVALID", "Cloudflare API base URL is invalid", { cause });
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    fail("D1_HTTP_INPUT_INVALID", "Cloudflare API base URL must use HTTPS outside loopback tests");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    fail("D1_HTTP_INPUT_INVALID", "Cloudflare API base URL must not contain credentials");
  }
  parsed.pathname = parsed.pathname.replace(/\/$/u, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed;
}

function apiToken(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4096 ||
    /[\r\n]/u.test(value)
  ) {
    fail("D1_HTTP_INPUT_INVALID", "Cloudflare API token is missing or malformed");
  }
  return value;
}

function sqlText(value) {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    UTF8.encode(value).byteLength > MAX_SQL_BYTES
  ) {
    fail("D1_HTTP_INPUT_INVALID", "D1 SQL is empty or exceeds 64 KiB");
  }
  return value;
}

function bindValue(value, index) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  fail("D1_HTTP_INPUT_INVALID", `D1 bind parameter ${index} is not a JSON scalar`);
}

function exactObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("D1_HTTP_RESPONSE_INVALID", `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("D1_HTTP_RESPONSE_INVALID", `${label} must be a plain object`);
  }
  return value;
}

async function boundedResponseText(response) {
  let text;
  try {
    text = await response.text();
  } catch (cause) {
    fail("D1_HTTP_TRANSPORT_FAILED", "Cloudflare D1 response body could not be read", {
      status: response.status,
      cause,
    });
  }
  if (UTF8.encode(text).byteLength > MAX_RESPONSE_BYTES) {
    fail("D1_HTTP_RESPONSE_INVALID", "Cloudflare D1 response exceeds 1 MiB", {
      status: response.status,
    });
  }
  return text;
}

function errorSummary(payload) {
  const errors = payload && typeof payload === "object" ? payload.errors : undefined;
  if (!Array.isArray(errors)) return "unknown Cloudflare API error";
  return errors
    .slice(0, 8)
    .map((entry) => {
      if (entry && typeof entry === "object") {
        const code = entry.code === undefined ? "?" : String(entry.code);
        const message = entry.message === undefined ? "unknown error" : String(entry.message);
        return `${code}: ${message}`;
      }
      return String(entry);
    })
    .join("; ");
}

function decodeRows(response, payload) {
  const envelope = exactObject(payload, "Cloudflare D1 response");
  if (!response.ok || envelope.success !== true) {
    fail(
      "D1_HTTP_QUERY_FAILED",
      `Cloudflare D1 query failed (${response.status}): ${errorSummary(envelope)}`,
      { status: response.status },
    );
  }
  if (!Array.isArray(envelope.result) || envelope.result.length !== 1) {
    fail("D1_HTTP_RESPONSE_INVALID", "Cloudflare D1 response must contain exactly one query result", {
      status: response.status,
    });
  }
  const result = exactObject(envelope.result[0], "Cloudflare D1 query result");
  if (result.success !== true || !Array.isArray(result.results)) {
    fail("D1_HTTP_QUERY_FAILED", "Cloudflare D1 query result is unsuccessful or omits rows", {
      status: response.status,
    });
  }
  return result.results.map((row, index) => exactObject(row, `Cloudflare D1 row ${index}`));
}

export function createCloudflareD1HttpDatabase(options) {
  const accountId = boundedIdentifier(options?.account_id, "account_id");
  const databaseId = boundedIdentifier(options?.database_id, "database_id");
  const token = apiToken(options?.api_token);
  const base = apiUrl(options?.api_base_url ?? "https://api.cloudflare.com/client/v4");
  const fetchImpl = options?.fetch_impl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    fail("D1_HTTP_INPUT_INVALID", "fetch implementation is unavailable");
  }
  if (typeof globalThis.AbortSignal?.timeout !== "function") {
    fail("D1_HTTP_INPUT_INVALID", "AbortSignal.timeout is unavailable");
  }
  const timeoutMs = options?.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    fail("D1_HTTP_INPUT_INVALID", "D1 HTTP timeout must be an integer in [1, 120000]");
  }
  const endpoint = new URL(
    `${base.pathname}/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
    base,
  );

  async function query(sql, params) {
    const statement = sqlText(sql);
    const values = params.map(bindValue);
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql: statement, params: values }),
        signal: globalThis.AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      fail("D1_HTTP_TRANSPORT_FAILED", "Cloudflare D1 query transport failed", { cause });
    }
    const text = await boundedResponseText(response);
    let payload;
    try {
      payload = text.length === 0 ? null : JSON.parse(text);
    } catch (cause) {
      fail("D1_HTTP_RESPONSE_INVALID", "Cloudflare D1 response is not JSON", {
        status: response.status,
        cause,
      });
    }
    return decodeRows(response, payload);
  }

  function preparedStatement(sql, params = []) {
    return Object.freeze({
      bind(...values) {
        return preparedStatement(sql, values);
      },
      async first() {
        const rows = await query(sql, params);
        return rows[0] ?? null;
      },
    });
  }

  return Object.freeze({
    prepare(sql) {
      sqlText(sql);
      return preparedStatement(sql);
    },
  });
}
