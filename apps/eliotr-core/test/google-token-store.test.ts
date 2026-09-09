import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createAesGcmTokenVault, createGoogleExchangeSheetPort, importGoogleTokenKey, REQUIRED_GOOGLE_SCOPES,
  type GoogleTokenBinding } from "@eliotr/google-drive-exchange";
import { exchangeFixture } from "../../../packages/google-drive-exchange/src/drive-test-fixture.js";
import { createD1GoogleAccessLeaseProvider, createD1GoogleCredentialStore } from "../src/google-token-store.js";
import type { Env } from "../src/env.js";
const runtime = env as unknown as Env & { CORE_MIGRATIONS: { name: string; queries: string[] }[] };
const db = runtime.CORE_DB;
const signal = () => new AbortController().signal;
beforeAll(async () => { await applyD1Migrations(db, runtime.CORE_MIGRATIONS); });
async function setup(name: string) {
  const binding: GoogleTokenBinding = { connection_id: `conn-${name}`, principal_id: "owner-1", oauth_client_id: "client.apps.googleusercontent.com",
    google_subject: "123456", google_email: "exchange@example.com", credential_generation: `grant-${name}` };
  const keys = new Map([[1, await importGoogleTokenKey(crypto.getRandomValues(new Uint8Array(32)))]]);
  const vault = createAesGcmTokenVault({ binding, activeKeyVersion: 1, keys }); const token = await vault.encrypt("refresh-secret");
  await db.prepare(`INSERT INTO google_exchange_connection(connection_id,google_subject,google_email,scopes_json,encrypted_refresh_token,
    token_nonce,token_key_version,state,created_at,updated_at,principal_id,oauth_client_id,credential_generation,credential_revision,oauth_publishing_status)
    VALUES (?1,?2,?3,?4,?5,?6,?7,'ACTIVE',?8,?8,?9,?10,?11,1,'In production')`).bind(binding.connection_id, binding.google_subject,
    binding.google_email, JSON.stringify(REQUIRED_GOOGLE_SCOPES), token.ciphertext, token.nonce, token.key_version, new Date().toISOString(),
    binding.principal_id, binding.oauth_client_id, binding.credential_generation).run();
  const generation = { ...exchangeFixture(), connection_id: binding.connection_id, generation_id: `exchange-${name}` };
  await db.prepare(`INSERT INTO exchange_generation(generation_id,connection_id,folder_id,spreadsheet_id,sheet_ids_json,protocol_version,state,created_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`).bind(generation.generation_id,generation.connection_id,generation.folder_id,generation.spreadsheet_id,
    JSON.stringify(generation.sheet_ids),generation.protocol_version,generation.status,generation.created_at).run();
  const fetchImpl = vi.fn<typeof fetch>(async (url) => String(url) === "https://oauth2.googleapis.com/token"
    ? Response.json({ access_token: "access-secret", token_type: "Bearer", expires_in: 3600 }) : Response.json({ startPageToken: "cursor-1" }));
  const options = { database: db, binding, generation, exchangeGenerationId: generation.generation_id,
    clientSecret: "client-secret", keys, activeKeyVersion: 1, deadlineEpochMs: Date.now() + 60000, fetchImpl };
  return { binding, keys, vault, token, generation, fetchImpl, options, store: createD1GoogleCredentialStore(db, binding) };
}
function intercepted(hook: (phase: "before" | "after") => Promise<void>): D1Database {
  return new Proxy(db, { get(target, key) {
    if (key === "withSession") return (constraint: "first-primary") => {
      const session = target.withSession(constraint);
      const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, { get(stmt, member) {
        if (member === "bind") return (...args: unknown[]) => wrap(stmt.bind(...args), sql);
        if (member === "run" && sql.startsWith("UPDATE google_exchange_connection")) return async () => {
          await hook("before"); const result = await stmt.run(); await hook("after"); return result;
        };
        const value = Reflect.get(stmt, member, stmt); return typeof value === "function" ? value.bind(stmt) : value;
      } });
      return new Proxy(session, { get(value, member) {
        if (member === "prepare") return (sql: string) => wrap(value.prepare(sql), sql);
        const entry = Reflect.get(value, member, value); return typeof entry === "function" ? entry.bind(value) : entry;
      } });
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
}
const state = (id: string) => db.prepare("SELECT state FROM google_exchange_connection WHERE connection_id=?1").bind(id).first("state");
describe("persisted encrypted Google credentials with actual D1/R2", () => {
  it("loads encrypted bytes after reconstructing the store/vault and uses the existing REST port", async () => {
    const test = await setup("restart");
    const restored = await createD1GoogleCredentialStore(db, test.binding).load(signal());
    expect(restored.token.ciphertext).toEqual(test.token.ciphertext); expect(await test.vault.decrypt(restored.token)).toBe("refresh-secret");
    const authorize = createD1GoogleAccessLeaseProvider(test.options);
    const sheet = createGoogleExchangeSheetPort({ connectionId: test.binding.connection_id, generationId: test.generation.generation_id,
      generation: test.generation, operationRef: "op-1", deadlineEpochMs: test.options.deadlineEpochMs, maxRequests: 2, authorize, fetchImpl: test.fetchImpl });
    expect(await sheet.getStartPageToken()).toBe("cursor-1"); expect(await sheet.getStartPageToken()).toBe("cursor-1");
    expect(test.fetchImpl.mock.calls.filter(([url]) => String(url).includes("oauth2"))).toHaveLength(1);
    const persisted = await db.prepare("SELECT * FROM google_exchange_connection WHERE connection_id=?1").bind(test.binding.connection_id).first();
    expect(JSON.stringify(persisted)).not.toContain("refresh-secret"); expect(JSON.stringify(persisted)).not.toContain("access-secret");
  });
  it("persists KEK and provider token rotations before use, then restarts without the old KEK", async () => {
    const test = await setup("two-rotations"); const key2 = await importGoogleTokenKey(crypto.getRandomValues(new Uint8Array(32)));
    test.keys.set(2, key2); const before = Date.now();
    test.fetchImpl.mockImplementation(async () => {
      const atSend = await test.store.load(signal()); expect(atSend.token.key_version).toBe(2); expect(atSend.revision).toBe(2);
      return Response.json({ access_token: "new-access", token_type: "Bearer", expires_in: 3600,
        refresh_token: "new-refresh", refresh_token_expires_in: 600 });
    });
    const lease = await createD1GoogleAccessLeaseProvider({ ...test.options, activeKeyVersion: 2 })(signal());
    expect(lease.access_token).toBe("new-access");
    const restored = await createD1GoogleCredentialStore(db, test.binding).load(signal());
    expect(restored.revision).toBe(3); expect(restored.refresh_expires_at_epoch_ms).toBeGreaterThanOrEqual(before + 600000);
    expect(restored.refresh_expires_at_epoch_ms).toBeLessThanOrEqual(Date.now() + 600000);
    const vault = createAesGcmTokenVault({ binding: test.binding, activeKeyVersion: 2, keys: new Map([[2, key2]]) });
    expect(await vault.decrypt(restored.token)).toBe("new-refresh");
    await lease.assertCurrent(signal());
  });
  it("withholds access when a provider-rotated refresh token cannot be persisted and never repeats the refresh", async () => {
    const test = await setup("unconfirmed-provider-token"); const before = await test.store.load(signal());
    test.fetchImpl.mockImplementation(async () => Response.json({ access_token: "withheld-access", token_type: "Bearer",
      expires_in: 3600, refresh_token: "provider-rotated" }));
    const database = intercepted(async (phase) => { if (phase === "before") throw new Error("database unavailable"); });
    const authorize = createD1GoogleAccessLeaseProvider({ ...test.options, database });
    await expect(authorize(signal())).rejects.toMatchObject({ code: "GOOGLE_CREDENTIAL_WRITE_UNCONFIRMED" });
    await expect(authorize(signal())).rejects.toThrow(); expect(test.fetchImpl).toHaveBeenCalledOnce();
    expect((await test.store.load(signal())).token.ciphertext).toEqual(before.token.ciphertext);
  });
  it("rejects a valid ciphertext copied from another connection before any Google request", async () => {
    const original = await setup("cipher-source"); const target = await setup("cipher-target");
    await db.prepare("UPDATE google_exchange_connection SET encrypted_refresh_token=?1,token_nonce=?2 WHERE connection_id=?3")
      .bind(original.token.ciphertext, original.token.nonce, target.binding.connection_id).run();
    await expect(createD1GoogleAccessLeaseProvider({ ...target.options, keys: original.keys })(signal()))
      .rejects.toMatchObject({ code: "GOOGLE_TOKEN_DECRYPT_FAILED" });
    expect(target.fetchImpl).not.toHaveBeenCalled();
  });
  it("rotates with exact readback after a lost update ACK, without repeating the SQL mutation", async () => {
    const test = await setup("lost-rotation"); const row = await test.store.load(signal()); let writes = 0;
    const database = intercepted(async (phase) => { if (phase === "after") { writes++; throw new Error("lost ACK"); } });
    const next = await test.vault.encrypt("refresh-new"); const store = createD1GoogleCredentialStore(database, test.binding);
    const actual = await store.replaceToken(row, next, null, signal()); expect(actual.revision).toBe(2); expect(writes).toBe(1);
    expect(await test.vault.decrypt((await test.store.load(signal())).token)).toBe("refresh-new");
  });
  it("does not return success if rotation never reached D1", async () => {
    const test = await setup("failed-rotation"); const row = await test.store.load(signal());
    const database = intercepted(async (phase) => { if (phase === "before") throw new Error("not applied"); });
    await expect(createD1GoogleCredentialStore(database, test.binding).replaceToken(row, await test.vault.encrypt("different"), null, signal()))
      .rejects.toMatchObject({ code: "GOOGLE_CREDENTIAL_WRITE_UNCONFIRMED" });
    expect((await test.store.load(signal())).revision).toBe(1);
  });
  it("allows only one of two concurrent token updates and preserves the winning ciphertext", async () => {
    const test = await setup("race"); const row = await test.store.load(signal());
    const tokens = await Promise.all([test.vault.encrypt("one"), test.vault.encrypt("two")]);
    const updates = await Promise.allSettled(tokens.map((token) => test.store.replaceToken(row, token, null, signal())));
    expect(updates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = await test.store.load(signal()); expect(winner.revision).toBe(2);
    expect(["one", "two"]).toContain(await test.vault.decrypt(winner.token));
  });
  it("preserves canonical artifact bytes and metadata when refresh fails with invalid_grant", async () => {
    const test = await setup("reauth"); const artifact = "canonical-report-reauth";
    await runtime.EVIDENCE_BUCKET.put(artifact, "immutable report contents");
    await db.prepare(`INSERT INTO artifact_revision VALUES (?1,1,'report',?2,'freeze',1,?1,'dependencies','PUBLISHED',?3)`)
      .bind(artifact,"a".repeat(64),new Date().toISOString()).run();
    const before = await db.prepare("SELECT * FROM artifact_revision WHERE artifact_id=?1").bind(artifact).first();
    test.fetchImpl.mockImplementation(async () => Response.json({ error: "invalid_grant", error_description: "DO NOT LOG secret" }, { status: 400 }));
    await expect(createD1GoogleAccessLeaseProvider(test.options)(signal())).rejects.toMatchObject({ code: "GOOGLE_REAUTH_REQUIRED" });
    expect(await state(test.binding.connection_id)).toBe("REAUTH_REQUIRED");
    expect(await (await runtime.EVIDENCE_BUCKET.get(artifact))?.text()).toBe("immutable report contents");
    expect(await db.prepare("SELECT * FROM artifact_revision WHERE artifact_id=?1").bind(artifact).first()).toEqual(before);
    const fresh = createD1GoogleAccessLeaseProvider(test.options); await expect(fresh(signal())).rejects.toThrow();
    expect(test.fetchImpl).toHaveBeenCalledOnce();
  });
  it("reconciles lost reauth ACK and a repeat without changing the grant again", async () => {
    const test = await setup("reauth-ack"); const row = await test.store.load(signal());
    const database = intercepted(async (phase) => { if (phase === "after") throw new Error("lost ACK"); });
    const store = createD1GoogleCredentialStore(database, test.binding);
    await store.requireReauthorization(row, signal()); await store.requireReauthorization(row, signal());
    expect((await store.load(signal())).revision).toBe(2); expect(await state(test.binding.connection_id)).toBe("REAUTH_REQUIRED");
  });
  it("denies foreign principal/client/subject/email/grant bindings before Google access", async () => {
    const test = await setup("foreign");
    for (const key of Object.keys(test.binding) as (keyof GoogleTokenBinding)[]) {
      const binding = { ...test.binding, [key]: key === "google_email" ? "different@example.com" : "different" };
      await expect(createD1GoogleCredentialStore(db, binding).load(signal())).rejects.toThrow();
    }
    expect(test.fetchImpl).not.toHaveBeenCalled();
  });
  it("fails closed for legacy/Testing, broad scopes, malformed JSON or token data", async () => {
    for (const [name, update] of [["legacy", "credential_revision=0,oauth_publishing_status='UNVERIFIED',principal_id=NULL"],
      ["testing", "oauth_publishing_status='Testing'"], ["broad", `scopes_json='["openid","email","https://www.googleapis.com/auth/drive.file","profile"]'`],
      ["record", "encrypted_refresh_token=x'0011'"], ["too-large", "encrypted_refresh_token=zeroblob(5000)"]]) {
      const test = await setup(String(name)); await db.prepare(`UPDATE google_exchange_connection SET ${update} WHERE connection_id=?1`).bind(test.binding.connection_id).run();
      await expect(createD1GoogleAccessLeaseProvider(test.options)(signal())).rejects.toThrow(); expect(test.fetchImpl).not.toHaveBeenCalled();
    }
  });
  it("rejects expired refresh grants durably, with no token request", async () => {
    const test = await setup("expired");
    await db.prepare("UPDATE google_exchange_connection SET refresh_expires_at_epoch_ms=0 WHERE connection_id=?1").bind(test.binding.connection_id).run();
    await expect(createD1GoogleAccessLeaseProvider(test.options)(signal())).rejects.toMatchObject({ code: "GOOGLE_REAUTH_REQUIRED" });
    expect(test.fetchImpl).not.toHaveBeenCalled(); expect(await state(test.binding.connection_id)).toBe("REAUTH_REQUIRED");
  });
  it("checks retired or changed exchange descriptors even if credential bytes remain identical", async () => {
    for (const [name, assignment] of [["retired", "state='retired'"], ["folder", "folder_id='other-folder'"], ["sheet", "spreadsheet_id='other-sheet'"]]) {
      const test = await setup(String(name)); await db.prepare(`UPDATE exchange_generation SET ${assignment} WHERE generation_id=?1`).bind(test.generation.generation_id).run();
      await expect(createD1GoogleAccessLeaseProvider(test.options)(signal())).rejects.toMatchObject({ code: "GOOGLE_EXCHANGE_CHANGED" });
      expect(test.fetchImpl).not.toHaveBeenCalled();
    }
  });
  it("revocation racing token response suppresses the lease and does not persist a new token", async () => {
    const test = await setup("revoke-race"); const before = await test.store.load(signal());
    test.fetchImpl.mockImplementation(async () => {
      await db.prepare("UPDATE google_exchange_connection SET state='REVOKED',credential_revision=credential_revision+1 WHERE connection_id=?1").bind(test.binding.connection_id).run();
      return Response.json({ access_token: "new-access", expires_in: 3600, token_type: "Bearer", refresh_token: "new-refresh" });
    });
    await expect(createD1GoogleAccessLeaseProvider(test.options)(signal())).rejects.toThrow();
    expect((await test.store.load(signal())).token.ciphertext).toEqual(before.token.ciphertext);
    expect(await state(test.binding.connection_id)).toBe("REVOKED");
  });
  it("late invalid_grant cannot revoke a concurrently reconnected grant", async () => {
    const test = await setup("late-reauth"); test.fetchImpl.mockImplementation(async () => {
      await db.prepare("UPDATE google_exchange_connection SET credential_generation='new-grant',credential_revision=credential_revision+1 WHERE connection_id=?1").bind(test.binding.connection_id).run();
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    });
    await expect(createD1GoogleAccessLeaseProvider(test.options)(signal())).rejects.toThrow();
    expect(await state(test.binding.connection_id)).toBe("ACTIVE");
  });
  it("revokes one exact credential snapshot and rejects a stale second revoke", async () => {
    const test = await setup("explicit-revoke");
    const before = await test.store.load(signal());
    const revoked = await test.store.revoke?.(before, signal());
    expect(revoked?.state).toBe("REVOKED");
    expect(revoked?.revision).toBe(before.revision + 1);
    await expect(test.store.revoke?.(before, signal())).rejects.toMatchObject({ code: "GOOGLE_CREDENTIAL_WRITE_UNCONFIRMED" });
    expect((await test.store.load(signal())).state).toBe("REVOKED");
  });
  it("the final CAS rejects changed scope/identity/nonce even if a broken writer failed to increment revision", async () => {
    const test = await setup("field-fence"); const row = await test.store.load(signal()); let raced = false;
    const database = intercepted(async (phase) => { if (phase === "before" && !raced) {
      raced = true; await db.prepare("UPDATE google_exchange_connection SET google_email='other@example.com' WHERE connection_id=?1").bind(test.binding.connection_id).run();
    } });
    await expect(createD1GoogleCredentialStore(database, test.binding).replaceToken(row, await test.vault.encrypt("replacement"), null, signal())).rejects.toThrow();
    expect(await db.prepare("SELECT credential_revision FROM google_exchange_connection WHERE connection_id=?1").bind(test.binding.connection_id).first("credential_revision")).toBe(1);
  });
  it("checks cancellation before any mutation and rejects missing credential schema marker", async () => {
    const test = await setup("cancel"); const row = await test.store.load(signal()); const controller = new AbortController(); controller.abort();
    await expect(test.store.replaceToken(row, await test.vault.encrypt("other"), null, controller.signal)).rejects.toMatchObject({ code: "GOOGLE_CREDENTIAL_CANCELLED" });
    expect((await test.store.load(signal())).revision).toBe(1);
    await db.prepare("UPDATE schema_state SET value='unknown' WHERE key='google_credentials_generation'").run();
    try { await expect(test.store.load(signal())).rejects.toThrow(); }
    finally { await db.prepare("UPDATE schema_state SET value='google-credentials-v1' WHERE key='google_credentials_generation'").run(); }
  });
});
