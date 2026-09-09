import type { GoogleAccessLease } from "./rest-transport.js";
import { credentialSnapshot, type GoogleCredentialSnapshot, type GoogleCredentialStore } from "./token-credentials.js";
import { createAesGcmTokenVault, GoogleCredentialError, refreshTokenBytes, tokenBinding, type GoogleTokenBinding } from "./token-vault.js";
import { refreshGoogleAccessToken } from "./token-refresh.js";

export interface GoogleTokenLeaseOptions {
  readonly binding: GoogleTokenBinding;
  readonly exchangeGenerationId: string;
  readonly clientSecret: string;
  readonly activeKeyVersion: number;
  readonly keys: ReadonlyMap<number, CryptoKey>;
  readonly store: GoogleCredentialStore;
  readonly deadlineEpochMs: number;
  readonly now?: () => number;
  readonly fetchImpl?: typeof fetch;
  /** Trusted primary D1 read of the exact immutable exchange descriptor and non-retired state. */
  assertGenerationCurrent(signal: AbortSignal): Promise<void>;
}

export interface GoogleAuthorizingBootstrapLeaseOptions {
  readonly connectionId: string;
  readonly principalId: string;
  readonly credentialGeneration: string;
  readonly credentialRevision: number;
  readonly exchangeGenerationId: string;
  /** A short-lived access token obtained by the already-admitted OAuth flow; never persisted or logged here. */
  readonly accessToken: string;
  /** Must check the exact owner, connection tuple and AUTHORIZING admission before each external call. */
  readonly assertCurrent: (signal: AbortSignal) => Promise<void>;
  readonly expiresAtEpochMs: number;
  readonly now?: () => number;
}

/** Narrow bootstrap-only lease for fixed asset provisioning. It does not alter ordinary ACTIVE/DEGRADED lease rules. */
export function createGoogleAuthorizingBootstrapLeaseProvider(options: GoogleAuthorizingBootstrapLeaseOptions): (signal: AbortSignal) => Promise<GoogleAccessLease> {
  const now = options.now ?? Date.now;
  const clock = () => { const value = now(); if (!Number.isSafeInteger(value) || value < 0) throw new GoogleCredentialError("GOOGLE_CLOCK_INVALID"); return value; };
  if (![options.connectionId, options.principalId, options.credentialGeneration, options.exchangeGenerationId].every((value) =>
    typeof value === "string" && /^[\x21-\x7e]{1,256}$/u.test(value)) || !Number.isSafeInteger(options.credentialRevision) || options.credentialRevision < 1 ||
      !Number.isSafeInteger(options.expiresAtEpochMs) || options.expiresAtEpochMs <= clock() || typeof options.accessToken !== "string" ||
      !/^[A-Za-z0-9._~+/-]{1,4096}={0,2}$/u.test(options.accessToken)) throw new GoogleCredentialError("GOOGLE_BOOTSTRAP_CONTEXT_INVALID");
  let issued: Promise<GoogleAccessLease> | undefined;
  return (signal) => issued ??= (async () => {
    if (signal.aborted || clock() >= options.expiresAtEpochMs) throw new GoogleCredentialError("GOOGLE_BOOTSTRAP_EXPIRED");
    try { await options.assertCurrent(signal); } catch { throw new GoogleCredentialError("GOOGLE_BOOTSTRAP_REJECTED"); }
    if (signal.aborted || clock() >= options.expiresAtEpochMs) throw new GoogleCredentialError("GOOGLE_BOOTSTRAP_EXPIRED");
    return Object.freeze({ connection_id: options.connectionId, exchange_generation_id: options.exchangeGenerationId,
      access_token: options.accessToken, expires_at_epoch_ms: options.expiresAtEpochMs,
      assertCurrent: async (nextSignal: AbortSignal) => {
        if (nextSignal.aborted || clock() >= options.expiresAtEpochMs) throw new GoogleCredentialError("GOOGLE_BOOTSTRAP_EXPIRED");
        try { await options.assertCurrent(nextSignal); } catch { throw new GoogleCredentialError("GOOGLE_BOOTSTRAP_REJECTED"); }
      } });
  })();
}

/** One request/operation only: one refresh attempt, no shared/global token cache. */
// IMPLEMENTED_NOT_LIVE: ER-20 persisted-credential refresh leases; no initial OAuth callback/admission or production connector composition.
export function createGoogleAccessLeaseProvider(options: GoogleTokenLeaseOptions): (signal: AbortSignal) => Promise<GoogleAccessLease> {
  const binding = tokenBinding(options.binding);
  const { store, clientSecret, activeKeyVersion, deadlineEpochMs, exchangeGenerationId,
    now = Date.now, fetchImpl = fetch } = options;
  const assertGeneration = options.assertGenerationCurrent.bind(options);
  const vault = createAesGcmTokenVault({ binding, activeKeyVersion, keys: options.keys });
  refreshTokenBytes(clientSecret).fill(0);
  if (!Number.isSafeInteger(deadlineEpochMs) || !/^[\x21-\x7e]{1,256}$/u.test(exchangeGenerationId)) {
    throw new GoogleCredentialError("GOOGLE_OAUTH_CONTEXT_INVALID");
  }
  const clock = () => {
    const time = now(); if (!Number.isSafeInteger(time) || time < 0 || time > 8640000000000000) throw new GoogleCredentialError("GOOGLE_CLOCK_INVALID");
    return time;
  };
  const check = (signal: AbortSignal) => {
    if (signal.aborted || clock() >= deadlineEpochMs) throw new GoogleCredentialError("GOOGLE_CREDENTIAL_CANCELLED");
  };
  const current = async (row: GoogleCredentialSnapshot, signal: AbortSignal) => {
    check(signal);
    if (JSON.stringify(row.binding) !== JSON.stringify(binding) || !["ACTIVE", "DEGRADED"].includes(row.state)) {
      throw new GoogleCredentialError("GOOGLE_REAUTH_REQUIRED");
    }
    await store.assertCurrent(row, signal); check(signal);
    await assertGeneration(signal); check(signal);
  };
  const issue = async (signal: AbortSignal): Promise<GoogleAccessLease> => {
    check(signal); let row = credentialSnapshot(await store.load(signal)); check(signal);
    await current(row, signal);
    if (row.refresh_expires_at_epoch_ms !== null && row.refresh_expires_at_epoch_ms <= clock()) {
      await store.requireReauthorization(row, signal); throw new GoogleCredentialError("GOOGLE_REAUTH_REQUIRED");
    }
    // Rotation never writes plaintext; CAS/readback must succeed before any external token request.
    if (row.token.key_version !== activeKeyVersion) {
      const rotated = await vault.rotate(row.token); check(signal);
      row = credentialSnapshot(await store.replaceToken(row, rotated, row.refresh_expires_at_epoch_ms, signal));
      await current(row, signal);
    }
    const refreshToken = await vault.decrypt(row.token); check(signal);
    await current(row, signal);
    const startedAt = clock();
    let refreshed;
    try { refreshed = await refreshGoogleAccessToken({ clientId: binding.oauth_client_id, clientSecret, refreshToken, signal, fetchImpl }); }
    catch (error) {
      check(signal);
      if (error instanceof GoogleCredentialError && error.code === "GOOGLE_REAUTH_REQUIRED") {
        // Compare-and-swap the OLD grant only: late invalid_grant cannot revoke a reconnected account.
        await store.requireReauthorization(row, signal);
      }
      throw error;
    }
    check(signal); await current(row, signal);
    const reportedExpiry = refreshed.refresh_token_expires_in === undefined ? null : startedAt + refreshed.refresh_token_expires_in * 1000;
    // Same-grant refresh cannot extend a pre-existing finite consent lifetime.
    const expiry = reportedExpiry === null ? row.refresh_expires_at_epoch_ms : row.refresh_expires_at_epoch_ms === null
      ? reportedExpiry : Math.min(row.refresh_expires_at_epoch_ms, reportedExpiry);
    if (refreshed.refresh_token !== undefined || expiry !== row.refresh_expires_at_epoch_ms) {
      const token = refreshed.refresh_token === undefined ? row.token : await vault.encrypt(refreshed.refresh_token);
      check(signal); row = credentialSnapshot(await store.replaceToken(row, token, expiry, signal));
      await current(row, signal);
    }
    const expiresAt = Math.min(startedAt + Math.min(refreshed.expires_in, 3600) * 1000 - 30000,
      expiry ?? Number.MAX_SAFE_INTEGER, deadlineEpochMs);
    if (expiresAt <= clock()) throw new GoogleCredentialError("GOOGLE_ACCESS_TOKEN_EXPIRED");
    const frozen = credentialSnapshot(row);
    return Object.freeze({ connection_id: binding.connection_id, exchange_generation_id: exchangeGenerationId,
      access_token: refreshed.access_token, expires_at_epoch_ms: expiresAt,
      assertCurrent: async (nextSignal: AbortSignal) => {
        if (clock() >= expiresAt) throw new GoogleCredentialError("GOOGLE_ACCESS_TOKEN_EXPIRED");
        await current(frozen, nextSignal);
        if (clock() >= expiresAt) throw new GoogleCredentialError("GOOGLE_ACCESS_TOKEN_EXPIRED");
      } });
  };
  const bounded = async <T>(signal: AbortSignal, action: (inner: AbortSignal) => Promise<T>): Promise<T> => {
    check(signal); const controller = new AbortController(); const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    const timer = setTimeout(abort, Math.min(15000, deadlineEpochMs - clock()));
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new GoogleCredentialError("GOOGLE_CREDENTIAL_CANCELLED"));
      controller.signal.addEventListener("abort", onAbort, { once: true }); if (controller.signal.aborted) onAbort();
    });
    try { return await Promise.race([action(controller.signal), cancelled]); }
    catch (error) { if (error instanceof GoogleCredentialError) throw error; throw new GoogleCredentialError("GOOGLE_CREDENTIAL_UNAVAILABLE"); }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (onAbort) controller.signal.removeEventListener("abort", onAbort); controller.abort(); }
  };
  let issued: Promise<GoogleAccessLease> | undefined;
  return (signal) => {
    // Cache the bounded attempt itself: cancellation must be sticky even if an upstream
    // dependency ignores AbortSignal and its raw promise never settles.
    const pending = issued ??= bounded(signal, issue);
    return bounded(signal, async (inner) => {
      const lease = await pending; check(inner); await lease.assertCurrent(inner); check(inner); return lease;
    });
  };
}
