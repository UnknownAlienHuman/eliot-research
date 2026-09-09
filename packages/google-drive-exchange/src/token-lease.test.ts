import { describe, expect, it, vi } from "vitest";
import { createAesGcmTokenVault, importGoogleTokenKey, REQUIRED_GOOGLE_SCOPES, type GoogleTokenBinding } from "./token-vault.js";
import { createGoogleAccessLeaseProvider, createGoogleAuthorizingBootstrapLeaseProvider } from "./token-lease.js";
import { credentialSnapshot, sameGoogleCredentials, type GoogleCredentialSnapshot, type GoogleCredentialStore } from "./token-credentials.js";

const binding: GoogleTokenBinding = { connection_id: "connection-1", principal_id: "owner-1", oauth_client_id: "client.apps.googleusercontent.com",
  google_subject: "1234567", google_email: "exchange@example.com", credential_generation: "grant-1" };
const signal = () => new AbortController().signal;
const response = (extra = {}) => Response.json({ access_token: "short-lived-access", expires_in: 3600, token_type: "Bearer", ...extra });
async function setup() {
  const keys = new Map([[1, await importGoogleTokenKey(crypto.getRandomValues(new Uint8Array(32)))]]);
  const vault = createAesGcmTokenVault({ binding, activeKeyVersion: 1, keys });
  let row: GoogleCredentialSnapshot = { binding, revision: 1, state: "ACTIVE", granted_scopes: [...REQUIRED_GOOGLE_SCOPES],
    oauth_publishing_status: "In production", refresh_expires_at_epoch_ms: null, token: await vault.encrypt("refresh-secret") };
  const saved: GoogleCredentialSnapshot[] = [];
  const store: GoogleCredentialStore = {
    load: async () => credentialSnapshot(row),
    assertCurrent: async (expected) => { if (!sameGoogleCredentials(expected, row)) throw new Error("changed"); },
    replaceToken: async (expected, token, expires) => { await store.assertCurrent(expected, signal());
      row = credentialSnapshot({ ...row, token, revision: row.revision + 1, refresh_expires_at_epoch_ms: expires }); saved.push(row); return row; },
    requireReauthorization: async (expected) => { await store.assertCurrent(expected, signal()); row = { ...row, state: "REAUTH_REQUIRED", revision: row.revision + 1 }; saved.push(row); },
  };
  const fetchImpl = vi.fn<typeof fetch>(async () => response());
  const assertGenerationCurrent = vi.fn(async () => {});
  let time = Date.now(); const options = { binding, exchangeGenerationId: "exchange-1", clientSecret: "client-secret", keys,
    activeKeyVersion: 1, store, deadlineEpochMs: time + 60000, now: () => time, fetchImpl, assertGenerationCurrent };
  return { options, store, fetchImpl, vault, saved, get: () => row, set: (changed: Partial<GoogleCredentialSnapshot>) => { row = { ...row, ...changed }; },
    tick: (ms: number) => { time += ms; } };
}
describe("one-operation OAuth refresh lease", () => {
  it("rejects inherited credential fields hidden behind an equal number of unknown own fields", async () => {
    const test = await setup(); const row = test.get();
    const inherited: unknown = Object.assign(Object.create(row), { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1 });
    expect(() => credentialSnapshot(inherited as GoogleCredentialSnapshot)).toThrow();
    const token: unknown = Object.assign(Object.create(row.token), { key_version: 1, a: 1, b: 1 });
    await expect(test.vault.decrypt(token as GoogleCredentialSnapshot["token"])).rejects.toThrow();
  });
  it("uses only fixed token endpoint, form body, omitted credentials and no redirect; caches one in-flight refresh", async () => {
    const test = await setup(); const authorize = createGoogleAccessLeaseProvider(test.options);
    const [a, b] = await Promise.all([authorize(signal()), authorize(signal())]); expect(a).toBe(b);
    await authorize(signal()); expect(test.fetchImpl).toHaveBeenCalledOnce();
    const call = test.fetchImpl.mock.calls[0]; if (!call) throw new Error("missing call");
    const [url, init] = call;
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init).toMatchObject({ method: "POST", redirect: "manual", credentials: "omit", cache: "no-store" });
    expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe("refresh-secret");
    expect(a.access_token).toBe("short-lived-access"); expect(a.connection_id).toBe(binding.connection_id);
    expect(test.saved).toHaveLength(0); expect(test.options.assertGenerationCurrent).toHaveBeenCalled();
  });
  it("persists invalid_grant as REAUTH_REQUIRED once and never retries within the operation", async () => {
    const test = await setup(); test.fetchImpl.mockImplementation(async () => Response.json({ error: "invalid_grant", error_description: "SECRET" }, { status: 400 }));
    const authorize = createGoogleAccessLeaseProvider(test.options);
    for (let n = 0; n < 2; n++) await expect(authorize(signal())).rejects.toMatchObject({ code: "GOOGLE_REAUTH_REQUIRED" });
    expect(test.get().state).toBe("REAUTH_REQUIRED"); expect(test.fetchImpl).toHaveBeenCalledOnce(); expect(test.saved).toHaveLength(1);
  });
  it("rotates old KEK before refresh and stores returned rotated refresh token encrypted before returning access", async () => {
    const test = await setup(); test.options.keys.set(2, await importGoogleTokenKey(crypto.getRandomValues(new Uint8Array(32))));
    test.fetchImpl.mockImplementation(async () => { expect(test.get().token.key_version).toBe(2); return response({ refresh_token: "rotated-secret" }); });
    const authorize = createGoogleAccessLeaseProvider({ ...test.options, activeKeyVersion: 2 });
    await authorize(signal()); expect(test.saved).toHaveLength(2);
    const nextVault = createAesGcmTokenVault({ binding, activeKeyVersion: 2, keys: test.options.keys });
    expect(await nextVault.decrypt(test.get().token)).toBe("rotated-secret");
    expect(JSON.stringify(test.saved)).not.toContain("rotated-secret");
  });
  it("rejects expiry, revoked/reauth/unauthorized state and Testing records without token HTTP", async () => {
    for (const patch of [{ state: "REVOKED" }, { state: "REAUTH_REQUIRED" }, { state: "AUTHORIZING" },
      { oauth_publishing_status: "Testing" }, { refresh_expires_at_epoch_ms: 0 }]) {
      const test = await setup(); test.set(patch as Partial<GoogleCredentialSnapshot>);
      await expect(createGoogleAccessLeaseProvider(test.options)(signal())).rejects.toThrow(); expect(test.fetchImpl).not.toHaveBeenCalled();
    }
  });
  it("persists scope loss or expansion as reauth; accepts the documented email scope spelling", async () => {
    for (const scope of ["openid", `${REQUIRED_GOOGLE_SCOPES.join(" ")} https://www.googleapis.com/auth/gmail.modify`]) {
      const test = await setup(); test.fetchImpl.mockImplementation(async () => response({ scope }));
      await expect(createGoogleAccessLeaseProvider(test.options)(signal())).rejects.toMatchObject({ code: "GOOGLE_REAUTH_REQUIRED" });
      expect(test.get().state).toBe("REAUTH_REQUIRED");
    }
    const test = await setup(); test.fetchImpl.mockImplementation(async () => response({ scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file" }));
    expect((await createGoogleAccessLeaseProvider(test.options)(signal())).access_token).toBe("short-lived-access");
  });
  it("expires the local cache and validates current grant after each reuse", async () => {
    const test = await setup(); const authorize = createGoogleAccessLeaseProvider(test.options); const lease = await authorize(signal());
    test.set({ state: "REVOKED", revision: 2 });
    await expect(lease.assertCurrent(signal())).rejects.toThrow(); await expect(authorize(signal())).rejects.toThrow();
    expect(test.fetchImpl).toHaveBeenCalledOnce();
    const other = await setup(); const expires = createGoogleAccessLeaseProvider(other.options); const result = await expires(signal());
    other.tick(60000); await expect(result.assertCurrent(signal())).rejects.toMatchObject({ code: "GOOGLE_ACCESS_TOKEN_EXPIRED" });
    expect(other.fetchImpl).toHaveBeenCalledOnce();
  });
  it("does not extend finite consent expiry and rejects revoked generation after token response", async () => {
    const test = await setup(); const expiry = test.options.now() + 120000; test.set({ refresh_expires_at_epoch_ms: expiry });
    test.fetchImpl.mockImplementation(async () => response({ refresh_token_expires_in: 100000 }));
    await createGoogleAccessLeaseProvider(test.options)(signal()); expect(test.get().refresh_expires_at_epoch_ms).toBe(expiry);
    const other = await setup(); other.fetchImpl.mockImplementation(async () => {
      other.options.assertGenerationCurrent.mockRejectedValue(new Error("retired")); return response();
    });
    await expect(createGoogleAccessLeaseProvider(other.options)(signal())).rejects.toThrow(); expect(other.saved).toHaveLength(0);
  });
  it("does not revoke a new connection when old refresh response arrives late", async () => {
    const test = await setup(); test.fetchImpl.mockImplementation(async () => {
      test.set({ revision: 2, binding: { ...binding, credential_generation: "grant-2" } });
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    });
    await expect(createGoogleAccessLeaseProvider(test.options)(signal())).rejects.toThrow(); expect(test.get().state).toBe("ACTIVE");
    expect(test.get().binding.credential_generation).toBe("grant-2");
  });
  it("aborts hung credential reads/token headers/body and never retries or saves a late token", async () => {
    for (const stage of ["store", "headers", "body"]) {
      const test = await setup(); const abort = new AbortController(); let cancelled = false;
      if (stage === "store") test.store.load = () => new Promise(() => {});
      if (stage === "headers") test.fetchImpl.mockImplementation(() => new Promise(() => {}));
      if (stage === "body") test.fetchImpl.mockImplementation(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }),
        { headers: { "content-type": "application/json" } }));
      const authorize = createGoogleAccessLeaseProvider(test.options); const pending = authorize(abort.signal);
      await new Promise((resolve) => setTimeout(resolve, 10)); abort.abort();
      await expect(pending).rejects.toMatchObject({ code: "GOOGLE_CREDENTIAL_CANCELLED" });
      await expect(authorize(signal())).rejects.toThrow(); expect(test.saved).toHaveLength(0);
      expect(test.fetchImpl.mock.calls.length).toBeLessThanOrEqual(1); if (stage === "body") expect(cancelled).toBe(true);
    }
  });
  it("enforces the absolute deadline even without caller abort", async () => {
    const test = await setup(); test.fetchImpl.mockImplementation(() => new Promise(() => {}));
    await expect(createGoogleAccessLeaseProvider({ ...test.options, deadlineEpochMs: Date.now() + 15 })(signal())).rejects.toMatchObject({ code: "GOOGLE_CREDENTIAL_CANCELLED" });
  });
  it("rejects redirects, HTML, malformed/oversized token JSON and bad counters without false reauth or secret reflection", async () => {
    const replies = [() => new Response(null, { status: 302 }), () => new Response("SECRET", { headers: { "content-type": "text/html" } }),
      () => response({ expires_in: "3600" }), () => response({ expires_in: 0 }), () => response({ unexpected: true }),
      () => response({ access_token: "a\r\nSECRET" }), () => response({ refresh_token: "" }), () => response({ refresh_token_expires_in: 0 }),
      () => new Response('"' + "x".repeat(32769) + '"', { headers: { "content-type": "application/json" } }),
      () => new Response("{SECRET", { headers: { "content-type": "application/json" } }),
      () => new Response(null, { status: 500 })];
    for (const reply of replies) {
      const test = await setup(); test.fetchImpl.mockImplementation(async () => reply()); const authorize = createGoogleAccessLeaseProvider(test.options);
      await expect(authorize(signal())).rejects.toMatchObject({ code: "GOOGLE_OAUTH_OUTCOME_UNKNOWN" });
      await expect(authorize(signal())).rejects.toThrow(); expect(test.fetchImpl).toHaveBeenCalledOnce(); expect(test.saved).toHaveLength(0);
    }
  });
});

describe("G4 AUTHORIZING bootstrap lease", () => {
  it("requires current admitted authority and preserves the exact generation tuple", async () => {
    const assertCurrent = vi.fn(async () => {});
    const authorize = createGoogleAuthorizingBootstrapLeaseProvider({ connectionId: "connection-bootstrap", principalId: "owner-bootstrap",
      credentialGeneration: "grant-bootstrap", credentialRevision: 3, exchangeGenerationId: "generation-bootstrap", accessToken: "bootstrap-access",
      expiresAtEpochMs: Date.now() + 60000, assertCurrent });
    const lease = await authorize(signal()); expect(lease.connection_id).toBe("connection-bootstrap"); expect(lease.exchange_generation_id).toBe("generation-bootstrap");
    await lease.assertCurrent(signal()); expect(assertCurrent).toHaveBeenCalledTimes(2);
  });
  it("does not issue after the bootstrap authority is revoked", async () => {
    const assertCurrent = vi.fn(async () => { throw new Error("revoked"); });
    const authorize = createGoogleAuthorizingBootstrapLeaseProvider({ connectionId: "connection-bootstrap-revoked", principalId: "owner-bootstrap",
      credentialGeneration: "grant-bootstrap", credentialRevision: 1, exchangeGenerationId: "generation-bootstrap", accessToken: "bootstrap-access",
      expiresAtEpochMs: Date.now() + 60000, assertCurrent });
    await expect(authorize(signal())).rejects.toMatchObject({ code: "GOOGLE_BOOTSTRAP_REJECTED" });
  });
});
