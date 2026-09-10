export interface SystemHealth {
  readonly ready: boolean;
  readonly deployment_generation: string;
  readonly core_schema_generation: string | null;
  readonly search_schema_generation: string | null;
  readonly blocking_reason_codes: readonly string[];
  readonly checked_at: string;
}

export interface ApiEnvelope<T> {
  readonly data: T;
  readonly trace_id: string;
  readonly deployment_generation: string;
}

export class ApiRequestError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly traceId: string | null;
  public readonly retryable: boolean;

  public constructor(input: {
    readonly status: number;
    readonly code: string;
    readonly message: string;
    readonly traceId?: string | null;
    readonly retryable?: boolean;
  }) {
    super(input.message);
    this.name = "ApiRequestError";
    this.status = input.status;
    this.code = input.code;
    this.traceId = input.traceId ?? null;
    this.retryable = input.retryable ?? false;
  }
}

type JsonRecord = Record<string, unknown>;

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(record: JsonRecord, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).filter((key) => !allowedSet.has(key));
  const missing = allowed.filter((key) => !Object.hasOwn(record, key));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new ApiRequestError({
      status: 502,
      code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: `${label} has missing or unknown fields`,
    });
  }
}

function requiredString(value: unknown, label: string, maximumLength = 512): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ApiRequestError({
      status: 502,
      code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: `${label} is not a valid bounded string`,
    });
  }
  return value;
}

function nullableIdentifier(value: unknown, label: string): string | null {
  if (value === null) return null;
  const identifier = requiredString(value, label, 256);
  if (!SAFE_IDENTIFIER.test(identifier)) {
    throw new ApiRequestError({
      status: 502,
      code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: `${label} is not a valid identifier`,
    });
  }
  return identifier;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new ApiRequestError({
      status: 502,
      code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: `${label} is not a bounded string array`,
    });
  }
  const values = value.map((item, index) => requiredString(item, `${label}[${index}]`, 256));
  if (new Set(values).size !== values.length) {
    throw new ApiRequestError({
      status: 502,
      code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: `${label} contains duplicates`,
    });
  }
  return values;
}

function isoTimestamp(value: unknown, label: string): string {
  const timestamp = requiredString(value, label, 64);
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    throw new ApiRequestError({
      status: 502,
      code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: `${label} must be a canonical ISO timestamp`,
    });
  }
  return timestamp;
}

function deploymentGeneration(value: unknown, label: string): string {
  const generation = requiredString(value, label, 256);
  if (!SAFE_IDENTIFIER.test(generation)) {
    throw new ApiRequestError({
      status: 502,
      code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: `${label} is not a valid generation identifier`,
    });
  }
  return generation;
}

export function decodeSystemHealthEnvelope(value: unknown): SystemHealth {
  if (!isRecord(value)) {
    throw new ApiRequestError({
      status: 502,
      code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: "system health response must be an object",
    });
  }
  exactKeys(value, ["data", "trace_id", "deployment_generation"], "system health envelope");
  const envelopeGeneration = deploymentGeneration(
    value.deployment_generation,
    "envelope.deployment_generation",
  );
  const trace = requiredString(value.trace_id, "envelope.trace_id", 128);
  if (!SAFE_TRACE_ID.test(trace)) {
    throw new ApiRequestError({
      status: 502,
      code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: "envelope.trace_id is invalid",
    });
  }
  const data = value.data;
  if (!isRecord(data)) {
    throw new ApiRequestError({
      status: 502,
      code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: "system health data must be an object",
    });
  }
  exactKeys(data, [
    "ready",
    "deployment_generation",
    "core_schema_generation",
    "search_schema_generation",
    "blocking_reason_codes",
    "checked_at",
  ], "system health data");
  const ready = data.ready;
  if (typeof ready !== "boolean") {
    throw new ApiRequestError({
      status: 502,
      code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: "system health ready must be boolean",
    });
  }
  const healthGeneration = deploymentGeneration(
    data.deployment_generation,
    "data.deployment_generation",
  );
  if (healthGeneration !== envelopeGeneration) {
    throw new ApiRequestError({
      status: 502,
      code: "API_GENERATION_MISMATCH",
      message: "system health envelope and payload generations differ",
    });
  }
  return {
    ready,
    deployment_generation: healthGeneration,
    core_schema_generation: nullableIdentifier(
      data.core_schema_generation,
      "data.core_schema_generation",
    ),
    search_schema_generation: nullableIdentifier(
      data.search_schema_generation,
      "data.search_schema_generation",
    ),
    blocking_reason_codes: stringArray(
      data.blocking_reason_codes,
      "data.blocking_reason_codes",
    ),
    checked_at: isoTimestamp(data.checked_at, "data.checked_at"),
  };
}

export function decodeApiProblem(value: unknown, fallbackStatus: number): ApiRequestError {
  if (!isRecord(value)) {
    return new ApiRequestError({
      status: fallbackStatus,
      code: "MALFORMED_API_PROBLEM",
      message: "API returned a non-object error response",
    });
  }
  try {
    exactKeys(value, ["type", "title", "status", "code", "trace_id", "retryable"], "API problem");
    const problemType = requiredString(value.type, "problem.type", 256);
    if (!problemType.startsWith("urn:eliotr:problem:")) {
      throw new ApiRequestError({
        status: fallbackStatus,
        code: "MALFORMED_API_PROBLEM",
        message: "API problem type is invalid",
      });
    }
    const status = value.status;
    if (
      typeof status !== "number" ||
      !Number.isSafeInteger(status) ||
      status < 400 ||
      status > 599 ||
      status !== fallbackStatus
    ) {
      throw new ApiRequestError({
        status: fallbackStatus,
        code: "MALFORMED_API_PROBLEM",
        message: "API problem status does not match HTTP status",
      });
    }
    const retryable = value.retryable;
    if (typeof retryable !== "boolean") {
      throw new ApiRequestError({
        status: fallbackStatus,
        code: "MALFORMED_API_PROBLEM",
        message: "API problem retryable must be boolean",
      });
    }
    const trace = requiredString(value.trace_id, "problem.trace_id", 128);
    if (!SAFE_TRACE_ID.test(trace)) {
      throw new ApiRequestError({
        status: fallbackStatus,
        code: "MALFORMED_API_PROBLEM",
        message: "API problem trace_id is invalid",
      });
    }
    return new ApiRequestError({
      status,
      code: requiredString(value.code, "problem.code", 128),
      message: requiredString(value.title, "problem.title", 512),
      traceId: trace,
      retryable,
    });
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === "MALFORMED_API_PROBLEM") return error;
    return new ApiRequestError({
      status: fallbackStatus,
      code: "MALFORMED_API_PROBLEM",
      message: "API returned an invalid typed problem",
    });
  }
}

/** Authenticated same-origin transport; the deadline includes streaming body consumption. */
export async function requestApi(path: string, init: RequestInit = {}): Promise<unknown> {
  if (!path.startsWith("/api/v1/") || path.includes("\\") || path.includes("..")) {
    throw new ApiRequestError({ status: 400, code: "API_PATH_INVALID", message: "Invalid API path" });
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  if (init.signal?.aborted) abort();
  const timeout = setTimeout(abort, 30000);
  let rejectAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new Error("API request cancelled"));
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
    if (controller.signal.aborted) rejectAbort();
  });
  const bounded = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, cancelled]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await bounded(fetch(path, { ...init, signal: controller.signal, redirect: "manual",
      credentials: "same-origin", cache: "no-store", headers: { accept: "application/json", ...init.headers } }));
    const redirected = response.type === "opaqueredirect" || response.redirected || (response.status >= 300 && response.status < 400);
    if ((redirected || response.status === 401 || response.status === 403) && typeof window !== "undefined") {
      window.dispatchEvent(new Event("eliotr:authorization-cleared"));
    }
    if (redirected) {
      throw new ApiRequestError({ status: 401, code: "ACCESS_SESSION_REQUIRED", message: "Sign in to Cloudflare Access and reload this page" });
    }
    if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" || !response.body) {
      throw new ApiRequestError({ status: 502, code: "API_RESPONSE_SCHEMA_MISMATCH", message: "Expected an authenticated JSON API response" });
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^[0-9]+$/u.test(length) || Number(length) > 512 * 1024)) {
      throw new ApiRequestError({ status: 502, code: "API_RESPONSE_TOO_LARGE", message: "API response exceeds its byte budget" });
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0; let count = 0;
    while (true) {
      const next = await bounded(reader.read()); if (next.done) break;
      size += next.value.byteLength;
      if (++count > 4096 || size > 512 * 1024) {
        throw new ApiRequestError({ status: 502, code: "API_RESPONSE_TOO_LARGE", message: "API response exceeds its byte budget" });
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new ApiRequestError({ status: 502, code: "MALFORMED_JSON_RESPONSE", message: "API response is not valid UTF-8 JSON" }); }
    if (!response.ok) {
      throw decodeApiProblem(value, response.status);
    }
    if (response.status !== 200) throw new ApiRequestError({ status: 502, code: "API_STATUS_INVALID", message: "Unexpected API completion status" });
    return value;
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    throw new ApiRequestError({ status: 503, code: controller.signal.aborted ? "API_REQUEST_ABORTED" : "API_UNREACHABLE",
      message: "Request interrupted; retry with the same inputs", retryable: true });
  } finally {
    clearTimeout(timeout); init.signal?.removeEventListener("abort", abort);
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
    controller.abort(); if (reader) void reader.cancel().catch(() => {});
  }
}

export async function getSystemHealth(signal?: AbortSignal): Promise<SystemHealth> {
  return decodeSystemHealthEnvelope(await requestApi("/api/v1/system/health", signal ? { signal } : {}));
}
