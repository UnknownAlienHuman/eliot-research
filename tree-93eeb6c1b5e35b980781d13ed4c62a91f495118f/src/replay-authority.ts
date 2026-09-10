import { OperationAttemptSchema, OperationReceiptSchema, type OperationAttempt, type OperationReceipt } from "@eliotr/contracts";
import { failBackup } from "./shared.js";
import { assertO2MigrationAuthority } from "./migration-gate.js";

// ER-34 O2 FIX2 restart-safe replay authority. D1 is the authority; no
// Map-based durable claims and no runtime CREATE TABLE substitute: every entry
// point first asserts migration 0018 in the authoritative ledger.
//
// The claim binds the canonical full intent digest (principal, payload, policy
// decision, timestamps, revisions, vector/manifest/epoch) plus the immutable
// persisted bytes (receipt, draft, attempt). Exact replay returns the persisted
// bytes verbatim from a new process/port — never a synthesized DUPLICATE with
// changed outcome/attempt/reason. Any same-key divergence conflicts with zero
// new side effects (callers pre-check before writing parts).

export interface EpochReplayClaim {
  readonly idempotency_key: string;
  readonly intent_id: string;
  readonly intent_digest: string;
  readonly vector_digest: string;
  readonly manifest_digest: string;
  readonly epoch_id: string;
}

export interface PersistedEpochReplay {
  readonly intent_digest: string;
  readonly receipt_json: string;
  readonly draft_json: string;
  readonly attempt_json: string;
}

interface ReplayRow {
  readonly intent_id: string;
  readonly intent_digest: string;
  readonly vector_digest: string;
  readonly manifest_digest: string;
  readonly epoch_id: string;
  readonly receipt_json: string;
  readonly draft_json: string;
  readonly attempt_json: string;
}

async function readReplayRow(database: D1Database, idempotencyKey: string): Promise<ReplayRow | null> {
  let row: ReplayRow | null;
  try {
    row = await database.prepare(
      "SELECT intent_id, intent_digest, vector_digest, manifest_digest, epoch_id, receipt_json, draft_json, attempt_json FROM backup_epoch_receipt WHERE idempotency_key = ?1",
    ).bind(idempotencyKey).first<ReplayRow>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup replay authority read is unavailable", true, { intent: idempotencyKey }, cause);
  }
  return row;
}

function parseReplayReceipt(row: ReplayRow, idempotencyKey: string): OperationReceipt {
  try {
    return OperationReceiptSchema.parse(JSON.parse(row.receipt_json) as unknown);
  } catch (cause) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup replay receipt is corrupt", false, { intent: idempotencyKey }, cause);
  }
}

function replayMatches(row: ReplayRow, claim: EpochReplayClaim): boolean {
  return row.intent_id === claim.intent_id
    && row.intent_digest === claim.intent_digest
    && row.vector_digest === claim.vector_digest
    && row.manifest_digest === claim.manifest_digest
    && row.epoch_id === claim.epoch_id;
}

// Read-only pre-check: lets callers return persisted bytes or conflict BEFORE
// any part write, so divergent replays cause zero new side effects.
export async function peekEpochReplay(database: D1Database, claim: EpochReplayClaim): Promise<{ readonly state: "ABSENT" } | { readonly state: "REPLAY"; readonly persisted: PersistedEpochReplay } | { readonly state: "CONFLICT" }> {
  await assertO2MigrationAuthority(database);
  const existing = await readReplayRow(database, claim.idempotency_key);
  if (existing === null) return { state: "ABSENT" };
  if (!replayMatches(existing, claim)) return { state: "CONFLICT" };
  return {
    state: "REPLAY",
    persisted: { intent_digest: existing.intent_digest, receipt_json: existing.receipt_json, draft_json: existing.draft_json, attempt_json: existing.attempt_json },
  };
}

export function parsePersistedEpochReplay(persisted: PersistedEpochReplay, idempotencyKey: string): { readonly receipt: OperationReceipt; readonly attempt: OperationAttempt } {
  let receipt: OperationReceipt;
  let attempt: OperationAttempt;
  try {
    receipt = OperationReceiptSchema.parse(JSON.parse(persisted.receipt_json) as unknown);
    attempt = OperationAttemptSchema.parse(JSON.parse(persisted.attempt_json) as unknown);
  } catch (cause) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup replay bytes are corrupt", false, { intent: idempotencyKey }, cause);
  }
  return { receipt, attempt };
}

export async function claimEpochReceipt(
  database: D1Database,
  claim: EpochReplayClaim,
  persisted: PersistedEpochReplay,
  now: string,
): Promise<{ readonly replayed: boolean; readonly persisted: PersistedEpochReplay }> {
  await assertO2MigrationAuthority(database);
  if (claim.intent_digest.length !== 64 || claim.vector_digest.length !== 64 || claim.manifest_digest.length !== 64) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup replay claim carries no complete authority digest", false, { intent: claim.idempotency_key });
  }
  parsePersistedEpochReplay(persisted, claim.idempotency_key);
  try {
    await database.prepare(
      "INSERT INTO backup_epoch_receipt (idempotency_key, intent_id, intent_digest, vector_digest, manifest_digest, epoch_id, receipt_json, draft_json, attempt_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    ).bind(claim.idempotency_key, claim.intent_id, claim.intent_digest, claim.vector_digest, claim.manifest_digest, claim.epoch_id, persisted.receipt_json, persisted.draft_json, persisted.attempt_json, now).run();
    return { replayed: false, persisted };
  } catch {
    // PK conflict: another process/port already claimed this key. Reopen and
    // reconcile exactly; never overwrite.
  }
  const existing = await readReplayRow(database, claim.idempotency_key);
  if (existing === null) failBackup("BACKUP_TABLE_MISSING", "backup replay authority lost a concurrent claim", true, { intent: claim.idempotency_key });
  if (!replayMatches(existing, claim)) {
    failBackup("BACKUP_INTENT_CONFLICT", "backup intent reuses an identity with divergent content", false, { intent_id: claim.intent_id });
  }
  return {
    replayed: true,
    persisted: { intent_digest: existing.intent_digest, receipt_json: existing.receipt_json, draft_json: existing.draft_json, attempt_json: existing.attempt_json },
  };
}

export async function readCommittedEpochReceipt(database: D1Database, idempotencyKey: string): Promise<OperationReceipt | null> {
  await assertO2MigrationAuthority(database);
  const existing = await readReplayRow(database, idempotencyKey);
  if (existing === null) return null;
  return parseReplayReceipt(existing, idempotencyKey);
}

// Epoch lookup by epoch id for caller-draft verification (copy/expiry must use
// D1-persisted draft bytes, never caller bytes).
export async function readEpochDraftById(database: D1Database, epochId: string): Promise<{ readonly idempotency_key: string; readonly draft_json: string } | null> {
  await assertO2MigrationAuthority(database);
  let row: { readonly idempotency_key: string; readonly draft_json: string } | null;
  try {
    row = await database.prepare(
      "SELECT idempotency_key, draft_json FROM backup_epoch_receipt WHERE epoch_id = ?1 ORDER BY created_at LIMIT 1",
    ).bind(epochId).first<{ readonly idempotency_key: string; readonly draft_json: string }>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup epoch lookup is unavailable", true, {}, cause);
  }
  return row;
}
