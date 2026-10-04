import { createD1ErasureRestoreFenceStore } from "@eliotr/cloudflare-erasure";
import {
  backupSha256Hex,
  canonicalBackupJson,
  failBackup,
  type BackupEpochDraft,
} from "@eliotr/backup-o2";
import type {
  IsolatedRestorePreflight,
} from "./isolated-restore-preflight.js";
import type {
  RestoreBackupObligationAttestation,
  RestoreErasureFence,
  RestoreErasureGate,
} from "./restore-executor.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_ROWS = 100_000;
const SCOPE_MANIFESTS = ["ownership", "sources", "revisions", "scopes", "handles", "heads"] as const;
const ERASURE_TARGET_KINDS = new Set(["OBJECT", "LOCATION_EMPTY_PROOF"]);
const ERASURE_TARGET_LOCATIONS = new Set([
  "CanonicalPayload", "Projection", "Index", "Blob", "OperationalRecovery", "ProviderCopy",
  "BackupRestorePath", "RouteContinuation",
]);
const ERASURE_TARGET_STATES = new Set(["ENUMERATED", "QUARANTINED", "BLOCKED", "PURGE_REQUESTED", "ABSENT", "FAILED"]);

interface PurgeRow extends Record<string, unknown> {
  readonly ledger_revision: unknown;
  readonly erasure_id: unknown;
  readonly non_revealing_subject_digest: unknown;
  readonly disposition: unknown;
  readonly receipt_ref: unknown;
  readonly created_at: unknown;
}

interface ErasureRow {
  readonly erasure_id: unknown;
  readonly revision: unknown;
  readonly state: unknown;
  readonly terminal_receipt_sha256: unknown;
  readonly guard_state: unknown;
  readonly guard_receipt_sha256: unknown;
  readonly guard_verified: unknown;
  readonly non_absent_targets: unknown;
}

interface BackupPurgeRow {
  readonly erasure_id: unknown;
  readonly erasure_revision: unknown;
  readonly backup_epoch_id: unknown;
  readonly target_id: unknown;
  readonly revision: unknown;
  readonly erasure_state: unknown;
  readonly state: unknown;
  readonly delete_receipt_ref: unknown;
  readonly absence_receipt_ref: unknown;
  readonly policy_or_hold_ref: unknown;
  readonly target_kind: unknown;
  readonly location: unknown;
  readonly canonical_ref: unknown;
  readonly target_state: unknown;
}

interface ReplayObligationRow {
  readonly erasure_id: unknown;
  readonly erasure_revision: unknown;
  readonly backup_epoch_id: unknown;
  readonly copy_id: unknown;
  readonly target_id: unknown;
  readonly expiry_intent_key: unknown;
  readonly state: unknown;
  readonly reason_code: unknown;
  readonly receipt_json: unknown;
  readonly authority_epoch_id: unknown;
  readonly authority_state: unknown;
  readonly authority_destination_id: unknown;
  readonly execution_revision: unknown;
  readonly execution_state: unknown;
  readonly target_kind: unknown;
  readonly location: unknown;
  readonly canonical_ref: unknown;
  readonly target_state: unknown;
}

interface PurgeFrontier {
  readonly revision: number;
  readonly digest: string;
  readonly blocked_count: number;
  readonly rows: readonly Record<string, unknown>[];
}

interface ReconciledInventory {
  readonly terminal_erasure_targets_verified: true;
  readonly unsettled_erasure_count: 0;
  readonly erasure_rows: readonly Record<string, unknown>[];
  readonly obligations: readonly RestoreBackupObligationAttestation[];
  readonly obligation_digest: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkedAll<T>(result: D1Result<T>, label: string): readonly T[] {
  if (result?.success !== true || !Array.isArray(result.results) || result.results.length > MAX_ROWS) {
    failBackup("BACKUP_TABLE_MISSING", `${label} returned an unsuccessful, malformed, or oversized result`, true);
  }
  return result.results;
}

async function readPurgeFrontier(database: D1Database): Promise<PurgeFrontier> {
  let result: D1Result<PurgeRow>;
  try {
    result = await database.prepare(
      "SELECT ledger_revision,erasure_id,non_revealing_subject_digest,disposition,receipt_ref,created_at " +
      "FROM purge_ledger ORDER BY ledger_revision LIMIT ?1",
    ).bind(MAX_ROWS + 1).all<PurgeRow>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "current purge ledger is unavailable under the restore fence", true, {}, cause);
  }
  const rows = checkedAll(result, "current purge ledger");
  if (rows.length > MAX_ROWS) failBackup("BACKUP_BOUND_EXCEEDED", "current purge ledger exceeds the restore bound");
  let revision = 0;
  let blockedCount = 0;
  const canonicalRows: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (!Number.isSafeInteger(row.ledger_revision) || (row.ledger_revision as number) < 1 ||
        typeof row.erasure_id !== "string" || typeof row.non_revealing_subject_digest !== "string" ||
        !SHA256.test(row.non_revealing_subject_digest) ||
        (row.disposition !== "COMPLETE" && row.disposition !== "BLOCKED") ||
        typeof row.receipt_ref !== "string" || row.receipt_ref.length === 0 ||
        typeof row.created_at !== "string" || row.created_at.length === 0) {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", "current purge ledger contains a malformed row");
    }
    revision = Math.max(revision, row.ledger_revision as number);
    if (row.disposition === "BLOCKED") blockedCount += 1;
    canonicalRows.push({
      ledger_revision: row.ledger_revision,
      erasure_id: row.erasure_id,
      non_revealing_subject_digest: row.non_revealing_subject_digest,
      disposition: row.disposition,
      receipt_ref: row.receipt_ref,
      created_at: row.created_at,
    });
  }
  return {
    revision,
    digest: await backupSha256Hex(canonicalRows.map(canonicalBackupJson).join("\n")),
    blocked_count: blockedCount,
    rows: canonicalRows,
  };
}

function optionalRef(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) failBackup("BACKUP_VECTOR_UNVERIFIABLE", `${label} is malformed`);
  return value;
}

async function readErasureInventory(database: D1Database, epochId: string): Promise<ReconciledInventory> {
  let result: D1Result<ErasureRow>;
  try {
    result = await database.prepare(
      "SELECT e.erasure_id,e.revision,e.state,e.terminal_receipt_sha256," +
      "g.terminal_state AS guard_state,g.receipt_sha256 AS guard_receipt_sha256,g.verified AS guard_verified," +
      "(SELECT COUNT(*) FROM erasure_target t WHERE t.erasure_id=e.erasure_id AND " +
      "t.erasure_revision=e.revision AND t.state<>'ABSENT') AS non_absent_targets " +
      "FROM erasure_execution e LEFT JOIN erasure_terminal_guard g " +
      "ON g.erasure_id=e.erasure_id AND g.erasure_revision=e.revision " +
      "ORDER BY e.erasure_id,e.revision LIMIT ?1",
    ).bind(MAX_ROWS + 1).all<ErasureRow>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "erasure terminal-target inventory is unavailable", true, {}, cause);
  }
  const erasures = checkedAll(result, "erasure terminal-target inventory");
  if (erasures.length > MAX_ROWS) failBackup("BACKUP_BOUND_EXCEEDED", "erasure terminal-target inventory exceeds the restore bound");
  let unsettled = 0;
  const erasureRows: Record<string, unknown>[] = [];
  for (const row of erasures) {
    if (typeof row.erasure_id !== "string" || row.erasure_id.length === 0 ||
        !Number.isSafeInteger(row.revision) || (row.revision as number) < 1 || typeof row.state !== "string" ||
        !Number.isSafeInteger(row.non_absent_targets) || (row.non_absent_targets as number) < 0) {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", "erasure terminal-target inventory contains a malformed row");
    }
    if (row.state !== "COMPLETE") unsettled += 1;
    if (row.state === "COMPLETE" &&
        (!SHA256.test(String(row.terminal_receipt_sha256 ?? "")) || row.guard_state !== "COMPLETE" ||
         row.guard_receipt_sha256 !== row.terminal_receipt_sha256 || row.guard_verified !== 1 || row.non_absent_targets !== 0)) {
      failBackup("BACKUP_PURGE_BLOCKED", "a COMPLETE erasure lacks exact terminal-target absence readback");
    }
    if ((row.state === "BLOCKED" && row.guard_state !== "BLOCKED") ||
        (row.state === "FAILED" && row.guard_state !== null)) {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", "erasure terminal guard diverges from its canonical execution state");
    }
    erasureRows.push({
      erasure_id: row.erasure_id,
      revision: row.revision,
      state: row.state,
      terminal_receipt_sha256: row.terminal_receipt_sha256,
      guard_state: row.guard_state,
      guard_receipt_sha256: row.guard_receipt_sha256,
      guard_verified: row.guard_verified,
      non_absent_targets: row.non_absent_targets,
    });
  }
  if (unsettled !== 0) failBackup("BACKUP_PURGE_BLOCKED", "restore is blocked until every current O4 erasure is COMPLETE");

  let backupResult: D1Result<BackupPurgeRow>;
  try {
    backupResult = await database.prepare(
      "SELECT o.erasure_id,o.erasure_revision,o.backup_epoch_id,o.target_id,o.state," +
      "o.delete_receipt_ref,o.absence_receipt_ref,o.policy_or_hold_ref,t.target_kind,t.location,t.canonical_ref,t.state AS target_state," +
      "e.revision AS revision,e.state AS erasure_state " +
      "FROM backup_purge_obligation o LEFT JOIN erasure_target t ON t.erasure_id=o.erasure_id " +
      "AND t.erasure_revision=o.erasure_revision AND t.target_id=o.target_id " +
      "LEFT JOIN erasure_execution e ON e.erasure_id=o.erasure_id AND e.revision=o.erasure_revision " +
      "WHERE o.backup_epoch_id=?1 ORDER BY o.erasure_id,o.erasure_revision,o.target_id LIMIT ?2",
    ).bind(epochId, MAX_ROWS + 1).all<BackupPurgeRow>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup purge-obligation inventory is unavailable", true, {}, cause);
  }
  const backupRows = checkedAll(backupResult, "backup purge-obligation inventory");
  if (backupRows.length > MAX_ROWS) failBackup("BACKUP_BOUND_EXCEEDED", "backup purge-obligation inventory exceeds the restore bound");
  const obligations: RestoreBackupObligationAttestation[] = [];
  for (const row of backupRows) {
    if (typeof row.erasure_id !== "string" || row.erasure_id.length === 0 ||
        !Number.isSafeInteger(row.erasure_revision) || (row.erasure_revision as number) < 1 ||
        row.backup_epoch_id !== epochId || typeof row.target_id !== "string" || row.target_id.length === 0 ||
        (row.state !== "PENDING" && row.state !== "BLOCKED" && row.state !== "ABSENT") ||
        typeof row.target_kind !== "string" || !ERASURE_TARGET_KINDS.has(row.target_kind) ||
        typeof row.location !== "string" || !ERASURE_TARGET_LOCATIONS.has(row.location) ||
        typeof row.canonical_ref !== "string" || row.canonical_ref.length === 0 ||
        typeof row.target_state !== "string" || !Number.isSafeInteger(row.revision) || row.revision !== row.erasure_revision ||
        !ERASURE_TARGET_STATES.has(row.target_state) ||
        row.erasure_state !== "COMPLETE") {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup purge obligation is malformed or not bound to the exact epoch and target");
    }
    const deleteReceipt = optionalRef(row.delete_receipt_ref, "backup purge delete receipt reference");
    const absenceReceipt = optionalRef(row.absence_receipt_ref, "backup purge absence receipt reference");
    const holdRef = optionalRef(row.policy_or_hold_ref, "backup purge policy or hold reference");
    if ((row.state === "PENDING" && absenceReceipt !== null) ||
        (row.state === "ABSENT" && (deleteReceipt === null || absenceReceipt === null || row.target_state !== "ABSENT")) ||
        (row.state !== "ABSENT" && row.target_state === "ABSENT")) {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup purge obligation state diverges from its exact receipts or target readback");
    }
    obligations.push({
      kind: "BACKUP_PURGE", erasure_id: row.erasure_id, erasure_revision: row.erasure_revision as number,
      backup_epoch_id: epochId, target_id: row.target_id, state: row.state,
      delete_receipt_ref: deleteReceipt, absence_receipt_ref: absenceReceipt, policy_or_hold_ref: holdRef,
    });
  }

  let replayResult: D1Result<ReplayObligationRow>;
  try {
    replayResult = await database.prepare(
      "SELECT o.erasure_id,o.erasure_revision,o.backup_epoch_id,o.copy_id,o.target_id,o.expiry_intent_key," +
      "o.state,o.reason_code,o.receipt_json,c.epoch_id AS authority_epoch_id,c.state AS authority_state," +
      "c.destination_id AS authority_destination_id,e.revision AS execution_revision,e.state AS execution_state,t.target_kind,t.location," +
      "t.canonical_ref,t.state AS target_state FROM backup_erasure_replay_obligation o " +
      "LEFT JOIN backup_offsite_copy_replay_authority c ON c.copy_id=o.copy_id " +
      "LEFT JOIN erasure_execution e ON e.erasure_id=o.erasure_id AND e.revision=o.erasure_revision " +
      "LEFT JOIN erasure_target t ON t.erasure_id=o.erasure_id AND t.erasure_revision=o.erasure_revision AND t.target_id=o.target_id " +
      "WHERE o.backup_epoch_id=?1 ORDER BY o.erasure_id,o.erasure_revision,o.copy_id,o.expiry_intent_key LIMIT ?2",
    ).bind(epochId, MAX_ROWS + 1).all<ReplayObligationRow>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "offsite replay-obligation inventory is unavailable", true, {}, cause);
  }
  const replayRows = checkedAll(replayResult, "offsite replay-obligation inventory");
  if (replayRows.length > MAX_ROWS) failBackup("BACKUP_BOUND_EXCEEDED", "offsite replay-obligation inventory exceeds the restore bound");
  for (const row of replayRows) {
    if (typeof row.erasure_id !== "string" || row.erasure_id.length === 0 ||
        !Number.isSafeInteger(row.erasure_revision) || (row.erasure_revision as number) < 1 ||
        row.backup_epoch_id !== epochId || typeof row.copy_id !== "string" || row.copy_id.length === 0 ||
        typeof row.target_id !== "string" || row.target_id.length === 0 ||
        typeof row.expiry_intent_key !== "string" || row.expiry_intent_key.length === 0 ||
        (row.state !== "PENDING" && row.state !== "BLOCKED" && row.state !== "DELETED") ||
        (row.reason_code !== null && (typeof row.reason_code !== "string" || row.reason_code.length === 0)) ||
        row.authority_epoch_id !== epochId || row.authority_state !== "COMMITTED" ||
        typeof row.authority_destination_id !== "string" || row.authority_destination_id.length === 0 ||
        !Number.isSafeInteger(row.execution_revision) || row.execution_revision !== row.erasure_revision || row.execution_state !== "COMPLETE" ||
        typeof row.target_kind !== "string" || !ERASURE_TARGET_KINDS.has(row.target_kind) ||
        typeof row.location !== "string" || !ERASURE_TARGET_LOCATIONS.has(row.location) ||
        typeof row.canonical_ref !== "string" || row.canonical_ref.length === 0 ||
        typeof row.target_state !== "string" || !ERASURE_TARGET_STATES.has(row.target_state)) {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", "offsite replay obligation lacks exact copy authority, target, or epoch identity");
    }
    let receiptDigest: string | null = null;
    if (row.state === "PENDING") {
      if (row.reason_code !== null || row.receipt_json !== null) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "pending replay obligation has terminal receipt fields");
    } else if (row.state === "BLOCKED") {
      if (row.reason_code === null || (row.receipt_json !== null && typeof row.receipt_json !== "string")) {
        failBackup("BACKUP_VECTOR_UNVERIFIABLE", "blocked replay obligation lacks its reason or has malformed receipt bytes");
      }
      if (typeof row.receipt_json === "string") {
        let receipt: unknown;
        try { receipt = JSON.parse(row.receipt_json) as unknown; }
        catch (cause) { failBackup("BACKUP_VECTOR_UNVERIFIABLE", "blocked replay receipt JSON is malformed", false, {}, cause); }
        if (!isRecord(receipt) || canonicalBackupJson(receipt) !== row.receipt_json || receipt["state"] !== "BLOCKED" ||
            receipt["epoch_id"] !== epochId || receipt["expiry_intent_key"] !== row.expiry_intent_key ||
            receipt["destination_id"] !== row.authority_destination_id ||
            !Array.isArray(receipt["journal_refs"]) || !receipt["journal_refs"].every((ref) => typeof ref === "string" && ref.length > 0) ||
            receipt["absent_parts"] !== 0 || typeof receipt["created_at"] !== "string" || receipt["created_at"].length === 0) {
          failBackup("BACKUP_VECTOR_UNVERIFIABLE", "blocked replay receipt does not bind to its exact intent and epoch");
        }
        receiptDigest = await backupSha256Hex(row.receipt_json);
      }
    } else {
      if (row.reason_code !== null || typeof row.receipt_json !== "string" || row.target_state !== "ABSENT") {
        failBackup("BACKUP_VECTOR_UNVERIFIABLE", "deleted replay obligation lacks an exact receipt or terminal target absence");
      }
      let receipt: unknown;
      try { receipt = JSON.parse(row.receipt_json) as unknown; }
      catch (cause) { failBackup("BACKUP_VECTOR_UNVERIFIABLE", "deleted replay receipt JSON is malformed", false, {}, cause); }
      if (!isRecord(receipt) || canonicalBackupJson(receipt) !== row.receipt_json || receipt["state"] !== "DELETED" ||
          receipt["epoch_id"] !== epochId || receipt["expiry_intent_key"] !== row.expiry_intent_key ||
          receipt["destination_id"] !== row.authority_destination_id ||
          !Array.isArray(receipt["journal_refs"]) || !receipt["journal_refs"].every((ref) => typeof ref === "string" && ref.length > 0) ||
          !Number.isSafeInteger(receipt["absent_parts"]) || (receipt["absent_parts"] as number) < 0 ||
          receipt["journal_refs"].length !== receipt["absent_parts"] ||
          typeof receipt["created_at"] !== "string" || receipt["created_at"].length === 0) {
        failBackup("BACKUP_VECTOR_UNVERIFIABLE", "deleted replay receipt does not bind to its exact intent and epoch");
      }
      receiptDigest = await backupSha256Hex(row.receipt_json);
    }
    obligations.push({
      kind: "OFFSITE_REPLAY", erasure_id: row.erasure_id, erasure_revision: row.erasure_revision as number,
      backup_epoch_id: epochId, target_id: row.target_id, copy_id: row.copy_id,
      expiry_intent_key: row.expiry_intent_key, state: row.state, reason_code: row.reason_code,
      receipt_sha256: receiptDigest,
    });
  }

  return {
    terminal_erasure_targets_verified: true,
    unsettled_erasure_count: 0,
    erasure_rows: erasureRows,
    obligations,
    obligation_digest: await backupSha256Hex(canonicalBackupJson({
      erasures: erasureRows, backup_purge_obligations: backupRows, offsite_replay_obligations: replayRows,
    })),
  };
}

function scopeDigestInput(draft: BackupEpochDraft): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const name of SCOPE_MANIFESTS) {
    const digest = draft.manifest_digests[name];
    if (typeof digest !== "string" || !SHA256.test(digest)) {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", "epoch subject-scope manifest digest is absent or malformed");
    }
    digests[name] = digest;
  }
  return digests;
}

async function inspectRestoreAuthority(input: {
  readonly database: D1Database;
  readonly draft: BackupEpochDraft;
  readonly expectedPurge: IsolatedRestorePreflight["current_purge"];
}): Promise<{
  readonly purge: PurgeFrontier;
  readonly scopeDigest: string;
  readonly inventory: ReconciledInventory;
}> {
  const purge = await readPurgeFrontier(input.database);
  if (purge.revision !== input.expectedPurge.revision || purge.digest !== input.expectedPurge.digest ||
      purge.revision !== input.draft.purge_ledger_revision || purge.digest !== input.draft.purge_ledger_digest) {
    failBackup("BACKUP_PURGE_BLOCKED", "the current purge frontier no longer matches the exact backup epoch");
  }
  if (purge.blocked_count !== 0) failBackup("BACKUP_PURGE_BLOCKED", "restore is blocked by a current BLOCKED purge-ledger entry");
  const inventory = await readErasureInventory(input.database, input.draft.epoch_id);
  const scopeDigest = await backupSha256Hex(canonicalBackupJson({
    protocol: "eliotr.backup-restore-scope.v1",
    epoch_id: input.draft.epoch_id,
    manifest_digests: scopeDigestInput(input.draft),
  }));
  return { purge, scopeDigest, inventory };
}

/**
 * Creates the D1-authoritative O4/restore fence used by the restore executor.
 * The common lease serializes starts; durable ATTEMPTING/UNKNOWN restore
 * state prevents a timed-out lease from authorizing an O4 takeover.
 */
export function createD1RestoreErasureGate(input: {
  readonly now?: () => number;
  readonly lease_ms?: number;
} = {}): RestoreErasureGate {
  return {
    async acquire(request) {
      const database = request.primary_database;
      const identity = `restore-${await backupSha256Hex(canonicalBackupJson({
        epoch_id: request.draft.epoch_id,
        target: request.target,
      }))}`;
      const locks = createD1ErasureRestoreFenceStore({
        database,
        ...(input.now === undefined ? {} : { now: input.now }),
        ...(input.lease_ms === undefined ? {} : { lease_ms: input.lease_ms }),
      });
      const shared = await locks.acquireRestore(identity);
      if (shared === null) failBackup("BACKUP_PURGE_BLOCKED", "an unsettled O4 erasure or restore attempt owns the shared fence", true);
      try {
        const authority = await inspectRestoreAuthority({ database, draft: request.draft, expectedPurge: request.current_purge });
        await shared.assertCurrent();
        const obligations = authority.inventory.obligations;
        const fence: RestoreErasureFence = {
          state: "ACQUIRED",
          epoch_id: request.draft.epoch_id,
          purge_ledger_revision: authority.purge.revision,
          purge_ledger_digest: authority.purge.digest,
          epoch_subject_scope_digest: authority.scopeDigest,
          obligation_inventory_digest: authority.inventory.obligation_digest,
          terminal_erasure_targets_verified: authority.inventory.terminal_erasure_targets_verified,
          backup_obligations_verified: true,
          unsettled_erasure_count: authority.inventory.unsettled_erasure_count,
          backup_obligations: obligations,
          shared_execution_fence: shared,
          async assertCurrent() { await shared.assertCurrent(); },
          async release() { await shared.release(); },
        };
        return fence;
      } catch (cause) {
        await shared.release();
        throw cause;
      }
    },
  };
}
