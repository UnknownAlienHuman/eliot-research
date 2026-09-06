import { backupSha256Hex, failBackup } from "./shared.js";

// ER-34 O2 FIX4 complete canonical migration authority. Runtime CREATE TABLE is
// not a migration substitute: every O2 entry point asserts that migration 0018 is
// present in the authoritative D1 migration ledger AND that every O2 table and
// index matches its expected canonical shape exactly. FIX4 tightens the FIX3
// shape: nonce_hex alone is the nonce-authority PRIMARY KEY (globally unique
// across copies and key generations) with a UNIQUE owner tuple
// (key_generation, copy_id, part_ref), and the expiry receipt mirrors the
// controller authority generation (authority_authorized_at); the previous
// weaker (key_generation, nonce_hex) key and shapes without the owner
// uniqueness are rejected here.
//
// Compared depth (FIX2 checked only column order/name/affinity/not-null):
// column order, name, affinity, not-null, DEFAULT (0018 defines none), PRIMARY
// KEY membership and position, per-index name/uniqueness/origin/column order,
// CHECK expressions, absence of FOREIGN KEYs (0018 defines none), STRICT table
// options, and the canonical schema fingerprint below. The ledger row plus the
// live schema shape plus the expected migration content digest together are the
// expected-digest check: the content digest binds this gate to the exact
// tracked migration file (tests prove the constant equals the file), the ledger
// row proves it was applied through the authoritative path, and the schema
// fingerprint proves the applied content matches, all read back from the live
// database via PRAGMA and sqlite_schema.
//
// canonicalizeSchemaSql is formatting only: it collapses whitespace runs and
// trims. It never drops, reorders or rewrites tokens, so every constraint,
// name and expression remains in the digested text.

export const O2_MIGRATION_FILENAME = "0018_backup_o2_replay_authority.sql";

// sha256 (hex) of the tracked migration file above with CRLF normalized to LF.
// Bound to the ledger check by fix3 tests: any file edit without a matching
// gate update fails the suite.
export const O2_EXPECTED_MIGRATION_DIGEST = "af311a7297c291f76db50394e85aae5ce433472ff79e342d2f98fd1847055dee";

// sha256 (hex) of the canonical schema text (sorted table/index entries, see
// canonicalO2SchemaFingerprint) read back from a database with 0018 applied.
// Any dropped/altered constraint, index, default, key or STRICT option changes
// the live fingerprint and fails closed here.
export const O2_EXPECTED_SCHEMA_DIGEST = "63aeb24c0fa6d18e4f0fd3c521a8122f5a75954bf63e56b4e267ba0c1dbbeb75";

type Affinity = "TEXT" | "INTEGER";

interface ExpectedColumn {
  readonly name: string;
  readonly affinity: Affinity;
  readonly notnull: boolean;
  readonly pk: number;
}

interface ExpectedIndex {
  readonly name: string;
  readonly unique: boolean;
  readonly origin: "pk" | "c" | "u";
  readonly columns: readonly string[];
}

interface ExpectedTable {
  readonly columns: readonly ExpectedColumn[];
  readonly checks: readonly string[];
  readonly indexes: readonly ExpectedIndex[];
}

const T = "TEXT" as const;
const I = "INTEGER" as const;
const NN = true;
const NL = false;

function col(name: string, affinity: Affinity, notnull: boolean, pkPosition: number): ExpectedColumn {
  return { name, affinity, notnull, pk: pkPosition };
}

export const O2_EXPECTED_TABLES: Readonly<Record<string, ExpectedTable>> = {
  d1_migrations: {
    columns: [col("name", T, NN, 1), col("applied_at", T, NN, 0)],
    checks: [],
    indexes: [{ name: "sqlite_autoindex_d1_migrations_1", unique: true, origin: "pk", columns: ["name"] }],
  },
  backup_epoch_receipt: {
    columns: [
      col("idempotency_key", T, NN, 1), col("intent_id", T, NN, 0), col("intent_digest", T, NN, 0),
      col("vector_digest", T, NN, 0), col("manifest_digest", T, NN, 0), col("epoch_id", T, NN, 0),
      col("receipt_json", T, NN, 0), col("draft_json", T, NN, 0), col("attempt_json", T, NN, 0),
      col("created_at", T, NN, 0),
    ],
    checks: ["length(intent_digest) = 64", "length(vector_digest) = 64", "length(manifest_digest) = 64", "json_valid(receipt_json)", "json_valid(draft_json)", "json_valid(attempt_json)"],
    indexes: [{ name: "sqlite_autoindex_backup_epoch_receipt_1", unique: true, origin: "pk", columns: ["idempotency_key"] }],
  },
  backup_offsite_expiry: {
    columns: [
      col("expiry_intent_key", T, NN, 1), col("epoch_id", T, NN, 0), col("destination_id", T, NN, 0),
      col("journal_refs_json", T, NN, 0), col("state", T, NN, 0), col("absent_parts", I, NN, 0),
      col("failure_domain", T, NN, 0), col("descriptor_digest", T, NN, 0), col("policy_digest", T, NN, 0),
      col("authority_authorized_at", T, NN, 0), col("created_at", T, NN, 0),
    ],
    checks: ["json_valid(journal_refs_json)", "state IN ('DELETED','BLOCKED')", "absent_parts >= 0", "length(descriptor_digest) = 64", "length(policy_digest) = 64"],
    indexes: [{ name: "sqlite_autoindex_backup_offsite_expiry_1", unique: true, origin: "pk", columns: ["expiry_intent_key"] }],
  },
  backup_destination_authority: {
    columns: [
      col("destination_id", T, NN, 1), col("principal_ref", T, NN, 2), col("policy_decision_ref", T, NN, 3),
      col("policy_json", T, NN, 0), col("policy_digest", T, NN, 0), col("authorization_receipt_ref", T, NN, 0),
      col("state", T, NN, 0), col("authorized_at", T, NN, 0), col("revoked_at", T, NL, 0),
    ],
    checks: ["json_valid(policy_json)", "length(policy_digest) = 64", "state IN ('AUTHORIZED','REVOKED')"],
    indexes: [{ name: "sqlite_autoindex_backup_destination_authority_1", unique: true, origin: "pk", columns: ["destination_id", "principal_ref", "policy_decision_ref"] }],
  },
  backup_offsite_copy_part: {
    columns: [
      col("copy_id", T, NN, 1), col("part_ref", T, NN, 2), col("content_digest", T, NN, 0),
      col("size_bytes", I, NN, 0), col("nonce_hex", T, NN, 0), col("state", T, NN, 0),
      col("updated_at", T, NN, 0),
    ],
    checks: ["length(content_digest) = 64", "size_bytes >= 0", "state IN ('STORED','VERIFIED')"],
    indexes: [
      { name: "sqlite_autoindex_backup_offsite_copy_part_1", unique: true, origin: "pk", columns: ["copy_id", "part_ref"] },
      { name: "backup_offsite_copy_part_nonce_unique", unique: true, origin: "c", columns: ["copy_id", "nonce_hex"] },
    ],
  },
  backup_offsite_copy_receipt: {
    columns: [
      col("copy_id", T, NN, 1), col("epoch_id", T, NN, 0), col("destination_id", T, NN, 0),
      col("key_generation", T, NN, 0), col("policy_digest", T, NN, 0), col("intent_digest", T, NN, 0),
      col("receipt_json", T, NN, 0), col("epoch_json", T, NN, 0), col("attempt_json", T, NN, 0),
      col("readback_digest", T, NN, 0), col("expires_at", T, NN, 0), col("failure_domain", T, NN, 0),
      col("descriptor_digest", T, NN, 0), col("authority_authorized_at", T, NN, 0), col("created_at", T, NN, 0),
    ],
    checks: ["length(policy_digest) = 64", "length(intent_digest) = 64", "json_valid(receipt_json)", "json_valid(epoch_json)", "json_valid(attempt_json)", "length(readback_digest) = 64", "length(descriptor_digest) = 64"],
    indexes: [{ name: "sqlite_autoindex_backup_offsite_copy_receipt_1", unique: true, origin: "pk", columns: ["copy_id"] }],
  },
  backup_export_cut: {
    columns: [col("cut_id", T, NN, 1), col("cut_digest", T, NN, 0), col("state", T, NN, 0), col("created_at", T, NN, 0)],
    checks: ["length(cut_digest) = 64", "state IN ('OPEN','ACCEPTED','REJECTED')"],
    indexes: [{ name: "sqlite_autoindex_backup_export_cut_1", unique: true, origin: "pk", columns: ["cut_id"] }],
  },
  backup_offsite_nonce_authority: {
    columns: [
      col("key_generation", T, NN, 0), col("nonce_hex", T, NN, 1), col("copy_id", T, NN, 0),
      col("part_ref", T, NN, 0), col("created_at", T, NN, 0),
    ],
    checks: ["length(nonce_hex) = 24"],
    indexes: [
      { name: "sqlite_autoindex_backup_offsite_nonce_authority_1", unique: true, origin: "pk", columns: ["nonce_hex"] },
      { name: "backup_offsite_nonce_owner_unique", unique: true, origin: "c", columns: ["key_generation", "copy_id", "part_ref"] },
    ],
  },
};

interface PragmaColumn {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: unknown;
  readonly pk: number;
}

interface PragmaIndex {
  readonly name: string;
  readonly unique: number;
  readonly origin: string;
}

interface IndexColumn {
  readonly seqno: number;
  readonly name: string;
}

export function canonicalizeSchemaSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function tableShapeError(table: string, detail: string): never {
  failBackup("BACKUP_TABLE_MISSING", `backup authority table ${table} diverges from migration ${O2_MIGRATION_FILENAME} (${detail})`, false, { table, migration: O2_MIGRATION_FILENAME });
}

export async function canonicalO2SchemaFingerprint(entries: ReadonlyArray<{ readonly kind: "table" | "index"; readonly name: string; readonly sql: string }>): Promise<string> {
  const ordered = [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
  const text = ordered.map((entry) => `${entry.kind} ${entry.name} ${canonicalizeSchemaSql(entry.sql)}`).join("\n");
  return backupSha256Hex(text);
}

async function readTableSql(database: D1Database, table: string): Promise<string> {
  let row: { readonly sql: unknown } | null;
  try {
    row = await database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1").bind(table).first<{ readonly sql: unknown }>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", `backup authority table ${table} is unreadable`, true, { table }, cause);
  }
  if (row === null || typeof row.sql !== "string" || row.sql.length === 0) {
    tableShapeError(table, "missing table definition");
  }
  return row.sql;
}

async function readNamedIndexSql(database: D1Database, tables: readonly string[]): Promise<readonly { readonly name: string; readonly sql: string }[]> {
  // Scoped to O2 tables only: earlier migrations own their own indexes and the
  // gate must not couple to them.
  const scope = tables.map((table) => `'${table}'`).join(",");
  let rows: readonly { readonly name: unknown; readonly sql: unknown }[];
  try {
    const result = await database.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND tbl_name IN (${scope})`).all<{ readonly name: unknown; readonly sql: unknown }>();
    rows = [...(result.results ?? [])];
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup authority index inventory is unreadable", true, {}, cause);
  }
  const out: { readonly name: string; readonly sql: string }[] = [];
  for (const row of rows) {
    if (typeof row.name !== "string" || typeof row.sql !== "string") {
      failBackup("BACKUP_TABLE_MISSING", "backup authority index inventory carries a malformed entry", false, {});
    }
    if (row.name.startsWith("sqlite_autoindex_")) continue;
    out.push({ name: row.name, sql: row.sql });
  }
  return out;
}

async function assertTableShape(database: D1Database, table: string, expected: ExpectedTable): Promise<string> {
  let info: PragmaColumn[];
  try {
    const result = await database.prepare(`PRAGMA table_info(${table})`).all<PragmaColumn>();
    info = [...(result.results ?? [])];
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", `backup authority table ${table} is unreadable`, true, { table }, cause);
  }
  if (info.length !== expected.columns.length) {
    tableShapeError(table, `expected ${expected.columns.length} columns, found ${info.length}`);
  }
  for (let index = 0; index < expected.columns.length; index += 1) {
    const want = expected.columns[index] as ExpectedColumn;
    const got = info[index] as PragmaColumn;
    const affinity = got.type.toUpperCase().includes("INT") ? "INTEGER" : "TEXT";
    if (got.name !== want.name || affinity !== want.affinity || (got.notnull === 1) !== want.notnull) {
      tableShapeError(table, `column ${index} diverges (expected ${want.name}:${want.affinity}, found ${got.name}:${got.type})`);
    }
    if (got.dflt_value !== null && got.dflt_value !== undefined) {
      tableShapeError(table, `column ${want.name} carries an unexpected default`);
    }
    if (got.pk !== want.pk) {
      tableShapeError(table, `column ${want.name} key position diverges (expected ${want.pk}, found ${got.pk})`);
    }
  }
  const sql = await readTableSql(database, table);
  const canonical = canonicalizeSchemaSql(sql);
  if (!canonical.endsWith(") STRICT")) {
    tableShapeError(table, "missing STRICT table option");
  }
  for (const check of expected.checks) {
    if (!canonical.includes(check)) {
      tableShapeError(table, `missing constraint expression ${check}`);
    }
  }
  let foreignKeys: readonly unknown[];
  try {
    const result = await database.prepare(`PRAGMA foreign_key_list(${table})`).all<unknown>();
    foreignKeys = [...(result.results ?? [])];
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", `backup authority table ${table} constraint inventory is unreadable`, true, { table }, cause);
  }
  if (foreignKeys.length !== 0) {
    tableShapeError(table, "unexpected FOREIGN KEY constraint");
  }
  let indexes: PragmaIndex[];
  try {
    const result = await database.prepare(`PRAGMA index_list(${table})`).all<PragmaIndex>();
    indexes = [...(result.results ?? [])];
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", `backup authority table ${table} index inventory is unreadable`, true, { table }, cause);
  }
  if (indexes.length !== expected.indexes.length) {
    tableShapeError(table, `expected ${expected.indexes.length} indexes, found ${indexes.length}`);
  }
  for (const want of expected.indexes) {
    const got = indexes.find((entry) => entry.name === want.name);
    if (got === undefined) tableShapeError(table, `missing index ${want.name}`);
    if ((got.unique === 1) !== want.unique || got.origin !== want.origin) {
      tableShapeError(table, `index ${want.name} diverges (expected unique=${want.unique} origin=${want.origin})`);
    }
    let columns: IndexColumn[];
    try {
      const result = await database.prepare(`PRAGMA index_info(${want.name})`).all<IndexColumn>();
      columns = [...(result.results ?? [])].sort((left, right) => left.seqno - right.seqno);
    } catch (cause) {
      failBackup("BACKUP_TABLE_MISSING", `backup authority index ${want.name} is unreadable`, true, { table }, cause);
    }
    const names = columns.map((entry) => entry.name);
    if (names.length !== want.columns.length || !names.every((name, position) => name === want.columns[position])) {
      tableShapeError(table, `index ${want.name} column order diverges (expected ${want.columns.join(",")}, found ${names.join(",")})`);
    }
  }
  return sql;
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
  const tableNames = Object.keys(O2_EXPECTED_TABLES);
  const fingerprintEntries: { readonly kind: "table" | "index"; readonly name: string; readonly sql: string }[] = [];
  for (const [table, expected] of Object.entries(O2_EXPECTED_TABLES)) {
    const sql = await assertTableShape(database, table, expected);
    fingerprintEntries.push({ kind: "table", name: table, sql });
  }
  const namedIndexes = await readNamedIndexSql(database, tableNames);
  const o2IndexNames = new Set(Object.values(O2_EXPECTED_TABLES).flatMap((table) => table.indexes.map((index) => index.name)).filter((name) => !name.startsWith("sqlite_autoindex_")));
  if (namedIndexes.length !== o2IndexNames.size || !namedIndexes.every((entry) => o2IndexNames.has(entry.name))) {
    failBackup("BACKUP_TABLE_MISSING", `backup authority index set diverges from migration ${O2_MIGRATION_FILENAME}`, false, { migration: O2_MIGRATION_FILENAME });
  }
  for (const entry of namedIndexes) fingerprintEntries.push({ kind: "index", name: entry.name, sql: entry.sql });
  const fingerprint = await canonicalO2SchemaFingerprint(fingerprintEntries);
  if (fingerprint !== O2_EXPECTED_SCHEMA_DIGEST) {
    failBackup("BACKUP_TABLE_MISSING", `backup authority schema fingerprint diverges from migration ${O2_MIGRATION_FILENAME}; refusing forged or edited schema`, false, { migration: O2_MIGRATION_FILENAME });
  }
}
