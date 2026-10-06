import {
  assertBackupProducerFenceMigrationAuthority,
  backupSha256Hex,
  canonicalizeSchemaSql,
  failBackup,
} from "@eliotr/backup-o2";

export const BACKUP_EPOCH_MANIFEST_MIGRATION = "0119_backup_epoch_manifest_bindings.sql";
// SHA-256 of the tracked 0119 migration with CRLF normalized to LF.
export const BACKUP_EPOCH_MANIFEST_MIGRATION_SHA256 = "9497a9d31187b2901258bfe4a1cd6823357eb1269483ac8fd160d130d2e3177c";
// SHA-256 of the exact normalized 0119-created DDL read back from sqlite_master.
export const BACKUP_EPOCH_MANIFEST_SCHEMA_SHA256 = "f53ec05bbac33edc8640869d31d45fac14e353faf0a91dcfa0fcbebacc04170c";

const BINDING_TABLE = "backup_epoch_manifest_binding";
const VERIFICATION_TABLE = "backup_epoch_verification_receipt";
const EPOCH_TABLE = "backup_epoch";
const TABLE_COLUMNS = [
  ["backup_epoch_id", "role", "binding_ref", "descriptor_sha256", "descriptor_json", "source_draft_sha256",
    "offsite_copy_id", "offsite_readback_digest", "created_at"],
  ["receipt_ref", "receipt_sha256", "backup_epoch_id", "outcome", "receipt_json", "binding_set_sha256",
    "core_export_ref", "search_projection_manifest_ref", "evidence_manifest_ref", "work_manifest_ref",
    "source_draft_sha256", "offsite_copy_id", "offsite_copy_ref", "offsite_readback_digest", "destination_id",
    "key_generation", "policy_digest", "purge_ledger_revision", "purge_ledger_digest",
    "primary_inventory_object_count", "primary_inventory_digest", "producer_claim_count", "producer_claims_digest",
    "canonical_epoch_count", "canonical_epochs_digest", "created_at"],
] as const;
const EXPECTED_OBJECTS = [
  "index:backup_epoch_manifest_binding_source",
  "table:backup_epoch_manifest_binding",
  "table:backup_epoch_verification_receipt",
  "trigger:backup_epoch_immutable_delete",
  "trigger:backup_epoch_manifest_binding_immutable_delete",
  "trigger:backup_epoch_manifest_binding_immutable_update",
  "trigger:backup_epoch_manifest_binding_insert_guard",
  "trigger:backup_epoch_manifest_identity_guard",
  "trigger:backup_epoch_manifest_publication_guard",
  "trigger:backup_epoch_verification_receipt_immutable_delete",
  "trigger:backup_epoch_verification_receipt_immutable_update",
  "trigger:backup_epoch_verification_receipt_insert_guard",
] as const;

interface SchemaObjectRow {
  readonly type: unknown;
  readonly name: unknown;
  readonly tbl_name: unknown;
  readonly sql: unknown;
}

interface SqlObject {
  readonly type: "table" | "index" | "trigger";
  readonly name: string;
  readonly sql: string;
}

async function all<T>(database: D1Database, sql: string, values: readonly string[] = []): Promise<readonly T[]> {
  let result: D1Result<T>;
  try { result = await database.prepare(sql).bind(...values).all<T>(); }
  catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "canonical backup manifest schema read is unavailable", true, {}, cause);
  }
  if (result.success !== true || !Array.isArray(result.results)) {
    failBackup("BACKUP_TABLE_MISSING", "canonical backup manifest schema readback is malformed", true);
  }
  return result.results;
}

function failSchema(label: string): never {
  failBackup("BACKUP_TABLE_MISSING", `canonical backup manifest ${label} authority is missing or mismatched`, false, { schema: label });
}

async function assertTableColumns(database: D1Database, table: string, expected: readonly string[]): Promise<void> {
  const columns = await all<{ readonly name: unknown }>(database, `PRAGMA table_info(${table})`);
  const observed = columns.map((column) => column.name);
  if (observed.some((name) => typeof name !== "string") || JSON.stringify(observed) !== JSON.stringify(expected)) {
    failSchema(table);
  }
}

async function schemaObjects(database: D1Database): Promise<readonly SqlObject[]> {
  const rows = await all<SchemaObjectRow>(database,
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND " +
      "((type='table' AND name IN (?1,?2)) OR (type='index' AND tbl_name IN (?1,?2)) OR " +
      "(type='trigger' AND tbl_name IN (?1,?2,?3)))",
    [BINDING_TABLE, VERIFICATION_TABLE, EPOCH_TABLE]);
  const objects: SqlObject[] = [];
  for (const row of rows) {
    if ((row.type !== "table" && row.type !== "index" && row.type !== "trigger") ||
        typeof row.name !== "string" || typeof row.sql !== "string") failSchema("sqlite_master");
    objects.push({ type: row.type, name: row.name, sql: row.sql });
  }
  return objects;
}

function compareObjects(left: SqlObject, right: SqlObject): number {
  return left.type < right.type ? -1 : left.type > right.type ? 1 : left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

/** Checks the migration ledger and exact DDL that authorizes PENDING publication; never runs DDL. */
export async function assertBackupEpochManifestMigrationAuthority(database: D1Database): Promise<void> {
  await assertBackupProducerFenceMigrationAuthority(database);
  const ledger = await all<{ readonly name: unknown }>(database,
    "SELECT name FROM d1_migrations WHERE name=?1 LIMIT 2", [BACKUP_EPOCH_MANIFEST_MIGRATION]);
  if (ledger.length !== 1 || ledger[0]?.name !== BACKUP_EPOCH_MANIFEST_MIGRATION) failSchema("0119_migration_ledger");
  await assertTableColumns(database, BINDING_TABLE, TABLE_COLUMNS[0]);
  await assertTableColumns(database, VERIFICATION_TABLE, TABLE_COLUMNS[1]);
  const ordered = [...await schemaObjects(database)].sort(compareObjects);
  const observedKeys = ordered.map((object) => `${object.type}:${object.name}`);
  if (JSON.stringify(observedKeys) !== JSON.stringify(EXPECTED_OBJECTS)) failSchema("0119_object_inventory");
  const fingerprint = await backupSha256Hex(
    ordered.map((object) => `${object.type} ${object.name} ${canonicalizeSchemaSql(object.sql)}`).join("\n"),
  );
  if (fingerprint !== BACKUP_EPOCH_MANIFEST_SCHEMA_SHA256) failSchema("0119_schema_fingerprint");
}
