/// <reference types="node" />
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { OperationIntent } from "@eliotr/contracts";
import { BackupError } from "./shared.js";
import { createBackupPort } from "./index.js";
import { createControlledOffsiteAdapter } from "./offsite.js";
import { authorizeBackupDestination, revokeBackupDestination } from "./destination-authority.js";
import type { BackupDestinationPolicy } from "./destination-policy.js";
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
import m0019 from "../../../infra/d1/core/migrations/0019_backup_o2_replay_authority_fix.sql?raw";

const T = "2026-09-06T00:00:00.000Z";
const HEX = (c: string): string => c.repeat(64);
const NOW = Date.parse(T);
const APPLIED = ["0001_initial.sql", "0002_execution_coordination.sql", "0003_delivery_inbox_payload_digest.sql", "0004_outbox_delivery_fence.sql", "0005_ingest_admission.sql", "0006_projection_execution.sql", "0007_evidence_resolution.sql", "0008_erasure_closure.sql", "0009_federation_authority.sql", "0010_navigation_artifacts.sql", "0011_owner_orientation.sql", "0012_google_credentials.sql", "0013_google_oauth_intents.sql", "0018_backup_o2_replay_authority.sql", "0019_backup_o2_replay_authority_fix.sql"];
async function sha(b: Uint8Array): Promise<string> {
  const c = new Uint8Array(b.byteLength); c.set(b);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", c.buffer))].map((v) => v.toString(16).padStart(2, "0")).join("");
}
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
interface ShimObject { bytes: Uint8Array; etag: string; version: string; customMetadata: Record<string, string>; contentType?: string | undefined }
function shimBucket(): { bucket: R2Bucket; objects: Map<string, ShimObject> } {
  const objects = new Map<string, ShimObject>(); let seq = 0;
  const streamOf = (b: Uint8Array): ReadableStream<Uint8Array> => new ReadableStream({ start(c) { c.enqueue(b.slice()); c.close(); } });
  const metaOf = (k: string, o: ShimObject): Record<string, unknown> => ({ key: k, size: o.bytes.byteLength, etag: o.etag, version: o.version, customMetadata: { ...o.customMetadata }, httpMetadata: { contentType: o.contentType } });
  const api = {
    async head(k: string) { const o = objects.get(k); return o === undefined ? null : metaOf(k, o); },
    async get(k: string) { const o = objects.get(k); if (o === undefined) return null; const f = o.bytes.slice(); return { ...metaOf(k, o), size: o.bytes.byteLength, body: streamOf(o.bytes), bytes: async () => f.slice(), arrayBuffer: async () => { const cp = new Uint8Array(f.byteLength); cp.set(f); return cp.buffer; } }; },
    async put(k: string, v: Uint8Array | ReadableStream<Uint8Array> | string, po?: Record<string, unknown>) {
      const bytes = typeof v === "string" ? new TextEncoder().encode(v) : v instanceof Uint8Array ? v : new Uint8Array(await new Response(v as ReadableStream<Uint8Array>).arrayBuffer());
      seq += 1; objects.set(k, { bytes: bytes.slice(), etag: `etag-${seq}`, version: `version-${seq}`, customMetadata: { ...((po?.["customMetadata"] as Record<string, string> | undefined) ?? {}) }, contentType: (po?.["httpMetadata"] as { contentType?: string } | undefined)?.contentType });
      return { key: k, etag: `etag-${seq}`, version: `version-${seq}` };
    },
    async delete(i: string | string[]) { for (const k of typeof i === "string" ? [i] : i) objects.delete(k); },
    async list(lo?: { prefix?: string; limit?: number; cursor?: string }) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(lo?.prefix ?? "")).sort();
      const s = lo?.cursor === undefined ? 0 : Number(lo.cursor);
      const page = keys.slice(s, s + (lo?.limit ?? 1000)); const n = s + (lo?.limit ?? 1000);
      return n < keys.length ? { objects: page.map((k) => metaOf(k, objects.get(k) as ShimObject)), truncated: true, cursor: String(n), delimitedPrefixes: [] } : { objects: page.map((k) => metaOf(k, objects.get(k) as ShimObject)), truncated: false, delimitedPrefixes: [] };
    },
  };
  return { bucket: api as unknown as R2Bucket, objects };
}
function testPartSink(bucket: R2Bucket): EvidenceObjectStore {
  return {
    async putImmutable(w) {
      const e = await bucket.get(w.key);
      if (e !== null) {
        const bytes = new Uint8Array(await new Response((e as R2ObjectBody).body as ReadableStream<Uint8Array>).arrayBuffer());
        const digest = await sha(bytes);
        if (digest !== w.expected_sha256 || bytes.byteLength !== w.expected_size_bytes) {
          throw new BackupError("BACKUP_PART_WRITE_FAILED", "immutable part conflict", false, {});
        }
        return { key: w.key, expected_sha256: w.expected_sha256, readback_sha256: digest, size_bytes: bytes.byteLength, etag: (e as unknown as { etag: string }).etag, existed_identically: true };
      }
      const bytes = new Uint8Array(await new Response(w.body as ReadableStream<Uint8Array>).arrayBuffer());
      await (bucket as unknown as { put(k: string, v: Uint8Array, o: unknown): Promise<{ etag: string }> }).put(w.key, bytes, { customMetadata: w.custom_metadata, httpMetadata: { contentType: w.content_type } });
      const head = await bucket.head(w.key) as unknown as { etag: string };
      return { key: w.key, expected_sha256: w.expected_sha256, readback_sha256: w.expected_sha256, size_bytes: bytes.byteLength, etag: head.etag, existed_identically: false };
    },
    async open(k) { return bucket.get(k); },
  };
}
function openCore(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const m of [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010, m0011, m0012, m0013, m0018, m0019]) db.exec(m);
  for (const [i, n] of APPLIED.entries()) db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?1,?2)").run(n, `${T.slice(0, 10)}T00:00:${String(i).padStart(2, "0")}.000Z`);
  return db;
}
function seedCore(db: DatabaseSync): void {
  db.exec(`INSERT INTO source_namespace_ownership (source_namespace_id,ownership_record_revision,owner_system_id,owner_incarnation_ref,source_owner_generation,source_admission_policy_revision,status,cutover_receipt_ref,created_at) VALUES ('ns-1',1,'owner-sys-1','incarnation-1','gen-1',1,'ACTIVE',NULL,'${T}');
    INSERT INTO source (source_id,source_namespace_id,source_owner_system_id,source_owner_generation,ownership_mode,kind,origin_uri,title,default_storage_policy,default_residency_profile_id,source_class,license_policy_ref,default_retention_policy_id,head_rev,created_at) VALUES ('source-1','ns-1','owner-sys-1','gen-1','immutable_import','document',NULL,'TITLE-7f3a','policy-store-1','profile-1','public','license-1','retention-1',NULL,'${T}');
    INSERT INTO source_revision (source_revision_ref,source_id,source_owner_generation,content_sha256,object_residency_key_digest,original_r2_key,normalized_artifact_ref,captured_at,parser_profile_generation,quality_state,purge_state,currentness_state,source_view_ref,workspace_view_revision_ref,admitted_at) VALUES ('rev-1','source-1','gen-1','${HEX("a")}','${HEX("b")}',NULL,NULL,'${T}',NULL,'standard','LIVE','unknown','view-1',NULL,'${T}');
    INSERT INTO scope_snapshot (snapshot_id,revision,resolved_scope_expression_json,participant_generations_json,member_source_revision_refs_json,source_owner_generations_json,policy_authority_ref,disclosure_closure_digest,purge_ledger_revision,client_fence_ref,snapshot_digest,created_at,expires_at,invalidated_at,invalidation_reason) VALUES ('snap-1',1,'{}','{}','["rev-1"]','{}','policy-authority-1','${HEX("e")}',0,NULL,'${HEX("f")}','${T}','2027-09-06T00:00:00.000Z',NULL,NULL);
    INSERT INTO purge_ledger (erasure_id,non_revealing_subject_digest,disposition,receipt_ref,created_at) VALUES ('erasure-1','${HEX("4")}','COMPLETE','receipt-1','${T}');`);
}
function intent(k: string): OperationIntent {
  return { intent_ref: { id: "intent-1", revision: 1 }, operation_kind: "BACKUP", principal_ref: "tester", idempotency_key: k, payload_ref: "payload-1", policy_decision_ref: "policy-1", created_at: T };
}
function policy(over: Partial<BackupDestinationPolicy> = {}): BackupDestinationPolicy {
  return { destination_id: "offsite-1", failure_domain: "domain-remote", endpoint_identity: "endpoint-1", supports_deletion_journal: true, supports_expiry: true, retention_locked: false, retention_policy_ref: "retention-1", expiry_identity: "expiry-1", policy_version: "v1", owner_ref: "owner-1", authorization_receipt_ref: "auth-1", ...over };
}
async function setup() {
  const db = openCore(); seedCore(db);
  const evidence = shimBucket(); const work = shimBucket(); const parts = shimBucket();
  const coreDb = d1Database(db);
  const ports: BackupSourcePorts = { core_db: coreDb, evidence_bucket: evidence.bucket, work_bucket: work.bucket, part_sink: testPartSink(parts.bucket), create_sha256_sink: sink };
  const port = createBackupPort(ports, { limits: { r2_list_page_size: 50, part_bytes: 512 } });
  // Controller plane: authorize the test destination for the test principal +
  // policy decision before any caller copy. Caller refs alone never authorize.
  await authorizeBackupDestination(coreDb, { destination_id: "offsite-1", principal_ref: "tester", policy_decision_ref: "policy-1", policy: policy(), authorization_receipt_ref: "auth-1" });
  return { db, coreDb, ports, port };
}
async function aesKey(len: number, usages: KeyUsage[] = ["encrypt", "decrypt"]): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: len }, false, usages);
}

describe("ER-34 O2 offsite copy (policy + hardened crypto)", () => {
  it("round-trips with controller authority; deterministic nonces converge across copies; exact replay returns persisted bytes", async () => {
    const h = await setup();
    const key = await aesKey(256);
    const draft = (await h.port.createPortableEpoch(intent("id-off-1"), { now_ms: NOW })).draft;
    const a1 = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    const c1 = await h.port.copyOffsite({ draft, intent: intent("id-off-1"), encryption_key: key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter: a1, now_ms: Date.now() });
    expect(c1.epoch.offsite_failure_domain).toBe("domain-remote");
    expect(c1.receipt.readback_receipt_refs).toContain("auth-1");
    const twin = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    const c2 = await h.port.copyOffsite({ draft, intent: intent("id-off-1-twin"), encryption_key: key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter: twin, now_ms: Date.now() });
    expect(c2.epoch).toEqual(c1.epoch);
    expect(c2.receipt).not.toEqual(c1.receipt);
    const ref = `offsite/${draft.epoch_id}/${draft.part_index[0]?.manifest}/${String(draft.part_index[0]?.index).padStart(6, "0")}-${draft.part_index[0]?.sha256}`;
    // Nonces derive per (key generation, copy/intent identity, part, content,
    // policy): distinct intents use distinct nonce material even for identical
    // plaintext under one key, while same-intent replay writes nothing new.
    expect(await sha(a1.peek(ref) as Uint8Array)).not.toBe(await sha(twin.peek(ref) as Uint8Array));
    const putsBefore = a1.puts;
    const replayed = await h.port.copyOffsite({ draft, intent: intent("id-off-1"), encryption_key: key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter: a1, now_ms: Date.now() });
    expect(replayed.receipt).toEqual(c1.receipt);
    expect(replayed.epoch).toEqual(c1.epoch);
    expect(a1.puts).toBe(putsBefore);
  });
  it("refuses copies with no controller authority and rejects adapter self-report", async () => {
    const h = await setup();
    const key = await aesKey(256);
    const draft = (await h.port.createPortableEpoch(intent("id-pol"), { now_ms: NOW })).draft;
    const base = { draft, intent: intent("id-pol"), encryption_key: key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", now_ms: Date.now() };
    // Caller-asserted owner/auth refs with no grant for that principal fail.
    await expect(h.port.copyOffsite({ ...base, intent: { ...intent("id-pol"), principal_ref: "stranger" }, destination_policy: policy(), adapter: createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }) })).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    await expect(h.port.copyOffsite({ ...base, intent: { ...intent("id-pol"), policy_decision_ref: "policy-evil" }, destination_policy: policy(), adapter: createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }) })).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    await expect(h.port.copyOffsite({ ...base, destination_policy: policy(), adapter: createControlledOffsiteAdapter({ destination_id: "offsite-evil", failure_domain: "domain-remote" }) })).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    await expect(h.port.copyOffsite({ ...base, destination_policy: policy(), adapter: createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-primary" }) })).rejects.toMatchObject({ code: expect.any(String) });
    await expect(h.port.copyOffsite({ ...base, destination_policy: policy({ retention_locked: true }), adapter: createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }) })).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
  });
  it("refuses a revoked authority and a caller-forged clock", async () => {
    const h = await setup();
    const key = await aesKey(256);
    const draft = (await h.port.createPortableEpoch(intent("id-rev"), { now_ms: NOW })).draft;
    await revokeBackupDestination(h.coreDb, "offsite-1", "tester", "policy-1");
    await expect(h.port.copyOffsite({ draft, intent: intent("id-rev"), encryption_key: key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter: createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }), now_ms: Date.now() })).rejects.toMatchObject({ code: "BACKUP_DESTINATION_POLICY_MISMATCH" });
    await authorizeBackupDestination(h.coreDb, { destination_id: "offsite-1", principal_ref: "tester", policy_decision_ref: "policy-1", policy: policy(), authorization_receipt_ref: "auth-1" });
    await expect(h.port.copyOffsite({ draft, intent: intent("id-rev"), encryption_key: key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter: createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }), now_ms: Date.parse("2019-01-01T00:00:00.000Z") })).rejects.toMatchObject({ code: "BACKUP_INPUT_INVALID" });
  });
  it("validates key strength/type and detects nonce reuse, tamper and wrong key", async () => {
    const h = await setup();
    const key = await aesKey(256);
    const draft = (await h.port.createPortableEpoch(intent("id-crypto"), { now_ms: NOW })).draft;
    const base = { draft, intent: intent("id-crypto"), key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), now_ms: Date.now() };
    await expect(h.port.copyOffsite({ ...base, encryption_key: await aesKey(128), adapter: createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }) })).rejects.toMatchObject({ code: "BACKUP_KEY_INVALID" });
    const fixed = new Uint8Array(12).fill(7);
    await expect(h.port.copyOffsite({ ...base, intent: intent("id-nonce"), encryption_key: key, adapter: createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }), generate_nonce: () => fixed.slice() })).rejects.toMatchObject({ code: "BACKUP_NONCE_COLLISION" });
    const corrupt = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote", faults: { corrupt_readback: "bytes" } });
    await expect(h.port.copyOffsite({ ...base, intent: intent("id-tamper"), encryption_key: key, adapter: corrupt })).rejects.toMatchObject({ code: "BACKUP_OFFSITE_READBACK_MISMATCH" });
    const good = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    await h.port.copyOffsite({ ...base, intent: intent("id-good"), encryption_key: key, adapter: good });
    const otherKey = await aesKey(256);
    const victim = { describe: () => good.describe(), put: (r: string, b: Uint8Array, s: never) => good.put(r, b, s), get: (r: string) => good.get(r), delete: (r: string, x: string) => good.delete(r, x) };
    const swappedDraft = draft;
    const wrongKeyInput = { draft: swappedDraft, intent: intent("id-wrong"), encryption_key: otherKey, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter: victim, now_ms: Date.now() };
    await expect(h.port.copyOffsite(wrongKeyInput)).rejects.toMatchObject({ code: "BACKUP_OFFSITE_READBACK_MISMATCH" });
    void BackupError;
  });
  it("keeps key material and source bytes out of epoch/receipts", async () => {
    const h = await setup();
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
    const rawHex = [...raw].map((v) => v.toString(16).padStart(2, "0")).join("");
    const draft = (await h.port.createPortableEpoch(intent("id-leak"), { now_ms: NOW })).draft;
    const copied = await h.port.copyOffsite({ draft, intent: intent("id-leak"), encryption_key: key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter: createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" }), now_ms: Date.now() });
    const s = JSON.stringify({ epoch: copied.epoch, receipt: copied.receipt });
    expect(s).not.toContain(rawHex);
    expect(s).not.toContain("TITLE-7f3a");
  });
});
