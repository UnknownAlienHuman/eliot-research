import { encryptedToken, GoogleCredentialError, tokenBinding, type EncryptedRefreshToken } from "./token-vault.js";
import type { GoogleCredentialSnapshot } from "./token-credentials.js";

/** Explicit operator configuration. Production evidence is an operator attestation, not a Google token claim. */
export interface GoogleOAuthConfiguration {
  readonly connection_id: string;
  readonly oauth_client_id: string;
  readonly redirect_uri: string;
  readonly google_subject: string;
  readonly google_email: string;
  readonly deployment_generation: string;
  readonly production_evidence_ref: string;
  readonly oauth_publishing_status: "In production";
  readonly environment: "development" | "staging" | "production";
}
/** Supplied only after current owner authentication, never decoded from the OAuth query. */
export interface GoogleOAuthOwner {
  readonly principal_id: string;
  readonly session_generation: string;
}
export interface GoogleOAuthIntent {
  readonly intent_id: string;
  readonly operation_ref: string;
  readonly configuration: GoogleOAuthConfiguration;
  readonly owner: GoogleOAuthOwner;
  readonly state_sha256: string;
  readonly secrets: EncryptedRefreshToken;
  readonly created_at_epoch_ms: number;
  readonly expires_at_epoch_ms: number;
  readonly status: "PENDING" | "EXCHANGING" | "ADMITTED" | "DENIED" | "FAILED";
  readonly attempt_id: string | null;
  readonly code_sha256: string | null;
  readonly id_token_sha256: string | null;
  readonly credential_sha256: string | null;
}
export interface GoogleOAuthAdmissionReceipt {
  readonly protocol: "eliotr.google-oauth-admission.v1";
  readonly intent_id: string;
  readonly connection_id: string;
  readonly credential_generation: string;
  readonly connector_state: "AUTHORIZING";
  readonly exchange_ready: false;
}
export interface GoogleOAuthIntentStore {
  put(intent: GoogleOAuthIntent, signal: AbortSignal): Promise<GoogleOAuthIntent>;
  find(stateHash: string, signal: AbortSignal): Promise<GoogleOAuthIntent>;
  claim(intent: GoogleOAuthIntent, attemptId: string, codeHash: string, signal: AbortSignal): Promise<GoogleOAuthIntent>;
  assertClaim(intent: GoogleOAuthIntent, signal: AbortSignal): Promise<void>;
  deny(intent: GoogleOAuthIntent, signal: AbortSignal): Promise<void>;
  admit(intent: GoogleOAuthIntent, credential: GoogleCredentialSnapshot, idTokenHash: string, signal: AbortSignal): Promise<void>;
  readAdmission(intent: GoogleOAuthIntent, signal: AbortSignal): Promise<GoogleOAuthAdmissionReceipt>;
  /** Reconnect-only metadata is resolved from durable intent state; absent for initial admission. */
  readonly expectedCredentialRevision?: (intent: GoogleOAuthIntent, signal: AbortSignal) => Promise<number | null>;
}
export const oauthFail = (code: string): never => { throw new GoogleCredentialError(code); };
export function oauthIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value)) return oauthFail("GOOGLE_OAUTH_INPUT_INVALID");
  return value;
}
export function oauthClock(now: () => number): number {
  const time = now();
  if (!Number.isSafeInteger(time) || time < 0 || time > 8640000000000000 - 600000) return oauthFail("GOOGLE_CLOCK_INVALID");
  return time;
}
export function oauthConfiguration(input: GoogleOAuthConfiguration): GoogleOAuthConfiguration {
  const names = ["connection_id", "oauth_client_id", "redirect_uri", "google_subject", "google_email", "deployment_generation",
    "production_evidence_ref", "oauth_publishing_status", "environment"] as const;
  if (!input || Object.keys(input).length !== names.length || names.some((key) => !Object.hasOwn(input, key))) return oauthFail("GOOGLE_OAUTH_CONFIG_INVALID");
  try {
    tokenBinding({ connection_id: input.connection_id, principal_id: "configuration-check", oauth_client_id: input.oauth_client_id,
      google_subject: input.google_subject, google_email: input.google_email, credential_generation: "configuration-check" });
    oauthIdentifier(input.connection_id); oauthIdentifier(input.deployment_generation); oauthIdentifier(input.production_evidence_ref);
    if (!/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/u.test(input.oauth_client_id) || input.google_subject.length > 255
        || input.oauth_publishing_status !== "In production" || !["development", "staging", "production"].includes(input.environment)
        || typeof input.redirect_uri !== "string" || input.redirect_uri.length > 1024 || /[\\\u0000-\u0020\u007f]/u.test(input.redirect_uri)) throw new Error();
    const url = new URL(input.redirect_uri);
    const local = input.environment === "development" && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((!local && url.protocol !== "https:") || url.username || url.password || url.hash || url.search
        || url.pathname === "/" || url.href !== input.redirect_uri) throw new Error();
  } catch { return oauthFail("GOOGLE_OAUTH_CONFIG_INVALID"); }
  return Object.freeze(Object.fromEntries(names.map((key) => [key, input[key]]))) as unknown as GoogleOAuthConfiguration;
}
export function oauthOwner(input: GoogleOAuthOwner): GoogleOAuthOwner {
  if (!input || Object.keys(input).length !== 2 || !Object.hasOwn(input, "principal_id") || !Object.hasOwn(input, "session_generation")) {
    return oauthFail("GOOGLE_OAUTH_OWNER_INVALID");
  }
  return Object.freeze({ principal_id: oauthIdentifier(input.principal_id), session_generation: oauthIdentifier(input.session_generation) });
}
export function intentBinding(intent: Pick<GoogleOAuthIntent, "intent_id" | "configuration" | "owner">, purpose: "intent" | "grant") {
  const config = intent.configuration;
  return tokenBinding({ connection_id: config.connection_id, principal_id: intent.owner.principal_id, oauth_client_id: config.oauth_client_id,
    google_subject: config.google_subject, google_email: config.google_email, credential_generation: `oauth-${purpose}:${intent.intent_id}` });
}
export function validateOAuthIntent(raw: GoogleOAuthIntent): GoogleOAuthIntent {
  if (!raw || Object.keys(raw).length !== 13 || !/^[a-f0-9]{64}$/u.test(raw.state_sha256)
      || !Number.isSafeInteger(raw.created_at_epoch_ms) || raw.created_at_epoch_ms < 0
      || !Number.isSafeInteger(raw.expires_at_epoch_ms) || raw.expires_at_epoch_ms <= raw.created_at_epoch_ms
      || raw.expires_at_epoch_ms - raw.created_at_epoch_ms > 600000
      || !["PENDING", "EXCHANGING", "ADMITTED", "DENIED", "FAILED"].includes(raw.status)
      || (raw.code_sha256 !== null && !/^[a-f0-9]{64}$/u.test(raw.code_sha256))
      || (raw.credential_sha256 !== null && !/^[a-f0-9]{64}$/u.test(raw.credential_sha256))
      || (raw.id_token_sha256 !== null && !/^[a-f0-9]{64}$/u.test(raw.id_token_sha256))) return oauthFail("GOOGLE_OAUTH_INTENT_INVALID");
  const result = { intent_id: oauthIdentifier(raw.intent_id), operation_ref: oauthIdentifier(raw.operation_ref),
    configuration: oauthConfiguration(raw.configuration), owner: oauthOwner(raw.owner), state_sha256: raw.state_sha256,
    secrets: encryptedToken(raw.secrets), created_at_epoch_ms: raw.created_at_epoch_ms, expires_at_epoch_ms: raw.expires_at_epoch_ms,
    status: raw.status, attempt_id: raw.attempt_id === null ? null : oauthIdentifier(raw.attempt_id),
    code_sha256: raw.code_sha256, id_token_sha256: raw.id_token_sha256, credential_sha256: raw.credential_sha256 };
  if (result.intent_id.length > 64 || (["PENDING", "DENIED"].includes(result.status)
      ? result.attempt_id !== null || result.code_sha256 !== null
      : result.attempt_id === null || result.code_sha256 === null)
      || (result.status === "ADMITTED") !== (result.id_token_sha256 !== null)
      || (result.status === "ADMITTED") !== (result.credential_sha256 !== null)) return oauthFail("GOOGLE_OAUTH_INTENT_INVALID");
  return Object.freeze(result);
}
export function oauthBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
export async function oauthDigest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (n) => n.toString(16).padStart(2, "0")).join("");
}
export async function oauthBounded<T>(signal: AbortSignal, deadline: number, now: () => number,
  action: (inner: AbortSignal) => Promise<T>): Promise<T> {
  const current = oauthClock(now);
  if (!Number.isSafeInteger(deadline) || deadline <= current || signal.aborted) return oauthFail("GOOGLE_OAUTH_CANCELLED");
  const controller = new AbortController(); const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, Math.min(15000, deadline - current));
  let rejectAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new GoogleCredentialError("GOOGLE_OAUTH_CANCELLED"));
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try { return await Promise.race([action(controller.signal), cancelled]); }
  catch (error) { if (error instanceof GoogleCredentialError) throw error; return oauthFail("GOOGLE_OAUTH_FAILED"); }
  finally { clearTimeout(timer); signal.removeEventListener("abort", abort);
    if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort); controller.abort(); }
}
