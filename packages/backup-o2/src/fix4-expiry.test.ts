/// <reference types="node" />
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { OperationIntent } from "@eliotr/contracts";
import { createBackupPort } from "./index.js";
import { createControlledOffsiteAdapter, type OffsiteCopyAdapter, type OffsiteStoredPart } from "./offsite.js";
import { expireOffsiteCopy } from "./expiry.js";
import { authorizeBackupDestination, revokeBackupDestination } from "./destination-authority.js";
import type { BackupDestinationPolicy } from "./destination-policy.js";
import type { BackupEpochDraft, BackupSourcePorts } from "./epoch.js";
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

// ER-34 O2 FIX4 terminal expiry replay authority (IMPLEMENTED_NOT_LIVE).
// Every terminal replay re-proves the full first-expiry reconciliation against
// live state before any success receipt: current authority, live descriptor,
// primary domain, capabilities, retention/hold, the fail-closed hold read and
// the persisted failure_domain/descriptor_digest/policy_digest/
// authority_authorized_at binding. Every negative below performs ZERO remote
// deletes and leaves no hidden D1 mutation (actual applied migrations, never
// Map fakes).

const T = "2026-09-06T00:00:00.000Z";
const HEX = (c: string): string => c.repeat(64);
const NOW = Date.parse(T);
const APPLIED = ["0001_initial.sql", "0002_execution_coordination.sql", "0003_delivery_inbox_payload_digest.sql", "0004_outbox_delivery_fence.sql", "0005_ingest_admission.sql", "0006_projection_execution.sql", "0007_evidence_resolution.sql", "0008_erasure_closure.sql", "0009_federation_authority.sql", "0010_navigation_artifacts.sql", "0011_owner_orientation.sql", "0012_google_credentials.sql", "0013_google_oauth_intents.sql", "0018_backup_o2_replay_authority.sql"];
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
  const metaOf = (k: string, o: { bytes: Uint8Array; etag: string; version: string; customMetadata: Record<string, string> }): Record<string, unknown> => ({ key: k, size: o.bytes.byteLength, etag: o.etag, version: o.version, customMetadata: { ...o.customMetadata }, httpMetadata: { contentType: "application/jsonl" } });
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
function intent(k: string): OperationIntent {
  return { intent_ref: { id: "intent-1", revision: 1 }, operation_kind: "BACKUP", principal_ref: "tester", idempotency_key: k, payload_ref: "payload-1", policy_decision_ref: "policy-1", created_at: T };
}
function policy(over: Partial<BackupDestinationPolicy> = {}): BackupDestinationPolicy {
  return { destination_id: "offsite-1", failure_domain: "domain-remote", endpoint_identity: "endpoint-1", supports_deletion_journal: true, supports_expiry: true, retention_locked: false, retention_policy_ref: "retention-1", expiry_identity: "expiry-1", policy_version: "v1", owner_ref: "owner-1", authorization_receipt_ref: "auth-1", ...over };
}
function seedRows(db: DatabaseSync): void {
  db.exec(`INSERT INTO source_namespace_ownership (source_namespace_id,ownership_record_revision,owner_system_id,owner_incarnation_ref,source_owner_generation,source_admission_policy_revision,status,cutover_receipt_ref,created_at) VALUES ('ns-1',1,'owner-sys-1','incarnation-1','gen-1',1,'ACTIVE',NULL,'${T}');
    INSERT INTO source (source_id,source_namespace_id,source_owner_system_id,source_owner_generation,ownership_mode,kind,origin_uri,title,default_storage_policy,default_residency_profile_id,source_class,license_policy_ref,default_retention_policy_id,head_rev,created_at) VALUES ('source-1','ns-1','owner-sys-1','gen-1','immutable_import','document',NULL,'T','policy-store-1','profile-1','public','license-1','retention-1',NULL,'${T}');
    INSERT INTO source_revision (source_revision_ref,source_id,source_owner_generation,content_sha256,object_residency_key_digest,original_r2_key,normalized_artifact_ref,captured_at,parser_profile_generation,quality_state,purge_state,currentness_state,source_view_ref,workspace_view_revision_ref,admitted_at) VALUES ('rev-1','source-1','gen-1','${HEX("a")}','${HEX("b")}',NULL,NULL,'${T}',NULL,'standard','LIVE','unknown','view-1',NULL,'${T}');
    INSERT INTO scope_snapshot (snapshot_id,revision,resolved_scope_expression_json,participant_generations_json,member_source_revision_refs_json,source_owner_generations_json,policy_authority_ref,disclosure_closure_digest,purge_ledger_revision,client_fence_ref,snapshot_digest,created_at,expires_at,invalidated_at,invalidation_reason) VALUES ('snap-1',1,'{}','{}','["rev-1"]','{}','policy-authority-1','${HEX("e")}',0,NULL,'${HEX("f")}','${T}','2027-09-06T00:00:00.000Z',NULL,NULL);
    INSERT INTO purge_ledger (erasure_id,non_revealing_subject_digest,disposition,receipt_ref,created_at) VALUES ('erasure-1','${HEX("4")}','COMPLETE','receipt-1','${T}');`);
}
type Harness = Awaited<ReturnType<typeof setup>>;
async function setup(): Promise<{ db: DatabaseSync; coreDb: D1Database; port: ReturnType<typeof createBackupPort> }> {
  const db = new DatabaseSync(":memory:");
  for (const m of [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010, m0011, m0012, m0013, m0018]) db.exec(m);
  for (const [i, n] of APPLIED.entries()) db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?1,?2)").run(n, `${T.slice(0, 10)}T00:00:${String(i).padStart(2, "0")}.000Z`);
  seedRows(db);
  const evidence = shimBucket(); const work = shimBucket(); const parts = shimBucket();
  const coreDb = d1Database(db);
  const ports: BackupSourcePorts = { core_db: coreDb, evidence_bucket: evidence.bucket, work_bucket: work.bucket, part_sink: testPartSink(parts.bucket), create_sha256_sink: sink };
  const port = createBackupPort(ports, { limits: { r2_list_page_size: 50, part_bytes: 512 } });
  await authorizeBackupDestination(coreDb, { destination_id: "offsite-1", principal_ref: "tester", policy_decision_ref: "policy-1", policy: policy(), authorization_receipt_ref: "auth-1" });
  return { db, coreDb, port };
}
function counting(inner: OffsiteCopyAdapter): OffsiteCopyAdapter & { deletes: number; describes: number } {
  let deletes = 0; let describes = 0;
  return {
    describe: (async () => { describes += 1; return inner.describe(); }) as OffsiteCopyAdapter["describe"],
    put: inner.put.bind(inner),
    get: inner.get.bind(inner),
    delete: async (ref: string, why: string) => { deletes += 1; return inner.delete(ref, why); },
    get deletes() { return deletes; },
    get describes() { return describes; },
  };
}
async function copied(h: Harness, key: string, adapter: OffsiteCopyAdapter): Promise<BackupEpochDraft> {
  const draft = (await h.port.createPortableEpoch(intent(key), { now_ms: NOW })).draft;
  const enc = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await h.port.copyOffsite({ draft, intent: intent(key), encryption_key: enc, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter, now_ms: Date.now() });
  return draft;
}
function expireWith(h: Harness, draft: BackupEpochDraft, key: string, ikey: string, adapter: OffsiteCopyAdapter, over: { policy?: BackupDestinationPolicy; intent?: OperationIntent } = {}) {
  return expireOffsiteCopy({ core_db: h.coreDb, draft, intent: over.intent ?? intent(key), expiry: { expiry_intent_key: ikey, epoch_id: draft.epoch_id, reason: "retention-expired" }, destination_policy: over.policy ?? policy(), primary_failure_domain: "domain-primary", adapter, now_ms: Date.now() });
}
function snap(h: Harness, ikey: string): string {
  const row = h.db.prepare("SELECT * FROM backup_offsite_expiry WHERE expiry_intent_key = ?").get(ikey) as Record<string, unknown> | undefined;
  const counts = ["backup_offsite_expiry", "backup_offsite_copy_part", "backup_offsite_copy_receipt", "backup_offsite_nonce_authority"]
    .map((t) => `${t}=${(h.db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n}`).join(",");
  return JSON.stringify(row ?? null) + "|" + counts;
}
function plainAdapter(): OffsiteCopyAdapter & { store: Map<string, { ciphertext: Uint8Array; stored: Omit<OffsiteStoredPart, "ciphertext"> }> } {
  const store = new Map<string, { ciphertext: Uint8Array; stored: Omit<OffsiteStoredPart, "ciphertext"> }>();
  return {
    store,
    describe: () => ({ destination_id: "offsite-1", failure_domain: "domain-remote", supports_deletion_journal: true, supports_expiry: true, retention_locked: false }),
    put: async (ref, ciphertext, stored) => { store.set(ref, { ciphertext: ciphertext.slice(), stored }); return { ack_ref: "ack" }; },
    get: async (ref) => { const f = store.get(ref); return f === undefined ? null : { ciphertext: f.ciphertext.slice(), stored: f.stored }; },
    delete: async (ref, _reason) => { store.delete(ref); return { journal_ref: `journal-${ref.length}` }; },
  };
}

describe("ER-34 O2 FIX4 terminal DELETED replay re-validates live authority", () => {
  it("returns persisted bytes verbatim when nothing drifted, with no new deletes", async () => {
    const h = await setup();
    const adapter = counting(createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }));
    const draft = await copied(h, "fix4-clean", adapter);
    const first = await expireWith(h, draft, "fix4-clean", "expiry-clean", adapter);
    expect(first.state).toBe("DELETED");
    const deletesAfterFirst = adapter.deletes;
    expect(deletesAfterFirst).toBe(draft.part_index.length);
    const replayed = await expireWith(h, draft, "fix4-clean", "expiry-clean", adapter);
    expect(replayed).toEqual(first);
    expect(adapter.deletes).toBe(deletesAfterFirst);
    expect(adapter.describes).toBeGreaterThan(0);
    const row = h.db.prepare("SELECT failure_domain, descriptor_digest, policy_digest, authority_authorized_at FROM backup_offsite_expiry WHERE expiry_intent_key = 'expiry-clean'").get() as { failure_domain: string; descriptor_digest: string; policy_digest: string; authority_authorized_at: string };
    expect(row.failure_domain).toBe("domain-remote");
    expect(row.authority_authorized_at.length).toBeGreaterThan(0);
  });
  it.each([
    ["primary-domain substitution", { domain: "domain-primary", journal: true, expiry: true, locked: false, hold: false }],
    ["different failure domain", { domain: "domain-evil", journal: true, expiry: true, locked: false, hold: false }],
    ["no deletion journal", { domain: "domain-remote", journal: false, expiry: true, locked: false, hold: false }],
    ["no expiry capability", { domain: "domain-remote", journal: true, expiry: false, locked: false, hold: false }],
    ["retention-locked adapter", { domain: "domain-remote", journal: true, expiry: true, locked: true, hold: false }],
    ["legal-hold adapter", { domain: "domain-remote", journal: true, expiry: true, locked: false, hold: true }],
  ] as const)("refuses terminal replay with %s: stale success denied, zero new deletes, no hidden mutation", async (label, twist) => {
    const tag = label.replace(/[^a-z]+/g, "-");
    const h = await setup();
    const good = counting(createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }));
    const draft = await copied(h, `fix4-drift-${tag}`, good);
    await expireWith(h, draft, `fix4-drift-${tag}`, `expiry-drift-${tag}`, good);
    const evil = counting(createControlledOffsiteAdapter({
      destination_id: "offsite-1",
      failure_domain: twist.domain,
      supports_deletion_journal: twist.journal,
      supports_expiry: twist.expiry,
      retention_locked: twist.locked,
      ...(twist.hold ? { legal_hold_ref: "hold-evil" } : {}),
    }));
    const before = snap(h, `expiry-drift-${tag}`);
    await expect(expireWith(h, draft, `fix4-drift-${tag}`, `expiry-drift-${tag}`, evil)).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    expect(evil.deletes).toBe(0);
    expect(evil.describes).toBeGreaterThan(0);
    expect(snap(h, `expiry-drift-${tag}`)).toBe(before);
  });
  it("refuses revoked authority, rotated policy, drifted principal/decision and retention/hold drift with zero new deletes", async () => {
    const h = await setup();
    const adapter = counting(createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }));
    const draft = await copied(h, "fix4-revoked", adapter);
    await expireWith(h, draft, "fix4-revoked", "expiry-revoked", adapter);
    const before = snap(h, "expiry-revoked");
    await revokeBackupDestination(h.coreDb, "offsite-1", "tester", "policy-1");
    await expect(expireWith(h, draft, "fix4-revoked", "expiry-revoked", adapter)).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    expect(adapter.deletes).toBe(draft.part_index.length);
    expect(snap(h, "expiry-revoked")).toBe(before);
    // Rotated policy: replay under the new grant fails the terminal binding,
    // replay under the stale grant fails authority.
    const h2 = await setup();
    const adapter2 = counting(createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }));
    const draft2 = await copied(h2, "fix4-rotated", adapter2);
    await expireWith(h2, draft2, "fix4-rotated", "expiry-rotated", adapter2);
    const before2 = snap(h2, "expiry-rotated");
    const rotated = policy({ retention_policy_ref: "retention-2", expiry_identity: "expiry-2" });
    await authorizeBackupDestination(h2.coreDb, { destination_id: "offsite-1", principal_ref: "tester", policy_decision_ref: "policy-1", policy: rotated, authorization_receipt_ref: "auth-1" });
    await expect(expireWith(h2, draft2, "fix4-rotated", "expiry-rotated", adapter2, { policy: rotated })).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    await expect(expireWith(h2, draft2, "fix4-rotated", "expiry-rotated", adapter2)).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    expect(adapter2.deletes).toBe(draft2.part_index.length);
    expect(snap(h2, "expiry-rotated")).toBe(before2);
    // Drifted principal / decision.
    const h3 = await setup();
    const adapter3 = counting(createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }));
    const draft3 = await copied(h3, "fix4-principal", adapter3);
    await expireWith(h3, draft3, "fix4-principal", "expiry-principal", adapter3);
    const before3 = snap(h3, "expiry-principal");
    await expect(expireWith(h3, draft3, "fix4-principal", "expiry-principal", adapter3, { intent: { ...intent("fix4-principal"), principal_ref: "stranger" } })).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    await expect(expireWith(h3, draft3, "fix4-principal", "expiry-principal", adapter3, { intent: { ...intent("fix4-principal"), policy_decision_ref: "policy-evil" } })).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    expect(adapter3.deletes).toBe(draft3.part_index.length);
    expect(snap(h3, "expiry-principal")).toBe(before3);
    // Retention/hold drift on the controller grant.
    const h4 = await setup();
    const adapter4 = counting(createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }));
    const draft4 = await copied(h4, "fix4-holddrift", adapter4);
    await expireWith(h4, draft4, "fix4-holddrift", "expiry-holddrift", adapter4);
    const before4 = snap(h4, "expiry-holddrift");
    const held = policy({ legal_hold_ref: "hold-9" });
    await authorizeBackupDestination(h4.coreDb, { destination_id: "offsite-1", principal_ref: "tester", policy_decision_ref: "policy-1", policy: held, authorization_receipt_ref: "auth-1" });
    await expect(expireWith(h4, draft4, "fix4-holddrift", "expiry-holddrift", adapter4, { policy: held })).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    expect(adapter4.deletes).toBe(draft4.part_index.length);
    expect(snap(h4, "expiry-holddrift")).toBe(before4);
  });
  it("refuses a forged persisted binding and an unreadable hold read with zero new deletes", async () => {
    const h = await setup();
    const adapter = counting(createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }));
    const draft = await copied(h, "fix4-forge", adapter);
    await expireWith(h, draft, "fix4-forge", "expiry-forge", adapter);
    h.db.prepare("UPDATE backup_offsite_expiry SET descriptor_digest = ? WHERE expiry_intent_key = 'expiry-forge'").run("0".repeat(64));
    await expect(expireWith(h, draft, "fix4-forge", "expiry-forge", adapter)).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    expect(adapter.deletes).toBe(draft.part_index.length);
    // Unreadable hold authority refuses even terminal history.
    const h2 = await setup();
    const adapter2 = counting(createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }));
    const draft2 = await copied(h2, "fix4-holdfail", adapter2);
    await expireWith(h2, draft2, "fix4-holdfail", "expiry-holdfail", adapter2);
    const before2 = snap(h2, "expiry-holdfail");
    const failingDb = {
      prepare: (sql: string): unknown => {
        if (sql.includes("erasure_hold")) {
          const bomb = (): never => { throw new Error("D1 erasure_hold unavailable"); };
          return { bind: () => ({ all: bomb, first: bomb, run: bomb }), all: bomb, first: bomb, run: bomb };
        }
        return (h2.coreDb as unknown as { prepare(s: string): unknown }).prepare(sql);
      },
    } as unknown as D1Database;
    await expect(expireOffsiteCopy({ core_db: failingDb, draft: draft2, intent: intent("fix4-holdfail"), expiry: { expiry_intent_key: "expiry-holdfail", epoch_id: draft2.epoch_id, reason: "retention-expired" }, destination_policy: policy(), primary_failure_domain: "domain-primary", adapter: adapter2, now_ms: Date.now() })).rejects.toMatchObject({ code: "BACKUP_TABLE_MISSING" });
    expect(adapter2.deletes).toBe(draft2.part_index.length);
    expect(snap(h2, "expiry-holdfail")).toBe(before2);
  });
  it("a later controller hold does not rewrite terminal DELETED history once absence and binding verify", async () => {
    const h = await setup();
    const adapter = counting(createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }));
    const draft = await copied(h, "fix4-latehold", adapter);
    const first = await expireWith(h, draft, "fix4-latehold", "expiry-latehold", adapter);
    h.db.prepare("INSERT INTO erasure_hold (hold_ref,exact_subject_ref,location,canonical_ref,policy_or_hold_ref,next_review_at,state,created_at,released_at) VALUES (?1,?2,NULL,NULL,?3,?4,'ACTIVE',?5,NULL)")
      .run("hold-late-1", draft.epoch_id, "retention-policy-1", "2027-01-01T00:00:00.000Z", T);
    const replayed = await expireWith(h, draft, "fix4-latehold", "expiry-latehold", adapter);
    expect(replayed).toEqual(first);
    expect(adapter.deletes).toBe(draft.part_index.length);
  });
  it("re-proves absence on terminal replay: a re-put part refuses resurrection with zero new deletes", async () => {
    const h = await setup();
    const adapter = plainAdapter();
    let deletes = 0;
    const watched: OffsiteCopyAdapter = { ...adapter, delete: async (ref: string, why: string) => { deletes += 1; return adapter.delete(ref, why); } };
    const draft = await copied(h, "fix4-resurrect", watched);
    const receipt = await expireWith(h, draft, "fix4-resurrect", "expiry-resurrect", watched);
    expect(receipt.state).toBe("DELETED");
    const before = snap(h, "expiry-resurrect");
    const ref = `offsite/${draft.epoch_id}/${draft.part_index[0]?.manifest}/${String(draft.part_index[0]?.index).padStart(6, "0")}-${draft.part_index[0]?.sha256}`;
    await adapter.put(ref, new Uint8Array([1, 2, 3]), { content_digest: HEX("9"), size_bytes: 3, key_generation: "key-gen-1", epoch_id: draft.epoch_id, expires_at: draft.expires_at });
    await expect(expireWith(h, draft, "fix4-resurrect", "expiry-resurrect", watched)).rejects.toMatchObject({ code: "BACKUP_RESURRECTION_REFUSED" });
    expect(deletes).toBe(draft.part_index.length);
    expect(snap(h, "expiry-resurrect")).toBe(before);
  });
});

describe("ER-34 O2 FIX4 terminal BLOCKED replay re-evaluates current hold state", () => {
  async function blocked(h: Harness, key: string, ikey: string, adapter: OffsiteCopyAdapter): Promise<BackupEpochDraft> {
    const draft = await copied(h, key, adapter);
    h.db.prepare("INSERT INTO erasure_hold (hold_ref,exact_subject_ref,location,canonical_ref,policy_or_hold_ref,next_review_at,state,created_at,released_at) VALUES (?1,?2,NULL,NULL,?3,?4,'ACTIVE',?5,NULL)")
      .run(`hold-${ikey}`, draft.epoch_id, "retention-policy-1", "2027-01-01T00:00:00.000Z", T);
    await expect(expireWith(h, draft, key, ikey, adapter)).rejects.toMatchObject({ code: "BACKUP_EXPIRY_BLOCKED" });
    return draft;
  }
  it("returns the current BLOCKED evaluation while the hold persists, with zero deletes and no new write", async () => {
    const h = await setup();
    const adapter = counting(createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }));
    const draft = await blocked(h, "fix4-stillblocked", "expiry-stillblocked", adapter);
    const before = snap(h, "expiry-stillblocked");
    const replayed = await expireWith(h, draft, "fix4-stillblocked", "expiry-stillblocked", adapter);
    expect(replayed.state).toBe("BLOCKED");
    expect(replayed.journal_refs).toEqual([]);
    expect(replayed.absent_parts).toBe(0);
    expect(adapter.deletes).toBe(0);
    expect(snap(h, "expiry-stillblocked")).toBe(before);
  });
  it("refuses stale BLOCKED success once the hold clears: fresh intent required, zero deletes", async () => {
    const h = await setup();
    const adapter = counting(createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }));
    const draft = await blocked(h, "fix4-cleared", "expiry-cleared", adapter);
    h.db.exec("DELETE FROM erasure_hold");
    const before = snap(h, "expiry-cleared");
    await expect(expireWith(h, draft, "fix4-cleared", "expiry-cleared", adapter)).rejects.toMatchObject({ code: "BACKUP_INTENT_CONFLICT" });
    expect(adapter.deletes).toBe(0);
    expect(snap(h, "expiry-cleared")).toBe(before);
  });
  it("refuses BLOCKED replay across descriptor drift while the hold persists", async () => {
    const h = await setup();
    const adapter = counting(createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }));
    const draft = await blocked(h, "fix4-blockdrift", "expiry-blockdrift", adapter);
    const evil = counting(createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-evil" }));
    const before = snap(h, "expiry-blockdrift");
    await expect(expireWith(h, draft, "fix4-blockdrift", "expiry-blockdrift", evil)).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    expect(evil.deletes).toBe(0);
    expect(snap(h, "expiry-blockdrift")).toBe(before);
  });
});
