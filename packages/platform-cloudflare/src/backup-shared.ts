import {
  OperationAttemptSchema,
  OperationIntentSchema,
  OperationReceiptSchema,
  type OperationAttempt,
  type OperationIntent,
  type OperationReceipt,
} from "@eliotr/contracts";

// ER-34 O2 shared backup primitives: typed fail-closed errors, canonical
// JSON/digest helpers, export limits, and the Intent/Attempt/Receipt builders
// reused from the versioned operation contracts (no second authority).

export type BackupErrorCode =
  | "BACKUP_INPUT_INVALID"
  | "BACKUP_TABLE_MISSING"
  | "BACKUP_ROW_INVALID"
  | "BACKUP_BOUND_EXCEEDED"
  | "BACKUP_OBJECT_DIGEST_MISMATCH"
  | "BACKUP_OBJECT_UNREADABLE"
  | "BACKUP_PART_WRITE_FAILED"
  | "BACKUP_PART_READBACK_MISMATCH"
  | "BACKUP_VECTOR_DRIFT"
  | "BACKUP_INTENT_CONFLICT"
  | "BACKUP_CANCELLED"
  | "BACKUP_OFFSITE_INADMISSIBLE"
  | "BACKUP_OFFSITE_UNCERTAIN"
  | "BACKUP_OFFSITE_READBACK_MISMATCH"
  | "BACKUP_OFFSITE_EXPIRED"
  | "BACKUP_PURGE_BLOCKED"
  | "BACKUP_RESTORE_NOT_IMPLEMENTED"
  | "BACKUP_PURGE_REPLAY_NOT_IMPLEMENTED";

export class BackupError extends Error {
  public readonly code: BackupErrorCode;
  public readonly retryable: boolean;
  public readonly detail: Readonly<Record<string, string>>;
  public constructor(code: BackupErrorCode, message: string, retryable = false, detail: Readonly<Record<string, string>> = {}, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BackupError";
    this.code = code;
    this.retryable = retryable;
    this.detail = detail;
  }
}

export function failBackup(code: BackupErrorCode, message: string, retryable = false, detail: Readonly<Record<string, string>> = {}, cause?: unknown): never {
  throw new BackupError(code, message, retryable, detail, cause);
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const MAX_TIMESTAMP_MS = 253_402_300_799_999;

export function assertBackupIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) failBackup("BACKUP_INPUT_INVALID", `backup ${label} is not a bounded identifier`);
  return value;
}

export function assertBackupIntent(intent: OperationIntent): OperationIntent {
  let parsed: OperationIntent;
  try {
    parsed = OperationIntentSchema.parse(intent);
  } catch (cause) {
    failBackup("BACKUP_INPUT_INVALID", "backup export intent is malformed", false, {}, cause);
  }
  if (parsed.operation_kind !== "BACKUP") failBackup("BACKUP_INPUT_INVALID", "backup export intent must use the BACKUP operation kind");
  return parsed;
}

export function canonicalBackupJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalBackupJson).join(",")}]`;
  const entries = Object.entries(value as Readonly<Record<string, unknown>>)
    .filter((entry) => entry[1] !== undefined)
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalBackupJson(entry)}`).join(",")}}`;
}

export function ownedBackupBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

export async function backupSha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function backupUtf8Bytes(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value);
}

export function backupAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

export function backupIsoDateTime(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP_MS) failBackup("BACKUP_INPUT_INVALID", "backup clock value is out of range");
  return new Date(value).toISOString();
}

export function backupAttempt(intent: OperationIntent, attemptNumber: number, state: OperationAttempt["state"], now: string, errorCode?: string): OperationAttempt {
  return OperationAttemptSchema.parse({
    attempt_id: `backup-attempt-${intent.idempotency_key}-${attemptNumber}`,
    intent_ref: intent.intent_ref,
    attempt_number: attemptNumber,
    state,
    ...(errorCode === undefined ? {} : { error_code: errorCode }),
    started_at: now,
    ended_at: now,
  });
}

export function backupReceipt(intent: OperationIntent, attemptId: string, outcome: OperationReceipt["outcome"], outputRefs: readonly string[], readbackRefs: readonly string[], reconciled: boolean, reasons: readonly string[], now: string): OperationReceipt {
  return OperationReceiptSchema.parse({
    receipt_ref: { id: `backup-receipt-${intent.idempotency_key}`, revision: 1 },
    intent_ref: intent.intent_ref,
    attempt_id: attemptId,
    outcome,
    output_refs: [...outputRefs],
    readback_receipt_refs: [...readbackRefs],
    reconciliation_required: reconciled,
    reason_codes: [...reasons],
    created_at: now,
  });
}

export interface BackupExportLimits {
  readonly max_table_rows: number;
  readonly max_r2_keys: number;
  readonly max_r2_pages: number;
  readonly max_object_bytes: number;
  readonly max_total_object_bytes: number;
  readonly max_manifest_bytes: number;
  readonly r2_list_page_size: number;
  readonly part_bytes: number;
}

export const DEFAULT_BACKUP_EXPORT_LIMITS: BackupExportLimits = {
  max_table_rows: 100_000,
  max_r2_keys: 100_000,
  max_r2_pages: 10_000,
  max_object_bytes: 64 * 1024 * 1024,
  max_total_object_bytes: 1024 * 1024 * 1024,
  max_manifest_bytes: 64 * 1024 * 1024,
  r2_list_page_size: 1000,
  part_bytes: 256 * 1024,
};

export function resolveBackupExportLimits(input?: Partial<BackupExportLimits>): BackupExportLimits {
  const limits = { ...DEFAULT_BACKUP_EXPORT_LIMITS, ...input };
  for (const [label, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || (value as number) < 0) failBackup("BACKUP_INPUT_INVALID", `backup export limit ${label} is not a non-negative safe integer`);
  }
  if (limits.r2_list_page_size < 1 || limits.part_bytes < 1) failBackup("BACKUP_INPUT_INVALID", "backup paging and part sizes must be positive");
  return limits;
}
