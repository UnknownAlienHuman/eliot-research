/// <reference types="node" />
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { OperationIntent } from "@eliotr/contracts";
import { createBackupPort } from "./index.js";
import { createControlledOffsiteAdapter, type OffsiteCopyAdapter } from "./offsite.js";
import { expireOffsiteCopy } from "./expiry.js";
import { authorizeBackupDestination, revokeBackupDestination } from "./destination-authority.js";
import { destinationDescriptorDigest, type BackupDestinationPolicy } from "./destination-policy.js";
import { readBlockingHoldAuthority } from "./hold-authority.js";
import type { BackupSourcePorts } from "./epoch.js";
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

// ER-34 O2 FIX3 expiry + hold authority proof (IMPLEMENTED_NOT_LIVE).
// Every negative below performs ZERO remote deletes through actual D1 (real
// applied migrations, never Map fakes).

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
async function setup() {
  const db = new DatabaseSync(":memory:");
  for (const m of [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010, m0011, m0012, m0013, m0018]) db.exec(m);
  for (const [i, n] of APPLIED.entries()) db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?1,?2)").run(n, `${T.slice(0, 10)}T00:00:${String(i).padStart(2, "0")}.000Z`);
  seedRows(db);
  const evidence = shimBucket(); const work = shimBucket(); const parts = shimBucket();
  const coreDb = d1Database(db);
  const ports: BackupSourcePorts = { core_db: coreDb, evidence_bucket: evidence.bucket, work_bucket: work.bucket, part_sink: testPartSink(parts.bucket), create_sha256_sink: sink };
  const port = createBackupPort(ports, { limits: { r2_list_page_size: 50, part_bytes: 512 } });
  await authorizeBackupDestination(coreDb, { destination_id: "offsite-1", principal_ref: "tester", policy_decision_ref: "policy-1", policy: policy(), authorization_receipt_ref: "auth-1" });
  return { db, coreDb, ports, port };
}
function counting(inner: OffsiteCopyAdapter): OffsiteCopyAdapter & { deletes: number } {
  let deletes = 0;
  return {
    describe: inner.describe.bind(inner),
    put: inner.put.bind(inner),
    get: inner.get.bind(inner),
    delete: async (ref: string, why: string) => { deletes += 1; return inner.delete(ref, why); },
    get deletes() { return deletes; },
  };
}
async function copied(h: Awaited<ReturnType<typeof setup>>, key: string, adapter: OffsiteCopyAdapter) {
  const draft = (await h.port.createPortableEpoch(intent(key), { now_ms: NOW })).draft;
  const enc = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await h.port.copyOffsite({ draft, intent: intent(key), encryption_key: enc, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter, now_ms: Date.now() });
  return draft;
}
function expire(h: Awaited<ReturnType<typeof setup>> | { readonly coreDb: D1Database }, draft: { readonly epoch_id: string }, key: string, ikey: string, adapter: OffsiteCopyAdapter) {
  return expireOffsiteCopy({ core_db: h.coreDb, draft: draft as never, intent: intent(key), expiry: { expiry_intent_key: ikey, epoch_id: draft.epoch_id, reason: "retention-expired" }, destination_policy: policy(), primary_failure_domain: "domain-primary", adapter, now_ms: Date.now() });
}

describe("ER-34 O2 FIX3 hold authority (fail-closed, zero side effects)", () => {
  it("refuses when the hold SELECT fails: BACKUP_TABLE_MISSING, zero deletes", async () => {
    const h = await setup();
    const adapter = counting(createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }));
    const draft = await copied(h, "fix3-hold-fail", adapter);
    const failingDb = {
      prepare: (sql: string): unknown => {
        if (sql.includes("erasure_hold")) {
          const bomb = (): never => { throw new Error("D1 erasure_hold unavailable"); };
          return { bind: () => ({ all: bomb, first: bomb, run: bomb }), all: bomb, first: bomb, run: bomb };
        }
        return (h.coreDb as unknown as { prepare(s: string): unknown }).prepare(sql);
      },
    } as unknown as D1Database;
    await expect(readBlockingHoldAuthority(failingDb, draft.epoch_id)).rejects.toMatchObject({ code: "BACKUP_TABLE_MISSING" });
    await expect(expireOffsiteCopy({ core_db: failingDb, draft, intent: intent("fix3-hold-fail"), expiry: { expiry_intent_key: "expiry-hold-fail", epoch_id: draft.epoch_id, reason: "retention-expired" }, destination_policy: policy(), primary_failure_domain: "domain-primary", adapter, now_ms: Date.now() })).rejects.toMatchObject({ code: "BACKUP_TABLE_MISSING" });
    expect(adapter.deletes).toBe(0);
    const rows = h.db.prepare("SELECT count(*) AS n FROM backup_offsite_expiry").get() as { n: number };
    expect(rows.n).toBe(0);
  });
  it("refuses on an unreadable hold result and on an ambiguous blocking row, zero deletes", async () => {
    const h = await setup();
    const adapter = counting(createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }));
    const draft = await copied(h, "fix3-hold-amb", adapter);
    const nullResultDb = {
      prepare: (sql: string): unknown => {
        if (sql.includes("erasure_hold")) {
          return { bind: () => ({ all: async () => ({ results: null }), first: async () => null, run: async () => ({}) }), all: async () => ({ results: null }), first: async () => null, run: async () => ({}) };
        }
        return (h.coreDb as unknown as { prepare(s: string): unknown }).prepare(sql);
      },
    } as unknown as D1Database;
    await expect(readBlockingHoldAuthority(nullResultDb, draft.epoch_id)).rejects.toMatchObject({ code: "BACKUP_TABLE_MISSING" });
    // Ambiguous: a BackupRestorePath hold without a determinate reference.
    h.db.exec(`INSERT INTO erasure_hold (hold_ref,exact_subject_ref,location,canonical_ref,policy_or_hold_ref,next_review_at,state,created_at,released_at) VALUES ('',NULL,'BackupRestorePath',NULL,'retention-policy-1','2027-01-01T00:00:00.000Z','ACTIVE','${T}',NULL)`);
    await expect(readBlockingHoldAuthority(h.coreDb, draft.epoch_id)).rejects.toMatchObject({ code: "BACKUP_TABLE_MISSING" });
    await expect(expire(h, draft, "fix3-hold-amb", "expiry-hold-amb", adapter)).rejects.toMatchObject({ code: "BACKUP_TABLE_MISSING" });
    expect(adapter.deletes).toBe(0);
  });
  it("authoritative CLEAR proceeds and an active hold BLOCKs auditably with zero deletes", async () => {
    const h = await setup();
    const adapter = counting(createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }));
    const draft = await copied(h, "fix3-hold-ok", adapter);
    await expect(readBlockingHoldAuthority(h.coreDb, draft.epoch_id)).resolves.toBeNull();
    const receipt = await expire(h, draft, "fix3-hold-ok", "expiry-hold-ok", adapter);
    expect(receipt.state).toBe("DELETED");
    expect(adapter.deletes).toBe(draft.part_index.length);
    // Active epoch-pinned hold blocks with an auditable BLOCKED receipt.
    const h2 = await setup();
    const adapter2 = counting(createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }));
    const draft2 = await copied(h2, "fix3-hold-block", adapter2);
    h2.db.prepare("INSERT INTO erasure_hold (hold_ref,exact_subject_ref,location,canonical_ref,policy_or_hold_ref,next_review_at,state,created_at,released_at) VALUES (?1,?2,NULL,NULL,?3,?4,'ACTIVE',?5,NULL)")
      .run("hold-epoch-1", draft2.epoch_id, "retention-policy-1", "2027-01-01T00:00:00.000Z", T);
    await expect(readBlockingHoldAuthority(h2.coreDb, draft2.epoch_id)).resolves.toBe("hold-epoch-1");
    await expect(expire(h2, draft2, "fix3-hold-block", "expiry-hold-block", adapter2)).rejects.toMatchObject({ code: "BACKUP_EXPIRY_BLOCKED" });
    expect(adapter2.deletes).toBe(0);
    const blocked = h2.db.prepare("SELECT state, failure_domain, descriptor_digest, policy_digest FROM backup_offsite_expiry WHERE expiry_intent_key = 'expiry-hold-block'").get() as { state: string; failure_domain: string; descriptor_digest: string; policy_digest: string };
    expect(blocked.state).toBe("BLOCKED");
    expect(blocked.failure_domain).toBe("domain-remote");
    expect(blocked.descriptor_digest).toBe(await destinationDescriptorDigest(await adapter2.describe()));
  });
});

describe("ER-34 O2 FIX3 expiry reconciliation (same-or-stricter than copy)", () => {
  it("persists copy-time descriptor identity and reads it back on the receipt", async () => {
    const h = await setup();
    const adapter = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    const draft = await copied(h, "fix3-persist", adapter);
    const row = h.db.prepare("SELECT failure_domain, descriptor_digest, authority_authorized_at, policy_digest FROM backup_offsite_copy_receipt WHERE epoch_id = ?").get(draft.epoch_id) as { failure_domain: string; descriptor_digest: string; authority_authorized_at: string; policy_digest: string };
    expect(row.failure_domain).toBe("domain-remote");
    expect(row.descriptor_digest).toBe(await destinationDescriptorDigest(await adapter.describe()));
    expect(row.authority_authorized_at.length).toBeGreaterThan(0);
    expect(row.policy_digest).toMatch(/^[a-f0-9]{64}$/);
    const receipt = await expire(h, draft, "fix3-persist", "expiry-persist", adapter);
    expect(receipt.state).toBe("DELETED");
    const exp = h.db.prepare("SELECT failure_domain, descriptor_digest, policy_digest, state FROM backup_offsite_expiry WHERE expiry_intent_key = 'expiry-persist'").get() as { failure_domain: string; descriptor_digest: string; policy_digest: string; state: string };
    expect(exp.state).toBe("DELETED");
    expect(exp.failure_domain).toBe("domain-remote");
    expect(exp.descriptor_digest).toBe(row.descriptor_digest);
    expect(exp.policy_digest).toBe(row.policy_digest);
  });
  it.each([
    ["primary-domain substitution", { domain: "domain-primary", journal: true, expiry: true, locked: false, hold: false }],
    ["different failure domain", { domain: "domain-evil", journal: true, expiry: true, locked: false, hold: false }],
    ["no deletion journal", { domain: "domain-remote", journal: false, expiry: true, locked: false, hold: false }],
    ["no expiry capability", { domain: "domain-remote", journal: true, expiry: false, locked: false, hold: false }],
    ["retention-locked adapter", { domain: "domain-remote", journal: true, expiry: true, locked: true, hold: false }],
    ["legal-hold adapter", { domain: "domain-remote", journal: true, expiry: true, locked: false, hold: true }],
  ] as const)("refuses %s with zero deletes", async (label, twist) => {
    const tag = label.replace(/[^a-z]+/g, "-");
    const h = await setup();
    const good = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    const draft = await copied(h, `fix3-neg-${tag}`, good);
    const evil = counting(createControlledOffsiteAdapter({
      destination_id: "offsite-1",
      failure_domain: twist.domain,
      supports_deletion_journal: twist.journal,
      supports_expiry: twist.expiry,
      retention_locked: twist.locked,
      ...(twist.hold ? { legal_hold_ref: "hold-evil" } : {}),
    }));
    await expect(expire(h, draft, `fix3-neg-${tag}`, `expiry-neg-${tag}`, evil)).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    expect(evil.deletes).toBe(0);
  });
  it("refuses revoked authority, rotated policy, drifted principal/decision and retention/hold drift with zero deletes", async () => {
    // Revoked.
    const h = await setup();
    const adapter = counting(createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }));
    const draft = await copied(h, "fix3-revoked", adapter);
    await revokeBackupDestination(h.coreDb, "offsite-1", "tester", "policy-1");
    await expect(expire(h, draft, "fix3-revoked", "expiry-revoked", adapter)).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    expect(adapter.deletes).toBe(0);
    // Rotated policy (same ID, changed retention/expiry identity).
    const h2 = await setup();
    const adapter2 = counting(createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }));
    const draft2 = await copied(h2, "fix3-rotated", adapter2);
    const rotated = policy({ retention_policy_ref: "retention-2", expiry_identity: "expiry-2" });
    await authorizeBackupDestination(h2.coreDb, { destination_id: "offsite-1", principal_ref: "tester", policy_decision_ref: "policy-1", policy: rotated, authorization_receipt_ref: "auth-1" });
    await expect(expireOffsiteCopy({ core_db: h2.coreDb, draft: draft2, intent: intent("fix3-rotated"), expiry: { expiry_intent_key: "expiry-rotated", epoch_id: draft2.epoch_id, reason: "retention-expired" }, destination_policy: rotated, primary_failure_domain: "domain-primary", adapter: adapter2, now_ms: Date.now() })).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    expect(adapter2.deletes).toBe(0);
    // Drifted principal / decision.
    const h3 = await setup();
    const adapter3 = counting(createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }));
    const draft3 = await copied(h3, "fix3-principal", adapter3);
    await expect(expireOffsiteCopy({ core_db: h3.coreDb, draft: draft3, intent: { ...intent("fix3-principal"), principal_ref: "stranger" }, expiry: { expiry_intent_key: "expiry-stranger", epoch_id: draft3.epoch_id, reason: "retention-expired" }, destination_policy: policy(), primary_failure_domain: "domain-primary", adapter: adapter3, now_ms: Date.now() })).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    await expect(expireOffsiteCopy({ core_db: h3.coreDb, draft: draft3, intent: { ...intent("fix3-principal"), policy_decision_ref: "policy-evil" }, expiry: { expiry_intent_key: "expiry-evil", epoch_id: draft3.epoch_id, reason: "retention-expired" }, destination_policy: policy(), primary_failure_domain: "domain-primary", adapter: adapter3, now_ms: Date.now() })).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    expect(adapter3.deletes).toBe(0);
    // Retention/hold drift on the controller grant.
    const h4 = await setup();
    const adapter4 = counting(createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }));
    const draft4 = await copied(h4, "fix3-holddrift", adapter4);
    await authorizeBackupDestination(h4.coreDb, { destination_id: "offsite-1", principal_ref: "tester", policy_decision_ref: "policy-1", policy: policy({ legal_hold_ref: "hold-9" }), authorization_receipt_ref: "auth-1" });
    await expect(expireOffsiteCopy({ core_db: h4.coreDb, draft: draft4, intent: intent("fix3-holddrift"), expiry: { expiry_intent_key: "expiry-holddrift", epoch_id: draft4.epoch_id, reason: "retention-expired" }, destination_policy: policy({ legal_hold_ref: "hold-9" }), primary_failure_domain: "domain-primary", adapter: adapter4, now_ms: Date.now() })).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    expect(adapter4.deletes).toBe(0);
  });
});
