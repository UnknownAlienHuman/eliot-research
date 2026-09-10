import type { OperationIntent } from "@eliotr/contracts";
import { assertBackupIdentifier, assertBackupIntent, backupAborted, backupIsoDateTime, failBackup } from "./shared.js";
import type { BackupEpochDraft } from "./epoch.js";
import type { OffsiteCopyAdapter } from "./offsite.js";
import type { BackupDestinationPolicy } from "./destination-policy.js";

// ER-34 O2 offsite-copy expiry lifecycle authority only (not O4). Durable
// delete intent/receipt, bounded delete attempt, read-after-delete absence
// proof, terminal journal/status reconciliation, replay/lost-ACK behavior and
// resurrection prevention for the same immutable ref.

export interface ExpiryIntent {
  readonly expiry_intent_key: string;
  readonly epoch_id: string;
  readonly reason: string;
}

export interface ExpiryReceipt {
  readonly expiry_intent_key: string;
  readonly epoch_id: string;
  readonly destination_id: string;
  readonly journal_refs: readonly string[];
  readonly state: "DELETED" | "BLOCKED";
  readonly absent_parts: number;
  readonly created_at: string;
}

export async function expireOffsiteCopy(input: {
  readonly core_db: D1Database;
  readonly draft: BackupEpochDraft;
  readonly intent: OperationIntent;
  readonly expiry: ExpiryIntent;
  readonly destination_policy: BackupDestinationPolicy;
  readonly adapter: OffsiteCopyAdapter;
  readonly signal?: AbortSignal;
  readonly now_ms?: number;
}): Promise<ExpiryReceipt> {
  const opIntent = assertBackupIntent(input.intent);
  void opIntent;
  const expiryKey = assertBackupIdentifier(input.expiry.expiry_intent_key, "expiry intent key");
  const epochId = assertBackupIdentifier(input.expiry.epoch_id, "expiry epoch");
  if (epochId !== input.draft.epoch_id) failBackup("BACKUP_INPUT_INVALID", "expiry epoch does not match the audited draft");
  const reason = assertBackupIdentifier(input.expiry.reason, "expiry reason");
  void reason;
  const nowMs = input.now_ms ?? Date.now();
  const now = backupIsoDateTime(nowMs);
  if (backupAborted(input.signal)) failBackup("BACKUP_CANCELLED", "backup expiry was cancelled", true);
  try {
    await input.core_db.prepare(
      "CREATE TABLE IF NOT EXISTS backup_offsite_expiry (expiry_intent_key TEXT PRIMARY KEY, epoch_id TEXT NOT NULL, destination_id TEXT NOT NULL, journal_refs_json TEXT NOT NULL CHECK (json_valid(journal_refs_json)), state TEXT NOT NULL CHECK (state IN ('DELETED','BLOCKED')), created_at TEXT NOT NULL) STRICT",
    ).run();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup expiry authority is unavailable", true, {}, cause);
  }
  let existing: { readonly journal_refs_json: unknown; readonly state: unknown; readonly epoch_id: unknown; readonly destination_id: unknown } | null;
  try {
    existing = await input.core_db.prepare(
      "SELECT journal_refs_json, state, epoch_id, destination_id FROM backup_offsite_expiry WHERE expiry_intent_key = ?1",
    ).bind(expiryKey).first<{ readonly journal_refs_json: unknown; readonly state: unknown; readonly epoch_id: unknown; readonly destination_id: unknown }>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup expiry read is unavailable", true, {}, cause);
  }
  if (existing !== null) {
    if (existing.epoch_id !== epochId || existing.destination_id !== input.destination_policy.destination_id) {
      failBackup("BACKUP_INTENT_CONFLICT", "expiry intent reuses an identity with divergent content", false, { intent_id: expiryKey });
    }
    return {
      expiry_intent_key: expiryKey, epoch_id: epochId,
      destination_id: input.destination_policy.destination_id,
      journal_refs: JSON.parse(existing.journal_refs_json as string) as readonly string[],
      state: existing.state as "DELETED" | "BLOCKED",
      absent_parts: input.draft.part_index.length,
      created_at: now,
    };
  }
  const descriptor = await input.adapter.describe();
  if (descriptor.destination_id !== input.destination_policy.destination_id) {
    failBackup("BACKUP_DESTINATION_POLICY_MISMATCH", "expiry adapter destination disagrees with approved policy", false, {});
  }
  if (descriptor.retention_locked || input.destination_policy.retention_locked || descriptor.legal_hold_ref !== undefined || input.destination_policy.legal_hold_ref !== undefined) {
    const blocked: ExpiryReceipt = {
      expiry_intent_key: expiryKey, epoch_id: epochId, destination_id: descriptor.destination_id,
      journal_refs: [], state: "BLOCKED", absent_parts: 0, created_at: now,
    };
    try {
      await input.core_db.prepare(
        "INSERT INTO backup_offsite_expiry (expiry_intent_key, epoch_id, destination_id, journal_refs_json, state, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      ).bind(expiryKey, epochId, descriptor.destination_id, JSON.stringify(blocked.journal_refs), blocked.state, now).run();
    } catch (cause) {
      failBackup("BACKUP_TABLE_MISSING", "backup expiry commit is unavailable", true, {}, cause);
    }
    throw Object.assign(new Error("offsite expiry blocked by retention lock or legal hold; nothing deleted"), { code: "BACKUP_EXPIRY_BLOCKED" });
  }
  const journalRefs: string[] = [];
  for (const part of input.draft.part_index) {
    if (backupAborted(input.signal)) failBackup("BACKUP_CANCELLED", "backup expiry was cancelled", true);
    const partRef = `offsite/${input.draft.epoch_id}/${part.manifest}/${String(part.index).padStart(6, "0")}-${part.sha256}`;
    let journalRef: string;
    try {
      journalRef = (await input.adapter.delete(partRef, `expiry:${expiryKey}`)).journal_ref;
    } catch (cause) {
      failBackup("BACKUP_OBJECT_UNREADABLE", "offsite expiry delete attempt failed", true, {}, cause);
    }
    journalRefs.push(journalRef);
    const after = await input.adapter.get(partRef);
    if (after !== null) failBackup("BACKUP_EXPIRY_ABSENCE_UNPROVEN", "offsite part remains after expiry delete; absence unproven", true, {});
  }
  const receipt: ExpiryReceipt = {
    expiry_intent_key: expiryKey, epoch_id: epochId, destination_id: descriptor.destination_id,
    journal_refs: journalRefs, state: "DELETED", absent_parts: input.draft.part_index.length, created_at: now,
  };
  try {
    await input.core_db.prepare(
      "INSERT INTO backup_offsite_expiry (expiry_intent_key, epoch_id, destination_id, journal_refs_json, state, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    ).bind(expiryKey, epochId, descriptor.destination_id, JSON.stringify(journalRefs), receipt.state, now).run();
  } catch {
    const raced = await input.core_db.prepare(
      "SELECT journal_refs_json, state FROM backup_offsite_expiry WHERE expiry_intent_key = ?1",
    ).bind(expiryKey).first<{ readonly journal_refs_json: string; readonly state: "DELETED" | "BLOCKED" }>();
    if (raced === null) failBackup("BACKUP_TABLE_MISSING", "backup expiry commit lost", true, {});
    if (JSON.stringify(journalRefs) !== raced.journal_refs_json) failBackup("BACKUP_INTENT_CONFLICT", "expiry intent reuses an identity with divergent content", false, {});
    return { ...receipt, journal_refs: JSON.parse(raced.journal_refs_json) as readonly string[], state: raced.state };
  }
  return receipt;
}
