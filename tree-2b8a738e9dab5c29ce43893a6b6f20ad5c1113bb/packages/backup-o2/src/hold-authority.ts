import { failBackup } from "./shared.js";

// ER-34 O2 FIX3 fail-closed erasure-hold authority for the expiry path (not O4).
//
// The hold read is authority, never a hint: a missing table, an unreadable
// result, or an ambiguous (unclassifiable) row fails closed with typed
// authority-unavailable BEFORE any remote deletion and with zero side effects.
// Only an authoritative read that proves no blocking hold exists returns null
// (CLEAR). The caller must never treat a caught read error as CLEAR.
// No secret cause text is embedded in the message or detail; the driver error
// is chained as the cause only.

const BACKUP_RESTORE_PATH = "BackupRestorePath";

interface HoldRow {
  readonly hold_ref: unknown;
  readonly exact_subject_ref: unknown;
  readonly location: unknown;
  readonly canonical_ref: unknown;
}

function asSubjectRef(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  failBackup("BACKUP_TABLE_MISSING", `backup hold authority carries an unclassifiable ${what}; refusing expiry without determinate hold evidence`, true, {});
}

export async function readBlockingHoldAuthority(database: D1Database, epochId: string): Promise<string | null> {
  let result: D1Result<HoldRow>;
  try {
    result = await database.prepare(
      "SELECT hold_ref, exact_subject_ref, location, canonical_ref FROM erasure_hold WHERE state = 'ACTIVE'",
    ).all<HoldRow>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup hold authority is unavailable; refusing expiry without controller hold evidence", true, {}, cause);
  }
  const rows = result.results;
  if (!Array.isArray(rows)) {
    failBackup("BACKUP_TABLE_MISSING", "backup hold authority returned an unreadable result; refusing expiry without controller hold evidence", true, {});
  }
  for (const row of rows) {
    const subject = asSubjectRef(row.exact_subject_ref, "subject reference");
    const location = asSubjectRef(row.location, "location");
    const canonical = asSubjectRef(row.canonical_ref, "canonical reference");
    const blocks = subject === epochId || canonical === epochId || location === BACKUP_RESTORE_PATH;
    if (!blocks) continue;
    if (typeof row.hold_ref !== "string" || row.hold_ref.length === 0) {
      failBackup("BACKUP_TABLE_MISSING", "backup hold authority carries a blocking hold without a determinate reference; refusing expiry", true, {});
    }
    return row.hold_ref;
  }
  return null;
}
