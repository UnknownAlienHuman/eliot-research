import type { OperationIntent } from "@eliotr/contracts";
import { assertBackupIdentifier, assertBackupIntent, backupAborted, failBackup, canonicalBackupJson } from "./shared.js";
import type { BackupEpochDraft } from "./epoch.js";
import type { OffsiteCopyAdapter } from "./offsite.js";
import { destinationDescriptorDigest, reconcileDestinationDescriptor, type BackupDestinationPolicy } from "./destination-policy.js";
import { requireDestinationAuthority } from "./destination-authority.js";
import { readBlockingHoldAuthority } from "./hold-authority.js";
import { readEpochDraftById } from "./replay-authority.js";
import { assertO2MigrationAuthority } from "./migration-gate.js";
import { resolveControllerClock, backupIsoNow } from "./offsite-durability.js";

// ER-34 O2 FIX3 offsite-copy expiry lifecycle authority only (not O4).
//
// Gating: expiry is authorized against D1-authoritative state, never caller
// timestamps or caller draft bytes. The epoch draft must equal the
// D1-persisted draft, expires_at comes from the D1-persisted copy success
// receipt, and the caller policy must equal the controller-owned AUTHORIZED
// authority (FIX3: same-or-stricter than copy, so revoked or rotated grants
// refuse instead of deleting). The live adapter descriptor must reproduce the
// copy-time descriptor identity (destination, failure domain, deletion/expiry
// and journal capabilities, retention-lock and legal-hold state) and reconcile
// against the approved policy with the primary failure domain before the first
// deletion: same-ID substitution, capability drift, primary-domain squatting,
// retention/hold/lock drift and policy rotation each fail closed with zero
// deletes. Controller-owned current holds are read through the fail-closed
// hold authority: missing, unreadable or ambiguous hold state refuses before
// any remote deletion. The caller clock beyond skew fails closed.
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

function partRefFor(epochId: string, manifest: string, index: number, sha256: string): string {
  return `offsite/${epochId}/${manifest}/${String(index).padStart(6, "0")}-${sha256}`;
}

interface CopyAuthorityRow {
  readonly policy_digest: string;
  readonly descriptor_digest: string;
  readonly failure_domain: string;
  readonly authority_authorized_at: string;
  readonly expires_at: string;
}

async function findCopyAuthorityForEpoch(database: D1Database, epochId: string, destinationId: string): Promise<readonly CopyAuthorityRow[]> {
  let rows: readonly CopyAuthorityRow[];
  try {
    const result = await database.prepare(
      "SELECT policy_digest, descriptor_digest, failure_domain, authority_authorized_at, expires_at FROM backup_offsite_copy_receipt WHERE epoch_id = ?1 AND destination_id = ?2 ORDER BY created_at",
    ).bind(epochId, destinationId).all<CopyAuthorityRow>();
    rows = [...(result.results ?? [])];
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup copy success authority is unavailable", true, {}, cause);
  }
  return rows;
}

export async function expireOffsiteCopy(input: {
  readonly core_db: D1Database;
  readonly draft: BackupEpochDraft;
  readonly intent: OperationIntent;
  readonly expiry: ExpiryIntent;
  readonly destination_policy: BackupDestinationPolicy;
  readonly primary_failure_domain: string;
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
  const primaryDomain = assertBackupIdentifier(input.primary_failure_domain, "primary failure domain");
  const clockMs = resolveControllerClock(input.now_ms);
  const now = backupIsoNow(clockMs);
  if (backupAborted(input.signal)) failBackup("BACKUP_CANCELLED", "backup expiry was cancelled", true);
  await assertO2MigrationAuthority(input.core_db);
  // Controller authority: caller policy must equal the persisted AUTHORIZED
  // grant for (destination, initiating principal, policy decision). Revoked or
  // rotated grants refuse: deletion never proceeds under stale authority.
  const authority = await requireDestinationAuthority(input.core_db, input.intent, input.destination_policy);
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
  // D1-authoritative expiry: copy receipts bound to this epoch and destination,
  // never caller draft bytes or caller timestamps. At least one receipt must
  // reproduce the live controller policy generation and the live descriptor
  // identity; any D1-vs-D1 divergence fails closed as corruption or drift.
  const candidates = await findCopyAuthorityForEpoch(input.core_db, epochId, authority.destination_id);
  if (candidates.length === 0) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "no D1-authoritative offsite copy exists for this epoch and destination; refusing expiry of uncopied state");
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
  // Full destination-policy reconciliation BEFORE the first deletion,
  // same-or-stricter than offsite creation: live descriptor identity must equal
  // a D1 copy-time receipt bound to the live controller policy generation.
  const descriptor = await input.adapter.describe();
  const liveDescriptorDigest = await destinationDescriptorDigest(descriptor);
  const authoritative = candidates.find((row) =>
    row.policy_digest === authority.policy_digest
    && row.authority_authorized_at === authority.authorized_at
    && row.descriptor_digest === liveDescriptorDigest
    && row.failure_domain === authority.policy.failure_domain
    && row.failure_domain === descriptor.failure_domain,
  );
  if (authoritative === undefined) {
    failBackup("BACKUP_DESTINATION_POLICY_MISMATCH", "no D1 copy authority matches the live controller policy generation and descriptor identity; refusing expiry across policy, generation or descriptor drift", false, {});
  }
  if (authoritative.expires_at !== persistedDraft.expires_at) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "D1 copy authority expires_at disagrees with the persisted epoch draft", false, {});
  }
  reconcileDestinationDescriptor(authority.policy, descriptor, primaryDomain);
  // Fail-closed hold authority BEFORE any remote deletion: only an
  // authoritative CLEAR proceeds; missing/unreadable/ambiguous refuses.
  const holdRef = await readBlockingHoldAuthority(input.core_db, epochId);
  if (descriptor.retention_locked || authority.policy.retention_locked || descriptor.legal_hold_ref !== undefined || authority.policy.legal_hold_ref !== undefined || holdRef !== null) {
    const blocked: ExpiryReceipt = {
      expiry_intent_key: expiryKey, epoch_id: epochId, destination_id: authority.destination_id,
      journal_refs: [], state: "BLOCKED", absent_parts: 0, created_at: now,
    };
    try {
      await input.core_db.prepare(
        "INSERT INTO backup_offsite_expiry (expiry_intent_key, epoch_id, destination_id, journal_refs_json, state, absent_parts, failure_domain, descriptor_digest, policy_digest, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
      ).bind(expiryKey, epochId, authority.destination_id, JSON.stringify(blocked.journal_refs), blocked.state, blocked.absent_parts, descriptor.failure_domain, liveDescriptorDigest, authority.policy_digest, now).run();
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
      "INSERT INTO backup_offsite_expiry (expiry_intent_key, epoch_id, destination_id, journal_refs_json, state, absent_parts, failure_domain, descriptor_digest, policy_digest, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    ).bind(expiryKey, epochId, authority.destination_id, JSON.stringify(journalRefs), receipt.state, receipt.absent_parts, descriptor.failure_domain, liveDescriptorDigest, authority.policy_digest, now).run();
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
