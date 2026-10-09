/** Exact legacy Connections semantics through injected owner HTTP, error and epoch ports. */
import type { LegacyErrorFactory, LegacyErrorDetails, LegacyHttpAdapter } from '../legacy/http';
import type { EpochPort } from '../transport/client';
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
const GOOGLE_CALLBACK_FRAGMENT = /^#eliotr-google-oauth=(authorized|denied|expired|conflict|retry|rejected)$/u;
export type GoogleOAuthCallbackOutcome = "authorized" | "denied" | "expired" | "conflict" | "retry" | "rejected";
export function createGoogleOAuthApi(http: Pick<LegacyHttpAdapter, 'requestApi'>, errors: LegacyErrorFactory, epoch: EpochPort, identity: { readonly mint: () => string }) {
const { requestApi } = http;

const fail = (details: Omit<LegacyErrorDetails, 'traceId' | 'retryable'> & Partial<Pick<LegacyErrorDetails, 'traceId' | 'retryable'>>): Error => errors({ traceId: null, retryable: false, ...details });
const closed = (): never => { throw fail({ status: 503, code: 'API_SESSION_CLOSED', message: 'Owner session is closed', retryable: false }); };
const currentResult = <T>(captured: object, result: T): T => { if (!epoch.isCurrent(captured)) closed(); return result; };
const currentCapture = (): object => { const captured = epoch.capture(); if (captured === undefined || !epoch.isCurrent(captured)) return closed(); return captured; };
const guarded = async <T>(captured: object, result: Promise<T>): Promise<T> => currentResult(captured, await result);
/** Read the fixed server callback outcome without accepting provider data. */
function readGoogleOAuthCallbackOutcome(hash: string): GoogleOAuthCallbackOutcome | null {
    const match = GOOGLE_CALLBACK_FRAGMENT.exec(hash);
    return match?.[1] as GoogleOAuthCallbackOutcome | undefined ?? null;
}
function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(record: JsonRecord, allowed: readonly string[], label: string): void {
    const allowedSet = new Set(allowed);
    if (Object.keys(record).some((key) => !allowedSet.has(key)) ||
        allowed.some((key) => !Object.hasOwn(record, key))) {
        throw fail({
            status: 502,
            code: "API_RESPONSE_SCHEMA_MISMATCH",
            message: `${label} has missing or unknown fields`,
        });
    }
}
function requiredString(value: unknown, label: string, maximumLength: number): string {
    if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
        value.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw fail({
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
        throw fail({
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
        throw fail({
            status: 502,
            code: "API_RESPONSE_SCHEMA_MISMATCH",
            message: `${label} is invalid`,
        });
    }
    return trace;
}
/** Strict decoder for the G1 begin envelope. Unknown load-bearing fields fail closed. */
function decodeGoogleOAuthBeginEnvelope(value: unknown): GoogleOAuthBegin {
    if (!isRecord(value)) {
        throw fail({
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
        throw fail({
            status: 502,
            code: "API_RESPONSE_SCHEMA_MISMATCH",
            message: "OAuth begin data must be an object",
        });
    }
    exactKeys(data, ["protocol", "authorization_url", "expires_at", "intent_id"], "OAuth begin data");
    if (data.protocol !== "eliotr.google-oauth-start.v1") {
        throw fail({
            status: 502,
            code: "API_RESPONSE_SCHEMA_MISMATCH",
            message: "OAuth begin protocol mismatch",
        });
    }
    const authorizationUrl = requiredString(data.authorization_url, "authorization_url", 4096);
    let url: URL;
    try {
        url = new URL(authorizationUrl);
    }
    catch {
        throw fail({
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
        throw fail({
            status: 502,
            code: "API_RESPONSE_SCHEMA_MISMATCH",
            message: "OAuth authorization URL carries an unexpected secret",
        });
    }
    const expiresAt = requiredString(data.expires_at, "expires_at", 64);
    if (!Number.isFinite(Date.parse(expiresAt)) || new Date(Date.parse(expiresAt)).toISOString() !== expiresAt) {
        throw fail({
            status: 502,
            code: "API_RESPONSE_SCHEMA_MISMATCH",
            message: "OAuth begin expiry must be a canonical ISO timestamp",
        });
    }
    const intentId = requiredString(data.intent_id, "intent_id", 64);
    if (!SAFE_IDENTIFIER.test(intentId)) {
        throw fail({
            status: 502,
            code: "API_RESPONSE_SCHEMA_MISMATCH",
            message: "OAuth begin intent_id is invalid",
        });
    }
    return { protocol: "eliotr.google-oauth-start.v1", authorizationUrl, expiresAt, intentId };
}
function newOperationRef(): string {
    const ref = identity.mint();
    if (!SAFE_IDENTIFIER.test(ref)) {
        throw fail({ status: 503, code: "API_REQUEST_ABORTED", message: "Could not mint an operation reference" });
    }
    return ref;
}
/**
 * Mint an OAuth begin operation reference before the first network attempt.
 * Callers keep the returned value in memory and reuse it for every retry, so a
 * timeout, lost response, or invalid envelope never mints a replacement
 * intent. Clear it only on explicit lifecycle reset (logout/unmount/pagehide).
 */
function newGoogleOAuthOperationRef(): string {
    return newOperationRef();
}
/**
 * Same-origin, CSRF-protected begin transport. The operation reference is kept
 * in memory by the caller for stable retry; nothing is written to browser
 * storage and no token, secret, or code ever enters the app URL, logs, or
 * persistent client state.
 */
async function beginGoogleOAuth(operationRef: string | undefined = undefined, signal?: AbortSignal): Promise<{
    readonly operationRef: string;
    readonly begin: GoogleOAuthBegin;
}> {
    const captured = currentCapture();
    operationRef ??= newOperationRef();
    if (!SAFE_IDENTIFIER.test(operationRef)) {
        throw fail({ status: 400, code: "API_PATH_INVALID", message: "Invalid OAuth operation reference" });
    }
    const response = await guarded(captured, requestApi("/api/v1/google/oauth/begin", {
        method: "POST",
        headers: { "content-type": "application/json", "x-eliotr-csrf": "1" },
        body: JSON.stringify({ operation_ref: operationRef }),
        ...(signal ? { signal } : {}),
    }));
    return currentResult(captured, { operationRef, begin: decodeGoogleOAuthBeginEnvelope(response) });
}
return { readGoogleOAuthCallbackOutcome, decodeGoogleOAuthBeginEnvelope, newGoogleOAuthOperationRef, beginGoogleOAuth };
}
