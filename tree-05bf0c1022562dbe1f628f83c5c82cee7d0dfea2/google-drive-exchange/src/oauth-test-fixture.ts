import { oauthBase64, oauthDigest, type GoogleOAuthConfiguration, type GoogleOAuthIntent } from "./oauth-types.js";
import { createAesGcmTokenVault, importGoogleTokenKey, REQUIRED_GOOGLE_SCOPES } from "./token-vault.js";
import { intentBinding } from "./oauth-types.js";
export const OAUTH_TEST_TIME = Date.parse("2026-09-05T22:00:00.000Z");
export const oauthTestConfiguration = (name = "test"): GoogleOAuthConfiguration => ({ connection_id: `connection-${name}`,
  oauth_client_id: "test-client.apps.googleusercontent.com", redirect_uri: "https://research.example/oauth/google/callback",
  google_subject: "123456789", google_email: "exchange@example.com", deployment_generation: "deployment-1",
  production_evidence_ref: "operator-attestation-1", oauth_publishing_status: "In production", environment: "production" });
export const oauthTestOwner = { principal_id: "owner-1", session_generation: "owner-session-1" };
let signing: Promise<CryptoKeyPair> | undefined;
export async function oauthTestKeys() {
  const pair = await (signing ??= crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]));
  const jwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "test-key", use: "sig" };
  // ext is an import/export attribute, not a field returned by Google's JWKS endpoint.
  delete jwk.ext;
  const sign = async (claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "test-key", typ: "JWT" }) => {
    const unsigned = `${oauthBase64(new TextEncoder().encode(JSON.stringify(header)))}.${oauthBase64(new TextEncoder().encode(JSON.stringify(claims)))}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(unsigned));
    return `${unsigned}.${oauthBase64(new Uint8Array(signature))}`;
  };
  return { jwk, sign };
}
export async function oauthTestClaims(nonce: string, config = oauthTestConfiguration(), time = OAUTH_TEST_TIME): Promise<Record<string, unknown>> {
  return { iss: "https://accounts.google.com", aud: config.oauth_client_id, sub: config.google_subject, email: config.google_email,
    email_verified: true, nonce, at_hash: oauthBase64(new Uint8Array(await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode("access-fixture"))).slice(0, 16)), iat: time / 1000, exp: time / 1000 + 3600 };
}
export function oauthTestTokenResponse(idToken: string) {
  return { access_token: "access-fixture", refresh_token: "refresh-fixture", token_type: "Bearer", expires_in: 3600,
    scope: REQUIRED_GOOGLE_SCOPES.join(" "), id_token: idToken };
}
export async function oauthTestIntent() {
  const base = { intent_id: "intent-test", configuration: oauthTestConfiguration(), owner: oauthTestOwner };
  const keys = new Map([[1, await importGoogleTokenKey(crypto.getRandomValues(new Uint8Array(32)))]]);
  const proof = { state: "S".repeat(43), verifier: "V".repeat(43), nonce: "N".repeat(43) };
  const secrets = await createAesGcmTokenVault({ binding: intentBinding(base, "intent"), keys, activeKeyVersion: 1 }).encrypt(JSON.stringify(proof));
  const intent: GoogleOAuthIntent = { ...base, operation_ref: "operation-test", state_sha256: await oauthDigest(proof.state), secrets,
    created_at_epoch_ms: OAUTH_TEST_TIME, expires_at_epoch_ms: OAUTH_TEST_TIME + 600000, status: "PENDING", attempt_id: null,
    code_sha256: null, id_token_sha256: null, credential_sha256: null };
  return { intent, proof, keys };
}
