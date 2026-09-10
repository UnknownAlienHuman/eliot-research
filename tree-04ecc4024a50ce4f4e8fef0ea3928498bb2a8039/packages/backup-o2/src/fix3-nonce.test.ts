/// <reference types="node" />
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { OperationIntent } from "@eliotr/contracts";
import { createBackupPort } from "./index.js";
import { createControlledOffsiteAdapter, type OffsiteCopyAdapter } from "./offsite.js";
import { authorizeBackupDestination } from "./destination-authority.js";
import { allocateOffsiteNonce } from "./nonce-authority.js";
import { backupNonceHex } from "./offsite-durability.js";
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
import m0019 from "../../../infra/d1/core/migrations/0019_backup_o2_replay_authority_fix.sql?raw";

// ER-34 O2 FIX3 durable nonce authority proof (IMPLEMENTED_NOT_LIVE).
// Uniqueness is enforced per key generation by an atomic D1 insert BEFORE
// encryption or remote put, across restart, concurrent copies and key changes.

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
function intent(k: string): OperationIntent {
  return { intent_ref: { id: "intent-1", revision: 1 }, operation_kind: "BACKUP", principal_ref: "tester", idempotency_key: k, payload_ref: "payload-1", policy_decision_ref: "policy-1", created_at: T };
}
function policy(over: Partial<BackupDestinationPolicy> = {}): BackupDestinationPolicy {
  return { destination_id: "offsite-1", failure_domain: "domain-remote", endpoint_identity: "endpoint-1", supports_deletion_journal: true, supports_expiry: true, retention_locked: false, retention_policy_ref: "retention-1", expiry_identity: "expiry-1", policy_version: "v1", owner_ref: "owner-1", authorization_receipt_ref: "auth-1", ...over };
}
function seedCore(db: DatabaseSync): void {
  db.exec(`INSERT INTO source_namespace_ownership (source_namespace_id,ownership_record_revision,owner_system_id,owner_incarnation_ref,source_owner_generation,source_admission_policy_revision,status,cutover_receipt_ref,created_at) VALUES ('ns-1',1,'owner-sys-1','incarnation-1','gen-1',1,'ACTIVE',NULL,'${T}');
    INSERT INTO source (source_id,source_namespace_id,source_owner_system_id,source_owner_generation,ownership_mode,kind,origin_uri,title,default_storage_policy,default_residency_profile_id,source_class,license_policy_ref,default_retention_policy_id,head_rev,created_at) VALUES ('source-1','ns-1','owner-sys-1','gen-1','immutable_import','document',NULL,'T','policy-store-1','profile-1','public','license-1','retention-1',NULL,'${T}');
    INSERT INTO source_revision (source_revision_ref,source_id,source_owner_generation,content_sha256,object_residency_key_digest,original_r2_key,normalized_artifact_ref,captured_at,parser_profile_generation,quality_state,purge_state,currentness_state,source_view_ref,workspace_view_revision_ref,admitted_at) VALUES ('rev-1','source-1','gen-1','${HEX("a")}','${HEX("b")}',NULL,NULL,'${T}',NULL,'standard','LIVE','unknown','view-1',NULL,'${T}');
    INSERT INTO scope_snapshot (snapshot_id,revision,resolved_scope_expression_json,participant_generations_json,member_source_revision_refs_json,source_owner_generations_json,policy_authority_ref,disclosure_closure_digest,purge_ledger_revision,client_fence_ref,snapshot_digest,created_at,expires_at,invalidated_at,invalidation_reason) VALUES ('snap-1',1,'{}','{}','["rev-1"]','{}','policy-authority-1','${HEX("e")}',0,NULL,'${HEX("f")}','${T}','2027-09-06T00:00:00.000Z',NULL,NULL);
    INSERT INTO purge_ledger (erasure_id,non_revealing_subject_digest,disposition,receipt_ref,created_at) VALUES ('erasure-1','${HEX("4")}','COMPLETE','receipt-1','${T}');`);
}
async function setup() {
  const db = new DatabaseSync(":memory:");
  for (const m of [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010, m0011, m0012, m0013, m0018, m0019]) db.exec(m);
  for (const [i, n] of APPLIED.entries()) db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?1,?2)").run(n, `${T.slice(0, 10)}T00:00:${String(i).padStart(2, "0")}.000Z`);
  seedCore(db);
  const evidence = shimBucket(); const work = shimBucket(); const parts = shimBucket();
  const coreDb = d1Database(db);
  const ports: BackupSourcePorts = { core_db: coreDb, evidence_bucket: evidence.bucket, work_bucket: work.bucket, part_sink: testPartSink(parts.bucket), create_sha256_sink: sink };
  const port = createBackupPort(ports, { limits: { r2_list_page_size: 50, part_bytes: 512 } });
  await authorizeBackupDestination(coreDb, { destination_id: "offsite-1", principal_ref: "tester", policy_decision_ref: "policy-1", policy: policy(), authorization_receipt_ref: "auth-1" });
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return { db, coreDb, ports, port, key };
}
async function draftFor(h: Awaited<ReturnType<typeof setup>>, k: string): Promise<BackupEpochDraft> {
  return (await h.port.createPortableEpoch(intent(k), { now_ms: NOW })).draft;
}
function nonceRows(db: DatabaseSync, keyGen: string): { nonce_hex: string; copy_id: string; part_ref: string }[] {
  return db.prepare("SELECT nonce_hex, copy_id, part_ref FROM backup_offsite_nonce_authority WHERE key_generation = ? ORDER BY part_ref").all(keyGen) as { nonce_hex: string; copy_id: string; part_ref: string }[];
}

describe("ER-34 O2 FIX3 durable nonce authority", () => {
  it("same part/copy replay is exactly idempotent with no new puts or ciphertext", async () => {
    const h = await setup();
    const draft = await draftFor(h, "fix3-nonce-replay");
    const adapter = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    const first = await h.port.copyOffsite({ draft, intent: intent("fix3-nonce-replay"), encryption_key: h.key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter, now_ms: Date.now() });
    const putsAfterFirst = adapter.puts;
    const rowsAfterFirst = nonceRows(h.db, "key-gen-1").length;
    expect(rowsAfterFirst).toBe(draft.part_index.length);
    const replayed = await h.port.copyOffsite({ draft, intent: intent("fix3-nonce-replay"), encryption_key: h.key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter, now_ms: Date.now() });
    expect(replayed.receipt).toEqual(first.receipt);
    expect(replayed.epoch).toEqual(first.epoch);
    expect(adapter.puts).toBe(putsAfterFirst);
    expect(nonceRows(h.db, "key-gen-1").length).toBe(rowsAfterFirst);
  });
  it("different copy under one key with copy-blind nonces collides BEFORE encryption/put", async () => {
    const h = await setup();
    const draft = await draftFor(h, "fix3-nonce-xcopy");
    // Controller allocator emitting a fixed per-part sequence. The second copy
    // replays the same sequence under a different copy identity.
    const sequence = (): (() => Uint8Array) => {
      let n = 0;
      return () => {
        n += 1;
        const out = new Uint8Array(12).fill(0x40);
        out[11] = n % 256;
        out[10] = Math.floor(n / 256) % 256;
        return out;
      };
    };
    const a1 = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    const c1 = await h.port.copyOffsite({ draft, intent: intent("fix3-nonce-xcopy"), encryption_key: h.key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter: a1, now_ms: Date.now(), generate_nonce: sequence() });
    expect(c1.receipt.outcome).toBe("SUCCEEDED");
    const a2 = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    const putsBefore = a2.puts;
    // Same nonce sequence, different copy identity: the first part's nonce is
    // already claimed under this key generation, so allocation collides first.
    await expect(h.port.copyOffsite({ draft, intent: intent("fix3-nonce-xcopy-2"), encryption_key: h.key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter: a2, now_ms: Date.now(), generate_nonce: sequence() })).rejects.toMatchObject({ code: "BACKUP_NONCE_COLLISION" });
    expect(a2.puts).toBe(putsBefore);
  });
  it("different key generation succeeds with disjoint nonce scope", async () => {
    const h = await setup();
    const draft = await draftFor(h, "fix3-nonce-keygen");
    const a1 = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    await h.port.copyOffsite({ draft, intent: intent("fix3-nonce-keygen"), encryption_key: h.key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter: a1, now_ms: Date.now() });
    const a2 = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    const rotated = await h.port.copyOffsite({ draft, intent: intent("fix3-nonce-keygen-rot"), encryption_key: h.key, key_generation: "key-gen-2", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter: a2, now_ms: Date.now() });
    expect(rotated.receipt.outcome).toBe("SUCCEEDED");
    const gen1 = nonceRows(h.db, "key-gen-1");
    const gen2 = nonceRows(h.db, "key-gen-2");
    expect(gen1.length).toBe(draft.part_index.length);
    expect(gen2.length).toBe(draft.part_index.length);
    const hex1 = new Set(gen1.map((r) => r.nonce_hex));
    const hex2 = new Set(gen2.map((r) => r.nonce_hex));
    for (const n of hex2) expect(hex1.has(n)).toBe(false);
  });
  it("concurrent allocation is atomic: same owner idempotent, divergent owner collides", async () => {
    const h = await setup();
    const same = new Uint8Array(12).fill(0x11);
    const [r1, r2] = await Promise.all([
      allocateOffsiteNonce(h.coreDb, { key_generation: "key-gen-1", copy_id: "copy-conc", part_ref: "part-1", nonce: same, created_at: T }),
      allocateOffsiteNonce(h.coreDb, { key_generation: "key-gen-1", copy_id: "copy-conc", part_ref: "part-1", nonce: same, created_at: T }),
    ]);
    expect(backupNonceHex(r1)).toBe(backupNonceHex(r2));
    const clash = new Uint8Array(12).fill(0x22);
    const settled = await Promise.allSettled([
      allocateOffsiteNonce(h.coreDb, { key_generation: "key-gen-1", copy_id: "copy-conc", part_ref: "part-2", nonce: clash, created_at: T }),
      allocateOffsiteNonce(h.coreDb, { key_generation: "key-gen-1", copy_id: "copy-conc", part_ref: "part-3", nonce: clash, created_at: T }),
    ]);
    const fulfilled = settled.filter((s) => s.status === "fulfilled").length;
    const collisions = settled.filter((s) => s.status === "rejected" && (s.reason as { code?: string }).code === "BACKUP_NONCE_COLLISION").length;
    expect(fulfilled).toBe(1);
    expect(collisions).toBe(1);
  });
  it("forged pre-existing nonce fails closed with zero puts", async () => {
    const h = await setup();
    const forged = new Uint8Array(12).fill(0x5a);
    const forgedHex = backupNonceHex(forged);
    h.db.prepare("INSERT INTO backup_offsite_nonce_authority (key_generation, nonce_hex, copy_id, part_ref, created_at) VALUES (?1,?2,?3,?4,?5)")
      .run("key-gen-1", forgedHex, "copy-attacker", "part-evil", T);
    await expect(allocateOffsiteNonce(h.coreDb, { key_generation: "key-gen-1", copy_id: "copy-victim", part_ref: "part-victim-1", nonce: forged, created_at: T })).rejects.toMatchObject({ code: "BACKUP_NONCE_COLLISION" });
    // End to end: the forged bytes cannot encrypt or put under this key.
    const draft = await draftFor(h, "fix3-nonce-forge");
    const adapter = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    const putsBefore = adapter.puts;
    await expect(h.port.copyOffsite({ draft, intent: intent("fix3-nonce-forge-2"), encryption_key: h.key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter, now_ms: Date.now(), generate_nonce: () => forged.slice() })).rejects.toMatchObject({ code: "BACKUP_NONCE_COLLISION" });
    expect(adapter.puts).toBe(putsBefore);
  });
  it("restart through a fresh port resumes from durable state and replays exactly", async () => {
    const h = await setup();
    const draft = await draftFor(h, "fix3-nonce-restart");
    const adapter = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    const controller = new AbortController();
    let puts = 0;
    const crashing: OffsiteCopyAdapter = { ...adapter, put: async (r, b, s) => { const out = await adapter.put(r, b, s); puts += 1; if (puts >= 2) controller.abort(); return out; } };
    await expect(h.port.copyOffsite({ draft, intent: intent("fix3-nonce-restart"), encryption_key: h.key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter: crashing, signal: controller.signal, now_ms: Date.now() })).rejects.toMatchObject({ code: "BACKUP_CANCELLED" });
    // Restart: a brand-new port over the same D1 resumes and commits.
    const fresh = createBackupPort(h.ports, { limits: { r2_list_page_size: 50, part_bytes: 512 } });
    const resumed = await fresh.copyOffsite({ draft, intent: intent("fix3-nonce-restart"), encryption_key: h.key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter, now_ms: Date.now() });
    expect(resumed.receipt.outcome).toBe("SUCCEEDED");
    const putsAfterCommit = adapter.puts;
    const again = await fresh.copyOffsite({ draft, intent: intent("fix3-nonce-restart"), encryption_key: h.key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter, now_ms: Date.now() });
    expect(again.receipt).toEqual(resumed.receipt);
    expect(adapter.puts).toBe(putsAfterCommit);
  });
});
