import { failBackup, ownedBackupBytes } from "./shared.js";
import { backupNonceHex } from "./offsite-durability.js";

// ER-34 O2 FIX4 durable globally-unique nonce allocation authority.
//
// AES-GCM nonces must be unique per encryption key, and key rotation must
// never resurrect retired nonce bytes: allocation claims nonce_hex alone in
// D1 with an atomic PRIMARY KEY insert BEFORE encryption or remote put, so
// ANY reuse of identical nonce bytes — across copies, parts, restarts,
// concurrent allocators, forged pre-existing rows, or key generations — fails
// closed as BACKUP_NONCE_COLLISION with zero ciphertext produced. A separate
// UNIQUE owner tuple (key_generation, copy_id, part_ref) guarantees one
// durable owner mapping per allocation scope: restart/replay cannot silently
// allocate a different nonce to the same owner tuple, and exact replay of the
// same owner with the same nonce is idempotent and returns the same bytes.
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
  readonly key_generation: unknown;
  readonly copy_id: unknown;
  readonly part_ref: unknown;
}

interface NonceBindingRow {
  readonly nonce_hex: unknown;
}

function assertAllocationLabel(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    failBackup("BACKUP_INPUT_INVALID", `backup nonce allocation carries an invalid ${label}`);
  }
}

function sameOwner(row: NonceOwnerRow, claim: { readonly key_generation: string; readonly copy_id: string; readonly part_ref: string }): boolean {
  return row.key_generation === claim.key_generation && row.copy_id === claim.copy_id && row.part_ref === claim.part_ref;
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
    // driver error text. Either the global nonce or the owner tuple (or the
    // table itself) explains the conflict.
  }
  // Global nonce lookup: identical bytes anywhere — any generation, copy or
  // part — belong to exactly one durable owner.
  let byNonce: NonceOwnerRow | null;
  try {
    byNonce = await database.prepare(
      "SELECT key_generation, copy_id, part_ref FROM backup_offsite_nonce_authority WHERE nonce_hex = ?1",
    ).bind(hex).first<NonceOwnerRow>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup nonce authority is unavailable", true, { copy: claim.copy_id }, cause);
  }
  if (byNonce !== null) {
    if (!sameOwner(byNonce, claim)) {
      failBackup("BACKUP_NONCE_COLLISION", "backup nonce reuse detected across copies, parts, restarts or key generations (durable global record); refusing encryption", false, { copy: claim.copy_id });
    }
    return ownedBackupBytes(claim.nonce);
  }
  // The nonce is unclaimed, so the failed insert hit the owner-tuple
  // uniqueness: this owner is already bound to a different nonce. Silent
  // re-allocation is refused; exact replay must present the bound bytes.
  let byOwner: NonceBindingRow | null;
  try {
    byOwner = await database.prepare(
      "SELECT nonce_hex FROM backup_offsite_nonce_authority WHERE key_generation = ?1 AND copy_id = ?2 AND part_ref = ?3",
    ).bind(claim.key_generation, claim.copy_id, claim.part_ref).first<NonceBindingRow>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup nonce authority is unavailable", true, { copy: claim.copy_id }, cause);
  }
  if (byOwner !== null) {
    if (byOwner.nonce_hex !== hex) {
      failBackup("BACKUP_NONCE_COLLISION", "backup nonce owner is already bound to a different nonce; refusing silent re-allocation across restart or replay", false, { copy: claim.copy_id });
    }
    return ownedBackupBytes(claim.nonce);
  }
  failBackup("BACKUP_TABLE_MISSING", "backup nonce authority lost an allocation", true, { copy: claim.copy_id });
}

// ER-34 O2 FIX5 VERIFIED-resume re-proof. Read-only: it never inserts, so
// forged or restored checkpoint bytes can never be laundered into the durable
// authority by the act of checking. The checkpoint nonce must already be bound
// in backup_offsite_nonce_authority to this exact owner tuple, in both
// directions (nonce -> owner and owner -> nonce); a missing row, a divergent
// owner, a rotated generation, or malformed bytes fail closed as
// BACKUP_NONCE_COLLISION with zero writes. Every VERIFIED resume path calls
// this BEFORE remote get/skip, whether or not a controller allocator
// (generate_nonce) is set.

export interface NonceBindingClaim {
  readonly key_generation: string;
  readonly copy_id: string;
  readonly part_ref: string;
  readonly nonce_hex: string;
}

export async function assertOffsiteNonceBinding(database: D1Database, claim: NonceBindingClaim): Promise<void> {
  assertAllocationLabel(claim.key_generation, "key generation");
  assertAllocationLabel(claim.copy_id, "copy identity");
  assertAllocationLabel(claim.part_ref, "part reference");
  if (!/^[0-9a-f]{24}$/.test(claim.nonce_hex)) {
    failBackup("BACKUP_NONCE_COLLISION", "backup copy checkpoint carries unproven nonce bytes; refusing resume without durable authority", false, { copy: claim.copy_id });
  }
  let byNonce: NonceOwnerRow | null;
  try {
    byNonce = await database.prepare(
      "SELECT key_generation, copy_id, part_ref FROM backup_offsite_nonce_authority WHERE nonce_hex = ?1",
    ).bind(claim.nonce_hex).first<NonceOwnerRow>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup nonce authority is unavailable", true, { copy: claim.copy_id }, cause);
  }
  if (byNonce === null || !sameOwner(byNonce, claim)) {
    failBackup("BACKUP_NONCE_COLLISION", "backup copy checkpoint nonce is not bound to this owner in the durable nonce authority; refusing resume", false, { copy: claim.copy_id });
  }
  let byOwner: NonceBindingRow | null;
  try {
    byOwner = await database.prepare(
      "SELECT nonce_hex FROM backup_offsite_nonce_authority WHERE key_generation = ?1 AND copy_id = ?2 AND part_ref = ?3",
    ).bind(claim.key_generation, claim.copy_id, claim.part_ref).first<NonceBindingRow>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup nonce authority is unavailable", true, { copy: claim.copy_id }, cause);
  }
  if (byOwner === null || byOwner.nonce_hex !== claim.nonce_hex) {
    failBackup("BACKUP_NONCE_COLLISION", "backup nonce owner is not bound to this checkpoint nonce in the durable authority; refusing resume", false, { copy: claim.copy_id });
  }
}
