import type { OperationIntent, OperationReceipt, OperationAttempt } from "@eliotr/contracts";
import {
  backupAborted, backupAttempt, backupIsoDateTime, backupReceipt, backupSha256Hex,
  canonicalBackupJson, failBackup, resolveBackupExportLimits, assertBackupIntent,
  hashBackupStream, type BackupExportLimits, type EvidenceObjectStore, type Sha256DigestSinkFactory,
} from "./shared.js";
import { assertExhaustiveTableCoverage, listDurableTables, rebuildManifestLines } from "./coverage.js";
import { freshBackupR2Tally, snapshotBackupR2Bucket } from "./r2-inventory.js";
import { claimEpochReceipt, peekEpochReplay, parsePersistedEpochReplay } from "./replay-authority.js";
import { assertO2MigrationAuthority } from "./migration-gate.js";
import { canonicalEpochIntentDigest } from "./intent-digest.js";
import {
  BACKUP_MANIFEST_PROTOCOL, TABLE_SPECS, assertExportColumnCoverage,
  digestCoreColumnInventory, openExportCut, readCoreColumnInventory, sealExportCut,
  type CutInputs, type OpenCut,
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

const MANIFEST_NAMES = ["schema", "schema-inventory", "ownership", "sources", "revisions", "projects", "scopes", "handles", "heads", "generations", "retention", "purge", "r2-objects", "rebuild", "vector"];

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

async function readBackupTable(database: D1Database, spec: (typeof TABLE_SPECS)[number], maxRows: number, signal?: AbortSignal): Promise<readonly SnapshotRow[]> {
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

// Fail closed: the migration gate guarantees the ledger exists, so an empty
// ledger here is corruption, never "ABSENT".
async function readMigrationNames(database: D1Database, maxRows: number): Promise<readonly string[]> {
  let result: D1Result<Record<string, unknown>>;
  try {
    result = await database.prepare("SELECT name FROM d1_migrations ORDER BY name LIMIT ?1").bind(maxRows + 1).all<Record<string, unknown>>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup migration ledger read failed", true, {}, cause);
  }
  const rows = result.results ?? [];
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

interface D1Snapshot {
  readonly vector_tables: Record<string, { count: number; digest: string }>;
  readonly rows: readonly SnapshotRow[];
  readonly purge_rows: readonly SnapshotRow[];
  readonly purge_frontier: number;
  readonly purge_digest: string;
  readonly schema_generation: string;
  readonly migration_names: readonly string[];
  readonly migration_ledger_digest: string;
  readonly inventory_digest: string;
}

export function createBackupEpochPort(ports: BackupSourcePorts, overrides?: { readonly limits?: Partial<BackupExportLimits> }): BackupEpochPort {
  const limits = resolveBackupExportLimits(overrides?.limits);

  async function snapshotD1(signal?: AbortSignal): Promise<D1Snapshot> {
    assertExhaustiveTableCoverage(await listDurableTables(ports.core_db));
    const specTables = TABLE_SPECS.map((spec) => spec.table);
    const inventory = await readCoreColumnInventory(ports.core_db, specTables);
    assertExportColumnCoverage(inventory, TABLE_SPECS);
    const inventoryDigest = await digestCoreColumnInventory(inventory);
    const schemaGeneration = await readSchemaGeneration(ports.core_db);
    const names = await readMigrationNames(ports.core_db, limits.max_table_rows);
    const migrationLedgerDigest = await backupSha256Hex(`migration-ledger\n${names.join("\n")}`);
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
      vector_tables: tables, rows, purge_rows: purge.rows,
      purge_frontier: purge.frontier, purge_digest: purge.digest,
      schema_generation: schemaGeneration, migration_names: names,
      migration_ledger_digest: migrationLedgerDigest, inventory_digest: inventoryDigest,
    };
  }

  async function snapshotR2(signal?: AbortSignal): Promise<{ readonly entries: { readonly bucket: "evidence" | "work"; readonly key: string }[]; readonly fingerprint: string; readonly total_bytes: number }> {
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

  function cutInputsFor(snap: D1Snapshot, r2Generation: string): CutInputs {
    return {
      schema_generation: snap.schema_generation,
      migration_ledger_digest: snap.migration_ledger_digest,
      table_digests: snap.vector_tables,
      purge_frontier: snap.purge_frontier,
      purge_digest: snap.purge_digest,
      r2_generation: r2Generation,
      schema_inventory_digest: snap.inventory_digest,
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
    await assertO2MigrationAuthority(ports.core_db);
    // Phase 1: freeze D1 + R2 into one cut and open the controller-owned token.
    const frozen = await snapshotD1(signal);
    const r2 = await snapshotR2(signal);
    const cut: OpenCut = await openExportCut(ports.core_db, cutInputsFor(frozen, r2.fingerprint), now);
    const vector: AuthorityVector = {
      schema_generation: frozen.schema_generation, migration_names: frozen.migration_names,
      migration_ledger_digest: frozen.migration_ledger_digest, tables: frozen.vector_tables,
      purge_frontier: frozen.purge_frontier, purge_digest: frozen.purge_digest,
      r2_keys: r2.entries.length, r2_bytes: r2.total_bytes, r2_digest: r2.fingerprint,
    };
    const vectorDigest = await backupSha256Hex(canonicalBackupJson(vector));
    const vectorManifestLine = canonicalBackupJson({ protocol: BACKUP_MANIFEST_PROTOCOL, vector, vector_digest: vectorDigest, schema_inventory_digest: frozen.inventory_digest, cut_id: cut.cut_id, cut_digest: cut.cut_digest });
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
    record("schema", canonicalBackupJson({ manifest_protocol: BACKUP_MANIFEST_PROTOCOL, schema_generation: vector.schema_generation, migration_ledger_digest: vector.migration_ledger_digest, migration_ledger: "PRESENT", migration_count: vector.migration_names.length }));
    record("schema-inventory", canonicalBackupJson({ protocol: BACKUP_MANIFEST_PROTOCOL, schema_inventory_digest: frozen.inventory_digest, cut_id: cut.cut_id }));
    for (const table of specManifest.keys()) {
      const columns = TABLE_SPECS.find((s) => s.table === table)?.columns ?? {};
      record("schema-inventory", canonicalBackupJson({ table, columns: Object.keys(columns).sort() }));
    }
    record("purge", canonicalBackupJson({ purge_frontier: vector.purge_frontier, purge_digest: vector.purge_digest }));
    record("r2-objects", canonicalBackupJson({ object_count: r2.entries.length, total_bytes: r2.total_bytes, fingerprint: r2.fingerprint }));
    for (const entry of r2.entries) record("r2-objects", canonicalBackupJson(entry));
    record("vector", vectorManifestLine);
    const bundles: { name: string; jsonl: string; bytes: Uint8Array<ArrayBuffer>; digest: string }[] = [];
    for (const name of MANIFEST_NAMES) bundles.push(await buildManifest(name, (byManifest.get(name) ?? []).sort(), limits.max_manifest_bytes));
    const manifestDigests: Record<string, string> = {};
    for (const bundle of bundles) manifestDigests[bundle.name] = bundle.digest;
    const vectorManifestDigest = manifestDigests["vector"] ?? "";
    const group = async (members: readonly string[]): Promise<string> => backupSha256Hex(members.map((m) => `${m}:${manifestDigests[m] ?? "ABSENT"}`).sort().join("\n"));
    const groupDigests: Record<string, string> = { core: await group(["schema", "schema-inventory", "ownership", "sources", "revisions", "projects", "scopes", "handles", "retention", "purge", "vector"]), heads: await group(["heads"]), generations: await group(["generations"]), r2: await group(["r2-objects"]) };
    const manifestDigest = await backupSha256Hex(Object.entries(manifestDigests).sort().map(([n, d]) => `${n}:${d}`).join("\n"));
    const epochId = `epoch-${(await backupSha256Hex(`backup-epoch\u0000${intent.intent_ref.id}\u0000${vectorDigest}\u0000${manifestDigest}`)).slice(0, 48)}`;
    const intentDigest = await canonicalEpochIntentDigest(intent, { vector_digest: vectorDigest, manifest_digest: manifestDigest, epoch_id: epochId });
    const claim = { idempotency_key: intent.idempotency_key, intent_id: intent.intent_ref.id, intent_digest: intentDigest, vector_digest: vectorDigest, manifest_digest: manifestDigest, epoch_id: epochId };
    // Replay pre-check BEFORE any part write: exact replay returns persisted
    // bytes with zero side effects; divergence conflicts with zero side effects.
    const peeked = await peekEpochReplay(ports.core_db, claim);
    if (peeked.state === "CONFLICT") failBackup("BACKUP_INTENT_CONFLICT", "backup intent reuses an identity with divergent content", false, { intent_id: intent.intent_ref.id });
    if (peeked.state === "REPLAY") {
      const replayed = parsePersistedEpochReplay(peeked.persisted, intent.idempotency_key);
      let draft: BackupEpochDraft;
      try {
        draft = JSON.parse(peeked.persisted.draft_json) as BackupEpochDraft;
      } catch (cause) {
        failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup persisted draft is corrupt", false, {}, cause);
      }
      if (draft.epoch_id !== epochId) failBackup("BACKUP_INTENT_CONFLICT", "backup replay resolves to a divergent epoch", false, { intent_id: intent.intent_ref.id });
      return { draft, attempt: replayed.attempt, receipt: replayed.receipt, vector_digest: vectorDigest };
    }
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
      purge_ledger_revision: vector.purge_frontier, purge_ledger_digest: vector.purge_digest,
      r2_object_count: r2.entries.length, r2_total_bytes: r2.total_bytes,
      audit_sample_receipt_ref: `audit-${epochId}-v${vectorDigest.slice(0, 16)}-p${partIndex.length}`,
      vector_digest: vectorDigest, vector_manifest_digest: vectorManifestDigest,
      cut_id: cut.cut_id, manifest_protocol: BACKUP_MANIFEST_PROTOCOL,
      created_at: now, expires_at: backupIsoDateTime(nowMs + retentionDays * 86_400_000),
    };
    const attempt = backupAttempt(intent, attemptNumber, "SUCCEEDED", now);
    const provisional = backupReceipt(intent, attempt.attempt_id, "SUCCEEDED",
      [epochId], [draft.audit_sample_receipt_ref, ...partIndex.map((p) => p.etag)], reconciled,
      reconciled ? ["RESUMED_PARTS"] : [], now);
    const claimed = await claimEpochReceipt(ports.core_db, claim,
      { intent_digest: intentDigest, receipt_json: JSON.stringify(provisional), draft_json: JSON.stringify(draft), attempt_json: JSON.stringify(attempt) }, now);
    if (claimed.replayed) {
      // Lost race with an identical claim: the winner's persisted bytes are
      // authority. Anything divergent already failed the pre-check, so a
      // divergent race here is a conflict, never a synthesized receipt.
      const winner = parsePersistedEpochReplay(claimed.persisted, intent.idempotency_key);
      let winnerDraft: BackupEpochDraft;
      try {
        winnerDraft = JSON.parse(claimed.persisted.draft_json) as BackupEpochDraft;
      } catch (cause) {
        failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup persisted draft is corrupt", false, {}, cause);
      }
      if (winnerDraft.epoch_id !== epochId) failBackup("BACKUP_INTENT_CONFLICT", "backup replay resolves to a divergent epoch", false, { intent_id: intent.intent_ref.id });
      return { draft: winnerDraft, attempt: winner.attempt, receipt: winner.receipt, vector_digest: vectorDigest };
    }
    return { draft, attempt, receipt: provisional, vector_digest: vectorDigest };
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
