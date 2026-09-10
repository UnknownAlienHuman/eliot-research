import { GoogleCredentialError, refreshTokenBytes, scopesAreNarrowAndComplete } from "./token-vault.js";
import { object } from "./rest-transport.js";
import { oauthFail, type GoogleOAuthConfiguration } from "./oauth-types.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
/** Called inside the whole-operation deadline. No retries, redirects or provider diagnostics. */
export async function readOAuthJson(url: typeof TOKEN_URL | typeof GOOGLE_JWKS_URL,
  body: string | undefined, signal: AbortSignal, fetchImpl: typeof fetch): Promise<unknown> {
  if (![TOKEN_URL, GOOGLE_JWKS_URL].includes(url) || (url === TOKEN_URL) !== (body !== undefined)
      || (body !== undefined && new TextEncoder().encode(body).length > 32768)) return oauthFail("GOOGLE_OAUTH_INPUT_INVALID");
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const chunks: Uint8Array[] = [];
  const abort = () => { if (reader) void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const response = await fetchImpl(url, { method: body === undefined ? "GET" : "POST", redirect: "manual",
      credentials: "omit", cache: "no-store", signal, headers: { Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/x-www-form-urlencoded" }) }, ...(body === undefined ? {} : { body }) });
    if (signal.aborted || response.redirected || response.type === "opaqueredirect"
        || (response.status !== 200 && !(url === TOKEN_URL && response.status === 400))
        || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" || !response.body) {
      void response.body?.cancel().catch(() => {}); throw new Error();
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > 32768)) {
      void response.body.cancel().catch(() => {}); throw new Error();
    }
    reader = response.body.getReader(); let size = 0;
    while (true) {
      signal.throwIfAborted(); const next = await reader.read(); signal.throwIfAborted(); if (next.done) break;
      size += next.value.byteLength;
      if (size > 32768 || chunks.length >= 256) throw new Error();
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    finally { bytes.fill(0); }
    if (response.status !== 200) {
      object(value, ["error"], ["error_description", "error_uri", "error_subtype"]);
      return oauthFail("GOOGLE_OAUTH_CODE_REJECTED");
    }
    return value;
  } catch (error) {
    if (error instanceof GoogleCredentialError) throw error;
    return oauthFail(url === TOKEN_URL ? "GOOGLE_OAUTH_OUTCOME_UNKNOWN" : "GOOGLE_OAUTH_KEYS_UNAVAILABLE");
  } finally {
    signal.removeEventListener("abort", abort); if (reader) void reader.cancel().catch(() => {});
    for (const chunk of chunks) chunk.fill(0);
  }
}
export interface GoogleCodeTokens {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly id_token: string;
  readonly refresh_token_expires_in: number | null;
  readonly granted_scopes: readonly string[];
}
export async function exchangeGoogleCode(input: { configuration: GoogleOAuthConfiguration; clientSecret: string;
  code: string; verifier: string; signal: AbortSignal; fetchImpl: typeof fetch }): Promise<GoogleCodeTokens> {
  const { configuration, clientSecret, code, verifier, signal, fetchImpl } = input;
  refreshTokenBytes(clientSecret).fill(0); refreshTokenBytes(code).fill(0);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(verifier)) return oauthFail("GOOGLE_OAUTH_PROOF_INVALID");
  const raw = await readOAuthJson(TOKEN_URL, new URLSearchParams({ grant_type: "authorization_code", code,
    client_id: configuration.oauth_client_id, client_secret: clientSecret, redirect_uri: configuration.redirect_uri,
    code_verifier: verifier }).toString(), signal, fetchImpl);
  try {
    const value = object(raw, ["access_token", "refresh_token", "id_token", "expires_in", "token_type", "scope"], ["refresh_token_expires_in"]);
    if (typeof value.scope !== "string" || value.scope.length > 512 || !scopesAreNarrowAndComplete(value.scope.split(" "))
        || typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer"
        || !Number.isSafeInteger(value.expires_in) || (value.expires_in as number) <= 30 || (value.expires_in as number) > 86400
        || typeof value.access_token !== "string" || !/^[A-Za-z0-9._~+/-]{1,4096}={0,2}$/u.test(value.access_token)
        || typeof value.id_token !== "string" || value.id_token.length > 16384) throw new Error();
    refreshTokenBytes(value.refresh_token as string).fill(0);
    if (value.refresh_token_expires_in !== undefined && (!Number.isSafeInteger(value.refresh_token_expires_in)
        || (value.refresh_token_expires_in as number) <= 0 || (value.refresh_token_expires_in as number) > 315360000)) throw new Error();
    return Object.freeze({ access_token: value.access_token, refresh_token: value.refresh_token as string, id_token: value.id_token,
      granted_scopes: Object.freeze(value.scope.split(" ")), refresh_token_expires_in: value.refresh_token_expires_in as number | undefined ?? null });
  } catch { return oauthFail("GOOGLE_OAUTH_TOKEN_RESPONSE_INVALID"); }
}
