import { OperationIntentSchema, type OperationIntent } from "@eliotr/contracts";
import { backupSha256Hex, canonicalBackupJson, failBackup } from "@eliotr/backup-o2";
import type { SharedExecutionFence } from "@eliotr/cloudflare-erasure";
import {
  digestNativeHistoryRestoreReadback,
  validateNativeHistoryArchiveSummary,
} from "./restore-native-history.js";
import type { NativeHistoryArchiveSourceContext, NativeHistoryArchiveSummary } from "./restore-native-history.js";
import { assertCurrentRestoreAdmissionBinding, type RestoreAdmissionBinding } from "./restore-admission.js";

const SHA256 = /^[a-f0-9]{64}$/u;

export interface BackupRestoreTargetBinding {
  readonly account_id: string;
  readonly failure_domain: string;
  readonly environment_ref: string;
  readonly deployment_ref: string;
  readonly configuration_sha256: string;
  readonly resources: {
    readonly core_database: string;
    readonly evidence_bucket: string;
    readonly work_bucket: string;
  };
}

export interface BackupRestoreBaseIntentBinding {
  readonly intent: OperationIntent;
  readonly epoch_id: string;
  readonly offsite_copy_ref: string;
  readonly target: BackupRestoreTargetBinding;
}

export interface BackupRestoreIntentBinding extends BackupRestoreBaseIntentBinding {
  readonly admission: RestoreAdmissionBinding;
}

export interface BackupRestoreAttempt {
  readonly restore_id: string;
  readonly attempt_number: 1;
  readonly attempt_id: string;
  readonly intent_digest: string;
  readonly started_at: string;
}

interface BackupRestoreReceiptBase {
  readonly restore_id: string;
  readonly receipt_id: string;
  readonly attempt_id: string;
  readonly intent_ref: OperationIntent["intent_ref"];
  readonly epoch_id: string;
  readonly offsite_copy_ref: string;
  readonly target_environment_ref: string;
  readonly applied_purge_ledger_revision: number;
  readonly applied_purge_ledger_digest: string;
  readonly restored_core_row_count: number;
  readonly restored_r2_object_count: number;
  readonly restored_r2_byte_count: number;
  readonly readback_digest: string;
  readonly state: "RESTORED_UNQUALIFIED";
  readonly traffic_ready: false;
  readonly unresolved_acceptance: readonly [
    "HANDLE_LIVE_REDACTED_ACCEPTANCE",
    "EXACT_RESTORE_ACCEPTANCE",
    "HIGH_RECALL_RESTORE_ACCEPTANCE",
    "ERASURE_RESTORE_ACCEPTANCE",
    "PROJECTION_REBUILD_ACCEPTANCE",
  ];
  readonly issued_at: string;
}

export interface BackupRestoreReceiptV1 extends BackupRestoreReceiptBase {
  readonly protocol: "eliotr.backup-restore.v1";
}

export interface BackupRestoreReceiptV2 extends BackupRestoreReceiptBase {
  readonly protocol: "eliotr.backup-restore.v2";
  readonly base_readback_digest: string;
  readonly target_readback_digest: string;
  readonly native_history_archive: NativeHistoryArchiveSummary;
}

export type BackupRestoreReceipt = BackupRestoreReceiptV1 | BackupRestoreReceiptV2;

type BackupRestoreReceiptResult = Omit<BackupRestoreReceiptV2,
  "protocol" | "restore_id" | "receipt_id" | "attempt_id" | "intent_ref" | "epoch_id" | "offsite_copy_ref" | "target_environment_ref" | "state" | "traffic_ready" | "unresolved_acceptance" | "issued_at">;

export type BackupRestoreClaim =
  | { readonly state: "READY"; readonly restore_id: string; readonly intent_digest: string }
  | { readonly state: "REPLAY"; readonly restore_id: string; readonly intent_digest: string; readonly receipt: BackupRestoreReceipt };

export interface BackupRestoreStore {
  claim(binding: BackupRestoreIntentBinding, now_ms?: number, archive_source?: NativeHistoryArchiveSourceContext): Promise<BackupRestoreClaim>;
  beginAttempt(claim: Extract<BackupRestoreClaim, { readonly state: "READY" }>, binding: BackupRestoreIntentBinding, fence: SharedExecutionFence, now_ms?: number): Promise<BackupRestoreAttempt>;
  markFailed(attempt: BackupRestoreAttempt, error_code: string, now_ms?: number): Promise<void>;
  markUnknown(attempt: BackupRestoreAttempt, error_code: string, now_ms?: number): Promise<void>;
  complete(attempt: BackupRestoreAttempt, binding: BackupRestoreIntentBinding, result: BackupRestoreReceiptResult,
    now_ms?: number, archive_source?: NativeHistoryArchiveSourceContext): Promise<BackupRestoreReceipt>;
}

interface IntentRow {
  readonly restore_id: unknown;
  readonly principal_ref: unknown;
  readonly idempotency_key: unknown;
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly intent_digest: unknown;
  readonly epoch_id: unknown;
  readonly offsite_copy_ref: unknown;
  readonly target_binding_json: unknown;
  readonly state: unknown;
}

interface ReceiptRow { readonly receipt_json: unknown; readonly receipt_digest: unknown; }

function timestamp(nowMs: number): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 253_402_300_799_999) failBackup("BACKUP_INPUT_INVALID", "backup restore timestamp is invalid");
  return new Date(nowMs).toISOString();
}

function validateBaseBinding(binding: BackupRestoreBaseIntentBinding): BackupRestoreBaseIntentBinding {
  const intent = OperationIntentSchema.safeParse(binding.intent);
  if (!intent.success || intent.data.operation_kind !== "RESTORE_VERIFY") failBackup("BACKUP_INPUT_INVALID", "backup restore requires a valid RESTORE_VERIFY intent");
  const safe = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value);
  if (!safe(binding.epoch_id) || !safe(binding.offsite_copy_ref) ||
      !safe(binding.target.account_id) || !safe(binding.target.failure_domain) || !safe(binding.target.environment_ref) ||
      !safe(binding.target.deployment_ref) || !SHA256.test(binding.target.configuration_sha256) ||
      !safe(binding.target.resources.core_database) || !safe(binding.target.resources.evidence_bucket) || !safe(binding.target.resources.work_bucket)) {
    failBackup("BACKUP_INPUT_INVALID", "backup restore intent contains an invalid epoch, copy, or target binding");
  }
  return { ...binding, intent: intent.data };
}

function validateBinding(binding: BackupRestoreIntentBinding): BackupRestoreIntentBinding {
  const normalized = validateBaseBinding(binding);
  if (typeof binding.admission !== "object" || binding.admission === null) {
    failBackup("BACKUP_RESTORE_NOT_IMPLEMENTED", "backup restore intent lacks a persisted current admission binding", false);
  }
  return { ...binding, intent: normalized.intent };
}

export async function computeBackupRestoreIdentity(binding: BackupRestoreBaseIntentBinding): Promise<{
  readonly restore_id: string; readonly intent_digest: string; readonly target_binding_json: string;
}> {
  const normalized = validateBaseBinding(binding);
  const targetBinding = canonicalBackupJson({
    account_id: normalized.target.account_id,
    failure_domain: normalized.target.failure_domain,
    environment_ref: normalized.target.environment_ref,
    resources: normalized.target.resources,
  });
  const requestDigest = await backupSha256Hex(canonicalBackupJson({
    intent: normalized.intent,
    epoch_id: normalized.epoch_id,
    offsite_copy_ref: normalized.offsite_copy_ref,
    target: JSON.parse(targetBinding) as unknown,
  }));
  const restoreKey = await backupSha256Hex(`${normalized.intent.principal_ref}\u0000${normalized.intent.idempotency_key}`);
  return { restore_id: `restore-${restoreKey.slice(0, 48)}`, intent_digest: requestDigest, target_binding_json: targetBinding };
}

async function identity(binding: BackupRestoreIntentBinding): Promise<{ readonly restore_id: string; readonly intent_digest: string; readonly target_binding_json: string }> {
  return computeBackupRestoreIdentity(binding);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

const EXPECTED_ACCEPTANCE = ["HANDLE_LIVE_REDACTED_ACCEPTANCE", "EXACT_RESTORE_ACCEPTANCE", "HIGH_RECALL_RESTORE_ACCEPTANCE", "ERASURE_RESTORE_ACCEPTANCE", "PROJECTION_REBUILD_ACCEPTANCE"] as const;
const RECEIPT_IDENTITY_KEYS = ["restore_id", "receipt_id", "attempt_id", "intent_ref", "epoch_id", "offsite_copy_ref", "target_environment_ref", "issued_at"] as const;

async function parseReceipt(value: unknown, archiveSource?: NativeHistoryArchiveSourceContext, expectedBinding?: BackupRestoreIntentBinding): Promise<BackupRestoreReceipt> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) failBackup("BACKUP_RESTORE_UNCERTAIN", "persisted backup restore receipt is malformed");
  const receipt = value as Record<string, unknown>;
  const commonValid = receipt["state"] === "RESTORED_UNQUALIFIED" && receipt["traffic_ready"] === false &&
      Array.isArray(receipt["unresolved_acceptance"]) && receipt["unresolved_acceptance"].length === EXPECTED_ACCEPTANCE.length &&
      canonicalBackupJson(receipt["unresolved_acceptance"]) === canonicalBackupJson(EXPECTED_ACCEPTANCE) &&
      SHA256.test(String(receipt["applied_purge_ledger_digest"] ?? "")) && SHA256.test(String(receipt["readback_digest"] ?? "")) &&
      Number.isSafeInteger(receipt["applied_purge_ledger_revision"]) && (receipt["applied_purge_ledger_revision"] as number) >= 0 &&
      Number.isSafeInteger(receipt["restored_core_row_count"]) && (receipt["restored_core_row_count"] as number) >= 0 &&
      Number.isSafeInteger(receipt["restored_r2_object_count"]) && (receipt["restored_r2_object_count"] as number) >= 0 &&
      Number.isSafeInteger(receipt["restored_r2_byte_count"]) && (receipt["restored_r2_byte_count"] as number) >= 0;
  if (!commonValid) failBackup("BACKUP_RESTORE_UNCERTAIN", "persisted backup restore receipt carries invalid or qualified status");
  if (receipt["protocol"] === "eliotr.backup-restore.v1") {
    const legacy = value as BackupRestoreReceiptV1;
    if (!SHA256.test(legacy.applied_purge_ledger_digest) || !SHA256.test(legacy.readback_digest)) {
      failBackup("BACKUP_RESTORE_UNCERTAIN", "legacy backup restore receipt digest is malformed");
    }
    return legacy;
  }
  const v2Keys = ["protocol", ...RECEIPT_IDENTITY_KEYS, "applied_purge_ledger_revision", "applied_purge_ledger_digest", "restored_core_row_count", "restored_r2_object_count", "restored_r2_byte_count", "readback_digest", "base_readback_digest", "target_readback_digest", "native_history_archive", "state", "traffic_ready", "unresolved_acceptance"];
  const intentRef = receipt["intent_ref"];
  if (receipt["protocol"] !== "eliotr.backup-restore.v2" || !exactKeys(receipt, v2Keys) ||
      ["restore_id", "receipt_id", "attempt_id", "epoch_id", "offsite_copy_ref", "target_environment_ref", "issued_at"].some((key) => typeof receipt[key] !== "string" || (receipt[key] as string).length === 0) ||
      !isRecord(intentRef) || !exactKeys(intentRef, ["id", "revision"]) || typeof intentRef["id"] !== "string" || intentRef["id"].length === 0 || !Number.isSafeInteger(intentRef["revision"]) ||
      !SHA256.test(String(receipt["base_readback_digest"] ?? "")) || !SHA256.test(String(receipt["target_readback_digest"] ?? ""))) {
    failBackup("BACKUP_RESTORE_UNCERTAIN", "persisted v2 backup restore receipt is malformed or contains unknown fields");
  }
  if (archiveSource === undefined) failBackup("BACKUP_RESTORE_UNCERTAIN", "v2 restore replay requires the current authenticated source epoch context", true);
  const archive = await validateNativeHistoryArchiveSummary(receipt["native_history_archive"], archiveSource);
  const v2 = value as BackupRestoreReceiptV2;
  if (archive.source.epoch_id !== v2.epoch_id || archive.source.offsite_copy_ref !== v2.offsite_copy_ref ||
      archive.target_readback_digest !== v2.target_readback_digest ||
      (expectedBinding !== undefined && (canonicalBackupJson(v2.intent_ref) !== canonicalBackupJson(expectedBinding.intent.intent_ref) ||
        v2.offsite_copy_ref !== expectedBinding.offsite_copy_ref || v2.target_environment_ref !== expectedBinding.target.environment_ref)) ||
      await digestNativeHistoryRestoreReadback(v2.base_readback_digest, v2.target_readback_digest) !== v2.readback_digest) {
    failBackup("BACKUP_RESTORE_UNCERTAIN", "v2 restore receipt readback does not bind its authenticated archive, intent, and target");
  }
  return v2;
}

async function readReceipt(db: D1Database, restoreId: string, archiveSource?: NativeHistoryArchiveSourceContext, expectedBinding?: BackupRestoreIntentBinding): Promise<BackupRestoreReceipt | null> {
  let row: ReceiptRow | null;
  try { row = await db.prepare("SELECT receipt_json,receipt_digest FROM backup_restore_receipt WHERE restore_id=?1 LIMIT 2").bind(restoreId).first<ReceiptRow>(); }
  catch (cause) { failBackup("BACKUP_TABLE_MISSING", "backup restore receipt authority is unavailable", true, {}, cause); }
  if (row === null) return null;
  if (typeof row.receipt_json !== "string" || typeof row.receipt_digest !== "string" || !SHA256.test(row.receipt_digest)) failBackup("BACKUP_RESTORE_UNCERTAIN", "backup restore receipt readback is malformed");
  let parsed: unknown;
  try { parsed = JSON.parse(row.receipt_json) as unknown; } catch (cause) { failBackup("BACKUP_RESTORE_UNCERTAIN", "backup restore receipt JSON is malformed", false, {}, cause); }
  const receipt = await parseReceipt(parsed, archiveSource, expectedBinding);
  if (await backupSha256Hex(canonicalBackupJson(receipt)) !== row.receipt_digest || canonicalBackupJson(receipt) !== row.receipt_json) failBackup("BACKUP_RESTORE_UNCERTAIN", "backup restore receipt digest or canonical bytes disagree on readback");
  return receipt;
}

// v1 bytes remain readable as historical records; new completion writes are v2-only.
async function readIntent(db: D1Database, principal: string, key: string): Promise<IntentRow | null> {
  try {
    return await db.prepare(
      "SELECT restore_id,principal_ref,idempotency_key,intent_id,intent_revision,intent_digest,epoch_id," +
      "offsite_copy_ref,target_binding_json,state FROM backup_restore_intent WHERE principal_ref=?1 AND idempotency_key=?2 LIMIT 2",
    ).bind(principal, key).first<IntentRow>();
  } catch (cause) { failBackup("BACKUP_TABLE_MISSING", "backup restore intent authority is unavailable", true, {}, cause); }
}

function assertIntentMatches(row: IntentRow, binding: BackupRestoreIntentBinding, expected: Awaited<ReturnType<typeof identity>>): void {
  if (row.restore_id !== expected.restore_id || row.principal_ref !== binding.intent.principal_ref || row.idempotency_key !== binding.intent.idempotency_key ||
      row.intent_id !== binding.intent.intent_ref.id || row.intent_revision !== binding.intent.intent_ref.revision || row.intent_digest !== expected.intent_digest ||
      row.epoch_id !== binding.epoch_id || row.offsite_copy_ref !== binding.offsite_copy_ref || row.target_binding_json !== expected.target_binding_json) {
    failBackup("BACKUP_INTENT_CONFLICT", "backup restore idempotency key is already bound to different intent, epoch, or target authority");
  }
}


export function createD1BackupRestoreStore(database: D1Database): BackupRestoreStore {
  return {
    async claim(bindingInput, nowMs = Date.now(), archiveSource) {
      const binding = validateBinding(bindingInput);
      const id = await identity(binding);
      const now = timestamp(nowMs);
      const existing = await readIntent(database, binding.intent.principal_ref, binding.intent.idempotency_key);
      if (existing !== null) assertIntentMatches(existing, binding, id);
      await assertCurrentRestoreAdmissionBinding(database, binding.admission, nowMs);
      if (existing?.state === "RESTORED_UNQUALIFIED") {
        const receipt = await readReceipt(database, id.restore_id, archiveSource, binding);
        if (receipt === null || receipt.restore_id !== id.restore_id || receipt.intent_ref.id !== binding.intent.intent_ref.id || receipt.epoch_id !== binding.epoch_id) {
          failBackup("BACKUP_RESTORE_UNCERTAIN", "completed backup restore has no exact persisted receipt", true);
        }
        return { state: "REPLAY", restore_id: id.restore_id, intent_digest: id.intent_digest, receipt };
      }
      if (existing !== null && existing.state !== "ADMITTED") {
        if (existing.state === "BLOCKED") failBackup("BACKUP_RESTORE_FAILED", "backup restore intent is terminally failed or blocked", false);
        failBackup("BACKUP_RESTORE_UNCERTAIN", "backup restore is already running or has an unknown prior outcome", true);
      }
      try {
        await database.prepare(
          "INSERT INTO backup_restore_intent(restore_id,principal_ref,idempotency_key,intent_id,intent_revision," +
          "intent_digest,epoch_id,offsite_copy_ref,target_binding_json,state,created_at,updated_at) " +
          "VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'ADMITTED',?10,?10) ON CONFLICT(principal_ref,idempotency_key) DO NOTHING",
        ).bind(id.restore_id, binding.intent.principal_ref, binding.intent.idempotency_key, binding.intent.intent_ref.id,
          binding.intent.intent_ref.revision, id.intent_digest, binding.epoch_id, binding.offsite_copy_ref,
          id.target_binding_json, now).run();
      } catch (cause) { failBackup("BACKUP_TABLE_MISSING", "backup restore intent did not settle", true, {}, cause); }
      const row = await readIntent(database, binding.intent.principal_ref, binding.intent.idempotency_key);
      if (row === null) failBackup("BACKUP_RESTORE_UNCERTAIN", "backup restore intent did not read back", true);
      assertIntentMatches(row, binding, id);
      await assertCurrentRestoreAdmissionBinding(database, binding.admission, nowMs);
      if (row.state === "RESTORED_UNQUALIFIED") {
        const receipt = await readReceipt(database, id.restore_id, archiveSource, binding);
        if (receipt === null || receipt.restore_id !== id.restore_id || receipt.intent_ref.id !== binding.intent.intent_ref.id || receipt.epoch_id !== binding.epoch_id) {
          failBackup("BACKUP_RESTORE_UNCERTAIN", "completed backup restore has no exact persisted receipt", true);
        }
        return { state: "REPLAY", restore_id: id.restore_id, intent_digest: id.intent_digest, receipt };
      }
      if (row.state !== "ADMITTED") {
        if (row.state === "BLOCKED") failBackup("BACKUP_RESTORE_FAILED", "backup restore intent is terminally failed or blocked", false);
        failBackup("BACKUP_RESTORE_UNCERTAIN", "backup restore is already running or has an unknown prior outcome", true);
      }
      return { state: "READY", restore_id: id.restore_id, intent_digest: id.intent_digest };
    },

    async beginAttempt(claim, bindingInput, fence, nowMs = Date.now()) {
      const binding = validateBinding(bindingInput);
      const id = await identity(binding);
      if (claim.restore_id !== id.restore_id || claim.intent_digest !== id.intent_digest) failBackup("BACKUP_INTENT_CONFLICT", "backup restore claim does not match the exact request binding");
      if (fence.kind !== "RESTORE" || typeof fence.operation_id !== "string" || fence.operation_id.length === 0 ||
          typeof fence.lease_owner !== "string" || fence.lease_owner.length === 0 ||
          !Number.isSafeInteger(fence.lease_generation) || fence.lease_generation < 1) {
        failBackup("BACKUP_PURGE_BLOCKED", "backup restore attempt lacks an exact shared O4 exclusion lease");
      }
      await assertCurrentRestoreAdmissionBinding(database, binding.admission, nowMs);
      await fence.assertCurrent();
      const now = timestamp(nowMs);
      let transition: { readonly restore_id: unknown } | null;
      try {
        transition = await database.prepare(
          "UPDATE backup_restore_intent SET state='ATTEMPTING',updated_at=?3 WHERE restore_id=?1 AND intent_digest=?2 AND state='ADMITTED' " +
          "AND EXISTS (SELECT 1 FROM backup_restore_admission_binding b " +
          "JOIN backup_restore_permission p ON p.permission_ref=b.permission_ref AND p.revision=b.permission_revision " +
          "JOIN backup_restore_target_profile t ON t.profile_ref=b.profile_ref AND t.revision=b.profile_revision AND t.profile_sha256=b.profile_sha256 " +
          "WHERE b.restore_id=?1 AND b.permission_ref=?8 AND b.permission_revision=?9 AND b.permission_sha256=?10 " +
          "AND b.restore_intent_digest=?2 AND b.binding_sha256=?11 AND b.intent_sha256=?12 AND b.actor_sha256=?13 " +
          "AND b.actor_expires_at=?14 AND b.copy_authority_sha256=?15 AND b.primary_binding_sha256=?16 AND b.request_sha256=?17 " +
          "AND b.profile_ref=?18 AND b.profile_revision=?19 AND b.profile_sha256=?20 AND b.valid_from=?21 AND b.expires_at=?22 " +
          "AND p.permission_sha256=b.permission_sha256 AND p.restore_id=b.restore_id AND p.restore_intent_digest=b.restore_intent_digest " +
          "AND p.intent_sha256=b.intent_sha256 AND p.actor_sha256=b.actor_sha256 AND p.actor_expires_at=b.actor_expires_at " +
          "AND p.copy_authority_sha256=b.copy_authority_sha256 AND p.primary_binding_sha256=b.primary_binding_sha256 " +
          "AND p.request_sha256=b.request_sha256 AND p.profile_ref=b.profile_ref AND p.profile_revision=b.profile_revision " +
          "AND p.profile_sha256=b.profile_sha256 AND p.valid_from=b.valid_from AND p.expires_at=b.expires_at " +
          "AND p.valid_from<=?23 AND p.expires_at>?23 AND b.actor_expires_at>?23 " +
          "AND NOT EXISTS (SELECT 1 FROM backup_restore_permission_revocation r WHERE r.permission_ref=p.permission_ref AND r.permission_revision=p.revision) " +
          "AND NOT EXISTS (SELECT 1 FROM backup_restore_target_profile_revocation r WHERE r.profile_ref=t.profile_ref AND r.profile_revision=t.revision)) " +
          "AND EXISTS (SELECT 1 FROM operation_execution_lease WHERE operation_id=?4 " +
          "AND operation_kind='ERASURE_RESTORE_SHARED_FENCE' AND lease_owner=?5 AND lease_generation=?6 " +
          "AND state='LEASED' AND lease_until>?7) RETURNING restore_id",
        ).bind(id.restore_id, id.intent_digest, now, fence.operation_id, fence.lease_owner, fence.lease_generation, nowMs,
          binding.admission.permission_ref, binding.admission.permission_revision, binding.admission.permission_sha256,
          binding.admission.binding_sha256, binding.admission.intent_sha256, binding.admission.actor_sha256,
          binding.admission.actor_expires_at, binding.admission.copy_authority_sha256, binding.admission.primary_binding_sha256,
          binding.admission.request_sha256, binding.admission.profile_ref, binding.admission.profile_revision,
          binding.admission.profile_sha256, binding.admission.valid_from, binding.admission.expires_at, new Date(nowMs).toISOString())
          .first<{ readonly restore_id: unknown }>();
      } catch (cause) { failBackup("BACKUP_RESTORE_UNCERTAIN", "backup restore attempt claim is unavailable", true, {}, cause); }
      if (transition?.restore_id !== id.restore_id) {
        // A concurrent revoke/expiry between the read preflight and this CAS
        // must win. Recheck the persisted grant only to distinguish that case
        // from loss of the shared O4 lease; the UPDATE itself is authoritative.
        await assertCurrentRestoreAdmissionBinding(database, binding.admission, nowMs);
        failBackup("BACKUP_PURGE_BLOCKED", "shared O4 exclusion was lost before the restore attempt could become durable", true);
      }
      const attemptIdDigest = await backupSha256Hex(`${id.restore_id}\u0000attempt\u00001`);
      const attemptId = `restore-attempt-${attemptIdDigest.slice(0, 40)}`;
      const attemptJson = canonicalBackupJson({
        protocol: "eliotr.backup-restore-attempt.v1", restore_id: id.restore_id, attempt_number: 1,
        attempt_id: attemptId, intent_digest: id.intent_digest, state: "STARTED", started_at: now,
      });
      try {
        await database.prepare(
          "INSERT INTO backup_restore_attempt(restore_id,attempt_number,attempt_id,state,attempt_json,started_at) " +
          "VALUES(?1,1,?2,'STARTED',?3,?4)",
        ).bind(id.restore_id, attemptId, attemptJson, now).run();
      } catch (cause) {
        await database.prepare("UPDATE backup_restore_intent SET state='UNKNOWN',updated_at=?2 WHERE restore_id=?1 AND state='ATTEMPTING'")
          .bind(id.restore_id, now).run().catch(() => undefined);
        failBackup("BACKUP_RESTORE_UNCERTAIN", "backup restore attempt did not settle before target writes", true, {}, cause);
      }
      const persistedAttempt = await database.prepare("SELECT attempt_id,state,attempt_json FROM backup_restore_attempt WHERE restore_id=?1 AND attempt_number=1 LIMIT 2")
        .bind(id.restore_id).first<{ readonly attempt_id: unknown; readonly state: unknown; readonly attempt_json: unknown }>();
      if (persistedAttempt?.attempt_id !== attemptId || persistedAttempt.state !== "STARTED" || persistedAttempt.attempt_json !== attemptJson) {
        await database.prepare("UPDATE backup_restore_intent SET state='UNKNOWN',updated_at=?2 WHERE restore_id=?1 AND state='ATTEMPTING'")
          .bind(id.restore_id, now).run().catch(() => undefined);
        failBackup("BACKUP_RESTORE_UNCERTAIN", "backup restore attempt failed exact durable readback", true);
      }
      return { restore_id: id.restore_id, attempt_number: 1, attempt_id: attemptId, intent_digest: id.intent_digest, started_at: now };
    },

    async markFailed(attempt, errorCode, nowMs = Date.now()) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(errorCode)) failBackup("BACKUP_INPUT_INVALID", "backup restore failure code is malformed");
      const now = timestamp(nowMs);
      const attemptJson = canonicalBackupJson({
        protocol: "eliotr.backup-restore-attempt.v1", restore_id: attempt.restore_id, attempt_number: attempt.attempt_number,
        attempt_id: attempt.attempt_id, intent_digest: attempt.intent_digest, state: "FAILED",
        started_at: attempt.started_at, ended_at: now, error_code: errorCode,
      });
      try {
        await database.prepare(
          "UPDATE backup_restore_attempt SET state='FAILED',attempt_json=?3,ended_at=?4,error_code=?5 " +
          "WHERE restore_id=?1 AND attempt_number=?2 AND attempt_id=?6 AND state='STARTED'",
        ).bind(attempt.restore_id, attempt.attempt_number, attemptJson, now, errorCode, attempt.attempt_id).run();
        await database.prepare("UPDATE backup_restore_intent SET state='BLOCKED',updated_at=?2 WHERE restore_id=?1 AND state='ATTEMPTING'")
          .bind(attempt.restore_id, now).run();
      } catch (cause) { failBackup("BACKUP_RESTORE_UNCERTAIN", "backup restore failure status did not settle", true, {}, cause); }
      const row = await database.prepare("SELECT state,attempt_json FROM backup_restore_attempt WHERE restore_id=?1 AND attempt_number=?2 LIMIT 2")
        .bind(attempt.restore_id, attempt.attempt_number).first<{ readonly state: unknown; readonly attempt_json: unknown }>();
      if (row?.state !== "FAILED" || row.attempt_json !== attemptJson) failBackup("BACKUP_RESTORE_UNCERTAIN", "backup restore failure status failed exact readback", true);
    },

    async markUnknown(attempt, errorCode, nowMs = Date.now()) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(errorCode)) failBackup("BACKUP_INPUT_INVALID", "backup restore uncertainty code is malformed");
      const now = timestamp(nowMs);
      const attemptJson = canonicalBackupJson({
        protocol: "eliotr.backup-restore-attempt.v1", restore_id: attempt.restore_id, attempt_number: attempt.attempt_number,
        attempt_id: attempt.attempt_id, intent_digest: attempt.intent_digest, state: "UNKNOWN",
        started_at: attempt.started_at, ended_at: now, error_code: errorCode,
      });
      try {
        await database.prepare(
          "UPDATE backup_restore_attempt SET state='UNKNOWN',attempt_json=?3,ended_at=?4,error_code=?5 " +
          "WHERE restore_id=?1 AND attempt_number=?2 AND attempt_id=?6 AND state='STARTED'",
        ).bind(attempt.restore_id, attempt.attempt_number, attemptJson, now, errorCode, attempt.attempt_id).run();
        await database.prepare("UPDATE backup_restore_intent SET state='UNKNOWN',updated_at=?2 WHERE restore_id=?1 AND state='ATTEMPTING'")
          .bind(attempt.restore_id, now).run();
      } catch (cause) { failBackup("BACKUP_RESTORE_UNCERTAIN", "backup restore unknown outcome did not settle", true, {}, cause); }
      const receipt = await readReceipt(database, attempt.restore_id);
      if (receipt !== null) failBackup("BACKUP_RESTORE_UNCERTAIN", "restore was marked unknown after a receipt had already committed", true);
    },

    async complete(attempt, bindingInput, result, nowMs = Date.now(), archiveSource) {
      const binding = validateBinding(bindingInput);
      const id = await identity(binding);
      if (attempt.restore_id !== id.restore_id || attempt.intent_digest !== id.intent_digest) failBackup("BACKUP_INTENT_CONFLICT", "restore receipt attempt does not match its intent binding");
      if (!SHA256.test(result.applied_purge_ledger_digest) || !SHA256.test(result.readback_digest) ||
          !SHA256.test(result.base_readback_digest) || !SHA256.test(result.target_readback_digest) ||
          !Number.isSafeInteger(result.applied_purge_ledger_revision) || result.applied_purge_ledger_revision < 0 ||
          !Number.isSafeInteger(result.restored_core_row_count) || result.restored_core_row_count < 0 ||
          !Number.isSafeInteger(result.restored_r2_object_count) || result.restored_r2_object_count < 0 ||
          !Number.isSafeInteger(result.restored_r2_byte_count) || result.restored_r2_byte_count < 0) {
        failBackup("BACKUP_INPUT_INVALID", "backup restore readback result is malformed");
      }
      if (archiveSource === undefined) failBackup("BACKUP_INPUT_INVALID", "new restore completion requires authenticated native-history source context");
      const archive = await validateNativeHistoryArchiveSummary(result.native_history_archive, archiveSource);
      if (archive.source.epoch_id !== binding.epoch_id || archive.source.offsite_copy_ref !== binding.offsite_copy_ref ||
          archive.target_readback_digest !== result.target_readback_digest ||
          await digestNativeHistoryRestoreReadback(result.base_readback_digest, result.target_readback_digest) !== result.readback_digest) {
        failBackup("BACKUP_INPUT_INVALID", "backup restore completion does not match its authenticated archive readback");
      }
      const now = timestamp(nowMs);
      const receipt = await parseReceipt({
        protocol: "eliotr.backup-restore.v2", restore_id: id.restore_id,
        receipt_id: `restore-receipt-${attempt.attempt_id.slice("restore-attempt-".length)}`,
        attempt_id: attempt.attempt_id, intent_ref: binding.intent.intent_ref,
        epoch_id: binding.epoch_id, offsite_copy_ref: binding.offsite_copy_ref,
        target_environment_ref: binding.target.environment_ref,
        applied_purge_ledger_revision: result.applied_purge_ledger_revision,
        applied_purge_ledger_digest: result.applied_purge_ledger_digest,
        restored_core_row_count: result.restored_core_row_count,
        restored_r2_object_count: result.restored_r2_object_count,
        restored_r2_byte_count: result.restored_r2_byte_count,
        readback_digest: result.readback_digest,
        base_readback_digest: result.base_readback_digest,
        target_readback_digest: result.target_readback_digest,
        native_history_archive: archive,
        state: "RESTORED_UNQUALIFIED", traffic_ready: false,
        unresolved_acceptance: ["HANDLE_LIVE_REDACTED_ACCEPTANCE", "EXACT_RESTORE_ACCEPTANCE", "HIGH_RECALL_RESTORE_ACCEPTANCE", "ERASURE_RESTORE_ACCEPTANCE", "PROJECTION_REBUILD_ACCEPTANCE"],
        issued_at: now,
      }, archiveSource, binding);
      const receiptJson = canonicalBackupJson(receipt);
      const receiptDigest = await backupSha256Hex(receiptJson);
      try {
        await database.prepare(
          "INSERT INTO backup_restore_receipt(restore_id,attempt_number,receipt_json,receipt_digest,created_at) " +
          "VALUES(?1,?2,?3,?4,?5) ON CONFLICT(restore_id) DO NOTHING",
        ).bind(id.restore_id, attempt.attempt_number, receiptJson, receiptDigest, now).run();
      } catch (cause) { failBackup("BACKUP_RESTORE_UNCERTAIN", "backup restore receipt commit is unknown", true, {}, cause); }
      const stored = await readReceipt(database, id.restore_id, archiveSource, binding);
      if (stored === null || canonicalBackupJson(stored) !== receiptJson) failBackup("BACKUP_INTENT_CONFLICT", "backup restore receipt identity already contains divergent bytes");
      const attemptJson = canonicalBackupJson({
        protocol: "eliotr.backup-restore-attempt.v1", restore_id: id.restore_id, attempt_number: attempt.attempt_number,
        attempt_id: attempt.attempt_id, intent_digest: id.intent_digest, state: "SUCCEEDED",
        started_at: attempt.started_at, ended_at: now, readback_digest: result.readback_digest,
      });
      try {
        await database.prepare(
          "UPDATE backup_restore_attempt SET state='SUCCEEDED',attempt_json=?3,ended_at=?4,readback_digest=?5 " +
          "WHERE restore_id=?1 AND attempt_number=?2 AND attempt_id=?6 AND state='STARTED'",
        ).bind(id.restore_id, attempt.attempt_number, attemptJson, now, result.readback_digest, attempt.attempt_id).run();
        await database.prepare("UPDATE backup_restore_intent SET state='RESTORED_UNQUALIFIED',updated_at=?2 WHERE restore_id=?1 AND state='ATTEMPTING'")
          .bind(id.restore_id, now).run();
      } catch (cause) { failBackup("BACKUP_RESTORE_UNCERTAIN", "backup restore completion status did not settle", true, {}, cause); }
      const row = await readIntent(database, binding.intent.principal_ref, binding.intent.idempotency_key);
      if (row === null || row.state !== "RESTORED_UNQUALIFIED" || row.intent_digest !== id.intent_digest) failBackup("BACKUP_RESTORE_UNCERTAIN", "backup restore completion failed exact intent readback", true);
      const storedAttempt = await database.prepare("SELECT state,readback_digest FROM backup_restore_attempt WHERE restore_id=?1 AND attempt_number=?2 LIMIT 2")
        .bind(id.restore_id, attempt.attempt_number).first<{ readonly state: unknown; readonly readback_digest: unknown }>();
      if (storedAttempt?.state !== "SUCCEEDED" || storedAttempt.readback_digest !== result.readback_digest) failBackup("BACKUP_RESTORE_UNCERTAIN", "backup restore attempt completion failed exact readback", true);
      return stored;
    },
  };
}
