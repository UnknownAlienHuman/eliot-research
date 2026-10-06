import type { OperationIntent, OperationReceipt, OperationAttempt } from "@eliotr/contracts";
import {
  backupAborted, backupAttempt, backupIsoDateTime, backupReceipt, backupSha256Hex,
  canonicalBackupJson, failBackup, resolveBackupExportLimits, assertBackupIntent,
  bufferBackupStream, hashBackupStream, type BackupExportLimits, type EvidenceObjectStore, type Sha256DigestSinkFactory,
} from "./shared.js";
import { assertExhaustiveTableCoverage, listDurableTables } from "./coverage.js";
import {
  BACKUP_R2_PAYLOAD_PROTOCOL, backupR2ObjectIdentity, freshBackupR2Tally,
  normalizeBackupR2CustomMetadata, normalizeBackupR2HttpMetadata, snapshotBackupR2Bucket,
  type R2ObjectEntry,
} from "./r2-inventory.js";
import { claimEpochReceipt, peekEpochReplay } from "./replay-authority.js";
import { replayPersistedEpoch } from "./epoch-replay-result.js";
import {
  abandonBackupEpochProducerWithoutWrites, admitBackupEpochProducer, assertBackupEpochProducerWriteOwner,
  commitBackupEpochProducer, markBackupEpochProducerUnknown, pinBackupEpochProducerForWrites,
  type BackupEpochProducerOwner, type BackupEpochProducerPins,
} from "./epoch-producer-fence.js";
import { planBackupEpoch, cutInputsFor } from "./epoch-plan.js";
import {
  BACKUP_MANIFEST_PROTOCOL, assertExportColumnCoverage, assertCoreTableMigrationPresence,
  coreTableSpecsForMigrationNames, digestCoreColumnInventory, openExportCut, readCoreColumnInventory, sealExportCut,
  type CoreTableInventory, type OpenCut, type TableSpec,
} from "./coherent-cut.js";

// ER-34 O2 FIX2 portable epoch. IMPLEMENTED_NOT_LIVE. Coherent-cut: phase-1
// freeze opens a controller-owned cut token binding D1 tables/schema/
// migration/purge state plus the R2 inventory generation to the same cut;
// phase-2 re-verification seals it, and any observable inter-phase divergence
// withholds the epoch as stale. The complete authority vector is persisted as
// a content-addressed `vector` manifest; its digest is bound into the epoch.
//
// Replay: the canonical full intent digest binds principal, payload, policy
// decision, timestamps, revisions, vector/manifest and epoch identity. The
// persisted bytes are pre-checked BEFORE any part write: exact replay returns
// the persisted draft/attempt/receipt verbatim with zero new side effects,
// and any same-key divergence conflicts with zero new side effects.

const SHA256 = /^[a-f0-9]{64}$/u;

export interface BackupExportContext {
  readonly attempt_number?: number;
  readonly signal?: AbortSignal;
  readonly retention_days?: number;
  readonly now_ms?: number;
}

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
export interface BackupPayloadPartRef {
  readonly object_identity_digest: string;
  readonly index: number;
  readonly count: number;
  readonly part_key: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly etag: string;
  readonly existed_identically: boolean;
}
export interface BackupEpochDraft {
  readonly epoch_id: string; readonly schema_generation: string;
  readonly migration_ledger_digest: string;
  readonly manifest_digests: Readonly<Record<string, string>>;
  readonly group_digests: Readonly<Record<string, string>>;
  readonly part_index: readonly BackupPartRef[];
  /** Missing fields identify pre-payload legacy epochs; restore must reject those explicitly. */
  readonly r2_payload_protocol?: typeof BACKUP_R2_PAYLOAD_PROTOCOL;
  readonly payload_part_index?: readonly BackupPayloadPartRef[];
  readonly purge_ledger_revision: number; readonly purge_ledger_digest: string;
  readonly r2_object_count: number; readonly r2_total_bytes: number;
  readonly audit_sample_receipt_ref: string;
  readonly vector_digest: string; readonly vector_manifest_digest: string;
  readonly cut_id: string; readonly manifest_protocol: string;
  readonly created_at: string; readonly expires_at: string;
}
export interface BackupEpochResult {
  readonly draft: BackupEpochDraft; readonly attempt: OperationAttempt;
  readonly receipt: OperationReceipt; readonly vector_digest: string;
}
export interface BackupEpochPort {
  createPortableEpoch(intent: OperationIntent, context?: BackupExportContext): Promise<BackupEpochResult>;
}

async function backupTableExists(database: D1Database, table: string): Promise<boolean> {
  try {
    const row = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1").bind(table).first<{ readonly name: unknown }>();
    return row !== null && row.name === table;
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", `backup authority read for ${table} is unavailable`, true, { table }, cause);
  }
}

function decodeCell(table: string, column: string, kind: string, value: unknown, index: number): unknown {
  const label = `${table}[${index}].${column}`;
  if (value === null) {
    if (kind === "text-or-null" || kind === "int-or-null" || kind === "real-or-null") return null;
    failBackup("BACKUP_ROW_INVALID", `backup row is missing load-bearing column ${label}`, false, { table, column });
  }
  if (kind === "text" || kind === "text-or-null") {
    if (typeof value !== "string") failBackup("BACKUP_ROW_INVALID", `backup row column ${label} is not text`, false, { table, column });
    return value;
  }
  if (kind === "real" || kind === "real-or-null") {
    if (typeof value !== "number" || !Number.isFinite(value)) failBackup("BACKUP_ROW_INVALID", `backup row column ${label} is not a finite real`, false, { table, column });
    return value;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) failBackup("BACKUP_ROW_INVALID", `backup row column ${label} is not a safe integer`, false, { table, column });
  return value;
}

async function readBackupTable(database: D1Database, spec: TableSpec, inventory: CoreTableInventory, maxRows: number, signal?: AbortSignal): Promise<readonly SnapshotRow[]> {
  if (backupAborted(signal)) failBackup("BACKUP_CANCELLED", "backup export was cancelled", true);
  if (!await backupTableExists(database, spec.table)) {
    if (spec.required) failBackup("BACKUP_TABLE_MISSING", `backup required table ${spec.table} is absent`, false, { table: spec.table });
    return [];
  }
  const columns = inventory.columns.map((column) => column.name);
  const columnKinds = Object.fromEntries(columns.map((column) => [column, spec.columns[column]]));
  if (columns.length === 0 || Object.values(columnKinds).some((kind) => kind === undefined)) {
    failBackup("BACKUP_COVERAGE_GAP", `backup table ${spec.table} has no complete live column inventory`, false, { table: spec.table });
  }
  let result: D1Result<Record<string, unknown>>;
  try {
    result = await database.prepare(`SELECT ${columns.join(", ")} FROM ${spec.table} ORDER BY ${spec.order_by} LIMIT ?1`).bind(maxRows + 1).all<Record<string, unknown>>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", `backup authority read for ${spec.table} failed`, true, { table: spec.table }, cause);
  }
  if (result.success !== true || !Array.isArray(result.results)) {
    failBackup("BACKUP_TABLE_MISSING", `backup authority inventory for ${spec.table} returned an incomplete result`, true, { table: spec.table });
  }
  const raw = result.results;
  if (raw.length > maxRows) failBackup("BACKUP_BOUND_EXCEEDED", `backup table ${spec.table} exceeds its row bound`, false, { table: spec.table, limit: String(maxRows) });
  const rows: SnapshotRow[] = raw.map((input, index) => {
    if (typeof input !== "object" || input === null || Array.isArray(input)) failBackup("BACKUP_ROW_INVALID", `backup row ${spec.table}[${index}] is not a record`, false, { table: spec.table });
    const row: Record<string, unknown> = {};
    for (const [column, kind] of Object.entries(columnKinds)) row[column] = decodeCell(spec.table, column, kind as string, (input as Record<string, unknown>)[column], index);
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

// Fail closed: the migration gate guarantees the ledger exists, so an empty
// ledger here is corruption, never "ABSENT".
async function readMigrationNames(database: D1Database, maxRows: number): Promise<readonly string[]> {
  let result: D1Result<Record<string, unknown>>;
  try {
    result = await database.prepare("SELECT name FROM d1_migrations ORDER BY name LIMIT ?1").bind(maxRows + 1).all<Record<string, unknown>>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup migration ledger read failed", true, {}, cause);
  }
  if (result.success !== true || !Array.isArray(result.results)) failBackup("BACKUP_TABLE_MISSING", "backup migration ledger returned an incomplete result", true);
  const rows = result.results;
  if (rows.length > maxRows) failBackup("BACKUP_BOUND_EXCEEDED", "backup migration ledger exceeds its row bound", false, { limit: String(maxRows) });
  if (rows.length === 0) failBackup("BACKUP_TABLE_MISSING", "backup migration ledger is empty; refusing ABSENT tolerance");
  return rows.map((row, i) => {
    if (typeof row?.name !== "string" || row.name.length === 0) failBackup("BACKUP_ROW_INVALID", `backup migration ledger row ${i} is malformed`, false, {});
    return row.name;
  }).sort();
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
  if (result.success !== true || !Array.isArray(result.results)) failBackup("BACKUP_TABLE_MISSING", "backup purge ledger returned an incomplete result", true);
  const raw = result.results;
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

export interface D1Snapshot {
  readonly table_specs: readonly TableSpec[];
  readonly vector_tables: Record<string, { count: number; digest: string }>;
  readonly rows: readonly SnapshotRow[];
  readonly purge_rows: readonly SnapshotRow[];
  readonly purge_frontier: number;
  readonly purge_digest: string;
  readonly schema_generation: string;
  readonly migration_names: readonly string[];
  readonly migration_ledger_digest: string;
  readonly inventory_digest: string;
  readonly column_inventory: readonly CoreTableInventory[];
}

export function createBackupEpochPort(ports: BackupSourcePorts, overrides?: { readonly limits?: Partial<BackupExportLimits> }): BackupEpochPort {
  const limits = resolveBackupExportLimits(overrides?.limits);

  async function snapshotD1(signal?: AbortSignal): Promise<D1Snapshot> {
    const existingTables = await listDurableTables(ports.core_db);
    assertExhaustiveTableCoverage(existingTables);
    const names = await readMigrationNames(ports.core_db, limits.max_table_rows);
    const tableSpecs = coreTableSpecsForMigrationNames(names);
    assertCoreTableMigrationPresence(existingTables, names);
    const specTables = tableSpecs.map((spec) => spec.table);
    const inventory = await readCoreColumnInventory(ports.core_db, specTables);
    assertExportColumnCoverage(inventory, tableSpecs);
    const inventoryByTable = new Map(inventory.map((entry) => [entry.table, entry]));
    const inventoryDigest = await digestCoreColumnInventory(inventory);
    const schemaGeneration = await readSchemaGeneration(ports.core_db);
    const migrationLedgerDigest = await backupSha256Hex(`migration-ledger\n${names.join("\n")}`);
    const rows: SnapshotRow[] = [];
    const tables: Record<string, { count: number; digest: string }> = {};
    for (const spec of tableSpecs) {
      const liveInventory = inventoryByTable.get(spec.table);
      if (liveInventory === undefined) failBackup("BACKUP_COVERAGE_GAP", `backup table ${spec.table} has no live schema inventory`, false, { table: spec.table });
      const tableRows = await readBackupTable(ports.core_db, spec, liveInventory, limits.max_table_rows, signal);
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
      table_specs: tableSpecs,
      vector_tables: tables, rows, purge_rows: purge.rows,
      purge_frontier: purge.frontier, purge_digest: purge.digest,
      schema_generation: schemaGeneration, migration_names: names,
      migration_ledger_digest: migrationLedgerDigest, inventory_digest: inventoryDigest,
      column_inventory: inventory,
    };
  }

  async function snapshotR2(signal?: AbortSignal): Promise<{ readonly entries: readonly R2ObjectEntry[]; readonly fingerprint: string; readonly total_bytes: number }> {
    const tally = freshBackupR2Tally();
    const evidence = await snapshotBackupR2Bucket(ports.evidence_bucket, "evidence", limits, ports.create_sha256_sink, tally, signal);
    const work = await snapshotBackupR2Bucket(ports.work_bucket, "work", limits, ports.create_sha256_sink, tally, signal);
    const entries = [...evidence.entries, ...work.entries].sort((l, r) => {
      const a = `${l.bucket}\u0000${l.key}`; const b = `${r.bucket}\u0000${r.key}`;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return {
      entries,
      fingerprint: await backupSha256Hex(entries.map((e) => canonicalBackupJson(e)).join("\n")),
      total_bytes: entries.reduce((s, e) => s + e.size_bytes, 0),
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
    const admission = await admitBackupEpochProducer(ports.core_db, intent, now);
    let frozen: D1Snapshot;
    let r2: Awaited<ReturnType<typeof snapshotR2>>;
    let plan: Awaited<ReturnType<typeof planBackupEpoch>>;
    try {
      // Durable CAPTURING admission precedes every source or R2 snapshot.
      frozen = await snapshotD1(signal);
      r2 = await snapshotR2(signal);
      const absentHeadTables: string[] = [];
      for (const table of ["publication", "federation_reference_manifest", "navigation_artifact"] as const) {
        if (!await backupTableExists(ports.core_db, table)) absentHeadTables.push(table);
      }
      plan = await planBackupEpoch({
        frozen, r2, intent, absentHeadTables, max_manifest_bytes: limits.max_manifest_bytes,
      });
    } catch (cause) {
      if (admission.mode === "OWNED_CAPTURE") {
        await abandonBackupEpochProducerWithoutWrites(ports.core_db, admission.owner, now).catch(() => undefined);
      }
      throw cause;
    }
    const { vector, vector_digest: vectorDigest, bundles, manifest_digests: manifestDigests,
      vector_manifest_digest: vectorManifestDigest, group_digests: groupDigests,
      manifest_digest: manifestDigest, epoch_id: epochId, intent_digest: intentDigest } = plan;
    const claim = {
      idempotency_key: intent.idempotency_key,
      intent_id: intent.intent_ref.id,
      intent_digest: intentDigest,
      vector_digest: vectorDigest,
      manifest_digest: manifestDigest,
      epoch_id: epochId,
    };
    // Replay pre-check BEFORE any part write: exact replay returns persisted
    // bytes with zero side effects; divergence conflicts with zero side effects.
    const peeked = await peekEpochReplay(ports.core_db, claim);
    if (peeked.state === "CONFLICT") {
      if (admission.mode === "OWNED_CAPTURE") await abandonBackupEpochProducerWithoutWrites(ports.core_db, admission.owner, now);
      failBackup("BACKUP_INTENT_CONFLICT", "backup intent reuses an identity with divergent content", false, { intent_id: intent.intent_ref.id });
    }
    if (peeked.state === "REPLAY") {
      if (admission.mode === "OWNED_CAPTURE") await abandonBackupEpochProducerWithoutWrites(ports.core_db, admission.owner, now);
      return replayPersistedEpoch(peeked.persisted, intent.idempotency_key, intent.intent_ref.id, epochId, vectorDigest);
    }
    if (admission.mode !== "OWNED_CAPTURE") {
      failBackup("BACKUP_INTENT_CONFLICT", "read-only backup replay authority has no exact persisted receipt", true);
    }
    const owner: BackupEpochProducerOwner = admission.owner;
    const pins: BackupEpochProducerPins = {
      epoch_id: epochId,
      part_prefix: `backup-parts/${epochId}/`,
      cut_id: plan.cut.cut_id,
      cut_digest: plan.cut.cut_digest,
      vector_digest: vectorDigest,
      manifest_digest: manifestDigest,
      intent_digest: intentDigest,
    };
    const pinResult = await pinBackupEpochProducerForWrites(ports.core_db, owner, pins, now);
    if (pinResult === "RECEIPT_PRESENT") {
      const latePeek = await peekEpochReplay(ports.core_db, claim);
      if (latePeek.state === "CONFLICT") {
        failBackup("BACKUP_INTENT_CONFLICT", "backup intent reuses an identity with divergent content", false, { intent_id: intent.intent_ref.id });
      }
      if (latePeek.state === "REPLAY") {
        return replayPersistedEpoch(latePeek.persisted, intent.idempotency_key, intent.intent_ref.id, epochId, vectorDigest);
      }
      failBackup("BACKUP_TABLE_MISSING", "backup receipt appeared during producer admission but no exact replay is readable", true);
    }
    try {
    const cut: OpenCut = await openExportCut(ports.core_db, plan.cut_inputs, now);
    if (!cut.inserted || cut.state !== "OPEN") {
      failBackup("BACKUP_INTENT_CONFLICT", "backup producer cannot adopt a pre-existing coherent cut", true, { cut: cut.cut_id });
    }
    if (cut.cut_id !== pins.cut_id || cut.cut_digest !== pins.cut_digest) {
      failBackup("BACKUP_VECTOR_DRIFT", "backup cut differs from the owner-pinned candidate", true);
    }
    const partIndex: BackupPartRef[] = [];
    const payloadPartIndex: BackupPayloadPartRef[] = [];
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
        await assertBackupEpochProducerWriteOwner(ports.core_db, owner, pins);
        try {
          receipt = await ports.part_sink.putImmutable({ key: partKey, body: stream, expected_sha256: chunkDigest, expected_size_bytes: chunk.byteLength, content_type: "application/jsonl", custom_metadata: { backup_epoch: epochId, backup_manifest: bundle.name, backup_part_index: String(n), backup_part_sha256: chunkDigest, backup_vector_digest: vectorDigest } });
        } catch (cause) {
          failBackup("BACKUP_PART_WRITE_FAILED", "backup part write failed", true, { manifest: bundle.name }, cause);
        }
        if (receipt.existed_identically) reconciled = true;
        partIndex.push({ manifest: bundle.name, index: n, part_key: partKey, sha256: chunkDigest, size_bytes: chunk.byteLength, etag: receipt.etag, existed_identically: receipt.existed_identically });
      }
    }
    // Payload bytes are copied only after the content-addressed epoch identity
    // is known. The initial and final R2 snapshots bind the inventory, metadata
    // and every deterministic chunk digest into the epoch vector. This second
    // source read must match that sealed plan before any payload part can be
    // referenced by the persisted draft.
    for (const entry of r2.entries) {
      if (backupAborted(signal)) failBackup("BACKUP_CANCELLED", "backup export was cancelled", true);
      const bucket = entry.bucket === "evidence" ? ports.evidence_bucket : ports.work_bucket;
      let body: R2ObjectBody | null;
      try { body = await bucket.get(entry.key); }
      catch (cause) { failBackup("BACKUP_OBJECT_UNREADABLE", "backup R2 payload read is unavailable", true, { bucket: entry.bucket }, cause); }
      if (body === null || body.size !== entry.size_bytes || body.etag !== entry.etag ||
          (body as unknown as { readonly version?: unknown }).version !== entry.version) {
        failBackup("BACKUP_VECTOR_DRIFT", "backup R2 payload changed after its inventory snapshot", true, { bucket: entry.bucket });
      }
      const customMetadata = normalizeBackupR2CustomMetadata(body.customMetadata, entry.bucket);
      const httpMetadata = normalizeBackupR2HttpMetadata((body as unknown as { readonly httpMetadata?: unknown }).httpMetadata, entry.bucket);
      if (await backupSha256Hex(canonicalBackupJson(customMetadata)) !== entry.metadata_digest ||
          await backupSha256Hex(canonicalBackupJson(httpMetadata)) !== entry.http_metadata_digest) {
        failBackup("BACKUP_VECTOR_DRIFT", "backup R2 payload metadata changed after its inventory snapshot", true, { bucket: entry.bucket });
      }
      const bytes = await bufferBackupStream(body.body, limits.max_object_bytes);
      if (bytes.byteLength !== entry.size_bytes || await backupSha256Hex(bytes) !== entry.sha256) {
        failBackup("BACKUP_VECTOR_DRIFT", "backup R2 payload bytes changed after its inventory snapshot", true, { bucket: entry.bucket });
      }
      const identity = await backupR2ObjectIdentity(entry);
      const chunks = entry.payload_parts;
      const expectedCount = chunks.length;
      if (expectedCount === 0) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup R2 payload plan contains no bounded parts", false, { bucket: entry.bucket });
      for (const chunk of chunks) {
        const partBytes = bytes.slice((chunk.index - 1) * limits.part_bytes, Math.min(bytes.byteLength, chunk.index * limits.part_bytes));
        if (partBytes.byteLength !== chunk.size_bytes || await backupSha256Hex(partBytes) !== chunk.sha256) {
          failBackup("BACKUP_VECTOR_DRIFT", "backup R2 payload chunk differs from the epoch inventory plan", true, { bucket: entry.bucket });
        }
        const partKey = `backup-parts/${epochId}/r2-payload/${identity}/${String(chunk.index).padStart(6, "0")}-${chunk.sha256}`;
        const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(partBytes.slice()); controller.close(); } });
        let receipt;
        await assertBackupEpochProducerWriteOwner(ports.core_db, owner, pins);
        try {
          receipt = await ports.part_sink.putImmutable({
            key: partKey, body: stream, expected_sha256: chunk.sha256, expected_size_bytes: chunk.size_bytes,
            content_type: "application/octet-stream",
            custom_metadata: {
              backup_epoch: epochId, backup_manifest: "r2-payload", backup_part_index: String(chunk.index),
              backup_part_count: String(expectedCount), backup_part_sha256: chunk.sha256,
              backup_vector_digest: vectorDigest, backup_object_identity_digest: identity,
            },
          });
        } catch (cause) {
          failBackup("BACKUP_PART_WRITE_FAILED", "backup R2 payload part write failed", true, { bucket: entry.bucket }, cause);
        }
        if (receipt.existed_identically) reconciled = true;
        payloadPartIndex.push({
          object_identity_digest: identity, index: chunk.index, count: expectedCount, part_key: partKey,
          sha256: chunk.sha256, size_bytes: chunk.size_bytes, etag: receipt.etag, existed_identically: receipt.existed_identically,
        });
      }
    }
    payloadPartIndex.sort((left, right) => left.object_identity_digest < right.object_identity_digest ? -1 :
      left.object_identity_digest > right.object_identity_digest ? 1 : left.index - right.index);
    for (const part of partIndex) {
      const reopened = await ports.part_sink.open(part.part_key);
      if (reopened === null) failBackup("BACKUP_PART_READBACK_MISMATCH", "backup part is absent on audit readback", false, { manifest: part.manifest });
      const hash = await hashBackupStream(reopened.body, part.size_bytes, ports.create_sha256_sink);
      if (hash.sha256 !== part.sha256 || hash.size_bytes !== part.size_bytes) failBackup("BACKUP_PART_READBACK_MISMATCH", "backup part digest disagrees on audit readback", false, { manifest: part.manifest });
    }
    for (const part of payloadPartIndex) {
      const reopened = await ports.part_sink.open(part.part_key);
      if (reopened === null) failBackup("BACKUP_PART_READBACK_MISMATCH", "backup R2 payload part is absent on audit readback", false, {});
      if (reopened.etag !== part.etag) failBackup("BACKUP_PART_READBACK_MISMATCH", "backup R2 payload part etag diverges on audit readback", false, {});
      const hash = await hashBackupStream(reopened.body, part.size_bytes, ports.create_sha256_sink);
      if (hash.sha256 !== part.sha256 || hash.size_bytes !== part.size_bytes) failBackup("BACKUP_PART_READBACK_MISMATCH", "backup R2 payload part digest disagrees on audit readback", false, {});
    }
    // Phase 2: re-verify D1 + R2 against the opened cut and seal it.
    const reread = await snapshotD1(signal);
    const rereadR2 = await snapshotR2(signal);
    const drifted: string[] = [];
    for (const name of Object.keys(vector.tables).sort()) {
      const l = vector.tables[name]; const r = reread.vector_tables[name];
      if (l?.digest !== r?.digest || l?.count !== r?.count) drifted.push(name);
    }
    if (reread.schema_generation !== vector.schema_generation) drifted.push("schema_state");
    if (reread.migration_ledger_digest !== vector.migration_ledger_digest) drifted.push("d1_migrations");
    if (reread.purge_frontier !== vector.purge_frontier || reread.purge_digest !== vector.purge_digest) drifted.push("purge_ledger");
    if (reread.inventory_digest !== frozen.inventory_digest) drifted.push("schema_inventory");
    if (rereadR2.fingerprint !== r2.fingerprint) drifted.push("r2-objects");
    if (drifted.length > 0) {
      await sealExportCut(ports.core_db, cut, { ...cutInputsFor(frozen, r2.fingerprint), r2_generation: rereadR2.fingerprint }, now).catch(() => undefined);
      failBackup("BACKUP_VECTOR_DRIFT", "backup authority vector drifted during export; epoch withheld as stale", true, { drifted: drifted.sort().join(",") });
    }
    await sealExportCut(ports.core_db, cut, cutInputsFor(reread, rereadR2.fingerprint), now);
    const draft: BackupEpochDraft = {
      epoch_id: epochId, schema_generation: vector.schema_generation,
      migration_ledger_digest: vector.migration_ledger_digest,
      manifest_digests: manifestDigests, group_digests: groupDigests, part_index: partIndex,
      r2_payload_protocol: BACKUP_R2_PAYLOAD_PROTOCOL, payload_part_index: payloadPartIndex,
      purge_ledger_revision: vector.purge_frontier, purge_ledger_digest: vector.purge_digest,
      r2_object_count: r2.entries.length, r2_total_bytes: r2.total_bytes,
      audit_sample_receipt_ref: `audit-${epochId}-v${vectorDigest.slice(0, 16)}-p${partIndex.length + payloadPartIndex.length}`,
      vector_digest: vectorDigest, vector_manifest_digest: vectorManifestDigest,
      cut_id: cut.cut_id, manifest_protocol: BACKUP_MANIFEST_PROTOCOL,
      created_at: now, expires_at: backupIsoDateTime(nowMs + retentionDays * 86_400_000),
    };
    const attempt = backupAttempt(intent, attemptNumber, "SUCCEEDED", now);
    const provisional = backupReceipt(intent, attempt.attempt_id, "SUCCEEDED",
      [epochId], [draft.audit_sample_receipt_ref, ...partIndex.map((p) => p.etag), ...payloadPartIndex.map((p) => p.etag)], reconciled,
      reconciled ? ["RESUMED_PARTS"] : [], now);
    const claimed = await claimEpochReceipt(ports.core_db, claim,
      { intent_digest: intentDigest, receipt_json: JSON.stringify(provisional), draft_json: JSON.stringify(draft), attempt_json: JSON.stringify(attempt) }, now);
    const persisted = claimed.persisted;
    if (persisted.intent_digest !== intentDigest) {
      failBackup("BACKUP_INTENT_CONFLICT", "persisted backup receipt intent differs from its producer pins", true);
    }
    await commitBackupEpochProducer(ports.core_db, owner, pins, {
      intent_id: intent.intent_ref.id,
      intent_digest: persisted.intent_digest,
      receipt_json: persisted.receipt_json,
      draft_json: persisted.draft_json,
      attempt_json: persisted.attempt_json,
    }, now);
    if (claimed.replayed) {
      // Lost race with an identical claim: the winner's persisted bytes are
      // authority. Anything divergent already failed the pre-check, so a
      // divergent race here is a conflict, never a synthesized receipt.
      return replayPersistedEpoch(claimed.persisted, intent.idempotency_key, intent.intent_ref.id, epochId, vectorDigest);
    }
    return { draft, attempt, receipt: provisional, vector_digest: vectorDigest };
    } catch (cause) {
      await markBackupEpochProducerUnknown(ports.core_db, owner, pins, now);
      throw cause;
    }
  }

  return { createPortableEpoch };
}

export async function reopenPersistedVector(ports: BackupSourcePorts, draft: BackupEpochDraft): Promise<AuthorityVector> {
  if (draft.manifest_protocol !== BACKUP_MANIFEST_PROTOCOL) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup epoch carries an unknown manifest protocol; refusing legacy promotion");
  }
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
  let parsed: { readonly protocol?: unknown; readonly vector?: unknown; readonly vector_digest?: unknown; readonly schema_inventory_digest?: unknown; readonly cut_id?: unknown };
  try {
    parsed = JSON.parse(line) as { readonly protocol?: unknown; readonly vector?: unknown; readonly vector_digest?: unknown; readonly schema_inventory_digest?: unknown; readonly cut_id?: unknown };
  } catch (cause) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "persisted vector is not valid JSON", false, {}, cause);
  }
  if (parsed.protocol !== BACKUP_MANIFEST_PROTOCOL) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "persisted vector carries an unknown manifest protocol");
  const digest = await backupSha256Hex(canonicalBackupJson(parsed.vector));
  if (digest !== draft.vector_digest || digest !== parsed.vector_digest) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "persisted vector digest disagrees with the epoch binding");
  return parsed.vector as AuthorityVector;
}
