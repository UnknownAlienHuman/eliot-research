import type { OperationReceipt } from "@eliotr/contracts";
import { failBackup } from "./shared.js";

// ER-34 O2 restart-safe replay authority. D1 is the authority; no Map-based
// durable claims. Exact replay (same idempotency key + identical digests)
// returns the same immutable receipt from a new process/port. Same key +
// any divergent byte conflicts.

export interface EpochReplayClaim {
  readonly idempotency_key: string;
  readonly intent_id: string;
  readonly vector_digest: string;
  readonly manifest_digest: string;
  readonly epoch_id: string;
}

const CREATE_RECEIPT_TABLE = `CREATE TABLE IF NOT EXISTS backup_epoch_receipt (
  idempotency_key TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL,
  vector_digest TEXT NOT NULL CHECK (length(vector_digest) = 64),
  manifest_digest TEXT NOT NULL CHECK (length(manifest_digest) = 64),
  epoch_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  created_at TEXT NOT NULL
) STRICT`;

const CREATE_EXPIRY_TABLE = `CREATE TABLE IF NOT EXISTS backup_offsite_expiry (
  expiry_intent_key TEXT PRIMARY KEY,
  epoch_id TEXT NOT NULL,
  destination_id TEXT NOT NULL,
  journal_refs_json TEXT NOT NULL CHECK (json_valid(journal_refs_json)),
  state TEXT NOT NULL CHECK (state IN ('DELETED','BLOCKED')),
  created_at TEXT NOT NULL
) STRICT`;

export async function ensureReplayTables(database: D1Database): Promise<void> {
  try {
    await database.prepare(CREATE_RECEIPT_TABLE).run();
    await database.prepare(CREATE_EXPIRY_TABLE).run();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup replay authority tables are unavailable", true, {}, cause);
  }
}

interface ReceiptRow {
  readonly idempotency_key: string;
  readonly intent_id: string;
  readonly vector_digest: string;
  readonly manifest_digest: string;
  readonly epoch_id: string;
  readonly receipt_json: string;
}

async function readReceiptRow(database: D1Database, idempotencyKey: string): Promise<ReceiptRow | null> {
  let row: ReceiptRow | null;
  try {
    row = await database.prepare(
      "SELECT idempotency_key, intent_id, vector_digest, manifest_digest, epoch_id, receipt_json FROM backup_epoch_receipt WHERE idempotency_key = ?1",
    ).bind(idempotencyKey).first<ReceiptRow>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup replay authority read is unavailable", true, { intent: idempotencyKey }, cause);
  }
  return row;
}

export async function claimEpochReceipt(
  database: D1Database,
  claim: EpochReplayClaim,
  receipt: OperationReceipt,
  now: string,
): Promise<{ readonly replayed: boolean; readonly receipt: OperationReceipt }> {
  await ensureReplayTables(database);
  const receiptJson = JSON.stringify(receipt);
  try {
    await database.prepare(
      "INSERT INTO backup_epoch_receipt (idempotency_key, intent_id, vector_digest, manifest_digest, epoch_id, receipt_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    ).bind(claim.idempotency_key, claim.intent_id, claim.vector_digest, claim.manifest_digest, claim.epoch_id, receiptJson, now).run();
    return { replayed: false, receipt };
  } catch {
    // PK conflict: another process/port already claimed this key. Reopen and
    // reconcile exactly; never overwrite.
  }
  const existing = await readReceiptRow(database, claim.idempotency_key);
  if (existing === null) failBackup("BACKUP_TABLE_MISSING", "backup replay authority lost a concurrent claim", true, { intent: claim.idempotency_key });
  if (existing.intent_id !== claim.intent_id || existing.vector_digest !== claim.vector_digest || existing.manifest_digest !== claim.manifest_digest || existing.epoch_id !== claim.epoch_id) {
    failBackup("BACKUP_INTENT_CONFLICT", "backup intent reuses an identity with divergent content", false, { intent_id: claim.intent_id });
  }
  let parsed: OperationReceipt;
  try {
    parsed = JSON.parse(existing.receipt_json) as OperationReceipt;
  } catch (cause) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup replay receipt is corrupt", false, {}, cause);
  }
  return { replayed: true, receipt: parsed };
}

export async function readCommittedEpochReceipt(database: D1Database, idempotencyKey: string): Promise<OperationReceipt | null> {
  await ensureReplayTables(database);
  const existing = await readReceiptRow(database, idempotencyKey);
  if (existing === null) return null;
  try {
    return JSON.parse(existing.receipt_json) as OperationReceipt;
  } catch (cause) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup replay receipt is corrupt", false, {}, cause);
  }
}
