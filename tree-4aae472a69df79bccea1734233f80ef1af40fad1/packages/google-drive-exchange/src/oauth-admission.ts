import { createAesGcmTokenVault, GoogleCredentialError, refreshTokenBytes, REQUIRED_GOOGLE_SCOPES } from "./token-vault.js";
import { credentialSnapshot } from "./token-credentials.js";
import { exchangeGoogleCode } from "./oauth-transport.js";
import { verifyGoogleIdentity } from "./oauth-identity.js";
import { intentBinding, oauthBase64, oauthBounded, oauthClock, oauthConfiguration, oauthDigest, oauthFail,
  oauthIdentifier, oauthOwner, validateOAuthIntent, type GoogleOAuthAdmissionReceipt, type GoogleOAuthConfiguration,
  type GoogleOAuthIntent, type GoogleOAuthIntentStore, type GoogleOAuthOwner } from "./oauth-types.js";

export interface GoogleOAuthAdmissionOptions {
  readonly configuration: GoogleOAuthConfiguration;
  readonly owner: GoogleOAuthOwner;
  readonly store: GoogleOAuthIntentStore;
  readonly keys: ReadonlyMap<number, CryptoKey>;
  readonly activeKeyVersion: number;
  readonly clientSecret: string;
  readonly deadlineEpochMs: number;
  /** Current authenticated owner/configuration authority, rechecked after every external operation. */
  readonly assertOwnerCurrent: (signal: AbortSignal) => Promise<void>;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  /** Versioned G3 reconnect mode. Initial admission remains the default and never overwrites. */
  readonly reconnect?: { readonly expected_generation: string; readonly expected_revision: number };
}
function randomProof(): string { return oauthBase64(crypto.getRandomValues(new Uint8Array(32))); }

// IMPLEMENTED_NOT_LIVE: ER-20 OAuth admission plus versioned reconnect lifecycle; PWA controls, provisioning and live qualification remain separate.
export function createGoogleOAuthAdmission(options: GoogleOAuthAdmissionOptions) {
  const configuration = oauthConfiguration(options.configuration); const owner = oauthOwner(options.owner);
  const keys = new Map(options.keys); const activeKeyVersion = options.activeKeyVersion;
  const { store, clientSecret, deadlineEpochMs, assertOwnerCurrent } = options;
  const fetchImpl = options.fetchImpl ?? fetch; const now = options.now ?? Date.now;
  refreshTokenBytes(clientSecret).fill(0);
  const vault = (intent: Pick<GoogleOAuthIntent, "intent_id" | "configuration" | "owner">, purpose: "intent" | "grant") =>
    createAesGcmTokenVault({ binding: intentBinding(intent, purpose), keys, activeKeyVersion });
  // Reject missing/wrong encryption keys before creating a durable intent or making any request.
  vault({ configuration, owner, intent_id: "preflight" }, "intent");
  const guard = async (signal: AbortSignal) => {
    signal.throwIfAborted(); if (oauthClock(now) >= deadlineEpochMs) return oauthFail("GOOGLE_OAUTH_CANCELLED");
    await assertOwnerCurrent(signal); signal.throwIfAborted();
  };
  const bound = (input: GoogleOAuthIntent): GoogleOAuthIntent => {
    const intent = validateOAuthIntent(input);
    if (JSON.stringify(intent.configuration) !== JSON.stringify(configuration) || JSON.stringify(intent.owner) !== JSON.stringify(owner)) {
      return oauthFail("GOOGLE_OAUTH_INTENT_UNAVAILABLE");
    }
    return intent;
  };
  const secrets = async (intent: GoogleOAuthIntent) => {
    let value: unknown;
    try { value = JSON.parse(await vault(intent, "intent").decrypt(intent.secrets)); }
    catch { return oauthFail("GOOGLE_OAUTH_PROOF_INVALID"); }
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3
        || !["state", "verifier", "nonce"].every((key) => Object.hasOwn(value, key)
          && typeof (value as Record<string, unknown>)[key] === "string"
          && /^[A-Za-z0-9_-]{43}$/u.test((value as Record<string, string>)[key] ?? ""))) return oauthFail("GOOGLE_OAUTH_PROOF_INVALID");
    const proof = value as { state: string; verifier: string; nonce: string };
    if (await oauthDigest(proof.state) !== intent.state_sha256) return oauthFail("GOOGLE_OAUTH_PROOF_INVALID");
    return proof;
  };
  const begin = (operationRef: string, signal: AbortSignal) => oauthBounded(signal, deadlineEpochMs, now, async (inner) => {
    oauthIdentifier(operationRef); await guard(inner);
    const time = oauthClock(now); const intentId = crypto.randomUUID();
    const proof = { state: randomProof(), verifier: randomProof(), nonce: randomProof() };
    const encrypted = await vault({ configuration, owner, intent_id: intentId }, "intent").encrypt(JSON.stringify(proof));
    await guard(inner);
    const draft: GoogleOAuthIntent = { intent_id: intentId, operation_ref: operationRef, configuration, owner,
      state_sha256: await oauthDigest(proof.state), secrets: encrypted, created_at_epoch_ms: time, expires_at_epoch_ms: time + 600000,
      status: "PENDING", attempt_id: null, code_sha256: null, id_token_sha256: null, credential_sha256: null };
    const intent = bound(await store.put(draft, inner)); await guard(inner);
    if (intent.status !== "PENDING" || oauthClock(now) >= intent.expires_at_epoch_ms) return oauthFail("GOOGLE_OAUTH_INTENT_CONSUMED");
    const recovered = await secrets(intent); await guard(inner);
    const challenge = oauthBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(recovered.verifier))));
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: configuration.oauth_client_id, redirect_uri: configuration.redirect_uri,
      response_type: "code", scope: REQUIRED_GOOGLE_SCOPES.join(" "), access_type: "offline", prompt: "consent",
      include_granted_scopes: "false", login_hint: configuration.google_email,
      state: recovered.state, nonce: recovered.nonce, code_challenge_method: "S256", code_challenge: challenge }).toString();
    await guard(inner);
    if (oauthClock(now) >= intent.expires_at_epoch_ms) return oauthFail("GOOGLE_OAUTH_INTENT_EXPIRED");
    return Object.freeze({ protocol: "eliotr.google-oauth-start.v1" as const, authorization_url: url.href,
      expires_at: new Date(intent.expires_at_epoch_ms).toISOString(), intent_id: intent.intent_id });
  });
  const finish = (callback: { readonly state: string; readonly iss: string; readonly code?: string; readonly error?: string }, signal: AbortSignal) => {
    // Snapshot callback input before asynchronous work; extra HTTP query fields belong to a reviewed HTTP adapter.
    if (!callback || Object.keys(callback).length !== 3 || callback.iss !== "https://accounts.google.com" || !/^[A-Za-z0-9_-]{43}$/u.test(callback.state)
        || (Object.hasOwn(callback, "code") === Object.hasOwn(callback, "error"))) return Promise.reject(new GoogleCredentialError("GOOGLE_OAUTH_CALLBACK_INVALID"));
    const { state, code, error } = callback;
    return oauthBounded(signal, deadlineEpochMs, now, async (inner): Promise<GoogleOAuthAdmissionReceipt> => {
      if (code !== undefined) refreshTokenBytes(code).fill(0);
      else if (typeof error !== "string" || !/^[a-z_]{1,64}$/u.test(error)) return oauthFail("GOOGLE_OAUTH_CALLBACK_INVALID");
      await guard(inner);
      let intent = bound(await store.find(await oauthDigest(state), inner)); await guard(inner);
      if (oauthClock(now) >= intent.expires_at_epoch_ms) return oauthFail("GOOGLE_OAUTH_INTENT_EXPIRED");
      const codeHash = code === undefined ? null : await oauthDigest(code);
      if (intent.status === "ADMITTED" && codeHash === intent.code_sha256) {
        const receipt = await store.readAdmission(intent, inner); await guard(inner); return receipt;
      }
      if (intent.status !== "PENDING") return oauthFail("GOOGLE_OAUTH_ALREADY_ATTEMPTED");
      if (code === undefined) { await store.deny(intent, inner); return oauthFail("GOOGLE_OAUTH_CONSENT_DENIED"); }
      const proof = await secrets(intent); await guard(inner);
      intent = bound(await store.claim(intent, crypto.randomUUID(), codeHash as string, inner));
      await guard(inner); await store.assertClaim(intent, inner); inner.throwIfAborted();
      // The durable claim precedes the only token POST. A crash/timeout after it requires a NEW explicit authorization.
      const exchangedAt = oauthClock(now);
      const tokens = await exchangeGoogleCode({ configuration, clientSecret, code, verifier: proof.verifier, signal: inner, fetchImpl });
      await guard(inner); await store.assertClaim(intent, inner);
      await verifyGoogleIdentity({ token: tokens.id_token, accessToken: tokens.access_token, code, nonce: proof.nonce, intent, signal: inner, fetchImpl, now });
      await guard(inner); await store.assertClaim(intent, inner);
      const encryptedRefresh = await vault(intent, "grant").encrypt(tokens.refresh_token); inner.throwIfAborted();
      const expiry = tokens.refresh_token_expires_in === null ? null : exchangedAt + tokens.refresh_token_expires_in * 1000;
      if (expiry !== null && expiry <= oauthClock(now)) return oauthFail("GOOGLE_OAUTH_INTENT_EXPIRED");
      const expectedRevision = options.reconnect?.expected_revision ?? await store.expectedCredentialRevision?.(intent, inner) ?? null;
      const credential = credentialSnapshot({ binding: intentBinding(intent, "grant"), revision: expectedRevision === null ? 1 : expectedRevision + 1, state: "AUTHORIZING",
        granted_scopes: tokens.granted_scopes, oauth_publishing_status: "In production", refresh_expires_at_epoch_ms: expiry, token: encryptedRefresh });
      const tokenHash = await oauthDigest(tokens.id_token);
      await guard(inner); await store.admit(intent, credential, tokenHash, inner);
      const receipt = await store.readAdmission(bound(await store.find(intent.state_sha256, inner)), inner);
      await guard(inner); return receipt;
    });
  };
  return Object.freeze({ begin, finish });
}
