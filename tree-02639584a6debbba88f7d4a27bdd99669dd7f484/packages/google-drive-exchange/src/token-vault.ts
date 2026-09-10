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

export const REQUIRED_GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/drive.file",
] as const;

export function scopesAreNarrowAndComplete(granted: readonly string[]): boolean {
  const set = new Set(granted);
  return REQUIRED_GOOGLE_SCOPES.every((scope) => set.has(scope))
    && !set.has("https://www.googleapis.com/auth/drive")
    && !set.has("https://www.googleapis.com/auth/drive.readonly");
}
