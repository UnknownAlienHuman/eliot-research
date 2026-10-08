import {
  backupSha256Hex,
  canonicalBackupJson,
  failBackup,
} from "@eliotr/backup-o2";
import {
  assertBackupProducerFenceMigrationAuthority,
  backupEpochProducerReceiptDigest,
  listBackupEpochProducerClaims,
  type BackupEpochProducerClaim,
} from "@eliotr/backup-o2";
import {
  BACKUP_PRODUCER_QUIESCENCE_ACTIVE_STATES,
  type BackupProducerQuiescenceContext,
  type BackupProducerQuiescenceErasureState,
  type BackupProducerQuiescencePort,
  type BackupProducerQuiescenceSnapshot,
} from "@eliotr/cloudflare-erasure";

interface D1Rows<T> {
  readonly success: boolean;
  readonly results?: readonly T[];
}

interface ActiveErasureRow {
  readonly case_state: unknown;
  readonly execution_state: unknown;
}

interface ReceiptRow {
  readonly idempotency_key: unknown;
  readonly intent_id: unknown;
  readonly intent_digest: unknown;
  readonly vector_digest: unknown;
  readonly manifest_digest: unknown;
  readonly epoch_id: unknown;
  readonly receipt_json: unknown;
  readonly draft_json: unknown;
  readonly attempt_json: unknown;
}

interface CanonicalEpochRow {
  readonly backup_epoch_id: unknown;
  readonly core_export_ref: unknown;
  readonly search_projection_manifest_ref: unknown;
  readonly evidence_manifest_ref: unknown;
  readonly work_manifest_ref: unknown;
  readonly offsite_copy_ref: unknown;
  readonly purge_ledger_revision: unknown;
  readonly verification_state: unknown;
  readonly created_at: unknown;
  readonly verified_at: unknown;
}

interface ExportCutRow {
  readonly cut_id: unknown;
  readonly cut_digest: unknown;
  readonly state: unknown;
}

interface ReceiptCutLinkRow {
  readonly idempotency_key: unknown;
  readonly epoch_id: unknown;
  readonly cut_id: unknown;
  readonly draft_epoch_id: unknown;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function all<T>(database: D1Database, sql: string, values: readonly (string | number)[] = []): Promise<readonly T[]> {
  let result: D1Rows<T>;
  try {
    const statement = database.prepare(sql);
    result = await (values.length === 0 ? statement : statement.bind(...values)).all<T>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup producer quiescence read is unavailable", true, {}, cause);
  }
  if (result.success !== true || !Array.isArray(result.results)) {
    failBackup("BACKUP_TABLE_MISSING", "backup producer quiescence readback is malformed", true);
  }
  return result.results;
}

async function activeErasureState(
  database: D1Database,
  context: BackupProducerQuiescenceContext,
): Promise<BackupProducerQuiescenceErasureState> {
  if (typeof context.erasure_id !== "string" || context.erasure_id.length === 0 ||
      !Number.isSafeInteger(context.revision) || context.revision < 1) {
    failBackup("BACKUP_INPUT_INVALID", "backup producer erasure identity is invalid");
  }
  let row: ActiveErasureRow | null;
  try {
    row = await database.prepare(`SELECT c.state AS case_state,e.state AS execution_state
      FROM erasure_case c JOIN erasure_execution e
        ON e.erasure_id=c.erasure_id AND e.revision=c.revision
      WHERE c.erasure_id=?1 AND c.revision=?2`).bind(context.erasure_id, context.revision).first<ActiveErasureRow>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup producer erasure context is unavailable", true, {}, cause);
  }
  if (row === null || typeof row.case_state !== "string" || typeof row.execution_state !== "string" ||
      row.case_state !== row.execution_state ||
      !BACKUP_PRODUCER_QUIESCENCE_ACTIVE_STATES.includes(row.case_state as BackupProducerQuiescenceErasureState)) {
    failBackup("BACKUP_PURGE_BLOCKED", "backup producer set requires one matching active erasure case and execution", true);
  }
  return row.case_state as BackupProducerQuiescenceErasureState;
}

async function committedLinkage(
  database: D1Database,
  claim: BackupEpochProducerClaim,
): Promise<string> {
  if (claim.state !== "COMMITTED" || claim.epoch_id === null || claim.cut_id === null ||
      claim.cut_digest === null || claim.vector_digest === null || claim.manifest_digest === null ||
      claim.intent_digest === null || claim.receipt_digest === null || claim.part_prefix === null) {
    failBackup("BACKUP_PURGE_BLOCKED", "committed producer claim is missing a required durable pin", true);
  }
  const receipts = await all<ReceiptRow>(database, `SELECT idempotency_key,intent_id,intent_digest,vector_digest,manifest_digest,
      epoch_id,receipt_json,draft_json,attempt_json
    FROM backup_epoch_receipt WHERE epoch_id=?1 ORDER BY idempotency_key LIMIT 2`, [claim.epoch_id]);
  const receipt = receipts[0];
  if (receipts.length !== 1 || receipt === undefined || receipt.idempotency_key !== claim.idempotency_key ||
      receipt.epoch_id !== claim.epoch_id || typeof receipt.intent_id !== "string" ||
      typeof receipt.intent_digest !== "string" || receipt.intent_digest !== claim.intent_digest ||
      typeof receipt.vector_digest !== "string" || receipt.vector_digest !== claim.vector_digest ||
      typeof receipt.manifest_digest !== "string" || receipt.manifest_digest !== claim.manifest_digest ||
      typeof receipt.receipt_json !== "string" ||
      typeof receipt.draft_json !== "string" || typeof receipt.attempt_json !== "string") {
    failBackup("BACKUP_PURGE_BLOCKED", "committed producer claim has no unique exact persisted receipt", true);
  }

  let parsedDraft: unknown;
  let parsedReceipt: unknown;
  let parsedAttempt: unknown;
  try {
    parsedDraft = JSON.parse(receipt.draft_json);
    parsedReceipt = JSON.parse(receipt.receipt_json);
    parsedAttempt = JSON.parse(receipt.attempt_json);
  } catch (cause) {
    failBackup("BACKUP_PURGE_BLOCKED", "committed producer receipt or draft is unreadable", true, {}, cause);
  }
  if (!isRecord(parsedDraft) || !isRecord(parsedReceipt) || !isRecord(parsedAttempt)) {
    failBackup("BACKUP_PURGE_BLOCKED", "committed producer receipt or draft is malformed", true);
  }
  const draft = parsedDraft;
  const operationReceipt = parsedReceipt;
  const operationAttempt = parsedAttempt;
  if (draft["epoch_id"] !== claim.epoch_id || draft["cut_id"] !== claim.cut_id ||
      draft["vector_digest"] !== claim.vector_digest || operationReceipt["outcome"] !== "SUCCEEDED" ||
      operationReceipt["attempt_id"] !== operationAttempt["attempt_id"] ||
      operationAttempt["state"] !== "SUCCEEDED" ||
      !isRecord(operationReceipt["intent_ref"]) || !isRecord(operationAttempt["intent_ref"]) ||
      (operationReceipt["intent_ref"] as Record<string, unknown>)["id"] !== receipt.intent_id ||
      (operationAttempt["intent_ref"] as Record<string, unknown>)["id"] !== receipt.intent_id ||
      (operationReceipt["intent_ref"] as Record<string, unknown>)["revision"] !==
        (operationAttempt["intent_ref"] as Record<string, unknown>)["revision"]) {
    failBackup("BACKUP_PURGE_BLOCKED", "committed producer receipt identity differs from its persisted draft", true);
  }
  if (!isRecord(draft["manifest_digests"]) || !Array.isArray(draft["part_index"]) ||
      !Array.isArray(draft["payload_part_index"]) || typeof draft["purge_ledger_revision"] !== "number" ||
      !Number.isSafeInteger(draft["purge_ledger_revision"]) || typeof draft["purge_ledger_digest"] !== "string") {
    failBackup("BACKUP_PURGE_BLOCKED", "committed producer draft is missing its exact output inventory", true);
  }
  const partRefs = [...draft["part_index"], ...draft["payload_part_index"]];
  for (const raw of partRefs) {
    if (!isRecord(raw) || typeof raw["part_key"] !== "string" || !raw["part_key"].startsWith(claim.part_prefix)) {
      failBackup("BACKUP_PURGE_BLOCKED", "committed producer part lies outside its pinned prefix", true);
    }
  }
  const manifestDigests = draft["manifest_digests"];
  const manifestEntries = Object.entries(manifestDigests);
  if (manifestEntries.some(([, digest]) => typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest))) {
    failBackup("BACKUP_PURGE_BLOCKED", "committed producer manifest digests are malformed", true);
  }
  const manifestDigest = await backupSha256Hex(manifestEntries
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, digest]) => `${name}:${String(digest)}`).join("\n"));
  if (manifestDigest !== claim.manifest_digest) failBackup("BACKUP_PURGE_BLOCKED", "committed producer manifest pin diverges", true);
  const expectedEpoch = `epoch-${(await backupSha256Hex(`backup-epoch\u0000${receipt.intent_id}\u0000${claim.vector_digest}\u0000${claim.manifest_digest}`)).slice(0, 48)}`;
  if (expectedEpoch !== claim.epoch_id) failBackup("BACKUP_PURGE_BLOCKED", "committed producer epoch identity diverges from its receipt", true);

  const cuts = await all<{ readonly cut_id: unknown; readonly cut_digest: unknown; readonly state: unknown }>(
    database, "SELECT cut_id,cut_digest,state FROM backup_export_cut WHERE cut_id=?1 LIMIT 2", [claim.cut_id],
  );
  if (cuts.length !== 1 || cuts[0]?.cut_id !== claim.cut_id || cuts[0]?.cut_digest !== claim.cut_digest || cuts[0]?.state !== "ACCEPTED") {
    failBackup("BACKUP_PURGE_BLOCKED", "committed producer cut is absent or unaccepted", true);
  }
  if (claim.receipt_digest !== await backupEpochProducerReceiptDigest({
    idempotency_key: claim.idempotency_key,
    intent_id: receipt.intent_id,
    intent_digest: receipt.intent_digest as string,
    vector_digest: receipt.vector_digest as string,
    manifest_digest: receipt.manifest_digest as string,
    epoch_id: claim.epoch_id,
    receipt_json: receipt.receipt_json,
    draft_json: receipt.draft_json,
    attempt_json: receipt.attempt_json,
  })) failBackup("BACKUP_PURGE_BLOCKED", "committed producer receipt digest diverges", true);

  const epochs = await all<CanonicalEpochRow>(database, `SELECT backup_epoch_id,core_export_ref,search_projection_manifest_ref,
      evidence_manifest_ref,work_manifest_ref,offsite_copy_ref,purge_ledger_revision,verification_state,created_at,verified_at
    FROM backup_epoch WHERE backup_epoch_id=?1 LIMIT 2`, [claim.epoch_id]);
  const epoch = epochs[0];
  if (epochs.length !== 1 || epoch === undefined || epoch.backup_epoch_id !== claim.epoch_id ||
      typeof epoch.core_export_ref !== "string" || typeof epoch.search_projection_manifest_ref !== "string" ||
      typeof epoch.evidence_manifest_ref !== "string" || typeof epoch.work_manifest_ref !== "string" ||
      typeof epoch.offsite_copy_ref !== "string" || epoch.purge_ledger_revision !== draft["purge_ledger_revision"] ||
      epoch.verification_state !== "VERIFIED" || typeof epoch.created_at !== "string" ||
      !isCanonicalTimestamp(epoch.verified_at)) {
    failBackup("BACKUP_PURGE_BLOCKED", "committed producer claim has no exact canonical backup_epoch row", true);
  }
  return backupSha256Hex(canonicalBackupJson({
    backup_epoch_id: epoch.backup_epoch_id,
    core_export_ref: epoch.core_export_ref,
    search_projection_manifest_ref: epoch.search_projection_manifest_ref,
    evidence_manifest_ref: epoch.evidence_manifest_ref,
    work_manifest_ref: epoch.work_manifest_ref,
    offsite_copy_ref: epoch.offsite_copy_ref,
    purge_ledger_revision: epoch.purge_ledger_revision,
    verification_state: epoch.verification_state,
    created_at: epoch.created_at,
    verified_at: epoch.verified_at,
  }));
}

/**
 * Reads terminal producer claims and a one-to-one accepted-cut/receipt/epoch
 * set for one active erasure. It does not prove old-worker routing drain,
 * complete epoch qualification, or a stable D1 snapshot.
 */
async function assertBackupProducerQuiescent(
  database: D1Database,
  context: BackupProducerQuiescenceContext,
): Promise<BackupProducerQuiescenceSnapshot> {
  await assertBackupProducerFenceMigrationAuthority(database);
  const erasureState = await activeErasureState(database, context);
  const claims = await listBackupEpochProducerClaims(database);
  const rawCuts = await all<ExportCutRow>(
    database, "SELECT cut_id,cut_digest,state FROM backup_export_cut ORDER BY cut_id LIMIT 100001",
  );
  if (rawCuts.length > 100000) failBackup("BACKUP_BOUND_EXCEEDED", "backup export-cut set exceeds its audit bound");
  const acceptedCuts: { readonly cut_id: string; readonly cut_digest: string }[] = [];
  const cutIds = new Set<string>();
  for (const row of rawCuts) {
    if (typeof row.cut_id !== "string" || !/^cut-[a-f0-9]{32}$/u.test(row.cut_id) ||
        typeof row.cut_digest !== "string" || !/^[a-f0-9]{64}$/u.test(row.cut_digest) ||
        row.cut_id !== `cut-${row.cut_digest.slice(0, 32)}` || row.state !== "ACCEPTED" || cutIds.has(row.cut_id)) {
      failBackup("BACKUP_PURGE_BLOCKED", "backup export-cut inventory contains an open, rejected, malformed, or duplicate cut", true);
    }
    cutIds.add(row.cut_id);
    acceptedCuts.push({ cut_id: row.cut_id, cut_digest: row.cut_digest });
  }
  const receiptLinks = await all<ReceiptCutLinkRow>(database, `SELECT idempotency_key,epoch_id,
      json_extract(draft_json,'$.cut_id') AS cut_id,
      json_extract(draft_json,'$.epoch_id') AS draft_epoch_id
    FROM backup_epoch_receipt ORDER BY idempotency_key LIMIT 100001`);
  if (receiptLinks.length > 100000) failBackup("BACKUP_BOUND_EXCEEDED", "backup receipt cut-link set exceeds its audit bound");
  const receiptsByCut = new Map<string, ReceiptCutLinkRow[]>();
  const receiptsByKey = new Map<string, ReceiptCutLinkRow>();
  for (const receipt of receiptLinks) {
    if (typeof receipt.idempotency_key !== "string" || typeof receipt.epoch_id !== "string" ||
        typeof receipt.cut_id !== "string" || typeof receipt.draft_epoch_id !== "string" ||
        receipt.epoch_id !== receipt.draft_epoch_id || !cutIds.has(receipt.cut_id)) {
      failBackup("BACKUP_PURGE_BLOCKED", "backup receipt has no exact accepted cut and draft linkage", true);
    }
    if (receiptsByKey.has(receipt.idempotency_key)) failBackup("BACKUP_PURGE_BLOCKED", "backup receipt idempotency key is duplicated", true);
    receiptsByKey.set(receipt.idempotency_key, receipt);
    const linked = receiptsByCut.get(receipt.cut_id);
    if (linked === undefined) receiptsByCut.set(receipt.cut_id, [receipt]);
    else linked.push(receipt);
  }
  const canonicalEpochs: { readonly epoch_id: string; readonly row_digest: string }[] = [];
  const claimsByCut = new Map<string, BackupEpochProducerClaim[]>();
  const claimsByKey = new Map(claims.map((claim) => [claim.idempotency_key, claim] as const));
  for (const claim of claims) {
    if (claim.state === "CAPTURING" || claim.state === "WRITING" || claim.state === "UNKNOWN") {
      failBackup("BACKUP_PURGE_BLOCKED", "backup producer inventory has an unsettled writer", true, { state: claim.state });
    }
    if (claim.state === "COMMITTED") {
      if (claim.cut_id === null || claim.cut_digest === null || !cutIds.has(claim.cut_id)) {
        failBackup("BACKUP_PURGE_BLOCKED", "committed producer claim has no accepted cut inventory row", true);
      }
      const linked = claimsByCut.get(claim.cut_id);
      if (linked === undefined) claimsByCut.set(claim.cut_id, [claim]);
      else linked.push(claim);
      canonicalEpochs.push({ epoch_id: claim.epoch_id as string, row_digest: await committedLinkage(database, claim) });
    } else if (claim.state === "ABANDONED_NO_WRITES") {
      if (receiptsByKey.has(claim.idempotency_key)) failBackup("BACKUP_PURGE_BLOCKED", "abandoned producer unexpectedly has a persisted receipt", true);
    } else failBackup("BACKUP_PURGE_BLOCKED", "backup producer inventory contains an unknown state", true);
  }
  const acceptedCutPins: { readonly cut_id: string; readonly cut_digest: string; readonly idempotency_key: string; readonly epoch_id: string; readonly receipt_digest: string }[] = [];
  for (const cut of acceptedCuts) {
    const matchingClaims = claimsByCut.get(cut.cut_id) ?? [];
    const matchingReceipts = receiptsByCut.get(cut.cut_id) ?? [];
    const claim = matchingClaims[0];
    const receipt = matchingReceipts[0];
    if (matchingClaims.length !== 1 || matchingReceipts.length !== 1 || claim === undefined || receipt === undefined ||
        claim.cut_digest !== cut.cut_digest || claim.state !== "COMMITTED" ||
        receipt.idempotency_key !== claim.idempotency_key || receipt.epoch_id !== claim.epoch_id ||
        claimsByKey.get(receipt.idempotency_key) !== claim || claim.receipt_digest === null) {
      failBackup("BACKUP_PURGE_BLOCKED", "accepted cut does not have exactly one matching claim, receipt, draft, and canonical epoch", true);
    }
    acceptedCutPins.push({
      cut_id: cut.cut_id,
      cut_digest: cut.cut_digest,
      idempotency_key: claim.idempotency_key,
      epoch_id: claim.epoch_id as string,
      receipt_digest: claim.receipt_digest,
    });
  }
  const finalState = await activeErasureState(database, context);
  if (finalState !== erasureState) failBackup("BACKUP_PURGE_BLOCKED", "erasure state changed during producer claim inventory", true);
  const claimsDigest = await backupSha256Hex(canonicalBackupJson({
    protocol: "eliotr.backup-producer-claims.v1", erasure_id: context.erasure_id,
    revision: context.revision, claims,
  }));
  const canonicalEpochsDigest = await backupSha256Hex(canonicalBackupJson({
    protocol: "eliotr.backup-producer-canonical-epochs.v1", erasure_id: context.erasure_id,
    revision: context.revision, canonical_epochs: canonicalEpochs,
  }));
  const acceptedCutsDigest = await backupSha256Hex(canonicalBackupJson({
    protocol: "eliotr.backup-producer-accepted-cuts.v1", erasure_id: context.erasure_id,
    revision: context.revision, accepted_cuts: acceptedCutPins,
  }));
  return {
    protocol: "eliotr.backup-producer-quiescence.v1",
    erasure_id: context.erasure_id,
    revision: context.revision,
    erasure_state: erasureState,
    claim_count: claims.length,
    claims,
    claims_digest: claimsDigest,
    accepted_cut_count: acceptedCutPins.length,
    accepted_cuts_digest: acceptedCutsDigest,
    canonical_epoch_count: canonicalEpochs.length,
    canonical_epochs_digest: canonicalEpochsDigest,
  };
}

export function createD1BackupProducerQuiescencePort(
  database: D1Database,
): BackupProducerQuiescencePort {
  return {
    assertQuiescent: (context) => assertBackupProducerQuiescent(database, context),
  };
}
