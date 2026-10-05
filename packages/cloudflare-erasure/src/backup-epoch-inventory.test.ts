/// <reference types="node" />
/// <reference types="vite/client" />
import { DatabaseSync } from "node:sqlite";
import type { ErasureRequest, OperationIntent } from "@eliotr/contracts";
import {
  createBackupPort,
  verifyPortableBackupManifests,
  type BackupEpochDraft,
  type BackupSourcePorts,
  type EvidenceObjectStore,
  type Sha256DigestSink,
} from "@eliotr/backup-o2";
import { describe, expect, it } from "vitest";
import { createD1ErasureInventory } from "./inventory.js";

const CREATED_AT = "2026-09-06T00:00:00.000Z";
const NOW = Date.parse(CREATED_AT);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const CORE_MIGRATIONS = import.meta.glob<string>("../../../infra/d1/core/migrations/*.sql", {
  eager: true,
  query: "?raw",
  import: "default",
});

async function sha(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}

function digestSink(): Sha256DigestSink {
  const chunks: Uint8Array[] = [];
  let resolve!: (value: ArrayBuffer) => void;
  let reject!: (reason: unknown) => void;
  const digest = new Promise<ArrayBuffer>((yes, no) => { resolve = yes; reject = no; });
  return {
    writable: new WritableStream<Uint8Array>({
      write(chunk) { chunks.push(chunk.slice()); },
      async close() {
        try {
          const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          const copy = new Uint8Array(bytes.byteLength);
          copy.set(bytes);
          resolve(await crypto.subtle.digest("SHA-256", copy.buffer));
        } catch (cause) { reject(cause); }
      },
      abort(reason) { reject(reason); },
    }),
    digest,
  };
}

function d1Database(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      const bind = (values: unknown[]) => ({
        async all<T>(): Promise<D1Result<T>> {
          const results = statement.all(...values as (string | number | null)[]) as unknown as T[];
          return { success: true, results, meta: {} } as unknown as D1Result<T>;
        },
        async first<T>(): Promise<T | null> {
          const result = statement.get(...values as (string | number | null)[]) as unknown as T | undefined;
          return result ?? null;
        },
        async run<T>(): Promise<D1Result<T>> {
          statement.run(...values as (string | number | null)[]);
          return { success: true, results: [], meta: {} } as unknown as D1Result<T>;
        },
      });
      return { bind: (...values: unknown[]) => bind(values), ...bind([]) };
    },
  } as unknown as D1Database;
}

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly etag: string;
  readonly version: string;
  readonly customMetadata: Record<string, string>;
}

function memoryBucket(): { readonly bucket: R2Bucket; readonly objects: Map<string, StoredObject> } {
  const objects = new Map<string, StoredObject>();
  let sequence = 0;
  const stream = (bytes: Uint8Array): ReadableStream<Uint8Array> => new ReadableStream({
    start(controller) { controller.enqueue(bytes.slice()); controller.close(); },
  });
  const meta = (key: string, object: StoredObject) => ({
    key, size: object.bytes.byteLength, etag: object.etag, version: object.version,
    customMetadata: { ...object.customMetadata },
  });
  const bucket = {
    async head(key: string) {
      const object = objects.get(key);
      return object === undefined ? null : meta(key, object);
    },
    async get(key: string) {
      const object = objects.get(key);
      if (object === undefined) return null;
      const frozen = object.bytes.slice();
      return {
        ...meta(key, object),
        body: stream(frozen),
        async arrayBuffer() { return frozen.slice().buffer; },
        async text() { return new TextDecoder().decode(frozen); },
        async bytes() { return frozen.slice(); },
      };
    },
    async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob, options?: Record<string, unknown>) {
      let bytes: Uint8Array;
      if (typeof value === "string") bytes = new TextEncoder().encode(value);
      else if (value === null) bytes = new Uint8Array();
      else if (value instanceof ReadableStream) bytes = new Uint8Array(await new Response(value as ReadableStream<Uint8Array>).arrayBuffer());
      else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value.slice(0));
      else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      else bytes = new Uint8Array(await value.arrayBuffer());
      sequence += 1;
      const etag = `etag-${sequence}`;
      const version = `version-${sequence}`;
      const customMetadata = { ...((options?.["customMetadata"] as Record<string, string> | undefined) ?? {}) };
      objects.set(key, { bytes, etag, version, customMetadata });
      return { key, size: bytes.byteLength, etag, version };
    },
    async delete(keys: string | string[]) {
      for (const key of typeof keys === "string" ? [keys] : keys) objects.delete(key);
    },
    async list(options?: { readonly prefix?: string; readonly limit?: number; readonly cursor?: string }) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(options?.prefix ?? "")).sort();
      const start = options?.cursor === undefined ? 0 : Number(options.cursor);
      const end = start + (options?.limit ?? 1000);
      const page = keys.slice(start, end).map((key) => meta(key, objects.get(key) as StoredObject));
      return end < keys.length
        ? { objects: page, truncated: true, cursor: String(end), delimitedPrefixes: [] }
        : { objects: page, truncated: false, delimitedPrefixes: [] };
    },
  };
  return { bucket: bucket as unknown as R2Bucket, objects };
}

async function openObjectBytes(bucket: R2Bucket, key: string): Promise<Uint8Array | null> {
  const object = await bucket.get(key);
  if (object === null || object.body === null) return null;
  return new Uint8Array(await new Response(object.body as ReadableStream<Uint8Array>).arrayBuffer());
}

function partSink(bucket: R2Bucket): EvidenceObjectStore {
  return {
    async putImmutable(write) {
      const existing = await openObjectBytes(bucket, write.key);
      if (existing !== null) {
        const digest = await sha(existing);
        const found = await bucket.head(write.key) as { readonly etag: string };
        if (digest !== write.expected_sha256 || existing.byteLength !== write.expected_size_bytes) {
          throw new Error("immutable test part conflict");
        }
        return {
          key: write.key, expected_sha256: write.expected_sha256, readback_sha256: digest,
          size_bytes: existing.byteLength, etag: found.etag, existed_identically: true,
        };
      }
      const body = new Uint8Array(await new Response(write.body).arrayBuffer());
      await bucket.put(write.key, body, { customMetadata: write.custom_metadata });
      const stored = await bucket.head(write.key) as { readonly etag: string };
      return {
        key: write.key, expected_sha256: write.expected_sha256, readback_sha256: await sha(body),
        size_bytes: body.byteLength, etag: stored.etag, existed_identically: false,
      };
    },
    open(key) { return bucket.get(key); },
  };
}

function openCore(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const migrations = Object.entries(CORE_MIGRATIONS).sort(([left], [right]) => left.localeCompare(right));
  for (const [, migration] of migrations) db.exec(migration);
  for (const [index, [path]] of migrations.entries()) {
    const name = path.split("/").at(-1)?.replace(/\.sql$/u, "");
    if (name === undefined) throw new Error("tracked Core migration path is malformed");
    db.prepare("INSERT INTO d1_migrations(name,applied_at) VALUES(?1,?2)")
      .run(`${name}.sql`, `2026-09-06T00:00:${String(index).padStart(2, "0")}.000Z`);
  }
  return db;
}

function addSource(db: DatabaseSync, sourceId: string, revisionRef: string, content: string, residency: string): void {
  db.prepare("INSERT INTO source_namespace_ownership (source_namespace_id,ownership_record_revision,owner_system_id,owner_incarnation_ref,source_owner_generation,source_admission_policy_revision,status,cutover_receipt_ref,created_at) VALUES (?1,1,'owner-system','incarnation-1','owner-gen',1,'ACTIVE',NULL,?2)")
    .run(`namespace-${sourceId}`, CREATED_AT);
  db.prepare("INSERT INTO source (source_id,source_namespace_id,source_owner_system_id,source_owner_generation,ownership_mode,kind,origin_uri,title,default_storage_policy,default_residency_profile_id,source_class,license_policy_ref,default_retention_policy_id,head_rev,created_at) VALUES (?1,?2,'owner-system','owner-gen','immutable_import','document',NULL,?3,'storage-policy','residency-profile','public','license','retention',NULL,?4)")
    .run(sourceId, `namespace-${sourceId}`, `title-${sourceId}`, CREATED_AT);
  db.prepare("INSERT INTO source_revision (source_revision_ref,source_id,source_owner_generation,content_sha256,object_residency_key_digest,original_r2_key,normalized_artifact_ref,captured_at,parser_profile_generation,quality_state,purge_state,currentness_state,source_view_ref,workspace_view_revision_ref,admitted_at) VALUES (?1,?2,'owner-gen',?3,?4,NULL,NULL,?5,NULL,'standard','LIVE','unknown',?6,NULL,?5)")
    .run(revisionRef, sourceId, content, residency, CREATED_AT, `view-${revisionRef}`);
}

interface ProducedEpoch {
  readonly db: DatabaseSync;
  readonly id: string;
  readonly draft: BackupEpochDraft;
  readonly part_bucket: R2Bucket;
}

async function produceEpoch(sourceId: string, revisionRef: string, content: string, residency: string, intentKey: string): Promise<ProducedEpoch> {
  const db = openCore();
  addSource(db, sourceId, revisionRef, content, residency);
  const evidence = memoryBucket();
  const work = memoryBucket();
  const parts = memoryBucket();
  const ports: BackupSourcePorts = {
    core_db: d1Database(db), evidence_bucket: evidence.bucket, work_bucket: work.bucket,
    part_sink: partSink(parts.bucket), create_sha256_sink: digestSink,
  };
  const intent: OperationIntent = {
    intent_ref: { id: `intent-${intentKey}`, revision: 1 }, operation_kind: "BACKUP",
    principal_ref: "test-owner", idempotency_key: intentKey, payload_ref: "backup-request",
    policy_decision_ref: "backup-policy", created_at: CREATED_AT,
  };
  const result = await createBackupPort(ports, { limits: { r2_list_page_size: 50, part_bytes: 1024 } })
    .createPortableEpoch(intent, { now_ms: NOW });
  const persisted = db.prepare("SELECT epoch_id,draft_json FROM backup_epoch_receipt WHERE epoch_id=?1")
    .get(result.draft.epoch_id) as { readonly epoch_id: string; readonly draft_json: string } | undefined;
  expect(persisted?.epoch_id).toBe(result.draft.epoch_id);
  expect(JSON.parse(persisted?.draft_json ?? "null")).toEqual(result.draft);
  return { db, id: result.draft.epoch_id, draft: result.draft, part_bucket: parts.bucket };
}

async function verifyProducedEpoch(epoch: ProducedEpoch) {
  const plaintext_parts = [];
  for (const part of epoch.draft.part_index) {
    const bytes = await openObjectBytes(epoch.part_bucket, part.part_key);
    expect(bytes).not.toBeNull();
    plaintext_parts.push({ manifest: part.manifest, index: part.index, bytes: bytes as Uint8Array });
  }
  return verifyPortableBackupManifests({ draft: epoch.draft, plaintext_parts });
}

function erasureRequest(subject: string): ErasureRequest {
  return {
    protocol: "erc.privacy.erasure.v1",
    erasure_ref: { id: "erase-backup-test", revision: 1 },
    requested_by_principal_ref: "privacy-owner",
    exact_subject_refs: [subject],
    required_locations: ["BackupRestorePath"],
    legal_basis_ref: "delete-request",
    admitted_at: CREATED_AT,
    deadline: "2026-09-13T00:00:00.000Z",
  };
}

describe("D1 backup epoch inventory producer integration", () => {
  it("reads O2 parts from the explicit primary bucket without reading source Work", async () => {
    const epoch = await produceEpoch("source-A", "revision-A1", HASH_A, HASH_B, "separate-parts");
    try {
      epoch.db.prepare("INSERT INTO backup_epoch (backup_epoch_id,core_export_ref,search_projection_manifest_ref,evidence_manifest_ref,work_manifest_ref,offsite_copy_ref,purge_ledger_revision,verification_state,created_at,verified_at) VALUES (?1,'core','search','evidence','work','offsite',0,'VERIFIED',?2,?2)")
        .run(epoch.id, CREATED_AT);
      let sourceWorkReads = 0;
      const sourceWork = {
        async get() { sourceWorkReads += 1; throw new Error("source Work is not the primary part store"); },
        async list() { sourceWorkReads += 1; throw new Error("source Work is not the primary part store"); },
      } as unknown as R2Bucket;
      const database = d1Database(epoch.db);
      const inventory = createD1ErasureInventory({
        core_database: database, search_database: database,
        work_bucket: sourceWork, backup_parts_bucket: epoch.part_bucket,
      });
      const closure = await inventory.enumerate(erasureRequest("source-revision:revision-A1"));
      expect(closure.targets).toHaveLength(1);
      expect(closure.targets[0]).toMatchObject({ location: "BackupRestorePath", canonical_ref: `backup:${epoch.id}` });
      expect(sourceWorkReads).toBe(0);
    } finally { epoch.db.close(); }
  }, 30_000);

  it("refuses source Work as an implicit primary backup-part binding", async () => {
    const epoch = await produceEpoch("source-A", "revision-A1", HASH_A, HASH_B, "missing-part-binding");
    try {
      epoch.db.prepare("INSERT INTO backup_epoch (backup_epoch_id,core_export_ref,search_projection_manifest_ref,evidence_manifest_ref,work_manifest_ref,offsite_copy_ref,purge_ledger_revision,verification_state,created_at,verified_at) VALUES (?1,'core','search','evidence','work','offsite',0,'VERIFIED',?2,?2)")
        .run(epoch.id, CREATED_AT);
      const database = d1Database(epoch.db);
      const inventory = createD1ErasureInventory({
        core_database: database, search_database: database, work_bucket: epoch.part_bucket,
      });
      await expect(inventory.enumerate(erasureRequest("source-revision:revision-A1")))
        .rejects.toMatchObject({ code: "ERASURE_CLOSURE_INCOMPLETE", message: "source-scoped local backup archive authority is unavailable" });
    } finally { epoch.db.close(); }
  }, 30_000);

  it("uses O2-produced persisted manifests to distinguish source and revision roots", async () => {
    const a1 = await produceEpoch("source-A", "revision-A1", HASH_A, HASH_B, "epoch-a1");
    const a2 = await produceEpoch("source-A", "revision-A2", HASH_C, HASH_D, "epoch-a2");
    const b1 = await produceEpoch("source-B", "revision-B1", HASH_A, HASH_D, "epoch-b1");

    const [manifestA1, manifestA2, manifestB1] = await Promise.all([
      verifyProducedEpoch(a1), verifyProducedEpoch(a2), verifyProducedEpoch(b1),
    ]);
    const sourceIds = (manifest: typeof manifestA1) => manifest.source_rows
      .filter((entry) => entry.table === "source").map((entry) => entry.row["source_id"]);
    const revisions = (manifest: typeof manifestA1) => manifest.source_rows
      .filter((entry) => entry.table === "source_revision").map((entry) => entry.row["source_revision_ref"]);

    expect(sourceIds(manifestA1)).toEqual(["source-A"]);
    expect(revisions(manifestA1)).toEqual(["revision-A1"]);
    expect(sourceIds(manifestA2)).toEqual(["source-A"]);
    expect(revisions(manifestA2)).toEqual(["revision-A2"]);
    expect(sourceIds(manifestB1)).toEqual(["source-B"]);
    expect(revisions(manifestB1)).toEqual(["revision-B1"]);
    for (const epoch of [a1, a2, b1]) {
      expect(epoch.db.prepare("SELECT COUNT(*) AS count FROM backup_epoch").get())
        .toMatchObject({ count: 0 });
      epoch.db.close();
    }
  }, 30_000);

  it("blocks the actual inventory producer when an O2 receipt lacks its canonical backup_epoch link", async () => {
    const epoch = await produceEpoch("source-A", "revision-A1", HASH_A, HASH_B, "missing-link");
    const database = d1Database(epoch.db);
    const inventory = createD1ErasureInventory({
      core_database: database,
      search_database: database,
      work_bucket: memoryBucket().bucket,
      backup_parts_bucket: epoch.part_bucket,
    });
    await expect(inventory.enumerate(erasureRequest("source-revision:revision-A1")))
      .rejects.toMatchObject({ code: "ERASURE_CLOSURE_INCOMPLETE" });

    epoch.db.prepare("INSERT INTO backup_epoch (backup_epoch_id,core_export_ref,search_projection_manifest_ref,evidence_manifest_ref,work_manifest_ref,offsite_copy_ref,purge_ledger_revision,verification_state,created_at,verified_at) VALUES (?1,'core','search','evidence','work','offsite',0,'PENDING',?2,NULL)")
      .run("different-epoch", CREATED_AT);
    await expect(inventory.enumerate(erasureRequest("source-revision:revision-A1")))
      .rejects.toMatchObject({ code: "ERASURE_CLOSURE_INCOMPLETE" });
    epoch.db.close();
  }, 30_000);

  it("does not promote a matching canonical PENDING row to verified authority", async () => {
    const epoch = await produceEpoch("source-A", "revision-A1", HASH_A, HASH_B, "pending-link");
    epoch.db.prepare("INSERT INTO backup_epoch (backup_epoch_id,core_export_ref,search_projection_manifest_ref,evidence_manifest_ref,work_manifest_ref,offsite_copy_ref,purge_ledger_revision,verification_state,created_at,verified_at) VALUES (?1,'core','search','evidence','work','offsite',0,'PENDING',?2,NULL)")
      .run(epoch.id, CREATED_AT);
    const database = d1Database(epoch.db);
    const inventory = createD1ErasureInventory({
      core_database: database,
      search_database: database,
      work_bucket: memoryBucket().bucket,
      backup_parts_bucket: epoch.part_bucket,
    });
    await expect(inventory.enumerate(erasureRequest("source-revision:revision-A1")))
      .rejects.toMatchObject({ code: "ERASURE_CLOSURE_INCOMPLETE" });
    epoch.db.close();
  }, 30_000);
});
