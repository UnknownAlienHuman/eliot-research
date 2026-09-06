import { failBackup, ownedBackupBytes } from "./shared.js";
import { backupNonceHex } from "./offsite-durability.js";

// ER-34 O2 FIX3 durable per-key nonce allocation authority.
//
// AES-GCM nonces must be unique per encryption key. The key scope is the key
// generation: allocation claims (key_generation, nonce_hex) in D1 with an
// atomic PRIMARY KEY insert BEFORE encryption or remote put, so reuse across
// copies, parts, restarts, concurrent allocators, or forged pre-existing rows
// fails closed as BACKUP_NONCE_COLLISION with zero ciphertext produced.
// A key-generation change is a disjoint scope and never collides with retired
// material. Exact replay of the same (key, copy, part) allocation is
// idempotent and returns the same nonce bytes.
//
// This replaces copy_id-scoped map checks: the durable row is the authority,
// never an in-memory set. No nonce or key bytes enter messages or details.

export interface NonceAllocationClaim {
  readonly key_generation: string;
  readonly copy_id: string;
  readonly part_ref: string;
  readonly nonce: Uint8Array;
  readonly created_at: string;
}

interface NonceOwnerRow {
  readonly copy_id: unknown;
  readonly part_ref: unknown;
}

function assertAllocationLabel(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    failBackup("BACKUP_INPUT_INVALID", `backup nonce allocation carries an invalid ${label}`);
  }
}

export async function allocateOffsiteNonce(database: D1Database, claim: NonceAllocationClaim): Promise<Uint8Array<ArrayBuffer>> {
  const hex = backupNonceHex(claim.nonce);
  assertAllocationLabel(claim.key_generation, "key generation");
  assertAllocationLabel(claim.copy_id, "copy identity");
  assertAllocationLabel(claim.part_ref, "part reference");
  assertAllocationLabel(claim.created_at, "allocation timestamp");
  try {
    await database.prepare(
      "INSERT INTO backup_offsite_nonce_authority (key_generation, nonce_hex, copy_id, part_ref, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    ).bind(claim.key_generation, hex, claim.copy_id, claim.part_ref, claim.created_at).run();
    return ownedBackupBytes(claim.nonce);
  } catch {
    // Possible duplicate: resolve the durable owner below instead of sniffing
    // driver error text.
  }
  let owner: NonceOwnerRow | null;
  try {
    owner = await database.prepare(
      "SELECT copy_id, part_ref FROM backup_offsite_nonce_authority WHERE key_generation = ?1 AND nonce_hex = ?2",
    ).bind(claim.key_generation, hex).first<NonceOwnerRow>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup nonce authority is unavailable", true, { copy: claim.copy_id }, cause);
  }
  if (owner === null) {
    failBackup("BACKUP_TABLE_MISSING", "backup nonce authority lost an allocation", true, { copy: claim.copy_id });
  }
  if (owner.copy_id !== claim.copy_id || owner.part_ref !== claim.part_ref) {
    failBackup("BACKUP_NONCE_COLLISION", "backup nonce reuse detected under one key generation (durable record, across copies, parts and restarts); refusing encryption", false, { copy: claim.copy_id });
  }
  return ownedBackupBytes(claim.nonce);
}
