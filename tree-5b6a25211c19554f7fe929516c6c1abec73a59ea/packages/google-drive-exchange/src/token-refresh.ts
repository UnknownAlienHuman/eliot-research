import { GoogleCredentialError, refreshTokenBytes, scopesAreNarrowAndComplete } from "./token-vault.js";
import { object } from "./rest-transport.js";

export interface GoogleRefreshResult {
  readonly access_token: string;
  readonly expires_in: number;
  readonly refresh_token?: string;
  readonly refresh_token_expires_in?: number;
}
/** Internal OAuth transport, under the lease provider's whole-operation deadline. No retry or endpoint override. */
export async function refreshGoogleAccessToken(input: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
  readonly signal: AbortSignal;
  readonly fetchImpl: typeof fetch;
}): Promise<GoogleRefreshResult> {
  const { clientId, clientSecret, refreshToken, signal, fetchImpl } = input;
  refreshTokenBytes(clientSecret).fill(0); refreshTokenBytes(refreshToken).fill(0);
  if (!/^[\x21-\x7e]{1,256}$/u.test(clientId)) throw new GoogleCredentialError("GOOGLE_OAUTH_CLIENT_INVALID");
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => { if (reader) void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const response = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }).toString(),
      redirect: "manual", credentials: "omit", cache: "no-store", signal,
    });
    if (signal.aborted || response.redirected || response.type === "opaqueredirect" || ![200, 400].includes(response.status)
        || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" || !response.body) {
      void response.body?.cancel().catch(() => {}); throw new Error();
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > 32768)) { void response.body.cancel().catch(() => {}); throw new Error(); }
    reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      signal.throwIfAborted(); const next = await reader.read(); signal.throwIfAborted(); if (next.done) break;
      size += next.value.byteLength;
      if (size > 32768 || chunks.length >= 256) throw new Error();
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let data: unknown;
    try { data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    finally { bytes.fill(0); for (const chunk of chunks) chunk.fill(0); }
    if (response.status === 400) {
      // Never include error_description/error_uri in diagnostics, or follow them.
      const error = object(data, ["error"], ["error_description", "error_uri", "error_subtype"]);
      if (error.error === "invalid_grant") throw new GoogleCredentialError("GOOGLE_REAUTH_REQUIRED");
      throw new GoogleCredentialError("GOOGLE_OAUTH_REJECTED");
    }
    const value = object(data, ["access_token", "expires_in", "token_type"], ["scope", "refresh_token", "refresh_token_expires_in", "id_token"]);
    if (typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer"
        || typeof value.access_token !== "string" || !/^[A-Za-z0-9._~+/-]{1,4096}={0,2}$/u.test(value.access_token)
        || !Number.isSafeInteger(value.expires_in) || (value.expires_in as number) <= 30 || (value.expires_in as number) > 86400) throw new Error();
    if (Object.hasOwn(value, "scope") && (typeof value.scope !== "string" || value.scope.length > 512
        || !scopesAreNarrowAndComplete(value.scope.split(" ")))) throw new GoogleCredentialError("GOOGLE_REAUTH_REQUIRED");
    if (Object.hasOwn(value, "refresh_token")) refreshTokenBytes(value.refresh_token as string).fill(0);
    if (Object.hasOwn(value, "refresh_token_expires_in") && (!Number.isSafeInteger(value.refresh_token_expires_in)
        || (value.refresh_token_expires_in as number) <= 0 || (value.refresh_token_expires_in as number) > 315360000)) throw new Error();
    // A refresh ID token is neither used nor mistaken for initial identity admission.
    if (Object.hasOwn(value, "id_token") && (typeof value.id_token !== "string" || value.id_token.length > 16384)) throw new Error();
    return { access_token: value.access_token, expires_in: value.expires_in as number,
      ...(value.refresh_token === undefined ? {} : { refresh_token: value.refresh_token as string }),
      ...(value.refresh_token_expires_in === undefined ? {} : { refresh_token_expires_in: value.refresh_token_expires_in as number }) };
  } catch (error) {
    if (error instanceof GoogleCredentialError && ["GOOGLE_REAUTH_REQUIRED", "GOOGLE_OAUTH_REJECTED"].includes(error.code)) throw error;
    throw new GoogleCredentialError("GOOGLE_OAUTH_OUTCOME_UNKNOWN");
  } finally { signal.removeEventListener("abort", cancel); if (reader) void reader.cancel().catch(() => {}); }
}
