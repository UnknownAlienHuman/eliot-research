/// <reference types="node" />
/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { BackupEpochSchema, type ObjectResidencyKey, type OperationIntent } from "@eliotr/contracts";
import { createR2EvidenceObjectStore, type Sha256DigestSink } from "./r2.js";
import {
  BackupError,
  createBackupPort,
  createControlledOffsiteAdapter,
  createPendingRestorePort,
  type BackupSourcePorts,
  type OffsiteCopyAdapter,
} from "./backup.js";
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
// ER-34 O2 tests run against actual local Cloudflare-compatible storage: a real
// SQLite engine (node:sqlite, the same engine family as D1/workerd) executing the
// tracked core migrations, plus byte-exact R2Bucket shims exercised through the
// production immutable-write/readback paths with real WebCrypto digests and AES-GCM.
// No canned D1 rows or map-only DDL fakes.
const T = "2026-09-06T00:00:00.000Z";
const HEX = (char: string): string => char.repeat(64);
const NOW = Date.parse(T);
async function sha(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}
function sink(): Sha256DigestSink {
  const chunks: Uint8Array[] = [];
  let resolveDigest!: (value: ArrayBuffer) => void;
  let rejectDigest!: (reason: unknown) => void;
  const result = new Promise<ArrayBuffer>((resolve, reject) => { resolveDigest = resolve; rejectDigest = reject; });
  return {
    writable: new WritableStream<Uint8Array>({
      write(chunk) { chunks.push(chunk.slice()); },
      async close() {
        try {
          const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
          const body = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
          const copy = new Uint8Array(body.byteLength);
          copy.set(body);
          resolveDigest(await crypto.subtle.digest("SHA-256", copy.buffer));
        } catch (error) { rejectDigest(error); }
      },
      abort(reason) { rejectDigest(reason); },
    }),
    digest: result,
  };
}
function d1Database(db: DatabaseSync, wrapAll?: (sql: string, rows: Record<string, unknown>[]) => Record<string, unknown>[]): D1Database {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      const runBound = (params: (string | number | null)[]) => ({
        async all<T>(): Promise<D1Result<T>> {
          let rows = stmt.all(...params) as unknown as Record<string, unknown>[];
          if (wrapAll !== undefined) rows = wrapAll(sql, rows);
          return { results: rows as unknown as T[], success: true, meta: {} } as unknown as D1Result<T>;
        },
        async first<T>(): Promise<T | null> {
          const row = stmt.get(...params) as unknown as T | undefined;
          return row ?? null;
        },
        async run<T>(): Promise<D1Result<T>> {
          stmt.run(...params);
          return { results: [], success: true, meta: {} } as unknown as D1Result<T>;
        },
      });
      return { bind(...params: unknown[]) { return runBound(params as (string | number | null)[]); }, ...runBound([]) };
    },
  } as unknown as D1Database;
}
interface ShimObject { bytes: Uint8Array; etag: string; version: string; customMetadata: Record<string, string>; contentType?: string | undefined }
interface ShimOptions { loseAckPrefix?: string; shortKeys?: Set<string>; vanishKeys?: Set<string>; onFirstList?: () => Promise<void> }
async function readShimValue(value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value === null) return new Uint8Array();
  if (value instanceof ReadableStream) return new Uint8Array(await new Response(value as ReadableStream<Uint8Array>).arrayBuffer());
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  return new Uint8Array(await (value as Blob).arrayBuffer());
}
function shimBucket(options: ShimOptions = {}): { bucket: R2Bucket; objects: Map<string, ShimObject> } {
  const objects = new Map<string, ShimObject>();
  const lostAcks = new Set<string>();
  let seq = 0;
  let listed = false;
  const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> => new ReadableStream({ start(controller) { controller.enqueue(bytes.slice()); controller.close(); } });
  const metaOf = (key: string, object: ShimObject): Record<string, unknown> => ({ key, size: object.bytes.byteLength, etag: object.etag, version: object.version, customMetadata: { ...object.customMetadata }, httpMetadata: { contentType: object.contentType } });
  const api = {
    async head(key: string) {
      const object = objects.get(key);
      return object === undefined ? null : metaOf(key, object);
    },
    async get(key: string) {
      if (options.vanishKeys?.has(key) === true) return null;
      const object = objects.get(key);
      if (object === undefined) return null;
      const body = options.shortKeys?.has(key) === true ? object.bytes.slice(0, Math.floor(object.bytes.byteLength / 2)) : object.bytes;
      const frozen = body.slice();
      return {
        ...metaOf(key, object), size: object.bytes.byteLength, body: streamOf(body),
        bytes: async () => frozen.slice(), text: async () => new TextDecoder().decode(frozen),
        arrayBuffer: async () => { const copy = new Uint8Array(frozen.byteLength); copy.set(frozen); return copy.buffer; },
      };
    },
    async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob, putOptions?: Record<string, unknown>) {
      if ((putOptions?.["onlyIf"] as { etagDoesNotMatch?: string } | undefined)?.etagDoesNotMatch === "*" && objects.has(key)) return null;
      const bytes = await readShimValue(value);
      if (typeof putOptions?.["sha256"] === "string" && await sha(bytes) !== putOptions["sha256"]) throw new Error("checksum mismatch");
      seq += 1;
      objects.set(key, { bytes, etag: `etag-${seq}`, version: `version-${seq}`, customMetadata: { ...((putOptions?.["customMetadata"] as Record<string, string> | undefined) ?? {}) }, contentType: (putOptions?.["httpMetadata"] as { contentType?: string } | undefined)?.contentType });
      if (options.loseAckPrefix !== undefined && key.startsWith(options.loseAckPrefix) && !lostAcks.has(key)) {
        lostAcks.add(key);
        throw new Error("simulated lost acknowledgement after durable R2 write");
      }
      return { key, size: bytes.byteLength, etag: `etag-${seq}`, version: `version-${seq}` };
    },
    async delete(input: string | string[]) {
      for (const key of typeof input === "string" ? [input] : input) objects.delete(key);
    },
    async list(listOptions?: { prefix?: string; limit?: number; cursor?: string }) {
      if (!listed) {
        listed = true;
        if (options.onFirstList !== undefined) await options.onFirstList();
      }
      const keys = [...objects.keys()].filter((key) => key.startsWith(listOptions?.prefix ?? "")).sort();
      const start = listOptions?.cursor === undefined ? 0 : Number(listOptions.cursor);
      const page = keys.slice(start, start + (listOptions?.limit ?? 1000));
      const next = start + (listOptions?.limit ?? 1000);
      const listedObjects = page.map((key) => metaOf(key, objects.get(key) as ShimObject));
      return next < keys.length
        ? { objects: listedObjects, truncated: true, cursor: String(next), delimitedPrefixes: [] }
        : { objects: listedObjects, truncated: false, delimitedPrefixes: [] };
    },
  };
  return { bucket: api as unknown as R2Bucket, objects };
}
function openCore(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const migration of [m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008, m0009, m0010, m0011, m0012, m0013]) db.exec(migration);
  return db;
}
function seedCore(db: DatabaseSync, withLedger: boolean): void {
  db.exec(`INSERT INTO source_namespace_ownership (source_namespace_id,ownership_record_revision,owner_system_id,owner_incarnation_ref,source_owner_generation,source_admission_policy_revision,status,cutover_receipt_ref,created_at) VALUES ('ns-1',1,'owner-sys-1','incarnation-1','gen-1',1,'ACTIVE',NULL,'${T}');
    INSERT INTO source (source_id,source_namespace_id,source_owner_system_id,source_owner_generation,ownership_mode,kind,origin_uri,title,default_storage_policy,default_residency_profile_id,source_class,license_policy_ref,default_retention_policy_id,head_rev,created_at) VALUES ('source-1','ns-1','owner-sys-1','gen-1','immutable_import','document',NULL,'MARKER-TITLE-7f3a','policy-store-1','profile-1','public','license-1','retention-1',NULL,'${T}');
    INSERT INTO source_revision (source_revision_ref,source_id,source_owner_generation,content_sha256,object_residency_key_digest,original_r2_key,normalized_artifact_ref,captured_at,parser_profile_generation,quality_state,purge_state,currentness_state,source_view_ref,workspace_view_revision_ref,admitted_at) VALUES ('rev-1','source-1','gen-1','${HEX("a")}','${HEX("b")}',NULL,NULL,'${T}',NULL,'standard','LIVE','unknown','view-1',NULL,'${T}');
    INSERT INTO source_revision (source_revision_ref,source_id,source_owner_generation,content_sha256,object_residency_key_digest,original_r2_key,normalized_artifact_ref,captured_at,parser_profile_generation,quality_state,purge_state,currentness_state,source_view_ref,workspace_view_revision_ref,admitted_at) VALUES ('rev-2','source-1','gen-1','${HEX("c")}','${HEX("d")}',NULL,NULL,'${T}',NULL,'standard','REDACTED','unknown','view-1',NULL,'${T}');
    INSERT INTO project (project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref,default_model_profile_ref,default_depth_profile_ref,generation,created_at) VALUES ('proj-1','Project One','owner-only','retention-1','source-policy-1','model-1','depth-1',1,'${T}');
    INSERT INTO project_source_membership (project_id,source_id,role,valid_from,valid_to,membership_generation) VALUES ('proj-1','source-1','owner','${T}',NULL,1);
    INSERT INTO source_tag (source_id,tag,valid_from,valid_to) VALUES ('source-1','lens','${T}',NULL);
    INSERT INTO scope_snapshot (snapshot_id,revision,resolved_scope_expression_json,participant_generations_json,member_source_revision_refs_json,source_owner_generations_json,policy_authority_ref,disclosure_closure_digest,purge_ledger_revision,client_fence_ref,snapshot_digest,created_at,expires_at,invalidated_at,invalidation_reason) VALUES ('snap-1',1,'{}','{}','["rev-1"]','{}','policy-authority-1','${HEX("e")}',1,NULL,'${HEX("f")}','${T}','2027-09-06T00:00:00.000Z',NULL,NULL);
    INSERT INTO evidence_handle (handle_id,revision,source_namespace_id,source_owner_generation,source_revision_ref,scope_snapshot_id,scope_snapshot_revision,anchor_json,excerpt_sha256,excerpt_byte_length,coordinate_map_ref,loss_map_ref,object_residency_key_digest,source_assurance_ceiling,materializer_assurance_ceiling,terminal_state,invalidation_ref,created_at,expires_at) VALUES ('h-1',1,'ns-1','gen-1','rev-1','snap-1',1,'{}','${HEX("1")}',16,NULL,NULL,'${HEX("b")}','source-local','source-local','LIVE',NULL,'${T}',NULL);
    INSERT INTO evidence_handle (handle_id,revision,source_namespace_id,source_owner_generation,source_revision_ref,scope_snapshot_id,scope_snapshot_revision,anchor_json,excerpt_sha256,excerpt_byte_length,coordinate_map_ref,loss_map_ref,object_residency_key_digest,source_assurance_ceiling,materializer_assurance_ceiling,terminal_state,invalidation_ref,created_at,expires_at) VALUES ('h-2',1,'ns-1','gen-1','rev-2','snap-1',1,'{}','${HEX("2")}',16,NULL,NULL,'${HEX("d")}','source-local','source-local','REDACTED','inv-1','${T}',NULL);
    INSERT INTO evidence_handle_invalidation (invalidation_ref,handle_id,handle_revision,terminal_state,reason_code,observed_at) VALUES ('inv-1','h-2',1,'REDACTED','PURGE_APPLIED','${T}');
    INSERT INTO investigation (investigation_id,revision,goal,intended_artifact,scope_snapshot_id,scope_snapshot_revision,inquiry_protocol_id,inquiry_protocol_revision,evidence_grade,execution_product,model_profile_ref,budget_ref,stop_rule_ref,current_stage,terminal_disposition,event_head,parent_investigation_id,parent_investigation_revision,manifest_r2_key,created_at) VALUES ('inv-1',1,'goal','artifact','snap-1',1,'protocol-1',1,'E1','research','model-1','budget-1','stop-1','PLAN',NULL,0,NULL,NULL,'r2-manifest-1','${T}');
    INSERT INTO investigation (investigation_id,revision,goal,intended_artifact,scope_snapshot_id,scope_snapshot_revision,inquiry_protocol_id,inquiry_protocol_revision,evidence_grade,execution_product,model_profile_ref,budget_ref,stop_rule_ref,current_stage,terminal_disposition,event_head,parent_investigation_id,parent_investigation_revision,manifest_r2_key,created_at) VALUES ('inv-1',2,'goal','artifact','snap-1',1,'protocol-1',1,'E1','research','model-1','budget-1','stop-1','PLAN',NULL,0,NULL,NULL,'r2-manifest-2','${T}');
    INSERT INTO artifact_revision (artifact_id,revision,kind,spec_digest,evidence_freeze_id,evidence_freeze_revision,manifest_r2_key,dependency_manifest_ref,status,created_at) VALUES ('art-1',1,'report','${HEX("3")}','freeze-1',1,'r2-artifact-1','dep-1','PUBLISHED','${T}');
    INSERT INTO artifact_head VALUES ('art-1',1,'r2-artifact-1','${T}');
    INSERT INTO wiki_revision (page_id,revision,page_type,title,scope_snapshot_id,scope_snapshot_revision,body_r2_key,manifest_r2_key,coverage_receipt_id,coverage_receipt_revision,status,supersedes_revision,generator_generation,reviewer_ref,created_at) VALUES ('page-1',1,'report','Page One','snap-1',1,'r2-body-1','r2-wiki-1','coverage-1',1,'PUBLISHED',NULL,'gen-wiki-1',NULL,'${T}');
    INSERT INTO wiki_head VALUES ('page-1',1,'r2-wiki-1','${T}');
    INSERT INTO model_generation (generation_id,capability_class,route_fingerprint_json,pricing_snapshot_ref,golden_set_result_ref,status,created_at,activated_at,retired_at) VALUES ('mg-1','reasoning','{}','pricing-1',NULL,'ACTIVE','${T}',NULL,NULL);
    INSERT INTO operation_intent (intent_id,revision,operation_kind,principal_ref,idempotency_key,payload_ref,policy_decision_ref,budget_reservation_ref,cancellation_ref,created_at) VALUES ('intent-seed',1,'PROJECTION','tester','seed-1','payload-1','policy-1',NULL,NULL,'${T}');
    INSERT INTO job (job_id,intent_id,intent_revision,state,current_stage,progress_cursor,workflow_instance_id,terminal_receipt_ref,created_at,updated_at) VALUES ('job-1','intent-seed',1,'ACCEPTED',NULL,NULL,NULL,NULL,'${T}','${T}');
    INSERT INTO projection_generation (source_revision_ref,projection_generation,job_id,source_owner_generation,content_sha256,object_residency_key_digest,projector_profile,state,item_count,item_set_digest,work_manifest_ref,work_manifest_sha256,d1_search_receipt_ref,d1_search_readback_digest,semantic_instance_id,semantic_generation,semantic_receipt_ref,semantic_readback_digest,reason_codes_json,created_at,updated_at) VALUES ('rev-1','pg-1','job-1','gen-1','${HEX("a")}','${HEX("b")}','projector-1','MATERIALIZED',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'[]','${T}','${T}');
    INSERT INTO purge_ledger (erasure_id,non_revealing_subject_digest,disposition,receipt_ref,created_at) VALUES ('erasure-1','${HEX("4")}','COMPLETE','receipt-1','${T}');
    INSERT INTO erasure_hold (hold_ref,exact_subject_ref,location,canonical_ref,policy_or_hold_ref,next_review_at,state,created_at,released_at) VALUES ('hold-1','source-1',NULL,NULL,'retention-policy-1','2027-01-01T00:00:00.000Z','ACTIVE','${T}',NULL);`);
  if (withLedger) {
    db.exec("CREATE TABLE d1_migrations (name TEXT PRIMARY KEY, applied_at TEXT)");
    for (const [index, name] of ["0001_initial", "0002_execution", "0005_ingest", "0006_projection", "0007_evidence", "0008_erasure", "0011_orientation"].entries()) {
      db.prepare("INSERT INTO d1_migrations VALUES (?1,?2)").run(`${name}.sql`, `${T.slice(0, 10)}T00:00:0${index}.000Z`);
    }
  }
}
function residencyFor(digest: string): ObjectResidencyKey {
  return { scope_domain_id: "scope-a", access_domain_id: "access-a", confidentiality_domain_id: "private", encryption_key_domain_id: "key-a", retention_domain_id: "retention-a", erasure_domain_id: "erase-a", content_digest: { algorithm: "sha256", digest } };
}
async function seedR2(evidence: R2Bucket, work: R2Bucket): Promise<{ digests: string[]; total: number }> {
  const evidenceStore = createR2EvidenceObjectStore(evidence, { createSha256Sink: sink });
  const workStore = createR2EvidenceObjectStore(work, { createSha256Sink: sink });
  const files: { store: typeof evidenceStore; prefix: string; bytes: Uint8Array }[] = [
    { store: evidenceStore, prefix: "original", bytes: new TextEncoder().encode("evidence bytes one") },
    { store: evidenceStore, prefix: "original", bytes: new TextEncoder().encode("evidence bytes two") },
    { store: evidenceStore, prefix: "original", bytes: new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x80]) },
    { store: workStore, prefix: "work", bytes: new TextEncoder().encode("work bytes one") },
    { store: workStore, prefix: "work", bytes: new TextEncoder().encode("work bytes two") },
  ];
  const digests: string[] = [];
  let total = 0;
  for (const file of files) {
    const digest = await sha(file.bytes);
    digests.push(digest);
    total += file.bytes.byteLength;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(file.bytes.slice()); controller.close(); } });
    await file.store.putResidencyObject({ residency_key: residencyFor(digest), prefix: file.prefix, body: stream, expected_sha256: digest, expected_size_bytes: file.bytes.byteLength, content_type: "application/octet-stream", custom_metadata: {} });
  }
  return { digests, total };
}
function backupIntent(idempotencyKey: string, id = "intent-1"): OperationIntent {
  return { intent_ref: { id, revision: 1 }, operation_kind: "BACKUP", principal_ref: "tester", idempotency_key: idempotencyKey, payload_ref: "payload-1", policy_decision_ref: "policy-1", created_at: T };
}
interface Harness { db: DatabaseSync; port: ReturnType<typeof createBackupPort>; ports: BackupSourcePorts; evidence: { bucket: R2Bucket; objects: Map<string, ShimObject> }; work: { bucket: R2Bucket; objects: Map<string, ShimObject> }; parts: { bucket: R2Bucket; objects: Map<string, ShimObject> }; r2seed: { digests: string[]; total: number } }
async function setup(shims: { evidence?: ShimOptions; work?: ShimOptions; parts?: ShimOptions } = {}, wrapAll?: (sql: string, rows: Record<string, unknown>[]) => Record<string, unknown>[], seedLedger = true, seedRows = true): Promise<Harness> {
  const db = openCore();
  if (seedRows) seedCore(db, seedLedger);
  else if (seedLedger) {
    db.exec("CREATE TABLE d1_migrations (name TEXT PRIMARY KEY, applied_at TEXT)");
    db.prepare("INSERT INTO d1_migrations VALUES (?1,?2)").run("0001_initial.sql", T);
  }
  const evidence = shimBucket(shims.evidence ?? {});
  const work = shimBucket(shims.work ?? {});
  const parts = shimBucket(shims.parts ?? {});
  const partSink = createR2EvidenceObjectStore(parts.bucket, { createSha256Sink: sink });
  const ports: BackupSourcePorts = { core_db: d1Database(db, wrapAll), evidence_bucket: evidence.bucket, work_bucket: work.bucket, part_sink: partSink, create_sha256_sink: sink };
  const r2seed = seedRows ? await seedR2(evidence.bucket, work.bucket) : { digests: [], total: 0 };
  return { db, port: createBackupPort(ports, { limits: { r2_list_page_size: 50, part_bytes: 512 } }), ports, evidence, work, parts, r2seed };
}
async function aesKey(extractable: boolean): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, extractable, ["encrypt", "decrypt"]);
}
async function exportAndCopy(harness: Harness, overrides: { key?: CryptoKey; generation?: string; adapter?: OffsiteCopyAdapter; idempotency?: string } = {}) {
  const key = overrides.key ?? await aesKey(false);
  const intent = backupIntent(overrides.idempotency ?? "id-1");
  const result = await harness.port.createPortableEpoch(intent, { now_ms: NOW });
  const adapter = overrides.adapter ?? createControlledOffsiteAdapter({ destination_id: "offsite-1", failure_domain: "domain-remote" });
  const copied = await harness.port.copyOffsite({ draft: result.draft, intent, encryption_key: key, key_generation: overrides.generation ?? "key-gen-1", primary_failure_domain: "domain-primary", adapter, now_ms: NOW });
  return { result, copied, key, adapter };
}
describe("ER-34 O2 portable backup epoch", () => {
  it("creates a coherent epoch from seeded canonical D1 rows and real local R2 objects", async () => {
    const harness = await setup();
    expect(await sha(new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x80]))).toBe(harness.r2seed.digests[2]);
    const { result } = await exportAndCopy(harness);
    expect(Object.keys(result.draft.manifest_digests).sort()).toEqual(["generations", "handles", "heads", "ownership", "projects", "purge", "r2-objects", "rebuild", "retention", "revisions", "schema", "scopes", "sources"]);
    expect(result.draft.schema_generation.startsWith("core-")).toBe(true);
    expect(result.draft.purge_ledger_revision).toBe(1);
    expect(result.draft.r2_object_count).toBe(5);
    expect(result.draft.r2_total_bytes).toBe(harness.r2seed.total);
    expect(result.receipt.outcome).toBe("SUCCEEDED");
    expect(result.receipt.reconciliation_required).toBe(false);
    expect(result.draft.part_index.length).toBeGreaterThan(0);
    const epoch = (await exportAndCopy(harness, { idempotency: "id-2" })).copied.epoch;
    expect(() => BackupEpochSchema.parse(epoch)).not.toThrow();
    expect(epoch.epoch_ref).toEqual({ id: result.draft.epoch_id, revision: 1 });
    const firstPart = result.draft.part_index.find((part) => part.manifest === "revisions") as (typeof result.draft.part_index)[number];
    const reopened = await harness.ports.part_sink.open(firstPart.part_key);
    expect(reopened).not.toBeNull();
    expect(new TextDecoder().decode(await reopened?.bytes())).toContain("source_revision");
  });
  it("pages multi-page R2 listings and streams multi-chunk manifests", async () => {
    const harness = await setup();
    harness.port = createBackupPort(harness.ports, { limits: { r2_list_page_size: 2, part_bytes: 128 } });
    const result = await harness.port.createPortableEpoch(backupIntent("id-page"), { now_ms: NOW });
    expect(result.draft.r2_object_count).toBe(5);
    expect(new Set(result.draft.part_index.map((part) => part.manifest)).size).toBeGreaterThan(5);
    for (const part of result.draft.part_index) expect(part.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("exports an empty corpus as an explicit zero epoch", async () => {
    const harness = await setup({}, undefined, false, false);
    const result = await harness.port.createPortableEpoch(backupIntent("id-zero"), { now_ms: NOW });
    expect(result.draft.r2_object_count).toBe(0);
    expect(result.draft.purge_ledger_revision).toBe(0);
    expect(result.draft.manifest_digests["schema"]).toMatch(/^[a-f0-9]{64}$/);
  });
  it("enforces zero/max/max+1 bounds for rows, keys, pages, object bytes, totals and manifests", async () => {
    const boundCases: { label: string; ok: Record<string, number>; over: Record<string, number> }[] = [
      { label: "rows", ok: { max_table_rows: 7 }, over: { max_table_rows: 6 } },
      { label: "keys", ok: { max_r2_keys: 5 }, over: { max_r2_keys: 4 } },
      { label: "pages", ok: { max_r2_pages: 2, r2_list_page_size: 2 }, over: { max_r2_pages: 1, r2_list_page_size: 2 } },
      { label: "object-bytes", ok: { max_object_bytes: 18 }, over: { max_object_bytes: 17 } },
      { label: "total-bytes", ok: { max_total_object_bytes: 69 }, over: { max_total_object_bytes: 68 } },
      { label: "manifest-bytes", ok: { max_manifest_bytes: 4096 }, over: { max_manifest_bytes: 32 } },
    ];
    for (const bound of boundCases) {
      const ok = await setup();
      ok.port = createBackupPort(ok.ports, { limits: { ...bound.ok, part_bytes: 512 } });
      await expect(ok.port.createPortableEpoch(backupIntent(`id-max-${bound.label}`), { now_ms: NOW })).resolves.toBeDefined();
      const over = await setup();
      over.port = createBackupPort(over.ports, { limits: { ...bound.over, part_bytes: 512 } });
      await expect(over.port.createPortableEpoch(backupIntent(`id-over-${bound.label}`), { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_BOUND_EXCEEDED" });
    }
  });
  it("fails closed on malformed JSON, null load-bearing cells and unknown fields", async () => {
    const badJson = await setup({}, (sql, rows) => sql.includes("FROM scope_snapshot") ? rows.map((row) => ({ ...row, resolved_scope_expression_json: "{bad" })) : rows);
    await expect(badJson.port.createPortableEpoch(backupIntent("id-json"), { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_ROW_INVALID" });
    const nulled = await setup({}, (sql, rows) => sql.includes("FROM source ") ? rows.map((row) => ({ ...row, title: null })) : rows);
    await expect(nulled.port.createPortableEpoch(backupIntent("id-null"), { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_ROW_INVALID" });
    const extra = await setup({}, (sql, rows) => sql.includes("FROM project ") && !sql.includes("project_source") ? rows.map((row) => ({ ...row, smuggled: "x" })) : rows);
    await expect(extra.port.createPortableEpoch(backupIntent("id-extra"), { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_ROW_INVALID" });
  });
  it("normalizes out-of-order rows deterministically and rejects duplicates", async () => {
    const baseline = await (await setup()).port.createPortableEpoch(backupIntent("id-order"), { now_ms: NOW });
    const reversed = await setup({}, (sql, rows) => sql.startsWith("SELECT ") ? [...rows].reverse() : rows);
    expect((await reversed.port.createPortableEpoch(backupIntent("id-order"), { now_ms: NOW })).draft.epoch_id).toBe(baseline.draft.epoch_id);
    const duplicated = await setup({}, (sql, rows) => sql.includes("FROM source_revision") && rows.length > 0 ? [...rows, rows[0] as Record<string, unknown>] : rows);
    await expect(duplicated.port.createPortableEpoch(backupIntent("id-dup"), { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_ROW_INVALID" });
  });
  it("replays the same frozen vector to the same epoch identity and conflicts on divergence", async () => {
    const harness = await setup();
    const first = await harness.port.createPortableEpoch(backupIntent("id-replay"), { now_ms: NOW });
    const second = await harness.port.createPortableEpoch(backupIntent("id-replay"), { now_ms: NOW });
    expect(second.draft.epoch_id).toBe(first.draft.epoch_id);
    expect(second.receipt.outcome).toBe("DUPLICATE");
    expect(second.receipt.reason_codes).toContain("REPLAY");
    harness.db.exec(`INSERT INTO source (source_id,source_namespace_id,source_owner_system_id,source_owner_generation,ownership_mode,kind,origin_uri,title,default_storage_policy,default_residency_profile_id,source_class,license_policy_ref,default_retention_policy_id,head_rev,created_at) VALUES ('source-2','ns-1','owner-sys-1','gen-1','immutable_import','document',NULL,'Other','policy-store-1','profile-1','public','license-1','retention-1',NULL,'${T}')`);
    await expect(harness.port.createPortableEpoch(backupIntent("id-replay"), { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_INTENT_CONFLICT" });
    const fresh = createBackupPort(harness.ports, { limits: { r2_list_page_size: 50, part_bytes: 512 } });
    await expect(fresh.createPortableEpoch(backupIntent("id-replay"), { now_ms: NOW })).resolves.toBeDefined();
  });
  it("resumes interrupted exports on verified chunks without a new epoch", async () => {
    const harness = await setup();
    let interruptions = 2;
    const flakySink = {
      ...harness.ports.part_sink,
      async putImmutable(write: Parameters<BackupSourcePorts["part_sink"]["putImmutable"]>[0]) {
        const receipt = await harness.ports.part_sink.putImmutable(write);
        if (interruptions > 0) {
          interruptions -= 1;
          throw new BackupError("BACKUP_PART_WRITE_FAILED", "injected interruption after a durable part write", true, {});
        }
        return receipt;
      },
    };
    const flakyPorts: BackupSourcePorts = { ...harness.ports, part_sink: flakySink };
    const flaky = createBackupPort(flakyPorts, { limits: { r2_list_page_size: 50, part_bytes: 512 } });
    await expect(flaky.createPortableEpoch(backupIntent("id-resume"), { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_PART_WRITE_FAILED" });
    const resumed = await harness.port.createPortableEpoch(backupIntent("id-resume"), { now_ms: NOW });
    expect(resumed.receipt.reconciliation_required).toBe(true);
    expect(resumed.receipt.reason_codes).toContain("RESUMED_PARTS");
    expect((await harness.port.createPortableEpoch(backupIntent("id-resume"), { now_ms: NOW })).draft.epoch_id).toBe(resumed.draft.epoch_id);
  });
  it("reconciles a lost part-sink acknowledgement via conditional-write readback", async () => {
    const harness = await setup({ parts: { loseAckPrefix: "backup-parts/" } });
    const result = await harness.port.createPortableEpoch(backupIntent("id-sink-ack"), { now_ms: NOW });
    expect(result.receipt.reconciliation_required).toBe(true);
    expect(result.draft.part_index.length).toBeGreaterThan(0);
  });
  it("withholds the epoch as stale on concurrent head, generation, owner, scope, policy and purge drift", async () => {
    const mutators: { table: string; sql: string }[] = [
      { table: "investigation", sql: `INSERT INTO investigation (investigation_id,revision,goal,intended_artifact,scope_snapshot_id,scope_snapshot_revision,inquiry_protocol_id,inquiry_protocol_revision,evidence_grade,execution_product,model_profile_ref,budget_ref,stop_rule_ref,current_stage,terminal_disposition,event_head,parent_investigation_id,parent_investigation_revision,manifest_r2_key,created_at) VALUES ('inv-2',1,'goal','artifact','snap-1',1,'protocol-1',1,'E1','research','model-1','budget-1','stop-1','PLAN',NULL,0,NULL,NULL,'r2-x','${T}')` },
      { table: "model_generation", sql: `INSERT INTO model_generation (generation_id,capability_class,route_fingerprint_json,pricing_snapshot_ref,golden_set_result_ref,status,created_at,activated_at,retired_at) VALUES ('mg-2','reasoning','{}','pricing-1',NULL,'SHADOW','${T}',NULL,NULL)` },
      { table: "source_namespace_ownership", sql: `INSERT INTO source_namespace_ownership (source_namespace_id,ownership_record_revision,owner_system_id,owner_incarnation_ref,source_owner_generation,source_admission_policy_revision,status,cutover_receipt_ref,created_at) VALUES ('ns-1',2,'owner-sys-1','incarnation-2','gen-2',1,'FENCED',NULL,'${T}')` },
      { table: "scope_snapshot", sql: `UPDATE scope_snapshot SET policy_authority_ref='policy-authority-2' WHERE snapshot_id='snap-1'` },
      { table: "purge_ledger", sql: `INSERT INTO purge_ledger (erasure_id,non_revealing_subject_digest,disposition,receipt_ref,created_at) VALUES ('erasure-2','${HEX("5")}','BLOCKED','receipt-2','${T}')` },
    ];
    for (const [index, mutator] of mutators.entries()) {
      const harness = await setup();
      let mutated = false;
      const evidence = shimBucket({
        onFirstList: async () => {
          if (!mutated) {
            mutated = true;
            harness.db.exec(mutator.sql);
          }
        },
      });
      expect(await seedR2(evidence.bucket, harness.work.bucket)).toMatchObject({ total: expect.any(Number) });
      const port = createBackupPort({ ...harness.ports, evidence_bucket: evidence.bucket }, { limits: { r2_list_page_size: 50, part_bytes: 512 } });
      let error: unknown;
      try {
        await port.createPortableEpoch(backupIntent(`id-drift-${index}`), { now_ms: NOW });
      } catch (cause) {
        error = cause;
      }
      expect(error).toMatchObject({ code: "BACKUP_VECTOR_DRIFT" });
      expect((error as BackupError).detail["drifted"] ?? "").toContain(mutator.table);
    }
  });
  it("fails closed on digest mismatch, tampered bytes and truncated readback", async () => {
    const tampered = await setup();
    const firstKey = [...tampered.evidence.objects.keys()].sort()[0] as string;
    (tampered.evidence.objects.get(firstKey) as ShimObject).bytes = new TextEncoder().encode("forged bytes with identical length!!");
    await expect(tampered.port.createPortableEpoch(backupIntent("id-tamper"), { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_OBJECT_DIGEST_MISMATCH" });
    const truncated = await setup();
    const shortKey = [...truncated.work.objects.keys()].sort()[0] as string;
    const shorted = shimBucket({ shortKeys: new Set([shortKey]) });
    for (const [key, object] of truncated.work.objects) shorted.objects.set(key, object);
    await expect(createBackupPort({ ...truncated.ports, work_bucket: shorted.bucket }, { limits: { r2_list_page_size: 50, part_bytes: 512 } }).createPortableEpoch(backupIntent("id-truncate"), { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_OBJECT_UNREADABLE" });
  });
  it("rejects cancelled exports, malformed intents and absent schema state", async () => {
    const harness = await setup();
    const controller = new AbortController();
    controller.abort();
    await expect(harness.port.createPortableEpoch(backupIntent("id-cancel"), { now_ms: NOW, signal: controller.signal })).rejects.toMatchObject({ code: "BACKUP_CANCELLED" });
    await expect(harness.port.createPortableEpoch({ ...backupIntent("id-bad"), operation_kind: "QUERY" }, { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_INPUT_INVALID" });
    const db = openCore();
    db.exec("DELETE FROM schema_state");
    const empty = await setup({}, undefined, false, false);
    await expect(createBackupPort({ ...empty.ports, core_db: d1Database(db) }).createPortableEpoch(backupIntent("id-schema"), { now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_TABLE_MISSING" });
  });
});
describe("ER-34 O2 encrypted offsite copy", () => {
  it("round-trips encrypted parts with stable refs and differing ciphertext", async () => {
    const first = await setup();
    const key = await aesKey(false);
    const left = await exportAndCopy(first, { key, idempotency: "id-off-1" });
    const right = await exportAndCopy(await setup(), { key, idempotency: "id-off-1" });
    expect(left.copied.offsite_copy_ref).toBe(right.copied.offsite_copy_ref);
    expect(left.copied.readback_digest).toBe(right.copied.readback_digest);
    expect(left.copied.epoch.offsite_failure_domain).toBe("domain-remote");
    expect(left.copied.epoch.encryption_key_generation).toBe("key-gen-1");
    expect((left.adapter as ReturnType<typeof createControlledOffsiteAdapter>).journal).toEqual([]);
    const firstPart = left.result.draft.part_index[0] as (typeof left.result.draft.part_index)[number];
    const ref = `offsite/${left.result.draft.epoch_id}/${firstPart.manifest}/${String(firstPart.index).padStart(6, "0")}-${firstPart.sha256}`;
    const twin = createControlledOffsiteAdapter({ destination_id: "offsite-2", failure_domain: "domain-far" });
    await first.port.copyOffsite({ draft: left.result.draft, intent: backupIntent("id-off-1"), encryption_key: key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", adapter: twin, now_ms: NOW });
    const leftBytes = (left.adapter as ReturnType<typeof createControlledOffsiteAdapter>).peek(ref);
    const twinBytes = twin.peek(ref);
    expect(leftBytes).not.toBeNull();
    expect(twinBytes).not.toBeNull();
    expect(await sha(leftBytes as Uint8Array)).not.toBe(await sha(twinBytes as Uint8Array));
    expect((twinBytes as Uint8Array).byteLength).toBe(firstPart.size_bytes + 28);
  });
  it("reconciles a lost offsite acknowledgement without a blind second identity", async () => {
    const harness = await setup();
    const intent = backupIntent("id-off-ack");
    const result = await harness.port.createPortableEpoch(intent, { now_ms: NOW });
    const adapter = createControlledOffsiteAdapter({ destination_id: "offsite-ack", failure_domain: "domain-remote", faults: { lose_ack_after_puts: 1000 } });
    const copied = await harness.port.copyOffsite({ draft: result.draft, intent, encryption_key: await aesKey(false), key_generation: "key-gen-1", primary_failure_domain: "domain-primary", adapter, now_ms: NOW });
    expect(copied.receipt.reconciliation_required).toBe(true);
    expect(copied.receipt.reason_codes).toContain("OFFSITE_ACK_RECONCILED");
    expect(adapter.puts).toBe(result.draft.part_index.length);
    expect(() => BackupEpochSchema.parse(copied.epoch)).not.toThrow();
  });
  it("fails closed on partial copies, wrong digests, truncations and altered metadata", async () => {
    for (const corrupt of ["bytes", "truncate", "metadata"] as const) {
      const harness = await setup();
      const intent = backupIntent(`id-off-${corrupt}`);
      const result = await harness.port.createPortableEpoch(intent, { now_ms: NOW });
      const adapter = createControlledOffsiteAdapter({ destination_id: `offsite-${corrupt}`, failure_domain: "domain-remote", faults: { corrupt_readback: corrupt } });
      await expect(harness.port.copyOffsite({ draft: result.draft, intent, encryption_key: await aesKey(false), key_generation: "key-gen-1", primary_failure_domain: "domain-primary", adapter, now_ms: NOW })).rejects.toMatchObject({ code: "BACKUP_OFFSITE_READBACK_MISMATCH" });
    }
  });
  it("rejects same-failure-domain, cross-epoch substitution, expiry and incapable destinations", async () => {
    const harness = await setup();
    const intent = backupIntent("id-off-domain");
    const result = await harness.port.createPortableEpoch(intent, { now_ms: NOW });
    const key = await aesKey(false);
    const base = { draft: result.draft, intent, encryption_key: key, key_generation: "key-gen-1", primary_failure_domain: "domain-primary", now_ms: NOW };
    await expect(harness.port.copyOffsite({ ...base, adapter: createControlledOffsiteAdapter({ destination_id: "offsite-same", failure_domain: "domain-primary" }) })).rejects.toMatchObject({ code: "BACKUP_OFFSITE_INADMISSIBLE" });
    const victim = createControlledOffsiteAdapter({ destination_id: "offsite-victim", failure_domain: "domain-remote" });
    await harness.port.copyOffsite({ ...base, adapter: victim });
    const swapped: OffsiteCopyAdapter = {
      describe: () => victim.describe(),
      put: (ref, bytes, stored) => victim.put(ref, bytes, stored),
      get: async () => ({ ciphertext: new Uint8Array([1, 2, 3]), stored: { content_digest: HEX("9"), size_bytes: 3, key_generation: "key-gen-1", epoch_id: "epoch-foreign", expires_at: T } }),
      delete: (ref, reason) => victim.delete(ref, reason),
    };
    await expect(harness.port.copyOffsite({ ...base, adapter: swapped })).rejects.toMatchObject({ code: "BACKUP_OFFSITE_READBACK_MISMATCH" });
    await expect(harness.port.copyOffsite({ ...base, adapter: createControlledOffsiteAdapter({ destination_id: "offsite-old", failure_domain: "domain-remote", expires_at: "2020-01-01T00:00:00.000Z" }) })).rejects.toMatchObject({ code: "BACKUP_OFFSITE_EXPIRED" });
    await expect(harness.port.copyOffsite({ ...base, adapter: createControlledOffsiteAdapter({ destination_id: "offsite-nojournal", failure_domain: "domain-remote", supports_deletion_journal: false }) })).rejects.toMatchObject({ code: "BACKUP_OFFSITE_INADMISSIBLE" });
    await expect(harness.port.copyOffsite({ ...base, adapter: createControlledOffsiteAdapter({ destination_id: "offsite-noexpiry", failure_domain: "domain-remote", supports_expiry: false }) })).rejects.toMatchObject({ code: "BACKUP_OFFSITE_INADMISSIBLE" });
    await expect(harness.port.copyOffsite({ ...base, adapter: createControlledOffsiteAdapter({ destination_id: "offsite-hold", failure_domain: "domain-remote", legal_hold_ref: "legal-1" }) })).rejects.toMatchObject({ code: "BACKUP_OFFSITE_INADMISSIBLE" });
  });
  it("records expiry and a deletion journal while a locked destination reports PURGE_BLOCKED", async () => {
    const harness = await setup();
    const { copied } = await exportAndCopy(harness, { idempotency: "id-off-journal" });
    expect(Date.parse(copied.epoch.expires_at)).toBeGreaterThan(Date.parse(copied.epoch.created_at));
    expect(copied.offsite_copy_ref.startsWith("offsite-")).toBe(true);
    const victim = createControlledOffsiteAdapter({ destination_id: "offsite-del", failure_domain: "domain-remote" });
    const second = await exportAndCopy(await setup(), { idempotency: "id-off-del", adapter: victim });
    for (const part of second.result.draft.part_index) {
      const ref = `offsite/${second.result.draft.epoch_id}/${part.manifest}/${String(part.index).padStart(6, "0")}-${part.sha256}`;
      expect((await victim.delete(ref, "retention-expiry")).journal_ref.startsWith("journal-")).toBe(true);
      expect(await victim.get(ref)).toBeNull();
    }
    expect(victim.journal.length).toBe(second.result.draft.part_index.length);
    const locked = createControlledOffsiteAdapter({ destination_id: "offsite-locked", failure_domain: "domain-remote", retention_locked: true, expires_at: "2027-06-01T00:00:00.000Z" });
    const fresh = await setup();
    const intent = backupIntent("id-off-locked");
    const result = await fresh.port.createPortableEpoch(intent, { now_ms: NOW });
    let blocked: unknown;
    try {
      await fresh.port.copyOffsite({ draft: result.draft, intent, encryption_key: await aesKey(false), key_generation: "key-gen-1", primary_failure_domain: "domain-primary", adapter: locked, now_ms: NOW });
    } catch (cause) {
      blocked = cause;
    }
    expect(blocked).toMatchObject({ code: "BACKUP_PURGE_BLOCKED" });
    expect((blocked as BackupError).detail["next_review_at"]).toBe("2027-06-01T00:00:00.000Z");
    expect(locked.puts).toBe(0);
  });
  it("keeps key material and source bytes out of the epoch, receipts and logs", async () => {
    const key = await aesKey(true);
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
    const rawHex = [...raw].map((value) => value.toString(16).padStart(2, "0")).join("");
    const harness = await setup();
    const { result, copied } = await exportAndCopy(harness, { key, idempotency: "id-off-leak" });
    const serialized = JSON.stringify({ epoch: copied.epoch, attempt: result.attempt, receipt: result.receipt, offsite: copied.receipt });
    expect(serialized).not.toContain("MARKER-TITLE-7f3a");
    expect(serialized).not.toContain(rawHex);
    expect(serialized).not.toContain("evidence bytes one");
  });
  it("records search, queue, workflow and object state only as rebuild references", async () => {
    const harness = await setup();
    const result = await harness.port.createPortableEpoch(backupIntent("id-rebuild"), { now_ms: NOW });
    expect(result.draft.manifest_digests["rebuild"]).toMatch(/^[a-f0-9]{64}$/);
    const part = result.draft.part_index.find((entry) => entry.manifest === "rebuild") as (typeof result.draft.part_index)[number];
    const reopened = await harness.ports.part_sink.open(part.part_key);
    const text = new TextDecoder().decode(await reopened?.bytes());
    expect(text).toContain("REBUILD_REQUIRED");
    expect(text).toContain("NOT_A_BACKUP");
    expect(text).not.toContain("projection_item");
  });
  it("keeps restore, purge replay and erasure paths explicitly not implemented", async () => {
    const restore = createPendingRestorePort();
    const harness = await setup();
    const { copied } = await exportAndCopy(harness, { idempotency: "id-restore" });
    await expect(restore.restoreIsolated(copied.epoch)).rejects.toMatchObject({ code: "BACKUP_RESTORE_NOT_IMPLEMENTED" });
    await expect(restore.applyPurgeLedger("env-1", 1)).rejects.toMatchObject({ code: "BACKUP_RESTORE_NOT_IMPLEMENTED" });
    await expect(restore.rebuildProjections("env-1")).rejects.toMatchObject({ code: "BACKUP_RESTORE_NOT_IMPLEMENTED" });
    await expect(restore.verifyBeforeTraffic("env-1")).rejects.toMatchObject({ code: "BACKUP_RESTORE_NOT_IMPLEMENTED" });
    await expect(harness.port.markEpochForPurgeReplay("epoch-1", 1)).rejects.toMatchObject({ code: "BACKUP_PURGE_REPLAY_NOT_IMPLEMENTED" });
  });
});
