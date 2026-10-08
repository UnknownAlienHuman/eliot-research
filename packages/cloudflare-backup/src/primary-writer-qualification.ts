import { OperationAttemptSchema, OperationIntentSchema, OperationReceiptSchema, type ErasureFence, type OperationAttempt, type OperationIntent, type OperationReceipt } from "@eliotr/contracts";
import { backupSha256Hex, canonicalBackupJson, failBackup } from "@eliotr/backup-o2";

export const PRIMARY_WRITER_QUALIFICATION_PROTOCOL = "eliotr.backup-primary-writer-qualification.v1" as const;
export const PRIMARY_WRITER_BOOTSTRAP_PROTOCOL = "eliotr.backup-primary-writer-bootstrap.v1" as const;
export const PRIMARY_WRITER_RESERVED_PREFIX = "backup-parts/" as const;
const SHA256 = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

export type PrimaryWriterQualificationMode = "ISOLATED_NEW_BUCKET" | "LEGACY_WRITERS_DRAINED";
export type PrimaryWriterErasureMode = "NO_ACTIVE_ERASURE" | "FENCED";

export interface PrimaryWriterZeroEvidence {
  readonly protocol: "eliotr.backup-primary-zero-baseline.v1";
  readonly epoch_count: 0;
  readonly receipt_count: 0;
  readonly export_cut_count: 0;
  readonly erasure_case_count: 0;
  readonly erasure_execution_count: 0;
  readonly producer_claim_count: 0;
  readonly primary_prefix_count: 0;
  readonly observed_at: string;
}

export interface PrimaryWriterPrefixReadback {
  readonly protocol: "eliotr.backup-primary-prefix-readback.v1";
  readonly bucket_binding_ref: string;
  readonly bucket_name: string;
  readonly prefix: typeof PRIMARY_WRITER_RESERVED_PREFIX;
  readonly object_count: number;
  readonly inventory_digest: string;
  readonly observed_at: string;
}

export interface PrimaryWriterQualification {
  readonly protocol: typeof PRIMARY_WRITER_QUALIFICATION_PROTOCOL;
  readonly qualification_ref: string;
  readonly revision: number;
  readonly mode: PrimaryWriterQualificationMode;
  readonly owner_admission_ref: string;
  readonly owner_admission_sha256: string;
  readonly erasure_mode: PrimaryWriterErasureMode;
  readonly erasure_fence?: ErasureFence;
  readonly erasure_request_sha256?: string;
  readonly producer_claim_count: number;
  readonly producer_claim_digest: string;
  readonly export_cut_count: number;
  readonly export_cut_digest: string;
  readonly primary_prefix_count: number;
  readonly primary_prefix_digest: string;
  readonly cloudflare: {
    readonly account_id: string;
    readonly worker_name: string;
    readonly deployment_id: string;
    readonly version_id: string;
    readonly version_etag: string;
    readonly controller_generation: string;
    readonly source_sha256: string;
    readonly configuration_sha256: string;
    readonly compiled_artifact_sha256: string;
    readonly bucket_binding_ref: string;
    readonly bucket_name: string;
    readonly reserved_prefix: typeof PRIMARY_WRITER_RESERVED_PREFIX;
  };
  readonly bootstrap_zero_d1: PrimaryWriterZeroEvidence;
  readonly bootstrap_zero_d1_ref: string;
  readonly reserved_prefix_readback: PrimaryWriterPrefixReadback;
  readonly reserved_prefix_readback_ref: string;
  readonly reserved_prefix_readback_sha256: string;
  readonly evidence_digest: string;
  readonly created_at: string;
}

export interface PrimaryWriterOperation {
  readonly operation_ref: string;
  readonly qualification_ref: string;
  readonly qualification_revision: number;
  readonly intent: OperationIntent;
  readonly intent_sha256: string;
  readonly attempt: OperationAttempt;
  readonly attempt_sha256: string;
  readonly receipt: OperationReceipt;
  readonly receipt_sha256: string;
  readonly readback_receipt_ref: string;
  readonly readback_sha256: string;
  readonly state: "ADMITTED" | "UNKNOWN" | "COMMITTED" | "BLOCKED";
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PrimaryWriterCurrentAuthority {
  readonly qualification_ref: string;
  readonly qualification_revision: number;
  readonly qualification_sha256: string;
  readonly controller_generation: string;
  readonly state: "ACTIVE" | "DRAINING" | "RETIRED";
  readonly updated_at: string;
}

export interface PrimaryWriterQualificationReadback {
  readonly qualification: PrimaryWriterQualification;
  readonly operation: PrimaryWriterOperation;
  readonly current: PrimaryWriterCurrentAuthority;
}

export interface PrimaryWriterErasureQualification {
  readonly protocol: "eliotr.backup-primary-writer-erasure-qualification.v1";
  readonly qualification_ref: string;
  readonly qualification_revision: number;
  readonly erasure_fence: ErasureFence;
  readonly erasure_request_sha256: string;
  readonly operation_ref: string;
  readonly intent_ref: { readonly id: string; readonly revision: number };
  readonly intent_sha256: string;
  readonly attempt_id: string;
  readonly attempt_sha256: string;
  readonly receipt_ref: OperationReceipt["receipt_ref"];
  readonly receipt_sha256: string;
  readonly owner_admission_ref: string;
  readonly owner_admission_sha256: string;
  readonly actual_version_id: string;
  readonly controller_generation: string;
  readonly bucket_binding_ref: string;
  readonly bucket_name: string;
  readonly producer_claim_count: number;
  readonly producer_claim_digest: string;
  readonly export_cut_count: number;
  readonly export_cut_digest: string;
  readonly primary_prefix_count: number;
  readonly primary_prefix_digest: string;
  readonly evidence_digest: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) failBackup("BACKUP_VECTOR_UNVERIFIABLE", `${label} is not an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) failBackup("BACKUP_VECTOR_UNVERIFIABLE", `${label} is malformed`);
  return value;
}
function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) failBackup("BACKUP_VECTOR_UNVERIFIABLE", `${label} is not SHA-256`);
  return value;
}
function canonicalStored(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "string") failBackup("BACKUP_VECTOR_UNVERIFIABLE", `${label} is not JSON`);
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { failBackup("BACKUP_VECTOR_UNVERIFIABLE", `${label} is malformed JSON`); }
  const object = record(parsed, label);
  if (canonicalBackupJson(object) !== value) failBackup("BACKUP_VECTOR_UNVERIFIABLE", `${label} is not canonical JSON`);
  return object;
}
function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) failBackup("BACKUP_VECTOR_UNVERIFIABLE", `${label} is malformed`);
  return value;
}
function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) || new Date(value).toISOString() !== value) failBackup("BACKUP_VECTOR_UNVERIFIABLE", `${label} is malformed`);
  return value;
}

function parseZero(value: unknown): PrimaryWriterZeroEvidence {
  const row = record(value, "bootstrap_zero_d1");
  if (row.protocol !== "eliotr.backup-primary-zero-baseline.v1" || row.epoch_count !== 0 || row.receipt_count !== 0 ||
      row.export_cut_count !== 0 || row.erasure_case_count !== 0 || row.erasure_execution_count !== 0 ||
      row.producer_claim_count !== 0 || row.primary_prefix_count !== 0) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "bootstrap zero baseline is not exact");
  return { protocol: row.protocol, epoch_count: 0, receipt_count: 0, export_cut_count: 0, erasure_case_count: 0,
    erasure_execution_count: 0, producer_claim_count: 0, primary_prefix_count: 0, observed_at: timestamp(row.observed_at, "bootstrap_zero_d1.observed_at") };
}

function parsePrefix(value: unknown): PrimaryWriterPrefixReadback {
  const row = record(value, "reserved_prefix_readback");
  const count = integer(row.object_count, "reserved_prefix_readback.object_count");
  if (row.protocol !== "eliotr.backup-primary-prefix-readback.v1" || row.prefix !== PRIMARY_WRITER_RESERVED_PREFIX || count !== 0) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "reserved prefix is not empty");
  return { protocol: row.protocol, bucket_binding_ref: text(row.bucket_binding_ref, "reserved_prefix_readback.bucket_binding_ref"),
    bucket_name: text(row.bucket_name, "reserved_prefix_readback.bucket_name"), prefix: PRIMARY_WRITER_RESERVED_PREFIX, object_count: 0,
    inventory_digest: digest(row.inventory_digest, "reserved_prefix_readback.inventory_digest"), observed_at: timestamp(row.observed_at, "reserved_prefix_readback.observed_at") };
}

export async function parsePrimaryWriterQualification(value: unknown): Promise<PrimaryWriterQualification> {
  const row = record(value, "primary writer qualification");
  if (row.protocol !== PRIMARY_WRITER_QUALIFICATION_PROTOCOL || row.mode !== "ISOLATED_NEW_BUCKET" && row.mode !== "LEGACY_WRITERS_DRAINED") failBackup("BACKUP_VECTOR_UNVERIFIABLE", "unsupported primary writer qualification");
  const cloudflare = record(row.cloudflare, "cloudflare");
  const zero = parseZero(row.bootstrap_zero_d1);
  const prefix = parsePrefix(row.reserved_prefix_readback);
  const erasureMode = row.erasure_mode;
  if (erasureMode !== "NO_ACTIVE_ERASURE" && erasureMode !== "FENCED") failBackup("BACKUP_VECTOR_UNVERIFIABLE", "primary writer erasure mode is invalid");
  if (row.mode === "ISOLATED_NEW_BUCKET" && (erasureMode !== "NO_ACTIVE_ERASURE" || integer(row.producer_claim_count, "producer_claim_count") !== 0 || integer(row.export_cut_count, "export_cut_count") !== 0)) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "isolated bootstrap baseline is not zero");
  let fence: ErasureFence | undefined;
  if (erasureMode === "FENCED") {
    const f = record(row.erasure_fence, "erasure_fence");
    fence = { erasure_id: text(f.erasure_id, "erasure_fence.erasure_id"), revision: integer(f.revision, "erasure_fence.revision"), lease_owner: text(f.lease_owner, "erasure_fence.lease_owner"), lease_generation: integer(f.lease_generation, "erasure_fence.lease_generation"), lease_until_ms: integer(f.lease_until_ms, "erasure_fence.lease_until_ms") };
    digest(row.erasure_request_sha256, "erasure_request_sha256");
  }
  if (prefix.bucket_binding_ref !== cloudflare.bucket_binding_ref || prefix.bucket_name !== cloudflare.bucket_name) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "prefix readback is bound to another bucket");
  const parsed: PrimaryWriterQualification = {
    protocol: PRIMARY_WRITER_QUALIFICATION_PROTOCOL, qualification_ref: text(row.qualification_ref, "qualification_ref"), revision: integer(row.revision, "revision"), mode: row.mode,
    owner_admission_ref: text(row.owner_admission_ref, "owner_admission_ref"), owner_admission_sha256: digest(row.owner_admission_sha256, "owner_admission_sha256"), erasure_mode: erasureMode, ...(fence === undefined ? {} : { erasure_fence: fence, erasure_request_sha256: digest(row.erasure_request_sha256, "erasure_request_sha256") }),
    producer_claim_count: integer(row.producer_claim_count, "producer_claim_count"), producer_claim_digest: digest(row.producer_claim_digest, "producer_claim_digest"), export_cut_count: integer(row.export_cut_count, "export_cut_count"), export_cut_digest: digest(row.export_cut_digest, "export_cut_digest"), primary_prefix_count: integer(row.primary_prefix_count, "primary_prefix_count"), primary_prefix_digest: digest(row.primary_prefix_digest, "primary_prefix_digest"),
    cloudflare: { account_id: text(cloudflare.account_id, "cloudflare.account_id"), worker_name: text(cloudflare.worker_name, "cloudflare.worker_name"), deployment_id: text(cloudflare.deployment_id, "cloudflare.deployment_id"), version_id: text(cloudflare.version_id, "cloudflare.version_id"), version_etag: text(cloudflare.version_etag, "cloudflare.version_etag"), controller_generation: text(cloudflare.controller_generation, "cloudflare.controller_generation"), source_sha256: digest(cloudflare.source_sha256, "cloudflare.source_sha256"), configuration_sha256: digest(cloudflare.configuration_sha256, "cloudflare.configuration_sha256"), compiled_artifact_sha256: digest(cloudflare.compiled_artifact_sha256, "cloudflare.compiled_artifact_sha256"), bucket_binding_ref: text(cloudflare.bucket_binding_ref, "cloudflare.bucket_binding_ref"), bucket_name: text(cloudflare.bucket_name, "cloudflare.bucket_name"), reserved_prefix: PRIMARY_WRITER_RESERVED_PREFIX },
    bootstrap_zero_d1: zero, bootstrap_zero_d1_ref: text(row.bootstrap_zero_d1_ref, "bootstrap_zero_d1_ref"), reserved_prefix_readback: prefix, reserved_prefix_readback_ref: text(row.reserved_prefix_readback_ref, "reserved_prefix_readback_ref"), reserved_prefix_readback_sha256: digest(row.reserved_prefix_readback_sha256, "reserved_prefix_readback_sha256"), evidence_digest: digest(row.evidence_digest, "evidence_digest"), created_at: timestamp(row.created_at, "created_at"),
  };
  if (await backupSha256Hex(canonicalBackupJson(parsed)) !== digest(row.authority_sha256, "authority_sha256")) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "primary writer authority digest diverges");
  return parsed;
}

export async function parsePrimaryWriterOperation(value: unknown): Promise<PrimaryWriterOperation> {
  const row = record(value, "primary writer operation");
  const state = row.state;
  if (state !== "ADMITTED" && state !== "UNKNOWN" && state !== "COMMITTED" && state !== "BLOCKED") {
    failBackup("BACKUP_INTENT_CONFLICT", "primary writer operation state is invalid");
  }
  const intent = OperationIntentSchema.parse(canonicalStored(row.intent_json, "intent_json"));
  const attempt = OperationAttemptSchema.parse(canonicalStored(row.attempt_json, "attempt_json"));
  const receipt = OperationReceiptSchema.parse(canonicalStored(row.receipt_json, "receipt_json"));
  const intentSha = digest(row.intent_sha256, "intent_sha256");
  const attemptSha = digest(row.attempt_sha256, "attempt_sha256");
  const receiptSha = digest(row.receipt_sha256, "receipt_sha256");
  if (await backupSha256Hex(canonicalBackupJson(intent)) !== intentSha || await backupSha256Hex(canonicalBackupJson(attempt)) !== attemptSha || await backupSha256Hex(canonicalBackupJson(receipt)) !== receiptSha) failBackup("BACKUP_INTENT_CONFLICT", "primary writer operation digest diverges");
  const operationRef = text(row.operation_ref, "operation_ref");
  const qualificationRef = text(row.qualification_ref, "qualification_ref");
  const qualificationRevision = integer(row.qualification_revision, "qualification_revision");
  const intentRef = text(row.intent_ref, "intent_ref");
  const intentRevision = integer(row.intent_revision, "intent_revision");
  const attemptId = text(row.attempt_id, "attempt_id");
  const attemptNumber = integer(row.attempt_number, "attempt_number");
  const receiptRef = text(row.receipt_ref, "receipt_ref");
  const readbackReceiptRef = text(row.readback_receipt_ref, "readback_receipt_ref");
  const readbackSha = digest(row.readback_sha256, "readback_sha256");
  const sameRef = (left: { readonly id: string; readonly revision: number }, right: { readonly id: string; readonly revision: number }): boolean => left.id === right.id && left.revision === right.revision;
  if (intent.operation_kind !== "BACKUP" || intentRef !== intent.intent_ref.id || intentRevision !== intent.intent_ref.revision ||
      !sameRef(attempt.intent_ref, intent.intent_ref) || !sameRef(receipt.intent_ref, intent.intent_ref) ||
      attemptId !== attempt.attempt_id || attemptNumber !== attempt.attempt_number || receipt.attempt_id !== attempt.attempt_id ||
      receiptRef !== receipt.receipt_ref.id) failBackup("BACKUP_INTENT_CONFLICT", "primary writer operation identity diverges");
  if (state === "COMMITTED" && (attempt.state !== "SUCCEEDED" || attempt.ended_at === undefined || attempt.error_code !== undefined ||
      receipt.outcome !== "SUCCEEDED" || receipt.reconciliation_required || receipt.reason_codes.length !== 0 ||
      !receipt.output_refs.includes(qualificationRef) || !receipt.readback_receipt_refs.includes(readbackReceiptRef))) {
    failBackup("BACKUP_INTENT_CONFLICT", "committed primary writer operation lacks an exact successful receipt and readback");
  }
  return { operation_ref: operationRef, qualification_ref: qualificationRef, qualification_revision: qualificationRevision, intent, intent_sha256: intentSha, attempt, attempt_sha256: attemptSha, receipt, receipt_sha256: receiptSha, readback_receipt_ref: readbackReceiptRef, readback_sha256: readbackSha, state, created_at: timestamp(row.created_at, "created_at"), updated_at: timestamp(row.updated_at, "updated_at") };
}

export async function digestQualification(value: PrimaryWriterQualification): Promise<string> {
  return backupSha256Hex(canonicalBackupJson(value));
}

export async function digestOperationPart(value: OperationIntent | OperationAttempt | OperationReceipt): Promise<string> {
  return backupSha256Hex(canonicalBackupJson(value));
}

export async function canonicalPrimaryWriterErasureQualification(value: PrimaryWriterErasureQualification): Promise<{ readonly json: string; readonly sha256: string }> {
  const json = canonicalBackupJson(value);
  return { json, sha256: await backupSha256Hex(json) };
}
