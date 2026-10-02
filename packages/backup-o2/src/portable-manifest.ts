import type { BackupEpochDraft, BackupPartRef } from "./epoch.js";
import { TABLE_SPECS, BACKUP_MANIFEST_PROTOCOL, BACKUP_SCHEMA_INVENTORY_PROTOCOL, assertExportColumnCoverage, digestCoreColumnInventory, type CoreTableInventory } from "./coherent-cut.js";
import { rebuildManifestLines } from "./coverage.js";
import { backupSha256Hex, canonicalBackupJson, failBackup } from "./shared.js";

export const BACKUP_PORTABLE_MANIFEST_NAMES = [
  "schema", "schema-inventory", "ownership", "sources", "revisions", "projects", "scopes",
  "handles", "heads", "generations", "retention", "purge", "r2-objects", "rebuild", "vector",
] as const;

export interface PlaintextBackupPart {
  readonly manifest: string;
  readonly index: number;
  readonly bytes: Uint8Array;
}

export interface VerifiedPortableBackupManifests {
  readonly manifests: Readonly<Record<string, readonly unknown[]>>;
  readonly source_rows: readonly { readonly table: string; readonly row: Readonly<Record<string, unknown>> }[];
  readonly purge_ledger: readonly Readonly<Record<string, unknown>>[];
  readonly r2_objects: readonly Readonly<Record<string, unknown>>[];
  readonly vector: Readonly<Record<string, unknown>>;
}

function invalid(message: string): never {
  return failBackup("BACKUP_VECTOR_UNVERIFIABLE", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function exactKeys(record: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function objectLines(value: readonly unknown[], name: string): readonly Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of value) {
    if (!isRecord(line)) invalid(`backup ${name} manifest contains a non-object JSONL row`);
    out.push(line);
  }
  return out;
}

function oneLine<T extends Record<string, unknown>>(lines: readonly Record<string, unknown>[], predicate: (line: Record<string, unknown>) => boolean, label: string): T {
  const found = lines.filter(predicate);
  if (found.length !== 1) invalid(`backup ${label} manifest must contain exactly one authority row`);
  return found[0] as T;
}

async function parseManifest(name: string, bytes: Uint8Array): Promise<readonly unknown[]> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", `backup ${name} manifest is not valid UTF-8`, false, { manifest: name }, cause);
  }
  if (text.length === 0) return [];
  if (text.endsWith("\n") || text.includes("\r")) invalid(`backup ${name} manifest has non-canonical JSONL framing`);
  const rawLines = text.split("\n");
  const parsed: unknown[] = [];
  let previous: string | undefined;
  for (const [index, line] of rawLines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (cause) {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", `backup ${name} manifest row ${index} is invalid JSON`, false, { manifest: name }, cause);
    }
    if (!isRecord(value) || canonicalBackupJson(value) !== line) invalid(`backup ${name} manifest row ${index} is not canonical JSON`);
    if (previous !== undefined && line < previous) invalid(`backup ${name} manifest rows are not deterministically sorted`);
    previous = line;
    parsed.push(value);
  }
  return parsed;
}

/**
 * Verify decrypted portable manifests against the controller-persisted epoch
 * draft. Callers must obtain both the draft and read authority from controller
 * storage, then authenticate each ciphertext with openOffsiteBackupPart before
 * passing plaintext here. This function never authorizes a restore target.
 */
export async function verifyPortableBackupManifests(input: {
  readonly draft: BackupEpochDraft;
  readonly plaintext_parts: readonly PlaintextBackupPart[];
}): Promise<VerifiedPortableBackupManifests> {
  const { draft } = input;
  if (draft.manifest_protocol !== BACKUP_MANIFEST_PROTOCOL || draft.part_index.length === 0) invalid("backup epoch draft has an unsupported manifest protocol or no parts");
  if (!exactKeys(draft.manifest_digests, BACKUP_PORTABLE_MANIFEST_NAMES)) invalid("backup draft manifest digest inventory is incomplete or has unknown entries");
  if (!exactKeys(draft.group_digests, ["core", "heads", "generations", "r2"])) invalid("backup draft group digest inventory is incomplete or has unknown entries");
  for (const [name, hash] of Object.entries(draft.manifest_digests)) if (!digest(hash)) invalid(`backup draft manifest digest for ${name} is malformed`);
  for (const [name, hash] of Object.entries(draft.group_digests)) if (!digest(hash)) invalid(`backup draft group digest for ${name} is malformed`);

  const expected = new Map<string, BackupPartRef>();
  for (const part of draft.part_index) {
    if (!BACKUP_PORTABLE_MANIFEST_NAMES.includes(part.manifest as (typeof BACKUP_PORTABLE_MANIFEST_NAMES)[number]) ||
      !Number.isSafeInteger(part.index) || part.index < 1 || !digest(part.sha256) || !Number.isSafeInteger(part.size_bytes) || part.size_bytes < 0 ||
      typeof part.part_key !== "string" || part.part_key.length === 0 || typeof part.etag !== "string" || part.etag.length === 0) {
      invalid("backup draft part index contains a malformed reference");
    }
    const key = `${part.manifest}\u0000${part.index}`;
    if (expected.has(key)) invalid("backup draft part index contains a duplicate position");
    expected.set(key, part);
  }
  const supplied = new Map<string, Uint8Array>();
  for (const part of input.plaintext_parts) {
    const key = `${part.manifest}\u0000${part.index}`;
    if (supplied.has(key) || !expected.has(key)) invalid("backup restore supplied a duplicate or unindexed plaintext part");
    supplied.set(key, part.bytes);
  }
  if (supplied.size !== expected.size) invalid("backup restore is missing an indexed plaintext part");

  const manifests: Record<string, readonly unknown[]> = {};
  for (const name of BACKUP_PORTABLE_MANIFEST_NAMES) {
    const refs = [...expected.values()].filter((part) => part.manifest === name).sort((a, b) => a.index - b.index);
    if (refs.length === 0 || refs.some((part, i) => part.index !== i + 1)) invalid(`backup ${name} manifest part sequence is incomplete`);
    const chunks: Uint8Array[] = [];
    for (const ref of refs) {
      const bytes = supplied.get(`${name}\u0000${ref.index}`);
      if (bytes === undefined || bytes.byteLength !== ref.size_bytes || await backupSha256Hex(bytes) !== ref.sha256) invalid(`backup ${name} manifest part fails its authenticated plaintext digest`);
      chunks.push(bytes);
    }
    const byteLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const joined = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    if (await backupSha256Hex(joined) !== draft.manifest_digests[name]) invalid(`backup ${name} manifest digest disagrees with its persisted draft`);
    manifests[name] = await parseManifest(name, joined);
  }

  const schemaLines = objectLines(manifests["schema"] ?? [], "schema");
  if (schemaLines.length !== 1) invalid("backup schema manifest has unexpected authority rows");
  const schema = oneLine<Record<string, unknown>>(schemaLines, () => true, "schema");
  if (!exactKeys(schema, ["manifest_protocol", "schema_generation", "migration_ledger_digest", "migration_ledger", "migration_count"]) ||
    schema["manifest_protocol"] !== BACKUP_MANIFEST_PROTOCOL || schema["schema_generation"] !== draft.schema_generation ||
    schema["migration_ledger_digest"] !== draft.migration_ledger_digest || schema["migration_ledger"] !== "PRESENT" ||
    !Number.isSafeInteger(schema["migration_count"])) invalid("backup schema manifest disagrees with the persisted epoch draft");

  const vectorLines = objectLines(manifests["vector"] ?? [], "vector");
  if (vectorLines.length !== 1) invalid("backup vector manifest has unexpected authority rows");
  const vectorLine = oneLine<Record<string, unknown>>(vectorLines, (line) => "vector" in line, "vector");
  const vector = vectorLine["vector"];
  if (!exactKeys(vectorLine, ["protocol", "vector", "vector_digest", "schema_inventory_digest", "cut_id", "cut_digest"]) ||
    vectorLine["protocol"] !== BACKUP_MANIFEST_PROTOCOL || !isRecord(vector) ||
    !exactKeys(vector, ["schema_generation", "migration_names", "migration_ledger_digest", "tables", "purge_frontier", "purge_digest", "r2_keys", "r2_bytes", "r2_digest"]) ||
    vectorLine["vector_digest"] !== draft.vector_digest || await backupSha256Hex(canonicalBackupJson(vector)) !== draft.vector_digest ||
    vectorLine["schema_inventory_digest"] === undefined || !digest(vectorLine["schema_inventory_digest"]) ||
    vectorLine["cut_id"] !== draft.cut_id || typeof vectorLine["cut_digest"] !== "string") invalid("backup authority vector fails its persisted digest or cut binding");
  if (vector["schema_generation"] !== draft.schema_generation || vector["migration_ledger_digest"] !== draft.migration_ledger_digest ||
    vector["purge_frontier"] !== draft.purge_ledger_revision || vector["purge_digest"] !== draft.purge_ledger_digest) {
    invalid("backup authority vector disagrees with persisted schema or purge metadata");
  }
  const migrationNames = vector["migration_names"];
  if (!Array.isArray(migrationNames) || migrationNames.some((name) => typeof name !== "string") ||
    (migrationNames as string[]).some((name, index, all) => index > 0 && name <= (all[index - 1] ?? "")) ||
    migrationNames.length !== schema["migration_count"] ||
    await backupSha256Hex(`migration-ledger\n${(migrationNames as string[]).join("\n")}`) !== draft.migration_ledger_digest) {
    invalid("backup migration ledger names do not match their durable digest");
  }

  const inventoryLines = objectLines(manifests["schema-inventory"] ?? [], "schema-inventory");
  const inventoryRoot = oneLine<Record<string, unknown>>(inventoryLines, (line) => "schema_inventory_digest" in line, "schema-inventory");
  if (!exactKeys(inventoryRoot, ["protocol", "inventory_protocol", "schema_inventory_digest", "cut_id"]) ||
    inventoryRoot["protocol"] !== BACKUP_MANIFEST_PROTOCOL || inventoryRoot["inventory_protocol"] !== BACKUP_SCHEMA_INVENTORY_PROTOCOL ||
    inventoryRoot["schema_inventory_digest"] !== vectorLine["schema_inventory_digest"] || inventoryRoot["cut_id"] !== draft.cut_id) {
    invalid("backup schema inventory does not match the authority vector");
  }
  const declaredTables = inventoryLines.filter((line) => "table" in line);
  const tableNames = declaredTables.map((line) => line["table"]);
  const expectedTables = [...new Set(TABLE_SPECS.map((spec) => spec.table))].sort();
  if (tableNames.some((name) => typeof name !== "string") || [...tableNames as string[]].sort().some((name, i) => name !== expectedTables[i]) || tableNames.length !== expectedTables.length) {
    invalid("backup schema inventory table set is incomplete or unrecognized");
  }
  if (inventoryLines.length !== expectedTables.length + 1) invalid("backup schema inventory contains unknown rows");
  const parsedInventory: CoreTableInventory[] = [];
  for (const line of declaredTables) {
    if (!exactKeys(line, ["table", "columns", "column_shapes"])) invalid("backup schema inventory table row has unknown fields");
    const table = line["table"] as string;
    const columns = line["columns"];
    const shapes = line["column_shapes"];
    const known = TABLE_SPECS.find((spec) => spec.table === table);
    if (!Array.isArray(columns) || columns.some((column) => typeof column !== "string") || !Array.isArray(shapes) || shapes.length !== columns.length) {
      invalid(`backup schema inventory has malformed columns for ${table}`);
    }
    const parsedShapes: CoreTableInventory["columns"][number][] = [];
    for (const [index, shape] of shapes.entries()) {
      if (!isRecord(shape) || typeof shape["name"] !== "string" || shape["name"] !== columns[index] ||
        (shape["affinity"] !== "TEXT" && shape["affinity"] !== "INTEGER" && shape["affinity"] !== "REAL") || typeof shape["notnull"] !== "boolean" ||
        !(shape["name"] in (known?.columns ?? {}))) invalid(`backup schema inventory has an unknown or malformed column for ${table}`);
      parsedShapes.push({ name: shape["name"], affinity: shape["affinity"], notnull: shape["notnull"] });
    }
    if (new Set(parsedShapes.map((column) => column.name)).size !== parsedShapes.length) invalid(`backup schema inventory duplicates a column for ${table}`);
    parsedInventory.push({ table, columns: parsedShapes });
  }
  assertExportColumnCoverage(parsedInventory, TABLE_SPECS);
  parsedInventory.sort((left, right) => left.table < right.table ? -1 : left.table > right.table ? 1 : 0);
  if (await digestCoreColumnInventory(parsedInventory) !== inventoryRoot["schema_inventory_digest"]) invalid("backup schema inventory digest does not match its exact column shapes");

  const tableInventory = new Map(declaredTables.map((line) => [line["table"] as string, line["columns"] as string[]]));
  const columnShapesByTable = new Map(parsedInventory.map((entry) => [entry.table, new Map(entry.columns.map((column) => [column.name, column]))]));
  const vectorTables = vector["tables"];
  if (!isRecord(vectorTables) || !exactKeys(vectorTables, expectedTables)) invalid("backup authority vector table inventory is incomplete or unknown");
  const rowsByTable = new Map<string, Readonly<Record<string, unknown>>[]>();
  for (const name of BACKUP_PORTABLE_MANIFEST_NAMES) {
    for (const line of objectLines(manifests[name] ?? [], name)) {
      if (!("row" in line)) continue;
      const row = line["row"];
      if (typeof line["table"] !== "string" || !isRecord(row)) invalid(`backup ${name} manifest contains a malformed portable row`);
      const table = line["table"];
      const spec = TABLE_SPECS.find((entry) => entry.table === table);
      if (spec === undefined || (table === "purge_ledger" ? name !== "purge" : name !== spec.manifest)) invalid(`backup row for ${table} appears in an unknown or incorrect manifest`);
      const shapes = columnShapesByTable.get(table);
      const columns = tableInventory.get(table);
      if (shapes === undefined || columns === undefined || !exactKeys(row, columns)) invalid(`backup row for ${table} does not match its exact portable column inventory`);
      for (const [column, value] of Object.entries(row)) {
        const shape = shapes.get(column);
        if (shape === undefined || (value === null && shape.notnull) ||
          (value !== null && shape.affinity === "TEXT" && typeof value !== "string") ||
          (value !== null && shape.affinity === "INTEGER" && (typeof value !== "number" || !Number.isSafeInteger(value))) ||
          (value !== null && shape.affinity === "REAL" && (typeof value !== "number" || !Number.isFinite(value)))) {
          invalid(`backup row for ${table} has a malformed ${column} value`);
        }
        if (typeof value === "string" && column.endsWith("_json")) {
          try { JSON.parse(value) as unknown; } catch { invalid(`backup row for ${table}.${column} contains invalid JSON`); }
        }
      }
      const rows = rowsByTable.get(line["table"]);
      if (rows === undefined) rowsByTable.set(line["table"], [row]);
      else rowsByTable.set(line["table"], [...rows, row]);
    }
  }
  for (const table of expectedTables) {
    const entry = vectorTables[table];
    const rows = rowsByTable.get(table) ?? [];
    if (!isRecord(entry) || !Number.isSafeInteger(entry["count"]) || !digest(entry["digest"]) || entry["count"] !== rows.length) {
      invalid(`backup authority vector count is invalid for ${table}`);
    }
    const columns = tableInventory.get(table) ?? [];
    const expectedTableDigest = rows.length > 0
      ? await backupSha256Hex(`\n${await backupSha256Hex(rows.map(canonicalBackupJson).sort().join("\n"))}`)
      : await backupSha256Hex(columns.length === 0 ? `${table}:TABLE_ABSENT` : `${table}:EMPTY`);
    if (entry["digest"] !== expectedTableDigest) {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", `backup authority vector digest is invalid for ${table} (${rows.length}; expected ${expectedTableDigest}; got ${String(entry["digest"])})`, false, {
        table, count: String(rows.length), expected: expectedTableDigest, actual: String(entry["digest"]),
      });
    }
  }

  const purgeLines = objectLines(manifests["purge"] ?? [], "purge");
  const purgeSummary = oneLine<Record<string, unknown>>(purgeLines, (line) => "purge_frontier" in line, "purge");
  if (!exactKeys(purgeSummary, ["purge_frontier", "purge_digest"])) invalid("backup purge summary has unknown fields");
  if (purgeLines.length !== purgeLines.filter((line) => "purge_frontier" in line || "row" in line).length) invalid("backup purge manifest has unknown rows");
  const purgeLedger = purgeLines.filter((line) => line["table"] === "purge_ledger").map((line) => {
    if (!isRecord(line["row"])) invalid("backup purge manifest contains a malformed ledger row");
    return line["row"];
  });
  const sortedLedger = [...purgeLedger].sort((a, b) => Number(a["ledger_revision"]) - Number(b["ledger_revision"]));
  if (purgeSummary["purge_frontier"] !== draft.purge_ledger_revision || purgeSummary["purge_digest"] !== draft.purge_ledger_digest ||
    await backupSha256Hex(sortedLedger.map(canonicalBackupJson).join("\n")) !== draft.purge_ledger_digest ||
    (sortedLedger.at(-1)?.["ledger_revision"] ?? 0) !== draft.purge_ledger_revision) invalid("backup purge ledger disagrees with its durable frontier or digest");

  const r2Lines = objectLines(manifests["r2-objects"] ?? [], "r2-objects");
  const r2Summary = oneLine<Record<string, unknown>>(r2Lines, (line) => "object_count" in line, "r2-objects");
  if (!exactKeys(r2Summary, ["object_count", "total_bytes", "fingerprint"])) invalid("backup R2 summary has unknown fields");
  const r2Objects = r2Lines.filter((line) => "bucket" in line);
  if (r2Lines.length !== r2Objects.length + 1) invalid("backup R2 inventory contains unknown rows");
  let r2Bytes = 0;
  for (const entry of r2Objects) {
    if (!exactKeys(entry, ["bucket", "key", "size_bytes", "etag", "version", "sha256", "admitted_sha256", "metadata_digest", "http_metadata_digest"]) ||
      (entry["bucket"] !== "evidence" && entry["bucket"] !== "work") || typeof entry["key"] !== "string" ||
      !Number.isSafeInteger(entry["size_bytes"]) || (entry["size_bytes"] as number) < 0 ||
      typeof entry["etag"] !== "string" || typeof entry["version"] !== "string" || !digest(entry["sha256"]) ||
      !(entry["admitted_sha256"] === null || digest(entry["admitted_sha256"])) || !digest(entry["metadata_digest"]) || !digest(entry["http_metadata_digest"])) {
      invalid("backup R2 object inventory contains a malformed object entry");
    }
    r2Bytes += entry["size_bytes"] as number;
  }
  const vectorR2 = vector["r2_keys"] === r2Objects.length && vector["r2_bytes"] === r2Summary["total_bytes"] &&
    r2Bytes === r2Summary["total_bytes"] && r2Summary["object_count"] === r2Objects.length && digest(r2Summary["fingerprint"]) &&
    await backupSha256Hex(r2Objects.map(canonicalBackupJson).join("\n")) === r2Summary["fingerprint"] &&
    vector["r2_digest"] === r2Summary["fingerprint"];
  if (!vectorR2) invalid("backup R2 object inventory disagrees with its authority vector");

  const rebuildLines = objectLines(manifests["rebuild"] ?? [], "rebuild");
  const expectedRebuild = rebuildManifestLines().map((line) => JSON.parse(line) as unknown).map(canonicalBackupJson).sort();
  if (rebuildLines.length !== expectedRebuild.length || rebuildLines.map(canonicalBackupJson).sort().some((line, index) => line !== expectedRebuild[index])) {
    invalid("backup rebuild manifest does not match the authoritative coverage classifications");
  }
  const headsLines = objectLines(manifests["heads"] ?? [], "heads");
  const optionalAbsent = new Set(["publication", "federation_reference_manifest", "navigation_artifact"]);
  for (const line of headsLines) {
    if ("row" in line) {
      if (!exactKeys(line, ["table", "row"])) invalid("backup heads row has unknown fields");
      continue;
    }
    if ("kind" in line) {
      if (!exactKeys(line, ["kind", "id", "head_revision"]) || line["kind"] !== "investigation" || typeof line["id"] !== "string" || !Number.isSafeInteger(line["head_revision"])) invalid("backup investigation head entry is malformed");
      continue;
    }
    if (!exactKeys(line, ["table", "status"]) || typeof line["table"] !== "string" || !optionalAbsent.has(line["table"]) || line["status"] !== "TABLE_ABSENT") invalid("backup heads manifest contains an unknown entry");
  }
  for (const name of ["ownership", "sources", "revisions", "projects", "scopes", "handles", "generations", "retention"] as const) {
    for (const line of objectLines(manifests[name] ?? [], name)) if (!exactKeys(line, ["table", "row"])) invalid(`backup ${name} manifest contains an unknown entry`);
  }

  const groups: Readonly<Record<string, readonly string[]>> = {
    core: ["schema", "schema-inventory", "ownership", "sources", "revisions", "projects", "scopes", "handles", "retention", "purge", "vector"],
    heads: ["heads"],
    generations: ["generations"],
    r2: ["r2-objects"],
  };
  for (const [groupName, members] of Object.entries(groups)) {
    const expectedDigest = await backupSha256Hex(members.map((name) => `${name}:${draft.manifest_digests[name] ?? "ABSENT"}`).sort().join("\n"));
    if (draft.group_digests[groupName] !== expectedDigest) invalid(`backup ${groupName} manifest group digest is invalid`);
  }

  const sourceRows: { table: string; row: Readonly<Record<string, unknown>> }[] = [];
  for (const name of BACKUP_PORTABLE_MANIFEST_NAMES) {
    for (const line of objectLines(manifests[name] ?? [], name)) {
      if (typeof line["table"] !== "string") continue;
      const row = line["row"];
      if (!isRecord(row)) continue;
      sourceRows.push({ table: line["table"], row });
    }
  }
  return {
    manifests,
    source_rows: sourceRows,
    purge_ledger: sortedLedger,
    r2_objects: r2Objects,
    vector,
  };
}
