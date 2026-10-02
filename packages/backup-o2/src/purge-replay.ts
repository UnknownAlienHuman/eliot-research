import type { ErasureFence } from "@eliotr/contracts";
import { assertBackupIdentifier, backupSha256Hex, canonicalBackupJson, failBackup } from "./shared.js";
import type { BackupEpochDraft } from "./epoch.js";
import type { BackupDestinationPolicy } from "./destination-policy.js";
import { destinationDescriptorDigest, destinationPolicyDigest } from "./destination-policy.js";
import type { OffsiteCopyAdapter } from "./offsite.js";
import { expireOffsiteCopy, type ExpiryReceipt } from "./expiry.js";
import { readBlockingHoldAuthority } from "./hold-authority.js";
import { readEpochDraftById } from "./replay-authority.js";
import { assertBackupErasureReplayAuthority, parseOffsiteCopyReplayIntent, type BackupOffsiteCopyReplayAuthority } from "./o4-authority.js";
import { backupIsoNow } from "./offsite-durability.js";

// O4 erasure-aware offsite deletion. This module intentionally owns no provider
// configuration: the composition root resolves an installed adapter by the
// D1-authoritative destination identity, while this capability revalidates
// its descriptor, original copy grant, current hold state, and exact absence
// through the existing expiry authority before returning success.

const MAX_EPOCH_COPIES = 1_000;
const MAX_COPY_PARTS = 100_000;

export interface BackupPurgeReplayDependencies {
  readonly core_db: D1Database;
  readonly resolve_adapter: (authority: {
    readonly destination_id: string;
    readonly failure_domain: string;
    readonly policy: BackupDestinationPolicy;
  }) => Promise<OffsiteCopyAdapter | null>;
  readonly now?: () => number;
}

export interface BackupPurgeReplayPort {
  purge(epochRef: string, erasureRef: string, context: { readonly target_id: string; readonly fence: ErasureFence }): Promise<{ readonly receipt_ref: string }>;
  verifyAbsent(epochRef: string, erasureRef: string, context: { readonly target_id: string; readonly fence: ErasureFence }): Promise<{ readonly absent: boolean; readonly receipt_ref: string }>;
}

export interface BackupPurgeReplayContext {
  readonly target_id: string;
  readonly fence: ErasureFence;
}

interface CopyReceiptRow {
  readonly copy_id: string;
  readonly epoch_id: string;
  readonly destination_id: string;
  readonly key_generation: string;
  readonly policy_digest: string;
  readonly intent_digest: string;
  readonly expires_at: string;
  readonly failure_domain: string;
  readonly descriptor_digest: string;
  readonly authority_authorized_at: string;
}

interface ReplayObligationRow {
  readonly erasure_id: string;
  readonly erasure_revision: number;
  readonly backup_epoch_id: string;
  readonly copy_id: string;
  readonly target_id: string;
  readonly expiry_intent_key: string;
  readonly state: "PENDING" | "BLOCKED" | "DELETED";
  readonly reason_code: string | null;
  readonly receipt_json: string | null;
}

interface LiveErasureFenceRow {
  readonly state: unknown;
  readonly lease_owner: unknown;
  readonly lease_generation: unknown;
  readonly lease_until: unknown;
}

async function assertLiveErasureFence(
  database: D1Database,
  fence: ErasureFence,
  expectedState: "PURGE_EACH_LOCATION" | "VERIFY_ABSENCE_OR_BLOCK",
  nowMs: number,
): Promise<void> {
  let row: LiveErasureFenceRow | null;
  try {
    row = await database.prepare(
      "SELECT state,lease_owner,lease_generation,lease_until FROM erasure_execution WHERE erasure_id=?1 AND revision=?2 LIMIT 1",
    ).bind(fence.erasure_id, fence.revision).first<LiveErasureFenceRow>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "live erasure execution authority is unavailable", true, {}, cause);
  }
  if (
    row === null || row.state !== expectedState || row.lease_owner !== fence.lease_owner ||
    row.lease_generation !== fence.lease_generation || row.lease_until !== fence.lease_until_ms ||
    typeof row.lease_until !== "number" || row.lease_until <= nowMs
  ) {
    failBackup("BACKUP_PURGE_BLOCKED", "backup purge replay no longer holds the live erasure fence", true);
  }
}

async function readCopyAuthorities(database: D1Database, epochId: string): Promise<readonly BackupOffsiteCopyReplayAuthority[]> {
  let result: D1Result<BackupOffsiteCopyReplayAuthority>;
  try {
    result = await database.prepare(
      `SELECT copy_id,epoch_id,destination_id,principal_ref,policy_decision_ref,operation_intent_json,key_generation,expires_at,primary_failure_domain,destination_policy_json,intent_digest,policy_digest,descriptor_digest,authority_authorized_at,state,created_at,committed_at FROM backup_offsite_copy_replay_authority WHERE epoch_id=?1 ORDER BY copy_id LIMIT ${MAX_EPOCH_COPIES + 1}`,
    ).bind(epochId).all<BackupOffsiteCopyReplayAuthority>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "offsite replay authority is unavailable", true, {}, cause);
  }
  if (result.success !== true || !Array.isArray(result.results)) {
    failBackup("BACKUP_TABLE_MISSING", "offsite replay authority query returned an incomplete inventory", true);
  }
  try {
    const rows = [...result.results];
    if (rows.some((row) => typeof row !== "object" || row === null || Array.isArray(row))) {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", "offsite replay authority inventory contains a malformed row");
    }
    if (rows.length > MAX_EPOCH_COPIES) failBackup("BACKUP_BOUND_EXCEEDED", "offsite epoch has too many copy authorities");
    for (const row of rows) {
      if ((row.state !== "INTENT" && row.state !== "COMMITTED") || row.epoch_id !== epochId) {
        failBackup("BACKUP_VECTOR_UNVERIFIABLE", "offsite copy authority carries a divergent epoch or state", false, { copy: row.copy_id });
      }
      if (
        typeof row.copy_id !== "string" || typeof row.destination_id !== "string" ||
        typeof row.principal_ref !== "string" || typeof row.policy_decision_ref !== "string" ||
        typeof row.operation_intent_json !== "string" || typeof row.key_generation !== "string" ||
        typeof row.expires_at !== "string" || typeof row.primary_failure_domain !== "string" ||
        typeof row.destination_policy_json !== "string" || typeof row.authority_authorized_at !== "string" ||
        typeof row.created_at !== "string" || (row.committed_at !== null && typeof row.committed_at !== "string") ||
        !/^[a-f0-9]{64}$/u.test(row.intent_digest) || !/^[a-f0-9]{64}$/u.test(row.policy_digest) || !/^[a-f0-9]{64}$/u.test(row.descriptor_digest)
      ) {
        failBackup("BACKUP_VECTOR_UNVERIFIABLE", "offsite copy authority carries an invalid digest", false, { copy: row.copy_id });
      }
      const { policy } = parseOffsiteCopyReplayIntent(row);
      if (await destinationPolicyDigest(policy) !== row.policy_digest) {
        failBackup("BACKUP_VECTOR_UNVERIFIABLE", "offsite copy authority policy digest does not match", false, { copy: row.copy_id });
      }
    }
    return rows;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause) throw cause;
    failBackup("BACKUP_TABLE_MISSING", "offsite replay authority is unavailable", true, {}, cause);
  }
}

async function readCopyReceipts(database: D1Database, epochId: string): Promise<readonly CopyReceiptRow[]> {
  let result: D1Result<CopyReceiptRow>;
  try {
    result = await database.prepare(
      `SELECT copy_id,epoch_id,destination_id,key_generation,policy_digest,intent_digest,expires_at,failure_domain,descriptor_digest,authority_authorized_at FROM backup_offsite_copy_receipt WHERE epoch_id=?1 ORDER BY copy_id LIMIT ${MAX_EPOCH_COPIES + 1}`,
    ).bind(epochId).all<CopyReceiptRow>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "offsite copy receipt inventory is unavailable", true, {}, cause);
  }
  if (result.success !== true || !Array.isArray(result.results)) {
    failBackup("BACKUP_TABLE_MISSING", "offsite copy receipt query returned an incomplete inventory", true);
  }
  try {
    const rows = [...result.results];
    if (rows.length > MAX_EPOCH_COPIES) failBackup("BACKUP_BOUND_EXCEEDED", "offsite epoch has too many committed copies");
    for (const row of rows) {
      if (
        typeof row !== "object" || row === null || Array.isArray(row) ||
        typeof row.copy_id !== "string" || typeof row.epoch_id !== "string" || typeof row.destination_id !== "string" ||
        typeof row.key_generation !== "string" || typeof row.policy_digest !== "string" || typeof row.intent_digest !== "string" ||
        typeof row.expires_at !== "string" || typeof row.failure_domain !== "string" || typeof row.descriptor_digest !== "string" ||
        typeof row.authority_authorized_at !== "string"
      ) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "offsite copy receipt inventory contains malformed persisted fields");
    }
    return rows;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause) throw cause;
    failBackup("BACKUP_TABLE_MISSING", "offsite copy receipt inventory is unavailable", true, {}, cause);
  }
}

async function assertNoUnboundParts(database: D1Database, epochId: string, authorities: readonly BackupOffsiteCopyReplayAuthority[]): Promise<void> {
  let result: D1Result<{ readonly copy_id: unknown }>;
  try {
    result = await database.prepare(
      `SELECT DISTINCT copy_id FROM backup_offsite_copy_part WHERE part_ref LIKE ?1 LIMIT ${MAX_EPOCH_COPIES + 1}`,
    ).bind(`offsite/${epochId}/%`).all<{ readonly copy_id: unknown }>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "offsite partial-copy inventory is unavailable", true, {}, cause);
  }
  if (result.success !== true || !Array.isArray(result.results)) {
    failBackup("BACKUP_TABLE_MISSING", "offsite partial-copy query returned an incomplete inventory", true);
  }
  const rows = result.results;
  if (rows.some((row) => typeof row !== "object" || row === null || Array.isArray(row) || typeof row.copy_id !== "string" || row.copy_id.length === 0)) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "offsite partial-copy inventory contains malformed copy identity");
  }
  if (rows.length > MAX_EPOCH_COPIES || rows.some((row) => !authorities.some((authority) => authority.copy_id === row.copy_id))) {
    failBackup("BACKUP_PURGE_BLOCKED", "offsite epoch has partial or legacy bytes without O4 authority; refusing incomplete purge closure");
  }
}

async function discoverCopies(database: D1Database, epochId: string): Promise<readonly { authority: BackupOffsiteCopyReplayAuthority; receipt: CopyReceiptRow }[]> {
  const [authorities, receipts] = await Promise.all([readCopyAuthorities(database, epochId), readCopyReceipts(database, epochId)]);
  await assertNoUnboundParts(database, epochId, authorities);
  if (authorities.length === 0 || receipts.length === 0 || authorities.length !== receipts.length) {
    failBackup("BACKUP_PURGE_BLOCKED", "verified offsite copy inventory and replay authority are incomplete");
  }
  const byAuthority = new Map(authorities.map((row) => [row.copy_id, row]));
  const pairs = receipts.map((receipt) => {
    const authority = byAuthority.get(receipt.copy_id);
    if (authority === undefined || authority.state !== "COMMITTED" || authority.committed_at === null) {
      failBackup("BACKUP_PURGE_BLOCKED", "offsite copy is missing committed O4 replay authority", false, { copy: receipt.copy_id });
    }
    if (
      authority.epoch_id !== receipt.epoch_id || authority.destination_id !== receipt.destination_id ||
      authority.key_generation !== receipt.key_generation || authority.expires_at !== receipt.expires_at ||
      authority.intent_digest !== receipt.intent_digest || authority.policy_digest !== receipt.policy_digest ||
      authority.descriptor_digest !== receipt.descriptor_digest || authority.authority_authorized_at !== receipt.authority_authorized_at
    ) {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", "offsite copy receipt diverges from its replay authority", false, { copy: receipt.copy_id });
    }
    return { authority, receipt };
  });
  return pairs;
}

async function readObligation(database: D1Database, erasureRef: string, epochId: string, copyId: string, expiryKey: string): Promise<ReplayObligationRow | null> {
  const { id: erasureId, revision } = parseErasureRef(erasureRef);
  let row: ReplayObligationRow | null;
  try {
    row = await database.prepare(
      "SELECT erasure_id,erasure_revision,backup_epoch_id,copy_id,target_id,expiry_intent_key,state,reason_code,receipt_json FROM backup_erasure_replay_obligation WHERE erasure_id=?1 AND erasure_revision=?2 AND backup_epoch_id=?3 AND copy_id=?4 AND expiry_intent_key=?5",
    ).bind(erasureId, revision, epochId, copyId, expiryKey).first<ReplayObligationRow>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup erasure replay obligation is unavailable", true, {}, cause);
  }
  if (row !== null) {
    if (row.erasure_id !== erasureId || row.erasure_revision !== revision || row.backup_epoch_id !== epochId || row.copy_id !== copyId || row.expiry_intent_key !== expiryKey) {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup erasure replay obligation identity is corrupt");
    }
    if (
      !Number.isSafeInteger(row.erasure_revision) || typeof row.target_id !== "string" || row.target_id.length === 0 ||
      (row.state !== "PENDING" && row.state !== "BLOCKED" && row.state !== "DELETED") ||
      (row.reason_code !== null && (typeof row.reason_code !== "string" || row.reason_code.length === 0)) ||
      (row.receipt_json !== null && typeof row.receipt_json !== "string") ||
      (row.state === "PENDING" && (row.reason_code !== null || row.receipt_json !== null)) ||
      (row.state === "BLOCKED" && row.reason_code === null) ||
      (row.state === "DELETED" && (row.reason_code !== null || row.receipt_json === null))
    ) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup erasure replay obligation has malformed persisted fields");
  }
  return row;
}

async function ensureIntent(
  database: D1Database,
  erasureRef: string,
  epochId: string,
  copyId: string,
  targetId: string,
  expiryKey: string,
  now: string,
  fence: ErasureFence,
  expectedState: "PURGE_EACH_LOCATION" | "VERIFY_ABSENCE_OR_BLOCK",
  nowMs: number,
): Promise<ReplayObligationRow> {
  const { id: erasureId, revision } = parseErasureRef(erasureRef);
  try {
    await database.prepare(
      "INSERT INTO backup_erasure_replay_obligation(erasure_id,erasure_revision,backup_epoch_id,copy_id,target_id,expiry_intent_key,state,reason_code,receipt_json,created_at,updated_at) " +
      "SELECT ?1,?2,?3,?4,?5,?6,'PENDING',NULL,NULL,?7,?7 WHERE EXISTS (SELECT 1 FROM erasure_execution " +
      "WHERE erasure_id=?8 AND revision=?9 AND lease_owner=?10 AND lease_generation=?11 AND lease_until>?12 AND state=?13) " +
      "ON CONFLICT(erasure_id,erasure_revision,backup_epoch_id,copy_id,expiry_intent_key) DO NOTHING",
    ).bind(erasureId, revision, epochId, copyId, targetId, expiryKey, now, fence.erasure_id, fence.revision, fence.lease_owner, fence.lease_generation, nowMs, expectedState).run();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup erasure replay intent did not settle", true, {}, cause);
  }
  const row = await readObligation(database, erasureRef, epochId, copyId, expiryKey);
  if (row === null || row.target_id !== targetId) failBackup("BACKUP_INTENT_CONFLICT", "backup erasure replay intent failed exact target readback");
  return row;
}

async function settleObligation(
  database: D1Database,
  row: ReplayObligationRow,
  state: "BLOCKED" | "DELETED",
  reasonCode: string | null,
  receipt: ExpiryReceipt | null,
  now: string,
  fence: ErasureFence,
  expectedState: "PURGE_EACH_LOCATION" | "VERIFY_ABSENCE_OR_BLOCK",
  nowMs: number,
): Promise<void> {
  const receiptJson = receipt === null ? null : canonicalBackupJson(receipt);
  try {
    await database.prepare(
      "UPDATE backup_erasure_replay_obligation SET state=?6,reason_code=?7,receipt_json=?8,updated_at=?9 WHERE erasure_id=?1 AND erasure_revision=?2 AND backup_epoch_id=?3 AND copy_id=?4 AND expiry_intent_key=?5 AND state='PENDING' " +
      "AND EXISTS (SELECT 1 FROM erasure_execution WHERE erasure_id=?10 AND revision=?11 AND lease_owner=?12 AND lease_generation=?13 AND lease_until>?14 AND state=?15)",
    ).bind(row.erasure_id, row.erasure_revision, row.backup_epoch_id, row.copy_id, row.expiry_intent_key, state, reasonCode, receiptJson, now, fence.erasure_id, fence.revision, fence.lease_owner, fence.lease_generation, nowMs, expectedState).run();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup erasure replay receipt did not settle", true, {}, cause);
  }
  const persisted = await readObligation(database, `${row.erasure_id}:${row.erasure_revision}`, row.backup_epoch_id, row.copy_id, row.expiry_intent_key);
  if (persisted === null || persisted.target_id !== row.target_id || persisted.state !== state || persisted.reason_code !== reasonCode || persisted.receipt_json !== receiptJson) {
    failBackup("BACKUP_OFFSITE_UNCERTAIN", "backup erasure replay receipt failed exact readback", true);
  }
}

function errorCode(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return null;
  const code = (cause as { readonly code?: unknown }).code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/u.test(code) ? code : null;
}

function blockedError(code: string | null): boolean {
  return code === "BACKUP_EXPIRY_BLOCKED" || code === "BACKUP_PURGE_BLOCKED" || code === "BACKUP_DESTINATION_POLICY_MISMATCH" || code === "BACKUP_OFFSITE_INADMISSIBLE";
}

function fenceOffsiteEffects(
  adapter: OffsiteCopyAdapter,
  dependencies: BackupPurgeReplayDependencies,
  fence: ErasureFence,
  expectedState: "PURGE_EACH_LOCATION" | "VERIFY_ABSENCE_OR_BLOCK",
): OffsiteCopyAdapter {
  const assertEffectFence = async (): Promise<void> => {
    try {
      await assertLiveErasureFence(dependencies.core_db, fence, expectedState, (dependencies.now ?? Date.now)());
    } catch (cause) {
      // A delete/get may already have settled remotely. Preserve the durable
      // O4 PENDING attempt so the next lease owner reconciles provider state;
      // never convert possible side effects into a terminal BLOCKED receipt.
      failBackup("BACKUP_OFFSITE_UNCERTAIN", "erasure lease changed around an offsite effect; provider settlement requires replay", true, {}, cause);
    }
  };
  return {
    async describe() {
      await assertEffectFence();
      const result = await adapter.describe();
      await assertEffectFence();
      return result;
    },
    async get(partRef) {
      await assertEffectFence();
      const result = await adapter.get(partRef);
      await assertEffectFence();
      return result;
    },
    async delete(partRef, reason) {
      await assertEffectFence();
      const result = await adapter.delete(partRef, reason);
      await assertEffectFence();
      return result;
    },
    async put() {
      failBackup("BACKUP_OFFSITE_UNCERTAIN", "purge replay adapter cannot write offsite objects", false);
    },
  };
}

async function expiryKeyFor(input: { erasureRef: string; epochId: string; copyId: string; descriptorDigest: string; holdRef: string | null }): Promise<string> {
  const digest = await backupSha256Hex(canonicalBackupJson({
    protocol: "eliotr.backup-erasure-expiry.v1",
    erasure_ref: input.erasureRef,
    epoch_id: input.epochId,
    copy_id: input.copyId,
    descriptor_digest: input.descriptorDigest,
    hold_ref: input.holdRef,
  }));
  return `erase-expiry-${digest.slice(0, 48)}`;
}

function parseExpiryReceipt(row: ReplayObligationRow): ExpiryReceipt | null {
  if (row.state !== "DELETED" || row.receipt_json === null) return null;
  let receipt: ExpiryReceipt;
  try { receipt = JSON.parse(row.receipt_json) as ExpiryReceipt; }
  catch (cause) { failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup erasure replay receipt is corrupt", false, {}, cause); }
  if (
    typeof receipt !== "object" || receipt === null || receipt.state !== "DELETED" ||
    receipt.epoch_id !== row.backup_epoch_id || receipt.expiry_intent_key !== row.expiry_intent_key ||
    typeof receipt.destination_id !== "string" || receipt.destination_id.length === 0 ||
    !Array.isArray(receipt.journal_refs) || !receipt.journal_refs.every((ref) => typeof ref === "string" && ref.length > 0) ||
    !Number.isSafeInteger(receipt.absent_parts) || receipt.absent_parts < 0 ||
    typeof receipt.created_at !== "string" || receipt.created_at.length === 0
  ) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup erasure replay receipt does not match its durable intent");
  }
  return receipt;
}

async function processCopy(input: {
  readonly dependencies: BackupPurgeReplayDependencies;
  readonly erasureRef: string;
  readonly epochId: string;
  readonly targetId: string;
  readonly context: BackupPurgeReplayContext;
  readonly expectedState: "PURGE_EACH_LOCATION" | "VERIFY_ABSENCE_OR_BLOCK";
  readonly authority: BackupOffsiteCopyReplayAuthority;
  readonly receipt: CopyReceiptRow;
}): Promise<{ readonly absent: boolean; readonly receipt_ref: string }> {
  const { dependencies, erasureRef, epochId, targetId, context, expectedState, authority, receipt } = input;
  const nowMs = (dependencies.now ?? Date.now)();
  const now = backupIsoNow(nowMs);
  await assertLiveErasureFence(dependencies.core_db, context.fence, expectedState, nowMs);
  const { intent, policy } = parseOffsiteCopyReplayIntent(authority);
  if (
    receipt.key_generation !== authority.key_generation || receipt.expires_at !== authority.expires_at ||
    receipt.epoch_id !== authority.epoch_id || receipt.destination_id !== authority.destination_id
  ) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "offsite copy receipt does not match the stored erasure authority", false, { copy: authority.copy_id });
  }
  const holdRef = await readBlockingHoldAuthority(dependencies.core_db, epochId);
  let adapter: OffsiteCopyAdapter | null;
  let descriptorDigest: string;
  try {
    adapter = await dependencies.resolve_adapter({ destination_id: authority.destination_id, failure_domain: authority.primary_failure_domain, policy });
    descriptorDigest = adapter === null
      ? await backupSha256Hex(`adapter-unavailable:${authority.destination_id}`)
      : await destinationDescriptorDigest(await adapter.describe());
  } catch {
    adapter = null;
    descriptorDigest = await backupSha256Hex(`adapter-unavailable:${authority.destination_id}`);
  }
  const expiryKey = await expiryKeyFor({ erasureRef, epochId, copyId: authority.copy_id, descriptorDigest, holdRef });
  const prior = await ensureIntent(dependencies.core_db, erasureRef, epochId, authority.copy_id, targetId, expiryKey, now, context.fence, expectedState, nowMs);
  if (prior.state === "BLOCKED") {
    return { absent: false, receipt_ref: `backup-blocked:${expiryKey}` };
  }
  if (adapter === null) {
    await assertLiveErasureFence(dependencies.core_db, context.fence, expectedState, (dependencies.now ?? Date.now)());
    await settleObligation(dependencies.core_db, prior, "BLOCKED", "OFFSITE_ADAPTER_UNAVAILABLE", null, now, context.fence, expectedState, (dependencies.now ?? Date.now)());
    return { absent: false, receipt_ref: `backup-blocked:${expiryKey}` };
  }
  const persistedEpoch = await readEpochDraftById(dependencies.core_db, epochId);
  if (persistedEpoch === null) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup erasure references an unknown persisted epoch");
  let draft: BackupEpochDraft;
  try { draft = JSON.parse(persistedEpoch.draft_json) as BackupEpochDraft; }
  catch (cause) { failBackup("BACKUP_VECTOR_UNVERIFIABLE", "persisted backup epoch draft is corrupt", false, {}, cause); }
  if (draft.epoch_id !== epochId || draft.part_index.length > MAX_COPY_PARTS) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "persisted backup epoch part inventory is invalid");
  }
  const expiry = { expiry_intent_key: expiryKey, epoch_id: epochId, reason: `erasure:${erasureRef}` };
  try {
    await assertLiveErasureFence(dependencies.core_db, context.fence, expectedState, (dependencies.now ?? Date.now)());
    const result = await expireOffsiteCopy({
      core_db: dependencies.core_db,
      draft,
      intent,
      expiry,
      destination_policy: policy,
      primary_failure_domain: authority.primary_failure_domain,
      adapter: fenceOffsiteEffects(adapter, dependencies, context.fence, expectedState),
      now_ms: nowMs,
    });
    if (result.state !== "DELETED" || result.absent_parts !== draft.part_index.length || result.journal_refs.length !== draft.part_index.length) {
      if (prior.state === "PENDING") await settleObligation(dependencies.core_db, prior, "BLOCKED", "BACKUP_EXPIRY_ABSENCE_UNPROVEN", null, now, context.fence, expectedState, (dependencies.now ?? Date.now)());
      return { absent: false, receipt_ref: `backup-blocked:${expiryKey}` };
    }
    if (prior.state === "PENDING") {
      await settleObligation(dependencies.core_db, prior, "DELETED", null, result, now, context.fence, expectedState, (dependencies.now ?? Date.now)());
    } else if (prior.state === "DELETED" && canonicalBackupJson(parseExpiryReceipt(prior)) !== canonicalBackupJson(result)) {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", "terminal backup erasure receipt diverges from O2 expiry replay");
    }
    const exact = await readObligation(dependencies.core_db, erasureRef, epochId, authority.copy_id, expiryKey);
    if (exact === null || parseExpiryReceipt(exact) === null) failBackup("BACKUP_OFFSITE_UNCERTAIN", "backup erasure success receipt failed terminal readback", true);
    return { absent: true, receipt_ref: `backup-expired:${expiryKey}` };
  } catch (cause) {
    const code = errorCode(cause);
    if (blockedError(code)) {
      if (prior.state === "PENDING") await settleObligation(dependencies.core_db, prior, "BLOCKED", code ?? "BACKUP_PURGE_BLOCKED", null, now, context.fence, expectedState, (dependencies.now ?? Date.now)());
      return { absent: false, receipt_ref: `backup-blocked:${expiryKey}` };
    }
    throw cause;
  }
}

function parseErasureRef(value: string): { readonly id: string; readonly revision: number } {
  const split = value.lastIndexOf(":");
  const id = assertBackupIdentifier(value.slice(0, split), "erasure reference");
  const revision = Number(value.slice(split + 1));
  if (split < 1 || !Number.isSafeInteger(revision) || revision < 1) failBackup("BACKUP_INPUT_INVALID", "backup erasure reference is malformed");
  return { id, revision };
}

export function createBackupPurgeReplayPort(dependencies: BackupPurgeReplayDependencies): BackupPurgeReplayPort {
  async function process(epochRef: string, erasureRef: string, context: BackupPurgeReplayContext, expectedState: "PURGE_EACH_LOCATION" | "VERIFY_ABSENCE_OR_BLOCK"): Promise<{ readonly absent: boolean; readonly receipt_ref: string }> {
    const epochId = assertBackupIdentifier(epochRef, "backup epoch reference");
    const erasure = parseErasureRef(erasureRef);
    if (context.fence.erasure_id !== erasure.id || context.fence.revision !== erasure.revision) failBackup("BACKUP_PURGE_BLOCKED", "backup erasure reference diverges from the active fence");
    await assertBackupErasureReplayAuthority(dependencies.core_db);
    const nowMs = (dependencies.now ?? Date.now)();
    await assertLiveErasureFence(dependencies.core_db, context.fence, expectedState, nowMs);
    const copies = await discoverCopies(dependencies.core_db, epochId);
    const results: { readonly absent: boolean; readonly receipt_ref: string }[] = [];
    for (const copy of copies) {
      results.push(await processCopy({
        dependencies, erasureRef, epochId, targetId: context.target_id, context, expectedState,
        authority: copy.authority, receipt: copy.receipt,
      }));
    }
    const absent = results.every((result) => result.absent);
    const receiptDigest = await backupSha256Hex(canonicalBackupJson(results.map((result) => result.receipt_ref).sort()));
    return { absent, receipt_ref: `backup-erasure-replay-${receiptDigest.slice(0, 48)}` };
  }
  return {
    async purge(epochRef, erasureRef, context) {
      return { receipt_ref: (await process(epochRef, erasureRef, context, "PURGE_EACH_LOCATION")).receipt_ref };
    },
    verifyAbsent(epochRef, erasureRef, context) {
      return process(epochRef, erasureRef, context, "VERIFY_ABSENCE_OR_BLOCK");
    },
  };
}
