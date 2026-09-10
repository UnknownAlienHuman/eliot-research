import { encryptedToken, GoogleCredentialError, scopesAreNarrowAndComplete, tokenBinding,
  type EncryptedRefreshToken, type GoogleConnectionState, type GoogleTokenBinding } from "./token-vault.js";

export interface GoogleCredentialSnapshot {
  readonly binding: GoogleTokenBinding;
  readonly revision: number;
  readonly state: GoogleConnectionState;
  readonly granted_scopes: readonly string[];
  readonly oauth_publishing_status: "In production";
  readonly refresh_expires_at_epoch_ms: number | null;
  readonly token: EncryptedRefreshToken;
}
/** Trusted D1 authority; compare-and-swap methods must reconcile by exact readback after lost ACKs. */
export interface GoogleCredentialStore {
  load(signal: AbortSignal): Promise<GoogleCredentialSnapshot>;
  assertCurrent(expected: GoogleCredentialSnapshot, signal: AbortSignal): Promise<void>;
  replaceToken(expected: GoogleCredentialSnapshot, token: EncryptedRefreshToken, expiresAt: number | null,
    signal: AbortSignal): Promise<GoogleCredentialSnapshot>;
  requireReauthorization(expected: GoogleCredentialSnapshot, signal: AbortSignal): Promise<void>;
  /** Revoke exactly the supplied credential snapshot; stale callers cannot revoke a replacement. */
  readonly revoke?: (expected: GoogleCredentialSnapshot, signal: AbortSignal) => Promise<GoogleCredentialSnapshot>;
  readonly revokeWithDisconnectReceipt?: (expected: GoogleCredentialSnapshot, receipt: GoogleDisconnectReceiptFence,
    signal: AbortSignal) => Promise<GoogleCredentialSnapshot>;
}
export interface GoogleDisconnectReceiptFence {
  readonly principal_id: string;
  readonly operation_ref: string;
  readonly connection_id: string;
  readonly configuration_json: string;
  readonly expected_credential_generation: string;
  readonly expected_credential_revision: number;
}
export function credentialSnapshot(raw: GoogleCredentialSnapshot): GoogleCredentialSnapshot {
  const states = ["DISCONNECTED", "AUTHORIZING", "ACTIVE", "DEGRADED", "REAUTH_REQUIRED", "REVOKED"];
  if (!raw || Object.keys(raw).length !== 7 || ["binding", "revision", "state", "granted_scopes", "oauth_publishing_status",
      "refresh_expires_at_epoch_ms", "token"].some((key) => !Object.hasOwn(raw, key)) || !Number.isSafeInteger(raw.revision) || raw.revision < 1
      || raw.revision >= Number.MAX_SAFE_INTEGER || !states.includes(raw.state) || raw.oauth_publishing_status !== "In production"
      || !scopesAreNarrowAndComplete(raw.granted_scopes) || (raw.refresh_expires_at_epoch_ms !== null
        && (!Number.isSafeInteger(raw.refresh_expires_at_epoch_ms) || raw.refresh_expires_at_epoch_ms < 0))) {
    throw new GoogleCredentialError("GOOGLE_CREDENTIAL_RECORD_INVALID");
  }
  return Object.freeze({ binding: tokenBinding(raw.binding), revision: raw.revision, state: raw.state,
    granted_scopes: Object.freeze([...raw.granted_scopes]), oauth_publishing_status: raw.oauth_publishing_status,
    refresh_expires_at_epoch_ms: raw.refresh_expires_at_epoch_ms, token: encryptedToken(raw.token) });
}
export function sameGoogleCredentials(left: GoogleCredentialSnapshot, right: GoogleCredentialSnapshot): boolean {
  const a = credentialSnapshot(left); const b = credentialSnapshot(right);
  const comparable = (value: GoogleCredentialSnapshot) => JSON.stringify({ ...value,
    token: { ...value.token, ciphertext: Array.from(value.token.ciphertext), nonce: Array.from(value.token.nonce) } });
  return comparable(a) === comparable(b);
}
