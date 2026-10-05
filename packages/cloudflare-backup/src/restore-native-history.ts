import type { BackupEpochDraft } from "@eliotr/backup-o2";
import { TABLE_SPECS, backupSha256Hex, canonicalBackupJson, failBackup } from "@eliotr/backup-o2";
import type { VerifiedPortableBackupManifests } from "@eliotr/backup-o2";

export const NATIVE_HISTORY_ARCHIVE_PROTOCOL = "eliotr.backup-native-history-archive.v1" as const;

export const NATIVE_HISTORY_TABLES = [
  { table: "research_provider_key_configuration_operation", introduced_by: "0109_research_provider_key_configuration.sql", manifest: "heads" },
  { table: "research_provider_key_model_use_operation", introduced_by: "0110_research_provider_key_model_use.sql", manifest: "heads" },
  { table: "research_provider_key_model_use_stage_operation", introduced_by: "0110_research_provider_key_model_use.sql", manifest: "heads" },
  { table: "research_provider_key_model_price_observation", introduced_by: "0110_research_provider_key_model_use.sql", manifest: "generations" },
  { table: "provider_native_model_preparation", introduced_by: "0111_provider_native_model_authority.sql", manifest: "generations" },
  { table: "provider_native_model_qualification_attempt", introduced_by: "0111_provider_native_model_authority.sql", manifest: "generations" },
  { table: "provider_native_model_qualification_observation", introduced_by: "0111_provider_native_model_authority.sql", manifest: "generations" },
  { table: "provider_native_model_candidate", introduced_by: "0111_provider_native_model_authority.sql", manifest: "generations" },
  { table: "provider_native_model_qualification_proof", introduced_by: "0111_provider_native_model_authority.sql", manifest: "generations" },
  { table: "provider_native_model_qualification_revocation", introduced_by: "0111_provider_native_model_authority.sql", manifest: "generations" },
] as const;

type NativeHistoryPolicy = typeof NATIVE_HISTORY_TABLES[number];
type ManifestGroup = "heads" | "generations";

export interface NativeHistoryManifestGroupPin {
  readonly manifest_sha256: string;
  readonly group_sha256: string;
}

export interface NativeHistoryArchiveSource {
  readonly epoch_id: string;
  readonly offsite_copy_ref: string;
  readonly schema_generation: string;
  readonly migration_names: readonly string[];
  readonly migration_ledger_digest: string;
  readonly schema_inventory_digest: string;
  readonly schema_inventory_manifest_sha256: string;
  readonly manifest_groups: Readonly<Record<ManifestGroup, NativeHistoryManifestGroupPin>>;
}

export interface NativeHistoryArchiveSourceContext {
  readonly source: NativeHistoryArchiveSource;
  readonly vector_tables: Readonly<Record<string, { readonly count: number; readonly digest: string }>>;
  readonly source_rows: VerifiedPortableBackupManifests["source_rows"];
}

export interface NativeHistoryArchiveTable {
  readonly table: string;
  readonly introduced_by: string;
  readonly manifest: ManifestGroup;
  readonly source_row_count: number;
  readonly source_vector_table_count: number;
  readonly source_vector_table_digest: string;
  readonly source_rows_sha256: string;
  readonly target_row_count: 0;
  readonly target_empty_sha256: string;
}

export interface NativeHistoryArchiveSummary {
  readonly protocol: typeof NATIVE_HISTORY_ARCHIVE_PROTOCOL;
  readonly disposition: "ARCHIVE_ONLY_NOT_MATERIALIZED";
  readonly source: NativeHistoryArchiveSource;
  readonly tables: readonly NativeHistoryArchiveTable[];
  readonly source_row_count: number;
  readonly source_rows_sha256: string;
  readonly target_readback_digest: string;
  readonly archive_digest: string;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const MIGRATION_CHAIN = [
  "0109_research_provider_key_configuration.sql",
  "0110_research_provider_key_model_use.sql",
  "0111_provider_native_model_authority.sql",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function failArchive(message: string): never {
  return failBackup("BACKUP_VECTOR_UNVERIFIABLE", message);
}

function assertMigrationNames(value: unknown): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !/^\d{4}_[A-Za-z0-9._-]+\.sql$/u.test(name)) ||
      value.some((name, index, names) => index > 0 && name <= (names[index - 1] as string))) {
    failArchive("native-history archive migration ledger is malformed or unsorted");
  }
  const names = new Set(value as string[]);
  for (let index = 1; index < MIGRATION_CHAIN.length; index += 1) {
    const migration = MIGRATION_CHAIN[index];
    const predecessor = MIGRATION_CHAIN[index - 1];
    if (migration !== undefined && predecessor !== undefined && names.has(migration) && !names.has(predecessor)) {
      failArchive("native-history archive migration chain is incomplete");
    }
  }
}

export function expectedNativeHistoryTables(migrationNames: readonly string[]): readonly NativeHistoryPolicy[] {
  assertMigrationNames(migrationNames);
  const names = new Set(migrationNames);
  return NATIVE_HISTORY_TABLES.filter((entry) => names.has(entry.introduced_by));
}

function digestRows(table: string, introducedBy: string, manifest: string, rows: readonly Readonly<Record<string, unknown>>[]): Promise<string> {
  return backupSha256Hex(canonicalBackupJson({ table, introduced_by: introducedBy, manifest, rows: [...rows].map(canonicalBackupJson).sort() }));
}

function digestSourceRows(tables: readonly NativeHistoryArchiveTable[]): Promise<string> {
  return backupSha256Hex(canonicalBackupJson(tables.map((entry) => ({
    table: entry.table, source_row_count: entry.source_row_count,
    source_vector_table_digest: entry.source_vector_table_digest, source_rows_sha256: entry.source_rows_sha256,
  }))));
}

function digestTargetReadback(tables: readonly NativeHistoryArchiveTable[]): Promise<string> {
  return backupSha256Hex(canonicalBackupJson(tables.map((entry) => ({
    table: entry.table, target_row_count: entry.target_row_count, target_empty_sha256: entry.target_empty_sha256,
  }))));
}

export async function digestNativeHistoryArchive(value: Omit<NativeHistoryArchiveSummary, "archive_digest">): Promise<string> {
  return backupSha256Hex(canonicalBackupJson(value));
}

export function digestNativeHistoryRestoreReadback(baseReadbackDigest: string, targetReadbackDigest: string): Promise<string> {
  if (!SHA256.test(baseReadbackDigest) || !SHA256.test(targetReadbackDigest)) failArchive("restore readback digest inputs are malformed");
  return backupSha256Hex(canonicalBackupJson({ base_readback_digest: baseReadbackDigest, target_readback_digest: targetReadbackDigest }));
}

function schemaInventoryDigest(manifests: VerifiedPortableBackupManifests): string {
  const lines = manifests.manifests["schema-inventory"];
  const root = lines?.find((line) => isRecord(line) && !("table" in line));
  if (!isRecord(root) || typeof root["schema_inventory_digest"] !== "string" || !SHA256.test(root["schema_inventory_digest"])) {
    failArchive("native-history archive is missing the authenticated schema-inventory root");
  }
  return root["schema_inventory_digest"];
}

function expectedSource(draft: BackupEpochDraft, manifests: VerifiedPortableBackupManifests): NativeHistoryArchiveSourceContext {
  const vector = manifests.vector;
  const migrationNames = vector["migration_names"];
  assertMigrationNames(migrationNames);
  const migrationLedgerDigest = vector["migration_ledger_digest"];
  const schemaGeneration = vector["schema_generation"];
  const group = (name: ManifestGroup): NativeHistoryManifestGroupPin => {
    const manifest = draft.manifest_digests[name];
    const digest = draft.group_digests[name];
    if (typeof manifest !== "string" || !SHA256.test(manifest) || typeof digest !== "string" || !SHA256.test(digest)) {
      failArchive(`native-history archive ${name} manifest group is not pinned by the authenticated epoch`);
    }
    return { manifest_sha256: manifest, group_sha256: digest };
  };
  const source: NativeHistoryArchiveSource = {
    epoch_id: draft.epoch_id,
    offsite_copy_ref: "",
    schema_generation: typeof schemaGeneration === "string" ? schemaGeneration : "",
    migration_names: migrationNames,
    migration_ledger_digest: typeof migrationLedgerDigest === "string" ? migrationLedgerDigest : "",
    schema_inventory_digest: schemaInventoryDigest(manifests),
    schema_inventory_manifest_sha256: draft.manifest_digests["schema-inventory"] ?? "",
    manifest_groups: { heads: group("heads"), generations: group("generations") },
  };
  const rawTables = vector["tables"];
  if (!isRecord(rawTables)) failArchive("native-history archive has no authenticated vector table inventory");
  const vectorTables: Record<string, { count: number; digest: string }> = {};
  for (const policy of expectedNativeHistoryTables(migrationNames)) {
    const entry = rawTables[policy.table];
    if (!isRecord(entry) || !Number.isSafeInteger(entry["count"]) || (entry["count"] as number) < 0 ||
        typeof entry["digest"] !== "string" || !SHA256.test(entry["digest"])) {
      failArchive(`native-history archive table ${policy.table} has no exact authenticated vector entry`);
    }
    vectorTables[policy.table] = { count: entry["count"] as number, digest: entry["digest"] };
  }
  const inventoryTables = new Map((manifests.manifests["schema-inventory"] ?? []).filter((line) => isRecord(line) && typeof line["table"] === "string")
    .map((line) => [(line as Record<string, unknown>)["table"] as string, line] as const));
  for (const policy of expectedNativeHistoryTables(migrationNames)) {
    const spec = TABLE_SPECS.find((entry) => entry.table === policy.table);
    const inventory = inventoryTables.get(policy.table);
    const columns = isRecord(inventory) && Array.isArray(inventory["columns"]) && inventory["columns"].every((column) => typeof column === "string")
      ? [...inventory["columns"] as string[]].sort()
      : [];
    if (spec === undefined || spec.manifest !== policy.manifest ||
        canonicalBackupJson(columns) !== canonicalBackupJson(Object.keys(spec.columns).sort())) {
      failArchive(`native-history archive table ${policy.table} is absent from its authenticated source schema or manifest`);
    }
  }
  if (typeof source.schema_generation !== "string" || source.schema_generation.length === 0 ||
      source.epoch_id.length === 0 || !SHA256.test(source.migration_ledger_digest) ||
      !SHA256.test(source.schema_inventory_manifest_sha256) || !SHA256.test(source.schema_inventory_digest) ||
      source.migration_ledger_digest !== draft.migration_ledger_digest ||
      source.schema_generation !== draft.schema_generation) {
    failArchive("native-history archive source schema or migration pins diverge from the verified epoch");
  }
  return { source, vector_tables: vectorTables, source_rows: manifests.source_rows };
}

export function nativeHistoryArchiveSourceContext(draft: BackupEpochDraft, manifests: VerifiedPortableBackupManifests, offsiteCopyRef: string): NativeHistoryArchiveSourceContext {
  if (typeof offsiteCopyRef !== "string" || offsiteCopyRef.length === 0) failArchive("native-history archive offsite-copy identity is missing");
  const derived = expectedSource(draft, manifests);
  return { ...derived, source: { ...derived.source, offsite_copy_ref: offsiteCopyRef } };
}

export async function buildNativeHistoryArchive(input: {
  readonly draft: BackupEpochDraft;
  readonly manifests: VerifiedPortableBackupManifests;
  readonly offsite_copy_ref: string;
  readonly target: D1Database;
  readonly assertCurrentFence: () => Promise<void>;
}): Promise<NativeHistoryArchiveSummary> {
  const context = nativeHistoryArchiveSourceContext(input.draft, input.manifests, input.offsite_copy_ref);
  const policies = expectedNativeHistoryTables(context.source.migration_names);
  const rowsByTable = new Map<string, Readonly<Record<string, unknown>>[]>();
  for (const row of context.source_rows) {
    if (NATIVE_HISTORY_TABLES.some((entry) => entry.table === row.table) && !policies.some((entry) => entry.table === row.table)) {
      failArchive(`native-history row ${row.table} is present before its introducing migration`);
    }
    if (policies.some((entry) => entry.table === row.table)) {
      const rows = rowsByTable.get(row.table) ?? [];
      rows.push(row.row);
      rowsByTable.set(row.table, rows);
    }
  }
  const tables: NativeHistoryArchiveTable[] = [];
  for (const policy of policies) {
    const rows = rowsByTable.get(policy.table) ?? [];
    const vector = context.vector_tables[policy.table];
    if (vector === undefined || vector.count !== rows.length) failArchive(`native-history source row count diverges from the authenticated ${policy.table} vector`);
    const canonicalVectorDigest = rows.length === 0
      ? await backupSha256Hex(`${policy.table}:EMPTY`)
      : await backupSha256Hex(`\n${await backupSha256Hex(rows.map(canonicalBackupJson).sort().join("\n"))}`);
    if (canonicalVectorDigest !== vector.digest) failArchive(`native-history source rows diverge from the authenticated ${policy.table} vector digest`);
    await input.assertCurrentFence();
    let readback: D1Result<{ readonly present: number }>;
    try { readback = await input.target.prepare(`SELECT 1 AS present FROM "${policy.table}" LIMIT 1`).all<{ readonly present: number }>(); }
    catch (cause) { failBackup("BACKUP_RESTORE_UNCERTAIN", "archive-only target table absence readback is unavailable", true, { table: policy.table }, cause); }
    if (readback.success !== true || !Array.isArray(readback.results) || readback.results.length !== 0) {
      failBackup("BACKUP_RESTORE_UNCERTAIN", "archive-only target table is not exactly empty", true, { table: policy.table });
    }
    await input.assertCurrentFence();
    const emptyDigest = await backupSha256Hex(canonicalBackupJson({ table: policy.table, target_row_count: 0, rows: [] }));
    tables.push({
      table: policy.table, introduced_by: policy.introduced_by, manifest: policy.manifest,
      source_row_count: rows.length, source_vector_table_count: vector.count, source_vector_table_digest: vector.digest,
      source_rows_sha256: await digestRows(policy.table, policy.introduced_by, policy.manifest, rows),
      target_row_count: 0, target_empty_sha256: emptyDigest,
    });
  }
  const tableRows = tables.reduce((sum, entry) => sum + entry.source_row_count, 0);
  const partial = {
    protocol: NATIVE_HISTORY_ARCHIVE_PROTOCOL,
    disposition: "ARCHIVE_ONLY_NOT_MATERIALIZED" as const,
    source: context.source,
    tables,
    source_row_count: tableRows,
    source_rows_sha256: await digestSourceRows(tables),
    target_readback_digest: await digestTargetReadback(tables),
  } as const;
  return validateNativeHistoryArchiveSummary({ ...partial, archive_digest: await digestNativeHistoryArchive(partial) }, context);
}

export async function validateNativeHistoryArchiveSummary(value: unknown, expected?: NativeHistoryArchiveSourceContext): Promise<NativeHistoryArchiveSummary> {
  if (!isRecord(value) || !exactKeys(value, ["protocol", "disposition", "source", "tables", "source_row_count", "source_rows_sha256", "target_readback_digest", "archive_digest"]) ||
      value["protocol"] !== NATIVE_HISTORY_ARCHIVE_PROTOCOL || value["disposition"] !== "ARCHIVE_ONLY_NOT_MATERIALIZED" || !isRecord(value["source"]) || !Array.isArray(value["tables"])) {
    failArchive("native-history archive receipt has unknown or missing fields");
  }
  const source = value["source"];
  if (!exactKeys(source, ["epoch_id", "offsite_copy_ref", "schema_generation", "migration_names", "migration_ledger_digest", "schema_inventory_digest", "schema_inventory_manifest_sha256", "manifest_groups"]) ||
      typeof source["epoch_id"] !== "string" || source["epoch_id"].length === 0 || typeof source["offsite_copy_ref"] !== "string" || source["offsite_copy_ref"].length === 0 ||
      typeof source["schema_generation"] !== "string" || source["schema_generation"].length === 0 || !SHA256.test(String(source["migration_ledger_digest"] ?? "")) ||
      !SHA256.test(String(source["schema_inventory_digest"] ?? "")) || !SHA256.test(String(source["schema_inventory_manifest_sha256"] ?? "")) || !isRecord(source["manifest_groups"]) ||
      !exactKeys(source["manifest_groups"], ["heads", "generations"])) failArchive("native-history archive source pins are malformed");
  assertMigrationNames(source["migration_names"]);
  if (await backupSha256Hex(`migration-ledger\n${source["migration_names"].join("\n")}`) !== source["migration_ledger_digest"]) {
    failArchive("native-history archive migration names disagree with their digest");
  }
  for (const group of ["heads", "generations"] as const) {
    const pin = source["manifest_groups"][group];
    if (!isRecord(pin) || !exactKeys(pin, ["manifest_sha256", "group_sha256"]) ||
        !SHA256.test(String(pin["manifest_sha256"] ?? "")) || !SHA256.test(String(pin["group_sha256"] ?? ""))) {
      failArchive(`native-history archive ${group} manifest pins are malformed`);
    }
  }
  const policies = expectedNativeHistoryTables(source["migration_names"]);
  if (value["tables"].length !== policies.length || !Number.isSafeInteger(value["source_row_count"]) || (value["source_row_count"] as number) < 0 ||
      !SHA256.test(String(value["source_rows_sha256"] ?? "")) || !SHA256.test(String(value["target_readback_digest"] ?? "")) || !SHA256.test(String(value["archive_digest"] ?? ""))) {
    failArchive("native-history archive table set or aggregate fields are malformed");
  }
  const tables: NativeHistoryArchiveTable[] = [];
  for (const [index, raw] of value["tables"].entries()) {
    const policy = policies[index];
    if (!isRecord(raw) || policy === undefined || !exactKeys(raw, ["table", "introduced_by", "manifest", "source_row_count", "source_vector_table_count", "source_vector_table_digest", "source_rows_sha256", "target_row_count", "target_empty_sha256"]) ||
        raw["table"] !== policy.table || raw["introduced_by"] !== policy.introduced_by || raw["manifest"] !== policy.manifest ||
        !Number.isSafeInteger(raw["source_row_count"]) || (raw["source_row_count"] as number) < 0 || raw["source_vector_table_count"] !== raw["source_row_count"] ||
        !SHA256.test(String(raw["source_vector_table_digest"] ?? "")) || !SHA256.test(String(raw["source_rows_sha256"] ?? "")) ||
        raw["target_row_count"] !== 0 || !SHA256.test(String(raw["target_empty_sha256"] ?? ""))) {
      failArchive("native-history archive entries are missing, duplicated, unknown, or inconsistent");
    }
    const expectedEmptyDigest = await backupSha256Hex(canonicalBackupJson({ table: policy.table, target_row_count: 0, rows: [] }));
    if (raw["target_empty_sha256"] !== expectedEmptyDigest) failArchive("native-history archive target-empty digest is not canonical");
    tables.push(raw as unknown as NativeHistoryArchiveTable);
  }
  const sourceRowCount = tables.reduce((sum, entry) => sum + entry.source_row_count, 0);
  const sourceRowsSha = await digestSourceRows(tables);
  const targetReadback = await digestTargetReadback(tables);
  const parsed = value as unknown as NativeHistoryArchiveSummary;
  const partial = {
    protocol: parsed.protocol,
    disposition: parsed.disposition,
    source: parsed.source,
    tables: parsed.tables,
    source_row_count: parsed.source_row_count,
    source_rows_sha256: parsed.source_rows_sha256,
    target_readback_digest: parsed.target_readback_digest,
  };
  if (sourceRowCount !== value["source_row_count"] || sourceRowsSha !== value["source_rows_sha256"] || targetReadback !== value["target_readback_digest"] ||
      await digestNativeHistoryArchive(partial) !== value["archive_digest"]) failArchive("native-history archive table and aggregate digests disagree");
  const summary = value as unknown as NativeHistoryArchiveSummary;
  if (expected !== undefined) {
    if (canonicalBackupJson(summary.source) !== canonicalBackupJson(expected.source)) failArchive("native-history archive does not match the authenticated source epoch identity");
    for (const [index, policy] of policies.entries()) {
      const archived = summary.tables[index];
      const vector = expected.vector_tables[policy.table];
      const sourceRows = expected.source_rows.filter((entry) => entry.table === policy.table).map((entry) => entry.row);
      if (archived === undefined || vector === undefined || archived.source_row_count !== sourceRows.length ||
          archived.source_vector_table_count !== vector.count || archived.source_vector_table_digest !== vector.digest || vector.count !== sourceRows.length ||
          archived.source_rows_sha256 !== await digestRows(policy.table, policy.introduced_by, policy.manifest, sourceRows)) {
        failArchive(`native-history archive table ${policy.table} differs from authenticated source rows or vector context`);
      }
      const vectorDigest = sourceRows.length === 0
        ? await backupSha256Hex(`${policy.table}:EMPTY`)
        : await backupSha256Hex(`\n${await backupSha256Hex(sourceRows.map(canonicalBackupJson).sort().join("\n"))}`);
      if (vector.digest !== vectorDigest) failArchive(`native-history source rows diverge from the authenticated ${policy.table} vector digest`);
    }
  }
  return summary;
}
