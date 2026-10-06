/// <reference types="node" />
/// <reference types="vite/client" />
import { DatabaseSync } from "node:sqlite";
import type { ErasureFence, ErasureRequest, OperationIntent, PurgeTarget } from "@eliotr/contracts";
import {
  createBackupPort,
  type BackupEpochDraft,
  type BackupSourcePorts,
  type EvidenceObjectStore,
  type Sha256DigestSink,
} from "@eliotr/backup-o2";
import {
  createBackupErasureLocationPort,
  createCloudflareErasureBackend,
  createD1ErasureAuthority,
  createD1ErasureInventory,
  composeBackupErasurePort,
  erasureDigest,
  stableErasureId,
  type BackupErasurePort,
  type BackupPrimaryWriterQualificationInput,
  type BackupPrimaryWriterQualificationReceipt,
  type BackupPrimaryWriterQualificationVerifier,
} from "@eliotr/cloudflare-erasure";
import { createBackupEpochScopePort } from "./backup-epoch-scope.js";
import { createD1BackupPrimaryInventoryPort } from "./backup-primary-adapter.js";
import { createPrimaryBackupErasurePort } from "./backup-primary-purge.js";
import { createD1BackupProducerQuiescencePort } from "./backup-producer-quiescence.js";

const CREATED_AT = new Date(Date.now() - 60_000).toISOString();
const NOW = Date.now();
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
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer))].map((value) => value.toString(16).padStart(2, "0")).join("");
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
  const database = {
    prepare(sql: string): D1PreparedStatement {
      const statement = db.prepare(sql);
      const bind = (values: unknown[]): D1PreparedStatement => ({
        bind: (...next: unknown[]) => bind(next),
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
        async raw<T>(): Promise<T[]> {
          return statement.all(...values as (string | number | null)[]) as unknown as T[];
        },
      } as unknown as D1PreparedStatement);
      return bind([]);
    },
    async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
      db.exec("BEGIN IMMEDIATE");
      try {
        const results: D1Result[] = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (cause) {
        db.exec("ROLLBACK");
        throw cause;
      }
    },
  };
  return database as unknown as D1Database;
}

function physicalInventoryDependencies(database: D1Database, bucket: R2Bucket) {
  return { backup_primary_inventory: createD1BackupPrimaryInventoryPort({ database, bucket }),
    backup_epoch_scope: createBackupEpochScopePort(), backup_producer_quiescence: createD1BackupProducerQuiescencePort(database) };
}

interface StoredObject {
  readonly bytes: Uint8Array; readonly etag: string;
  readonly version: string; readonly customMetadata: Record<string, string>;
}

function memoryBucket(): {
  readonly bucket: R2Bucket;
  readonly objects: Map<string, StoredObject>;
  failNextDelete(mode: "before" | "after", key?: string): void;
} {
  const objects = new Map<string, StoredObject>();
  let sequence = 0;
  let deleteFailure: { readonly mode: "before" | "after"; readonly key?: string } | null = null;
  const stream = (bytes: Uint8Array): ReadableStream<Uint8Array> => new ReadableStream({ start(controller) { controller.enqueue(bytes.slice()); controller.close(); } });
  const meta = (key: string, object: StoredObject) => ({ key, size: object.bytes.byteLength, etag: object.etag, version: object.version, customMetadata: { ...object.customMetadata } });
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
      for (const key of typeof keys === "string" ? [keys] : keys) {
        if (deleteFailure !== null && (deleteFailure.key === undefined || deleteFailure.key === key)) {
          const failure = deleteFailure;
          deleteFailure = null;
          if (failure.mode === "after") objects.delete(key);
          throw new Error("simulated lost R2 delete acknowledgement");
        }
        objects.delete(key);
      }
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
  return {
    bucket: bucket as unknown as R2Bucket,
    objects,
    failNextDelete(mode, key) { deleteFailure = { mode, ...(key === undefined ? {} : { key }) }; },
  };
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
      await bucket.put(write.key, body, { customMetadata: {
        ...write.custom_metadata,
        eliotr_sha256: write.expected_sha256,
        eliotr_size_bytes: String(write.expected_size_bytes),
        eliotr_immutable: "true",
      } });
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
  const migrations = Object.entries(CORE_MIGRATIONS)
    .filter(([path]) => !path.endsWith("0119_backup_epoch_manifest_bindings.sql"))
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [, migration] of migrations) db.exec(migration);
  for (const [index, [path]] of migrations.entries()) {
    const name = path.split("/").at(-1)?.replace(/\.sql$/u, "");
    if (name === undefined) throw new Error("tracked Core migration path is malformed");
    db.prepare("INSERT INTO d1_migrations(name,applied_at) VALUES(?1,?2)")
      .run(`${name}.sql`, new Date(Date.parse(CREATED_AT) + index).toISOString());
  }
  return db;
}

function applyManifestBindingsMigration(db: DatabaseSync): void {
  const migration = Object.entries(CORE_MIGRATIONS)
    .find(([path]) => path.endsWith("0119_backup_epoch_manifest_bindings.sql"));
  if (migration === undefined) throw new Error("0119 migration source is unavailable");
  const [path, sql] = migration;
  db.exec(sql);
  const name = path.split("/").at(-1);
  if (name === undefined) throw new Error("tracked Core migration path is malformed");
  db.prepare("INSERT INTO d1_migrations(name,applied_at) VALUES(?1,?2)")
    .run(name, new Date(Date.now()).toISOString());
}

function addSource(db: DatabaseSync, sourceId: string, revisionRef: string, content: string, residency: string): void {
  db.prepare("INSERT INTO source_namespace_ownership (source_namespace_id,ownership_record_revision,owner_system_id,owner_incarnation_ref,source_owner_generation,source_admission_policy_revision,status,cutover_receipt_ref,created_at) VALUES (?1,1,'owner-system','incarnation-1','owner-gen',1,'ACTIVE',NULL,?2)").run(`namespace-${sourceId}`, CREATED_AT);
  db.prepare("INSERT INTO source (source_id,source_namespace_id,source_owner_system_id,source_owner_generation,ownership_mode,kind,origin_uri,title,default_storage_policy,default_residency_profile_id,source_class,license_policy_ref,default_retention_policy_id,head_rev,created_at) VALUES (?1,?2,'owner-system','owner-gen','immutable_import','document',NULL,?3,'storage-policy','residency-profile','public','license','retention',NULL,?4)").run(sourceId, `namespace-${sourceId}`, `title-${sourceId}`, CREATED_AT);
  db.prepare("INSERT INTO source_revision (source_revision_ref,source_id,source_owner_generation,content_sha256,object_residency_key_digest,original_r2_key,normalized_artifact_ref,captured_at,parser_profile_generation,quality_state,purge_state,currentness_state,source_view_ref,workspace_view_revision_ref,admitted_at) VALUES (?1,?2,'owner-gen',?3,?4,NULL,NULL,?5,NULL,'standard','LIVE','unknown',?6,NULL,?5)").run(revisionRef, sourceId, content, residency, CREATED_AT, `view-${revisionRef}`);
}

export interface ProducedEpoch {
  readonly db: DatabaseSync; readonly id: string; readonly draft: BackupEpochDraft;
  readonly part_bucket: R2Bucket; readonly part_objects: Map<string, StoredObject>;
  readonly failNextDelete: (mode: "before" | "after", key?: string) => void;
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
  const result = await createBackupPort(ports, { limits: { r2_list_page_size: 50, part_bytes: 1024 } }).createPortableEpoch(intent, { now_ms: NOW });
  return {
    db,
    id: result.draft.epoch_id,
    draft: result.draft,
    part_bucket: parts.bucket,
    part_objects: parts.objects,
    failNextDelete: parts.failNextDelete,
  };
}
function erasureRequest(subject: string, erasureId = "erase-backup-recovery"): ErasureRequest {
  return {
    protocol: "erc.privacy.erasure.v1",
    erasure_ref: { id: erasureId, revision: 1 },
    requested_by_principal_ref: "privacy-owner",
    exact_subject_refs: [subject],
    required_locations: ["BackupRestorePath"],
    legal_basis_ref: "delete-request",
    admitted_at: CREATED_AT,
    deadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  };
}

function historicalVerifiedEpoch(epoch: ProducedEpoch): void {
  const manifests = epoch.draft.manifest_digests;
  const values = [
    manifests["schema-inventory"], manifests["rebuild"], manifests["r2-objects"], manifests["r2-objects"],
  ];
  if (values.some((value) => typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))) {
    throw new Error("O2 draft lacks exact content digests for the historical canonical row");
  }
  // This models an already-existing pre-0119 database row only. The fixture
  // does not issue a verification receipt or test a live verification gate.
  epoch.db.prepare(
    "INSERT INTO backup_epoch (backup_epoch_id,core_export_ref,search_projection_manifest_ref," +
      "evidence_manifest_ref,work_manifest_ref,offsite_copy_ref,purge_ledger_revision," +
      "verification_state,created_at,verified_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'VERIFIED',?8,?8)",
  ).run(
    epoch.id,
    `sha256:${values[0]}`,
    `sha256:${values[1]}`,
    `sha256:${values[2]}`,
    `sha256:${values[3]}`,
    `legacy-o4-copy:${epoch.id}`,
    epoch.draft.purge_ledger_revision,
    epoch.draft.created_at,
  );
}

export function caughtErrorSummary(value: unknown): string {
  if (typeof value !== "object" || value === null) return String(value);
  const error = value as { readonly name?: unknown; readonly code?: unknown; readonly retryable?: unknown; readonly message?: unknown; readonly cause?: unknown };
  const cause = error.cause instanceof Error
    ? `${error.cause.name}: ${error.cause.message}`
    : error.cause === undefined ? undefined : String(error.cause);
  return JSON.stringify({ name: error.name, code: error.code, retryable: error.retryable, message: error.message, cause });
}

function testWriterQualificationVerifier(): BackupPrimaryWriterQualificationVerifier {
  return {
    async assertCurrentQualification(
      input: BackupPrimaryWriterQualificationInput,
    ): Promise<BackupPrimaryWriterQualificationReceipt> {
      // The typed receipt is a test double for this external owner/runtime
      // boundary. All producer, cut, prefix, intent, and R2 evidence stays real.
      return {
        protocol: "eliotr.backup-primary-writer-qualification.v1",
        mode: "ISOLATED_NEW_BUCKET",
        operation_receipt_ref: "test-primary-writer-operation",
        operation_receipt_digest: HASH_A,
        admission_binding_ref: "test-owner-admission",
        admission_binding_digest: HASH_B,
        cloudflare_account_ref: "test-cloudflare-account",
        primary_bucket_binding_ref: "BACKUP_PARTS_BUCKET",
        worker_version_ref: "test-worker-version",
        controller_generation: "test-controller-generation",
        controller_fingerprint: HASH_C,
        source_sha256: HASH_A,
        configuration_sha256: HASH_B,
        artifact_sha256: HASH_C,
        bootstrap_zero_state_receipt_ref: "test-bootstrap-zero-state",
        bootstrap_zero_state_digest: HASH_D,
        producer_claims_digest: input.producer_claims_digest,
        export_cut_inventory_digest: input.export_cut_inventory_digest,
        primary_prefix_inventory_digest: input.primary_prefix_inventory_digest,
        evidence_digest: HASH_D,
      };
    },
  };
}

export interface RecoveryFixture {
  readonly epoch: ProducedEpoch;
  readonly database: D1Database;
  readonly request: ErasureRequest;
  readonly authority: ReturnType<typeof createD1ErasureAuthority>;
  readonly inventory: ReturnType<typeof createD1ErasureInventory>;
  readonly location: ReturnType<typeof createBackupErasureLocationPort>;
  readonly backend: ReturnType<typeof createCloudflareErasureBackend>;
  readonly advancePastSharedFenceLeaseExpiry: () => void;
}

export async function createRecoveryFixture(): Promise<RecoveryFixture> {
  const epoch = await produceEpoch("source-recovery", "revision-recovery-1", HASH_A, HASH_B, "recovery-epoch");
  historicalVerifiedEpoch(epoch);
  applyManifestBindingsMigration(epoch.db);
  const database = d1Database(epoch.db);
  let nowMs = Date.now();
  const now = () => nowMs;
  const request = erasureRequest("source-revision:revision-recovery-1");
  const producerQuiescence = createD1BackupProducerQuiescencePort(database);
  const qualification = testWriterQualificationVerifier();
  const offsite: BackupErasurePort = {
    async purge(epochRef, erasureRef, context) {
      return { receipt_ref: await stableErasureId("test-offsite-delete", epochRef, erasureRef, context.target_id) };
    },
    async verifyAbsent(epochRef, erasureRef, context) {
      return {
        absent: true,
        receipt_ref: await stableErasureId("test-offsite-absence", epochRef, erasureRef, context.target_id),
      };
    },
  };
  const authority = createD1ErasureAuthority({
    core_database: database,
    worker_id: "backup-recovery-test",
    lease_ms: 10 * 60_000,
    now,
  });
  const inventory = createD1ErasureInventory({
    core_database: database,
    search_database: database,
    work_bucket: memoryBucket().bucket,
    backup_offsite: offsite,
    backup_primary_qualification: qualification,
    ...physicalInventoryDependencies(database, epoch.part_bucket),
    now,
  });
  const primary = createPrimaryBackupErasurePort({
    database,
    bucket: epoch.part_bucket,
    backup_producer_quiescence: producerQuiescence,
    qualification,
    now,
  });
  const location = createBackupErasureLocationPort({
    database,
    port: composeBackupErasurePort(primary, offsite),
    now,
  });
  const backend = createCloudflareErasureBackend({
    core_database: database,
    authority,
    inventory,
    locations: {
      forLocation(locationName) { return locationName === "BackupRestorePath" ? location : null; },
    },
    invalidation: { async invalidate() { return []; } },
    now,
  });
  function advancePastSharedFenceLeaseExpiry(): void {
    const lease = epoch.db.prepare(
      "SELECT lease_until FROM operation_execution_lease WHERE operation_id=?1",
    ).get("research-erasure-restore-shared-fence-v1") as { readonly lease_until: number } | undefined;
    if (lease === undefined || !Number.isSafeInteger(lease.lease_until)) {
      throw new Error("recovery fixture has no persisted shared execution lease expiry");
    }
    nowMs = Math.max(nowMs, lease.lease_until + 1);
  }
  return { epoch, database, request, authority, inventory, location, backend, advancePastSharedFenceLeaseExpiry };
}

export async function advanceToPrimaryPurge(
  fixture: RecoveryFixture,
  fence: ErasureFence,
): Promise<{ readonly closure: Awaited<ReturnType<RecoveryFixture["inventory"]["enumerate"]>>; readonly target: PurgeTarget }> {
  const { backend, request } = fixture;
  await backend.quarantineAndRevoke(request, fence);
  const closure = await backend.enumerateDependencyClosure(request, fence);
  const blockers = await backend.checkRetentionAndHolds(request, fence, closure);
  await backend.advanceLifecycle(
    request,
    fence,
    "CHECK_RETENTION_AND_HOLDS",
    "PURGE_EACH_LOCATION",
    await erasureDigest({ closure: closure.closure_digest, blockers }),
  );
  const target = closure.targets.find((candidate) => candidate.location === "BackupRestorePath");
  if (target === undefined) throw new Error("recovery fixture omitted its backup target");
  return { closure, target };
}
