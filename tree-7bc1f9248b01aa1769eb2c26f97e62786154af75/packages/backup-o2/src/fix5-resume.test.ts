/// <reference types="node" />
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { OperationIntent } from "@eliotr/contracts";
import { createBackupPort } from "./index.js";
import { createControlledOffsiteAdapter, type OffsiteCopyAdapter, type OffsiteStoredPart } from "./offsite.js";
import { authorizeBackupDestination } from "./destination-authority.js";
import { destinationPolicyDigest, type BackupDestinationPolicy } from "./destination-policy.js";
import { canonicalOffsiteCopyDigest } from "./intent-digest.js";
import { copyIdForDigest } from "./offsite-durability.js";
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

// ER-34 O2 FIX5 durable-nonce resume authority (IMPLEMENTED_NOT_LIVE).
// Every VERIFIED checkpoint resume must re-prove the durable nonce authority
// (backup_offsite_nonce_authority binds checkpoint nonce_hex to this exact
// (key_generation, copy_id, part_ref) owner) BEFORE remote get/skip. Forged or
// restored checkpoints with a generate_nonce mismatch, a missing authority
// row, a divergent owner, or malformed bytes fail closed with zero puts and
// zero authority writes; a legitimate authority-bound resume still reconciles
// idempotently even when the controller allocator disagrees.

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
type Harness = Awaited<ReturnType<typeof setup>>;
async function setup() {
  const db = new DatabaseSync(":memory:");
  for (const m of [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010, m0011, m0012, m0013, m0018, m0019]) db.exec(m);
  for (const [i, n] of APPLIED.entries()) db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?1,?2)").run(n, `${T.slice(0, 10)}T00:00:${String(i).padStart(2, "0")}.000Z`);
  db.exec(`INSERT INTO source_namespace_ownership (source_namespace_id,ownership_record_revision,owner_system_id,owner_incarnation_ref,source_owner_generation,source_admission_policy_revision,status,cutover_receipt_ref,created_at) VALUES ('ns-1',1,'owner-sys-1','incarnation-1','gen-1',1,'ACTIVE',NULL,'${T}');
    INSERT INTO source (source_id,source_namespace_id,source_owner_system_id,source_owner_generation,ownership_mode,kind,origin_uri,title,default_storage_policy,default_residency_profile_id,source_class,license_policy_ref,default_retention_policy_id,head_rev,created_at) VALUES ('source-1','ns-1','owner-sys-1','gen-1','immutable_import','document',NULL,'T','policy-store-1','profile-1','public','license-1','retention-1',NULL,'${T}');
    INSERT INTO source_revision (source_revision_ref,source_id,source_owner_generation,content_sha256,object_residency_key_digest,original_r2_key,normalized_artifact_ref,captured_at,parser_profile_generation,quality_state,purge_state,currentness_state,source_view_ref,workspace_view_revision_ref,admitted_at) VALUES ('rev-1','source-1','gen-1','${HEX("a")}','${HEX("b")}',NULL,NULL,'${T}',NULL,'standard','LIVE','unknown','view-1',NULL,'${T}');
    INSERT INTO scope_snapshot (snapshot_id,revision,resolved_scope_expression_json,participant_generations_json,member_source_revision_refs_json,source_owner_generations_json,policy_authority_ref,disclosure_closure_digest,purge_ledger_revision,client_fence_ref,snapshot_digest,created_at,expires_at,invalidated_at,invalidation_reason) VALUES ('snap-1',1,'{}','{}','["rev-1"]','{}','policy-authority-1','${HEX("e")}',0,NULL,'${HEX("f")}','${T}','2027-09-06T00:00:00.000Z',NULL,NULL);
    INSERT INTO purge_ledger (erasure_id,non_revealing_subject_digest,disposition,receipt_ref,created_at) VALUES ('erasure-1','${HEX("4")}','COMPLETE','receipt-1','${T}');`);
  const evidence = shimBucket(); const work = shimBucket(); const parts = shimBucket();
  const coreDb = d1Database(db);
  const ports: BackupSourcePorts = { core_db: coreDb, evidence_bucket: evidence.bucket, work_bucket: work.bucket, part_sink: testPartSink(parts.bucket), create_sha256_sink: sink };
  const port = createBackupPort(ports, { limits: { r2_list_page_size: 50, part_bytes: 512 } });
  await authorizeBackupDestination(coreDb, { destination_id: "offsite-1", principal_ref: "tester", policy_decision_ref: "policy-1", policy: policy(), authorization_receipt_ref: "auth-1" });
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return { db, coreDb, ports, port, key };
}
function partRefFor(draft: BackupEpochDraft, index: number): { part_ref: string; content_digest: string; size_bytes: number } {
  const part = draft.part_index[index] as BackupEpochDraft["part_index"][number];
  return { part_ref: `offsite/${draft.epoch_id}/${part.manifest}/${String(part.index).padStart(6, "0")}-${part.sha256}`, content_digest: part.sha256, size_bytes: part.size_bytes };
}
async function copyIdFor(h: Harness, draft: BackupEpochDraft, op: OperationIntent, generation: string): Promise<string> {
  const policyDigest = await destinationPolicyDigest(policy());
  const intentDigest = await canonicalOffsiteCopyDigest(op, {
    epoch_id: draft.epoch_id, destination_id: "offsite-1", policy_digest: policyDigest,
    authorization_receipt_ref: "auth-1", key_generation: generation,
    expires_at: draft.expires_at, retention_policy_ref: "retention-1", expiry_identity: "expiry-1",
  });
  return copyIdForDigest({ epoch_id: draft.epoch_id, destination_id: "offsite-1", key_generation: generation, policy_digest: policyDigest, intent_digest: intentDigest });
}
// Remote-present stub: every part reads back with matching metadata and
// arbitrary bytes (the vulnerable skip path never decrypts).
function remotePresentAdapter(draft: BackupEpochDraft, generation: string): OffsiteCopyAdapter & { puts: number } {
  let puts = 0;
  const base = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
  return {
    ...base,
    get puts() { return puts; },
    async put(part_ref, ciphertext, stored) { puts += 1; return base.put(part_ref, ciphertext, stored); },
    async get(part_ref) {
      const hit = draft.part_index.find((p) => `offsite/${draft.epoch_id}/${p.manifest}/${String(p.index).padStart(6, "0")}-${p.sha256}` === part_ref);
      if (hit === undefined) return null;
      const stored: Omit<OffsiteStoredPart, "ciphertext"> = { content_digest: hit.sha256, size_bytes: hit.size_bytes, key_generation: generation, epoch_id: draft.epoch_id, expires_at: draft.expires_at };
      return { ciphertext: new Uint8Array(64), stored };
    },
  };
}
function nonceCount(h: Harness): number {
  return (h.db.prepare("SELECT count(*) AS n FROM backup_offsite_nonce_authority").get() as { n: number }).n;
}
function forgedHex(fill: number, salt: number): string {
  return Array.from({ length: 12 }, (_, j) => ((fill + salt + j) & 0xff).toString(16).padStart(2, "0")).join("");
}
function forgeCheckpoints(h: Harness, copyId: string, draft: BackupEpochDraft, nonceHexForPart: (index: number) => string): void {
  for (let i = 0; i < draft.part_index.length; i += 1) {
    const { part_ref, content_digest, size_bytes } = partRefFor(draft, i);
    h.db.prepare("INSERT INTO backup_offsite_copy_part (copy_id, part_ref, content_digest, size_bytes, nonce_hex, state, updated_at) VALUES (?1,?2,?3,?4,?5,'VERIFIED',?6)")
      .run(copyId, part_ref, content_digest, size_bytes, nonceHexForPart(i), T);
  }
}

describe("ER-34 O2 FIX5 VERIFIED resume re-proves durable nonce authority", () => {
  it("forged VERIFIED checkpoints with a generate_nonce mismatch fail closed with zero puts and zero authority rows", async () => {
    const h = await setup();
    const draft = (await h.port.createPortableEpoch(intent("fix5-forge"), { now_ms: NOW })).draft;
    const op = intent("fix5-forge-copy");
    const copyId = await copyIdFor(h, draft, op, "key-gen-1");
    forgeCheckpoints(h, copyId, draft, (i) => forgedHex(0xa0, i));
    const adapter = remotePresentAdapter(draft, "key-gen-1");
    await expect(h.port.copyOffsite({
      draft, intent: op, encryption_key: h.key, key_generation: "key-gen-1",
      primary_failure_domain: "domain-primary", destination_policy: policy(),
      adapter, now_ms: Date.now(), generate_nonce: () => new Uint8Array(12).fill(0x99),
    })).rejects.toMatchObject({ code: "BACKUP_NONCE_COLLISION" });
    expect(adapter.puts).toBe(0);
    expect(nonceCount(h)).toBe(0);
  });
  it("VERIFIED checkpoints with no durable authority row fail closed even when the nonce matches derivation", async () => {
    const h = await setup();
    const draft = (await h.port.createPortableEpoch(intent("fix5-missing"), { now_ms: NOW })).draft;
    // Legitimate copy first so checkpoints carry derivation-correct nonces.
    const first = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    await h.port.copyOffsite({
      draft, intent: intent("fix5-missing-copy"), encryption_key: h.key, key_generation: "key-gen-1",
      primary_failure_domain: "domain-primary", destination_policy: policy(), adapter: first, now_ms: Date.now(),
    });
    // Destroy the authority rows and the success receipt, keep checkpoints and
    // remote bytes: resume must refuse to skip on checkpoints alone.
    h.db.exec("DELETE FROM backup_offsite_nonce_authority");
    h.db.exec("DELETE FROM backup_offsite_copy_receipt");
    expect(nonceCount(h)).toBe(0);
    await expect(h.port.copyOffsite({
      draft, intent: intent("fix5-missing-copy"), encryption_key: h.key, key_generation: "key-gen-1",
      primary_failure_domain: "domain-primary", destination_policy: policy(), adapter: first, now_ms: Date.now(),
    })).rejects.toMatchObject({ code: "BACKUP_NONCE_COLLISION" });
    expect(first.puts).toBeGreaterThan(0); // the first legitimate copy wrote; the resume wrote nothing new
  });
  it("a checkpoint nonce bound to a divergent owner fails closed with zero new puts", async () => {
    const h = await setup();
    const draft = (await h.port.createPortableEpoch(intent("fix5-owner"), { now_ms: NOW })).draft;
    const op = intent("fix5-owner-copy");
    const copyId = await copyIdFor(h, draft, op, "key-gen-1");
    const stolen = new Uint8Array(12).fill(0x5e);
    const stolenHex = [...stolen].map((b) => b.toString(16).padStart(2, "0")).join("");
    h.db.prepare("INSERT INTO backup_offsite_nonce_authority (key_generation, nonce_hex, copy_id, part_ref, created_at) VALUES (?1,?2,?3,?4,?5)")
      .run("key-gen-1", stolenHex, "copy-attacker", "part-evil", T);
    forgeCheckpoints(h, copyId, draft, (i) => (i === 0 ? stolenHex : forgedHex(0xb0, i)));
    const adapter = remotePresentAdapter(draft, "key-gen-1");
    await expect(h.port.copyOffsite({
      draft, intent: op, encryption_key: h.key, key_generation: "key-gen-1",
      primary_failure_domain: "domain-primary", destination_policy: policy(),
      adapter, now_ms: Date.now(), generate_nonce: () => new Uint8Array(12).fill(0x5e),
    })).rejects.toMatchObject({ code: "BACKUP_NONCE_COLLISION" });
    expect(adapter.puts).toBe(0);
  });
  it("malformed checkpoint nonce bytes fail closed before any remote reliance", async () => {
    const h = await setup();
    const draft = (await h.port.createPortableEpoch(intent("fix5-malformed"), { now_ms: NOW })).draft;
    const op = intent("fix5-malformed-copy");
    const copyId = await copyIdFor(h, draft, op, "key-gen-1");
    forgeCheckpoints(h, copyId, draft, (i) => `z${"y".repeat(21)}${String(i).padStart(2, "0")}`.slice(0, 24));
    const adapter = remotePresentAdapter(draft, "key-gen-1");
    await expect(h.port.copyOffsite({
      draft, intent: op, encryption_key: h.key, key_generation: "key-gen-1",
      primary_failure_domain: "domain-primary", destination_policy: policy(),
      adapter, now_ms: Date.now(), generate_nonce: () => new Uint8Array(12).fill(0x01),
    })).rejects.toMatchObject({ code: "BACKUP_NONCE_COLLISION" });
    expect(adapter.puts).toBe(0);
    expect(nonceCount(h)).toBe(0);
  });
  it("authority checks run before remote verification: forged checkpoints with an absent remote still collide, never readback-mismatch", async () => {
    const h = await setup();
    const draft = (await h.port.createPortableEpoch(intent("fix5-order"), { now_ms: NOW })).draft;
    const op = intent("fix5-order-copy");
    const copyId = await copyIdFor(h, draft, op, "key-gen-1");
    forgeCheckpoints(h, copyId, draft, (i) => forgedHex(0xc0, i));
    const adapter = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    await expect(h.port.copyOffsite({
      draft, intent: op, encryption_key: h.key, key_generation: "key-gen-1",
      primary_failure_domain: "domain-primary", destination_policy: policy(),
      adapter, now_ms: Date.now(), generate_nonce: () => new Uint8Array(12).fill(0x02),
    })).rejects.toMatchObject({ code: "BACKUP_NONCE_COLLISION" });
    expect(adapter.puts).toBe(0);
  });
  it("a legitimate authority-bound resume still reconciles idempotently when the allocator disagrees", async () => {
    const h = await setup();
    const draft = (await h.port.createPortableEpoch(intent("fix5-legit"), { now_ms: NOW })).draft;
    const adapter = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    const controller = new AbortController();
    let puts = 0;
    const crashing: OffsiteCopyAdapter = { ...adapter, put: async (r, b, s) => { const out = await adapter.put(r, b, s); puts += 1; if (puts >= 2) controller.abort(); return out; } };
    await expect(h.port.copyOffsite({
      draft, intent: intent("fix5-legit"), encryption_key: h.key, key_generation: "key-gen-1",
      primary_failure_domain: "domain-primary", destination_policy: policy(),
      adapter: crashing, signal: controller.signal, now_ms: Date.now(),
    })).rejects.toMatchObject({ code: "BACKUP_CANCELLED" });
    const rowsBefore = nonceCount(h);
    expect(rowsBefore).toBeGreaterThan(0);
    let allocations = 0;
    const resumed = await h.port.copyOffsite({
      draft, intent: intent("fix5-legit"), encryption_key: h.key, key_generation: "key-gen-1",
      primary_failure_domain: "domain-primary", destination_policy: policy(),
      adapter, now_ms: Date.now(),
      generate_nonce: () => {
        allocations += 1;
        const out = new Uint8Array(12).fill(0x77);
        out[11] = (0x80 + allocations) & 0xff;
        out[10] = 0x77;
        return out;
      },
    });
    expect(resumed.receipt.outcome).toBe("SUCCEEDED");
    expect(nonceCount(h)).toBe(draft.part_index.length);
  });
});
