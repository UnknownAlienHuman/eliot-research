export type GoogleConnectionState = "DISCONNECTED" | "AUTHORIZING" | "ACTIVE" | "DEGRADED" | "REAUTH_REQUIRED" | "REVOKED";

export interface EncryptedRefreshToken {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly key_version: number;
}
export interface TokenVault {
  encrypt(refreshToken: string): Promise<EncryptedRefreshToken>;
  decrypt(record: EncryptedRefreshToken): Promise<string>;
  rotate(record: EncryptedRefreshToken): Promise<EncryptedRefreshToken>;
}
export interface GoogleConnectionAdmission {
  readonly expected_google_subject: string;
  readonly expected_google_email: string;
  readonly granted_scopes: readonly string[];
  readonly oauth_publishing_status: "In production";
}
export const REQUIRED_GOOGLE_SCOPES = Object.freeze([
  "openid", "email", "https://www.googleapis.com/auth/drive.file",
] as const);
const EMAIL_ALIAS = "https://www.googleapis.com/auth/userinfo.email";
/** Google's URI spelling of email is the same privilege, not an additional scope. */
export function scopesAreNarrowAndComplete(granted: readonly string[]): boolean {
  if (!Array.isArray(granted) || granted.length < 3 || granted.length > 4 || new Set(granted).size !== granted.length) return false;
  const scopes = Array.from(granted, (scope: unknown) => scope === EMAIL_ALIAS ? "email" : scope);
  return scopes.every((scope) => typeof scope === "string" && REQUIRED_GOOGLE_SCOPES.some((required) => required === scope))
    && REQUIRED_GOOGLE_SCOPES.every((scope) => scopes.includes(scope));
}

/** Fixed by the trusted, verified connection owner; never supplied by a browser decrypt request. */
export interface GoogleTokenBinding {
  readonly connection_id: string;
  readonly principal_id: string;
  readonly oauth_client_id: string;
  readonly google_subject: string;
  readonly google_email: string;
  readonly credential_generation: string;
}
export class GoogleCredentialError extends Error {
  public readonly code: string;
  public constructor(code: string) { super(code); this.name = "GoogleCredentialError"; this.code = code; }
}
export function tokenBinding(input: GoogleTokenBinding): GoogleTokenBinding {
  const keys = ["connection_id", "principal_id", "oauth_client_id", "google_subject", "google_email", "credential_generation"] as const;
  if (!input || Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key)
      || typeof input[key] !== "string" || !/^[\x21-\x7e]{1,256}$/u.test(input[key]))) {
    throw new GoogleCredentialError("GOOGLE_TOKEN_BINDING_INVALID");
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(input.google_email)) throw new GoogleCredentialError("GOOGLE_TOKEN_BINDING_INVALID");
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, input[key]]))) as unknown as GoogleTokenBinding;
}
export function refreshTokenBytes(token: string): Uint8Array<ArrayBuffer> {
  if (typeof token !== "string" || !/^[\x21-\x7e]{1,4096}$/u.test(token)) throw new GoogleCredentialError("GOOGLE_TOKEN_INVALID");
  return new TextEncoder().encode(token);
}
export function encryptedToken(record: EncryptedRefreshToken): EncryptedRefreshToken {
  if (!record || Object.keys(record).length !== 3 || ["key_version", "nonce", "ciphertext"].some((key) => !Object.hasOwn(record, key))
      || !Number.isSafeInteger(record.key_version) || record.key_version < 1 || record.key_version > 2147483647
      || !(record.nonce instanceof Uint8Array) || record.nonce.byteLength !== 12
      || !(record.ciphertext instanceof Uint8Array) || record.ciphertext.byteLength < 17 || record.ciphertext.byteLength > 4112) {
    throw new GoogleCredentialError("GOOGLE_TOKEN_RECORD_INVALID");
  }
  return { key_version: record.key_version, nonce: new Uint8Array(record.nonce), ciphertext: new Uint8Array(record.ciphertext) };
}
/** Import only from a Worker secret. Raw key bytes must not be saved beside the ciphertext. */
export async function importGoogleTokenKey(raw: Uint8Array): Promise<CryptoKey> {
  if (!(raw instanceof Uint8Array) || raw.byteLength !== 32) throw new GoogleCredentialError("GOOGLE_TOKEN_KEY_INVALID");
  const bytes = new Uint8Array(raw);
  try { return await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]); }
  catch { throw new GoogleCredentialError("GOOGLE_TOKEN_KEY_INVALID"); }
  finally { bytes.fill(0); }
}

// IMPLEMENTED_NOT_LIVE: ER-20 credential encryption; initial OAuth admission and runtime activation remain separate.
export function createAesGcmTokenVault(input: {
  readonly binding: GoogleTokenBinding;
  readonly activeKeyVersion: number;
  readonly keys: ReadonlyMap<number, CryptoKey>;
}): TokenVault {
  const binding = tokenBinding(input.binding);
  const keys = new Map(input.keys); const active = input.activeKeyVersion;
  const activeKey = keys.get(active);
  if (keys.size < 1 || keys.size > 8 || !activeKey) throw new GoogleCredentialError("GOOGLE_TOKEN_KEY_INVALID");
  for (const [version, key] of keys) {
    const algorithm = key?.algorithm as AesKeyAlgorithm | undefined;
    if (!Number.isSafeInteger(version) || version < 1 || version > 2147483647 || version > active
        || key?.type !== "secret" || key.extractable !== false || algorithm?.name !== "AES-GCM" || algorithm.length !== 256
        || key.usages.length !== 2 || !key.usages.includes("encrypt") || !key.usages.includes("decrypt")) {
      throw new GoogleCredentialError("GOOGLE_TOKEN_KEY_INVALID");
    }
  }
  const aad = (version: number) => new TextEncoder().encode(JSON.stringify([
    "eliotr.google-refresh-token.v1", binding.connection_id, binding.principal_id, binding.oauth_client_id,
    binding.google_subject, binding.google_email, binding.credential_generation, REQUIRED_GOOGLE_SCOPES, version,
  ]));
  const encrypt = async (token: string): Promise<EncryptedRefreshToken> => {
    const bytes = refreshTokenBytes(token); const nonce = new Uint8Array(12);
    try {
      crypto.getRandomValues(nonce);
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(active), tagLength: 128 }, activeKey, bytes);
      return { ciphertext: new Uint8Array(ciphertext), nonce, key_version: active };
    } catch { throw new GoogleCredentialError("GOOGLE_TOKEN_ENCRYPT_FAILED"); }
    finally { bytes.fill(0); }
  };
  const decrypt = async (inputRecord: EncryptedRefreshToken): Promise<string> => {
    const record = encryptedToken(inputRecord); const key = keys.get(record.key_version);
    if (!key) throw new GoogleCredentialError("GOOGLE_TOKEN_KEY_UNAVAILABLE");
    let bytes: Uint8Array | undefined;
    try {
      bytes = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(record.nonce),
        additionalData: aad(record.key_version), tagLength: 128 }, key, new Uint8Array(record.ciphertext)));
      const token = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      refreshTokenBytes(token).fill(0); return token;
    } catch { throw new GoogleCredentialError("GOOGLE_TOKEN_DECRYPT_FAILED"); }
    finally { bytes?.fill(0); }
  };
  return Object.freeze({ encrypt, decrypt, rotate: async (record: EncryptedRefreshToken) => encrypt(await decrypt(record)) });
}
