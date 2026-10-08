import type { ErasureFence } from "@eliotr/contracts";
import type { BackupPrimaryWriterQualificationInput, BackupPrimaryWriterQualificationReceipt, BackupProducerQuiescencePort } from "@eliotr/cloudflare-erasure";
import { backupSha256Hex, canonicalBackupJson, failBackup, type BackupSourcePorts, createBackupPort, type BackupPort } from "@eliotr/backup-o2";
import { parsePrimaryWriterOperation, parsePrimaryWriterQualification, PRIMARY_WRITER_RESERVED_PREFIX, type PrimaryWriterCurrentAuthority, type PrimaryWriterErasureQualification, type PrimaryWriterQualification, type PrimaryWriterQualificationReadback } from "./primary-writer-qualification.js";

const MAX_PAGES = 128;
const PAGE_SIZE = 1000;
const SHA256 = /^[a-f0-9]{64}$/u;
const PART_METADATA_KEYS = new Set(["backup_epoch", "backup_vector_digest", "backup_manifest", "backup_part_index", "backup_part_sha256", "backup_object_identity_digest", "backup_part_count", "eliotr_sha256", "eliotr_size_bytes", "eliotr_immutable"]);

interface QualificationRow { readonly qualification_json: unknown; readonly qualification_sha256: unknown; }
interface OperationRow {
  readonly operation_ref: unknown; readonly qualification_ref: unknown; readonly qualification_revision: unknown;
  readonly intent_ref: unknown; readonly intent_revision: unknown; readonly intent_json: unknown; readonly intent_sha256: unknown;
  readonly attempt_id: unknown; readonly attempt_number: unknown; readonly attempt_json: unknown; readonly attempt_sha256: unknown;
  readonly receipt_ref: unknown; readonly operation_json: unknown; readonly receipt_json: unknown; readonly receipt_sha256: unknown;
  readonly readback_receipt_ref: unknown; readonly readback_sha256: unknown; readonly state: unknown; readonly created_at: unknown; readonly updated_at: unknown;
}
interface CurrentRow extends PrimaryWriterCurrentAuthority { readonly slot: unknown; }

async function first<T>(database: D1Database, sql: string, values: readonly unknown[] = []): Promise<T | null> {
  try { return await database.prepare(sql).bind(...values).first<T>(); }
  catch (cause) { failBackup("BACKUP_TABLE_MISSING", "primary writer authority read failed", true, {}, cause); }
}

async function all<T>(database: D1Database, sql: string, values: readonly unknown[] = []): Promise<readonly T[]> {
  try {
    const result = await database.prepare(sql).bind(...values).all<T>();
    if (result.success !== true || !Array.isArray(result.results)) failBackup("BACKUP_TABLE_MISSING", "primary writer authority readback is malformed", true);
    return result.results;
  } catch (cause) { failBackup("BACKUP_TABLE_MISSING", "primary writer authority inventory failed", true, {}, cause); }
}

function current(row: CurrentRow | null): PrimaryWriterCurrentAuthority {
  if (row === null || row.slot !== "primary" || typeof row.qualification_ref !== "string" || !Number.isSafeInteger(row.qualification_revision) || typeof row.qualification_sha256 !== "string" || !SHA256.test(row.qualification_sha256) || typeof row.controller_generation !== "string" || !["ACTIVE", "DRAINING", "RETIRED"].includes(row.state) || typeof row.updated_at !== "string") failBackup("BACKUP_VECTOR_UNVERIFIABLE", "primary writer current authority is absent or malformed");
  return row;
}

export async function readCurrentPrimaryWriterQualification(database: D1Database): Promise<PrimaryWriterQualificationReadback> {
  const pointer = current(await first<CurrentRow>(database, "SELECT slot,qualification_ref,qualification_revision,qualification_sha256,controller_generation,state,updated_at FROM backup_primary_writer_current WHERE slot='primary' LIMIT 1"));
  const authority = await first<QualificationRow>(database, "SELECT authority_json AS qualification_json,authority_sha256 AS qualification_sha256 FROM backup_primary_writer_qualification WHERE qualification_ref=?1 AND revision=?2 LIMIT 2", [pointer.qualification_ref, pointer.qualification_revision]);
  if (authority === null || authority.qualification_sha256 !== pointer.qualification_sha256) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "primary writer qualification pointer is stale");
  const qualification = await parsePrimaryWriterQualification({ ...JSON.parse(String(authority.qualification_json)), authority_sha256: authority.qualification_sha256 });
  const operation = await first<OperationRow>(database, "SELECT operation_ref,qualification_ref,qualification_revision,intent_ref,intent_revision,intent_json,intent_sha256,attempt_id,attempt_number,attempt_json,attempt_sha256,receipt_ref,operation_json,receipt_json,receipt_sha256,readback_receipt_ref,readback_sha256,state,created_at,updated_at FROM backup_primary_writer_operation WHERE qualification_ref=?1 AND qualification_revision=?2 AND state='COMMITTED' ORDER BY updated_at DESC LIMIT 2", [qualification.qualification_ref, qualification.revision]);
  if (operation === null) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "primary writer qualification has no committed operation");
  const parsedOperation = await parsePrimaryWriterOperation(operation);
  if (parsedOperation.qualification_ref !== qualification.qualification_ref || parsedOperation.qualification_revision !== qualification.revision) failBackup("BACKUP_INTENT_CONFLICT", "primary writer operation binds another qualification");
  return { qualification, operation: parsedOperation, current: pointer };
}

export async function readPrimaryPrefixProof(bucket: R2Bucket, bindingRef: string, bucketName: string, now = new Date().toISOString()): Promise<{ readonly count: number; readonly digest: string; readonly readback: Record<string, unknown> }> {
  const objects: { key: string; epoch_id: string; manifest: string; part_index: number; part_sha256: string; payload_identity_digest?: string; payload_part_count?: number; size_bytes: number; etag: string; custom_metadata: Record<string, string> }[] = [];
  const objectKeys = new Set<string>();
  let cursor: string | undefined;
  const cursors = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let result: R2Objects;
    try { result = await bucket.list({ prefix: PRIMARY_WRITER_RESERVED_PREFIX, limit: PAGE_SIZE, include: ["customMetadata"], ...(cursor === undefined ? {} : { cursor }) }); }
    catch (cause) { failBackup("BACKUP_OBJECT_UNREADABLE", "primary writer reserved-prefix readback failed", true, {}, cause); }
    for (const object of result.objects) {
      if (typeof object.key !== "string" || !object.key.startsWith(PRIMARY_WRITER_RESERVED_PREFIX) || typeof object.size !== "number" || !Number.isSafeInteger(object.size) || object.size < 0 || typeof object.etag !== "string" || object.etag.length === 0 || typeof object.customMetadata !== "object" || object.customMetadata === null || Array.isArray(object.customMetadata)) failBackup("BACKUP_OBJECT_UNREADABLE", "primary writer prefix object readback is malformed");
      const metadata = object.customMetadata as Record<string, unknown>;
      if (Object.keys(metadata).some((key) => !PART_METADATA_KEYS.has(key)) || Object.keys(metadata).some((key) => typeof metadata[key] !== "string")) failBackup("BACKUP_OBJECT_UNREADABLE", "primary writer prefix metadata is malformed");
      const custom = metadata as Record<string, string>;
      if (objectKeys.has(object.key)) failBackup("BACKUP_OBJECT_UNREADABLE", "primary writer prefix listing contains a duplicate object key", true);
      objectKeys.add(object.key);
      const epoch = custom.backup_epoch;
      const vector = custom.backup_vector_digest;
      const manifest = custom.backup_manifest;
      const index = custom.backup_part_index;
      const partSha = custom.backup_part_sha256;
      if (epoch === undefined || epoch.length === 0 || epoch.length > 256 || vector === undefined || !SHA256.test(vector) || manifest === undefined || manifest.length === 0 || manifest.length > 256 || index === undefined || !/^(?:0|[1-9]\d*)$/u.test(index) || !Number.isSafeInteger(Number(index)) || partSha === undefined || !SHA256.test(partSha) || custom.eliotr_sha256 !== partSha || custom.eliotr_size_bytes !== String(object.size) || custom.eliotr_immutable !== "true") failBackup("BACKUP_OBJECT_UNREADABLE", "primary writer prefix metadata does not contain an exact immutable part pin");
      const payloadIdentity = custom.backup_object_identity_digest;
      const payloadCount = custom.backup_part_count;
      if ((payloadIdentity === undefined) !== (payloadCount === undefined) || (payloadIdentity !== undefined && (!SHA256.test(payloadIdentity) || payloadCount === undefined || !/^(?:0|[1-9]\d*)$/u.test(payloadCount) || !Number.isSafeInteger(Number(payloadCount))))) failBackup("BACKUP_OBJECT_UNREADABLE", "primary writer payload metadata is incomplete");
      objects.push({ key: object.key, epoch_id: epoch, manifest, part_index: Number(index), part_sha256: partSha, ...(payloadIdentity === undefined ? {} : { payload_identity_digest: payloadIdentity, payload_part_count: Number(payloadCount) }), size_bytes: object.size, etag: object.etag, custom_metadata: { ...custom } });
    }
    if (!result.truncated) break;
    if (typeof result.cursor !== "string" || result.cursor.length === 0 || cursors.has(result.cursor)) failBackup("BACKUP_OBJECT_UNREADABLE", "primary writer prefix pagination did not advance", true);
    cursors.add(result.cursor); cursor = result.cursor;
  }
  if (cursor !== undefined && cursors.size >= MAX_PAGES) failBackup("BACKUP_BOUND_EXCEEDED", "primary writer prefix exceeds its readback bound");
  const ordered = objects.sort((a, b) => a.key.localeCompare(b.key));
  const digest = await backupSha256Hex(canonicalBackupJson(ordered));
  return { count: ordered.length, digest, readback: { protocol: "eliotr.backup-primary-prefix-readback.v1", bucket_binding_ref: bindingRef, bucket_name: bucketName, prefix: PRIMARY_WRITER_RESERVED_PREFIX, object_count: ordered.length, inventory_digest: digest, observed_at: now } };
}

export async function assertCurrentPrimaryWriterRuntime(input: {
  readonly database: D1Database;
  readonly bucket: R2Bucket;
  readonly binding_ref: string;
  readonly controller_generation: string;
  readonly version_id: string;
}): Promise<PrimaryWriterQualification> {
  const authority = await readCurrentPrimaryWriterQualification(input.database);
  const q = authority.qualification;
  if (authority.current.state !== "ACTIVE" || q.mode !== "ISOLATED_NEW_BUCKET" || q.erasure_mode !== "NO_ACTIVE_ERASURE" || q.cloudflare.controller_generation !== input.controller_generation || q.cloudflare.version_id !== input.version_id || q.cloudflare.bucket_binding_ref !== input.binding_ref) failBackup("BACKUP_INTENT_CONFLICT", "primary writer runtime authority is not the active isolated bootstrap", true);
  const activeErasure = await first<{ readonly active: number }>(input.database, "SELECT CASE WHEN EXISTS (SELECT 1 FROM erasure_case WHERE state <> 'COMPLETE') OR EXISTS (SELECT 1 FROM erasure_execution WHERE state <> 'COMPLETE') THEN 1 ELSE 0 END AS active");
  if (activeErasure?.active !== 0) failBackup("BACKUP_PURGE_BLOCKED", "primary writer admission is blocked by an active erasure", true);
  return q;
}

export async function assertCurrentPrimaryWriterErasureQualification(input: {
  readonly database: D1Database;
  readonly bucket: R2Bucket;
  readonly binding_ref: string;
  readonly controller_generation: string;
  readonly version_id: string;
  readonly producer_quiescence: BackupProducerQuiescencePort;
  readonly erasure_fence: ErasureFence;
  readonly erasure_request_sha256: string;
}): Promise<PrimaryWriterErasureQualification> {
  const authority = await readCurrentPrimaryWriterQualification(input.database);
  const q = authority.qualification;
  if (authority.current.state !== "ACTIVE" || q.cloudflare.controller_generation !== input.controller_generation || q.cloudflare.version_id !== input.version_id || q.cloudflare.bucket_binding_ref !== input.binding_ref) failBackup("BACKUP_INTENT_CONFLICT", "primary writer erasure qualification is not current", true);
  if (q.erasure_mode === "FENCED" && (q.erasure_fence === undefined || q.erasure_request_sha256 !== input.erasure_request_sha256 || q.erasure_fence.erasure_id !== input.erasure_fence.erasure_id || q.erasure_fence.revision !== input.erasure_fence.revision || q.erasure_fence.lease_owner !== input.erasure_fence.lease_owner || q.erasure_fence.lease_generation !== input.erasure_fence.lease_generation || q.erasure_fence.lease_until_ms !== input.erasure_fence.lease_until_ms)) failBackup("BACKUP_INTENT_CONFLICT", "persisted fenced qualification does not match the current erasure fence", true);
  const fence = await first<{ readonly request_sha256: unknown; readonly state: unknown; readonly lease_owner: unknown; readonly lease_generation: unknown; readonly lease_until: unknown }>(input.database, "SELECT e.request_sha256,e.state,e.lease_owner,e.lease_generation,e.lease_until FROM erasure_execution e WHERE e.erasure_id=?1 AND e.revision=?2 AND e.state IN ('REQUESTED','QUARANTINE_AND_REVOKE','ENUMERATE_DEPENDENCY_CLOSURE','CHECK_RETENTION_AND_HOLDS','PURGE_EACH_LOCATION','VERIFY_ABSENCE_OR_BLOCK','APPEND_PURGE_LEDGER','INVALIDATE_DEPENDENTS') AND e.lease_until>CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) LIMIT 2", [input.erasure_fence.erasure_id, input.erasure_fence.revision]);
  if (fence === null || fence.request_sha256 !== input.erasure_request_sha256 || fence.state === "COMPLETE" || fence.state === "BLOCKED" || fence.lease_owner !== input.erasure_fence.lease_owner || fence.lease_generation !== input.erasure_fence.lease_generation || fence.lease_until !== input.erasure_fence.lease_until_ms) failBackup("BACKUP_PURGE_BLOCKED", "primary writer runtime lacks the exact current erasure fence", true);
  const prefix = await readPrimaryPrefixProof(input.bucket, input.binding_ref, q.cloudflare.bucket_name);
  const cuts = await all<{ readonly cut_id: unknown; readonly cut_digest: unknown; readonly state: unknown }>(input.database, "SELECT cut_id,cut_digest,state FROM backup_export_cut ORDER BY cut_id LIMIT 100001");
  if (cuts.length > 100000) failBackup("BACKUP_BOUND_EXCEEDED", "primary writer runtime inventory exceeds its bound");
  const producer = await input.producer_quiescence.assertQuiescent({ erasure_id: input.erasure_fence.erasure_id, revision: input.erasure_fence.revision });
  const cutDigest = await backupSha256Hex(canonicalBackupJson(cuts));
  const evidence = { protocol: "eliotr.backup-primary-writer-erasure-qualification.v1", qualification_ref: q.qualification_ref, qualification_revision: q.revision, erasure_fence: input.erasure_fence, erasure_request_sha256: input.erasure_request_sha256, operation_ref: authority.operation.operation_ref, intent_ref: authority.operation.intent.intent_ref, intent_sha256: authority.operation.intent_sha256, attempt_id: authority.operation.attempt.attempt_id, attempt_sha256: authority.operation.attempt_sha256, receipt_ref: authority.operation.receipt.receipt_ref, receipt_sha256: authority.operation.receipt_sha256, owner_admission_ref: q.owner_admission_ref, owner_admission_sha256: q.owner_admission_sha256, actual_version_id: q.cloudflare.version_id, controller_generation: q.cloudflare.controller_generation, bucket_binding_ref: q.cloudflare.bucket_binding_ref, bucket_name: q.cloudflare.bucket_name, producer_claim_count: producer.claim_count, producer_claim_digest: producer.claims_digest, export_cut_count: cuts.length, export_cut_digest: cutDigest, primary_prefix_count: prefix.count, primary_prefix_digest: prefix.digest } as const;
  return { ...evidence, evidence_digest: await backupSha256Hex(canonicalBackupJson(evidence)) };
}

/** Adapter for the erasure consumer's typed verifier contract. */
export function createPrimaryWriterQualificationVerifier(input: {
  readonly database: D1Database;
  readonly bucket: R2Bucket;
  readonly binding_ref: string;
  readonly controller_generation: string;
  readonly version_id: string;
  readonly producer_quiescence: BackupProducerQuiescencePort;
}): { assertCurrentQualification(value: BackupPrimaryWriterQualificationInput): Promise<BackupPrimaryWriterQualificationReceipt> } {
  return {
    assertCurrentQualification: async (value) => {
      const current = await assertCurrentPrimaryWriterErasureQualification({
        database: input.database,
        bucket: input.bucket,
        binding_ref: input.binding_ref,
        controller_generation: input.controller_generation,
        version_id: input.version_id,
        producer_quiescence: input.producer_quiescence,
        erasure_fence: value.fence,
        erasure_request_sha256: value.request_sha256,
      });
      if (current.producer_claim_count !== value.producer_claim_count || current.producer_claim_digest !== value.producer_claims_digest ||
          current.export_cut_count !== value.export_cut_count || current.export_cut_digest !== value.export_cut_inventory_digest ||
          current.primary_prefix_count !== value.primary_prefix_object_count || current.primary_prefix_digest !== value.primary_prefix_inventory_digest) {
        failBackup("BACKUP_INTENT_CONFLICT", "primary writer erasure qualification does not match the current consumer inventory", true);
      }
      const authority = await readCurrentPrimaryWriterQualification(input.database);
      const q = authority.qualification;
      const controllerFingerprint = await backupSha256Hex(canonicalBackupJson({
        account_id: q.cloudflare.account_id,
        worker_name: q.cloudflare.worker_name,
        deployment_id: q.cloudflare.deployment_id,
        version_id: q.cloudflare.version_id,
        version_etag: q.cloudflare.version_etag,
        controller_generation: q.cloudflare.controller_generation,
        bucket_binding_ref: q.cloudflare.bucket_binding_ref,
        bucket_name: q.cloudflare.bucket_name,
      }));
      return {
        protocol: "eliotr.backup-primary-writer-qualification.v1",
        mode: q.mode,
        operation_receipt_ref: authority.operation.receipt.receipt_ref.id,
        operation_receipt_digest: authority.operation.receipt_sha256,
        admission_binding_ref: q.owner_admission_ref,
        admission_binding_digest: q.owner_admission_sha256,
        cloudflare_account_ref: q.cloudflare.account_id,
        primary_bucket_binding_ref: q.cloudflare.bucket_binding_ref,
        worker_version_ref: q.cloudflare.version_id,
        controller_generation: q.cloudflare.controller_generation,
        controller_fingerprint: controllerFingerprint,
        source_sha256: q.cloudflare.source_sha256,
        configuration_sha256: q.cloudflare.configuration_sha256,
        artifact_sha256: q.cloudflare.compiled_artifact_sha256,
        bootstrap_zero_state_receipt_ref: q.bootstrap_zero_d1_ref,
        bootstrap_zero_state_digest: await backupSha256Hex(canonicalBackupJson(q.bootstrap_zero_d1)),
        producer_claims_digest: current.producer_claim_digest,
        export_cut_inventory_digest: current.export_cut_digest,
        primary_prefix_inventory_digest: current.primary_prefix_digest,
        evidence_digest: current.evidence_digest,
      };
    },
  };
}

export async function createQualifiedPrimaryBackupPort(input: {
  readonly database: D1Database;
  readonly evidence_bucket: R2Bucket;
  readonly work_bucket: R2Bucket;
  readonly part_sink: BackupSourcePorts["part_sink"];
  readonly bucket: R2Bucket;
  readonly binding_ref: string;
  readonly controller_generation: string;
  readonly version_id: string;
}): Promise<BackupPort> {
  await assertCurrentPrimaryWriterRuntime({ database: input.database, bucket: input.bucket, binding_ref: input.binding_ref, controller_generation: input.controller_generation, version_id: input.version_id });
  return createBackupPort({ core_db: input.database, evidence_bucket: input.evidence_bucket, work_bucket: input.work_bucket, part_sink: input.part_sink });
}
