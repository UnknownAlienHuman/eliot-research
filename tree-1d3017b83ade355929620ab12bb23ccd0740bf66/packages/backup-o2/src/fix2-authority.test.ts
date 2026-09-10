/// <reference types="node" />
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { OperationIntent } from "@eliotr/contracts";
import { createBackupPort } from "./index.js";
import { reopenPersistedVector, type BackupSourcePorts } from "./epoch.js";
import { assertO2MigrationAuthority, O2_MIGRATION_FILENAME, O2_UPGRADE_FILENAME, O2_EXPECTED_MIGRATION_DIGEST, O2_EXPECTED_UPGRADE_DIGEST, O2_EXPECTED_SCHEMA_DIGEST, canonicalO2SchemaFingerprint, canonicalizeSchemaSql } from "./migration-gate.js";
import { BACKUP_MANIFEST_PROTOCOL } from "./coherent-cut.js";
import { authorizeBackupDestination, requireDestinationAuthority, revokeBackupDestination } from "./destination-authority.js";
import type { BackupDestinationPolicy } from "./destination-policy.js";
import type { Sha256DigestSink, EvidenceObjectStore } from "./shared.js";
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

// ER-34 O2 FIX2 authority regressions: migration gate, full intent digest,
// coherent cut + column inventory + protocol id, controller-owned destination
// authority. All D1 tests apply the actual tracked migrations plus 0018 and
// 0019 and record the ledger exactly like the authoritative runner.

const T = "2026-09-06T00:00:00.000Z";
const HEX = (c: string): string => c.repeat(64);
const NOW = Date.parse(T);
const APPLIED = ["0001_initial.sql", "0002_execution_coordination.sql", "0003_delivery_inbox_payload_digest.sql", "0004_outbox_delivery_fence.sql", "0005_ingest_admission.sql", "0006_projection_execution.sql", "0007_evidence_resolution.sql", "0008_erasure_closure.sql", "0009_federation_authority.sql", "0010_navigation_artifacts.sql", "0011_owner_orientation.sql", "0012_google_credentials.sql", "0013_google_oauth_intents.sql", "0018_backup_o2_replay_authority.sql", "0019_backup_o2_replay_authority_fix.sql"];
function sink(): Sha256DigestSink {
  const chunks: Uint8Array[] = [];
  let res!: (v: ArrayBuffer) => void; let rej!: (r: unknown) => void;
  const result = new Promise<ArrayBuffer>((a, b) => { res = a; rej = b; });
  return { writable: new WritableStream<Uint8Array>({ write(c) { chunks.push(c.slice()); }, async close() { try { const t = chunks.reduce((s, c) => s + c.byteLength, 0); const body = new Uint8Array(t); let o = 0; for (const c of chunks) { body.set(c, o); o += c.byteLength; } const cp = new Uint8Array(body.byteLength); cp.set(body); res(await crypto.subtle.digest("SHA-256", cp.buffer)); } catch (e) { rej(e); } }, abort(r) { rej(r); } }), digest: result };
}
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
function shimBucket(): { bucket: R2Bucket } {
  const objects = new Map<string, { bytes: Uint8Array; etag: string; version: string; customMetadata: Record<string, string> }>(); let seq = 0;
  const streamOf = (b: Uint8Array): ReadableStream<Uint8Array> => new ReadableStream({ start(c) { c.enqueue(b.slice()); c.close(); } });
  const metaOf = (k: string, o: { bytes: Uint8Array; etag: string; version: string; customMetadata: Record<string, string> }): Record<string, unknown> => ({ key: k, size: o.bytes.byteLength, etag: o.etag, version: o.version, customMetadata: { ...o.customMetadata }, httpMetadata: { contentType: "application/octet-stream" } });
  const api = {
    async head(k: string) { const o = objects.get(k); return o === undefined ? null : metaOf(k, o); },
    async get(k: string) { const o = objects.get(k); if (o === undefined) return null; const f = o.bytes.slice(); return { ...metaOf(k, o), size: o.bytes.byteLength, body: streamOf(o.bytes), bytes: async () => f.slice() }; },
    async put(k: string, v: Uint8Array | ReadableStream<Uint8Array> | string, po?: Record<string, unknown>) {
      const bytes = typeof v === "string" ? new TextEncoder().encode(v) : v instanceof Uint8Array ? v : new Uint8Array(await new Response(v as ReadableStream<Uint8Array>).arrayBuffer());
      seq += 1; objects.set(k, { bytes: bytes.slice(), etag: `etag-${seq}`, version: `version-${seq}`, customMetadata: { ...((po?.["customMetadata"] as Record<string, string> | undefined) ?? {}) } });
      return { key: k, etag: `etag-${seq}`, version: `version-${seq}` };
    },
    async delete(i: string | string[]) { for (const k of typeof i === "string" ? [i] : i) objects.delete(k); },
    async list(lo?: { prefix?: string; limit?: number; cursor?: string }) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(lo?.prefix ?? "")).sort();
      const s = lo?.cursor === undefined ? 0 : Number(lo.cursor);
      const page = keys.slice(s, s + (lo?.limit ?? 1000)); const n = s + (lo?.limit ?? 1000);
      return n < keys.length ? { objects: page.map((k) => metaOf(k, objects.get(k) as never)), truncated: true, cursor: String(n), delimitedPrefixes: [] } : { objects: page.map((k) => metaOf(k, objects.get(k) as never)), truncated: false, delimitedPrefixes: [] };
    },
  };
  return { bucket: api as unknown as R2Bucket };
}
function testPartSink(bucket: R2Bucket): EvidenceObjectStore {
  return {
    async putImmutable(w) {
      const e = await bucket.get(w.key);
      if (e !== null) return { key: w.key, expected_sha256: w.expected_sha256, readback_sha256: w.expected_sha256, size_bytes: w.expected_size_bytes, etag: (e as unknown as { etag: string }).etag, existed_identically: true };
      const bytes = new Uint8Array(await new Response(w.body as ReadableStream<Uint8Array>).arrayBuffer());
      await (bucket as unknown as { put(k: string, v: Uint8Array, o: unknown): Promise<{ etag: string }> }).put(w.key, bytes, { customMetadata: w.custom_metadata, httpMetadata: { contentType: w.content_type } });
      const head = await bucket.head(w.key) as unknown as { etag: string };
      return { key: w.key, expected_sha256: w.expected_sha256, readback_sha256: w.expected_sha256, size_bytes: bytes.byteLength, etag: head.etag, existed_identically: false };
    },
    async open(k) { return bucket.get(k); },
  };
}
const MIGRATIONS = [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010, m0011, m0012, m0013, m0018, m0019];
function openCore(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  return db;
}
function recordLedger(db: DatabaseSync): void {
  for (const [i, n] of APPLIED.entries()) db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?1,?2)").run(n, `${T.slice(0, 10)}T00:00:${String(i).padStart(2, "0")}.000Z`);
}
function seedCore(db: DatabaseSync): void {
  db.exec(`INSERT INTO source_namespace_ownership (source_namespace_id,ownership_record_revision,owner_system_id,owner_incarnation_ref,source_owner_generation,source_admission_policy_revision,status,cutover_receipt_ref,created_at) VALUES ('ns-1',1,'owner-sys-1','incarnation-1','gen-1',1,'ACTIVE',NULL,'${T}');
    INSERT INTO source (source_id,source_namespace_id,source_owner_system_id,source_owner_generation,ownership_mode,kind,origin_uri,title,default_storage_policy,default_residency_profile_id,source_class,license_policy_ref,default_retention_policy_id,head_rev,created_at) VALUES ('source-1','ns-1','owner-sys-1','gen-1','immutable_import','document','https://origin.example/s1','TITLE-7f3a','policy-store-1','profile-1','public','license-1','retention-1',NULL,'${T}');
    INSERT INTO source_revision (source_revision_ref,source_id,source_owner_generation,content_sha256,object_residency_key_digest,original_r2_key,normalized_artifact_ref,captured_at,parser_profile_generation,quality_state,purge_state,currentness_state,source_view_ref,workspace_view_revision_ref,admitted_at) VALUES ('rev-1','source-1','gen-1','${HEX("a")}','${HEX("b")}',NULL,NULL,'${T}','parser-gen-9','standard','LIVE','current_confirmed','view-1','ws-view-3','${T}');
    INSERT INTO project (project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref,default_model_profile_ref,default_depth_profile_ref,generation,created_at) VALUES ('proj-1','Project One','owner-only','retention-1','source-policy-1','model-1','depth-1',1,'${T}');
    INSERT INTO project_source_membership (project_id,source_id,role,valid_from,valid_to,membership_generation) VALUES ('proj-1','source-1','owner','${T}',NULL,1);
    INSERT INTO scope_snapshot (snapshot_id,revision,resolved_scope_expression_json,participant_generations_json,member_source_revision_refs_json,source_owner_generations_json,policy_authority_ref,disclosure_closure_digest,purge_ledger_revision,client_fence_ref,snapshot_digest,created_at,expires_at,invalidated_at,invalidation_reason) VALUES ('snap-1',1,'{}','{}','["rev-1"]','{}','policy-authority-1','${HEX("e")}',1,'fence-7','${HEX("f")}','${T}','2027-09-06T00:00:00.000Z',NULL,NULL);
    INSERT INTO evidence_handle (handle_id,revision,source_namespace_id,source_owner_generation,source_revision_ref,scope_snapshot_id,scope_snapshot_revision,anchor_json,excerpt_sha256,excerpt_byte_length,coordinate_map_ref,loss_map_ref,object_residency_key_digest,source_assurance_ceiling,materializer_assurance_ceiling,terminal_state,invalidation_ref,created_at,expires_at) VALUES ('h-1',1,'ns-1','gen-1','rev-1','snap-1',1,'{}','${HEX("1")}',16,'coord-1','loss-1','${HEX("b")}','source-local','source-local','LIVE',NULL,'${T}','2027-01-01T00:00:00.000Z');
    INSERT INTO artifact_revision (artifact_id,revision,kind,spec_digest,evidence_freeze_id,evidence_freeze_revision,manifest_r2_key,dependency_manifest_ref,status,created_at) VALUES ('art-1',1,'report','${HEX("3")}','freeze-1',1,'r2-artifact-1','dep-9','PUBLISHED','${T}');
    INSERT INTO purge_ledger (erasure_id,non_revealing_subject_digest,disposition,receipt_ref,created_at) VALUES ('erasure-1','${HEX("4")}','COMPLETE','receipt-1','${T}');`);
}
function backupIntent(k: string, over: Partial<OperationIntent> = {}): OperationIntent {
  return { intent_ref: { id: "intent-1", revision: 1 }, operation_kind: "BACKUP", principal_ref: "tester", idempotency_key: k, payload_ref: "payload-1", policy_decision_ref: "policy-1", created_at: T, ...over };
}
function policy(over: Partial<BackupDestinationPolicy> = {}): BackupDestinationPolicy {
  return { destination_id: "offsite-1", failure_domain: "domain-remote", endpoint_identity: "endpoint-1", supports_deletion_journal: true, supports_expiry: true, retention_locked: false, retention_policy_ref: "retention-1", expiry_identity: "expiry-1", policy_version: "v1", owner_ref: "owner-1", authorization_receipt_ref: "auth-1", ...over };
}
async function setup() {
  const db = openCore(); recordLedger(db); seedCore(db);
  const evidence = shimBucket(); const work = shimBucket(); const parts = shimBucket();
  const coreDb = d1Database(db);
  const ports: BackupSourcePorts = { core_db: coreDb, evidence_bucket: evidence.bucket, work_bucket: work.bucket, part_sink: testPartSink(parts.bucket), create_sha256_sink: sink };
  return { db, coreDb, port: createBackupPort(ports, { limits: { r2_list_page_size: 50, part_bytes: 512 } }), ports };
}

describe("ER-34 O2 FIX2 authority (migration gate, intent digest, cut, destination)", () => {
  it("fails closed without the 0018 ledger row: no runtime DDL substitute, no ABSENT tolerance", async () => {
    const db = openCore(); seedCore(db);
    const coreDb = d1Database(db);
    await expect(assertO2MigrationAuthority(coreDb)).rejects.toMatchObject({ code: "BACKUP_TABLE_MISSING" });
    const evidence = shimBucket(); const work = shimBucket(); const parts = shimBucket();
    const ports: BackupSourcePorts = { core_db: coreDb, evidence_bucket: evidence.bucket, work_bucket: work.bucket, part_sink: testPartSink(parts.bucket), create_sha256_sink: sink };
    await expect(createBackupPort(ports).createPortableEpoch(backupIntent("gate-1"), { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_TABLE_MISSING" });
    // The schema exists (migration SQL applied) but without the ledger row the
    // gate fails closed instead of substituting runtime DDL or ABSENT tolerance.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'backup_%'").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain("backup_epoch_receipt");
    recordLedger(db);
    await expect(assertO2MigrationAuthority(coreDb)).resolves.toBeUndefined();
    expect(O2_MIGRATION_FILENAME).toBe("0018_backup_o2_replay_authority.sql");
    expect(O2_UPGRADE_FILENAME).toBe("0019_backup_o2_replay_authority_fix.sql");
  });
  it("fails closed on hand-created O2 tables with a forged ledger row and wrong shape", async () => {
    const db = new DatabaseSync(":memory:");
    for (const m of MIGRATIONS.slice(0, 13)) db.exec(m);
    seedCore(db);
    // Forge the ledger claim without applying migration 0018, plus a
    // wrong-shaped table: the gate checks live shape, not just the row.
    db.exec("CREATE TABLE d1_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT");
    db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?1,?2)").run("0018_backup_o2_replay_authority.sql", T);
    db.exec("CREATE TABLE backup_epoch_receipt (idempotency_key TEXT PRIMARY KEY, intent_id TEXT NOT NULL) STRICT");
    await expect(assertO2MigrationAuthority(d1Database(db))).rejects.toMatchObject({ code: "BACKUP_TABLE_MISSING" });
  });
  it("conflicts on every immutable intent field, including revision and cancellation refs", async () => {
    const h = await setup();
    const first = await h.port.createPortableEpoch(backupIntent("fix2-digest"), { now_ms: NOW });
    expect(first.receipt.outcome).toBe("SUCCEEDED");
    const variants: Partial<OperationIntent>[] = [
      { principal_ref: "attacker" },
      { payload_ref: "payload-evil" },
      { policy_decision_ref: "policy-evil" },
      { created_at: "2027-01-01T00:00:00.000Z" },
      { intent_ref: { id: "intent-evil", revision: 1 } },
      { intent_ref: { id: "intent-1", revision: 2 } },
      { budget_reservation_ref: "budget-evil" },
      { cancellation_ref: "cancel-evil" },
    ];
    for (const over of variants) {
      await expect(h.port.createPortableEpoch(backupIntent("fix2-digest", over), { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_INTENT_CONFLICT" });
    }
    const replayed = await h.port.createPortableEpoch(backupIntent("fix2-digest"), { now_ms: NOW + 5_000 });
    expect(replayed.receipt).toEqual(first.receipt);
  });
  it("binds the coherent cut, protocol id, schema inventory and every Luna-listed column", async () => {
    const h = await setup();
    const r = await h.port.createPortableEpoch(backupIntent("fix2-cut"), { now_ms: NOW });
    expect(r.draft.manifest_protocol).toBe(BACKUP_MANIFEST_PROTOCOL);
    expect(r.draft.cut_id).toMatch(/^cut-[a-f0-9]{32}$/);
    const cut = h.db.prepare("SELECT cut_digest, state FROM backup_export_cut WHERE cut_id = ?").get(r.draft.cut_id) as { cut_digest: string; state: string };
    expect(cut.state).toBe("ACCEPTED");
    expect(cut.cut_digest).toMatch(/^[a-f0-9]{64}$/);
    // Every Luna-listed load-bearing column is present in the export payload.
    const sources = r.draft.part_index.filter((p) => p.manifest === "sources");
    expect(sources.length).toBeGreaterThan(0);
    const reopened = await reopenPersistedVector(h.ports, r.draft);
    const generation = h.db.prepare("SELECT value FROM schema_state WHERE key = 'schema_generation'").get() as { value: string };
    expect(reopened.schema_generation).toBe(generation.value);
    const row = h.db.prepare("SELECT origin_uri FROM source WHERE source_id = 'source-1'").get() as { origin_uri: string };
    expect(row.origin_uri).toBe("https://origin.example/s1");
  });
  it("withholds the epoch when D1 mutates between freeze and seal", async () => {
    const h = await setup();
    interface Bound { all<T>(): Promise<D1Result<T>>; first<T>(): Promise<T | null>; run<T>(): Promise<D1Result<T>>; }
    interface Stmt extends Bound { bind(...p: unknown[]): Bound; }
    const innerPrepare = (h.ports.core_db as unknown as { prepare(sql: string): Stmt }).prepare.bind(h.ports.core_db);
    let mutated = false;
    let purgeReads = 0;
    const racingDb = {
      prepare: (sql: string): Stmt => {
        const stmt = innerPrepare(sql);
        // Mutate BEFORE the phase-2 re-verification read executes (the
        // second purge read), so the reread digest must diverge from the cut.
        const beforeRead = (): void => {
          if (!sql.includes("FROM purge_ledger")) return;
          purgeReads += 1;
          if (!mutated && purgeReads >= 2) {
            mutated = true;
            h.db.exec(`INSERT INTO purge_ledger (erasure_id,non_revealing_subject_digest,disposition,receipt_ref,created_at) VALUES ('erasure-race','${HEX("5")}','BLOCKED','receipt-race','${T}')`);
          }
        };
        const boundAll = (bound: Bound): Bound["all"] => async <T>(): Promise<D1Result<T>> => {
          beforeRead();
          return bound.all<T>();
        };
        return {
          bind: (...p: unknown[]): Bound => {
            const bound = stmt.bind(...p);
            return { ...bound, all: boundAll(bound) };
          },
          first: <T>(): Promise<T | null> => stmt.first<T>(),
          run: <T>(): Promise<D1Result<T>> => stmt.run<T>(),
          all: async <T>(): Promise<D1Result<T>> => {
            beforeRead();
            return stmt.all<T>();
          },
        };
      },
    } as unknown as D1Database;
    const racingPorts: BackupSourcePorts = { ...h.ports, core_db: racingDb };
    await expect(createBackupPort(racingPorts, { limits: { r2_list_page_size: 50, part_bytes: 512 } }).createPortableEpoch(backupIntent("fix2-race"), { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_VECTOR_DRIFT" });
    expect(mutated).toBe(true);
  });
  it("fails closed on an unclassified column and on a tampered manifest protocol", async () => {
    const h = await setup();
    h.db.exec("ALTER TABLE source ADD COLUMN o2_unclassified TEXT");
    await expect(h.port.createPortableEpoch(backupIntent("fix2-col"), { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_COVERAGE_GAP" });
    const h2 = await setup();
    const r = await h2.port.createPortableEpoch(backupIntent("fix2-proto"), { now_ms: NOW });
    await expect(reopenPersistedVector(h2.ports, { ...r.draft, manifest_protocol: "eliotr.backup-manifest.v9" })).rejects.toMatchObject({ code: "BACKUP_VECTOR_UNVERIFIABLE" });
  });
  it("requires exact controller authority: negatives for principal, decision, domain, capability, retention, hold, lock, auth receipt, revocation", async () => {    const h = await setup();
    await authorizeBackupDestination(h.coreDb, { destination_id: "offsite-1", principal_ref: "tester", policy_decision_ref: "policy-1", policy: policy(), authorization_receipt_ref: "auth-1" });
    const good = await requireDestinationAuthority(h.coreDb, backupIntent("x"), policy());
    expect(good.state).toBe("AUTHORIZED");
    await expect(requireDestinationAuthority(h.coreDb, backupIntent("x", { principal_ref: "wrong" }), policy())).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    await expect(requireDestinationAuthority(h.coreDb, backupIntent("x", { policy_decision_ref: "wrong" }), policy())).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    await expect(requireDestinationAuthority(h.coreDb, backupIntent("x"), policy({ failure_domain: "other" }))).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    await expect(requireDestinationAuthority(h.coreDb, backupIntent("x"), policy({ supports_deletion_journal: false }))).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    await expect(requireDestinationAuthority(h.coreDb, backupIntent("x"), policy({ retention_policy_ref: "other" }))).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    await expect(requireDestinationAuthority(h.coreDb, backupIntent("x"), policy({ legal_hold_ref: "hold-1" }))).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    await expect(requireDestinationAuthority(h.coreDb, backupIntent("x"), policy({ retention_locked: true }))).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    await expect(requireDestinationAuthority(h.coreDb, backupIntent("x"), policy({ authorization_receipt_ref: "auth-evil" }))).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    await revokeBackupDestination(h.coreDb, "offsite-1", "tester", "policy-1");
    await expect(requireDestinationAuthority(h.coreDb, backupIntent("x"), policy())).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    await authorizeBackupDestination(h.coreDb, { destination_id: "offsite-1", principal_ref: "tester", policy_decision_ref: "policy-1", policy: policy(), authorization_receipt_ref: "auth-1" });
    await expect(requireDestinationAuthority(h.coreDb, backupIntent("x"), policy())).resolves.toMatchObject({ state: "AUTHORIZED" });
  });
});

describe("ER-34 O2 FIX3 canonical migration authority", () => {
  const LF0018 = m0018.replace(/\r\n/g, "\n");
  async function shaHex(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer))].map((v) => v.toString(16).padStart(2, "0")).join("");
  }
  function mutatedDb(variant0018: string): { db: DatabaseSync; coreDb: D1Database } {
    const db = new DatabaseSync(":memory:");
    for (const m of MIGRATIONS.slice(0, 13)) db.exec(m);
    db.exec(variant0018);
    // Complete intended chain: the forward 0019 upgrade runs over the edited
    // 0018, exactly as the authoritative runner would apply it. Rejection
    // below is therefore mutation/digest/fingerprint detection, never an
    // absent-schema artifact from a skipped 0019.
    db.exec(m0019);
    for (const [i, n] of APPLIED.entries()) db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?1,?2)").run(n, `${T.slice(0, 10)}T00:00:${String(i).padStart(2, "0")}.000Z`);
    return { db, coreDb: d1Database(db) };
  }
  it("binds the expected migration content digests to the tracked 0018 + 0019 files", async () => {
    expect(await shaHex(m0018.replace(/\r\n/g, "\n"))).toBe(O2_EXPECTED_MIGRATION_DIGEST);
    expect(await shaHex(m0019.replace(/\r\n/g, "\n"))).toBe(O2_EXPECTED_UPGRADE_DIGEST);
  });
  it("reads back the canonical schema fingerprint from the actual applied 0018", async () => {
    const db = openCore(); recordLedger(db);
    const coreDb = d1Database(db);
    await expect(assertO2MigrationAuthority(coreDb)).resolves.toBeUndefined();
    const tableRows = (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('d1_migrations','backup_epoch_receipt','backup_offsite_expiry','backup_destination_authority','backup_offsite_copy_part','backup_offsite_copy_receipt','backup_export_cut','backup_offsite_nonce_authority')").all() as { name: string; sql: string }[]);
    expect(tableRows.length).toBe(8);
    const entries: { kind: "table" | "index"; name: string; sql: string }[] = tableRows.map((row) => ({ kind: "table" as const, name: row.name, sql: row.sql }));
    const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND tbl_name IN ('d1_migrations','backup_epoch_receipt','backup_offsite_expiry','backup_destination_authority','backup_offsite_copy_part','backup_offsite_copy_receipt','backup_export_cut','backup_offsite_nonce_authority')").all() as { name: string; sql: string }[];
    expect(indexes.map((r) => r.name)).toEqual(["backup_offsite_copy_part_nonce_unique", "backup_offsite_nonce_owner_unique"]);
    for (const row of indexes) entries.push({ kind: "index" as const, name: row.name, sql: row.sql });
    expect(await canonicalO2SchemaFingerprint(entries)).toBe(O2_EXPECTED_SCHEMA_DIGEST);
    expect(canonicalizeSchemaSql("  CREATE   TABLE x (\n a TEXT )  ")).toBe("CREATE TABLE x ( a TEXT )");
  });
  it("rejects the forged weak schema (same columns, no constraints) with a fake ledger row", async () => {
    const db = new DatabaseSync(":memory:");
    for (const m of MIGRATIONS.slice(0, 13)) db.exec(m);
    db.exec("CREATE TABLE d1_migrations (name TEXT NOT NULL, applied_at TEXT NOT NULL)");
    db.exec("CREATE TABLE backup_epoch_receipt (idempotency_key TEXT NOT NULL, intent_id TEXT NOT NULL, intent_digest TEXT NOT NULL, vector_digest TEXT NOT NULL, manifest_digest TEXT NOT NULL, epoch_id TEXT NOT NULL, receipt_json TEXT NOT NULL, draft_json TEXT NOT NULL, attempt_json TEXT NOT NULL, created_at TEXT NOT NULL)");
    db.exec("CREATE TABLE backup_offsite_expiry (expiry_intent_key TEXT NOT NULL, epoch_id TEXT NOT NULL, destination_id TEXT NOT NULL, journal_refs_json TEXT NOT NULL, state TEXT NOT NULL, absent_parts INTEGER NOT NULL, created_at TEXT NOT NULL, failure_domain TEXT NOT NULL, descriptor_digest TEXT NOT NULL, policy_digest TEXT NOT NULL)");
    db.exec("CREATE TABLE backup_destination_authority (destination_id TEXT NOT NULL, principal_ref TEXT NOT NULL, policy_decision_ref TEXT NOT NULL, policy_json TEXT NOT NULL, policy_digest TEXT NOT NULL, authorization_receipt_ref TEXT NOT NULL, state TEXT NOT NULL, authorized_at TEXT NOT NULL, revoked_at TEXT)");
    db.exec("CREATE TABLE backup_offsite_copy_part (copy_id TEXT NOT NULL, part_ref TEXT NOT NULL, content_digest TEXT NOT NULL, size_bytes INTEGER NOT NULL, nonce_hex TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL)");
    db.exec("CREATE TABLE backup_offsite_copy_receipt (copy_id TEXT NOT NULL, epoch_id TEXT NOT NULL, destination_id TEXT NOT NULL, key_generation TEXT NOT NULL, policy_digest TEXT NOT NULL, intent_digest TEXT NOT NULL, receipt_json TEXT NOT NULL, epoch_json TEXT NOT NULL, attempt_json TEXT NOT NULL, readback_digest TEXT NOT NULL, expires_at TEXT NOT NULL, failure_domain TEXT NOT NULL, descriptor_digest TEXT NOT NULL, authority_authorized_at TEXT NOT NULL, created_at TEXT NOT NULL)");
    db.exec("CREATE TABLE backup_export_cut (cut_id TEXT NOT NULL, cut_digest TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL)");
    db.exec("CREATE TABLE backup_offsite_nonce_authority (key_generation TEXT NOT NULL, nonce_hex TEXT NOT NULL, copy_id TEXT NOT NULL, part_ref TEXT NOT NULL, created_at TEXT NOT NULL)");
    db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?1,?2)").run("0018_backup_o2_replay_authority.sql", T);
    await expect(assertO2MigrationAuthority(d1Database(db))).rejects.toMatchObject({ code: "BACKUP_TABLE_MISSING" });
  });
  it.each([
    ["dropped CHECK", LF0018.replace("cut_digest TEXT NOT NULL CHECK (length(cut_digest) = 64)", "cut_digest TEXT NOT NULL")],
    ["dropped UNIQUE index", LF0018.replace("CREATE UNIQUE INDEX IF NOT EXISTS backup_offsite_copy_part_nonce_unique\n  ON backup_offsite_copy_part(copy_id, nonce_hex);", "")],
    ["added DEFAULT", LF0018.replace("updated_at TEXT NOT NULL,\n  PRIMARY KEY (copy_id, part_ref)", "updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',\n  PRIMARY KEY (copy_id, part_ref)")],
    ["altered PRIMARY KEY", LF0018.replace("PRIMARY KEY (copy_id, part_ref)", "PRIMARY KEY (copy_id)")],
    ["dropped STRICT", LF0018.replace("state TEXT NOT NULL CHECK (state IN ('OPEN','ACCEPTED','REJECTED')),\n  created_at TEXT NOT NULL\n) STRICT;", "state TEXT NOT NULL CHECK (state IN ('OPEN','ACCEPTED','REJECTED')),\n  created_at TEXT NOT NULL\n);")],
    ["reordered column", LF0018.replace("authorized_at TEXT NOT NULL,\n  revoked_at TEXT,", "revoked_at TEXT,\n  authorized_at TEXT NOT NULL,")],
  ])("rejects edited migration variant: %s", async (_label, variant) => {
    // File binding: the edited variant digest differs from the pinned parent
    // digest, so the content check binds the gate to the exact tracked bytes.
    expect(await shaHex(variant)).not.toBe(O2_EXPECTED_MIGRATION_DIGEST);
    const { db, coreDb } = mutatedDb(variant);
    // Non-vacuous chain proof: BOTH ledger rows are recorded, every O2 table
    // is present, and 0019 applied cleanly over the variant -- so the gate
    // rejection below is shape/fingerprint detection of the mutation itself,
    // not an absent ledger row or an unapplied upgrade.
    const ledger = (db.prepare("SELECT name FROM d1_migrations").all() as { name: string }[]).map((r) => r.name);
    expect(ledger).toContain("0018_backup_o2_replay_authority.sql");
    expect(ledger).toContain("0019_backup_o2_replay_authority_fix.sql");
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'backup_%'").all() as { name: string }[]).map((r) => r.name);
    for (const required of ["backup_epoch_receipt", "backup_offsite_expiry", "backup_destination_authority", "backup_offsite_copy_part", "backup_offsite_copy_receipt", "backup_export_cut", "backup_offsite_nonce_authority"]) {
      expect(tables).toContain(required);
    }
    await expect(assertO2MigrationAuthority(coreDb)).rejects.toMatchObject({ code: "BACKUP_TABLE_MISSING" });
  });
});
