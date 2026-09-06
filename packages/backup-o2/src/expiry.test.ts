/// <reference types="node" />
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { OperationIntent } from "@eliotr/contracts";
import { createBackupPort } from "./index.js";
import { createControlledOffsiteAdapter, type OffsiteCopyAdapter, type OffsiteStoredPart } from "./offsite.js";
import { expireOffsiteCopy } from "./expiry.js";
import { authorizeBackupDestination } from "./destination-authority.js";
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
async function copyFixture(h: Awaited<ReturnType<typeof setup>>, key: string, adapter: OffsiteCopyAdapter): Promise<BackupEpochDraft> {
  const draft = (await h.port.createPortableEpoch(intent(key), { now_ms: NOW })).draft;
  const enc = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await h.port.copyOffsite({ draft, intent: intent(key), encryption_key: enc, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter, now_ms: Date.now() });
  return draft;
}

describe("ER-34 O2 expiry lifecycle (not O4)", () => {
  it("deletes with journal, proves absence, replays persisted bytes and refuses resurrection", async () => {
    const h = await setup();
    const adapter = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    const draft = await copyFixture(h, "id-exp", adapter);
    const receipt = await expireOffsiteCopy({ core_db: h.ports.core_db, draft, intent: intent("id-exp"), expiry: { expiry_intent_key: "expiry-1", epoch_id: draft.epoch_id, reason: "retention-expired" }, destination_policy: policy(), adapter, now_ms: Date.now() });
    expect(receipt.state).toBe("DELETED");
    expect(receipt.journal_refs.length).toBe(draft.part_index.length);
    for (const part of draft.part_index) {
      const ref = `offsite/${draft.epoch_id}/${part.manifest}/${String(part.index).padStart(6, "0")}-${part.sha256}`;
      expect(await adapter.get(ref)).toBeNull();
    }
    const replayed = await expireOffsiteCopy({ core_db: h.ports.core_db, draft, intent: intent("id-exp"), expiry: { expiry_intent_key: "expiry-1", epoch_id: draft.epoch_id, reason: "retention-expired" }, destination_policy: policy(), adapter, now_ms: Date.now() });
    expect(replayed).toEqual(receipt);
    const firstRef = `offsite/${draft.epoch_id}/${draft.part_index[0]?.manifest}/${String(draft.part_index[0]?.index).padStart(6, "0")}-${draft.part_index[0]?.sha256}`;
    await expect(adapter.put(firstRef, new Uint8Array([9, 9, 9]), { content_digest: HEX("9"), size_bytes: 3, key_generation: "key-gen-1", epoch_id: draft.epoch_id, expires_at: draft.expires_at })).rejects.toMatchObject({ code: "BACKUP_RESURRECTION_REFUSED" });
  });
  it("re-proves absence on terminal replay: a re-put part refuses resurrection instead of staying DELETED", async () => {
    const h = await setup();
    const adapter = plainAdapter();
    const draft = await copyFixture(h, "id-exp-reput", adapter);
    const receipt = await expireOffsiteCopy({ core_db: h.ports.core_db, draft, intent: intent("id-exp-reput"), expiry: { expiry_intent_key: "expiry-reput", epoch_id: draft.epoch_id, reason: "retention-expired" }, destination_policy: policy(), adapter, now_ms: Date.now() });
    expect(receipt.state).toBe("DELETED");
    const ref = `offsite/${draft.epoch_id}/${draft.part_index[0]?.manifest}/${String(draft.part_index[0]?.index).padStart(6, "0")}-${draft.part_index[0]?.sha256}`;
    await adapter.put(ref, new Uint8Array([1, 2, 3]), { content_digest: HEX("9"), size_bytes: 3, key_generation: "key-gen-1", epoch_id: draft.epoch_id, expires_at: draft.expires_at });
    await expect(expireOffsiteCopy({ core_db: h.ports.core_db, draft, intent: intent("id-exp-reput"), expiry: { expiry_intent_key: "expiry-reput", epoch_id: draft.epoch_id, reason: "retention-expired" }, destination_policy: policy(), adapter, now_ms: Date.now() })).rejects.toMatchObject({ code: "BACKUP_RESURRECTION_REFUSED" });
  });
  it("blocks expiry under legal hold, retention lock, or a controller backup-path hold, and stays auditable", async () => {
    const h = await setup();
    const draft = (await h.port.createPortableEpoch(intent("id-hold"), { now_ms: NOW })).draft;
    const enc = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const adapter = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    await h.port.copyOffsite({ draft, intent: intent("id-hold"), encryption_key: enc, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter, now_ms: Date.now() });
    const locked = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote", retention_locked: true });
    await expect(expireOffsiteCopy({ core_db: h.ports.core_db, draft, intent: intent("id-hold"), expiry: { expiry_intent_key: "expiry-hold", epoch_id: draft.epoch_id, reason: "retention-expired" }, destination_policy: policy(), adapter: locked, now_ms: Date.now() })).rejects.toMatchObject({ code: "BACKUP_EXPIRY_BLOCKED" });
    h.db.exec(`INSERT INTO erasure_hold (hold_ref,exact_subject_ref,location,canonical_ref,policy_or_hold_ref,next_review_at,state,created_at,released_at) VALUES ('hold-path',NULL,'BackupRestorePath',NULL,'retention-policy-1','2027-01-01T00:00:00.000Z','ACTIVE','${T}',NULL)`);
    const plain = plainAdapter();
    await expect(expireOffsiteCopy({ core_db: h.ports.core_db, draft, intent: intent("id-hold"), expiry: { expiry_intent_key: "expiry-hold-2", epoch_id: draft.epoch_id, reason: "retention-expired" }, destination_policy: policy(), adapter: plain, now_ms: Date.now() })).rejects.toMatchObject({ code: "BACKUP_EXPIRY_BLOCKED" });
  });
});
