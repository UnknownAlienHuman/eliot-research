import {
  assertBackupErasureReplayAuthority,
  assertO2MigrationAuthority,
  destinationPolicyDigest,
  parseOffsiteCopyReplayIntent,
  type BackupOffsiteCopyReplayAuthority,
} from "@eliotr/backup-o2";
import { assertErasureIdentifier, erasureFail } from "./canonical.js";
import type { BackupEpochScopeArchive, BackupEpochScopeDraft, BackupEpochScopePart } from "./backup-epoch-scope.js";
import { assertPrimaryBackupPartInventory } from "./backup-primary-inventory.js";

const INVENTORY_ROW_LIMIT = 10_000;
const INVENTORY_FETCH_LIMIT = INVENTORY_ROW_LIMIT + 1;
const MAX_LOCAL_PART_BYTES = 8 * 1024 * 1024;

interface QueryRows<T> {
  readonly success?: boolean;
  readonly results?: readonly T[];
}

interface BackupEpochRow {
  readonly backup_epoch_id: unknown;
  readonly verification_state: unknown;
}

interface EpochReceiptIdentityRow {
  readonly epoch_id: unknown;
}

interface PersistedEpochReceiptRow {
  readonly epoch_id: unknown;
  readonly draft_json: unknown;
}

interface CopyReceiptRow {
  readonly copy_id: unknown;
  readonly epoch_id: unknown;
  readonly destination_id: unknown;
  readonly key_generation: unknown;
  readonly policy_digest: unknown;
  readonly intent_digest: unknown;
  readonly expires_at: unknown;
  readonly failure_domain: unknown;
  readonly descriptor_digest: unknown;
  readonly authority_authorized_at: unknown;
}

function queryRows<T>(result: QueryRows<T>, label: string): readonly T[] {
  if (result.success !== true || !Array.isArray(result.results)) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", `${label} did not return a complete successful result`, true);
  }
  if (result.results.length > INVENTORY_ROW_LIMIT) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", `${label} exceeds the bounded ${INVENTORY_ROW_LIMIT}-row inventory`);
  }
  return result.results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCopyReceipt(value: CopyReceiptRow): {
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
} {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    typeof value.copy_id !== "string" || typeof value.epoch_id !== "string" ||
    typeof value.destination_id !== "string" || typeof value.key_generation !== "string" ||
    typeof value.expires_at !== "string" || typeof value.failure_domain !== "string" ||
    typeof value.authority_authorized_at !== "string" ||
    typeof value.policy_digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.policy_digest) ||
    typeof value.intent_digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.intent_digest) ||
    typeof value.descriptor_digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.descriptor_digest)
  ) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "offsite backup receipt has malformed persisted authority fields");
  }
  return {
    copy_id: value.copy_id,
    epoch_id: value.epoch_id,
    destination_id: value.destination_id,
    key_generation: value.key_generation,
    policy_digest: value.policy_digest,
    intent_digest: value.intent_digest,
    expires_at: value.expires_at,
    failure_domain: value.failure_domain,
    descriptor_digest: value.descriptor_digest,
    authority_authorized_at: value.authority_authorized_at,
  };
}

async function verifiedCopyEpochIds(database: D1Database, knownEpochs: ReadonlySet<string>): Promise<readonly string[]> {
  try {
    await assertBackupErasureReplayAuthority(database);
  } catch (cause) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup O4 copy authority is unavailable or mismatched", false, cause);
  }

  let authorityResult: QueryRows<BackupOffsiteCopyReplayAuthority>;
  let receiptResult: QueryRows<CopyReceiptRow>;
  let partialResult: QueryRows<{ readonly copy_id: unknown }>;
  try {
    [authorityResult, receiptResult, partialResult] = await Promise.all([
      database.prepare(
        "SELECT copy_id,epoch_id,destination_id,principal_ref,policy_decision_ref,operation_intent_json,key_generation,expires_at,primary_failure_domain,destination_policy_json,intent_digest,policy_digest,descriptor_digest,authority_authorized_at,state,created_at,committed_at " +
        `FROM backup_offsite_copy_replay_authority ORDER BY epoch_id,copy_id LIMIT ${INVENTORY_FETCH_LIMIT}`,
      ).all<BackupOffsiteCopyReplayAuthority>(),
      database.prepare(
        "SELECT copy_id,epoch_id,destination_id,key_generation,policy_digest,intent_digest,expires_at,failure_domain,descriptor_digest,authority_authorized_at " +
        `FROM backup_offsite_copy_receipt ORDER BY epoch_id,copy_id LIMIT ${INVENTORY_FETCH_LIMIT}`,
      ).all<CopyReceiptRow>(),
      database.prepare(
        "SELECT DISTINCT copy_id FROM backup_offsite_copy_part WHERE part_ref LIKE 'offsite/%' " +
        `ORDER BY copy_id LIMIT ${INVENTORY_FETCH_LIMIT}`,
      ).all<{ readonly copy_id: unknown }>(),
    ]);
  } catch (cause) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup O4 copy inventories are unavailable", true, cause);
  }
  const authorities = queryRows(authorityResult, "backup O4 copy-authority inventory");
  const receipts = queryRows(receiptResult, "backup O4 copy-receipt inventory").map(readCopyReceipt);
  const partialCopies = queryRows(partialResult, "backup O4 partial-copy inventory");
  const authorityById = new Map<string, BackupOffsiteCopyReplayAuthority>();
  for (const authority of authorities) {
    if (!isRecord(authority) || typeof authority.copy_id !== "string" || typeof authority.epoch_id !== "string" || authorityById.has(authority.copy_id)) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup O4 authority inventory has malformed or duplicate copy identity");
    }
    if (authority.state !== "COMMITTED" || typeof authority.committed_at !== "string" || authority.committed_at.length === 0) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup O4 inventory contains an uncommitted or unknown copy authority");
    }
    if (!knownEpochs.has(authority.epoch_id)) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup O4 copy authority refers to an epoch absent from canonical D1 inventory");
    }
    let policyDigest: string;
    try {
      const parsed = parseOffsiteCopyReplayIntent(authority);
      policyDigest = await destinationPolicyDigest(parsed.policy);
    } catch (cause) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup O4 copy policy is not valid persisted authority", false, cause);
    }
    if (policyDigest !== authority.policy_digest) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup O4 policy digest differs from its immutable authority");
    }
    authorityById.set(authority.copy_id, authority);
  }
  const receiptIds = new Set<string>();
  for (const receipt of receipts) {
    if (receiptIds.has(receipt.copy_id)) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup O4 receipt inventory contains duplicate copy identity");
    receiptIds.add(receipt.copy_id);
    const authority = authorityById.get(receipt.copy_id);
    if (authority === undefined || authority.epoch_id !== receipt.epoch_id ||
      authority.destination_id !== receipt.destination_id || authority.key_generation !== receipt.key_generation ||
      authority.policy_digest !== receipt.policy_digest || authority.intent_digest !== receipt.intent_digest ||
      authority.expires_at !== receipt.expires_at || authority.primary_failure_domain !== receipt.failure_domain ||
      authority.descriptor_digest !== receipt.descriptor_digest || authority.authority_authorized_at !== receipt.authority_authorized_at) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup O4 receipt does not match its committed persisted authority");
    }
  }
  if (receipts.length !== authorities.length) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup O4 copy receipts and committed authorities are not one-to-one");
  }
  for (const partial of partialCopies) {
    if (typeof partial.copy_id !== "string" || !authorityById.has(partial.copy_id)) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup O4 partial bytes have no persisted copy authority");
    }
  }
  return [...new Set(receipts.map((receipt) => receipt.epoch_id))].sort();
}

async function readPart(
  bucket: R2Bucket,
  epochId: string,
  vectorDigest: string,
  part: BackupEpochScopePart,
): Promise<Uint8Array | null> {
  if (!Number.isSafeInteger(part.size_bytes) || part.size_bytes < 0 || part.size_bytes > MAX_LOCAL_PART_BYTES) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup epoch part exceeds the bounded local verifier input");
  }
  const object = await bucket.get(part.part_key);
  if (object === null) return null;
  const metadata = object.customMetadata;
  if (
    object.size !== part.size_bytes || object.etag !== part.etag || !isRecord(metadata) ||
    metadata["backup_epoch"] !== epochId || metadata["backup_manifest"] !== part.manifest ||
    metadata["backup_part_index"] !== String(part.index) || metadata["backup_part_sha256"] !== part.sha256 ||
    metadata["backup_vector_digest"] !== vectorDigest || object.body === null
  ) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "local backup part metadata differs from its immutable persisted reference");
  }
  const output = new Uint8Array(part.size_bytes);
  const reader = object.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      if (offset > output.byteLength - chunk.byteLength) {
        await reader.cancel("backup part exceeded persisted size");
        erasureFail("ERASURE_CLOSURE_INCOMPLETE", "local backup part body exceeded its persisted size");
      }
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } catch (cause) {
    if (cause instanceof Error && "code" in cause) throw cause;
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "local backup part readback failed", true, cause);
  } finally {
    reader.releaseLock();
  }
  if (offset !== part.size_bytes) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "local backup part body is shorter than its persisted size");
  return output;
}

export interface D1BackupEpochScopeInventory {
  readonly archives: readonly BackupEpochScopeArchive[];
  readonly copy_authority_epoch_ids: readonly string[];
}

/** Reads exact local O2 parts and canonical epoch linkage; no caller refs grant archive authority. */
export async function readD1BackupEpochScopeInventory(
  database: D1Database,
  backupPartsBucket: R2Bucket,
): Promise<D1BackupEpochScopeInventory> {
  try {
    await assertO2MigrationAuthority(database);
  } catch (cause) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "backup O2 receipt authority is unavailable or mismatched", false, cause);
  }
  let epochResult: QueryRows<BackupEpochRow>;
  let receiptIdentityResult: QueryRows<EpochReceiptIdentityRow>;
  try {
    [epochResult, receiptIdentityResult] = await Promise.all([
      database.prepare(
        "SELECT backup_epoch_id,verification_state FROM backup_epoch ORDER BY backup_epoch_id " +
        `LIMIT ${INVENTORY_FETCH_LIMIT}`,
      ).all<BackupEpochRow>(),
      database.prepare(
        "SELECT epoch_id FROM backup_epoch_receipt ORDER BY epoch_id,idempotency_key " +
        `LIMIT ${INVENTORY_FETCH_LIMIT}`,
      ).all<EpochReceiptIdentityRow>(),
    ]);
  } catch (cause) {
    erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "backup epoch and O2 receipt inventories are unavailable", true, cause);
  }
  const epochs = queryRows(epochResult, "canonical backup epoch inventory");
  const receiptIdentities = queryRows(receiptIdentityResult, "backup O2 receipt identity inventory");
  const epochById = new Map<string, BackupEpochRow>();
  for (const row of epochs) {
    const epochId = assertErasureIdentifier(row.backup_epoch_id, "canonical backup epoch ID");
    if (epochById.has(epochId)) erasureFail("ERASURE_CLOSURE_INCOMPLETE", "canonical backup epoch inventory contains duplicate identities");
    epochById.set(epochId, row);
  }
  const receiptCounts = new Map<string, number>();
  for (const row of receiptIdentities) {
    const epochId = assertErasureIdentifier(row.epoch_id, "O2 backup receipt epoch ID");
    receiptCounts.set(epochId, (receiptCounts.get(epochId) ?? 0) + 1);
    if (!epochById.has(epochId)) {
      erasureFail("ERASURE_CLOSURE_INCOMPLETE", "O2 backup receipt has no matching canonical backup_epoch row");
    }
  }
  if (epochById.size !== receiptCounts.size || [...receiptCounts.values()].some((count) => count !== 1)) {
    erasureFail("ERASURE_CLOSURE_INCOMPLETE", "canonical backup epochs and immutable O2 receipts are not one-to-one");
  }

  const epochIds = new Set(epochById.keys());
  const copyAuthorityEpochIds = await verifiedCopyEpochIds(database, epochIds);
  const archives: BackupEpochScopeArchive[] = [...epochById.values()].map((epoch) => {
    const epochId = assertErasureIdentifier(epoch.backup_epoch_id, "canonical backup epoch ID");
    return {
      epoch_id: epochId,
      verification_state: epoch.verification_state,
      read_draft_json: async () => {
        let result: QueryRows<PersistedEpochReceiptRow>;
        try {
          result = await database.prepare(
            "SELECT epoch_id,draft_json FROM backup_epoch_receipt WHERE epoch_id=?1 ORDER BY created_at,idempotency_key LIMIT 2",
          ).bind(epochId).all<PersistedEpochReceiptRow>();
        } catch (cause) {
          erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "immutable backup epoch draft readback is unavailable", true, cause);
        }
        if (result.success !== true || !Array.isArray(result.results) || result.results.length !== 1) {
          erasureFail("ERASURE_CLOSURE_INCOMPLETE", "canonical backup epoch has no unique persisted O2 draft");
        }
        const receipt = result.results[0];
        if (receipt?.epoch_id !== epochId || typeof receipt.draft_json !== "string") {
          erasureFail("ERASURE_CLOSURE_INCOMPLETE", "persisted O2 draft does not match its canonical backup epoch");
        }
        return receipt.draft_json;
      },
      read_plaintext_part: (part, draft: BackupEpochScopeDraft) => readPart(backupPartsBucket, epochId, draft.vector_digest, part),
    };
  });
  await assertPrimaryBackupPartInventory(backupPartsBucket, archives);
  return { archives, copy_authority_epoch_ids: copyAuthorityEpochIds };
}
