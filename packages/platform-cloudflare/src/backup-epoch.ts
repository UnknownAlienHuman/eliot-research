import type { OperationAttempt, OperationIntent, OperationReceipt } from "@eliotr/contracts";
import { hashReadableStream } from "./r2.js";
import type { EvidenceObjectStore, Sha256DigestSinkFactory } from "./r2.js";
import {
  backupAborted,
  backupAttempt,
  backupIsoDateTime,
  backupReceipt,
  backupSha256Hex,
  canonicalBackupJson,
  failBackup,
  resolveBackupExportLimits,
  assertBackupIntent,
  type BackupExportLimits,
} from "./backup-shared.js";

// ER-34 O2 epoch export: portable coherent BackupEpoch drafts over injected
// real D1+R2 ports. O2 is IMPLEMENTED_NOT_LIVE; O3 restore and O4 purge
// replay stay NOT_IMPLEMENTED. D1 Search, AI Search, Queue, Workflow and
// Durable Object state are recorded only as rebuild refs; D1 Time Travel
// alone is never treated as a backup. All SQL here is read-only snapshots.

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

export interface SnapshotRow {
  readonly table: string;
  readonly row: Readonly<Record<string, unknown>>;
}

interface ManifestBundle {
  readonly name: string;
  readonly jsonl: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly digest: string;
}

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
  const ordered = [...rows].sort((left, right) => {
    const leftKey = canonicalBackupJson(left.row);
    const rightKey = canonicalBackupJson(right.row);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous !== undefined && current !== undefined && canonicalBackupJson(previous.row) === canonicalBackupJson(current.row)) {
      failBackup("BACKUP_ROW_INVALID", `backup table ${spec.table} contains a duplicate row`, false, { table: spec.table });
    }
  }
  for (const row of ordered) {
    for (const [column, value] of Object.entries(row.row)) {
      if (typeof value === "string" && column.endsWith("_json")) {
        try {
          JSON.parse(value);
        } catch {
          failBackup("BACKUP_ROW_INVALID", `backup row ${spec.table}.${column} is not valid JSON`, false, { table: spec.table, column });
        }
      }
    }
  }
  return ordered;
}

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
  const names = rows.map((row, index) => {
    if (typeof row?.name !== "string" || row.name.length === 0) failBackup("BACKUP_ROW_INVALID", `backup migration ledger row ${index} is malformed`, false, {});
    return row.name;
  }).sort();
  return { names, explicit_absent: false };
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
  const rows: SnapshotRow[] = raw.map((input, index) => {
    const record = input as Record<string, unknown>;
    if (typeof record["ledger_revision"] !== "number" || !Number.isSafeInteger(record["ledger_revision"]) || (record["ledger_revision"] as number) < 1) {
      failBackup("BACKUP_ROW_INVALID", `backup purge ledger row ${index} has an invalid revision`, false, {});
    }
    if (typeof record["non_revealing_subject_digest"] !== "string" || !SHA256.test(record["non_revealing_subject_digest"] as string)) {
      failBackup("BACKUP_ROW_INVALID", `backup purge ledger row ${index} has an invalid subject digest`, false, {});
    }
    if (record["disposition"] !== "COMPLETE" && record["disposition"] !== "BLOCKED") {
      failBackup("BACKUP_ROW_INVALID", `backup purge ledger row ${index} has an unknown disposition`, false, {});
    }
    return { table: "purge_ledger", row: input as Readonly<Record<string, unknown>> };
  });
  let frontier = 0;
  for (const row of rows) {
    const revision = row.row["ledger_revision"];
    if (typeof revision === "number" && revision > frontier) frontier = revision;
  }
  return { rows, frontier, digest: await backupSha256Hex(rows.map((row) => canonicalBackupJson(row.row)).join("\n")) };
}

export interface R2ObjectEntry {
  readonly bucket: "evidence" | "work";
  readonly key: string;
  readonly size_bytes: number;
  readonly etag: string;
  readonly version: string;
  readonly sha256: string;
  readonly admitted_sha256: string | null;
  readonly metadata_digest: string;
}

export interface BackupR2Tally {
  keys: number;
  bytes: number;
}

export function freshBackupR2Tally(): BackupR2Tally {
  return { keys: 0, bytes: 0 };
}

export async function snapshotBackupR2Bucket(bucket: R2Bucket, label: "evidence" | "work", limits: BackupExportLimits, createSink: Sha256DigestSinkFactory | undefined, tally: BackupR2Tally, signal?: AbortSignal): Promise<{ readonly entries: readonly R2ObjectEntry[]; readonly fingerprint: string }> {
  const entries: R2ObjectEntry[] = [];
  let pages = 0;
  let cursor: string | undefined;
  for (;;) {
    if (backupAborted(signal)) failBackup("BACKUP_CANCELLED", "backup export was cancelled", true);
    pages += 1;
    if (pages > limits.max_r2_pages) failBackup("BACKUP_BOUND_EXCEEDED", `backup R2 ${label} listing exceeds its page bound`, false, { bucket: label, limit: String(limits.max_r2_pages) });
    let page: R2Objects;
    try {
      page = await bucket.list({ limit: limits.r2_list_page_size, include: ["customMetadata", "httpMetadata"], ...(cursor === undefined ? {} : { cursor }) });
    } catch (cause) {
      failBackup("BACKUP_OBJECT_UNREADABLE", `backup R2 ${label} listing is unavailable`, true, { bucket: label }, cause);
    }
    for (const object of page.objects) {
      if (tally.keys >= limits.max_r2_keys) failBackup("BACKUP_BOUND_EXCEEDED", `backup R2 ${label} objects exceed the key bound`, false, { bucket: label, limit: String(limits.max_r2_keys) });
      if (object.size > limits.max_object_bytes) failBackup("BACKUP_BOUND_EXCEEDED", "backup R2 object exceeds the per-object byte bound", false, { bucket: label, limit: String(limits.max_object_bytes) });
      tally.bytes += object.size;
      if (tally.bytes > limits.max_total_object_bytes) failBackup("BACKUP_BOUND_EXCEEDED", `backup R2 ${label} objects exceed the total byte bound`, false, { bucket: label, limit: String(limits.max_total_object_bytes) });
      let body: R2ObjectBody | null;
      try {
        body = await bucket.get(object.key);
      } catch (cause) {
        failBackup("BACKUP_OBJECT_UNREADABLE", "backup R2 object read is unavailable", true, { bucket: label }, cause);
      }
      if (body === null) failBackup("BACKUP_OBJECT_UNREADABLE", "backup R2 object vanished during export", true, { bucket: label });
      const hash = await hashReadableStream(body.body, object.size, createSink);
      if (hash.size_bytes !== object.size) failBackup("BACKUP_OBJECT_UNREADABLE", "backup R2 object truncated during readback", false, { bucket: label });
      const metadata = body.customMetadata ?? {};
      const admitted = metadata["eliotr_sha256"];
      if (admitted !== undefined && admitted !== hash.sha256) failBackup("BACKUP_OBJECT_DIGEST_MISMATCH", "backup R2 object digest disagrees with its admitted digest", false, { bucket: label });
      if (typeof admitted === "string" && !SHA256.test(admitted)) failBackup("BACKUP_OBJECT_DIGEST_MISMATCH", "backup R2 object carries a malformed admitted digest", false, { bucket: label });
      entries.push({ bucket: label, key: object.key, size_bytes: object.size, etag: object.etag, version: object.version, sha256: hash.sha256, admitted_sha256: typeof admitted === "string" ? admitted : null, metadata_digest: await backupSha256Hex(canonicalBackupJson(metadata)) });
      tally.keys += 1;
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  const ordered = [...entries].sort((left, right) => {
    const leftKey = `${left.bucket}\u0000${left.key}`;
    const rightKey = `${right.bucket}\u0000${right.key}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return { entries: ordered, fingerprint: await backupSha256Hex(ordered.map((entry) => canonicalBackupJson(entry)).join("\n")) };
}

async function buildManifest(name: string, lines: readonly string[], maxBytes: number): Promise<ManifestBundle> {
  const jsonl = lines.join("\n");
  const bytes = new TextEncoder().encode(jsonl);
  if (bytes.byteLength > maxBytes) failBackup("BACKUP_BOUND_EXCEEDED", `backup manifest ${name} exceeds its byte bound`, false, { manifest: name, limit: String(maxBytes) });
  return { name, jsonl, bytes, digest: await backupSha256Hex(bytes) };
}

export interface BackupSourcePorts {
  readonly core_db: D1Database;
  readonly evidence_bucket: R2Bucket;
  readonly work_bucket: R2Bucket;
  readonly part_sink: EvidenceObjectStore;
  readonly create_sha256_sink?: Sha256DigestSinkFactory;
}

export interface BackupPartRef {
  readonly manifest: string;
  readonly index: number;
  readonly part_key: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly etag: string;
  readonly existed_identically: boolean;
}

export interface BackupEpochDraft {
  readonly epoch_id: string;
  readonly schema_generation: string;
  readonly migration_ledger_digest: string;
  readonly manifest_digests: Readonly<Record<string, string>>;
  readonly group_digests: Readonly<Record<string, string>>;
  readonly part_index: readonly BackupPartRef[];
  readonly purge_ledger_revision: number;
  readonly purge_ledger_digest: string;
  readonly r2_object_count: number;
  readonly r2_total_bytes: number;
  readonly audit_sample_receipt_ref: string;
  readonly created_at: string;
  readonly expires_at: string;
}

export interface BackupEpochResult {
  readonly draft: BackupEpochDraft;
  readonly attempt: OperationAttempt;
  readonly receipt: OperationReceipt;
  readonly vector_digest: string;
}

interface IntentRecord {
  readonly intent_id: string;
  readonly vector_digest: string;
  readonly manifest_digest: string;
  readonly epoch_id: string;
}

const MANIFEST_NAMES = ["schema", "ownership", "sources", "revisions", "projects", "scopes", "handles", "heads", "generations", "retention", "purge", "r2-objects", "rebuild"];

export interface BackupEpochPort {
  createPortableEpoch(intent: OperationIntent, context?: BackupExportContext): Promise<BackupEpochResult>;
}

export function createBackupEpochPort(ports: BackupSourcePorts, overrides?: { readonly limits?: Partial<BackupExportLimits> }): BackupEpochPort {
  const limits = resolveBackupExportLimits(overrides?.limits);
  const registry = new Map<string, IntentRecord>();

  async function freezeVector(signal?: AbortSignal): Promise<{ readonly vector: AuthorityVector; readonly rows: readonly SnapshotRow[]; readonly purge_rows: readonly SnapshotRow[] }> {
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
      rows,
      purge_rows: purge.rows,
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
    const r2Entries = [...evidence.entries, ...work.entries].sort((left, right) => {
      const leftKey = `${left.bucket}\u0000${left.key}`;
      const rightKey = `${right.bucket}\u0000${right.key}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    const r2TotalBytes = r2Entries.reduce((sum, entry) => sum + entry.size_bytes, 0);
    const r2Digest = await backupSha256Hex(r2Entries.map((entry) => canonicalBackupJson(entry)).join("\n"));
    const vector: AuthorityVector = { ...frozen.vector, r2_keys: r2Entries.length, r2_bytes: r2TotalBytes, r2_digest: r2Digest };
    const vectorDigest = await backupSha256Hex(canonicalBackupJson(vector));

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
    const investigationHeads = new Map<string, number>();
    for (const row of frozen.rows) {
      if (row.table !== "investigation") continue;
      const id = row.row["investigation_id"];
      const revision = row.row["revision"];
      if (typeof id !== "string" || typeof revision !== "number") continue;
      if (revision > (investigationHeads.get(id) ?? 0)) investigationHeads.set(id, revision);
    }
    for (const [id, head] of [...investigationHeads.entries()].sort()) record("heads", canonicalBackupJson({ kind: "investigation", id, head_revision: head }));
    record("rebuild", canonicalBackupJson({ kind: "d1-search", source: "search-db", status: "REBUILD_REQUIRED" }));
    record("rebuild", canonicalBackupJson({ kind: "ai-search", source: "managed-index", status: "REBUILD_REQUIRED" }));
    record("rebuild", canonicalBackupJson({ kind: "queue", source: "queue-transient", status: "REBUILD_REQUIRED" }));
    record("rebuild", canonicalBackupJson({ kind: "workflow", source: "workflow-transient", status: "REBUILD_REQUIRED" }));
    record("rebuild", canonicalBackupJson({ kind: "durable-object", source: "do-transient", status: "TRANSIENT_EXCLUDED" }));
    record("rebuild", canonicalBackupJson({ kind: "d1-time-travel", status: "NOT_A_BACKUP" }));
    record("schema", canonicalBackupJson({ schema_generation: vector.schema_generation, migration_ledger_digest: vector.migration_ledger_digest, migration_ledger: vector.migration_names.length === 0 ? "ABSENT" : "PRESENT", migration_count: vector.migration_names.length }));
    record("purge", canonicalBackupJson({ purge_frontier: vector.purge_frontier, purge_digest: vector.purge_digest }));
    record("r2-objects", canonicalBackupJson({ object_count: r2Entries.length, total_bytes: r2TotalBytes, fingerprint: r2Digest }));
    for (const entry of r2Entries) record("r2-objects", canonicalBackupJson(entry));

    const bundles: { name: string; jsonl: string; bytes: Uint8Array<ArrayBuffer>; digest: string }[] = [];
    for (const name of MANIFEST_NAMES) bundles.push(await buildManifest(name, (byManifest.get(name) ?? []).sort(), limits.max_manifest_bytes));
    const manifestDigests: Record<string, string> = {};
    for (const bundle of bundles) manifestDigests[bundle.name] = bundle.digest;
    const group = async (members: readonly string[]): Promise<string> => backupSha256Hex(members.map((member) => `${member}:${manifestDigests[member] ?? "ABSENT"}`).sort().join("\n"));
    const groupDigests: Record<string, string> = { core: await group(["schema", "ownership", "sources", "revisions", "projects", "scopes", "handles", "retention", "purge"]), heads: await group(["heads"]), generations: await group(["generations"]), r2: await group(["r2-objects"]) };
    const manifestDigest = await backupSha256Hex(Object.entries(manifestDigests).sort().map(([name, digest]) => `${name}:${digest}`).join("\n"));
    const epochId = `epoch-${(await backupSha256Hex(`backup-epoch\u0000${intent.intent_ref.id}\u0000${vectorDigest}\u0000${manifestDigest}`)).slice(0, 48)}`;

    const prior = registry.get(intent.idempotency_key);
    if (prior !== undefined && (prior.intent_id !== intent.intent_ref.id || prior.vector_digest !== vectorDigest || prior.manifest_digest !== manifestDigest)) {
      failBackup("BACKUP_INTENT_CONFLICT", "backup intent reuses an identity with divergent content", false, { intent_id: intent.intent_ref.id });
    }

    const partIndex: BackupPartRef[] = [];
    let reconciled = false;
    for (const bundle of bundles) {
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      for (let offset = 0; offset < bundle.bytes.byteLength; offset += limits.part_bytes) chunks.push(bundle.bytes.slice(offset, offset + limits.part_bytes));
      if (chunks.length === 0) chunks.push(new Uint8Array());
      let chunkNumber = 0;
      for (const chunk of chunks) {
        chunkNumber += 1;
        if (backupAborted(signal)) failBackup("BACKUP_CANCELLED", "backup export was cancelled", true);
        const chunkDigest = await backupSha256Hex(chunk);
        const partKey = `backup-parts/${epochId}/${bundle.name}/${String(chunkNumber).padStart(6, "0")}-${chunkDigest}`;
        const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(chunk.slice()); controller.close(); } });
        let receipt;
        try {
          receipt = await ports.part_sink.putImmutable({ key: partKey, body: stream, expected_sha256: chunkDigest, expected_size_bytes: chunk.byteLength, content_type: "application/jsonl", custom_metadata: { backup_epoch: epochId, backup_manifest: bundle.name, backup_part_index: String(chunkNumber), backup_part_sha256: chunkDigest } });
        } catch (cause) {
          failBackup("BACKUP_PART_WRITE_FAILED", "backup part write failed", true, { manifest: bundle.name }, cause);
        }
        if (receipt.existed_identically) reconciled = true;
        partIndex.push({ manifest: bundle.name, index: chunkNumber, part_key: partKey, sha256: chunkDigest, size_bytes: chunk.byteLength, etag: receipt.etag, existed_identically: receipt.existed_identically });
      }
    }

    for (const part of partIndex) {
      const reopened = await ports.part_sink.open(part.part_key);
      if (reopened === null) failBackup("BACKUP_PART_READBACK_MISMATCH", "backup part is absent on audit readback", false, { manifest: part.manifest });
      const hash = await hashReadableStream(reopened.body, part.size_bytes, ports.create_sha256_sink);
      if (hash.sha256 !== part.sha256 || hash.size_bytes !== part.size_bytes) failBackup("BACKUP_PART_READBACK_MISMATCH", "backup part digest disagrees on audit readback", false, { manifest: part.manifest });
    }

    // Re-read the authority vector after all external R2/part work. Any
    // concurrent drift invalidates the export: explicit stale, never mixed.
    const reread = await freezeVector(signal);
    const rereadTally = freshBackupR2Tally();
    const rereadEvidence = await snapshotBackupR2Bucket(ports.evidence_bucket, "evidence", limits, ports.create_sha256_sink, rereadTally, signal);
    const rereadWork = await snapshotBackupR2Bucket(ports.work_bucket, "work", limits, ports.create_sha256_sink, rereadTally, signal);
    const rereadR2Digest = await backupSha256Hex([...rereadEvidence.entries, ...rereadWork.entries]
      .sort((left, right) => (`${left.bucket}\u0000${left.key}` < `${right.bucket}\u0000${right.key}` ? -1 : 1))
      .map((entry) => canonicalBackupJson(entry)).join("\n"));
    const drifted: string[] = [];
    for (const name of Object.keys(vector.tables).sort()) {
      const left = vector.tables[name];
      const right = reread.vector.tables[name];
      if (left?.digest !== right?.digest || left?.count !== right?.count) drifted.push(name);
    }
    if (reread.vector.schema_generation !== vector.schema_generation) drifted.push("schema_state");
    if (reread.vector.migration_ledger_digest !== vector.migration_ledger_digest) drifted.push("d1_migrations");
    if (reread.vector.purge_frontier !== vector.purge_frontier || reread.vector.purge_digest !== vector.purge_digest) drifted.push("purge_ledger");
    if (rereadR2Digest !== r2Digest) drifted.push("r2-objects");
    if (drifted.length > 0) failBackup("BACKUP_VECTOR_DRIFT", "backup authority vector drifted during export; epoch withheld as stale", true, { drifted: drifted.sort().join(",") });

    const draft: BackupEpochDraft = {
      epoch_id: epochId,
      schema_generation: vector.schema_generation,
      migration_ledger_digest: vector.migration_ledger_digest,
      manifest_digests: manifestDigests,
      group_digests: groupDigests,
      part_index: partIndex,
      purge_ledger_revision: vector.purge_frontier,
      purge_ledger_digest: vector.purge_digest,
      r2_object_count: r2Entries.length,
      r2_total_bytes: r2TotalBytes,
      audit_sample_receipt_ref: `audit-${epochId}-p${partIndex.length}`,
      created_at: now,
      expires_at: backupIsoDateTime(nowMs + retentionDays * 86_400_000),
    };
    registry.set(intent.idempotency_key, { intent_id: intent.intent_ref.id, vector_digest: vectorDigest, manifest_digest: manifestDigest, epoch_id: epochId });
    const attempt = backupAttempt(intent, attemptNumber, "SUCCEEDED", now);
    const receipt = backupReceipt(intent, attempt.attempt_id, prior === undefined ? "SUCCEEDED" : "DUPLICATE",
      [epochId], [draft.audit_sample_receipt_ref, ...partIndex.map((part) => part.etag)], reconciled,
      prior === undefined ? (reconciled ? ["RESUMED_PARTS"] : []) : ["REPLAY"], now);
    return { draft, attempt, receipt, vector_digest: vectorDigest };
  }

  return { createPortableEpoch };
}
