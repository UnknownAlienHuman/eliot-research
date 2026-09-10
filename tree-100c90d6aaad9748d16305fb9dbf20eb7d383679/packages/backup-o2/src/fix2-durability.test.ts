/// <reference types="node" />
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { OperationIntent } from "@eliotr/contracts";
import { BackupError } from "./shared.js";
import { createBackupPort } from "./index.js";
import { createControlledOffsiteAdapter, type OffsiteCopyAdapter } from "./offsite.js";
import { authorizeBackupDestination } from "./destination-authority.js";
import { deriveBackupNonce } from "./offsite-durability.js";
import { destinationPolicyDigest } from "./destination-policy.js";
import type { BackupDestinationPolicy } from "./destination-policy.js";
import type { BackupEpochDraft, BackupSourcePorts } from "./epoch.js";
import { createConformantR2Bucket } from "./r2-conformance.js";
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

// ER-34 O2 FIX2 durability regressions: D1 copy checkpoints + success
// authority, crash/restart resume, stale ACK, cancellation, concurrent
// duplicate, key-generation change, nonce collision/tamper, exact replay, and
// R2-conformance faults through the production inventory path. D1 tests apply
// the actual tracked migrations plus 0018 + 0019 with ledger rows recorded.

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
function copyArgs(h: Awaited<ReturnType<typeof setup>>, k: string, draft: BackupEpochDraft, adapter: OffsiteCopyAdapter, extra: Record<string, unknown> = {}) {
  return { draft, intent: intent(k), encryption_key: h.key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", destination_policy: policy(), adapter, now_ms: Date.now(), ...extra };
}

describe("ER-34 O2 FIX2 durability (checkpoints, resume, nonces, replay, R2 faults)", () => {
  it("crash mid-copy resumes from durable checkpoints; cancellation leaves resumable state", async () => {
    const h = await setup();
    const draft = await draftFor(h, "id-crash");
    const adapter = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    const controller = new AbortController();
    let puts = 0;
    const crashing: OffsiteCopyAdapter = { ...adapter, put: async (r, b, s) => { const out = await adapter.put(r, b, s); puts += 1; if (puts >= 2) controller.abort(); return out; } };
    await expect(h.port.copyOffsite({ ...copyArgs(h, "id-crash", draft, crashing), signal: controller.signal })).rejects.toMatchObject({ code: "BACKUP_CANCELLED" });
    const checkpoints = h.db.prepare("SELECT count(*) AS n FROM backup_offsite_copy_part WHERE state = 'VERIFIED'").get() as { n: number };
    expect(checkpoints.n).toBe(2);
    const resumed = await h.port.copyOffsite(copyArgs(h, "id-crash", draft, adapter));
    expect(resumed.receipt.outcome).toBe("SUCCEEDED");
    expect(adapter.puts).toBe(draft.part_index.length);
    const replayed = await h.port.copyOffsite(copyArgs(h, "id-crash", draft, adapter));
    expect(replayed.receipt).toEqual(resumed.receipt);
    expect(replayed.epoch).toEqual(resumed.epoch);
    expect(replayed.attempt).toEqual(resumed.attempt);
    expect(adapter.puts).toBe(draft.part_index.length);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(h.port.copyOffsite({ ...copyArgs(h, "id-cancel", draft, adapter), signal: cancelled.signal })).rejects.toMatchObject({ code: "BACKUP_CANCELLED" });
  });
  it("reconciles a stale ACK and proves key-generation change plus nonce tamper/collision", async () => {
    const h = await setup();
    const draft = await draftFor(h, "id-ack");
    const flaky = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote", faults: { lose_ack_after_puts: 1 } });
    const first = await h.port.copyOffsite(copyArgs(h, "id-ack", draft, flaky));
    expect(first.receipt.outcome).toBe("SUCCEEDED");
    expect(first.receipt.reason_codes).toContain("OFFSITE_ACK_RECONCILED");
    const secondKey = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    const rotated = await h.port.copyOffsite({ ...copyArgs(h, "id-ack-rot", draft, secondKey), key_generation: "key-gen-2" });
    expect(rotated.receipt.outcome).toBe("SUCCEEDED");
    const ref = `offsite/${draft.epoch_id}/${draft.part_index[0]?.manifest}/${String(draft.part_index[0]?.index).padStart(6, "0")}-${draft.part_index[0]?.sha256}`;
    expect(await sha(flaky.peek(ref) as Uint8Array)).not.toBe(await sha(secondKey.peek(ref) as Uint8Array));
    // Simulate crash before success commit, then tamper the recorded nonce.
    h.db.exec("DELETE FROM backup_offsite_copy_receipt");
    const victim = h.db.prepare("SELECT part_ref FROM backup_offsite_copy_part LIMIT 1").get() as { part_ref: string };
    h.db.prepare("UPDATE backup_offsite_copy_part SET nonce_hex = ? WHERE part_ref = ?").run("ff".repeat(12), victim.part_ref);
    await expect(h.port.copyOffsite(copyArgs(h, "id-ack", draft, flaky))).rejects.toMatchObject({ code: "BACKUP_NONCE_COLLISION" });
  });
  it("collides when one nonce is forged onto two parts of the same copy", async () => {
    const h = await setup();
    const draft = await draftFor(h, "id-nonce2");
    const adapter = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    await h.port.copyOffsite(copyArgs(h, "id-nonce2", draft, adapter));
    // Crash before commit, drop one checkpoint, then forge its derived nonce
    // onto a second part ref: resume allocation must collide durably.
    h.db.exec("DELETE FROM backup_offsite_copy_receipt");
    const target = draft.part_index[1] as { manifest: string; index: number; sha256: string };
    const targetRef = `offsite/${draft.epoch_id}/${target.manifest}/${String(target.index).padStart(6, "0")}-${target.sha256}`;
    const copyRow = h.db.prepare("SELECT copy_id FROM backup_offsite_copy_part LIMIT 1").get() as { copy_id: string };
    const policyDigest = await destinationPolicyDigest(policy());
    const nonceHex = [...await deriveBackupNonce({ key_generation: "key-gen-1", copy_id: copyRow.copy_id, part_ref: targetRef, content_digest: target.sha256, policy_digest: policyDigest })].map((b) => b.toString(16).padStart(2, "0")).join("");
    h.db.prepare("DELETE FROM backup_offsite_copy_part WHERE part_ref = ?").run(targetRef);
    h.db.prepare("INSERT INTO backup_offsite_copy_part (copy_id, part_ref, content_digest, size_bytes, nonce_hex, state, updated_at) VALUES (?1, ?2, ?3, 1, ?4, 'STORED', ?5)").run(copyRow.copy_id, "forged-ref-x", target.sha256, nonceHex, T);
    await expect(h.port.copyOffsite(copyArgs(h, "id-nonce2", draft, adapter))).rejects.toMatchObject({ code: "BACKUP_NONCE_COLLISION" });
  });
  it("resolves concurrent duplicates to one persisted authority", async () => {
    const h = await setup();
    const draft = await draftFor(h, "id-dupe");
    // One shared destination store (two callers, one remote): checkpoints and
    // the success receipt converge; skips re-verify against the same store.
    const shared = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
    const [r1, r2] = await Promise.all([
      h.port.copyOffsite(copyArgs(h, "id-dupe", draft, shared)),
      h.port.copyOffsite(copyArgs(h, "id-dupe", draft, shared)),
    ]);
    expect(r1.receipt).toEqual(r2.receipt);
    expect(r1.epoch).toEqual(r2.epoch);
    expect(r1.attempt).toEqual(r2.attempt);
  });
  it("R2 faults fail closed through the production path without leaking keys; conformant happy path exports", async () => {
    const h = await setup();
    const attemptExport = async (configure: (c: ReturnType<typeof createConformantR2Bucket>) => void, key: string, pageSize: number): Promise<{ code: string; text: string }> => {
      const conf = createConformantR2Bucket();
      const bytes = new TextEncoder().encode("conformance object bytes");
      const digest = await sha(bytes);
      await conf.putObject("conf-key-1", bytes, { custom: { eliotr_sha256: digest }, http: { contentType: "application/octet-stream" } });
      configure(conf);
      const ports: BackupSourcePorts = { ...h.ports, evidence_bucket: conf.bucket };
      try {
        await createBackupPort(ports, { limits: { r2_list_page_size: pageSize, part_bytes: 512 } }).createPortableEpoch(intent(key), { now_ms: NOW });
      } catch (e) {
        const err = e as { code?: string; message?: string; detail?: Record<string, string> };
        return { code: String(err.code ?? "?"), text: `${err.message ?? ""} ${JSON.stringify(err.detail ?? {})}` };
      }
      throw new Error(`expected failure for ${key}`);
    };
    const noVersion = await (async () => {
      const conf = createConformantR2Bucket({ drop_version_on_get: new Set(["conf-key-1"]) });
      const bytes = new TextEncoder().encode("conformance object bytes");
      await conf.putObject("conf-key-1", bytes, { custom: {}, http: { contentType: "application/octet-stream" } });
      const ports: BackupSourcePorts = { ...h.ports, evidence_bucket: conf.bucket };
      try {
        await createBackupPort(ports, { limits: { r2_list_page_size: 50, part_bytes: 512 } }).createPortableEpoch(intent("id-r2-noversion"), { now_ms: NOW });
      } catch (e) {
        return { code: String((e as { code?: string }).code ?? "?"), text: "" };
      }
      throw new Error("expected version failure");
    })();
    expect(noVersion.code).toBe("BACKUP_OBJECT_UNREADABLE");
    const httpDrift = await (async () => {
      const conf = createConformantR2Bucket({ drift_http_metadata_on_get: new Set(["conf-key-1"]) });
      const bytes = new TextEncoder().encode("conformance object bytes");
      const digest = await sha(bytes);
      await conf.putObject("conf-key-1", bytes, { custom: { eliotr_sha256: digest }, http: { contentType: "application/octet-stream" } });
      const ports: BackupSourcePorts = { ...h.ports, evidence_bucket: conf.bucket };
      try {
        await createBackupPort(ports, { limits: { r2_list_page_size: 50, part_bytes: 512 } }).createPortableEpoch(intent("id-r2-httpdrift"), { now_ms: NOW });
      } catch (e) {
        const err = e as { code?: string };
        return { code: String(err.code ?? "?") };
      }
      throw new Error("expected http drift failure");
    })();
    expect(httpDrift.code).toBe("BACKUP_OBJECT_UNREADABLE");
    const etagRace = await attemptExport((c) => {
      c.mutateBetweenListAndGet("conf-key-1", (stored) => { stored.etag = "etag-forged"; });
    }, "id-r2-etagrace", 50);
    expect(etagRace.code).toBe("BACKUP_OBJECT_UNREADABLE");
    const dup = await (async () => {
      const conf = createConformantR2Bucket({ duplicate_first_key_on_next_page: true });
      const bytes = new TextEncoder().encode("conformance object bytes");
      const digest = await sha(bytes);
      await conf.putObject("conf-key-1", bytes, { custom: { eliotr_sha256: digest }, http: { contentType: "application/octet-stream" } });
      await conf.putObject("conf-key-2", bytes, { custom: { eliotr_sha256: digest }, http: { contentType: "application/octet-stream" } });
      const ports: BackupSourcePorts = { ...h.ports, evidence_bucket: conf.bucket };
      try {
        await createBackupPort(ports, { limits: { r2_list_page_size: 1, part_bytes: 512 } }).createPortableEpoch(intent("id-r2-dup"), { now_ms: NOW });
      } catch (e) {
        const err = e as { code?: string; message?: string; detail?: Record<string, string> };
        return { code: String(err.code ?? "?"), text: `${err.message ?? ""} ${JSON.stringify(err.detail ?? {})}` };
      }
      throw new Error("expected dup failure");
    })();
    expect(dup.code).toBe("BACKUP_OBJECT_UNREADABLE");
    expect(dup.text).not.toContain("conf-key-1");
    const stall = await (async () => {
      const conf = createConformantR2Bucket({ stall_cursor_once: true });
      const bytes = new TextEncoder().encode("conformance object bytes");
      const digest = await sha(bytes);
      await conf.putObject("conf-key-1", bytes, { custom: { eliotr_sha256: digest }, http: { contentType: "application/octet-stream" } });
      await conf.putObject("conf-key-2", bytes, { custom: { eliotr_sha256: digest }, http: { contentType: "application/octet-stream" } });
      await conf.putObject("conf-key-3", bytes, { custom: { eliotr_sha256: digest }, http: { contentType: "application/octet-stream" } });
      const ports: BackupSourcePorts = { ...h.ports, evidence_bucket: conf.bucket };
      try {
        await createBackupPort(ports, { limits: { r2_list_page_size: 1, part_bytes: 512 } }).createPortableEpoch(intent("id-r2-stall"), { now_ms: NOW });
      } catch (e) {
        return { code: String((e as { code?: string }).code ?? "?") };
      }
      throw new Error("expected stall failure");
    })();
    expect(stall.code).toBe("BACKUP_OBJECT_UNREADABLE");
    const happy = createConformantR2Bucket();
    const hbytes = new TextEncoder().encode("happy object bytes");
    const hdigest = await sha(hbytes);
    await happy.putObject("happy-1", hbytes, { custom: { eliotr_sha256: hdigest }, http: { contentType: "application/octet-stream" } });
    const happyPorts: BackupSourcePorts = { ...h.ports, evidence_bucket: happy.bucket };
    const ok = await createBackupPort(happyPorts, { limits: { r2_list_page_size: 50, part_bytes: 512 } }).createPortableEpoch(intent("id-r2-happy"), { now_ms: NOW });
    expect(ok.receipt.outcome).toBe("SUCCEEDED");
    expect(ok.draft.r2_object_count).toBe(1);
  });
  it("withholds the epoch when R2 re-puts identical bytes between phases (rollback invalidates)", async () => {
    const h = await setup();
    const conf = createConformantR2Bucket();
    const bytes = new TextEncoder().encode("rollback probe bytes");
    const digest = await sha(bytes);
    await conf.putObject("race-key-1", bytes, { custom: { eliotr_sha256: digest }, http: { contentType: "application/octet-stream" } });
    const stored = conf.objects.get("race-key-1") as { bytes: Uint8Array; customMetadata: Record<string, string>; httpMetadata: Record<string, string> };
    let calls = 0;
    const innerList = conf.bucket.list.bind(conf.bucket);
    const racing = {
      ...conf.bucket,
      list: async (options?: { prefix?: string; limit?: number; cursor?: string }) => {
        calls += 1;
        if (calls === 2) {
          // Mutation AND rollback before the phase-2 inventory read: identical
          // bytes re-put, which mints a fresh etag/version downstream.
          await conf.putObject("race-key-1", stored.bytes.slice(), { custom: { ...stored.customMetadata }, http: { ...stored.httpMetadata } });
        }
        return innerList(options);
      },
    } as unknown as R2Bucket;
    const ports: BackupSourcePorts = { ...h.ports, evidence_bucket: racing };
    await expect(createBackupPort(ports, { limits: { r2_list_page_size: 50, part_bytes: 512 } }).createPortableEpoch(intent("id-r2-rollback"), { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_VECTOR_DRIFT" });
    expect(calls).toBeGreaterThanOrEqual(2);
  });
  it("rejects a forged future clock while a 2030 destination stays admissible on the controller clock", async () => {
    const h = await setup();
    const draft = await draftFor(h, "id-clock");
    const future = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote", expires_at: "2030-01-01T00:00:00.000Z" });
    const ok = await h.port.copyOffsite(copyArgs(h, "id-clock", draft, future));
    expect(ok.receipt.outcome).toBe("SUCCEEDED");
    await expect(h.port.copyOffsite({ ...copyArgs(h, "id-clock-evil", draft, future), now_ms: Date.parse("2031-06-01T00:00:00.000Z") })).rejects.toMatchObject({ code: "BACKUP_INPUT_INVALID" });
    const expired = createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote", expires_at: "2020-01-01T00:00:00.000Z" });
    await expect(h.port.copyOffsite(copyArgs(h, "id-clock-old", draft, expired))).rejects.toMatchObject({ code: "BACKUP_OFFSITE_EXPIRED" });
    void BackupError;
  });
});
