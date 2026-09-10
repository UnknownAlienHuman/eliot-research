import { ApiRequestError, requestApi } from "./api.js";

export interface GoogleOAuthBegin {
  readonly protocol: "eliotr.google-oauth-start.v1";
  readonly authorizationUrl: string;
  readonly expiresAt: string;
  readonly intentId: string;
}

type JsonRecord = Record<string, unknown>;

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const GOOGLE_AUTHORIZATION_ORIGIN = "https://accounts.google.com";
const GOOGLE_AUTHORIZATION_PATH = "/o/oauth2/v2/auth";
const SECRET_QUERY_PATTERN = /secret|token|credential/iu;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(record: JsonRecord, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedSet.has(key)) ||
      allowed.some((key) => !Object.hasOwn(record, key))) {
    throw new ApiRequestError({
      status: 502,
      code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: `${label} has missing or unknown fields`,
    });
  }
}

function requiredString(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
      value.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ApiRequestError({
      status: 502,
      code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: `${label} is not a valid bounded string`,
    });
  }
  return value;
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

function envelopeTraceId(value: unknown, label: string): string {
  const trace = requiredString(value, label, 128);
  if (!SAFE_TRACE_ID.test(trace)) {
    throw new ApiRequestError({
      status: 502,
      code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: `${label} is invalid`,
    });
  }
  return trace;
}

/** Strict decoder for the G1 begin envelope. Unknown load-bearing fields fail closed. */
export function decodeGoogleOAuthBeginEnvelope(value: unknown): GoogleOAuthBegin {
  if (!isRecord(value)) {
    throw new ApiRequestError({
      status: 502,
      code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: "OAuth begin response must be an object",
    });
  }
  exactKeys(value, ["data", "trace_id", "deployment_generation"], "OAuth begin envelope");
  deploymentGeneration(value.deployment_generation, "envelope.deployment_generation");
  envelopeTraceId(value.trace_id, "envelope.trace_id");
  const data = value.data;
  if (!isRecord(data)) {
    throw new ApiRequestError({
      status: 502,
      code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: "OAuth begin data must be an object",
    });
  }
  exactKeys(data, ["protocol", "authorization_url", "expires_at", "intent_id"], "OAuth begin data");
  if (data.protocol !== "eliotr.google-oauth-start.v1") {
    throw new ApiRequestError({
      status: 502,
      code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: "OAuth begin protocol mismatch",
    });
  }
  const authorizationUrl = requiredString(data.authorization_url, "authorization_url", 4096);
  let url: URL;
  try {
    url = new URL(authorizationUrl);
  } catch {
    throw new ApiRequestError({
      status: 502,
      code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: "OAuth authorization URL is malformed",
    });
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
      url.origin !== GOOGLE_AUTHORIZATION_ORIGIN || url.host !== "accounts.google.com" ||
      url.pathname !== GOOGLE_AUTHORIZATION_PATH || url.hash !== "" ||
      url.searchParams.has("client_secret") || url.searchParams.has("refresh_token") ||
      url.searchParams.has("access_token") || url.searchParams.has("id_token") ||
      url.searchParams.has("code") ||
      [...url.searchParams.keys()].some((key) => SECRET_QUERY_PATTERN.test(key))) {
    throw new ApiRequestError({
      status: 502,
      code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: "OAuth authorization URL carries an unexpected secret",
    });
  }
  const expiresAt = requiredString(data.expires_at, "expires_at", 64);
  if (!Number.isFinite(Date.parse(expiresAt)) || new Date(Date.parse(expiresAt)).toISOString() !== expiresAt) {
    throw new ApiRequestError({
      status: 502,
      code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: "OAuth begin expiry must be a canonical ISO timestamp",
    });
  }
  const intentId = requiredString(data.intent_id, "intent_id", 64);
  if (!SAFE_IDENTIFIER.test(intentId)) {
    throw new ApiRequestError({
      status: 502,
      code: "API_RESPONSE_SCHEMA_MISMATCH",
      message: "OAuth begin intent_id is invalid",
    });
  }
  return { protocol: "eliotr.google-oauth-start.v1", authorizationUrl, expiresAt, intentId };
}

function newOperationRef(): string {
  const ref = crypto.randomUUID();
  if (!SAFE_IDENTIFIER.test(ref)) {
    throw new ApiRequestError({ status: 503, code: "API_REQUEST_ABORTED", message: "Could not mint an operation reference" });
  }
  return ref;
}

/**
 * Mint an OAuth begin operation reference before the first network attempt.
 * Callers keep the returned value in memory and reuse it for every retry, so a
 * timeout, lost response, or invalid envelope never mints a replacement
 * intent. Clear it only on explicit lifecycle reset (logout/unmount/pagehide).
 */
export function newGoogleOAuthOperationRef(): string {
  return newOperationRef();
}

/**
 * Same-origin, CSRF-protected begin transport. The operation reference is kept
 * in memory by the caller for stable retry; nothing is written to browser
 * storage and no token, secret, or code ever enters the app URL, logs, or
 * persistent client state.
 */
export async function beginGoogleOAuth(
  operationRef: string = newOperationRef(),
  signal?: AbortSignal,
): Promise<{ readonly operationRef: string; readonly begin: GoogleOAuthBegin }> {
  if (!SAFE_IDENTIFIER.test(operationRef)) {
    throw new ApiRequestError({ status: 400, code: "API_PATH_INVALID", message: "Invalid OAuth operation reference" });
  }
  const response = await requestApi("/api/v1/google/oauth/begin", {
    method: "POST",
    headers: { "content-type": "application/json", "x-eliotr-csrf": "1" },
    body: JSON.stringify({ operation_ref: operationRef }),
    ...(signal ? { signal } : {}),
  });
  return { operationRef, begin: decodeGoogleOAuthBeginEnvelope(response) };
}
