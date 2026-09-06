import { BackupEpochSchema, type BackupEpoch, type OperationAttempt, type OperationIntent, type OperationReceipt } from "@eliotr/contracts";
import {
  backupAborted, backupAttempt, backupIsoDateTime, backupReceipt, backupSha256Hex,
  backupUtf8Bytes, bufferBackupStream, canonicalBackupJson, failBackup, ownedBackupBytes,
  assertBackupIdentifier, assertBackupIntent, BackupError, type BackupExportLimits,
} from "./shared.js";
import type { BackupEpochDraft, BackupSourcePorts } from "./epoch.js";
import { assertDestinationPolicy, destinationPolicyDigest, reconcileDestinationDescriptor, type BackupDestinationPolicy, type OffsiteDestinationDescriptor } from "./destination-policy.js";

// ER-34 O2 encrypted offsite copy. Encryption happens before the destination
// boundary; KEK/key bytes never enter the epoch, logs, receipts or fixtures.

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
  readonly destination_policy: BackupDestinationPolicy;
  readonly adapter: OffsiteCopyAdapter;
  readonly signal?: AbortSignal;
  readonly now_ms?: number;
  readonly generate_nonce?: () => Uint8Array;
}

export interface OffsiteCopyResult {
  readonly epoch: BackupEpoch;
  readonly offsite_copy_ref: string;
  readonly readback_digest: string;
  readonly attempt: OperationAttempt;
  readonly receipt: OperationReceipt;
}

function assertAes256GcmKey(key: CryptoKey): void {
  const algo = (key as unknown as { readonly algorithm?: unknown }).algorithm as { readonly name?: unknown; readonly length?: unknown } | undefined;
  if (algo?.name !== "AES-GCM" || algo?.length !== 256) failBackup("BACKUP_KEY_INVALID", "offsite encryption key must be AES-256-GCM with 256-bit strength");
  if (key.type !== "secret") failBackup("BACKUP_KEY_INVALID", "offsite encryption key must be a secret key");
  const usages = key.usages as readonly string[];
  if (!usages.includes("encrypt") || !usages.includes("decrypt")) failBackup("BACKUP_KEY_INVALID", "offsite encryption key must allow encrypt and decrypt");
}

async function canonicalAad(input: { epoch_id: string; manifest: string; index: number; part_ref: string; part_sha256: string; destination_policy_digest: string; key_generation: string; expires_at: string; retention_policy_ref: string; expiry_identity: string }): Promise<Uint8Array<ArrayBuffer>> {
  return backupUtf8Bytes(canonicalBackupJson(input));
}

async function encryptBackupPart(key: CryptoKey, aad: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (nonce.byteLength !== 12) failBackup("BACKUP_KEY_INVALID", "offsite nonce must be 96 bits");
  let sealed: ArrayBuffer;
  try {
    sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as unknown as BufferSource, additionalData: aad as unknown as BufferSource }, key, ownedBackupBytes(plaintext));
  } catch (cause) {
    failBackup("BACKUP_OFFSITE_READBACK_MISMATCH", "offsite encryption failed", false, {}, cause);
  }
  const out = new Uint8Array(12 + sealed.byteLength);
  out.set(nonce, 0);
  out.set(new Uint8Array(sealed), 12);
  return out;
}

async function decryptBackupPart(key: CryptoKey, aad: Uint8Array, sealed: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (sealed.byteLength < 28) failBackup("BACKUP_OFFSITE_READBACK_MISMATCH", "offsite ciphertext is truncated", false, {});
  const iv = sealed.slice(0, 12);
  const body = sealed.slice(12);
  try {
    const open = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource, additionalData: aad as unknown as BufferSource }, key, body as unknown as BufferSource);
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
  assertAes256GcmKey(input.encryption_key);
  const policy = assertDestinationPolicy(input.destination_policy);
  if (policy.destination_id.length === 0) failBackup("BACKUP_INPUT_INVALID", "destination policy is empty");
  const nowMs = input.now_ms ?? Date.now();
  const now = backupIsoDateTime(nowMs);
  const signal = input.signal;
  const draft = input.draft;
  if (draft.part_index.length === 0) failBackup("BACKUP_INPUT_INVALID", "backup draft carries no audited parts");
  if (draft.vector_digest.length !== 64) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup draft carries no complete authority vector binding");
  const policyDigest = await destinationPolicyDigest(policy);
  const descriptor = await input.adapter.describe();
  reconcileDestinationDescriptor(policy, descriptor, primaryDomain);
  if (descriptor.expires_at !== undefined && Date.parse(descriptor.expires_at) <= nowMs) {
    failBackup("BACKUP_OFFSITE_EXPIRED", "offsite destination admissibility has expired", false, { destination: descriptor.destination_id });
  }
  if (descriptor.retention_locked) {
    throw new BackupError("BACKUP_PURGE_BLOCKED", "offsite destination is retention-locked; copy withheld for review, nothing deleted", false,
      { destination: descriptor.destination_id, next_review_at: descriptor.expires_at ?? draft.expires_at });
  }
  const usedNonces = new Set<string>();
  const freshNonce = (): Uint8Array<ArrayBuffer> => {
    const nonce = input.generate_nonce !== undefined ? ownedBackupBytes(input.generate_nonce()) : ownedBackupBytes(crypto.getRandomValues(new Uint8Array(12)));
    if (nonce.byteLength !== 12) failBackup("BACKUP_KEY_INVALID", "offsite nonce must be 96 bits");
    const hex = [...nonce].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (usedNonces.has(hex)) failBackup("BACKUP_NONCE_COLLISION", "offsite nonce reuse detected within the copy operation", false, {});
    usedNonces.add(hex);
    return nonce;
  };
  let reconciled = false;
  const remoteRefs: string[] = [];
  for (const part of draft.part_index) {
    if (backupAborted(signal)) failBackup("BACKUP_CANCELLED", "backup offsite copy was cancelled", true);
    const partRef = `offsite/${draft.epoch_id}/${part.manifest}/${String(part.index).padStart(6, "0")}-${part.sha256}`;
    const reopened = await ports.part_sink.open(part.part_key);
    if (reopened === null) failBackup("BACKUP_PART_READBACK_MISMATCH", "backup part is absent before offsite copy", false, { manifest: part.manifest });
    const plaintext = await bufferBackupStream(reopened.body, limits.max_object_bytes);
    if (plaintext.byteLength !== part.size_bytes) failBackup("BACKUP_PART_READBACK_MISMATCH", "backup part size disagrees before offsite copy", false, { manifest: part.manifest });
    const aad = await canonicalAad({
      epoch_id: draft.epoch_id, manifest: part.manifest, index: part.index, part_ref: partRef,
      part_sha256: part.sha256, destination_policy_digest: policyDigest,
      key_generation: keyGeneration, expires_at: draft.expires_at,
      retention_policy_ref: policy.retention_policy_ref, expiry_identity: policy.expiry_identity,
    });
    const ciphertext = await encryptBackupPart(input.encryption_key, aad, freshNonce(), plaintext);
    const stored = { content_digest: part.sha256, size_bytes: part.size_bytes, key_generation: keyGeneration, epoch_id: draft.epoch_id, expires_at: draft.expires_at };
    let acknowledged = false;
    try {
      await input.adapter.put(partRef, ciphertext, stored);
      acknowledged = true;
    } catch (cause) {
      if (!(cause instanceof BackupError) || cause.code !== "BACKUP_OFFSITE_UNCERTAIN") throw cause;
    }
    if (!acknowledged) {
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
    if (remote.stored.content_digest !== part.sha256 || remote.stored.size_bytes !== part.size_bytes || remote.stored.key_generation !== keyGeneration || remote.stored.epoch_id !== draft.epoch_id || remote.stored.expires_at !== draft.expires_at) {
      failBackup("BACKUP_OFFSITE_READBACK_MISMATCH", "offsite part metadata was altered", false, {});
    }
    const decrypted = await decryptBackupPart(input.encryption_key, aad, remote.ciphertext);
    if (decrypted.byteLength !== part.size_bytes || await backupSha256Hex(decrypted) !== part.sha256) {
      failBackup("BACKUP_OFFSITE_READBACK_MISMATCH", "offsite part plaintext digest disagrees on readback", false, {});
    }
    remoteRefs.push(partRef);
  }
  const offsiteCopyRef = `offsite-${(await backupSha256Hex(`offsite-copy\u0000${draft.epoch_id}\u0000${draft.vector_digest}\u0000${policyDigest}\u0000${policy.authorization_receipt_ref}\u0000${keyGeneration}\u0000${remoteRefs.join(",")}`)).slice(0, 48)}`;
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
    [draft.epoch_id, offsiteCopyRef], [draft.audit_sample_receipt_ref, readbackDigest, policyDigest, policy.authorization_receipt_ref], reconciled,
    reconciled ? ["OFFSITE_ACK_RECONCILED", `POLICY:${policy.policy_version}`] : [`POLICY:${policy.policy_version}`], now);
  return { epoch, offsite_copy_ref: offsiteCopyRef, readback_digest: readbackDigest, attempt, receipt };
}

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
  const tombstones = new Set<string>();
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
      if (tombstones.has(part_ref)) {
        throw new BackupError("BACKUP_RESURRECTION_REFUSED", "offsite immutable ref was terminally expired; resurrection refused", false, {});
      }
      if (objects.has(part_ref)) {
        const prior = objects.get(part_ref) as { readonly ciphertext: Uint8Array<ArrayBuffer>; readonly stored: Omit<OffsiteStoredPart, "ciphertext"> };
        if (prior.stored.content_digest !== stored.content_digest || prior.stored.size_bytes !== stored.size_bytes || prior.stored.epoch_id !== stored.epoch_id) {
          throw new BackupError("BACKUP_RESURRECTION_REFUSED", "offsite immutable ref already holds divergent bytes; resurrection refused", false, {});
        }
        if (lostAcks < loseAfter) {
          lostAcks += 1;
          throw new BackupError("BACKUP_OFFSITE_UNCERTAIN", "controlled offsite acknowledgement was lost after a durable write", true, {});
        }
        return { ack_ref: `ack-${part_ref.length}-${puts}` };
      }
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
      tombstones.add(part_ref);
      journal.push({ journal_ref: journalRef, part_ref, reason });
      return { journal_ref: journalRef };
    },
  };
}
