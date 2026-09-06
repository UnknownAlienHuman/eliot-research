import { backupIsoDateTime, backupSha256Hex, canonicalBackupJson, failBackup } from "./shared.js";

// ER-34 O2 FIX2 durable offsite-copy state. Copy-part checkpoints and the
// success authority live in D1 (controller-owned); restart or cancellation
// resumes from that state instead of redoing blind writes. Nonces are
// deterministic per (key generation, copy identity, part ref, content digest,
// policy digest) by default, or controller-allocated via generate_nonce; per-key
// uniqueness is enforced by the durable nonce authority BEFORE encryption
// (see nonce-authority.ts), across restarts, concurrent copies and key
// generations, never via an in-memory set. The checkpoint UNIQUE on
// (copy_id, nonce_hex) remains as post-verify defense in depth only.
//
// The controller clock disciplines caller timestamps: a caller-supplied now_ms
// more than CONTROLLER_CLOCK_SKEW_MS from the runtime clock fails closed, so
// expiry admissibility can no longer be forged with a caller timestamp.

export const CONTROLLER_CLOCK_SKEW_MS = 15 * 60 * 1000;

export function resolveControllerClock(nowMs: number | undefined): number {
  const now = nowMs ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) failBackup("BACKUP_INPUT_INVALID", "backup controller clock is out of range");
  if (Math.abs(Date.now() - now) > CONTROLLER_CLOCK_SKEW_MS) {
    failBackup("BACKUP_INPUT_INVALID", "backup caller timestamp diverges from the controller clock beyond skew; refusing forged time", false, {});
  }
  return now;
}

export async function copyIdForDigest(input: { readonly epoch_id: string; readonly destination_id: string; readonly key_generation: string; readonly policy_digest: string; readonly intent_digest: string }): Promise<string> {
  const digest = await backupSha256Hex(canonicalBackupJson({
    protocol: "eliotr.backup-offsite-copy.v1",
    epoch_id: input.epoch_id,
    destination_id: input.destination_id,
    key_generation: input.key_generation,
    policy_digest: input.policy_digest,
    intent_digest: input.intent_digest,
  }));
  return `offcopy-${digest.slice(0, 48)}`;
}

export async function deriveBackupNonce(input: { readonly key_generation: string; readonly copy_id: string; readonly part_ref: string; readonly content_digest: string; readonly policy_digest: string }): Promise<Uint8Array<ArrayBuffer>> {
  const digest = await backupSha256Hex(canonicalBackupJson({
    protocol: "eliotr.backup-offsite-nonce.v1",
    key_generation: input.key_generation,
    copy_id: input.copy_id,
    part_ref: input.part_ref,
    content_digest: input.content_digest,
    policy_digest: input.policy_digest,
  }));
  const nonce = new Uint8Array(12);
  for (let i = 0; i < 12; i += 1) nonce[i] = Number.parseInt(digest.slice(i * 2, i * 2 + 2), 16);
  return nonce;
}

export function backupNonceHex(nonce: Uint8Array): string {
  if (nonce.byteLength !== 12) failBackup("BACKUP_KEY_INVALID", "offsite nonce must be 96 bits");
  return [...nonce].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface CopyCheckpoint {
  readonly part_ref: string;
  readonly content_digest: string;
  readonly size_bytes: number;
  readonly nonce_hex: string;
  readonly state: "STORED" | "VERIFIED";
}

export async function readCopyCheckpoints(database: D1Database, copyId: string): Promise<ReadonlyMap<string, CopyCheckpoint>> {
  let rows: readonly { readonly part_ref: unknown; readonly content_digest: unknown; readonly size_bytes: unknown; readonly nonce_hex: unknown; readonly state: unknown }[];
  try {
    const result = await database.prepare(
      "SELECT part_ref, content_digest, size_bytes, nonce_hex, state FROM backup_offsite_copy_part WHERE copy_id = ?1",
    ).bind(copyId).all<{ readonly part_ref: unknown; readonly content_digest: unknown; readonly size_bytes: unknown; readonly nonce_hex: unknown; readonly state: unknown }>();
    rows = [...(result.results ?? [])];
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup copy checkpoints are unavailable", true, { copy: copyId }, cause);
  }
  const map = new Map<string, CopyCheckpoint>();
  for (const row of rows) {
    if (typeof row.part_ref !== "string" || typeof row.content_digest !== "string" || typeof row.size_bytes !== "number" || typeof row.nonce_hex !== "string" || (row.state !== "STORED" && row.state !== "VERIFIED")) {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup copy checkpoint is corrupt", false, { copy: copyId });
    }
    map.set(row.part_ref, { part_ref: row.part_ref, content_digest: row.content_digest, size_bytes: row.size_bytes, nonce_hex: row.nonce_hex, state: row.state });
  }
  return map;
}

export async function recordCopyCheckpoint(database: D1Database, copyId: string, checkpoint: CopyCheckpoint, now: string): Promise<void> {
  try {
    await database.prepare(
      "INSERT INTO backup_offsite_copy_part (copy_id, part_ref, content_digest, size_bytes, nonce_hex, state, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (copy_id, part_ref) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
    ).bind(copyId, checkpoint.part_ref, checkpoint.content_digest, checkpoint.size_bytes, checkpoint.nonce_hex, checkpoint.state, now).run();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "";
    if (message.includes("backup_offsite_copy_part_nonce_unique")) {
      failBackup("BACKUP_NONCE_COLLISION", "backup nonce reuse detected across parts (durable unique record)", false, { copy: copyId });
    }
    failBackup("BACKUP_TABLE_MISSING", "backup copy checkpoint commit is unavailable", true, { copy: copyId }, cause);
  }
}

export interface StoredCopyReceipt {
  readonly copy_id: string;
  readonly epoch_id: string;
  readonly destination_id: string;
  readonly key_generation: string;
  readonly policy_digest: string;
  readonly intent_digest: string;
  readonly receipt_json: string;
  readonly epoch_json: string;
  readonly attempt_json: string;
  readonly readback_digest: string;
  readonly expires_at: string;
  readonly failure_domain: string;
  readonly descriptor_digest: string;
  readonly authority_authorized_at: string;
  readonly created_at: string;
}

export async function readCopyReceipt(database: D1Database, copyId: string): Promise<StoredCopyReceipt | null> {
  let row: StoredCopyReceipt | null;
  try {
    row = await database.prepare(
      "SELECT copy_id, epoch_id, destination_id, key_generation, policy_digest, intent_digest, receipt_json, epoch_json, attempt_json, readback_digest, expires_at, failure_domain, descriptor_digest, authority_authorized_at, created_at FROM backup_offsite_copy_receipt WHERE copy_id = ?1",
    ).bind(copyId).first<StoredCopyReceipt>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup copy success authority is unavailable", true, { copy: copyId }, cause);
  }
  return row;
}

export async function commitCopyReceipt(database: D1Database, receipt: StoredCopyReceipt): Promise<{ readonly committed: boolean; readonly stored: StoredCopyReceipt }> {
  try {
    await database.prepare(
      "INSERT INTO backup_offsite_copy_receipt (copy_id, epoch_id, destination_id, key_generation, policy_digest, intent_digest, receipt_json, epoch_json, attempt_json, readback_digest, expires_at, failure_domain, descriptor_digest, authority_authorized_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
    ).bind(receipt.copy_id, receipt.epoch_id, receipt.destination_id, receipt.key_generation, receipt.policy_digest, receipt.intent_digest, receipt.receipt_json, receipt.epoch_json, receipt.attempt_json, receipt.readback_digest, receipt.expires_at, receipt.failure_domain, receipt.descriptor_digest, receipt.authority_authorized_at, receipt.created_at).run();
    return { committed: true, stored: receipt };
  } catch {
    // Concurrent duplicate: the winner's receipt is authority.
  }
  const stored = await readCopyReceipt(database, receipt.copy_id);
  if (stored === null) failBackup("BACKUP_TABLE_MISSING", "backup copy success authority lost a concurrent commit", true, { copy: receipt.copy_id });
  return { committed: false, stored };
}

export function backupIsoNow(clockMs: number): string {
  return backupIsoDateTime(clockMs);
}
