import type { OperationIntent, OperationReceipt, OperationAttempt } from "@eliotr/contracts";
import {
  backupAborted, backupAttempt, backupIsoDateTime, backupReceipt, backupSha256Hex,
  canonicalBackupJson, failBackup, resolveBackupExportLimits, assertBackupIntent,
  hashBackupStream, type BackupExportLimits, type EvidenceObjectStore, type Sha256DigestSinkFactory,
} from "./shared.js";
import { assertExhaustiveTableCoverage, listDurableTables, rebuildManifestLines } from "./coverage.js";
import { freshBackupR2Tally, snapshotBackupR2Bucket } from "./r2-inventory.js";
import { claimEpochReceipt } from "./replay-authority.js";

// ER-34 O2 portable epoch. IMPLEMENTED_NOT_LIVE. Coherent-cut: pre-freeze,
// bounded export, post-freeze/readback reconciliation proving byte-identical
// watermarks or failing closed. The complete authority vector is persisted as
// a content-addressed `vector` manifest; its digest is bound into the epoch.

const SHA256 = /^[a-f0-9]{64}$/u;

export interface BackupExportContext {
  readonly attempt_number?: number;
  readonly signal?: AbortSignal;
  readonly retention_days?: number;
  readonly now_ms?: number;
}

type ColumnKind = "text" | "int" | "text-or-null" | "int-or-null";
interface TableSpec {
  readonly manifest: string;
  readonly table: string;
  readonly order_by: string;
  readonly columns: Readonly<Record<string, ColumnKind>>;
  readonly required: boolean;
}

const TABLE_SPECS: readonly TableSpec[] = [
  { manifest: "ownership", table: "source_namespace_ownership", order_by: "source_namespace_id, ownership_record_revision", columns: { source_namespace_id: "text", ownership_record_revision: "int", owner_system_id: "text", owner_incarnation_ref: "text", source_owner_generation: "text", source_admission_policy_revision: "int", status: "text", cutover_receipt_ref: "text-or-null", created_at: "text" }, required: true },
  { manifest: "sources", table: "source", order_by: "source_id", columns: { source_id: "text", source_namespace_id: "text", source_owner_system_id: "text", source_owner_generation: "text", ownership_mode: "text", kind: "text", title: "text", default_storage_policy: "text", default_residency_profile_id: "text", source_class: "text", license_policy_ref: "text", default_retention_policy_id: "text", head_rev: "text-or-null", created_at: "text" }, required: true },
  { manifest: "revisions", table: "source_revision", order_by: "source_revision_ref", columns: { source_revision_ref: "text", source_id: "text", source_owner_generation: "text", content_sha256: "text", object_residency_key_digest: "text", original_r2_key: "text-or-null", normalized_artifact_ref: "text-or-null", captured_at: "text", quality_state: "text", purge_state: "text", source_view_ref: "text", admitted_at: "text" }, required: true },
  { manifest: "projects", table: "project", order_by: "project_id", columns: { project_id: "text", title: "text", default_disclosure: "text", retention_policy_ref: "text", default_source_policy_ref: "text", default_model_profile_ref: "text", default_depth_profile_ref: "text", generation: "int", created_at: "text" }, required: true },
  { manifest: "projects", table: "project_source_membership", order_by: "project_id, source_id, valid_from", columns: { project_id: "text", source_id: "text", role: "text", valid_from: "text", valid_to: "text-or-null", membership_generation: "int" }, required: true },
  { manifest: "projects", table: "source_tag", order_by: "source_id, tag, valid_from", columns: { source_id: "text", tag: "text", valid_from: "text", valid_to: "text-or-null" }, required: false },
  { manifest: "scopes", table: "scope_snapshot", order_by: "snapshot_id, revision", columns: { snapshot_id: "text", revision: "int", resolved_scope_expression_json: "text", participant_generations_json: "text", member_source_revision_refs_json: "text", source_owner_generations_json: "text", policy_authority_ref: "text", disclosure_closure_digest: "text", purge_ledger_revision: "int", snapshot_digest: "text", created_at: "text", expires_at: "text", invalidated_at: "text-or-null", invalidation_reason: "text-or-null" }, required: true },
  { manifest: "handles", table: "evidence_handle", order_by: "handle_id, revision", columns: { handle_id: "text", revision: "int", source_namespace_id: "text", source_owner_generation: "text", source_revision_ref: "text", scope_snapshot_id: "text", scope_snapshot_revision: "int", anchor_json: "text", excerpt_sha256: "text", excerpt_byte_length: "int", object_residency_key_digest: "text", source_assurance_ceiling: "text", materializer_assurance_ceiling: "text", terminal_state: "text", invalidation_ref: "text-or-null", created_at: "text" }, required: true },
  { manifest: "handles", table: "evidence_handle_invalidation", order_by: "handle_id, handle_revision", columns: { invalidation_ref: "text", handle_id: "text", handle_revision: "int", terminal_state: "text", reason_code: "text", observed_at: "text" }, required: false },
  { manifest: "heads", table: "investigation", order_by: "investigation_id, revision", columns: { investigation_id: "text", revision: "int", scope_snapshot_id: "text", scope_snapshot_revision: "int", manifest_r2_key: "text", created_at: "text" }, required: false },
  { manifest: "heads", table: "artifact_head", order_by: "artifact_id", columns: { artifact_id: "text", head_revision: "int", manifest_r2_key: "text", updated_at: "text" }, required: false },
  { manifest: "heads", table: "artifact_revision", order_by: "artifact_id, revision", columns: { artifact_id: "text", revision: "int", kind: "text", evidence_freeze_id: "text", manifest_r2_key: "text", status: "text", created_at: "text" }, required: false },
  { manifest: "heads", table: "wiki_head", order_by: "page_id", columns: { page_id: "text", head_revision: "int", manifest_r2_key: "text", updated_at: "text" }, required: false },
  { manifest: "heads", table: "wiki_revision", order_by: "page_id, revision", columns: { page_id: "text", revision: "int", page_type: "text", scope_snapshot_id: "text", scope_snapshot_revision: "int", body_r2_key: "text", manifest_r2_key: "text", status: "text", created_at: "text" }, required: false },
  { manifest: "generations", table: "model_generation", order_by: "generation_id", columns: { generation_id: "text", capability_class: "text", status: "text", created_at: "text" }, required: false },
  { manifest: "generations", table: "exchange_generation", order_by: "generation_id", columns: { generation_id: "text", connection_id: "text", protocol_version: "text", state: "text", created_at: "text" }, required: false },
  { manifest: "generations", table: "projection_generation", order_by: "source_revision_ref, projection_generation", columns: { source_revision_ref: "text", projection_generation: "text", source_owner_generation: "text", content_sha256: "text", state: "text", created_at: "text" }, required: false },
  { manifest: "retention", table: "backup_epoch", order_by: "backup_epoch_id", columns: { backup_epoch_id: "text", core_export_ref: "text", offsite_copy_ref: "text", purge_ledger_revision: "int", verification_state: "text", created_at: "text" }, required: false },
  { manifest: "retention", table: "erasure_hold", order_by: "hold_ref", columns: { hold_ref: "text", policy_or_hold_ref: "text", next_review_at: "text", state: "text" }, required: false },
];

export interface SnapshotRow { readonly table: string; readonly row: Readonly<Record<string, unknown>>; }
export interface AuthorityVector {
  readonly schema_generation: string;
  readonly migration_names: readonly string[];
  readonly migration_ledger_digest: string;
  readonly tables: Readonly<Record<string, { readonly count: number; readonly digest: string }>>;
  readonly purge_frontier: number;
  readonly purge_digest: string;
  readonly r2_keys: number;
  readonly r2_bytes: number;
  readonly r2_digest: string;
}
export interface BackupSourcePorts {
  readonly core_db: D1Database;
  readonly evidence_bucket: R2Bucket;
  readonly work_bucket: R2Bucket;
  readonly part_sink: EvidenceObjectStore;
  readonly create_sha256_sink?: Sha256DigestSinkFactory;
}
export interface BackupPartRef {
  readonly manifest: string; readonly index: number; readonly part_key: string;
  readonly sha256: string; readonly size_bytes: number; readonly etag: string;
  readonly existed_identically: boolean;
}
export interface BackupEpochDraft {
  readonly epoch_id: string; readonly schema_generation: string;
  readonly migration_ledger_digest: string;
  readonly manifest_digests: Readonly<Record<string, string>>;
  readonly group_digests: Readonly<Record<string, string>>;
  readonly part_index: readonly BackupPartRef[];
  readonly purge_ledger_revision: number; readonly purge_ledger_digest: string;
  readonly r2_object_count: number; readonly r2_total_bytes: number;
  readonly audit_sample_receipt_ref: string;
  readonly vector_digest: string; readonly vector_manifest_digest: string;
  readonly created_at: string; readonly expires_at: string;
}
export interface BackupEpochResult {
  readonly draft: BackupEpochDraft; readonly attempt: OperationAttempt;
  readonly receipt: OperationReceipt; readonly vector_digest: string;
}
export interface BackupEpochPort {
  createPortableEpoch(intent: OperationIntent, context?: BackupExportContext): Promise<BackupEpochResult>;
}

const MANIFEST_NAMES = ["schema", "ownership", "sources", "revisions", "projects", "scopes", "handles", "heads", "generations", "retention", "purge", "r2-objects", "rebuild", "vector"];

async function backupTableExists(database: D1Database, table: string): Promise<boolean> {
  try {
    const row = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1").bind(table).first<{ readonly name: unknown }>();
    return row !== null && row.name === table;
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", `backup authority read for ${table} is unavailable`, true, { table }, cause);
  }
}

function decodeCell(table: string, column: string, kind: ColumnKind, value: unknown, index: number): unknown {
  const label = `${table}[${index}].${column}`;
  if (value === null) {
    if (kind === "text-or-null" || kind === "int-or-null") return null;
    failBackup("BACKUP_ROW_INVALID", `backup row is missing load-bearing column ${label}`, false, { table, column });
  }
  if (kind === "text" || kind === "text-or-null") {
    if (typeof value !== "string") failBackup("BACKUP_ROW_INVALID", `backup row column ${label} is not text`, false, { table, column });
    return value;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) failBackup("BACKUP_ROW_INVALID", `backup row column ${label} is not a safe integer`, false, { table, column });
  return value;
}

async function readBackupTable(database: D1Database, spec: TableSpec, maxRows: number, signal?: AbortSignal): Promise<readonly SnapshotRow[]> {
  if (backupAborted(signal)) failBackup("BACKUP_CANCELLED", "backup export was cancelled", true);
  if (!await backupTableExists(database, spec.table)) {
    if (spec.required) failBackup("BACKUP_TABLE_MISSING", `backup required table ${spec.table} is absent`, false, { table: spec.table });
    return [];
  }
  const columns = Object.keys(spec.columns);
  let result: D1Result<Record<string, unknown>>;
  try {
    result = await database.prepare(`SELECT ${columns.join(", ")} FROM ${spec.table} ORDER BY ${spec.order_by} LIMIT ?1`).bind(maxRows + 1).all<Record<string, unknown>>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", `backup authority read for ${spec.table} failed`, true, { table: spec.table }, cause);
  }
  const raw = result.results ?? [];
  if (raw.length > maxRows) failBackup("BACKUP_BOUND_EXCEEDED", `backup table ${spec.table} exceeds its row bound`, false, { table: spec.table, limit: String(maxRows) });
  const rows: SnapshotRow[] = raw.map((input, index) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) failBackup("BACKUP_ROW_INVALID", `backup row ${spec.table}[${index}] is not a record`, false, { table: spec.table });
    const row: Record<string, unknown> = {};
    for (const [column, kind] of Object.entries(spec.columns)) row[column] = decodeCell(spec.table, column, kind, (input as Record<string, unknown>)[column], index);
    for (const key of Object.keys(input as Record<string, unknown>)) {
      if (!(key in spec.columns)) failBackup("BACKUP_ROW_INVALID", `backup row ${spec.table}[${index}] carries an unknown load-bearing field`, false, { table: spec.table });
    }
    return { table: spec.table, row };
  });
  const ordered = [...rows].sort((l, r) => {
    const a = canonicalBackupJson(l.row); const b = canonicalBackupJson(r.row);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (let i = 1; i < ordered.length; i += 1) {
    const p = ordered[i - 1]; const c = ordered[i];
    if (p !== undefined && c !== undefined && canonicalBackupJson(p.row) === canonicalBackupJson(c.row)) failBackup("BACKUP_ROW_INVALID", `backup table ${spec.table} contains a duplicate row`, false, { table: spec.table });
  }
  for (const row of ordered) for (const [col, v] of Object.entries(row.row)) {
    if (typeof v === "string" && col.endsWith("_json")) {
      try { JSON.parse(v); } catch { failBackup("BACKUP_ROW_INVALID", `backup row ${spec.table}.${col} is not valid JSON`, false, { table: spec.table, column: col }); }
    }
  }
  return ordered;
}

async function readSchemaGeneration(database: D1Database): Promise<string> {
  let row: { readonly value: unknown } | null;
  try {
    row = await database.prepare("SELECT value FROM schema_state WHERE key = 'schema_generation'").first<{ readonly value: unknown }>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup schema generation read is unavailable", true, {}, cause);
  }
  if (row === null || typeof row.value !== "string" || row.value.length === 0) failBackup("BACKUP_TABLE_MISSING", "backup schema generation is absent");
  return row.value;
}

async function readMigrationNames(database: D1Database, maxRows: number): Promise<{ readonly names: readonly string[]; readonly explicit_absent: boolean }> {
  if (!await backupTableExists(database, "d1_migrations")) return { names: [], explicit_absent: true };
  let result: D1Result<Record<string, unknown>>;
  try {
    result = await database.prepare("SELECT name FROM d1_migrations ORDER BY name LIMIT ?1").bind(maxRows + 1).all<Record<string, unknown>>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup migration ledger read failed", true, {}, cause);
  }
  const rows = result.results ?? [];
  if (rows.length > maxRows) failBackup("BACKUP_BOUND_EXCEEDED", "backup migration ledger exceeds its row bound", false, { limit: String(maxRows) });
  return {
    names: rows.map((row, i) => {
      if (typeof row?.name !== "string" || row.name.length === 0) failBackup("BACKUP_ROW_INVALID", `backup migration ledger row ${i} is malformed`, false, {});
      return row.name;
    }).sort(),
    explicit_absent: false,
  };
}

async function readPurgeLedger(database: D1Database, maxRows: number, signal?: AbortSignal): Promise<{ readonly rows: readonly SnapshotRow[]; readonly frontier: number; readonly digest: string }> {
  if (backupAborted(signal)) failBackup("BACKUP_CANCELLED", "backup export was cancelled", true);
  if (!await backupTableExists(database, "purge_ledger")) failBackup("BACKUP_TABLE_MISSING", "backup purge ledger table is absent");
  let result: D1Result<Record<string, unknown>>;
  try {
    result = await database.prepare("SELECT ledger_revision, erasure_id, non_revealing_subject_digest, disposition, receipt_ref, created_at FROM purge_ledger ORDER BY ledger_revision LIMIT ?1").bind(maxRows + 1).all<Record<string, unknown>>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup purge ledger read failed", true, {}, cause);
  }
  const raw = result.results ?? [];
  if (raw.length > maxRows) failBackup("BACKUP_BOUND_EXCEEDED", "backup purge ledger exceeds its row bound", false, { limit: String(maxRows) });
  const rows: SnapshotRow[] = raw.map((input) => {
    const r = input as Record<string, unknown>;
    if (typeof r["ledger_revision"] !== "number" || !Number.isSafeInteger(r["ledger_revision"])) failBackup("BACKUP_ROW_INVALID", "backup purge ledger has an invalid revision", false, {});
    if (typeof r["non_revealing_subject_digest"] !== "string" || !SHA256.test(r["non_revealing_subject_digest"] as string)) failBackup("BACKUP_ROW_INVALID", "backup purge ledger has an invalid subject digest", false, {});
    if (r["disposition"] !== "COMPLETE" && r["disposition"] !== "BLOCKED") failBackup("BACKUP_ROW_INVALID", "backup purge ledger has an unknown disposition", false, {});
    return { table: "purge_ledger", row: input as Readonly<Record<string, unknown>> };
  });
  let frontier = 0;
  for (const row of rows) {
    const rev = row.row["ledger_revision"];
    if (typeof rev === "number" && rev > frontier) frontier = rev;
  }
  return { rows, frontier, digest: await backupSha256Hex(rows.map((row) => canonicalBackupJson(row.row)).join("\n")) };
}

async function buildManifest(name: string, lines: readonly string[], maxBytes: number): Promise<{ name: string; jsonl: string; bytes: Uint8Array<ArrayBuffer>; digest: string }> {
  const jsonl = lines.join("\n");
  const bytes = new TextEncoder().encode(jsonl);
  if (bytes.byteLength > maxBytes) failBackup("BACKUP_BOUND_EXCEEDED", `backup manifest ${name} exceeds its byte bound`, false, { manifest: name, limit: String(maxBytes) });
  return { name, jsonl, bytes, digest: await backupSha256Hex(bytes) };
}

export function createBackupEpochPort(ports: BackupSourcePorts, overrides?: { readonly limits?: Partial<BackupExportLimits> }): BackupEpochPort {
  const limits = resolveBackupExportLimits(overrides?.limits);

  async function freezeVector(signal?: AbortSignal): Promise<{ readonly vector: AuthorityVector; readonly rows: readonly SnapshotRow[]; readonly purge_rows: readonly SnapshotRow[] }> {
    assertExhaustiveTableCoverage(await listDurableTables(ports.core_db));
    const schemaGeneration = await readSchemaGeneration(ports.core_db);
    const ledger = await readMigrationNames(ports.core_db, limits.max_table_rows);
    const migrationLedgerDigest = await backupSha256Hex(ledger.explicit_absent ? "migration-ledger:ABSENT" : `migration-ledger\n${ledger.names.join("\n")}`);
    const rows: SnapshotRow[] = [];
    const tables: Record<string, { count: number; digest: string }> = {};
    for (const spec of TABLE_SPECS) {
      const tableRows = await readBackupTable(ports.core_db, spec, limits.max_table_rows, signal);
      if (tableRows.length > 0) {
        for (const row of tableRows) rows.push(row);
        const digest = await backupSha256Hex(tableRows.map((row) => canonicalBackupJson(row.row)).join("\n"));
        const prior = tables[spec.table];
        tables[spec.table] = { count: (prior?.count ?? 0) + tableRows.length, digest: await backupSha256Hex(`${prior?.digest ?? ""}\n${digest}`) };
      } else if (!await backupTableExists(ports.core_db, spec.table)) {
        tables[spec.table] = { count: 0, digest: await backupSha256Hex(`${spec.table}:TABLE_ABSENT`) };
      } else {
        tables[spec.table] = { count: 0, digest: await backupSha256Hex(`${spec.table}:EMPTY`) };
      }
    }
    const purge = await readPurgeLedger(ports.core_db, limits.max_table_rows, signal);
    return {
      vector: { schema_generation: schemaGeneration, migration_names: ledger.names, migration_ledger_digest: migrationLedgerDigest, tables, purge_frontier: purge.frontier, purge_digest: purge.digest, r2_keys: 0, r2_bytes: 0, r2_digest: await backupSha256Hex("r2:pending") },
      rows, purge_rows: purge.rows,
    };
  }

  async function createPortableEpoch(intentInput: OperationIntent, context: BackupExportContext = {}): Promise<BackupEpochResult> {
    const intent = assertBackupIntent(intentInput);
    const attemptNumber = context.attempt_number ?? 1;
    if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) failBackup("BACKUP_INPUT_INVALID", "backup attempt number is invalid");
    const nowMs = context.now_ms ?? Date.now();
    const now = backupIsoDateTime(nowMs);
    const retentionDays = context.retention_days ?? 90;
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) failBackup("BACKUP_INPUT_INVALID", "backup retention window is out of range");
    const signal = context.signal;
    if (backupAborted(signal)) failBackup("BACKUP_CANCELLED", "backup export was cancelled", true);
    const frozen = await freezeVector(signal);
    const tally = freshBackupR2Tally();
    const evidence = await snapshotBackupR2Bucket(ports.evidence_bucket, "evidence", limits, ports.create_sha256_sink, tally, signal);
    const work = await snapshotBackupR2Bucket(ports.work_bucket, "work", limits, ports.create_sha256_sink, tally, signal);
    const r2Entries = [...evidence.entries, ...work.entries].sort((l, r) => {
      const a = `${l.bucket}\u0000${l.key}`; const b = `${r.bucket}\u0000${r.key}`;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const r2TotalBytes = r2Entries.reduce((s, e) => s + e.size_bytes, 0);
    const r2Digest = await backupSha256Hex(r2Entries.map((e) => canonicalBackupJson(e)).join("\n"));
    const vector: AuthorityVector = { ...frozen.vector, r2_keys: r2Entries.length, r2_bytes: r2TotalBytes, r2_digest: r2Digest };
    const vectorDigest = await backupSha256Hex(canonicalBackupJson(vector));
    const vectorManifestLine = canonicalBackupJson({ vector, vector_digest: vectorDigest });
    const byManifest = new Map<string, string[]>();
    const record = (manifest: string, line: string): void => {
      const lines = byManifest.get(manifest);
      if (lines === undefined) byManifest.set(manifest, [line]);
      else lines.push(line);
    };
    const specManifest = new Map<string, string>();
    for (const spec of TABLE_SPECS) specManifest.set(spec.table, spec.manifest);
    for (const row of frozen.rows) record(specManifest.get(row.table) ?? "sources", canonicalBackupJson({ table: row.table, row: row.row }));
    for (const row of frozen.purge_rows) record("purge", canonicalBackupJson({ table: row.table, row: row.row }));
    for (const table of ["publication", "federation_reference_manifest", "navigation_artifact"] as const) {
      if (!await backupTableExists(ports.core_db, table)) record("heads", canonicalBackupJson({ table, status: "TABLE_ABSENT" }));
    }
    const heads = new Map<string, number>();
    for (const row of frozen.rows) {
      if (row.table !== "investigation") continue;
      const id = row.row["investigation_id"]; const rev = row.row["revision"];
      if (typeof id !== "string" || typeof rev !== "number") continue;
      if (rev > (heads.get(id) ?? 0)) heads.set(id, rev);
    }
    for (const [id, head] of [...heads.entries()].sort()) record("heads", canonicalBackupJson({ kind: "investigation", id, head_revision: head }));
    for (const line of rebuildManifestLines()) record("rebuild", line);
    record("schema", canonicalBackupJson({ schema_generation: vector.schema_generation, migration_ledger_digest: vector.migration_ledger_digest, migration_ledger: vector.migration_names.length === 0 ? "ABSENT" : "PRESENT", migration_count: vector.migration_names.length }));
    record("purge", canonicalBackupJson({ purge_frontier: vector.purge_frontier, purge_digest: vector.purge_digest }));
    record("r2-objects", canonicalBackupJson({ object_count: r2Entries.length, total_bytes: r2TotalBytes, fingerprint: r2Digest }));
    for (const entry of r2Entries) record("r2-objects", canonicalBackupJson(entry));
    record("vector", vectorManifestLine);
    const bundles: { name: string; jsonl: string; bytes: Uint8Array<ArrayBuffer>; digest: string }[] = [];
    for (const name of MANIFEST_NAMES) bundles.push(await buildManifest(name, (byManifest.get(name) ?? []).sort(), limits.max_manifest_bytes));
    const manifestDigests: Record<string, string> = {};
    for (const bundle of bundles) manifestDigests[bundle.name] = bundle.digest;
    const vectorManifestDigest = manifestDigests["vector"] ?? "";
    const group = async (members: readonly string[]): Promise<string> => backupSha256Hex(members.map((m) => `${m}:${manifestDigests[m] ?? "ABSENT"}`).sort().join("\n"));
    const groupDigests: Record<string, string> = { core: await group(["schema", "ownership", "sources", "revisions", "projects", "scopes", "handles", "retention", "purge", "vector"]), heads: await group(["heads"]), generations: await group(["generations"]), r2: await group(["r2-objects"]) };
    const manifestDigest = await backupSha256Hex(Object.entries(manifestDigests).sort().map(([n, d]) => `${n}:${d}`).join("\n"));
    const epochId = `epoch-${(await backupSha256Hex(`backup-epoch\u0000${intent.intent_ref.id}\u0000${vectorDigest}\u0000${manifestDigest}`)).slice(0, 48)}`;
    const partIndex: BackupPartRef[] = [];
    let reconciled = false;
    for (const bundle of bundles) {
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      for (let off = 0; off < bundle.bytes.byteLength; off += limits.part_bytes) chunks.push(bundle.bytes.slice(off, off + limits.part_bytes));
      if (chunks.length === 0) chunks.push(new Uint8Array());
      let n = 0;
      for (const chunk of chunks) {
        n += 1;
        if (backupAborted(signal)) failBackup("BACKUP_CANCELLED", "backup export was cancelled", true);
        const chunkDigest = await backupSha256Hex(chunk);
        const partKey = `backup-parts/${epochId}/${bundle.name}/${String(n).padStart(6, "0")}-${chunkDigest}`;
        const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(chunk.slice()); c.close(); } });
        let receipt;
        try {
          receipt = await ports.part_sink.putImmutable({ key: partKey, body: stream, expected_sha256: chunkDigest, expected_size_bytes: chunk.byteLength, content_type: "application/jsonl", custom_metadata: { backup_epoch: epochId, backup_manifest: bundle.name, backup_part_index: String(n), backup_part_sha256: chunkDigest, backup_vector_digest: vectorDigest } });
        } catch (cause) {
          failBackup("BACKUP_PART_WRITE_FAILED", "backup part write failed", true, { manifest: bundle.name }, cause);
        }
        if (receipt.existed_identically) reconciled = true;
        partIndex.push({ manifest: bundle.name, index: n, part_key: partKey, sha256: chunkDigest, size_bytes: chunk.byteLength, etag: receipt.etag, existed_identically: receipt.existed_identically });
      }
    }
    for (const part of partIndex) {
      const reopened = await ports.part_sink.open(part.part_key);
      if (reopened === null) failBackup("BACKUP_PART_READBACK_MISMATCH", "backup part is absent on audit readback", false, { manifest: part.manifest });
      const hash = await hashBackupStream(reopened.body, part.size_bytes, ports.create_sha256_sink);
      if (hash.sha256 !== part.sha256 || hash.size_bytes !== part.size_bytes) failBackup("BACKUP_PART_READBACK_MISMATCH", "backup part digest disagrees on audit readback", false, { manifest: part.manifest });
    }
    const reread = await freezeVector(signal);
    const rereadTally = freshBackupR2Tally();
    const rereadEvidence = await snapshotBackupR2Bucket(ports.evidence_bucket, "evidence", limits, ports.create_sha256_sink, rereadTally, signal);
    const rereadWork = await snapshotBackupR2Bucket(ports.work_bucket, "work", limits, ports.create_sha256_sink, rereadTally, signal);
    const rereadR2Digest = await backupSha256Hex([...rereadEvidence.entries, ...rereadWork.entries]
      .sort((l, r) => (`${l.bucket}\u0000${l.key}` < `${r.bucket}\u0000${r.key}` ? -1 : 1))
      .map((e) => canonicalBackupJson(e)).join("\n"));
    const drifted: string[] = [];
    for (const name of Object.keys(vector.tables).sort()) {
      const l = vector.tables[name]; const r = reread.vector.tables[name];
      if (l?.digest !== r?.digest || l?.count !== r?.count) drifted.push(name);
    }
    if (reread.vector.schema_generation !== vector.schema_generation) drifted.push("schema_state");
    if (reread.vector.migration_ledger_digest !== vector.migration_ledger_digest) drifted.push("d1_migrations");
    if (reread.vector.purge_frontier !== vector.purge_frontier || reread.vector.purge_digest !== vector.purge_digest) drifted.push("purge_ledger");
    if (rereadR2Digest !== r2Digest) drifted.push("r2-objects");
    if (drifted.length > 0) failBackup("BACKUP_VECTOR_DRIFT", "backup authority vector drifted during export; epoch withheld as stale", true, { drifted: drifted.sort().join(",") });
    const draft: BackupEpochDraft = {
      epoch_id: epochId, schema_generation: vector.schema_generation,
      migration_ledger_digest: vector.migration_ledger_digest,
      manifest_digests: manifestDigests, group_digests: groupDigests, part_index: partIndex,
      purge_ledger_revision: vector.purge_frontier, purge_ledger_digest: vector.purge_digest,
      r2_object_count: r2Entries.length, r2_total_bytes: r2TotalBytes,
      audit_sample_receipt_ref: `audit-${epochId}-v${vectorDigest.slice(0, 16)}-p${partIndex.length}`,
      vector_digest: vectorDigest, vector_manifest_digest: vectorManifestDigest,
      created_at: now, expires_at: backupIsoDateTime(nowMs + retentionDays * 86_400_000),
    };
    const attempt = backupAttempt(intent, attemptNumber, "SUCCEEDED", now);
    const provisional = backupReceipt(intent, attempt.attempt_id, "SUCCEEDED",
      [epochId], [draft.audit_sample_receipt_ref, ...partIndex.map((p) => p.etag)], reconciled,
      reconciled ? ["RESUMED_PARTS"] : [], now);
    const claimed = await claimEpochReceipt(ports.core_db,
      { idempotency_key: intent.idempotency_key, intent_id: intent.intent_ref.id, vector_digest: vectorDigest, manifest_digest: manifestDigest, epoch_id: epochId },
      provisional, now);
    const finalReceipt = claimed.replayed
      ? backupReceipt(intent, attempt.attempt_id, "DUPLICATE", [epochId], [draft.audit_sample_receipt_ref, ...partIndex.map((p) => p.etag)], true, ["REPLAY"], now)
      : provisional;
    if (claimed.replayed) {
      if (claimed.receipt.output_refs[0] !== epochId) failBackup("BACKUP_INTENT_CONFLICT", "backup replay resolves to a divergent epoch", false, { intent_id: intent.intent_ref.id });
    }
    return { draft, attempt, receipt: finalReceipt, vector_digest: vectorDigest };
  }

  return { createPortableEpoch };
}

export async function reopenPersistedVector(ports: BackupSourcePorts, draft: BackupEpochDraft): Promise<AuthorityVector> {
  const parts = draft.part_index.filter((p) => p.manifest === "vector").sort((a, b) => a.index - b.index);
  if (parts.length === 0) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup epoch carries no persisted vector part");
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const reopened = await ports.part_sink.open(part.part_key);
    if (reopened === null) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "persisted vector part is absent");
    chunks.push(new Uint8Array(await new Response(reopened.body as ReadableStream<Uint8Array>).arrayBuffer()));
  }
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  const text = new TextDecoder().decode(joined);
  const line = text.split("\n").filter((l) => l.length > 0)[0] ?? "";
  let parsed: { readonly vector?: unknown; readonly vector_digest?: unknown };
  try {
    parsed = JSON.parse(line) as { readonly vector?: unknown; readonly vector_digest?: unknown };
  } catch (cause) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "persisted vector is not valid JSON", false, {}, cause);
  }
  const digest = await backupSha256Hex(canonicalBackupJson(parsed.vector));
  if (digest !== draft.vector_digest || digest !== parsed.vector_digest) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "persisted vector digest disagrees with the epoch binding");
  return parsed.vector as AuthorityVector;
}
