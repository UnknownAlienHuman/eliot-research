import type { OperationIntent } from "@eliotr/contracts";
import { backupSha256Hex, canonicalBackupJson, failBackup } from "./shared.js";
import { canonicalProducerIntentDigest } from "./intent-digest.js";
import { assertO2MigrationAuthority, canonicalizeSchemaSql } from "./migration-gate.js";

export const BACKUP_PRODUCER_FENCE_MIGRATION = "0116_backup_epoch_producer_fence.sql";
// Digests bind the exact normalized migration and the producer/erasure DDL
// read back from SQLite; fixtures verify these values against the tracked SQL.
export const BACKUP_PRODUCER_FENCE_MIGRATION_SHA256 = "f5ca9a65411158aef794b934a0ea89f9c01453a06bdf2591b9b0427e6cacd9bc";
export const BACKUP_PRODUCER_FENCE_SCHEMA_SHA256 = "6bd894a59b88fc2b7ab5728c39dbda83cdc3564ac7affd1d28868ffb5c02b618";
export const BACKUP_PRODUCER_ERASURE_SCHEMA_SHA256 = "4b8d7fb3391f32a0403636876532735de148d77e1107d75647e7a4dcc1c00527";

const PRODUCER_TABLE = "backup_epoch_producer_claim";
const REQUIRED_LEDGER = [
  "0001_initial.sql", "0008_erasure_closure.sql", "0018_backup_o2_replay_authority.sql",
  "0019_backup_o2_replay_authority_fix.sql", BACKUP_PRODUCER_FENCE_MIGRATION, "0117_backup_erasure_primary_closure.sql",
] as const;
const PRODUCER_STATES = ["CAPTURING", "WRITING", "UNKNOWN", "COMMITTED", "ABANDONED_NO_WRITES"] as const;
const FINGERPRINT_OBJECTS = [
  "table:backup_epoch_producer_claim",
  "index:backup_epoch_producer_claim_state_idx",
  "trigger:backup_epoch_producer_claim_admission_guard",
  "trigger:backup_epoch_producer_claim_transition_guard",
  "trigger:backup_epoch_producer_claim_insert_state_guard",
  "trigger:backup_epoch_producer_claim_delete_guard",
] as const;
const ERASURE_FINGERPRINT_OBJECTS = [
  "table:erasure_case", "table:erasure_execution",
  "index:erasure_request_digest_unique", "index:erasure_execution_claim_idx",
  "trigger:erasure_execution_backup_primary_complete_guard",
] as const;
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface BackupEpochProducerOwner {
  readonly idempotency_key: string;
  readonly base_intent_digest: string;
  readonly attempt_nonce: string;
}

export interface BackupEpochProducerPins {
  readonly epoch_id: string;
  readonly part_prefix: string;
  readonly cut_id: string;
  readonly cut_digest: string;
  readonly vector_digest: string;
  readonly manifest_digest: string;
  readonly intent_digest: string;
}

export interface BackupEpochProducerClaim {
  readonly idempotency_key: string;
  readonly base_intent_digest: string;
  readonly attempt_nonce: string;
  readonly state: typeof PRODUCER_STATES[number];
  readonly epoch_id: string | null;
  readonly part_prefix: string | null;
  readonly cut_id: string | null;
  readonly cut_digest: string | null;
  readonly vector_digest: string | null;
  readonly manifest_digest: string | null;
  readonly intent_digest: string | null;
  readonly receipt_digest: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export type BackupEpochProducerAdmission =
  | { readonly mode: "OWNED_CAPTURE"; readonly owner: BackupEpochProducerOwner }
  | {
      readonly mode: "READ_ONLY_REPLAY";
      readonly base_intent_digest: string;
      readonly existing_claim: BackupEpochProducerClaim | null;
    };

interface SqlObject {
  readonly type: "table" | "index" | "trigger";
  readonly name: string;
  readonly sql: string;
}

interface ProducerClaimRow {
  readonly idempotency_key: unknown;
  readonly base_intent_digest: unknown;
  readonly attempt_nonce: unknown;
  readonly state: unknown;
  readonly epoch_id: unknown;
  readonly part_prefix: unknown;
  readonly cut_id: unknown;
  readonly cut_digest: unknown;
  readonly vector_digest: unknown;
  readonly manifest_digest: unknown;
  readonly intent_digest: unknown;
  readonly receipt_digest: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface D1Rows<T> {
  readonly success: boolean;
  readonly results?: readonly T[];
}

function bind(database: D1Database, sql: string, values: readonly (string | number)[] = []): D1PreparedStatement {
  const statement = database.prepare(sql);
  return values.length === 0 ? statement : statement.bind(...values);
}

async function all<T>(database: D1Database, sql: string, values: readonly (string | number)[] = []): Promise<readonly T[]> {
  let result: D1Rows<T>;
  try {
    result = await bind(database, sql, values).all<T>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup producer fence read is unavailable", true, {}, cause);
  }
  if (result.success !== true || !Array.isArray(result.results)) {
    failBackup("BACKUP_TABLE_MISSING", "backup producer fence readback is malformed", true);
  }
  return result.results;
}

async function first<T>(database: D1Database, sql: string, values: readonly (string | number)[] = []): Promise<T | null> {
  try {
    return await bind(database, sql, values).first<T>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup producer fence lookup is unavailable", true, {}, cause);
  }
}

function failSchema(label: string, cause?: unknown): never {
  failBackup("BACKUP_TABLE_MISSING", `backup producer fence ${label} authority is missing or mismatched`, false, { schema: label }, cause);
}

async function schemaFingerprint(entries: readonly SqlObject[]): Promise<string> {
  const ordered = [...entries].sort((a, b) => a.type < b.type ? -1 : a.type > b.type ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return backupSha256Hex(ordered.map((entry) => `${entry.type} ${entry.name} ${canonicalizeSchemaSql(entry.sql)}`).join("\n"));
}

async function assertObjectFingerprint(
  database: D1Database,
  tableNames: readonly string[],
  expectedObjects: readonly string[],
  expectedDigest: string,
  label: string,
): Promise<void> {
  const placeholders = tableNames.map((_, i) => `?${i + 1}`).join(",");
  const rows = await all<{ readonly type: unknown; readonly name: unknown; readonly sql: unknown }>(
    database,
    `SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','index','trigger') AND tbl_name IN (${placeholders}) AND sql IS NOT NULL`,
    tableNames,
  );
  const entries: SqlObject[] = [];
  for (const row of rows) {
    if ((row.type !== "table" && row.type !== "index" && row.type !== "trigger") || typeof row.name !== "string" || typeof row.sql !== "string") {
      failSchema(label);
    }
    entries.push({ type: row.type, name: row.name, sql: row.sql });
  }
  const keys = entries.map((entry) => `${entry.type}:${entry.name}`).sort();
  const expected = [...expectedObjects].sort();
  if (canonicalBackupJson(keys) !== canonicalBackupJson(expected)) failSchema(label);
  if (await schemaFingerprint(entries) !== expectedDigest) failSchema(label);
}

async function assertProducerColumnsAndIndexes(database: D1Database): Promise<void> {
  const columns = await all<{
    readonly name: unknown; readonly type: unknown; readonly notnull: unknown; readonly dflt_value: unknown; readonly pk: unknown;
  }>(database, `PRAGMA table_info(${PRODUCER_TABLE})`);
  const expectedColumns = [
    ["idempotency_key", "TEXT", 1, null, 1], ["base_intent_digest", "TEXT", 1, null, 0],
    ["attempt_nonce", "TEXT", 1, null, 0], ["state", "TEXT", 1, null, 0],
    ["epoch_id", "TEXT", 0, null, 0], ["part_prefix", "TEXT", 0, null, 0],
    ["cut_id", "TEXT", 0, null, 0], ["cut_digest", "TEXT", 0, null, 0],
    ["vector_digest", "TEXT", 0, null, 0], ["manifest_digest", "TEXT", 0, null, 0],
    ["intent_digest", "TEXT", 0, null, 0], ["receipt_digest", "TEXT", 0, null, 0],
    ["created_at", "TEXT", 1, null, 0], ["updated_at", "TEXT", 1, null, 0],
  ];
  const observedColumns = columns.map((row) => [row.name, row.type, row.notnull, row.dflt_value, row.pk]);
  if (canonicalBackupJson(observedColumns) !== canonicalBackupJson(expectedColumns)) failSchema(PRODUCER_TABLE);

  const foreignKeys = await all<unknown>(database, `PRAGMA foreign_key_list(${PRODUCER_TABLE})`);
  if (foreignKeys.length !== 0) failSchema(PRODUCER_TABLE);
  const indexRows = await all<{ readonly name: unknown; readonly unique: unknown; readonly origin: unknown }>(
    database, `PRAGMA index_list(${PRODUCER_TABLE})`,
  );
  const observedIndexes: { name: string; unique: number; origin: string; columns: string[] }[] = [];
  for (const row of indexRows) {
    if (typeof row.name !== "string" || typeof row.unique !== "number" || typeof row.origin !== "string") failSchema(PRODUCER_TABLE);
    const quoted = `"${row.name.replaceAll('"', '""')}"`;
    const indexColumns = await all<{ readonly seqno: unknown; readonly name: unknown }>(database, `PRAGMA index_info(${quoted})`);
    const names = [...indexColumns].sort((a, b) => Number(a.seqno) - Number(b.seqno)).map((column) => {
      if (typeof column.name !== "string") failSchema(PRODUCER_TABLE);
      return column.name;
    });
    observedIndexes.push({ name: row.name, unique: row.unique, origin: row.origin, columns: names });
  }
  observedIndexes.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const expectedIndexes = [
    { name: "backup_epoch_producer_claim_state_idx", unique: 0, origin: "c", columns: ["state", "idempotency_key"] },
    { name: "sqlite_autoindex_backup_epoch_producer_claim_1", unique: 1, origin: "pk", columns: ["idempotency_key"] },
    { name: "sqlite_autoindex_backup_epoch_producer_claim_2", unique: 1, origin: "u", columns: ["attempt_nonce"] },
    { name: "sqlite_autoindex_backup_epoch_producer_claim_3", unique: 1, origin: "u", columns: ["epoch_id"] },
  ].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (canonicalBackupJson(observedIndexes) !== canonicalBackupJson(expectedIndexes)) failSchema(PRODUCER_TABLE);
}

async function assertErasureGuardColumnsAndIndexes(database: D1Database): Promise<void> {
  const caseColumns = await all<{ readonly name: unknown; readonly type: unknown; readonly notnull: unknown; readonly pk: unknown }>(
    database, "PRAGMA table_info(erasure_case)",
  );
  const executionColumns = await all<{ readonly name: unknown; readonly type: unknown; readonly notnull: unknown; readonly pk: unknown }>(
    database, "PRAGMA table_info(erasure_execution)",
  );
  const caseState = caseColumns.find((row) => row.name === "state");
  const executionState = executionColumns.find((row) => row.name === "state");
  if (caseState?.type !== "TEXT" || caseState.notnull !== 1 || caseState.pk !== 0 ||
      executionState?.type !== "TEXT" || executionState.notnull !== 1 || executionState.pk !== 0) failSchema("erasure-state-tables");
  if (!caseColumns.some((row) => row.name === "erasure_id" && row.pk === 1) ||
      !caseColumns.some((row) => row.name === "revision" && row.pk === 2) ||
      !executionColumns.some((row) => row.name === "erasure_id" && row.pk === 1) ||
      !executionColumns.some((row) => row.name === "revision" && row.pk === 2)) failSchema("erasure-state-tables");
  const caseFks = await all<unknown>(database, "PRAGMA foreign_key_list(erasure_case)");
  if (caseFks.length !== 0) failSchema("erasure-state-tables");
  const executionFks = await all<{ readonly table: unknown; readonly from: unknown; readonly to: unknown }>(
    database, "PRAGMA foreign_key_list(erasure_execution)",
  );
  const observed = [...executionFks].map((row) => [row.table, row.from, row.to]).sort((a, b) => canonicalBackupJson(a).localeCompare(canonicalBackupJson(b)));
  const expected = [["erasure_case", "erasure_id", "erasure_id"], ["erasure_case", "revision", "revision"], ["purge_ledger", "purge_ledger_revision", "ledger_revision"]]
    .sort((a, b) => canonicalBackupJson(a).localeCompare(canonicalBackupJson(b)));
  if (canonicalBackupJson(observed) !== canonicalBackupJson(expected)) failSchema("erasure-state-tables");
}

/** Strict O2 + 0116 + exact 0117 erasure-completion guard authority; never performs runtime DDL. */
export async function assertBackupProducerFenceMigrationAuthority(database: D1Database): Promise<void> {
  await assertO2MigrationAuthority(database);
  const names = await all<{ readonly name: unknown }>(
    database,
    `SELECT name FROM d1_migrations WHERE name IN (${REQUIRED_LEDGER.map((_, i) => `?${i + 1}`).join(",")})`,
    REQUIRED_LEDGER,
  );
  const observedNames = new Set(names.map((row) => row.name));
  for (const name of REQUIRED_LEDGER) if (!observedNames.has(name)) failSchema(name);
  await assertErasureGuardColumnsAndIndexes(database);
  await assertObjectFingerprint(
    database, ["erasure_case", "erasure_execution"], ERASURE_FINGERPRINT_OBJECTS,
    BACKUP_PRODUCER_ERASURE_SCHEMA_SHA256, "erasure-state-tables",
  );
  await assertProducerColumnsAndIndexes(database);
  await assertObjectFingerprint(
    database, [PRODUCER_TABLE], FINGERPRINT_OBJECTS, BACKUP_PRODUCER_FENCE_SCHEMA_SHA256, PRODUCER_TABLE,
  );
}

function parseProducerClaim(row: ProducerClaimRow): BackupEpochProducerClaim {
  const nullableText = (value: unknown, label: string): string | null => {
    if (value === null) return null;
    if (typeof value !== "string") failBackup("BACKUP_VECTOR_UNVERIFIABLE", `backup producer ${label} is malformed`);
    return value;
  };
  if (typeof row.idempotency_key !== "string" || row.idempotency_key.length === 0 ||
      typeof row.base_intent_digest !== "string" || !SHA256.test(row.base_intent_digest) ||
      typeof row.attempt_nonce !== "string" || !UUID.test(row.attempt_nonce) || typeof row.state !== "string" ||
      !PRODUCER_STATES.includes(row.state as typeof PRODUCER_STATES[number]) ||
      typeof row.created_at !== "string" || typeof row.updated_at !== "string") {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup producer claim identity is malformed");
  }
  const claim: BackupEpochProducerClaim = {
    idempotency_key: row.idempotency_key, base_intent_digest: row.base_intent_digest,
    attempt_nonce: row.attempt_nonce, state: row.state as BackupEpochProducerClaim["state"],
    epoch_id: nullableText(row.epoch_id, "epoch pin"), part_prefix: nullableText(row.part_prefix, "prefix pin"),
    cut_id: nullableText(row.cut_id, "cut pin"), cut_digest: nullableText(row.cut_digest, "cut digest"),
    vector_digest: nullableText(row.vector_digest, "vector digest"), manifest_digest: nullableText(row.manifest_digest, "manifest digest"),
    intent_digest: nullableText(row.intent_digest, "intent digest"), receipt_digest: nullableText(row.receipt_digest, "receipt digest"),
    created_at: row.created_at, updated_at: row.updated_at,
  };
  const hasNoPins = claim.epoch_id === null && claim.part_prefix === null && claim.cut_id === null &&
    claim.cut_digest === null && claim.vector_digest === null && claim.manifest_digest === null &&
    claim.intent_digest === null && claim.receipt_digest === null;
  if (claim.state === "CAPTURING" || claim.state === "ABANDONED_NO_WRITES") {
    if (!hasNoPins) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "unwritten backup producer claim carries output pins");
    return claim;
  }
  if (claim.epoch_id === null || claim.part_prefix !== `backup-parts/${claim.epoch_id}/` ||
      claim.cut_digest === null || !SHA256.test(claim.cut_digest) || claim.cut_id !== `cut-${claim.cut_digest.slice(0, 32)}` ||
      claim.vector_digest === null || !SHA256.test(claim.vector_digest) ||
      claim.manifest_digest === null || !SHA256.test(claim.manifest_digest) ||
      claim.intent_digest === null || !SHA256.test(claim.intent_digest)) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "writing backup producer claim has incomplete or malformed output pins");
  }
  if ((claim.state === "COMMITTED") !== (claim.receipt_digest !== null) ||
      (claim.receipt_digest !== null && !SHA256.test(claim.receipt_digest))) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup producer receipt pin disagrees with its state");
  }
  return claim;
}

const PRODUCER_CLAIM_SELECT = `SELECT idempotency_key,base_intent_digest,attempt_nonce,state,epoch_id,part_prefix,cut_id,cut_digest,
  vector_digest,manifest_digest,intent_digest,receipt_digest,created_at,updated_at FROM ${PRODUCER_TABLE}`;

async function readClaim(database: D1Database, idempotencyKey: string): Promise<BackupEpochProducerClaim | null> {
  const row = await first<ProducerClaimRow>(database, `${PRODUCER_CLAIM_SELECT} WHERE idempotency_key=?1`, [idempotencyKey]);
  return row === null ? null : parseProducerClaim(row);
}

export async function listBackupEpochProducerClaims(database: D1Database): Promise<readonly BackupEpochProducerClaim[]> {
  const rows = await all<ProducerClaimRow>(database, `${PRODUCER_CLAIM_SELECT} ORDER BY idempotency_key LIMIT 100001`);
  if (rows.length > 100000) failBackup("BACKUP_BOUND_EXCEEDED", "backup producer claim set exceeds its audit bound");
  return rows.map(parseProducerClaim);
}

async function hasUnsettledErasure(database: D1Database): Promise<boolean> {
  const row = await first<{ readonly active_case: unknown; readonly active_execution: unknown }>(
    database,
    "SELECT EXISTS(SELECT 1 FROM erasure_case WHERE state <> 'COMPLETE') AS active_case, " +
      "EXISTS(SELECT 1 FROM erasure_execution WHERE state <> 'COMPLETE') AS active_execution",
  );
  if (row === null || (row.active_case !== 0 && row.active_case !== 1) || (row.active_execution !== 0 && row.active_execution !== 1)) {
    failBackup("BACKUP_TABLE_MISSING", "backup producer erasure fence readback is malformed", true);
  }
  return row.active_case === 1 || row.active_execution === 1;
}

function readonlyAdmission(baseIntentDigest: string, claim: BackupEpochProducerClaim | null): BackupEpochProducerAdmission {
  return { mode: "READ_ONLY_REPLAY", base_intent_digest: baseIntentDigest, existing_claim: claim };
}

function admitExistingClaim(claim: BackupEpochProducerClaim, baseIntentDigest: string): BackupEpochProducerAdmission {
  if (claim.base_intent_digest !== baseIntentDigest) {
    failBackup("BACKUP_INTENT_CONFLICT", "backup idempotency key is bound to a different producer intent");
  }
  if (claim.state === "COMMITTED") return readonlyAdmission(baseIntentDigest, claim);
  failBackup("BACKUP_INTENT_CONFLICT", "backup idempotency key has an unresolved or abandoned producer claim", true, { state: claim.state });
}

/** Claims a new producer attempt before any D1/R2 snapshot; historical receipts stay read-only. */
export async function admitBackupEpochProducer(
  database: D1Database,
  intent: OperationIntent,
  now: string,
): Promise<BackupEpochProducerAdmission> {
  await assertBackupProducerFenceMigrationAuthority(database);
  const baseIntentDigest = await canonicalProducerIntentDigest(intent);
  const existingClaim = await readClaim(database, intent.idempotency_key);
  if (existingClaim !== null) return admitExistingClaim(existingClaim, baseIntentDigest);
  const existingReceipt = await first<{ readonly idempotency_key: unknown }>(
    database, "SELECT idempotency_key FROM backup_epoch_receipt WHERE idempotency_key=?1", [intent.idempotency_key],
  );
  if (existingReceipt !== null) return readonlyAdmission(baseIntentDigest, null);

  const attemptNonce = crypto.randomUUID().toLowerCase();
  const sql = `INSERT INTO ${PRODUCER_TABLE}
      (idempotency_key,base_intent_digest,attempt_nonce,state,created_at,updated_at)
    SELECT ?1,?2,?3,'CAPTURING',?4,?4
    WHERE NOT EXISTS (SELECT 1 FROM erasure_case WHERE state <> 'COMPLETE')
      AND NOT EXISTS (SELECT 1 FROM erasure_execution WHERE state <> 'COMPLETE')
      AND NOT EXISTS (SELECT 1 FROM backup_epoch_receipt WHERE idempotency_key=?1)
    ON CONFLICT(idempotency_key) DO NOTHING
    RETURNING idempotency_key,attempt_nonce`;
  let inserted: readonly { readonly idempotency_key: unknown; readonly attempt_nonce: unknown }[] = [];
  try {
    const result = await bind(database, sql, [intent.idempotency_key, baseIntentDigest, attemptNonce, now]).all<{ readonly idempotency_key: unknown; readonly attempt_nonce: unknown }>();
    if (result.success !== true || !Array.isArray(result.results)) failBackup("BACKUP_TABLE_MISSING", "backup producer claim insert readback is malformed", true);
    inserted = result.results;
  } catch {
    const raced = await readClaim(database, intent.idempotency_key);
    if (raced !== null) return admitExistingClaim(raced, baseIntentDigest);
    const racedReceipt = await first<{ readonly idempotency_key: unknown }>(
      database, "SELECT idempotency_key FROM backup_epoch_receipt WHERE idempotency_key=?1", [intent.idempotency_key],
    );
    if (racedReceipt !== null) return readonlyAdmission(baseIntentDigest, null);
    if (await hasUnsettledErasure(database)) failBackup("BACKUP_PURGE_BLOCKED", "backup producer admission is fenced by an unsettled erasure", true);
    failBackup("BACKUP_TABLE_MISSING", "backup producer claim could not be durably recorded", true);
  }
  if (inserted.length === 1 && inserted[0]?.idempotency_key === intent.idempotency_key && inserted[0]?.attempt_nonce === attemptNonce) {
    return { mode: "OWNED_CAPTURE", owner: { idempotency_key: intent.idempotency_key, base_intent_digest: baseIntentDigest, attempt_nonce: attemptNonce } };
  }
  const raced = await readClaim(database, intent.idempotency_key);
  if (raced !== null) return admitExistingClaim(raced, baseIntentDigest);
  const racedReceipt = await first<{ readonly idempotency_key: unknown }>(
    database, "SELECT idempotency_key FROM backup_epoch_receipt WHERE idempotency_key=?1", [intent.idempotency_key],
  );
  if (racedReceipt !== null) return readonlyAdmission(baseIntentDigest, null);
  if (await hasUnsettledErasure(database)) failBackup("BACKUP_PURGE_BLOCKED", "backup producer admission is fenced by an unsettled erasure", true);
  failBackup("BACKUP_TABLE_MISSING", "backup producer claim insert returned no owned row", true);
}

function pinsMatch(claim: BackupEpochProducerClaim, pins: BackupEpochProducerPins): boolean {
  return claim.epoch_id === pins.epoch_id && claim.part_prefix === pins.part_prefix && claim.cut_id === pins.cut_id &&
    claim.cut_digest === pins.cut_digest && claim.vector_digest === pins.vector_digest &&
    claim.manifest_digest === pins.manifest_digest && claim.intent_digest === pins.intent_digest;
}

function assertOwner(claim: BackupEpochProducerClaim, owner: BackupEpochProducerOwner): void {
  if (claim.idempotency_key !== owner.idempotency_key || claim.base_intent_digest !== owner.base_intent_digest ||
      claim.attempt_nonce !== owner.attempt_nonce) {
    failBackup("BACKUP_INTENT_CONFLICT", "backup producer attempt no longer owns its durable claim", true);
  }
}

/** Pins the exact candidate and enters WRITING in the same guarded D1 statement. */
export async function pinBackupEpochProducerForWrites(
  database: D1Database,
  owner: BackupEpochProducerOwner,
  pins: BackupEpochProducerPins,
  now: string,
): Promise<"PINNED" | "RECEIPT_PRESENT"> {
  if (pins.part_prefix !== `backup-parts/${pins.epoch_id}/` || pins.cut_id !== `cut-${pins.cut_digest.slice(0, 32)}`) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "backup producer candidate pins are inconsistent");
  }
  const sql = `UPDATE ${PRODUCER_TABLE} SET state='WRITING',epoch_id=?1,part_prefix=?2,cut_id=?3,cut_digest=?4,
      vector_digest=?5,manifest_digest=?6,intent_digest=?7,updated_at=?8
    WHERE idempotency_key=?9 AND base_intent_digest=?10 AND attempt_nonce=?11 AND state='CAPTURING'
      AND NOT EXISTS (SELECT 1 FROM erasure_case WHERE state <> 'COMPLETE')
      AND NOT EXISTS (SELECT 1 FROM erasure_execution WHERE state <> 'COMPLETE')
      AND NOT EXISTS (SELECT 1 FROM backup_epoch_producer_claim WHERE epoch_id=?1 AND idempotency_key<>?9)
      AND NOT EXISTS (SELECT 1 FROM backup_epoch_receipt WHERE idempotency_key=?9 OR epoch_id=?1)
      AND NOT EXISTS (SELECT 1 FROM backup_epoch WHERE backup_epoch_id=?1)
    RETURNING idempotency_key`;
  let result: D1Rows<{ readonly idempotency_key: unknown }> | undefined;
  try {
    result = await bind(database, sql, [
      pins.epoch_id, pins.part_prefix, pins.cut_id, pins.cut_digest, pins.vector_digest,
      pins.manifest_digest, pins.intent_digest, now, owner.idempotency_key,
      owner.base_intent_digest, owner.attempt_nonce,
    ]).all<{ readonly idempotency_key: unknown }>();
  } catch {
    // Resolve a lost D1 acknowledgement only by exact durable owner/pin readback.
  }
  if (result?.success === true && Array.isArray(result.results) && result.results.length === 1 &&
      result.results[0]?.idempotency_key === owner.idempotency_key) {
    await assertBackupEpochProducerWriteOwner(database, owner, pins);
    return "PINNED";
  }
  const current = await readClaim(database, owner.idempotency_key);
  if (current !== null) {
    assertOwner(current, owner);
    if (current.state === "WRITING" && pinsMatch(current, pins)) {
      await assertBackupEpochProducerWriteOwner(database, owner, pins);
      return "PINNED";
    }
    if (current.state === "CAPTURING") {
      const existingReceipt = await first<{ readonly idempotency_key: unknown }>(
        database,
        "SELECT idempotency_key FROM backup_epoch_receipt WHERE idempotency_key=?1 OR epoch_id=?2 LIMIT 1",
        [owner.idempotency_key, pins.epoch_id],
      );
      if (existingReceipt !== null) {
        await abandonBackupEpochProducerWithoutWrites(database, owner, now);
        return "RECEIPT_PRESENT";
      }
    }
    if (current.state === "CAPTURING" && await hasUnsettledErasure(database)) {
      await abandonBackupEpochProducerWithoutWrites(database, owner, now);
      failBackup("BACKUP_PURGE_BLOCKED", "backup producer write is fenced by an unsettled erasure", true);
    }
    if (current.state === "CAPTURING") {
      await abandonBackupEpochProducerWithoutWrites(database, owner, now);
      failBackup("BACKUP_INTENT_CONFLICT", "backup producer candidate epoch is already owned or persisted", false);
    }
  }
  failBackup("BACKUP_INTENT_CONFLICT", "backup producer pre-write ownership could not be confirmed", true);
}

export async function assertBackupEpochProducerWriteOwner(
  database: D1Database,
  owner: BackupEpochProducerOwner,
  pins: BackupEpochProducerPins,
): Promise<void> {
  const claim = await readClaim(database, owner.idempotency_key);
  if (claim === null) failBackup("BACKUP_INTENT_CONFLICT", "backup producer claim disappeared before a part write", true);
  assertOwner(claim, owner);
  if (claim.state !== "WRITING" || !pinsMatch(claim, pins)) {
    failBackup("BACKUP_INTENT_CONFLICT", "backup producer write pins changed before a part write", true);
  }
}

export async function abandonBackupEpochProducerWithoutWrites(
  database: D1Database,
  owner: BackupEpochProducerOwner,
  now: string,
): Promise<void> {
  const sql = `UPDATE ${PRODUCER_TABLE} SET state='ABANDONED_NO_WRITES',updated_at=?1
    WHERE idempotency_key=?2 AND base_intent_digest=?3 AND attempt_nonce=?4 AND state='CAPTURING'
    RETURNING idempotency_key`;
  try {
    const result = await bind(database, sql, [now, owner.idempotency_key, owner.base_intent_digest, owner.attempt_nonce]).all<{ readonly idempotency_key: unknown }>();
    if (result.success === true && result.results?.length === 1 && result.results[0]?.idempotency_key === owner.idempotency_key) return;
  } catch {
    // Confirm only the exact safe terminal state; otherwise leave it blocking.
  }
  const current = await readClaim(database, owner.idempotency_key);
  if (current !== null) {
    assertOwner(current, owner);
    if (current.state === "ABANDONED_NO_WRITES") return;
  }
}

export async function markBackupEpochProducerUnknown(
  database: D1Database,
  owner: BackupEpochProducerOwner,
  pins: BackupEpochProducerPins,
  now: string,
): Promise<void> {
  try {
    await bind(database, `UPDATE ${PRODUCER_TABLE} SET state='UNKNOWN',updated_at=?1
      WHERE idempotency_key=?2 AND base_intent_digest=?3 AND attempt_nonce=?4 AND state='WRITING'
        AND epoch_id=?5 AND part_prefix=?6 AND cut_id=?7 AND cut_digest=?8 AND vector_digest=?9
        AND manifest_digest=?10 AND intent_digest=?11`, [
      now, owner.idempotency_key, owner.base_intent_digest, owner.attempt_nonce,
      pins.epoch_id, pins.part_prefix, pins.cut_id, pins.cut_digest, pins.vector_digest,
      pins.manifest_digest, pins.intent_digest,
    ]).run();
  } catch {
    // WRITING is itself unresolved and remains a blocking state.
  }
}

export async function backupEpochProducerReceiptDigest(value: {
  readonly idempotency_key: string;
  readonly intent_id: string;
  readonly intent_digest: string;
  readonly vector_digest: string;
  readonly manifest_digest: string;
  readonly epoch_id: string;
  readonly receipt_json: string;
  readonly draft_json: string;
  readonly attempt_json: string;
}): Promise<string> {
  return backupSha256Hex(canonicalBackupJson({ protocol: "eliotr.backup-epoch-producer-receipt.v1", ...value }));
}

export async function commitBackupEpochProducer(
  database: D1Database,
  owner: BackupEpochProducerOwner,
  pins: BackupEpochProducerPins,
  receipt: {
    readonly intent_id: string;
    readonly intent_digest: string;
    readonly receipt_json: string;
    readonly draft_json: string;
    readonly attempt_json: string;
  },
  now: string,
): Promise<void> {
  const persisted = await first<{
    readonly idempotency_key: unknown;
    readonly intent_id: unknown;
    readonly intent_digest: unknown;
    readonly vector_digest: unknown;
    readonly manifest_digest: unknown;
    readonly epoch_id: unknown;
    readonly receipt_json: unknown;
    readonly draft_json: unknown;
    readonly attempt_json: unknown;
  }>(database, `SELECT idempotency_key,intent_id,intent_digest,vector_digest,manifest_digest,epoch_id,
      receipt_json,draft_json,attempt_json FROM backup_epoch_receipt WHERE idempotency_key=?1`, [owner.idempotency_key]);
  if (persisted === null || persisted.idempotency_key !== owner.idempotency_key || persisted.intent_id !== receipt.intent_id ||
      persisted.intent_digest !== receipt.intent_digest || persisted.vector_digest !== pins.vector_digest ||
      persisted.manifest_digest !== pins.manifest_digest || persisted.epoch_id !== pins.epoch_id ||
      persisted.receipt_json !== receipt.receipt_json || persisted.draft_json !== receipt.draft_json ||
      persisted.attempt_json !== receipt.attempt_json || typeof persisted.receipt_json !== "string" ||
      typeof persisted.draft_json !== "string" || typeof persisted.attempt_json !== "string") {
    failBackup("BACKUP_INTENT_CONFLICT", "backup producer receipt readback differs from its exact persisted pins", true);
  }
  const persistedReceipt = {
    idempotency_key: owner.idempotency_key,
    intent_id: receipt.intent_id,
    intent_digest: receipt.intent_digest,
    vector_digest: pins.vector_digest,
    manifest_digest: pins.manifest_digest,
    epoch_id: pins.epoch_id,
    receipt_json: persisted.receipt_json,
    draft_json: persisted.draft_json,
    attempt_json: persisted.attempt_json,
  };
  const digest = await backupEpochProducerReceiptDigest(persistedReceipt);
  try {
    const result = await bind(database, `UPDATE ${PRODUCER_TABLE} SET state='COMMITTED',receipt_digest=?1,updated_at=?2
      WHERE idempotency_key=?3 AND base_intent_digest=?4 AND attempt_nonce=?5 AND state='WRITING'
        AND epoch_id=?6 AND part_prefix=?7 AND cut_id=?8 AND cut_digest=?9 AND vector_digest=?10
        AND manifest_digest=?11 AND intent_digest=?12
        AND EXISTS (SELECT 1 FROM backup_epoch_receipt r WHERE r.idempotency_key=?3 AND r.intent_id=?13
          AND r.intent_digest=?12 AND r.vector_digest=?10 AND r.manifest_digest=?11 AND r.epoch_id=?6
          AND r.receipt_json=?14 AND r.draft_json=?15 AND r.attempt_json=?16)`, [
      digest, now, owner.idempotency_key, owner.base_intent_digest, owner.attempt_nonce,
      pins.epoch_id, pins.part_prefix, pins.cut_id, pins.cut_digest, pins.vector_digest,
      pins.manifest_digest, pins.intent_digest, receipt.intent_id, receipt.receipt_json, receipt.draft_json, receipt.attempt_json,
    ]).all<{ readonly idempotency_key: unknown }>();
    if (result.success === true && result.results?.length === 1 && result.results[0]?.idempotency_key === owner.idempotency_key) return;
  } catch {
    // Lost acknowledgement requires an exact state and digest readback below.
  }
  const current = await readClaim(database, owner.idempotency_key);
  if (current !== null) {
    assertOwner(current, owner);
    if (current.state === "COMMITTED" && pinsMatch(current, pins) && current.receipt_digest === digest) return;
  }
  failBackup("BACKUP_INTENT_CONFLICT", "backup producer COMMITTED authority could not be confirmed", true);
}
