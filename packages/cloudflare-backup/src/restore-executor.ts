import type { OperationIntent } from "@eliotr/contracts";
import {
  BACKUP_R2_PAYLOAD_PROTOCOL, TABLE_SPECS, backupR2ObjectIdentity, backupSha256Hex, canonicalBackupJson,
  failBackup, normalizeBackupR2CustomMetadata, normalizeBackupR2HttpMetadata, openOffsiteBackupPart,
  type BackupEpochDraft,
  type VerifiedPortableBackupManifests,
} from "@eliotr/backup-o2";
import type {
  IsolatedRestorePreflight, IsolatedRestorePreflightInput,
} from "./isolated-restore-preflight.js";
import { verifyIsolatedRestorePreflight } from "./isolated-restore-preflight.js";
import type { BackupRestoreIntentBinding } from "./restore-store.js";
import type { BackupRestoreStore, BackupRestoreReceipt } from "./restore-store.js";
import type { SharedExecutionFence } from "@eliotr/cloudflare-erasure";

const LIMITS = { max_rows: 100_000, max_object_bytes: 64 * 1024 * 1024, max_total_bytes: 1024 * 1024 * 1024, rows_per_batch: 40 } as const;
const SHA256 = /^[a-f0-9]{64}$/u;
const PURGE_COLUMNS = ["ledger_revision", "erasure_id", "non_revealing_subject_digest", "disposition", "receipt_ref", "created_at"] as const;

export type RestoreBackupObligationAttestation =
  | {
    readonly kind: "BACKUP_PURGE";
    readonly erasure_id: string;
    readonly erasure_revision: number;
    readonly backup_epoch_id: string;
    readonly target_id: string;
    readonly state: "ABSENT" | "BLOCKED" | "PENDING";
    readonly delete_receipt_ref: string | null;
    readonly absence_receipt_ref: string | null;
    readonly policy_or_hold_ref: string | null;
  }
  | {
    readonly kind: "OFFSITE_REPLAY";
    readonly erasure_id: string;
    readonly erasure_revision: number;
    readonly backup_epoch_id: string;
    readonly target_id: string;
    readonly copy_id: string;
    readonly expiry_intent_key: string;
    readonly state: "BLOCKED" | "DELETED" | "PENDING";
    readonly reason_code: string | null;
    readonly receipt_sha256: string | null;
  };

export interface RestoreErasureFence {
  readonly state: "ACQUIRED";
  readonly epoch_id: string;
  readonly purge_ledger_revision: number;
  readonly purge_ledger_digest: string;
  readonly epoch_subject_scope_digest: string;
  readonly obligation_inventory_digest: string;
  readonly terminal_erasure_targets_verified: boolean;
  readonly backup_obligations_verified: boolean;
  readonly unsettled_erasure_count: number;
  readonly backup_obligations: readonly RestoreBackupObligationAttestation[];
  /** D1 lease identity passed into the atomic ADMITTED -> ATTEMPTING transition. */
  readonly shared_execution_fence: SharedExecutionFence;
  /** This durable exclusion must also be respected by every O4 erasure start path. */
  assertCurrent(): Promise<void>;
  release(): Promise<void>;
}

export interface RestoreErasureGate {
  acquire(input: {
    readonly primary_database: D1Database;
    readonly draft: BackupEpochDraft;
    readonly current_purge: IsolatedRestorePreflight["current_purge"];
    readonly manifests: VerifiedPortableBackupManifests;
    readonly target: IsolatedRestorePreflight["target"];
    readonly signal?: AbortSignal;
  }): Promise<RestoreErasureFence>;
}

export interface ExecuteIsolatedRestoreInput {
  readonly intent: OperationIntent;
  readonly preflight: IsolatedRestorePreflightInput;
  readonly erasure_gate: RestoreErasureGate;
  readonly restore_store: BackupRestoreStore;
  readonly signal?: AbortSignal;
}

export interface IsolatedRestoreExecutionResult {
  readonly state: "RESTORED_UNQUALIFIED";
  readonly receipt: BackupRestoreReceipt;
  readonly traffic_ready: false;
}

interface R2InventoryEntry extends Readonly<Record<string, unknown>> {
  readonly bucket: "evidence" | "work";
  readonly key: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly custom_metadata: Readonly<Record<string, string>>;
  readonly http_metadata: Readonly<Record<string, string>>;
  readonly payload_parts: readonly { readonly index: number; readonly sha256: string; readonly size_bytes: number }[];
}

interface CoreRestoreTable {
  readonly table: string;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly columns: readonly string[];
  readonly order_by: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted === true) failBackup("BACKUP_CANCELLED", "isolated restore was cancelled", true);
}

function restoreBinding(intent: OperationIntent, preflight: IsolatedRestorePreflight): BackupRestoreIntentBinding {
  return { intent, epoch_id: preflight.draft.epoch_id, offsite_copy_ref: preflight.copy_ref, target: preflight.target };
}

function assertFence(fence: RestoreErasureFence, preflight: IsolatedRestorePreflight): void {
  if (fence.state !== "ACQUIRED" || fence.epoch_id !== preflight.draft.epoch_id ||
      fence.purge_ledger_revision !== preflight.current_purge.revision || fence.purge_ledger_digest !== preflight.current_purge.digest ||
      fence.purge_ledger_revision !== preflight.draft.purge_ledger_revision || fence.purge_ledger_digest !== preflight.draft.purge_ledger_digest ||
      !SHA256.test(fence.epoch_subject_scope_digest) || !SHA256.test(fence.obligation_inventory_digest) ||
      fence.terminal_erasure_targets_verified !== true || fence.backup_obligations_verified !== true ||
      fence.unsettled_erasure_count !== 0 || !Array.isArray(fence.backup_obligations) ||
      fence.shared_execution_fence?.kind !== "RESTORE" ||
      typeof fence.shared_execution_fence.operation_id !== "string" ||
      typeof fence.shared_execution_fence.lease_owner !== "string" ||
      !Number.isSafeInteger(fence.shared_execution_fence.lease_generation) || fence.shared_execution_fence.lease_generation < 1) {
    failBackup("BACKUP_PURGE_BLOCKED", "current purge, terminal-target, or backup-obligation reconciliation does not authorize restore");
  }
  for (const obligation of fence.backup_obligations) {
    if (obligation.backup_epoch_id !== preflight.draft.epoch_id ||
        typeof obligation.erasure_id !== "string" || obligation.erasure_id.length === 0 ||
        !Number.isSafeInteger(obligation.erasure_revision) || obligation.erasure_revision < 1 ||
        typeof obligation.target_id !== "string" || obligation.target_id.length === 0) {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", "restore fence contains an obligation outside the exact epoch or with malformed identity");
    }
    if (obligation.kind === "BACKUP_PURGE") {
      if ((obligation.state !== "PENDING" && obligation.state !== "BLOCKED" && obligation.state !== "ABSENT") ||
          (obligation.delete_receipt_ref !== null && (typeof obligation.delete_receipt_ref !== "string" || obligation.delete_receipt_ref.length === 0)) ||
          (obligation.absence_receipt_ref !== null && (typeof obligation.absence_receipt_ref !== "string" || obligation.absence_receipt_ref.length === 0)) ||
          (obligation.policy_or_hold_ref !== null && (typeof obligation.policy_or_hold_ref !== "string" || obligation.policy_or_hold_ref.length === 0)) ||
          (obligation.state === "ABSENT" && (obligation.delete_receipt_ref === null || obligation.absence_receipt_ref === null)) ||
          (obligation.state === "PENDING" && obligation.absence_receipt_ref !== null)) {
        failBackup("BACKUP_VECTOR_UNVERIFIABLE", "restore fence contains a malformed O4 backup purge obligation");
      }
    } else if (obligation.kind === "OFFSITE_REPLAY") {
      if (typeof obligation.copy_id !== "string" || obligation.copy_id.length === 0 ||
          typeof obligation.expiry_intent_key !== "string" || obligation.expiry_intent_key.length === 0 ||
          (obligation.state !== "PENDING" && obligation.state !== "BLOCKED" && obligation.state !== "DELETED") ||
          (obligation.reason_code !== null && (typeof obligation.reason_code !== "string" || obligation.reason_code.length === 0)) ||
          (obligation.receipt_sha256 !== null && !SHA256.test(obligation.receipt_sha256)) ||
          (obligation.state === "DELETED" && obligation.receipt_sha256 === null) ||
          (obligation.state === "PENDING" && (obligation.reason_code !== null || obligation.receipt_sha256 !== null)) ||
          (obligation.state === "BLOCKED" && obligation.reason_code === null) ||
          (obligation.state === "DELETED" && obligation.reason_code !== null)) {
        failBackup("BACKUP_VECTOR_UNVERIFIABLE", "restore fence contains a malformed offsite replay obligation");
      }
    } else {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", "restore fence contains an unknown obligation kind");
    }
  }
  // An epoch named by an O4 obligation is already selected for erasure. A
  // terminal absence receipt does not grant permission to resurrect that copy.
  if (fence.backup_obligations.length !== 0) {
    failBackup("BACKUP_PURGE_BLOCKED", "the selected backup epoch has an O4 purge obligation and cannot be restored");
  }
}

function valueMatches(kind: string, value: unknown): boolean {
  if (value === null) return kind.endsWith("-or-null");
  if (kind.startsWith("text")) return typeof value === "string";
  if (kind.startsWith("int")) return typeof value === "number" && Number.isSafeInteger(value);
  if (kind.startsWith("real")) return typeof value === "number" && Number.isFinite(value);
  return false;
}

function planCoreRestore(preflight: IsolatedRestorePreflight): readonly CoreRestoreTable[] {
  const sourceRows = preflight.manifests.source_rows;
  if (sourceRows.length > LIMITS.max_rows) failBackup("BACKUP_BOUND_EXCEEDED", "isolated restore Core row count exceeds its bound");
  const present = new Set(preflight.schema_inventory.map((entry) => entry.table));
  const seen = new Set<string>();
  const plan: CoreRestoreTable[] = [];
  for (const spec of TABLE_SPECS) {
    if (seen.has(spec.table)) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "restore table specification contains a duplicate table");
    seen.add(spec.table);
    const rows = sourceRows.filter((entry) => entry.table === spec.table).map((entry) => entry.row);
    if (rows.length > 0 && !present.has(spec.table)) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "restore manifest has rows for a table absent from the exact target schema", false, { table: spec.table });
    const columns = Object.keys(spec.columns);
    for (const row of rows) {
      if (canonicalBackupJson(Object.keys(row).sort()) !== canonicalBackupJson([...columns].sort()) ||
          columns.some((column) => !valueMatches(spec.columns[column] ?? "", row[column]))) {
        failBackup("BACKUP_VECTOR_UNVERIFIABLE", "restore row columns or value kinds differ from the exact Core table schema", false, { table: spec.table });
      }
    }
    if (rows.length > 0) plan.push({ table: spec.table, rows, columns, order_by: spec.order_by });
  }

  const purgeRows = sourceRows.filter((entry) => entry.table === "purge_ledger").map((entry) => entry.row);
  const orderedPurge = [...purgeRows].sort((left, right) => Number(left["ledger_revision"]) - Number(right["ledger_revision"]));
  if (canonicalBackupJson(orderedPurge) !== canonicalBackupJson(preflight.manifests.purge_ledger)) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "restore purge rows differ from the separately verified purge ledger");
  for (const row of purgeRows) {
    if (canonicalBackupJson(Object.keys(row).sort()) !== canonicalBackupJson([...PURGE_COLUMNS].sort()) ||
        !Number.isSafeInteger(row["ledger_revision"]) || typeof row["erasure_id"] !== "string" ||
        !SHA256.test(String(row["non_revealing_subject_digest"] ?? "")) ||
        (row["disposition"] !== "COMPLETE" && row["disposition"] !== "BLOCKED") ||
        typeof row["receipt_ref"] !== "string" || typeof row["created_at"] !== "string") {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", "restore purge row is malformed");
    }
  }
  if (purgeRows.length > 0) plan.push({ table: "purge_ledger", rows: orderedPurge, columns: PURGE_COLUMNS, order_by: "ledger_revision" });
  return plan;
}

function validateR2Entries(manifests: VerifiedPortableBackupManifests): readonly R2InventoryEntry[] {
  if (!manifests.payload_supported) failBackup("BACKUP_PAYLOAD_UNSUPPORTED", "legacy R2 inventory cannot be restored");
  const entries: R2InventoryEntry[] = [];
  let totalBytes = 0;
  for (const value of manifests.r2_objects) {
    if (!isRecord(value) || value["payload_protocol"] !== BACKUP_R2_PAYLOAD_PROTOCOL ||
        (value["bucket"] !== "evidence" && value["bucket"] !== "work") || typeof value["key"] !== "string" ||
        !Number.isSafeInteger(value["size_bytes"]) || (value["size_bytes"] as number) < 0 ||
        (value["size_bytes"] as number) > LIMITS.max_object_bytes || !SHA256.test(String(value["sha256"] ?? "")) ||
        !isRecord(value["custom_metadata"]) || !isRecord(value["http_metadata"]) || !Array.isArray(value["payload_parts"])) {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", "restore R2 inventory row is malformed or exceeds its bound");
    }
    totalBytes += value["size_bytes"] as number;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > LIMITS.max_total_bytes) failBackup("BACKUP_BOUND_EXCEEDED", "restore R2 payload inventory exceeds its total byte bound");
    entries.push(value as unknown as R2InventoryEntry);
  }
  if (entries.length > LIMITS.max_rows) failBackup("BACKUP_BOUND_EXCEEDED", "restore R2 inventory exceeds its row bound");
  return entries;
}

async function authenticatedPayloadParts(input: {
  readonly draft: BackupEpochDraft;
  readonly entry: R2InventoryEntry;
  readonly verified: IsolatedRestorePreflight;
  readonly preflight: IsolatedRestorePreflightInput;
  readonly signal?: AbortSignal;
}): Promise<Uint8Array[]> {
  const identity = await backupR2ObjectIdentity(input.entry as never);
  const refs = input.draft.payload_part_index?.filter((part) => part.object_identity_digest === identity) ?? [];
  if (refs.length !== input.entry.payload_parts.length || refs.length === 0) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "restore payload parts do not bind to the exact R2 inventory object");
  const byIndex = new Map(refs.map((part) => [part.index, part]));
  const bytes: Uint8Array[] = [];
  let size = 0;
  for (const expected of input.entry.payload_parts) {
    abortIfNeeded(input.signal);
    const ref = byIndex.get(expected.index);
    if (ref === undefined || ref.count !== refs.length || ref.sha256 !== expected.sha256 || ref.size_bytes !== expected.size_bytes) {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", "restore payload part sequence diverges from the exact R2 object inventory");
    }
    const plaintext = await openOffsiteBackupPart({
      draft: input.draft, part: ref, encryption_key: input.preflight.encryption_key,
      destination_policy: input.verified.offsite_authority.destination_policy,
      authority: input.verified.offsite_authority.read_authority, adapter: input.preflight.offsite,
    });
    if (plaintext.byteLength !== expected.size_bytes || await backupSha256Hex(plaintext) !== expected.sha256) failBackup("BACKUP_PART_READBACK_MISMATCH", "restore payload chunk failed exact authentication");
    bytes.push(plaintext);
    size += plaintext.byteLength;
  }
  if (size !== input.entry.size_bytes) failBackup("BACKUP_PART_READBACK_MISMATCH", "restore payload parts do not cover the exact R2 object size");
  return bytes;
}

function payloadStream(parts: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({ pull(controller) {
    const next = parts[index];
    if (next === undefined) { controller.close(); return; }
    controller.enqueue(next);
    index += 1;
  } });
}

function httpMetadataForR2(metadata: Readonly<Record<string, string>>): Record<string, string | Date> {
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, key === "cacheExpiry" ? new Date(value) : value]));
}

async function restoreCoreRows(database: D1Database, plan: readonly CoreRestoreTable[], fence: RestoreErasureFence, markWriteStarted: () => void, signal?: AbortSignal): Promise<{ readonly count: number; readonly digest: string }> {
  const readbackDigests: string[] = [];
  let count = 0;
  for (const table of plan) {
    const selectedColumns = table.columns.map((column) => "\"" + column + "\"").join(",");
    const placeholders = table.columns.map(() => "?").join(",");
    const sql = "INSERT INTO \"" + table.table + "\" (" + selectedColumns + ") VALUES (" + placeholders + ")";
    for (let offset = 0; offset < table.rows.length; offset += LIMITS.rows_per_batch) {
      abortIfNeeded(signal);
      await fence.assertCurrent();
      const rows = table.rows.slice(offset, offset + LIMITS.rows_per_batch);
      const statements = rows.map((row) => database.prepare(sql).bind(...table.columns.map((column) => row[column])));
      markWriteStarted();
      let results: D1Result[];
      try { results = await database.batch(statements); }
      catch (cause) { failBackup("BACKUP_RESTORE_UNCERTAIN", "restore Core row batch did not settle", true, { table: table.table }, cause); }
      if (!Array.isArray(results) || results.length !== statements.length || results.some((result) => result?.success !== true)) failBackup("BACKUP_RESTORE_UNCERTAIN", "restore Core row batch returned unsuccessful results", true, { table: table.table });
      await fence.assertCurrent();
      count += rows.length;
    }

    let result: D1Result<Record<string, unknown>>;
    try { result = await database.prepare("SELECT " + selectedColumns + " FROM \"" + table.table + "\" ORDER BY " + table.order_by + " LIMIT ?1").bind(LIMITS.max_rows + 1).all<Record<string, unknown>>(); }
    catch (cause) { failBackup("BACKUP_RESTORE_UNCERTAIN", "restore Core row readback is unavailable", true, { table: table.table }, cause); }
    if (result.success !== true || !Array.isArray(result.results) || result.results.length !== table.rows.length ||
        result.results.some((row) => canonicalBackupJson(Object.keys(row).sort()) !== canonicalBackupJson([...table.columns].sort()))) {
      failBackup("BACKUP_RESTORE_UNCERTAIN", "restore Core row readback count or columns diverge", true, { table: table.table });
    }
    const expected = table.rows.map(canonicalBackupJson).sort();
    const actual = result.results.map(canonicalBackupJson).sort();
    if (expected.some((line, index) => line !== actual[index])) failBackup("BACKUP_RESTORE_UNCERTAIN", "restore Core row readback bytes diverge", true, { table: table.table });
    await fence.assertCurrent();
    readbackDigests.push(table.table + ":" + await backupSha256Hex(expected.join("\n")));
  }
  return { count, digest: await backupSha256Hex(readbackDigests.join("\n")) };
}

async function verifyR2ObjectReadback(bucket: R2Bucket, entry: R2InventoryEntry): Promise<string> {
  let object: R2ObjectBody | null;
  try { object = await bucket.get(entry.key); }
  catch (cause) { failBackup("BACKUP_OBJECT_UNREADABLE", "restore target R2 readback is unavailable", true, { bucket: entry.bucket }, cause); }
  if (object === null || object.size !== entry.size_bytes) failBackup("BACKUP_PART_READBACK_MISMATCH", "restore target R2 object is missing or has a divergent size", false, { bucket: entry.bucket });
  const custom = normalizeBackupR2CustomMetadata(object.customMetadata, entry.bucket);
  const http = normalizeBackupR2HttpMetadata((object as unknown as { readonly httpMetadata?: unknown }).httpMetadata, entry.bucket);
  if (canonicalBackupJson(custom) !== canonicalBackupJson(entry.custom_metadata) || canonicalBackupJson(http) !== canonicalBackupJson(entry.http_metadata)) failBackup("BACKUP_PART_READBACK_MISMATCH", "restore target R2 metadata diverges from its exact inventory", false, { bucket: entry.bucket });

  const reader = object.body.getReader();
  let carry: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let carryOffset = 0;
  let ended = false;
  const readPart = async (size: number): Promise<Uint8Array> => {
    const result = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      if (carryOffset >= carry.byteLength) {
        const next = await reader.read();
        if (next.done) { ended = true; failBackup("BACKUP_PART_READBACK_MISMATCH", "restore target R2 object is truncated"); }
        if (!(next.value instanceof Uint8Array)) failBackup("BACKUP_OBJECT_UNREADABLE", "restore target R2 stream yielded a non-byte chunk");
        carry = next.value;
        carryOffset = 0;
        if (carry.byteLength === 0) continue;
      }
      const length = Math.min(size - offset, carry.byteLength - carryOffset);
      result.set(carry.subarray(carryOffset, carryOffset + length), offset);
      carryOffset += length;
      offset += length;
    }
    return result;
  };
  const digests: string[] = [];
  try {
    for (const part of entry.payload_parts) {
      const bytes = await readPart(part.size_bytes);
      const digest = await backupSha256Hex(bytes);
      if (digest !== part.sha256) failBackup("BACKUP_PART_READBACK_MISMATCH", "restore target R2 chunk digest diverges from the authenticated inventory");
      digests.push(digest);
    }
    if (carryOffset < carry.byteLength && carry.subarray(carryOffset).some((byte) => byte !== 0)) failBackup("BACKUP_PART_READBACK_MISMATCH", "restore target R2 object has trailing bytes");
    while (!ended) {
      const next = await reader.read();
      if (next.done) { ended = true; break; }
      if (!(next.value instanceof Uint8Array) || next.value.some((byte) => byte !== 0)) failBackup("BACKUP_PART_READBACK_MISMATCH", "restore target R2 object has trailing bytes");
    }
  } finally { reader.releaseLock(); }
  return backupSha256Hex(canonicalBackupJson({ bucket: entry.bucket, key: entry.key, size_bytes: entry.size_bytes,
    sha256: entry.sha256, chunk_digests: digests, custom_metadata: custom, http_metadata: http }));
}

async function restoreR2Objects(input: {
  readonly preflightInput: IsolatedRestorePreflightInput;
  readonly verified: IsolatedRestorePreflight;
  readonly entries: readonly R2InventoryEntry[];
  readonly fence: RestoreErasureFence;
  readonly signal?: AbortSignal;
  readonly markWriteStarted: () => void;
}): Promise<{ readonly count: number; readonly bytes: number; readonly digest: string }> {
  const digests: string[] = [];
  let total = 0;
  for (const entry of input.entries) {
    abortIfNeeded(input.signal);
    const parts = await authenticatedPayloadParts({ draft: input.verified.draft, entry, verified: input.verified, preflight: input.preflightInput,
      ...(input.signal === undefined ? {} : { signal: input.signal }) });
    const bucket = entry.bucket === "evidence" ? input.preflightInput.target.evidence_bucket : input.preflightInput.target.work_bucket;
    const custom = normalizeBackupR2CustomMetadata(entry.custom_metadata, entry.bucket);
    const http = normalizeBackupR2HttpMetadata(entry.http_metadata, entry.bucket);
    await input.fence.assertCurrent();
    input.markWriteStarted();
    let putAcknowledged = false;
    try {
      await bucket.put(entry.key, payloadStream(parts), { customMetadata: { ...custom }, httpMetadata: httpMetadataForR2(http) });
      putAcknowledged = true;
      await input.fence.assertCurrent();
      const digest = await verifyR2ObjectReadback(bucket, entry);
      await input.fence.assertCurrent();
      digests.push(digest);
    } catch (cause) {
      if (putAcknowledged) {
        // The isolated target was proven empty before restore. If authority is
        // lost after an acknowledged PUT, remove this exact late object and
        // require exact absence readback. The durable restore attempt remains
        // UNKNOWN so O4 cannot proceed until reconciliation closes it.
        try {
          await bucket.delete(entry.key);
          const lateObject = await bucket.get(entry.key);
          if (lateObject !== null) failBackup("BACKUP_RESTORE_UNCERTAIN", "late restore object remains after exact-key compensation", true, { bucket: entry.bucket });
        } catch (cleanupCause) {
          failBackup("BACKUP_RESTORE_UNCERTAIN", "late restore object could not be proven absent after fence loss", true, { bucket: entry.bucket }, cleanupCause);
        }
      }
      if (cause !== null && typeof cause === "object" && "code" in cause) throw cause;
      failBackup("BACKUP_RESTORE_UNCERTAIN", "restore R2 payload write or readback did not settle", true, { bucket: entry.bucket }, cause);
    } finally {
      parts.length = 0;
    }
    total += entry.size_bytes;
  }
  return { count: input.entries.length, bytes: total, digest: await backupSha256Hex(digests.join("\n")) };
}

/**
 * Executes a one-shot, isolated data restore under a durable O4-shared
 * erasure exclusion. It never rebuilds projections or authorizes traffic.
 */
export async function executeIsolatedBackupRestore(input: ExecuteIsolatedRestoreInput): Promise<IsolatedRestoreExecutionResult> {
  if (input.intent.operation_kind !== "RESTORE_VERIFY") failBackup("BACKUP_INPUT_INVALID", "isolated restore requires a RESTORE_VERIFY intent");
  const preflightInput = { ...input.preflight, ...(input.signal === undefined ? {} : { signal: input.signal }) };
  const initial = await verifyIsolatedRestorePreflight(preflightInput);
  const corePlan = planCoreRestore(initial);
  const r2Entries = validateR2Entries(initial.manifests);
  const fence = await input.erasure_gate.acquire({
    primary_database: input.preflight.primary.db, draft: initial.draft, current_purge: initial.current_purge,
    manifests: initial.manifests, target: initial.target, ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  try {
    assertFence(fence, initial);
    await fence.assertCurrent();
    const binding = restoreBinding(input.intent, initial);
    const claim = await input.restore_store.claim(binding);
    if (claim.state === "REPLAY") return { state: "RESTORED_UNQUALIFIED", receipt: claim.receipt, traffic_ready: false };

    // Current copy, admission, target isolation, schemas and manifests are
    // rechecked after the O4 exclusion has been acquired and before writes.
    const latest = await verifyIsolatedRestorePreflight(preflightInput);
    if (latest.copy_ref !== initial.copy_ref || latest.draft.epoch_id !== initial.draft.epoch_id ||
        canonicalBackupJson(latest.target) !== canonicalBackupJson(initial.target) ||
        latest.current_purge.revision !== initial.current_purge.revision || latest.current_purge.digest !== initial.current_purge.digest ||
        canonicalBackupJson(latest.manifests.source_rows) !== canonicalBackupJson(initial.manifests.source_rows) ||
        canonicalBackupJson(latest.manifests.r2_objects) !== canonicalBackupJson(initial.manifests.r2_objects)) {
      failBackup("BACKUP_VECTOR_DRIFT", "restore authority or payload inventory changed before target writes", true);
    }
    assertFence(fence, latest);
    await fence.assertCurrent();
    const attempt = await input.restore_store.beginAttempt(claim, binding, fence.shared_execution_fence);
    let writesStarted = false;
    const markWriteStarted = (): void => { writesStarted = true; };
    try {
      const core = await restoreCoreRows(input.preflight.target.db, corePlan, fence, markWriteStarted, input.signal);
      const r2 = await restoreR2Objects({ preflightInput, verified: initial, entries: r2Entries, fence, markWriteStarted,
        ...(input.signal === undefined ? {} : { signal: input.signal }) });
      await fence.assertCurrent();
      const readbackDigest = await backupSha256Hex(canonicalBackupJson({
        epoch_id: initial.draft.epoch_id, offsite_copy_ref: initial.copy_ref,
        purge_revision: initial.current_purge.revision, purge_digest: initial.current_purge.digest,
        core_row_count: core.count, core_digest: core.digest,
        r2_object_count: r2.count, r2_byte_count: r2.bytes, r2_digest: r2.digest,
        epoch_subject_scope_digest: fence.epoch_subject_scope_digest,
        obligation_inventory_digest: fence.obligation_inventory_digest,
      }));
      const receipt = await input.restore_store.complete(attempt, binding, {
        applied_purge_ledger_revision: initial.current_purge.revision,
        applied_purge_ledger_digest: initial.current_purge.digest,
        restored_core_row_count: core.count, restored_r2_object_count: r2.count,
        restored_r2_byte_count: r2.bytes, readback_digest: readbackDigest,
      });
      return { state: "RESTORED_UNQUALIFIED", receipt, traffic_ready: false };
    } catch (cause) {
      const errorCode = cause !== null && typeof cause === "object" && "code" in cause
        ? String((cause as { readonly code: unknown }).code) : "BACKUP_RESTORE_UNCERTAIN";
      if (writesStarted) await input.restore_store.markUnknown(attempt, errorCode).catch(() => undefined);
      else await input.restore_store.markFailed(attempt, errorCode).catch(() => undefined);
      throw cause;
    }
  } finally {
    await fence.release();
  }
}
