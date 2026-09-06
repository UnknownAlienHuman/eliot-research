import { BackupEpochSchema, type BackupEpoch, type OperationAttempt, type OperationIntent, type OperationReceipt } from "@eliotr/contracts";
import { bufferBounded } from "./r2.js";
import {
  assertBackupIdentifier,
  assertBackupIntent,
  backupAborted,
  backupAttempt,
  backupIsoDateTime,
  backupReceipt,
  backupSha256Hex,
  backupUtf8Bytes,
  failBackup,
  ownedBackupBytes,
  BackupError,
  type BackupExportLimits,
} from "./backup-shared.js";
import type { BackupEpochDraft, BackupSourcePorts } from "./backup-epoch.js";

// ER-34 O2 encrypted independent offsite copy. Encryption happens before the
// destination boundary; KEK/key bytes and credentials are injected and never
// enter the epoch, logs, receipts or fixtures. Expiry and deletion-journal
// semantics also serve future erasure; a retained/locked destination yields
// a typed PURGE_BLOCKED-class receipt with review metadata, never "deleted".

export interface OffsiteDestinationDescriptor {
  readonly destination_id: string;
  readonly failure_domain: string;
  readonly supports_deletion_journal: boolean;
  readonly supports_expiry: boolean;
  readonly retention_locked: boolean;
  readonly legal_hold_ref?: string;
  readonly expires_at?: string;
}

export interface OffsiteStoredPart {
  readonly ciphertext: Uint8Array;
  readonly content_digest: string;
  readonly size_bytes: number;
  readonly key_generation: string;
  readonly epoch_id: string;
  readonly expires_at: string;
}

export interface OffsiteCopyAdapter {
  describe(): Promise<OffsiteDestinationDescriptor> | OffsiteDestinationDescriptor;
  put(part_ref: string, ciphertext: Uint8Array, stored: Omit<OffsiteStoredPart, "ciphertext">): Promise<{ readonly ack_ref: string }>;
  get(part_ref: string): Promise<{ readonly ciphertext: Uint8Array; readonly stored: Omit<OffsiteStoredPart, "ciphertext"> } | null>;
  delete(part_ref: string, reason: string): Promise<{ readonly journal_ref: string }>;
}

export interface OffsiteCopyInput {
  readonly draft: BackupEpochDraft;
  readonly intent: OperationIntent;
  readonly attempt_number?: number;
  readonly encryption_key: CryptoKey;
  readonly key_generation: string;
  readonly primary_failure_domain: string;
  readonly adapter: OffsiteCopyAdapter;
  readonly signal?: AbortSignal;
  readonly now_ms?: number;
}

export interface OffsiteCopyResult {
  readonly epoch: BackupEpoch;
  readonly offsite_copy_ref: string;
  readonly readback_digest: string;
  readonly attempt: OperationAttempt;
  readonly receipt: OperationReceipt;
}

async function encryptBackupPart(key: CryptoKey, partRef: string, plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: backupUtf8Bytes(partRef) }, key, ownedBackupBytes(plaintext));
  const out = new Uint8Array(12 + sealed.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(sealed), 12);
  return out;
}

async function decryptBackupPart(key: CryptoKey, partRef: string, sealed: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (sealed.byteLength < 13) failBackup("BACKUP_OFFSITE_READBACK_MISMATCH", "offsite ciphertext is truncated", false, {});
  const iv = sealed.slice(0, 12);
  const body = sealed.slice(12);
  try {
    const open = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: backupUtf8Bytes(partRef) }, key, body);
    return ownedBackupBytes(new Uint8Array(open));
  } catch (cause) {
    failBackup("BACKUP_OFFSITE_READBACK_MISMATCH", "offsite ciphertext fails authenticated decryption", false, {}, cause);
  }
}

export async function copyOffsiteExport(ports: BackupSourcePorts, limits: BackupExportLimits, input: OffsiteCopyInput): Promise<OffsiteCopyResult> {
  const intent = assertBackupIntent(input.intent);
  const attemptNumber = input.attempt_number ?? 1;
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) failBackup("BACKUP_INPUT_INVALID", "backup attempt number is invalid");
  const keyGeneration = assertBackupIdentifier(input.key_generation, "encryption key generation");
  const primaryDomain = assertBackupIdentifier(input.primary_failure_domain, "primary failure domain");
  const nowMs = input.now_ms ?? Date.now();
  const now = backupIsoDateTime(nowMs);
  const signal = input.signal;
  const draft = input.draft;
  if (draft.part_index.length === 0) failBackup("BACKUP_INPUT_INVALID", "backup draft carries no audited parts");

  const descriptor = await input.adapter.describe();
  assertBackupIdentifier(descriptor.destination_id, "offsite destination identity");
  assertBackupIdentifier(descriptor.failure_domain, "offsite failure domain");
  if (descriptor.failure_domain === primaryDomain) {
    failBackup("BACKUP_OFFSITE_INADMISSIBLE", "offsite destination shares the primary failure domain", false, { destination: descriptor.destination_id });
  }
  if (!descriptor.supports_deletion_journal || !descriptor.supports_expiry) {
    failBackup("BACKUP_OFFSITE_INADMISSIBLE", "offsite destination cannot honor purge/expiry", false, { destination: descriptor.destination_id });
  }
  if (descriptor.legal_hold_ref !== undefined) {
    failBackup("BACKUP_OFFSITE_INADMISSIBLE", "offsite destination reports a legal retention conflict", false, { destination: descriptor.destination_id });
  }
  if (descriptor.expires_at !== undefined && Date.parse(descriptor.expires_at) <= nowMs) {
    failBackup("BACKUP_OFFSITE_EXPIRED", "offsite destination admissibility has expired", false, { destination: descriptor.destination_id });
  }
  if (descriptor.retention_locked) {
    throw new BackupError("BACKUP_PURGE_BLOCKED", "offsite destination is retention-locked; copy withheld for review, nothing deleted", false,
      { destination: descriptor.destination_id, next_review_at: descriptor.expires_at ?? draft.expires_at });
  }

  let reconciled = false;
  const remoteRefs: string[] = [];
  for (const part of draft.part_index) {
    if (backupAborted(signal)) failBackup("BACKUP_CANCELLED", "backup offsite copy was cancelled", true);
    const partRef = `offsite/${draft.epoch_id}/${part.manifest}/${String(part.index).padStart(6, "0")}-${part.sha256}`;
    const reopened = await ports.part_sink.open(part.part_key);
    if (reopened === null) failBackup("BACKUP_PART_READBACK_MISMATCH", "backup part is absent before offsite copy", false, { manifest: part.manifest });
    const plaintext = await bufferBounded(reopened.body, limits.max_object_bytes);
    if (plaintext.byteLength !== part.size_bytes) failBackup("BACKUP_PART_READBACK_MISMATCH", "backup part size disagrees before offsite copy", false, { manifest: part.manifest });
    const ciphertext = await encryptBackupPart(input.encryption_key, partRef, plaintext);
    const stored = { content_digest: part.sha256, size_bytes: part.size_bytes, key_generation: keyGeneration, epoch_id: draft.epoch_id, expires_at: draft.expires_at };
    let acknowledged = false;
    try {
      await input.adapter.put(partRef, ciphertext, stored);
      acknowledged = true;
    } catch (cause) {
      if (!(cause instanceof BackupError) || cause.code !== "BACKUP_OFFSITE_UNCERTAIN") throw cause;
    }
    if (!acknowledged) {
      // Lost/unknown ACK reconciles via the stable intent+content digest:
      // read back the same identity instead of writing a blind second copy.
      const existing = await input.adapter.get(partRef);
      if (existing === null) {
        await input.adapter.put(partRef, ciphertext, stored);
      } else {
        reconciled = true;
        if (existing.stored.content_digest !== part.sha256 || existing.stored.size_bytes !== part.size_bytes) {
          failBackup("BACKUP_OFFSITE_READBACK_MISMATCH", "offsite copy reconciles to divergent content", false, {});
        }
      }
    }
    const remote = await input.adapter.get(partRef);
    if (remote === null) failBackup("BACKUP_OFFSITE_READBACK_MISMATCH", "offsite part is absent on readback", true, {});
    if (remote.stored.content_digest !== part.sha256 || remote.stored.size_bytes !== part.size_bytes || remote.stored.key_generation !== keyGeneration || remote.stored.epoch_id !== draft.epoch_id) {
      failBackup("BACKUP_OFFSITE_READBACK_MISMATCH", "offsite part metadata was altered", false, {});
    }
    const decrypted = await decryptBackupPart(input.encryption_key, partRef, remote.ciphertext);
    if (decrypted.byteLength !== part.size_bytes || await backupSha256Hex(decrypted) !== part.sha256) {
      failBackup("BACKUP_OFFSITE_READBACK_MISMATCH", "offsite part plaintext digest disagrees on readback", false, {});
    }
    remoteRefs.push(partRef);
  }

  const offsiteCopyRef = `offsite-${(await backupSha256Hex(`offsite-copy\u0000${draft.epoch_id}\u0000${descriptor.destination_id}\u0000${keyGeneration}\u0000${remoteRefs.join(",")}`)).slice(0, 48)}`;
  const readbackDigest = await backupSha256Hex(remoteRefs.join("\n"));
  const epoch: BackupEpoch = BackupEpochSchema.parse({
    epoch_ref: { id: draft.epoch_id, revision: 1 },
    schema_generation: draft.schema_generation,
    migration_ledger_digest: draft.migration_ledger_digest,
    core_export_manifest_ref: draft.group_digests["core"] ?? "",
    r2_object_manifest_ref: draft.group_digests["r2"] ?? "",
    head_manifest_ref: draft.group_digests["heads"] ?? "",
    generation_manifest_ref: draft.group_digests["generations"] ?? "",
    purge_ledger_revision: draft.purge_ledger_revision,
    purge_ledger_digest: draft.purge_ledger_digest,
    offsite_copy_ref: offsiteCopyRef,
    offsite_failure_domain: descriptor.failure_domain,
    encryption_key_generation: keyGeneration,
    audit_sample_receipt_ref: draft.audit_sample_receipt_ref,
    created_at: draft.created_at,
    expires_at: draft.expires_at,
  });
  const attempt = backupAttempt(intent, attemptNumber, "SUCCEEDED", now);
  const receipt = backupReceipt(intent, attempt.attempt_id, "SUCCEEDED",
    [draft.epoch_id, offsiteCopyRef], [draft.audit_sample_receipt_ref, readbackDigest], reconciled,
    reconciled ? ["OFFSITE_ACK_RECONCILED"] : [], now);
  return { epoch, offsite_copy_ref: offsiteCopyRef, readback_digest: readbackDigest, attempt, receipt };
}

// Controlled encrypted destination adapter for tests: real AES-GCM bytes,
// real readback and a real deletion journal, with no external credentials
// and no live-provider receipt claim.
export interface ControlledOffsiteFaults {
  readonly lose_ack_after_puts?: number;
  readonly corrupt_readback?: "none" | "bytes" | "truncate" | "metadata";
}

export interface ControlledOffsiteAdapter extends OffsiteCopyAdapter {
  readonly journal: readonly { readonly journal_ref: string; readonly part_ref: string; readonly reason: string }[];
  readonly puts: number;
  peek(part_ref: string): Uint8Array<ArrayBuffer> | null;
}

export function createControlledOffsiteAdapter(options: {
  readonly destination_id: string;
  readonly failure_domain: string;
  readonly supports_deletion_journal?: boolean;
  readonly supports_expiry?: boolean;
  readonly retention_locked?: boolean;
  readonly legal_hold_ref?: string;
  readonly expires_at?: string;
  readonly faults?: ControlledOffsiteFaults;
}): ControlledOffsiteAdapter {
  const objects = new Map<string, { readonly ciphertext: Uint8Array<ArrayBuffer>; readonly stored: Omit<OffsiteStoredPart, "ciphertext"> }>();
  const journal: { readonly journal_ref: string; readonly part_ref: string; readonly reason: string }[] = [];
  let puts = 0;
  let lostAcks = 0;
  const loseAfter = options.faults?.lose_ack_after_puts ?? 0;
  const corrupt = options.faults?.corrupt_readback ?? "none";
  return {
    get journal() { return journal; },
    get puts() { return puts; },
    peek(part_ref) {
      const found = objects.get(part_ref);
      return found === undefined ? null : ownedBackupBytes(found.ciphertext);
    },
    describe(): OffsiteDestinationDescriptor {
      return {
        destination_id: options.destination_id,
        failure_domain: options.failure_domain,
        supports_deletion_journal: options.supports_deletion_journal ?? true,
        supports_expiry: options.supports_expiry ?? true,
        retention_locked: options.retention_locked ?? false,
        ...(options.legal_hold_ref === undefined ? {} : { legal_hold_ref: options.legal_hold_ref }),
        ...(options.expires_at === undefined ? {} : { expires_at: options.expires_at }),
      };
    },
    async put(part_ref, ciphertext, stored): Promise<{ readonly ack_ref: string }> {
      puts += 1;
      objects.set(part_ref, { ciphertext: ownedBackupBytes(ciphertext), stored });
      if (lostAcks < loseAfter) {
        lostAcks += 1;
        throw new BackupError("BACKUP_OFFSITE_UNCERTAIN", "controlled offsite acknowledgement was lost after a durable write", true, {});
      }
      return { ack_ref: `ack-${part_ref.length}-${puts}` };
    },
    async get(part_ref) {
      const found = objects.get(part_ref);
      if (found === undefined) return null;
      if (corrupt === "bytes") {
        const broken = ownedBackupBytes(found.ciphertext);
        broken[0] = (broken[0] ?? 0) ^ 0xff;
        return { ciphertext: broken, stored: found.stored };
      }
      if (corrupt === "truncate") {
        return { ciphertext: found.ciphertext.slice(0, Math.max(0, found.ciphertext.byteLength - 8)), stored: found.stored };
      }
      if (corrupt === "metadata") {
        return { ciphertext: ownedBackupBytes(found.ciphertext), stored: { ...found.stored, content_digest: "0".repeat(64) } };
      }
      return { ciphertext: ownedBackupBytes(found.ciphertext), stored: found.stored };
    },
    async delete(part_ref, reason) {
      const journalRef = `journal-${journal.length + 1}-${part_ref.length}`;
      objects.delete(part_ref);
      journal.push({ journal_ref: journalRef, part_ref, reason });
      return { journal_ref: journalRef };
    },
  };
}
