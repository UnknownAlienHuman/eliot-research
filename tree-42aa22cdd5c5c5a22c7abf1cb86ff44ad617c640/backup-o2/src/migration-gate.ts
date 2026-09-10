import { failBackup } from "./shared.js";

// ER-34 O2 FIX2 fail-closed migration gate. Runtime CREATE TABLE is not a
// migration substitute: every O2 entry point asserts that migration 0018 is
// present in the authoritative D1 migration ledger AND that every O2 table
// matches its expected shape exactly (the ledger row plus the live schema shape
// together are the expected-digest check). Tests apply the actual migration and
// record its ledger row; swallowing migration errors or reporting
// migration-ledger:ABSENT fails closed here instead.

export const O2_MIGRATION_FILENAME = "0018_backup_o2_replay_authority.sql";

interface ExpectedColumn {
  readonly name: string;
  readonly affinity: "TEXT" | "INTEGER";
  readonly notnull: boolean;
}

interface ExpectedTable {
  readonly columns: readonly ExpectedColumn[];
}

const T = "TEXT" as const;
const I = "INTEGER" as const;
const NN = true;
const NL = false;

export const O2_EXPECTED_TABLES: Readonly<Record<string, ExpectedTable>> = {
  d1_migrations: { columns: [
    { name: "name", affinity: T, notnull: NN },
    { name: "applied_at", affinity: T, notnull: NN },
  ] },
  backup_epoch_receipt: { columns: [
    { name: "idempotency_key", affinity: T, notnull: NN },
    { name: "intent_id", affinity: T, notnull: NN },
    { name: "intent_digest", affinity: T, notnull: NN },
    { name: "vector_digest", affinity: T, notnull: NN },
    { name: "manifest_digest", affinity: T, notnull: NN },
    { name: "epoch_id", affinity: T, notnull: NN },
    { name: "receipt_json", affinity: T, notnull: NN },
    { name: "draft_json", affinity: T, notnull: NN },
    { name: "attempt_json", affinity: T, notnull: NN },
    { name: "created_at", affinity: T, notnull: NN },
  ] },
  backup_offsite_expiry: { columns: [
    { name: "expiry_intent_key", affinity: T, notnull: NN },
    { name: "epoch_id", affinity: T, notnull: NN },
    { name: "destination_id", affinity: T, notnull: NN },
    { name: "journal_refs_json", affinity: T, notnull: NN },
    { name: "state", affinity: T, notnull: NN },
    { name: "absent_parts", affinity: I, notnull: NN },
    { name: "created_at", affinity: T, notnull: NN },
  ] },
  backup_destination_authority: { columns: [
    { name: "destination_id", affinity: T, notnull: NN },
    { name: "principal_ref", affinity: T, notnull: NN },
    { name: "policy_decision_ref", affinity: T, notnull: NN },
    { name: "policy_json", affinity: T, notnull: NN },
    { name: "policy_digest", affinity: T, notnull: NN },
    { name: "authorization_receipt_ref", affinity: T, notnull: NN },
    { name: "state", affinity: T, notnull: NN },
    { name: "authorized_at", affinity: T, notnull: NN },
    { name: "revoked_at", affinity: T, notnull: NL },
  ] },
  backup_offsite_copy_part: { columns: [
    { name: "copy_id", affinity: T, notnull: NN },
    { name: "part_ref", affinity: T, notnull: NN },
    { name: "content_digest", affinity: T, notnull: NN },
    { name: "size_bytes", affinity: I, notnull: NN },
    { name: "nonce_hex", affinity: T, notnull: NN },
    { name: "state", affinity: T, notnull: NN },
    { name: "updated_at", affinity: T, notnull: NN },
  ] },
  backup_offsite_copy_receipt: { columns: [
    { name: "copy_id", affinity: T, notnull: NN },
    { name: "epoch_id", affinity: T, notnull: NN },
    { name: "destination_id", affinity: T, notnull: NN },
    { name: "key_generation", affinity: T, notnull: NN },
    { name: "policy_digest", affinity: T, notnull: NN },
    { name: "intent_digest", affinity: T, notnull: NN },
    { name: "receipt_json", affinity: T, notnull: NN },
    { name: "epoch_json", affinity: T, notnull: NN },
    { name: "attempt_json", affinity: T, notnull: NN },
    { name: "readback_digest", affinity: T, notnull: NN },
    { name: "expires_at", affinity: T, notnull: NN },
    { name: "created_at", affinity: T, notnull: NN },
  ] },
  backup_export_cut: { columns: [
    { name: "cut_id", affinity: T, notnull: NN },
    { name: "cut_digest", affinity: T, notnull: NN },
    { name: "state", affinity: T, notnull: NN },
    { name: "created_at", affinity: T, notnull: NN },
  ] },
};

interface PragmaColumn {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
}

export async function assertO2MigrationAuthority(database: D1Database): Promise<void> {
  let ledger: { readonly name: unknown }[] | null = null;
  try {
    const result = await database.prepare("SELECT name FROM d1_migrations").all<{ readonly name: unknown }>();
    ledger = result.results ?? [];
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", `backup migration ledger is unavailable; apply ${O2_MIGRATION_FILENAME} via the authoritative migration path`, true, { migration: O2_MIGRATION_FILENAME }, cause);
  }
  const names = new Set((ledger ?? []).map((row) => row.name));
  if (!names.has(O2_MIGRATION_FILENAME)) {
    failBackup("BACKUP_TABLE_MISSING", `backup migration ${O2_MIGRATION_FILENAME} is absent from the authoritative migration ledger; refusing runtime DDL substitute`, false, { migration: O2_MIGRATION_FILENAME });
  }
  for (const [table, expected] of Object.entries(O2_EXPECTED_TABLES)) {
    let info: PragmaColumn[];
    try {
      const result = await database.prepare(`PRAGMA table_info(${table})`).all<PragmaColumn>();
      info = [...(result.results ?? [])];
    } catch (cause) {
      failBackup("BACKUP_TABLE_MISSING", `backup authority table ${table} is unreadable`, true, { table }, cause);
    }
    if (info.length !== expected.columns.length) {
      failBackup("BACKUP_TABLE_MISSING", `backup authority table ${table} has an unexpected shape (expected ${expected.columns.length} columns, found ${info.length}); migration ${O2_MIGRATION_FILENAME} digest mismatch`, false, { table, migration: O2_MIGRATION_FILENAME });
    }
    for (let index = 0; index < expected.columns.length; index += 1) {
      const want = expected.columns[index] as ExpectedColumn;
      const got = info[index] as PragmaColumn;
      const affinity = got.type.toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
      if (got.name !== want.name || affinity !== want.affinity || (got.notnull === 1) !== want.notnull) {
        failBackup("BACKUP_TABLE_MISSING", `backup authority table ${table} column ${index} diverges from migration ${O2_MIGRATION_FILENAME} (expected ${want.name}:${want.affinity}, found ${got.name}:${got.type})`, false, { table, migration: O2_MIGRATION_FILENAME });
      }
    }
  }
}
