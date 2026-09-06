import { BackupEpochSchema, OperationAttemptSchema, OperationReceiptSchema, type BackupEpoch, type OperationAttempt, type OperationIntent, type OperationReceipt } from "@eliotr/contracts";
import {
  backupAborted, backupAttempt, backupReceipt, backupSha256Hex,
  backupUtf8Bytes, bufferBackupStream, canonicalBackupJson, failBackup, ownedBackupBytes,
  assertBackupIdentifier, assertBackupIntent, BackupError, type BackupExportLimits,
} from "./shared.js";
import type { BackupEpochDraft, BackupSourcePorts } from "./epoch.js";
import { assertDestinationPolicy, destinationDescriptorDigest, destinationPolicyDigest, reconcileDestinationDescriptor, type BackupDestinationPolicy, type OffsiteDestinationDescriptor } from "./destination-policy.js";
import { requireDestinationAuthority } from "./destination-authority.js";
import { readEpochDraftById } from "./replay-authority.js";
import { assertO2MigrationAuthority } from "./migration-gate.js";
import { allocateOffsiteNonce } from "./nonce-authority.js";
import { canonicalOffsiteCopyDigest } from "./intent-digest.js";
import {
  backupIsoNow, backupNonceHex, commitCopyReceipt, copyIdForDigest,
  deriveBackupNonce, readCopyCheckpoints, readCopyReceipt, recordCopyCheckpoint, resolveControllerClock,
} from "./offsite-durability.js";

// ER-34 O2 FIX2 encrypted offsite copy. Encryption happens before the
// destination boundary; KEK/key bytes never enter the epoch, logs, receipts
// or fixtures.
//
// Authority: the destination policy must equal the controller-owned persisted
// authority bound to the initiating principal + approved policy decision;
// caller owner/auth refs never self-authorize. The epoch draft must equal the
// D1-persisted draft bytes (caller drafts never trusted). The admissibility
// clock is controller-disciplined (caller timestamps beyond skew fail closed).
//
// Durability: part checkpoints + the success receipt persist in D1, so restart
// or cancellation resumes from controller-owned state. Nonces derive
// deterministically from (key generation, copy, part ref, content digest,
// policy) or from a controller allocator; every nonce is claimed in the durable
// globally-unique nonce authority BEFORE encryption or remote put, so reuse
// across copies, parts, restarts, concurrent allocators, forged rows or key
// generations collides closed with zero ciphertext produced. Exact replay of a
// committed copy returns the
// persisted receipt/epoch bytes verbatim.

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
  const clockMs = resolveControllerClock(input.now_ms);
  const now = backupIsoNow(clockMs);
  const signal = input.signal;
  const draft = input.draft;
  if (draft.part_index.length === 0) failBackup("BACKUP_INPUT_INVALID", "backup draft carries no audited parts");
  if (draft.vector_digest.length !== 64) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup draft carries no complete authority vector binding");
  await assertO2MigrationAuthority(ports.core_db);
  // Controller-owned authority first: caller policy must equal the persisted
  // grant for (destination, initiating principal, policy decision).
  const authority = await requireDestinationAuthority(ports.core_db, intent, policy);
  // Caller draft bytes are never trusted: the D1-persisted epoch draft is
  // authority, including its expires_at.
  const persistedEpoch = await readEpochDraftById(ports.core_db, draft.epoch_id);
  if (persistedEpoch === null) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup epoch is unknown to D1 replay authority; caller drafts never authorize copies");
  if (canonicalBackupJson(JSON.parse(JSON.stringify(draft)) as unknown) !== canonicalBackupJson(JSON.parse(persistedEpoch.draft_json) as unknown)) {
    failBackup("BACKUP_INTENT_CONFLICT", "caller epoch draft diverges from D1-persisted bytes", false, {});
  }
  let persistedDraft: BackupEpochDraft;
  try {
    persistedDraft = JSON.parse(persistedEpoch.draft_json) as BackupEpochDraft;
  } catch (cause) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "D1-persisted epoch draft is corrupt", false, {}, cause);
  }
  const policyDigest = await destinationPolicyDigest(authority.policy);
  const descriptor = await input.adapter.describe();
  reconcileDestinationDescriptor(authority.policy, descriptor, primaryDomain);
  const descriptorDigest = await destinationDescriptorDigest(descriptor);
  if (descriptor.expires_at !== undefined && Date.parse(descriptor.expires_at) <= clockMs) {
    failBackup("BACKUP_OFFSITE_EXPIRED", "offsite destination admissibility has expired", false, { destination: descriptor.destination_id });
  }
  if (descriptor.retention_locked) {
    throw new BackupError("BACKUP_PURGE_BLOCKED", "offsite destination is retention-locked; copy withheld for review, nothing deleted", false,
      { destination: descriptor.destination_id, next_review_at: descriptor.expires_at ?? persistedDraft.expires_at });
  }
  const storedIntentDigest = await canonicalOffsiteCopyDigest(intent, {
    epoch_id: persistedDraft.epoch_id, destination_id: authority.destination_id, policy_digest: policyDigest,
    authorization_receipt_ref: authority.authorization_receipt_ref, key_generation: keyGeneration,
    expires_at: persistedDraft.expires_at, retention_policy_ref: authority.policy.retention_policy_ref,
    expiry_identity: authority.policy.expiry_identity,
  });
  const copyId = await copyIdForDigest({ epoch_id: persistedDraft.epoch_id, destination_id: authority.destination_id, key_generation: keyGeneration, policy_digest: policyDigest, intent_digest: storedIntentDigest });
  // Exact replay of a committed copy returns persisted bytes verbatim.
  const committed = await readCopyReceipt(ports.core_db, copyId);
  if (committed !== null) {
    if (committed.epoch_id !== persistedDraft.epoch_id || committed.destination_id !== authority.destination_id || committed.key_generation !== keyGeneration || committed.policy_digest !== policyDigest || committed.intent_digest !== storedIntentDigest || committed.failure_domain !== descriptor.failure_domain || committed.descriptor_digest !== descriptorDigest || committed.authority_authorized_at !== authority.authorized_at) {
      failBackup("BACKUP_INTENT_CONFLICT", "offsite copy identity reuses divergent content", false, {});
    }
    let receipt: OperationReceipt;
    let epoch: BackupEpoch;
    let attempt: OperationAttempt;
    try {
      receipt = OperationReceiptSchema.parse(JSON.parse(committed.receipt_json) as unknown);
      epoch = BackupEpochSchema.parse(JSON.parse(committed.epoch_json) as unknown);
      attempt = OperationAttemptSchema.parse(JSON.parse(committed.attempt_json) as unknown);
    } catch (cause) {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", "persisted offsite copy bytes are corrupt", false, {}, cause);
    }
    return { epoch, offsite_copy_ref: epoch.offsite_copy_ref, readback_digest: committed.readback_digest, attempt, receipt };
  }
  let checkpoints = await readCopyCheckpoints(ports.core_db, copyId);
  let reconciled = false;
  const remoteRefs: string[] = [];
  for (const part of persistedDraft.part_index) {
    if (backupAborted(signal)) failBackup("BACKUP_CANCELLED", "backup offsite copy was cancelled", true);
    const partRef = `offsite/${persistedDraft.epoch_id}/${part.manifest}/${String(part.index).padStart(6, "0")}-${part.sha256}`;
    const checkpoint = checkpoints.get(partRef);
    if (checkpoint !== undefined && checkpoint.content_digest === part.sha256 && checkpoint.size_bytes === part.size_bytes && checkpoint.state === "VERIFIED") {
      // Durable resume: the recorded nonce must equal the deterministic
      // derivation (tamper collides), then re-verify remote before skipping.
      const expected = await deriveBackupNonce({ key_generation: keyGeneration, copy_id: copyId, part_ref: partRef, content_digest: part.sha256, policy_digest: policyDigest });
      if (backupNonceHex(expected) !== checkpoint.nonce_hex && input.generate_nonce === undefined) {
        failBackup("BACKUP_NONCE_COLLISION", "backup copy checkpoint nonce was tampered; refusing resume", false, { copy: copyId });
      }
      // Durable resume: re-verify the remote part before skipping local work.
      const present = await input.adapter.get(partRef);
      if (present === null) failBackup("BACKUP_OFFSITE_READBACK_MISMATCH", "offsite checkpointed part is absent on resume; refusing silent skip", true, {});
      if (present.stored.content_digest !== part.sha256 || present.stored.size_bytes !== part.size_bytes || present.stored.key_generation !== keyGeneration || present.stored.epoch_id !== persistedDraft.epoch_id || present.stored.expires_at !== persistedDraft.expires_at) {
        failBackup("BACKUP_OFFSITE_READBACK_MISMATCH", "offsite checkpointed part metadata was altered", false, {});
      }
      reconciled = true;
      remoteRefs.push(partRef);
      continue;
    }
    if (checkpoint !== undefined && (checkpoint.content_digest !== part.sha256 || checkpoint.size_bytes !== part.size_bytes)) {
      failBackup("BACKUP_INTENT_CONFLICT", "offsite checkpoint binds this ref to divergent content", false, {});
    }
    const reopened = await ports.part_sink.open(part.part_key);
    if (reopened === null) failBackup("BACKUP_PART_READBACK_MISMATCH", "backup part is absent before offsite copy", false, { manifest: part.manifest });
    const plaintext = await bufferBackupStream(reopened.body, limits.max_object_bytes);
    if (plaintext.byteLength !== part.size_bytes) failBackup("BACKUP_PART_READBACK_MISMATCH", "backup part size disagrees before offsite copy", false, { manifest: part.manifest });
    const aad = await canonicalAad({
      epoch_id: persistedDraft.epoch_id, manifest: part.manifest, index: part.index, part_ref: partRef,
      part_sha256: part.sha256, destination_policy_digest: policyDigest,
      key_generation: keyGeneration, expires_at: persistedDraft.expires_at,
      retention_policy_ref: authority.policy.retention_policy_ref, expiry_identity: authority.policy.expiry_identity,
    });
    const candidate = input.generate_nonce !== undefined
      ? ownedBackupBytes(input.generate_nonce())
      : await deriveBackupNonce({ key_generation: keyGeneration, copy_id: copyId, part_ref: partRef, content_digest: part.sha256, policy_digest: policyDigest });
    // Durable pre-encrypt checks: a checkpoint that binds this part to a
    // different nonce, or this candidate nonce to a different part, collides
    // here (durable D1 read, not an in-memory set).
    const candidateHex = backupNonceHex(candidate);
    const bound = checkpoints.get(partRef);
    if (bound !== undefined && bound.nonce_hex !== candidateHex) {
      failBackup("BACKUP_NONCE_COLLISION", "backup copy checkpoint binds this owner to a different nonce; refusing silent re-allocation", false, { copy: copyId });
    }
    for (const [ref, checkpoint] of checkpoints) {
      if (ref !== partRef && checkpoint.nonce_hex === candidateHex) {
        failBackup("BACKUP_NONCE_COLLISION", "backup nonce reuse detected across parts (durable checkpoint record); refusing encryption", false, { copy: copyId });
      }
    }
    // Durable global claim BEFORE encryption or remote put: cross-copy,
    // cross-part, cross-generation, restart, concurrent or forged reuse
    // collides here with zero ciphertext produced. Exact same owner with the
    // same nonce replays idempotently.
    const nonce = await allocateOffsiteNonce(ports.core_db, { key_generation: keyGeneration, copy_id: copyId, part_ref: partRef, nonce: candidate, created_at: now });
    const nonceHex = backupNonceHex(nonce);
    const ciphertext = await encryptBackupPart(input.encryption_key, aad, nonce, plaintext);
    const stored = { content_digest: part.sha256, size_bytes: part.size_bytes, key_generation: keyGeneration, epoch_id: persistedDraft.epoch_id, expires_at: persistedDraft.expires_at };
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
    if (remote.stored.content_digest !== part.sha256 || remote.stored.size_bytes !== part.size_bytes || remote.stored.key_generation !== keyGeneration || remote.stored.epoch_id !== persistedDraft.epoch_id || remote.stored.expires_at !== persistedDraft.expires_at) {
      failBackup("BACKUP_OFFSITE_READBACK_MISMATCH", "offsite part metadata was altered", false, {});
    }
    const decrypted = await decryptBackupPart(input.encryption_key, aad, remote.ciphertext);
    if (decrypted.byteLength !== part.size_bytes || await backupSha256Hex(decrypted) !== part.sha256) {
      failBackup("BACKUP_OFFSITE_READBACK_MISMATCH", "offsite part plaintext digest disagrees on readback", false, {});
    }
    await recordCopyCheckpoint(ports.core_db, copyId, { part_ref: partRef, content_digest: part.sha256, size_bytes: part.size_bytes, nonce_hex: nonceHex, state: "VERIFIED" }, now);
    checkpoints = await readCopyCheckpoints(ports.core_db, copyId);
    remoteRefs.push(partRef);
  }
  const offsiteCopyRef = `offsite-${(await backupSha256Hex(`offsite-copy\u0000${persistedDraft.epoch_id}\u0000${persistedDraft.vector_digest}\u0000${policyDigest}\u0000${authority.authorization_receipt_ref}\u0000${keyGeneration}\u0000${remoteRefs.join(",")}`)).slice(0, 48)}`;
  const readbackDigest = await backupSha256Hex(remoteRefs.join("\n"));
  const epoch: BackupEpoch = BackupEpochSchema.parse({
    epoch_ref: { id: persistedDraft.epoch_id, revision: 1 },
    schema_generation: persistedDraft.schema_generation,
    migration_ledger_digest: persistedDraft.migration_ledger_digest,
    core_export_manifest_ref: persistedDraft.group_digests["core"] ?? "",
    r2_object_manifest_ref: persistedDraft.group_digests["r2"] ?? "",
    head_manifest_ref: persistedDraft.group_digests["heads"] ?? "",
    generation_manifest_ref: persistedDraft.group_digests["generations"] ?? "",
    purge_ledger_revision: persistedDraft.purge_ledger_revision,
    purge_ledger_digest: persistedDraft.purge_ledger_digest,
    offsite_copy_ref: offsiteCopyRef,
    offsite_failure_domain: descriptor.failure_domain,
    encryption_key_generation: keyGeneration,
    audit_sample_receipt_ref: persistedDraft.audit_sample_receipt_ref,
    created_at: persistedDraft.created_at,
    expires_at: persistedDraft.expires_at,
  });
  const receipt = backupReceipt(intent, backupAttempt(intent, attemptNumber, "SUCCEEDED", now).attempt_id, "SUCCEEDED",
    [persistedDraft.epoch_id, offsiteCopyRef], [persistedDraft.audit_sample_receipt_ref, readbackDigest, policyDigest, authority.authorization_receipt_ref], reconciled,
    reconciled ? ["OFFSITE_ACK_RECONCILED", `POLICY:${authority.policy.policy_version}`] : [`POLICY:${authority.policy.policy_version}`], now);
  const attempt = backupAttempt(intent, attemptNumber, "SUCCEEDED", now);
  const outcome = await commitCopyReceipt(ports.core_db, {
    copy_id: copyId, epoch_id: persistedDraft.epoch_id, destination_id: authority.destination_id,
    key_generation: keyGeneration, policy_digest: policyDigest, intent_digest: storedIntentDigest,
    receipt_json: JSON.stringify(receipt), epoch_json: JSON.stringify(epoch), attempt_json: JSON.stringify(attempt),
    readback_digest: readbackDigest, expires_at: persistedDraft.expires_at,
    failure_domain: descriptor.failure_domain, descriptor_digest: descriptorDigest,
    authority_authorized_at: authority.authorized_at, created_at: now,
  });
  if (!outcome.committed) {
    // Concurrent duplicate won: its persisted bytes are authority.
    const winner = outcome.stored;
    if (winner.epoch_id !== persistedDraft.epoch_id || winner.destination_id !== authority.destination_id || winner.key_generation !== keyGeneration || winner.policy_digest !== policyDigest || winner.intent_digest !== storedIntentDigest || winner.failure_domain !== descriptor.failure_domain || winner.descriptor_digest !== descriptorDigest || winner.authority_authorized_at !== authority.authorized_at) {
      failBackup("BACKUP_INTENT_CONFLICT", "offsite copy identity reuses divergent content", false, {});
    }
    try {
      const winnerReceipt = OperationReceiptSchema.parse(JSON.parse(winner.receipt_json) as unknown);
      const winnerEpoch = BackupEpochSchema.parse(JSON.parse(winner.epoch_json) as unknown);
      const winnerAttempt = OperationAttemptSchema.parse(JSON.parse(winner.attempt_json) as unknown);
      return { epoch: winnerEpoch, offsite_copy_ref: winnerEpoch.offsite_copy_ref, readback_digest: winner.readback_digest, attempt: winnerAttempt, receipt: winnerReceipt };
    } catch (cause) {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", "persisted offsite copy bytes are corrupt", false, {}, cause);
    }
  }
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
