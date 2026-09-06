/// <reference types="node" />
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  assertO2MigrationAuthority, O2_UPGRADE_FILENAME, O2_EXPECTED_UPGRADE_DIGEST,
  O2_EXPECTED_SCHEMA_DIGEST, canonicalO2SchemaFingerprint,
} from "./migration-gate.js";
import m0001 from "../../../infra/d1/core/migrations/0001_initial.sql?raw";
import m0002 from "../../../infra/d1/core/migrations/0002_execution_coordination.sql?raw";
import m0003 from "../../../infra/d1/core/migrations/0003_delivery_inbox_payload_digest.sql?raw";
import m0004 from "../../../infra/d1/core/migrations/0004_outbox_delivery_fence.sql?raw";
import m0005 from "../../../infra/d1/core/migrations/0005_ingest_admission.sql?raw";
import m0006 from "../../../infra/d1/core/migrations/0006_projection_execution.sql?raw";
import m0007 from "../../../infra/d1/core/migrations/0007_evidence_resolution.sql?raw";
import m0008 from "../../../infra/d1/core/migrations/0008_erasure_closure.sql?raw";
import m0009 from "../../../infra/d1/core/migrations/0009_federation_authority.sql?raw";
import m0010 from "../../../infra/d1/core/migrations/0010_navigation_artifacts.sql?raw";
import m0011 from "../../../infra/d1/core/migrations/0011_owner_orientation.sql?raw";
import m0012 from "../../../infra/d1/core/migrations/0012_google_credentials.sql?raw";
import m0013 from "../../../infra/d1/core/migrations/0013_google_oauth_intents.sql?raw";
import m0018 from "../../../infra/d1/core/migrations/0018_backup_o2_replay_authority.sql?raw";
import m0019 from "../../../infra/d1/core/migrations/0019_backup_o2_replay_authority_fix.sql?raw";

// ER-34 O2 FIX5 forward upgrade 0019 (IMPLEMENTED_NOT_LIVE).
// 0018 is immutable parent bytes (FIX3 shape); 0019 carries the FIX4 delta
// forward. Fresh databases (0001-0013 + 0018 + 0019) and parent-0018 databases
// upgraded by 0019 converge to one shape under one fingerprint; the gate
// requires BOTH ledger rows. Duplicate nonce bytes inherited from the parent
// key abort the upgrade instead of deduplicating; 0019 without its parent 0018
// predecessor aborts; D1 migrations are forward-only with no down migration
// (rollback is restore-from-backup; O2 is pre-live with no live receipts).

const T = "2026-09-06T00:00:00.000Z";
const D64 = "d".repeat(64);
const EARLY = [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010, m0011, m0012, m0013];
const APPLIED_PARENT = ["0001_initial.sql", "0002_execution_coordination.sql", "0003_delivery_inbox_payload_digest.sql", "0004_outbox_delivery_fence.sql", "0005_ingest_admission.sql", "0006_projection_execution.sql", "0007_evidence_resolution.sql", "0008_erasure_closure.sql", "0009_federation_authority.sql", "0010_navigation_artifacts.sql", "0011_owner_orientation.sql", "0012_google_credentials.sql", "0013_google_oauth_intents.sql", "0018_backup_o2_replay_authority.sql"];
const APPLIED_FULL = [...APPLIED_PARENT, "0019_backup_o2_replay_authority_fix.sql"];
function d1Database(db: DatabaseSync): D1Database {
  return { prepare(sql: string) {
    const stmt = db.prepare(sql);
    const runBound = (params: (string | number | null)[]) => ({
      async all<T>(): Promise<D1Result<T>> { return { results: stmt.all(...params) as unknown as T[], success: true, meta: {} } as unknown as D1Result<T>; },
      async first<T>(): Promise<T | null> { const r = stmt.get(...params) as unknown as T | undefined; return r ?? null; },
      async run<T>(): Promise<D1Result<T>> { stmt.run(...params); return { results: [], success: true, meta: {} } as unknown as D1Result<T>; },
    });
    return { bind(...p: unknown[]) { return runBound(p as (string | number | null)[]); }, ...runBound([]) };
  } } as unknown as D1Database;
}
function openEarly(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const m of EARLY) db.exec(m);
  return db;
}
function recordLedger(db: DatabaseSync, names: readonly string[]): void {
  for (const [i, n] of names.entries()) db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?1,?2)").run(n, `${T.slice(0, 10)}T00:00:${String(i).padStart(2, "0")}.000Z`);
}
function seedParentRows(db: DatabaseSync): void {
  db.prepare("INSERT INTO backup_offsite_expiry (expiry_intent_key, epoch_id, destination_id, journal_refs_json, state, absent_parts, failure_domain, descriptor_digest, policy_digest, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)")
    .run("exp-1", "epoch-1", "dest-1", "[]", "BLOCKED", 0, "domain-x", D64, D64, T);
  db.prepare("INSERT INTO backup_offsite_nonce_authority (key_generation, nonce_hex, copy_id, part_ref, created_at) VALUES (?1,?2,?3,?4,?5)")
    .run("gen-1", "ab".repeat(12), "copy-1", "part-1", T);
  db.prepare("INSERT INTO backup_offsite_nonce_authority (key_generation, nonce_hex, copy_id, part_ref, created_at) VALUES (?1,?2,?3,?4,?5)")
    .run("gen-2", "cd".repeat(12), "copy-2", "part-1", T);
  db.prepare("INSERT INTO backup_offsite_copy_part (copy_id, part_ref, content_digest, size_bytes, nonce_hex, state, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)")
    .run("copy-1", "offsite/epoch-1/manifest-a/000000-" + "e".repeat(64), "e".repeat(64), 512, "ab".repeat(12), "VERIFIED", T);
}
async function shaHex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer))].map((v) => v.toString(16).padStart(2, "0")).join("");
}
async function liveFingerprint(db: DatabaseSync): Promise<string> {
  const tables = ["d1_migrations", "backup_epoch_receipt", "backup_offsite_expiry", "backup_destination_authority", "backup_offsite_copy_part", "backup_offsite_copy_receipt", "backup_export_cut", "backup_offsite_nonce_authority"];
  const tableRows = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN (${tables.map((t) => `'${t}'`).join(",")})`).all() as { name: string; sql: string }[];
  const entries: { kind: "table" | "index"; name: string; sql: string }[] = tableRows.map((row) => ({ kind: "table" as const, name: row.name, sql: row.sql }));
  const indexes = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND tbl_name IN (${tables.map((t) => `'${t}'`).join(",")})`).all() as { name: string; sql: string }[];
  for (const row of indexes) entries.push({ kind: "index" as const, name: row.name, sql: row.sql });
  return canonicalO2SchemaFingerprint(entries);
}

describe("ER-34 O2 FIX5 forward upgrade 0019", () => {
  it("binds the expected upgrade content digest to the tracked 0019 file", async () => {
    expect(O2_UPGRADE_FILENAME).toBe("0019_backup_o2_replay_authority_fix.sql");
    expect(await shaHex(m0019.replace(/\r\n/g, "\n"))).toBe(O2_EXPECTED_UPGRADE_DIGEST);
  });
  it("fresh databases (0018 + 0019) pass the gate under the canonical fingerprint", async () => {
    const db = openEarly();
    db.exec(m0018);
    db.exec(m0019);
    recordLedger(db, APPLIED_FULL);
    await expect(assertO2MigrationAuthority(d1Database(db))).resolves.toBeUndefined();
    expect(await liveFingerprint(db)).toBe(O2_EXPECTED_SCHEMA_DIGEST);
    const pk = (db.prepare("PRAGMA table_info(backup_offsite_nonce_authority)").all() as { name: string; pk: number }[])
      .filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    expect(pk).toEqual(["nonce_hex"]);
    const owner = (db.prepare("PRAGMA index_info(backup_offsite_nonce_owner_unique)").all() as { seqno: number; name: string }[])
      .sort((a, b) => a.seqno - b.seqno).map((c) => c.name);
    expect(owner).toEqual(["key_generation", "copy_id", "part_ref"]);
    const expiryCols = (db.prepare("PRAGMA table_info(backup_offsite_expiry)").all() as { name: string }[]).map((c) => c.name);
    expect(expiryCols).toEqual(["expiry_intent_key", "epoch_id", "destination_id", "journal_refs_json", "state", "absent_parts", "failure_domain", "descriptor_digest", "policy_digest", "authority_authorized_at", "created_at"]);
  });
  it("parent-0018 databases upgrade to the identical shape with data preserved", async () => {
    const db = openEarly();
    db.exec(m0018);
    recordLedger(db, APPLIED_PARENT);
    // Before 0019: the parent shape fails the gate (missing upgrade row and
    // stale nonce key), proving re-application is not an upgrade path.
    await expect(assertO2MigrationAuthority(d1Database(db))).rejects.toMatchObject({ code: "BACKUP_TABLE_MISSING" });
    seedParentRows(db);
    db.exec(m0019);
    recordLedger(db, ["0019_backup_o2_replay_authority_fix.sql"]);
    await expect(assertO2MigrationAuthority(d1Database(db))).resolves.toBeUndefined();
    expect(await liveFingerprint(db)).toBe(O2_EXPECTED_SCHEMA_DIGEST);
    // Expiry rows are preserved; the new generation binding backfills from the
    // row's own creation instant (fail-closed: terminal replay must equal the
    // live grant generation, so a backfilled row refuses stale success).
    const expiry = db.prepare("SELECT expiry_intent_key, epoch_id, destination_id, journal_refs_json, state, absent_parts, failure_domain, descriptor_digest, policy_digest, authority_authorized_at, created_at FROM backup_offsite_expiry").all();
    expect(expiry).toEqual([{
      expiry_intent_key: "exp-1", epoch_id: "epoch-1", destination_id: "dest-1",
      journal_refs_json: "[]", state: "BLOCKED", absent_parts: 0, failure_domain: "domain-x",
      descriptor_digest: D64, policy_digest: D64, authority_authorized_at: T, created_at: T,
    }]);
    // Nonce rows copy verbatim across the key tightening.
    const nonces = db.prepare("SELECT key_generation, nonce_hex, copy_id, part_ref, created_at FROM backup_offsite_nonce_authority ORDER BY key_generation").all();
    expect(nonces).toEqual([
      { key_generation: "gen-1", nonce_hex: "ab".repeat(12), copy_id: "copy-1", part_ref: "part-1", created_at: T },
      { key_generation: "gen-2", nonce_hex: "cd".repeat(12), copy_id: "copy-2", part_ref: "part-1", created_at: T },
    ]);
    // Untouched tables ride along byte-identical.
    const parts = db.prepare("SELECT copy_id, part_ref, content_digest, size_bytes, nonce_hex, state, updated_at FROM backup_offsite_copy_part").all();
    expect(parts).toEqual([{
      copy_id: "copy-1", part_ref: `offsite/epoch-1/manifest-a/000000-${"e".repeat(64)}`,
      content_digest: "e".repeat(64), size_bytes: 512, nonce_hex: "ab".repeat(12), state: "VERIFIED", updated_at: T,
    }]);
  });
  it("duplicate nonce bytes inherited from the parent key abort the upgrade (fail-closed, both dimensions)", async () => {
    // Same nonce under two generations: legal under the parent PRIMARY KEY
    // (key_generation, nonce_hex), illegal under the global nonce_hex key.
    const crossGen = openEarly();
    crossGen.exec(m0018);
    crossGen.prepare("INSERT INTO backup_offsite_nonce_authority (key_generation, nonce_hex, copy_id, part_ref, created_at) VALUES (?1,?2,?3,?4,?5)")
      .run("gen-1", "ef".repeat(12), "copy-1", "part-1", T);
    crossGen.prepare("INSERT INTO backup_offsite_nonce_authority (key_generation, nonce_hex, copy_id, part_ref, created_at) VALUES (?1,?2,?3,?4,?5)")
      .run("gen-2", "ef".repeat(12), "copy-2", "part-1", T);
    expect(() => crossGen.exec(m0019)).toThrow();
    // Same owner bound to two nonces: legal without the owner UNIQUE index,
    // illegal after it.
    const crossOwner = openEarly();
    crossOwner.exec(m0018);
    crossOwner.prepare("INSERT INTO backup_offsite_nonce_authority (key_generation, nonce_hex, copy_id, part_ref, created_at) VALUES (?1,?2,?3,?4,?5)")
      .run("gen-1", "aa".repeat(12), "copy-1", "part-1", T);
    crossOwner.prepare("INSERT INTO backup_offsite_nonce_authority (key_generation, nonce_hex, copy_id, part_ref, created_at) VALUES (?1,?2,?3,?4,?5)")
      .run("gen-1", "bb".repeat(12), "copy-1", "part-1", T);
    expect(() => crossOwner.exec(m0019)).toThrow();
  });
  it("0019 without its parent 0018 predecessor aborts: the predecessor is mandatory", async () => {
    const db = openEarly();
    expect(() => db.exec(m0019)).toThrow();
  });
  it("a forged 0019 ledger row without the applied upgrade still fails the gate", async () => {
    const db = openEarly();
    db.exec(m0018);
    recordLedger(db, APPLIED_FULL);
    await expect(assertO2MigrationAuthority(d1Database(db))).rejects.toMatchObject({ code: "BACKUP_TABLE_MISSING" });
  });
  it.each([
    ["weaker per-generation nonce PK", (v: string) => v.replace("  PRIMARY KEY (nonce_hex)", "  PRIMARY KEY (key_generation, nonce_hex)")],
    ["missing nonce owner uniqueness", (v: string) => v.replace("CREATE UNIQUE INDEX IF NOT EXISTS backup_offsite_nonce_owner_unique\n  ON backup_offsite_nonce_authority(key_generation, copy_id, part_ref);", "")],
    ["missing expiry generation binding", (v: string) => v
      .replace("  authority_authorized_at TEXT NOT NULL,\n", "")
      .replace("policy_digest, authority_authorized_at, created_at)", "policy_digest, created_at)")
      .replace("descriptor_digest, policy_digest, created_at, created_at\n  FROM _backup_offsite_expiry_0018", "descriptor_digest, policy_digest, created_at\n  FROM _backup_offsite_expiry_0018")],
  ])("rejects edited upgrade variant: %s", async (_label, mutate) => {
    const db = openEarly();
    db.exec(m0018);
    db.exec(mutate(m0019.replace(/\r\n/g, "\n")));
    recordLedger(db, APPLIED_FULL);
    await expect(assertO2MigrationAuthority(d1Database(db))).rejects.toMatchObject({ code: "BACKUP_TABLE_MISSING" });
  });
});
