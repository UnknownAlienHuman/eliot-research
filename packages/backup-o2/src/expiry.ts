import type { OperationIntent } from "@eliotr/contracts";
import { assertBackupIdentifier, assertBackupIntent, backupAborted, failBackup, canonicalBackupJson } from "./shared.js";
import type { BackupEpochDraft } from "./epoch.js";
import type { OffsiteCopyAdapter } from "./offsite.js";
import type { BackupDestinationPolicy } from "./destination-policy.js";
import { requireDestinationAuthority } from "./destination-authority.js";
import { readEpochDraftById } from "./replay-authority.js";
import { assertO2MigrationAuthority } from "./migration-gate.js";
import { resolveControllerClock, backupIsoNow } from "./offsite-durability.js";

// ER-34 O2 FIX2 offsite-copy expiry lifecycle authority only (not O4).
//
// Gating: expiry is authorized against D1-authoritative state, never caller
// timestamps or caller draft bytes. The epoch draft must equal the
// D1-persisted draft, expires_at comes from the D1-persisted copy success
// receipt, and the destination policy must equal the controller-owned
// authority (revoked authorities still permit deletion: deletion is safe, but
// still policy-pinned). Controller-owned current holds referencing this epoch
// or the backup path block auditably. The caller clock beyond skew fails
// closed, so a 2030 expiry can no longer be accepted in 2026 on a forged
// caller timestamp.
//
// Terminal replay re-proves absence of EVERY remote part via adapter get; any
// reappeared part is BACKUP_RESURRECTION_REFUSED, never DELETED while a part
// is present. Replays return persisted bytes verbatim (including created_at).

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

interface ExpiryRow {
  readonly journal_refs_json: string;
  readonly state: "DELETED" | "BLOCKED";
  readonly absent_parts: number;
  readonly epoch_id: string;
  readonly destination_id: string;
  readonly created_at: string;
}

async function readExpiryRow(database: D1Database, expiryKey: string): Promise<ExpiryRow | null> {
  let row: ExpiryRow | null;
  try {
    row = await database.prepare(
      "SELECT journal_refs_json, state, absent_parts, epoch_id, destination_id, created_at FROM backup_offsite_expiry WHERE expiry_intent_key = ?1",
    ).bind(expiryKey).first<ExpiryRow>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup expiry read is unavailable", true, {}, cause);
  }
  return row;
}

function parseExpiryRow(row: ExpiryRow, expiryKey: string): ExpiryReceipt {
  let journalRefs: readonly string[];
  try {
    const parsed: unknown = JSON.parse(row.journal_refs_json);
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) throw new Error("malformed journal refs");
    journalRefs = parsed;
  } catch (cause) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup expiry receipt is corrupt", false, {}, cause);
  }
  if (row.state !== "DELETED" && row.state !== "BLOCKED") failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup expiry receipt carries an unknown state", false, {});
  return {
    expiry_intent_key: expiryKey, epoch_id: row.epoch_id, destination_id: row.destination_id,
    journal_refs: journalRefs, state: row.state, absent_parts: row.absent_parts, created_at: row.created_at,
  };
}

// Controller-owned current holds that pin this epoch or the backup path.
async function readBlockingHold(database: D1Database, epochId: string): Promise<string | null> {
  let rows: readonly { readonly hold_ref: unknown; readonly exact_subject_ref: unknown; readonly location: unknown; readonly canonical_ref: unknown }[];
  try {
    const result = await database.prepare(
      "SELECT hold_ref, exact_subject_ref, location, canonical_ref FROM erasure_hold WHERE state = 'ACTIVE'",
    ).all<{ readonly hold_ref: unknown; readonly exact_subject_ref: unknown; readonly location: unknown; readonly canonical_ref: unknown }>();
    rows = [...(result.results ?? [])];
  } catch {
    return null;
  }
  for (const row of rows) {
    if (row.exact_subject_ref === epochId || row.canonical_ref === epochId) return typeof row.hold_ref === "string" ? row.hold_ref : "unknown-hold";
    if (row.location === "BackupRestorePath") return typeof row.hold_ref === "string" ? row.hold_ref : "unknown-hold";
  }
  return null;
}

function partRefFor(epochId: string, manifest: string, index: number, sha256: string): string {
  return `offsite/${epochId}/${manifest}/${String(index).padStart(6, "0")}-${sha256}`;
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
  const clockMs = resolveControllerClock(input.now_ms);
  const now = backupIsoNow(clockMs);
  if (backupAborted(input.signal)) failBackup("BACKUP_CANCELLED", "backup expiry was cancelled", true);
  await assertO2MigrationAuthority(input.core_db);
  // Controller authority: caller policy must equal the persisted grant.
  // Revoked grants still permit deletion (safe) but stay policy-pinned.
  const authority = await requireDestinationAuthority(input.core_db, input.intent, input.destination_policy, { allow_revoked: true });
  // Caller draft bytes are never trusted: resolve the D1-persisted epoch.
  const persistedEpoch = await readEpochDraftById(input.core_db, epochId);
  if (persistedEpoch === null) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup epoch is unknown to D1 replay authority; caller drafts never authorize expiry");
  if (canonicalBackupJson(JSON.parse(JSON.stringify(input.draft)) as unknown) !== canonicalBackupJson(JSON.parse(persistedEpoch.draft_json) as unknown)) {
    failBackup("BACKUP_INTENT_CONFLICT", "caller epoch draft diverges from D1-persisted bytes", false, {});
  }
  let persistedDraft: BackupEpochDraft;
  try {
    persistedDraft = JSON.parse(persistedEpoch.draft_json) as BackupEpochDraft;
  } catch (cause) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "D1-persisted epoch draft is corrupt", false, {}, cause);
  }
  // D1-authoritative expiry: the success receipt's expires_at, never caller
  // timestamps or stale caller receipts. It must agree with the persisted
  // epoch draft; any D1-vs-D1 divergence fails closed as corruption.
  const authoritative = await findCopyReceiptForEpoch(input.core_db, epochId, authority.destination_id);
  if (authoritative === null) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "no D1-authoritative offsite copy exists for this epoch and destination; refusing expiry of uncopied state");
  if (authoritative.expires_at !== persistedDraft.expires_at) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "D1 copy authority expires_at disagrees with the persisted epoch draft", false, {});
  }
  const existing = await readExpiryRow(input.core_db, expiryKey);
  if (existing !== null) {
    if (existing.epoch_id !== epochId || existing.destination_id !== authority.destination_id) {
      failBackup("BACKUP_INTENT_CONFLICT", "expiry intent reuses an identity with divergent content", false, { intent_id: expiryKey });
    }
    const persisted = parseExpiryRow(existing, expiryKey);
    if (persisted.state === "DELETED") {
      // Terminal replay re-proves absence of EVERY remote part. A reappeared
      // part is resurrection, never DELETED while present.
      for (const part of persistedDraft.part_index) {
        const ref = partRefFor(epochId, part.manifest, part.index, part.sha256);
        let remote: { readonly ciphertext: Uint8Array } | null;
        try {
          remote = await input.adapter.get(ref);
        } catch (cause) {
          failBackup("BACKUP_OBJECT_UNREADABLE", "offsite absence re-proof is unavailable on replay", true, {}, cause);
        }
        if (remote !== null) {
          failBackup("BACKUP_RESURRECTION_REFUSED", "offsite part reappeared after terminal expiry; resurrection refused", false, {});
        }
      }
    }
    return persisted;
  }
  const descriptor = await input.adapter.describe();
  if (descriptor.destination_id !== authority.destination_id) {
    failBackup("BACKUP_DESTINATION_POLICY_MISMATCH", "expiry adapter destination disagrees with controller authority", false, {});
  }
  const holdRef = await readBlockingHold(input.core_db, epochId);
  if (descriptor.retention_locked || authority.policy.retention_locked || descriptor.legal_hold_ref !== undefined || authority.policy.legal_hold_ref !== undefined || holdRef !== null) {
    const blocked: ExpiryReceipt = {
      expiry_intent_key: expiryKey, epoch_id: epochId, destination_id: authority.destination_id,
      journal_refs: [], state: "BLOCKED", absent_parts: 0, created_at: now,
    };
    try {
      await input.core_db.prepare(
        "INSERT INTO backup_offsite_expiry (expiry_intent_key, epoch_id, destination_id, journal_refs_json, state, absent_parts, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      ).bind(expiryKey, epochId, authority.destination_id, JSON.stringify(blocked.journal_refs), blocked.state, blocked.absent_parts, now).run();
    } catch (cause) {
      failBackup("BACKUP_TABLE_MISSING", "backup expiry commit is unavailable", true, {}, cause);
    }
    throw Object.assign(new Error("offsite expiry blocked by retention lock, legal hold, or controller hold; nothing deleted"), { code: "BACKUP_EXPIRY_BLOCKED" });
  }
  const journalRefs: string[] = [];
  for (const part of persistedDraft.part_index) {
    if (backupAborted(input.signal)) failBackup("BACKUP_CANCELLED", "backup expiry was cancelled", true);
    const partRef = partRefFor(epochId, part.manifest, part.index, part.sha256);
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
    expiry_intent_key: expiryKey, epoch_id: epochId, destination_id: authority.destination_id,
    journal_refs: journalRefs, state: "DELETED", absent_parts: persistedDraft.part_index.length, created_at: now,
  };
  try {
    await input.core_db.prepare(
      "INSERT INTO backup_offsite_expiry (expiry_intent_key, epoch_id, destination_id, journal_refs_json, state, absent_parts, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    ).bind(expiryKey, epochId, authority.destination_id, JSON.stringify(journalRefs), receipt.state, receipt.absent_parts, now).run();
  } catch {
    const raced = await readExpiryRow(input.core_db, expiryKey);
    if (raced === null) failBackup("BACKUP_TABLE_MISSING", "backup expiry commit lost", true, {});
    if (raced.epoch_id !== epochId || raced.destination_id !== authority.destination_id) {
      failBackup("BACKUP_INTENT_CONFLICT", "expiry intent reuses an identity with divergent content", false, {});
    }
    return parseExpiryRow(raced, expiryKey);
  }
  return receipt;
}

async function findCopyReceiptForEpoch(database: D1Database, epochId: string, destinationId: string): Promise<{ readonly expires_at: string } | null> {
  let row: { readonly expires_at: string } | null;
  try {
    row = await database.prepare(
      "SELECT expires_at FROM backup_offsite_copy_receipt WHERE epoch_id = ?1 AND destination_id = ?2 ORDER BY created_at LIMIT 1",
    ).bind(epochId, destinationId).first<{ readonly expires_at: string }>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup copy success authority is unavailable", true, {}, cause);
  }
  return row;
}
