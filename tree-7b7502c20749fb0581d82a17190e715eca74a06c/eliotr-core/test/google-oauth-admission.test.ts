import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createAesGcmTokenVault, importGoogleTokenKey, intentBinding, oauthDigest,
  type GoogleOAuthAdmissionOptions } from "@eliotr/google-drive-exchange";
import { OAUTH_TEST_TIME, oauthTestClaims, oauthTestConfiguration, oauthTestKeys, oauthTestOwner,
  oauthTestTokenResponse } from "../../../packages/google-drive-exchange/src/oauth-test-fixture.js";
import { createD1GoogleOAuthAdmission } from "../src/google-oauth-service.js";
import { createD1GoogleOAuthIntentStore } from "../src/google-oauth-store.js";
import { createD1GoogleCredentialStore } from "../src/google-token-store.js";
import type { Env } from "../src/env.js";
const runtime = env as unknown as Env & { CORE_MIGRATIONS: { name: string; queries: string[] }[] };
const db = runtime.CORE_DB;
const signal = () => new AbortController().signal;
let signing: Awaited<ReturnType<typeof oauthTestKeys>>;
let key: CryptoKey;
beforeAll(async () => {
  await applyD1Migrations(db, runtime.CORE_MIGRATIONS);
  signing = await oauthTestKeys(); key = await importGoogleTokenKey(crypto.getRandomValues(new Uint8Array(32)));
});
async function setup(name: string) {
  const configuration = oauthTestConfiguration(name);
  let time = OAUTH_TEST_TIME; let claims: Record<string, unknown> = {}; let extraTokens: Record<string, unknown> = {};

  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      const body = new URLSearchParams(init?.body as string);
      expect(body.get("code")).toBe("code-fixture");
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.get("code_verifier") ?? "")));
      const challenge = btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
      expect(challenge).toBe(authorization.searchParams.get("code_challenge"));
      return Response.json({ ...oauthTestTokenResponse(await signing.sign({
        ...await oauthTestClaims(authorization.searchParams.get("nonce") ?? "", configuration), ...claims })), ...extraTokens });
    }
    expect(String(url)).toBe("https://www.googleapis.com/oauth2/v3/certs");
    return Response.json({ keys: [signing.jwk] });
  });
  const assertOwnerCurrent = vi.fn(async (inner: AbortSignal) => { inner.throwIfAborted(); });
  const options: Omit<GoogleOAuthAdmissionOptions, "store"> & { database: D1Database } = { database: db, configuration,
    owner: oauthTestOwner, keys: new Map([[1, key]]), activeKeyVersion: 1, clientSecret: "client-secret",
    deadlineEpochMs: OAUTH_TEST_TIME + 1200000, now: () => time, assertOwnerCurrent, fetchImpl };
  const service = createD1GoogleOAuthAdmission(options);
  const start = await service.begin(`operation-${name}`, signal()); const authorization = new URL(start.authorization_url);
  const callback = { iss: "https://accounts.google.com", state: authorization.searchParams.get("state") ?? "", code: "code-fixture" };
  return { options, service, start, authorization, callback, fetchImpl, assertOwnerCurrent,
    clock: (value: number) => { time = value; }, changeClaims: (value: Record<string, unknown>) => { claims = value; },
    changeTokens: (value: Record<string, unknown>) => { extraTokens = value; } };
}
async function intentFor(test: Awaited<ReturnType<typeof setup>>) {
  return createD1GoogleOAuthIntentStore(db, test.options.configuration, test.options.owner, test.options.now)
    .find(await oauthDigest(test.callback.state), signal());
}
const count = async (connection: string) => (await db.prepare("SELECT count(*) AS n FROM google_exchange_connection WHERE connection_id=?1").bind(connection).first<{ n: number }>())?.n;
function intercepted(hook: (phase: "before" | "after", sql: string) => Promise<void>): D1Database {
  const wrapSession = (session: D1DatabaseSession) => new Proxy(session, { get(target, key) {
    if (key === "prepare") return (sql: string) => {
      const wrapStatement = (stmt: D1PreparedStatement): D1PreparedStatement => new Proxy(stmt, { get(value, member) {
        if (member === "bind") return (...args: unknown[]) => wrapStatement(value.bind(...args));
        if (member === "run") return async () => { await hook("before", sql); const result = await value.run(); await hook("after", sql); return result; };
        const entry = Reflect.get(value, member, value); return typeof entry === "function" ? entry.bind(value) : entry;
      } });
      return wrapStatement(target.prepare(sql));
    };
    if (key === "batch") return async (statements: D1PreparedStatement[]) => {
      await hook("before", "BATCH"); const result = await target.batch(statements); await hook("after", "BATCH"); return result;
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  return new Proxy(db, { get(target, key) {
    if (key === "withSession") return (constraint: "first-primary") => wrapSession(target.withSession(constraint));
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
}

describe("initial Google OAuth with real RSA, vault and D1", () => {
  it("persists an encrypted one-use intent and reproduces the same URL after restart", async () => {
    const test = await setup("restart");
    const replay = await createD1GoogleOAuthAdmission(test.options).begin("operation-restart", signal());
    expect(replay).toEqual(test.start); expect(test.fetchImpl).not.toHaveBeenCalled();
    const query = test.authorization.searchParams;
    expect(query.get("access_type")).toBe("offline"); expect(query.get("code_challenge_method")).toBe("S256");
    expect(query.get("include_granted_scopes")).toBe("false"); expect(query.get("scope")).toBe("openid email https://www.googleapis.com/auth/drive.file");
    const row = await db.prepare("SELECT * FROM google_oauth_intent WHERE intent_id=?1").bind(test.start.intent_id).first();
    expect(JSON.stringify(row)).not.toContain(test.callback.state); expect(JSON.stringify(row)).not.toContain(query.get("nonce"));
    expect(await count(test.options.configuration.connection_id)).toBe(0);
  });
  it("admits only verified encrypted credentials and keeps the connector AUTHORIZING without creating exchange assets", async () => {
    const test = await setup("admit"); const receipt = await test.service.finish(test.callback, signal());
    expect(receipt).toMatchObject({ connector_state: "AUTHORIZING", exchange_ready: false, connection_id: test.options.configuration.connection_id });
    const intent = await intentFor(test); expect(intent.status).toBe("ADMITTED");
    const binding = intentBinding(intent, "grant");
    const stored = await createD1GoogleCredentialStore(db, binding, test.options.now).load(signal());
    expect(stored.state).toBe("AUTHORIZING"); expect(stored.revision).toBe(1);
    expect(await createAesGcmTokenVault({ binding, keys: test.options.keys, activeKeyVersion: 1 }).decrypt(stored.token)).toBe("refresh-fixture");
    expect((await db.prepare("SELECT count(*) AS n FROM exchange_generation WHERE connection_id=?1").bind(binding.connection_id).first<{ n: number }>())?.n).toBe(0);
    const raw = await db.prepare("SELECT * FROM google_exchange_connection WHERE connection_id=?1").bind(binding.connection_id).first();
    for (const secret of ["refresh-fixture", "access-fixture", "client-secret", "code-fixture"]) {
      expect(JSON.stringify(raw)).not.toContain(secret); expect(JSON.stringify(receipt)).not.toContain(secret);
    }
  });
  it("reconciles a repeated admitted callback without another token POST, even after restart", async () => {
    const test = await setup("callback-replay"); const first = await test.service.finish(test.callback, signal());
    expect(await createD1GoogleOAuthAdmission(test.options).finish(test.callback, signal())).toEqual(first);
    expect(test.fetchImpl.mock.calls.filter(([url]) => String(url).includes("/token"))).toHaveLength(1);
    await expect(test.service.finish({ ...test.callback, code: "other-code" }, signal())).rejects.toThrow();
  });
  it("allows only one claimant among parallel callbacks", async () => {
    const test = await setup("parallel");
    const results = await Promise.allSettled([test.service.finish(test.callback, signal()), createD1GoogleOAuthAdmission(test.options).finish(test.callback, signal())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(test.fetchImpl.mock.calls.filter(([url]) => String(url).includes("/token"))).toHaveLength(1);
    expect(await count(test.options.configuration.connection_id)).toBe(1);
  });
  it("a lost token reply burns the claim; restart cannot exchange the code again", async () => {
    const test = await setup("lost-token"); test.fetchImpl.mockRejectedValue(new Error("upstream secret"));
    await expect(test.service.finish(test.callback, signal())).rejects.toMatchObject({ code: "GOOGLE_OAUTH_OUTCOME_UNKNOWN" });
    expect((await intentFor(test)).status).toBe("EXCHANGING");
    await expect(createD1GoogleOAuthAdmission(test.options).finish(test.callback, signal())).rejects.toMatchObject({ code: "GOOGLE_OAUTH_ALREADY_ATTEMPTED" });
    expect(test.fetchImpl).toHaveBeenCalledOnce(); expect(await count(test.options.configuration.connection_id)).toBe(0);
  });
  it("rejects missing/foreign state and changed owner/session without a provider request", async () => {
    const test = await setup("state-owner");
    await expect(test.service.finish({ ...test.callback, state: "x".repeat(43) }, signal())).rejects.toThrow();
    for (const owner of [{ ...test.options.owner, principal_id: "other-owner" }, { ...test.options.owner, session_generation: "new-session" }]) {
      await expect(createD1GoogleOAuthAdmission({ ...test.options, owner }).finish(test.callback, signal())).rejects.toThrow();
    }
    expect(test.fetchImpl).not.toHaveBeenCalled(); expect((await intentFor(test)).status).toBe("PENDING");
  });
  it("binds outstanding intent to client/redirect/account/deployment/operator evidence", async () => {
    const test = await setup("config-bindings");
    for (const change of [{ oauth_client_id: "other.apps.googleusercontent.com" }, { redirect_uri: "https://research.example/other" },
      { google_subject: "987654321" }, { google_email: "another@example.com" }, { deployment_generation: "new" }, { production_evidence_ref: "new-evidence" }]) {
      await expect(createD1GoogleOAuthAdmission({ ...test.options, configuration: { ...test.options.configuration, ...change } })
        .finish(test.callback, signal())).rejects.toThrow();
    }
    expect(test.fetchImpl).not.toHaveBeenCalled();
  });
  it("expires at the exact deadline and cannot renew the same operation key", async () => {
    const test = await setup("expiry"); test.clock(OAUTH_TEST_TIME + 600000);
    await expect(test.service.finish(test.callback, signal())).rejects.toMatchObject({ code: "GOOGLE_OAUTH_INTENT_EXPIRED" });
    await expect(test.service.begin("operation-expiry", signal())).rejects.toThrow(); expect(test.fetchImpl).not.toHaveBeenCalled();
  });
  it("persists consent denial without a code exchange", async () => {
    const test = await setup("denial");
    await expect(test.service.finish({ iss: "https://accounts.google.com", state: test.callback.state, error: "access_denied" }, signal())).rejects.toMatchObject({ code: "GOOGLE_OAUTH_CONSENT_DENIED" });
    expect((await intentFor(test)).status).toBe("DENIED");
    await expect(test.service.finish(test.callback, signal())).rejects.toThrow(); expect(test.fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects changed Google identity after real signature verification and preserves canonical artifacts", async () => {
    const test = await setup("wrong-google"); test.changeClaims({ sub: "attacker" });
    await runtime.EVIDENCE_BUCKET.put("oauth-existing-artifact", "canonical bytes");
    await expect(test.service.finish(test.callback, signal())).rejects.toMatchObject({ code: "GOOGLE_OAUTH_IDENTITY_REJECTED" });
    expect(await count(test.options.configuration.connection_id)).toBe(0);
    expect(await (await runtime.EVIDENCE_BUCKET.get("oauth-existing-artifact"))?.text()).toBe("canonical bytes");
  });
  it("rejects an expanded scope or missing offline grant without inserting a connection", async () => {
    for (const [name, change] of [["scope", { scope: "openid email https://www.googleapis.com/auth/drive" }],
      ["no-refresh", { refresh_token: undefined }]] as const) {
      const test = await setup(name); test.changeTokens(change);
      await expect(test.service.finish(test.callback, signal())).rejects.toMatchObject({ code: "GOOGLE_OAUTH_TOKEN_RESPONSE_INVALID" });
      expect(await count(test.options.configuration.connection_id)).toBe(0);
    }
  });
  it("persists finite offline-consent expiry using the request start, not a later extended value", async () => {
    const test = await setup("finite"); test.changeTokens({ refresh_token_expires_in: 120 });
    await test.service.finish(test.callback, signal());
    const row = await createD1GoogleCredentialStore(db, intentBinding(await intentFor(test), "grant"), test.options.now).load(signal());
    expect(row.refresh_expires_at_epoch_ms).toBe(OAUTH_TEST_TIME + 120000);
  });
  it("reads back a lost initial-intent insert ACK without creating a second state", async () => {
    const test = await setup("lost-initial"); let writes = 0;
    const configuration = oauthTestConfiguration("lost-initial-new");
    const database = intercepted(async (phase, sql) => {
      if (phase === "after" && sql.startsWith("INSERT INTO google_oauth_intent")) { writes++; throw new Error("lost ACK"); }
    });
    const options = { ...test.options, configuration, database };
    const start = await createD1GoogleOAuthAdmission(options).begin("lost-initial-new", signal());
    expect(await createD1GoogleOAuthAdmission({ ...options, database: db }).begin("lost-initial-new", signal())).toEqual(start);
    expect(writes).toBe(1); expect(test.fetchImpl).not.toHaveBeenCalled();
  });
  it("recovers a lost claim acknowledgement only through exact readback", async () => {
    const test = await setup("lost-claims"); let writes = 0;
    const database = intercepted(async (phase, sql) => {
      if (phase === "after" && sql.startsWith("UPDATE google_oauth_intent SET state='EXCHANGING'")) { writes++; throw new Error("lost ACK"); }
    });
    const receipt = await createD1GoogleOAuthAdmission({ ...test.options, database }).finish(test.callback, signal());
    expect(receipt.exchange_ready).toBe(false); expect(writes).toBe(1);
  });
  it("recovers a lost atomic-admission ACK and never replays the token exchange", async () => {
    const test = await setup("lost-admission"); let batches = 0;
    const database = intercepted(async (phase, sql) => { if (phase === "after" && sql === "BATCH") { batches++; throw new Error("lost ACK"); } });
    const receipt = await createD1GoogleOAuthAdmission({ ...test.options, database }).finish(test.callback, signal());
    expect(receipt.connector_state).toBe("AUTHORIZING"); expect(batches).toBe(1);
    expect(test.fetchImpl.mock.calls.filter(([url]) => String(url).includes("/token"))).toHaveLength(1);
  });
  it("a failed claim prevents the external request entirely", async () => {
    const test = await setup("failed-claim");
    const database = intercepted(async (phase, sql) => { if (phase === "before" && sql.startsWith("UPDATE google_oauth_intent")) throw new Error("not applied"); });
    await expect(createD1GoogleOAuthAdmission({ ...test.options, database }).finish(test.callback, signal())).rejects.toThrow();
    expect(test.fetchImpl).not.toHaveBeenCalled(); expect((await intentFor(test)).status).toBe("PENDING");
  });
  it("rolls back the credential insert when the final receipt update fails", async () => {
    const test = await setup("atomic-rollback");
    await db.exec("CREATE TRIGGER reject_oauth_completion BEFORE UPDATE ON google_oauth_intent WHEN NEW.state='ADMITTED' BEGIN SELECT RAISE(ABORT,'test rollback'); END;");
    try { await expect(test.service.finish(test.callback, signal())).rejects.toThrow(); }
    finally { await db.exec("DROP TRIGGER reject_oauth_completion;"); }
    expect(await count(test.options.configuration.connection_id)).toBe(0); expect((await intentFor(test)).status).toBe("EXCHANGING");
    await expect(createD1GoogleOAuthAdmission(test.options).finish(test.callback, signal())).rejects.toThrow();
    expect(test.fetchImpl.mock.calls.filter(([url]) => String(url).includes("/token"))).toHaveLength(1);
  });
  it("cannot replace an existing admitted connection by starting a second intent", async () => {
    const test = await setup("no-overwrite"); await test.service.finish(test.callback, signal());
    const before = await db.prepare("SELECT * FROM google_exchange_connection WHERE connection_id=?1").bind(test.options.configuration.connection_id).first();
    await expect(test.service.begin("replacement-operation", signal())).rejects.toThrow();
    expect(await db.prepare("SELECT * FROM google_exchange_connection WHERE connection_id=?1").bind(test.options.configuration.connection_id).first()).toEqual(before);
  });
  it("rejects owner revocation after Google responds, before credential admission", async () => {
    const test = await setup("owner-revoked"); let revoked = false;
    const original = test.fetchImpl.getMockImplementation(); if (!original) throw new Error("fixture");
    test.fetchImpl.mockImplementation(async (...args) => { const response = await original(...args); revoked = true; return response; });
    test.assertOwnerCurrent.mockImplementation(async () => { if (revoked) throw new Error("owner revoked"); });
    await expect(test.service.finish(test.callback, signal())).rejects.toThrow(); expect(await count(test.options.configuration.connection_id)).toBe(0);
  });
  it("does not claim a successful replay after credential tampering or revocation", async () => {
    const test = await setup("tampered-replay"); await test.service.finish(test.callback, signal());
    const intent = await intentFor(test); const binding = intentBinding(intent, "grant");
    const different = await createAesGcmTokenVault({ binding, keys: test.options.keys, activeKeyVersion: 1 }).encrypt("different-refresh");
    await db.prepare("UPDATE google_exchange_connection SET encrypted_refresh_token=?1,token_nonce=?2 WHERE connection_id=?3")
      .bind(different.ciphertext, different.nonce, binding.connection_id).run();
    await expect(createD1GoogleOAuthAdmission(test.options).finish(test.callback, signal())).rejects.toThrow();
    expect(test.fetchImpl.mock.calls.filter(([url]) => String(url).includes("/token"))).toHaveLength(1);
  });
  it("keeps proof/configuration immutable in SQL and caps active pending intents", async () => {
    const test = await setup("immutable");
    await expect(db.prepare("UPDATE google_oauth_intent SET session_generation='attacker' WHERE intent_id=?1").bind(test.start.intent_id).run()).rejects.toThrow();
    // Existing rows from other cases are isolated by a distinct owner here.
    const owner = { principal_id: "bounded-owner", session_generation: "bounded-session" };
    const service = createD1GoogleOAuthAdmission({ ...test.options, owner });
    for (let i = 0; i < 16; i++) await service.begin(`bounded-${i}`, signal());
    await expect(service.begin("bounded-overflow", signal())).rejects.toThrow();
    expect(test.fetchImpl).not.toHaveBeenCalled();
  });
  it("withholds data after cancelled callback without dispatching or consuming state", async () => {
    const test = await setup("cancel-before"); const abort = new AbortController(); abort.abort();
    await expect(test.service.finish(test.callback, abort.signal)).rejects.toThrow(); expect(test.fetchImpl).not.toHaveBeenCalled();
    expect((await intentFor(test)).status).toBe("PENDING");
  });
  it("rejects a callback with both code/error or extra fields", async () => {
    const test = await setup("bad-callback");
    for (const callback of [{ ...test.callback, iss: "https://attacker.example" },
      { ...test.callback, iss: "" },{ ...test.callback, error: "access_denied" }, { ...test.callback, extra: true },
      { iss: "https://accounts.google.com", state: "", code: "code-fixture" }, { iss: "https://accounts.google.com", state: test.callback.state }]) await expect(test.service.finish(callback, signal())).rejects.toThrow();
    expect(test.fetchImpl).not.toHaveBeenCalled();
  });
});
