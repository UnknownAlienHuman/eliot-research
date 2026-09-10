/// <reference types="node" />
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { OperationIntent } from "@eliotr/contracts";
import { BackupError } from "./shared.js";
import { createBackupPort, createPendingRestorePort } from "./index.js";
import { reopenPersistedVector, type BackupSourcePorts } from "./epoch.js";
import type { EvidenceObjectStore, Sha256DigestSink } from "./shared.js";
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

// O2 epoch tests run against real SQLite executing tracked core migrations
// plus 0018, and byte-exact R2 shims through production readback paths.
const T = "2026-09-06T00:00:00.000Z";
const HEX = (c: string): string => c.repeat(64);
const NOW = Date.parse(T);

async function sha(bytes: Uint8Array): Promise<string> {
  const c = new Uint8Array(bytes.byteLength); c.set(bytes);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", c.buffer))].map((v) => v.toString(16).padStart(2, "0")).join("");
}
function sink(): Sha256DigestSink {
  const chunks: Uint8Array[] = [];
  let res!: (v: ArrayBuffer) => void; let rej!: (r: unknown) => void;
  const result = new Promise<ArrayBuffer>((a, b) => { res = a; rej = b; });
  return { writable: new WritableStream<Uint8Array>({ write(c) { chunks.push(c.slice()); }, async close() { try { const t = chunks.reduce((s, c) => s + c.byteLength, 0); const body = new Uint8Array(t); let o = 0; for (const c of chunks) { body.set(c, o); o += c.byteLength; } const cp = new Uint8Array(body.byteLength); cp.set(body); res(await crypto.subtle.digest("SHA-256", cp.buffer)); } catch (e) { rej(e); } }, abort(r) { rej(r); } }), digest: result };
}
function d1Database(db: DatabaseSync, wrapAll?: (sql: string, rows: Record<string, unknown>[]) => Record<string, unknown>[]): D1Database {
  return { prepare(sql: string) {
    const stmt = db.prepare(sql);
    const runBound = (params: (string | number | null)[]) => ({
      async all<T>(): Promise<D1Result<T>> { let rows = stmt.all(...params) as unknown as Record<string, unknown>[]; if (wrapAll !== undefined) rows = wrapAll(sql, rows); return { results: rows as unknown as T[], success: true, meta: {} } as unknown as D1Result<T>; },
      async first<T>(): Promise<T | null> { const r = stmt.get(...params) as unknown as T | undefined; return r ?? null; },
      async run<T>(): Promise<D1Result<T>> { stmt.run(...params); return { results: [], success: true, meta: {} } as unknown as D1Result<T>; },
    });
    return { bind(...p: unknown[]) { return runBound(p as (string | number | null)[]); }, ...runBound([]) };
  } } as unknown as D1Database;
}
interface ShimObject { bytes: Uint8Array; etag: string; version: string; customMetadata: Record<string, string>; contentType?: string | undefined }
interface ShimOptions { loseAckPrefix?: string; shortKeys?: Set<string>; vanishKeys?: Set<string>; onFirstList?: () => Promise<void>; dupKey?: string }
async function readShimValue(v: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob): Promise<Uint8Array> {
  if (typeof v === "string") return new TextEncoder().encode(v);
  if (v === null) return new Uint8Array();
  if (v instanceof ReadableStream) return new Uint8Array(await new Response(v as ReadableStream<Uint8Array>).arrayBuffer());
  if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  return new Uint8Array(await (v as Blob).arrayBuffer());
}
function shimBucket(options: ShimOptions = {}): { bucket: R2Bucket; objects: Map<string, ShimObject> } {
  const objects = new Map<string, ShimObject>();
  const lostAcks = new Set<string>();
  let seq = 0; let listed = false;
  const streamOf = (b: Uint8Array): ReadableStream<Uint8Array> => new ReadableStream({ start(c) { c.enqueue(b.slice()); c.close(); } });
  const metaOf = (k: string, o: ShimObject): Record<string, unknown> => ({ key: k, size: o.bytes.byteLength, etag: o.etag, version: o.version, customMetadata: { ...o.customMetadata }, httpMetadata: { contentType: o.contentType } });
  const api = {
    async head(k: string) { const o = objects.get(k); return o === undefined ? null : metaOf(k, o); },
    async get(k: string) {
      if (options.vanishKeys?.has(k) === true) return null;
      const o = objects.get(k); if (o === undefined) return null;
      const body = options.shortKeys?.has(k) === true ? o.bytes.slice(0, Math.floor(o.bytes.byteLength / 2)) : o.bytes;
      const frozen = body.slice();
      return { ...metaOf(k, o), size: o.bytes.byteLength, body: streamOf(body), bytes: async () => frozen.slice(), text: async () => new TextDecoder().decode(frozen), arrayBuffer: async () => { const cp = new Uint8Array(frozen.byteLength); cp.set(frozen); return cp.buffer; } };
    },
    async put(k: string, v: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob, po?: Record<string, unknown>) {
      if ((po?.["onlyIf"] as { etagDoesNotMatch?: string } | undefined)?.etagDoesNotMatch === "*" && objects.has(k)) return null;
      const bytes = await readShimValue(v);
      if (typeof po?.["sha256"] === "string" && await sha(bytes) !== po["sha256"]) throw new Error("checksum mismatch");
      seq += 1;
      objects.set(k, { bytes, etag: `etag-${seq}`, version: `version-${seq}`, customMetadata: { ...((po?.["customMetadata"] as Record<string, string> | undefined) ?? {}) }, contentType: (po?.["httpMetadata"] as { contentType?: string } | undefined)?.contentType });
      if (options.loseAckPrefix !== undefined && k.startsWith(options.loseAckPrefix) && !lostAcks.has(k)) { lostAcks.add(k); throw new Error("simulated lost acknowledgement after durable R2 write"); }
      return { key: k, size: bytes.byteLength, etag: `etag-${seq}`, version: `version-${seq}` };
    },
    async delete(input: string | string[]) { for (const k of typeof input === "string" ? [input] : input) objects.delete(k); },
    async list(lo?: { prefix?: string; limit?: number; cursor?: string }) {
      if (!listed) { listed = true; if (options.onFirstList !== undefined) await options.onFirstList(); }
      let keys = [...objects.keys()].filter((k) => k.startsWith(lo?.prefix ?? "")).sort();
      if (options.dupKey !== undefined && keys.length > 0) keys = [...keys, keys[0] as string];
      const start = lo?.cursor === undefined ? 0 : Number(lo.cursor);
      const page = keys.slice(start, start + (lo?.limit ?? 1000));
      const next = start + (lo?.limit ?? 1000);
      const objs = page.map((k) => metaOf(k, objects.get(k) as ShimObject));
      return next < keys.length ? { objects: objs, truncated: true, cursor: String(next), delimitedPrefixes: [] } : { objects: objs, truncated: false, delimitedPrefixes: [] };
    },
  };
  return { bucket: api as unknown as R2Bucket, objects };
}
function testPartSink(bucket: R2Bucket): EvidenceObjectStore {
  return {
    async putImmutable(w) {
      const existing = await bucket.get(w.key);
      if (existing !== null) {
        const bytes = new Uint8Array(await new Response((existing as R2ObjectBody).body as ReadableStream<Uint8Array>).arrayBuffer());
        const digest = await sha(bytes);
        if (digest !== w.expected_sha256 || bytes.byteLength !== w.expected_size_bytes) {
          const e = new BackupError("BACKUP_PART_WRITE_FAILED", "immutable part conflict", false, {});
          throw e;
        }
        return { key: w.key, expected_sha256: w.expected_sha256, readback_sha256: digest, size_bytes: bytes.byteLength, etag: (existing as unknown as { etag: string }).etag, existed_identically: true };
      }
      const bodyBytes = await new Response(w.body as ReadableStream<Uint8Array>).arrayBuffer().then((b) => new Uint8Array(b));
      await (bucket as unknown as { put(k: string, v: Uint8Array, o: unknown): Promise<{ etag: string }> }).put(w.key, bodyBytes, { customMetadata: w.custom_metadata, httpMetadata: { contentType: w.content_type } });
      const head = await bucket.head(w.key) as unknown as { etag: string };
      return { key: w.key, expected_sha256: w.expected_sha256, readback_sha256: w.expected_sha256, size_bytes: bodyBytes.byteLength, etag: head.etag, existed_identically: false };
    },
    async open(k) { return bucket.get(k); },
  };
}
function openCore(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const m of [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010, m0011, m0012, m0013, m0018]) db.exec(m);
  return db;
}
// Simulate the authoritative migration runner (wrangler): every applied file
// is recorded in d1_migrations. The O2 gate requires the 0018 row; nothing
// here swallows migration errors.
const APPLIED_MIGRATIONS = ["0001_initial", "0002_execution_coordination", "0003_delivery_inbox_payload_digest", "0004_outbox_delivery_fence", "0005_ingest_admission", "0006_projection_execution", "0007_evidence_resolution", "0008_erasure_closure", "0009_federation_authority", "0010_navigation_artifacts", "0011_owner_orientation", "0012_google_credentials", "0013_google_oauth_intents", "0018_backup_o2_replay_authority"];
function recordLedger(db: DatabaseSync): void {
  for (const [i, n] of APPLIED_MIGRATIONS.entries()) {
    db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?1,?2)").run(`${n}.sql`, `${T.slice(0, 10)}T00:00:${String(i).padStart(2, "0")}.000Z`);
  }
}
function seedCore(db: DatabaseSync, withLedger: boolean): void {
  db.exec(`INSERT INTO source_namespace_ownership (source_namespace_id,ownership_record_revision,owner_system_id,owner_incarnation_ref,source_owner_generation,source_admission_policy_revision,status,cutover_receipt_ref,created_at) VALUES ('ns-1',1,'owner-sys-1','incarnation-1','gen-1',1,'ACTIVE',NULL,'${T}');
    INSERT INTO source (source_id,source_namespace_id,source_owner_system_id,source_owner_generation,ownership_mode,kind,origin_uri,title,default_storage_policy,default_residency_profile_id,source_class,license_policy_ref,default_retention_policy_id,head_rev,created_at) VALUES ('source-1','ns-1','owner-sys-1','gen-1','immutable_import','document',NULL,'MARKER-TITLE-7f3a','policy-store-1','profile-1','public','license-1','retention-1',NULL,'${T}');
    INSERT INTO source_revision (source_revision_ref,source_id,source_owner_generation,content_sha256,object_residency_key_digest,original_r2_key,normalized_artifact_ref,captured_at,parser_profile_generation,quality_state,purge_state,currentness_state,source_view_ref,workspace_view_revision_ref,admitted_at) VALUES ('rev-1','source-1','gen-1','${HEX("a")}','${HEX("b")}',NULL,NULL,'${T}',NULL,'standard','LIVE','unknown','view-1',NULL,'${T}');
    INSERT INTO project (project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref,default_model_profile_ref,default_depth_profile_ref,generation,created_at) VALUES ('proj-1','Project One','owner-only','retention-1','source-policy-1','model-1','depth-1',1,'${T}');
    INSERT INTO project_source_membership (project_id,source_id,role,valid_from,valid_to,membership_generation) VALUES ('proj-1','source-1','owner','${T}',NULL,1);
    INSERT INTO scope_snapshot (snapshot_id,revision,resolved_scope_expression_json,participant_generations_json,member_source_revision_refs_json,source_owner_generations_json,policy_authority_ref,disclosure_closure_digest,purge_ledger_revision,client_fence_ref,snapshot_digest,created_at,expires_at,invalidated_at,invalidation_reason) VALUES ('snap-1',1,'{}','{}','["rev-1"]','{}','policy-authority-1','${HEX("e")}',1,NULL,'${HEX("f")}','${T}','2027-09-06T00:00:00.000Z',NULL,NULL);
    INSERT INTO evidence_handle (handle_id,revision,source_namespace_id,source_owner_generation,source_revision_ref,scope_snapshot_id,scope_snapshot_revision,anchor_json,excerpt_sha256,excerpt_byte_length,coordinate_map_ref,loss_map_ref,object_residency_key_digest,source_assurance_ceiling,materializer_assurance_ceiling,terminal_state,invalidation_ref,created_at,expires_at) VALUES ('h-1',1,'ns-1','gen-1','rev-1','snap-1',1,'{}','${HEX("1")}',16,NULL,NULL,'${HEX("b")}','source-local','source-local','LIVE',NULL,'${T}',NULL);
    INSERT INTO investigation (investigation_id,revision,goal,intended_artifact,scope_snapshot_id,scope_snapshot_revision,inquiry_protocol_id,inquiry_protocol_revision,evidence_grade,execution_product,model_profile_ref,budget_ref,stop_rule_ref,current_stage,terminal_disposition,event_head,parent_investigation_id,parent_investigation_revision,manifest_r2_key,created_at) VALUES ('inv-1',1,'goal','artifact','snap-1',1,'protocol-1',1,'E1','research','model-1','budget-1','stop-1','PLAN',NULL,0,NULL,NULL,'r2-manifest-1','${T}');
    INSERT INTO artifact_revision (artifact_id,revision,kind,spec_digest,evidence_freeze_id,evidence_freeze_revision,manifest_r2_key,dependency_manifest_ref,status,created_at) VALUES ('art-1',1,'report','${HEX("3")}','freeze-1',1,'r2-artifact-1','dep-1','PUBLISHED','${T}');
    INSERT INTO artifact_head VALUES ('art-1',1,'r2-artifact-1','${T}');
    INSERT INTO wiki_revision (page_id,revision,page_type,title,scope_snapshot_id,scope_snapshot_revision,body_r2_key,manifest_r2_key,coverage_receipt_id,coverage_receipt_revision,status,supersedes_revision,generator_generation,reviewer_ref,created_at) VALUES ('page-1',1,'report','Page One','snap-1',1,'r2-body-1','r2-wiki-1','coverage-1',1,'PUBLISHED',NULL,'gen-wiki-1',NULL,'${T}');
    INSERT INTO wiki_head VALUES ('page-1',1,'r2-wiki-1','${T}');
    INSERT INTO model_generation (generation_id,capability_class,route_fingerprint_json,pricing_snapshot_ref,golden_set_result_ref,status,created_at,activated_at,retired_at) VALUES ('mg-1','reasoning','{}','pricing-1',NULL,'ACTIVE','${T}',NULL,NULL);
    INSERT INTO purge_ledger (erasure_id,non_revealing_subject_digest,disposition,receipt_ref,created_at) VALUES ('erasure-1','${HEX("4")}','COMPLETE','receipt-1','${T}');
    INSERT INTO erasure_hold (hold_ref,exact_subject_ref,location,canonical_ref,policy_or_hold_ref,next_review_at,state,created_at,released_at) VALUES ('hold-1','source-1',NULL,NULL,'retention-policy-1','2027-01-01T00:00:00.000Z','ACTIVE','${T}',NULL);`);
  if (withLedger) {
    recordLedger(db);
  }
}
async function seedR2(evidence: R2Bucket, work: R2Bucket): Promise<{ total: number }> {
  let total = 0;
  const files: { b: R2Bucket; bytes: Uint8Array }[] = [
    { b: evidence, bytes: new TextEncoder().encode("evidence bytes one") },
    { b: evidence, bytes: new TextEncoder().encode("evidence bytes two") },
    { b: work, bytes: new TextEncoder().encode("work bytes one") },
  ];
  for (const f of files) {
    const d = await sha(f.bytes);
    total += f.bytes.byteLength;
    await (f.b as unknown as { put(k: string, v: Uint8Array, o: unknown): Promise<unknown> }).put(`seed-${d.slice(0, 8)}`, f.bytes, { customMetadata: { eliotr_sha256: d }, httpMetadata: { contentType: "application/octet-stream" } });
  }
  return { total };
}
function backupIntent(k: string, id = "intent-1"): OperationIntent {
  return { intent_ref: { id, revision: 1 }, operation_kind: "BACKUP", principal_ref: "tester", idempotency_key: k, payload_ref: "payload-1", policy_decision_ref: "policy-1", created_at: T };
}
interface Harness { db: DatabaseSync; port: ReturnType<typeof createBackupPort>; ports: BackupSourcePorts; evidence: { bucket: R2Bucket; objects: Map<string, ShimObject> }; work: { bucket: R2Bucket; objects: Map<string, ShimObject> }; parts: { bucket: R2Bucket; objects: Map<string, ShimObject> } }
async function setup(shims: { evidence?: ShimOptions; work?: ShimOptions; parts?: ShimOptions } = {}, wrapAll?: (sql: string, rows: Record<string, unknown>[]) => Record<string, unknown>[], seedLedger = true, seedRows = true): Promise<Harness> {
  const db = openCore();
  if (seedRows) seedCore(db, seedLedger);
  const evidence = shimBucket(shims.evidence ?? {});
  const work = shimBucket(shims.work ?? {});
  const parts = shimBucket(shims.parts ?? {});
  const ports: BackupSourcePorts = { core_db: d1Database(db, wrapAll), evidence_bucket: evidence.bucket, work_bucket: work.bucket, part_sink: testPartSink(parts.bucket), create_sha256_sink: sink };
  if (seedRows) await seedR2(evidence.bucket, work.bucket);
  return { db, port: createBackupPort(ports, { limits: { r2_list_page_size: 50, part_bytes: 512 } }), ports, evidence, work, parts };
}

describe("ER-34 O2 epoch (restart-safe authority)", () => {
  it("creates a coherent epoch with persisted vector bound into receipts", async () => {
    const h = await setup();
    const r = await h.port.createPortableEpoch(backupIntent("id-1"), { now_ms: NOW });
    expect(r.draft.vector_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(r.draft.vector_manifest_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(r.draft.manifest_digests["vector"]).toBe(r.draft.vector_manifest_digest);
    expect(r.draft.audit_sample_receipt_ref).toContain(r.draft.vector_digest.slice(0, 16));
    expect(r.receipt.outcome).toBe("SUCCEEDED");
    expect(r.draft.manifest_protocol).toBe("eliotr.backup-manifest.v1");
    expect(r.draft.cut_id).toMatch(/^cut-[a-f0-9]{32}$/);
    expect(r.draft.manifest_digests["schema-inventory"]).toMatch(/^[a-f0-9]{64}$/);
    const reopened = await reopenPersistedVector(h.ports, r.draft);
    expect(reopened.purge_frontier).toBe(1);
  });
  it("replays exact intent from a new port/process to the same persisted bytes; divergent bytes conflict", async () => {
    const h = await setup();
    const first = await h.port.createPortableEpoch(backupIntent("id-replay"), { now_ms: NOW });
    const fresh = createBackupPort(h.ports, { limits: { r2_list_page_size: 50, part_bytes: 512 } });
    const second = await fresh.createPortableEpoch(backupIntent("id-replay"), { now_ms: NOW + 60_000 });
    expect(second.draft.epoch_id).toBe(first.draft.epoch_id);
    expect(second.receipt).toEqual(first.receipt);
    expect(second.attempt).toEqual(first.attempt);
    expect(JSON.stringify(second.draft)).toBe(JSON.stringify(first.draft));
    await expect(fresh.createPortableEpoch({ ...backupIntent("id-replay"), principal_ref: "attacker" }, { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_INTENT_CONFLICT" });
    await expect(fresh.createPortableEpoch({ ...backupIntent("id-replay"), payload_ref: "payload-evil" }, { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_INTENT_CONFLICT" });
    await expect(fresh.createPortableEpoch({ ...backupIntent("id-replay"), policy_decision_ref: "policy-evil" }, { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_INTENT_CONFLICT" });
    await expect(fresh.createPortableEpoch({ ...backupIntent("id-replay"), created_at: "2027-01-01T00:00:00.000Z" }, { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_INTENT_CONFLICT" });
    h.db.exec(`INSERT INTO source (source_id,source_namespace_id,source_owner_system_id,source_owner_generation,ownership_mode,kind,origin_uri,title,default_storage_policy,default_residency_profile_id,source_class,license_policy_ref,default_retention_policy_id,head_rev,created_at) VALUES ('source-2','ns-1','owner-sys-1','gen-1','immutable_import','document',NULL,'Other','policy-store-1','profile-1','public','license-1','retention-1',NULL,'${T}')`);
    await expect(fresh.createPortableEpoch(backupIntent("id-replay"), { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_INTENT_CONFLICT" });
    await expect(h.port.createPortableEpoch(backupIntent("id-replay"), { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_INTENT_CONFLICT" });
  });
  it("withholds epoch as stale on D1 and R2 drift", async () => {
    const h = await setup();
    let mutated = false;
    const evidence = shimBucket({ onFirstList: async () => { if (!mutated) { mutated = true; h.db.exec(`INSERT INTO purge_ledger (erasure_id,non_revealing_subject_digest,disposition,receipt_ref,created_at) VALUES ('erasure-2','${HEX("5")}','BLOCKED','receipt-2','${T}')`); } } });
    await seedR2(evidence.bucket, h.work.bucket);
    const port = createBackupPort({ ...h.ports, evidence_bucket: evidence.bucket }, { limits: { r2_list_page_size: 50, part_bytes: 512 } });
    await expect(port.createPortableEpoch(backupIntent("id-drift"), { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_VECTOR_DRIFT" });
  });
  it("fails closed on R2 list/get metadata races and pagination duplication", async () => {
    const h = await setup();
    const firstKey = [...h.evidence.objects.keys()].sort()[0] as string;
    const before = h.evidence.objects.get(firstKey) as ShimObject;
    (h.evidence.objects.get(firstKey) as ShimObject).bytes = new TextEncoder().encode("forged bytes with identical length!!".slice(0, before.bytes.byteLength));
    await expect(h.port.createPortableEpoch(backupIntent("id-tamper"), { now_ms: NOW })).rejects.toMatchObject({ code: expect.any(String) });
    const dup = await setup({ evidence: { dupKey: "x" } });
    await expect(dup.port.createPortableEpoch(backupIntent("id-dup"), { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_OBJECT_UNREADABLE" });
  });
  it("fails closed on unclassified durable tables and keeps O3/O4 not implemented", async () => {
    const h = await setup();
    h.db.exec("CREATE TABLE o2_unclassified_mystery (id TEXT PRIMARY KEY)");
    await expect(h.port.createPortableEpoch(backupIntent("id-gap"), { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_COVERAGE_GAP" });
    const restore = createPendingRestorePort();
    await expect(restore.restoreIsolated({} as never)).rejects.toMatchObject({ code: "BACKUP_RESTORE_NOT_IMPLEMENTED" });
    await expect(h.port.markEpochForPurgeReplay("epoch-1", 1)).rejects.toMatchObject({ code: "BACKUP_PURGE_REPLAY_NOT_IMPLEMENTED" });
  });
});
