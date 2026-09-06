import { createGoogleOAuthAdmission, GoogleCredentialError, importGoogleTokenKey, oauthConfiguration,
  type GoogleOAuthAdmissionOptions, type GoogleOAuthConfiguration } from "@eliotr/google-drive-exchange";
import { createD1GoogleOAuthIntentStore } from "./google-oauth-store.js";
import type { Env } from "./env.js";

/** Initial credential admission only. Caller supplies current authenticated owner and trusted operator configuration. */
export function createD1GoogleOAuthAdmission(options: Omit<GoogleOAuthAdmissionOptions, "store"> & { readonly database: D1Database }) {
  return createGoogleOAuthAdmission({ ...options,
    store: createD1GoogleOAuthIntentStore(options.database, options.configuration, options.owner, options.now) });
}

function requiredEnvText(value: string | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new GoogleCredentialError(`GOOGLE_OAUTH_NOT_CONFIGURED:${label}`);
  }
  return value;
}

/**
 * G1 server-owned OAuth admission configuration. Every field comes from Worker
 * Env (operator configuration) plus deployment generation; the OAuth client is
 * admitted only with an explicit Production attestation reference. Never call
 * with request-body values.
 */
export function readGoogleOAuthServerConfiguration(env: Env): GoogleOAuthConfiguration {
  try {
    return oauthConfiguration({
      connection_id: requiredEnvText(env.GOOGLE_OAUTH_CONNECTION_ID, "connection"),
      oauth_client_id: requiredEnvText(env.GOOGLE_CLIENT_ID, "client"),
      redirect_uri: requiredEnvText(env.GOOGLE_OAUTH_REDIRECT_URI, "redirect"),
      google_subject: requiredEnvText(env.GOOGLE_OAUTH_GOOGLE_SUBJECT, "subject"),
      google_email: requiredEnvText(env.GOOGLE_OAUTH_GOOGLE_EMAIL, "email"),
      deployment_generation: requiredEnvText(env.DEPLOYMENT_GENERATION, "deployment"),
      production_evidence_ref: requiredEnvText(env.GOOGLE_OAUTH_PRODUCTION_EVIDENCE_REF, "production-evidence"),
      oauth_publishing_status: "In production",
      environment: env.ENVIRONMENT,
    });
  } catch (error) {
    if (error instanceof GoogleCredentialError && error.code.startsWith("GOOGLE_OAUTH_NOT_CONFIGURED")) throw error;
    throw new GoogleCredentialError("GOOGLE_OAUTH_NOT_CONFIGURED:admission");
  }
}

/** Import the active server KEK from base64-encoded 32-byte Worker-secret input. */
export async function importGoogleOAuthServerKey(env: Env): Promise<{ readonly key: CryptoKey; readonly version: number }> {
  const raw = requiredEnvText(env.GOOGLE_TOKEN_ENCRYPTION_KEY, "kek");
  const versionText = env.GOOGLE_TOKEN_KEY_VERSION ?? "1";
  if (!/^[1-9][0-9]{0,9}$/u.test(versionText)) throw new GoogleCredentialError("GOOGLE_OAUTH_NOT_CONFIGURED:key-version");
  const version = Number(versionText);
  let bytes: Uint8Array;
  try {
    if (!/^[A-Za-z0-9+/]{43}=$/u.test(raw)) throw new Error("key shape");
    const binary = atob(raw);
    bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    if (bytes.byteLength !== 32) throw new Error("key length");
  } catch {
    throw new GoogleCredentialError("GOOGLE_OAUTH_NOT_CONFIGURED:kek-shape");
  }
  try {
    return { key: await importGoogleTokenKey(bytes), version };
  } finally {
    bytes.fill(0);
  }
}

/** Server-owned client secret bytes; validated but never logged, persisted, or returned. */
export function readGoogleOAuthClientSecret(env: Env): string {
  const secret = requiredEnvText(env.GOOGLE_CLIENT_SECRET, "client-secret");
  if (!/^[\x21-\x7e]{1,4096}$/u.test(secret)) throw new GoogleCredentialError("GOOGLE_OAUTH_NOT_CONFIGURED:client-secret-shape");
  return secret;
}
