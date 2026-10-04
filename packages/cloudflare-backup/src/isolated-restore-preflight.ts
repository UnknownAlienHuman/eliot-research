import { BackupEpochSchema, type BackupEpoch } from "@eliotr/contracts";
import { BACKUP_MANIFEST_PROTOCOL, BACKUP_R2_PAYLOAD_PROTOCOL, BACKUP_SCHEMA_INVENTORY_PROTOCOL, TABLE_SPECS, digestCoreColumnInventory, readCoreColumnInventory, type CoreTableInventory } from "@eliotr/backup-o2";
import type { BackupEpochDraft } from "@eliotr/backup-o2";
import { openOffsiteBackupPart, type BackupOffsiteReadAuthority, type OffsiteCopyAdapter } from "@eliotr/backup-o2";
import { BACKUP_PORTABLE_MANIFEST_NAMES, verifyPortableBackupManifests, type PlaintextBackupPart, type VerifiedPortableBackupManifests } from "@eliotr/backup-o2";
import { destinationDescriptorDigest, destinationPolicyDigest, type BackupDestinationPolicy } from "@eliotr/backup-o2";
import { readBlockingHoldAuthority } from "@eliotr/backup-o2";
import { backupAborted, backupSha256Hex, canonicalBackupJson, failBackup } from "@eliotr/backup-o2";

const SHA256 = /^[a-f0-9]{64}$/u;
const MANIFESTS = BACKUP_PORTABLE_MANIFEST_NAMES;
const RESTORE_READ_LIMITS = { max_parts: 4096, max_part_bytes: 1024 * 1024, max_manifest_bytes: 8 * 1024 * 1024, max_total_manifest_bytes: 8 * 1024 * 1024, max_inventory_rows: 100_000, max_bucket_pages: 1000 } as const;
const CONTROL_TABLES = new Set(["d1_migrations", "schema_state", "investigation_ledger_epoch", "orientation_authority_epoch"]);

function checkedDatabase(database: D1Database): D1Database {
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({
    bind(...values: unknown[]) { return wrap(statement.bind(...values)); },
    async all<T>() {
      const result = await statement.all<T>();
      if (result?.success !== true || !Array.isArray(result.results)) failBackup("BACKUP_TABLE_MISSING", "isolated restore D1 read returned an unsuccessful or malformed result", true);
      return result;
    },
    async first<T>() { return statement.first<T>(); },
    async run<T>() {
      const result = await statement.run<T>();
      if (result?.success !== true || !Array.isArray(result.results)) failBackup("BACKUP_TABLE_MISSING", "isolated restore D1 write returned an unsuccessful or malformed result", true);
      return result;
    },
  } as unknown as D1PreparedStatement);
  return { prepare(query: string) { return wrap(database.prepare(query)); } } as D1Database;
}

function assertBoundResourceIds(primary: IsolatedRestorePrimaryIdentity, target: IsolatedRestoreTargetIdentity): void {
  const valid = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value);
  for (const value of [primary.account_id, primary.failure_domain, target.account_id, target.failure_domain, target.environment_ref,
    primary.resources.core_database, primary.resources.evidence_bucket, primary.resources.work_bucket,
    target.resources.core_database, target.resources.evidence_bucket, target.resources.work_bucket]) {
    if (!valid(value)) failBackup("BACKUP_INPUT_INVALID", "isolated restore resource identity is malformed");
  }
  if (primary.resources.core_database === target.resources.core_database ||
      primary.resources.evidence_bucket === target.resources.evidence_bucket ||
      primary.resources.work_bucket === target.resources.work_bucket) {
    failBackup("BACKUP_RESTORE_NOT_IMPLEMENTED", "isolated restore target resource IDs must differ from primary resource IDs", false, {});
  }
}

export interface IsolatedRestoreTargetIdentity {
  readonly account_id: string;
  readonly failure_domain: string;
  readonly environment_ref: string;
  readonly resources: {
    readonly core_database: string;
    readonly evidence_bucket: string;
    readonly work_bucket: string;
  };
}

export interface IsolatedRestorePrimaryIdentity {
  readonly account_id: string;
  readonly failure_domain: string;
  readonly resources: {
    readonly core_database: string;
    readonly evidence_bucket: string;
    readonly work_bucket: string;
  };
}

export interface RestoreAdmissionRequest {
  readonly epoch_id: string;
  readonly offsite_copy_ref: string;
  readonly target_account_id: string;
  readonly target_failure_domain: string;
  readonly target_environment_ref: string;
  readonly primary_account_id: string;
  readonly primary_failure_domain: string;
  readonly primary_resources: IsolatedRestorePrimaryIdentity["resources"];
  readonly target_resources: IsolatedRestoreTargetIdentity["resources"];
  readonly migration_ledger_digest: string;
  readonly purge_ledger_revision: number;
  readonly purge_ledger_digest: string;
}

/**
 * The composition root must bind this check to a current controller-owned
 * restore admission. An epoch or its copy receipt never grants permission to
 * restore into a target.
 */
export interface RestoreAdmissionVerifier {
  assertCurrentAdmission(request: RestoreAdmissionRequest): Promise<void>;
}

export interface IsolatedRestorePreflightInput {
  readonly draft: BackupEpochDraft;
  readonly primary: IsolatedRestorePrimaryIdentity & { readonly db: D1Database; readonly evidence_bucket: R2Bucket; readonly work_bucket: R2Bucket };
  readonly target: IsolatedRestoreTargetIdentity & { readonly db: D1Database; readonly evidence_bucket: R2Bucket; readonly work_bucket: R2Bucket };
  readonly offsite: OffsiteCopyAdapter;
  readonly encryption_key: CryptoKey;
  readonly admission: RestoreAdmissionVerifier;
  readonly signal?: AbortSignal;
}

export interface IsolatedRestorePreflight {
  readonly state: "PREFLIGHT_VERIFIED_NO_WRITES";
  readonly draft: BackupEpochDraft;
  readonly copy_ref: string;
  readonly target: IsolatedRestoreTargetIdentity;
  readonly manifests: VerifiedPortableBackupManifests;
  readonly schema_inventory: readonly CoreTableInventory[];
  readonly current_purge: { readonly revision: number; readonly digest: string };
  readonly offsite_authority: {
    readonly destination_policy: BackupDestinationPolicy;
    readonly read_authority: BackupOffsiteReadAuthority;
  };
  readonly payload_writes_performed: false;
  readonly traffic_ready: false;
}

interface CopyAuthorityRow {
  readonly epoch_id: unknown;
  readonly destination_id: unknown;
  readonly key_generation: unknown;
  readonly policy_digest: unknown;
  readonly epoch_json: unknown;
  readonly expires_at: unknown;
  readonly failure_domain: unknown;
  readonly descriptor_digest: unknown;
  readonly authority_authorized_at: unknown;
}

interface DestinationAuthorityRow {
  readonly policy_json: unknown;
  readonly policy_digest: unknown;
  readonly state: unknown;
  readonly authorized_at: unknown;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (backupAborted(signal)) failBackup("BACKUP_CANCELLED", "isolated restore preflight was cancelled", true);
}

function parseJson<T>(text: unknown, label: string): T {
  if (typeof text !== "string" || text.length > RESTORE_READ_LIMITS.max_manifest_bytes) failBackup("BACKUP_VECTOR_UNVERIFIABLE", `isolated restore ${label} is missing or exceeds its bound`);
  try { return JSON.parse(text) as T; } catch (cause) { failBackup("BACKUP_VECTOR_UNVERIFIABLE", `isolated restore ${label} is malformed`, false, {}, cause); }
}

async function currentMigrationNames(db: D1Database): Promise<readonly string[]> {
  let result: D1Result<{ readonly name: unknown }>;
  try { result = await db.prepare("SELECT name FROM d1_migrations ORDER BY name LIMIT ?1").bind(RESTORE_READ_LIMITS.max_inventory_rows + 1).all<{ readonly name: unknown }>(); }
  catch (cause) { failBackup("BACKUP_TABLE_MISSING", "isolated restore migration ledger is unavailable", true, {}, cause); }
  if (result.success !== true || !Array.isArray(result.results)) failBackup("BACKUP_TABLE_MISSING", "isolated restore migration ledger returned an unsuccessful or malformed result", true);
  const rows = result.results;
  if (rows.length === 0 || rows.length > RESTORE_READ_LIMITS.max_inventory_rows) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "isolated restore migration ledger is empty or exceeds its bound");
  return rows.map((row) => {
    if (typeof row.name !== "string" || row.name.length === 0 || row.name.length > 256) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "isolated restore migration ledger contains a malformed name");
    return row.name;
  });
}

async function migrationDigest(db: D1Database): Promise<string> {
  const names = await currentMigrationNames(db);
  return backupSha256Hex(`migration-ledger\n${names.join("\n")}`);
}

async function schemaGeneration(db: D1Database): Promise<string> {
  let row: { readonly value: unknown } | null;
  try { row = await db.prepare("SELECT value FROM schema_state WHERE key='schema_generation'").first<{ readonly value: unknown }>(); }
  catch (cause) { failBackup("BACKUP_TABLE_MISSING", "isolated restore schema generation is unavailable", true, {}, cause); }
  if (row === null || typeof row.value !== "string" || row.value.length === 0) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "isolated restore schema generation is absent");
  return row.value;
}

async function currentPurge(db: D1Database): Promise<{ readonly revision: number; readonly digest: string; readonly blocked_count: number }> {
  let result: D1Result<Record<string, unknown>>;
  try {
    result = await db.prepare("SELECT ledger_revision, erasure_id, non_revealing_subject_digest, disposition, receipt_ref, created_at FROM purge_ledger ORDER BY ledger_revision LIMIT ?1")
      .bind(RESTORE_READ_LIMITS.max_inventory_rows + 1).all<Record<string, unknown>>();
  } catch (cause) { failBackup("BACKUP_TABLE_MISSING", "isolated restore current purge ledger is unavailable", true, {}, cause); }
  if (result.success !== true || !Array.isArray(result.results)) failBackup("BACKUP_TABLE_MISSING", "isolated restore purge ledger returned an unsuccessful or malformed result", true);
  const rows = result.results;
  if (rows.length > RESTORE_READ_LIMITS.max_inventory_rows) failBackup("BACKUP_BOUND_EXCEEDED", "isolated restore purge ledger exceeds its row bound");
  let revision = 0;
  let blockedCount = 0;
  for (const row of rows) {
    if (!Number.isSafeInteger(row.ledger_revision) || (row.ledger_revision as number) < 1 || typeof row.erasure_id !== "string" || typeof row.non_revealing_subject_digest !== "string" || !SHA256.test(row.non_revealing_subject_digest) || (row.disposition !== "COMPLETE" && row.disposition !== "BLOCKED") || typeof row.receipt_ref !== "string" || typeof row.created_at !== "string") {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", "isolated restore purge ledger carries a malformed row");
    }
    revision = Math.max(revision, row.ledger_revision as number);
    if (row.disposition === "BLOCKED") blockedCount += 1;
  }
  return { revision, digest: await backupSha256Hex(rows.map((row) => canonicalBackupJson(row)).join("\n")), blocked_count: blockedCount };
}

async function assertNoUnsettledErasure(db: D1Database): Promise<void> {
  let result: D1Result<{ readonly state: unknown }>;
  try {
    result = await db.prepare("SELECT state FROM erasure_execution ORDER BY erasure_id,revision LIMIT ?1").bind(RESTORE_READ_LIMITS.max_inventory_rows + 1).all<{ readonly state: unknown }>();
  } catch (cause) { failBackup("BACKUP_TABLE_MISSING", "isolated restore current erasure execution inventory is unavailable", true, {}, cause); }
  if (result.success !== true || !Array.isArray(result.results)) failBackup("BACKUP_TABLE_MISSING", "isolated restore erasure execution inventory returned an unsuccessful or malformed result", true);
  if (result.results.length > RESTORE_READ_LIMITS.max_inventory_rows) failBackup("BACKUP_BOUND_EXCEEDED", "isolated restore erasure execution inventory exceeds its row bound");
  if (result.results.some((row) => row.state !== "COMPLETE")) failBackup("BACKUP_PURGE_BLOCKED", "isolated restore is blocked by an unsettled erasure execution", false, {});
}

async function assertCleanTarget(db: D1Database): Promise<void> {
  let tables: D1Result<{ readonly name: unknown }>;
  try { tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name LIMIT ?1").bind(RESTORE_READ_LIMITS.max_inventory_rows + 1).all<{ readonly name: unknown }>(); }
  catch (cause) { failBackup("BACKUP_TABLE_MISSING", "isolated restore target table inventory is unavailable", true, {}, cause); }
  if (tables.success !== true || !Array.isArray(tables.results)) failBackup("BACKUP_TABLE_MISSING", "isolated restore target table inventory returned an unsuccessful or malformed result", true);
  const names = tables.results;
  if (names.length > RESTORE_READ_LIMITS.max_inventory_rows) failBackup("BACKUP_BOUND_EXCEEDED", "isolated restore target has too many tables");
  for (const entry of names) {
    if (typeof entry.name !== "string") failBackup("BACKUP_VECTOR_UNVERIFIABLE", "isolated restore target table inventory is malformed");
    const table = entry.name;
    if (table.startsWith("sqlite_") || CONTROL_TABLES.has(table)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(table)) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "isolated restore target has an unsafe table identifier");
    let row: { readonly n: unknown } | null;
    try { row = await db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).first<{ readonly n: unknown }>(); }
    catch (cause) { failBackup("BACKUP_TABLE_MISSING", "isolated restore target table cannot be counted", true, { table }, cause); }
    if (row === null || typeof row.n !== "number" || !Number.isSafeInteger(row.n) || row.n !== 0) failBackup("BACKUP_RESTORE_NOT_IMPLEMENTED", "isolated restore target is not empty; refusing to overlay canonical or controller state", false, { table });
  }
  // These two singleton rows are created by immutable schema migrations. They
  // are bootstrap coordination epochs, not tenant/canonical restore payload.
  for (const [table, sql, expected] of [
    ["investigation_ledger_epoch", "SELECT singleton,generation FROM investigation_ledger_epoch ORDER BY singleton LIMIT 2", [{ singleton: 1, generation: 1 }]],
    ["orientation_authority_epoch", "SELECT singleton,generation FROM orientation_authority_epoch ORDER BY singleton LIMIT 2", [{ singleton: 1, generation: 1 }]],
  ] as const) {
    const exists = names.some((entry) => entry.name === table);
    if (!exists) continue;
    let result: D1Result<Record<string, unknown>>;
    try { result = await db.prepare(sql).all<Record<string, unknown>>(); }
    catch (cause) { failBackup("BACKUP_TABLE_MISSING", "isolated restore bootstrap epoch is unreadable", true, { table }, cause); }
    if (result.success !== true || !Array.isArray(result.results)) failBackup("BACKUP_TABLE_MISSING", "isolated restore bootstrap epoch returned an unsuccessful or malformed result", true, { table });
    if (canonicalBackupJson(result.results) !== canonicalBackupJson(expected)) failBackup("BACKUP_RESTORE_NOT_IMPLEMENTED", "isolated restore target bootstrap epoch is not at its migration default", false, { table });
  }
}

async function assertEmptyBucket(bucket: R2Bucket, signal?: AbortSignal): Promise<void> {
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    abortIfNeeded(signal);
    pages += 1;
    if (pages > RESTORE_READ_LIMITS.max_bucket_pages) failBackup("BACKUP_BOUND_EXCEEDED", "isolated restore target bucket listing exceeds its page bound");
    let page: R2Objects;
    try { page = await bucket.list({ limit: 1000, ...(cursor === undefined ? {} : { cursor }) }); }
    catch (cause) { failBackup("BACKUP_OBJECT_UNREADABLE", "isolated restore target bucket inventory is unavailable", true, {}, cause); }
    if (typeof page !== "object" || page === null || !Array.isArray(page.objects) || typeof page.truncated !== "boolean") failBackup("BACKUP_OBJECT_UNREADABLE", "isolated restore target bucket inventory returned a malformed page", true);
    if (page.objects.length !== 0) failBackup("BACKUP_RESTORE_NOT_IMPLEMENTED", "isolated restore target bucket is not empty; refusing to overlay existing objects", false, { bucket: "isolated" });
    if (!page.truncated) return;
    const next = (page as unknown as { readonly cursor?: unknown }).cursor;
    if (typeof next !== "string" || next.length === 0 || next === cursor) failBackup("BACKUP_OBJECT_UNREADABLE", "isolated restore target bucket pagination is invalid", true);
    cursor = next;
  }
}

async function assertCurrentCopyAuthority(db: D1Database, draft: BackupEpochDraft, adapter: OffsiteCopyAdapter): Promise<{ readonly policy: BackupDestinationPolicy; readonly row: CopyAuthorityRow }> {
  let epochAuthority: { readonly manifest_digest: unknown; readonly draft_json: unknown } | null;
  try { epochAuthority = await db.prepare("SELECT manifest_digest,draft_json FROM backup_epoch_receipt WHERE epoch_id=?1 ORDER BY created_at LIMIT 1").bind(draft.epoch_id).first<{ readonly manifest_digest: unknown; readonly draft_json: unknown }>(); }
  catch (cause) { failBackup("BACKUP_TABLE_MISSING", "isolated restore persisted epoch draft is unavailable", true, {}, cause); }
  if (epochAuthority === null || typeof epochAuthority.manifest_digest !== "string" || !SHA256.test(epochAuthority.manifest_digest)) failBackup("BACKUP_RESTORE_NOT_IMPLEMENTED", "isolated restore requires a persisted D1 epoch receipt", false, {});
  const persistedDraft = parseJson<BackupEpochDraft>(epochAuthority.draft_json, "persisted epoch draft");
  if (canonicalBackupJson(persistedDraft) !== canonicalBackupJson(draft)) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "isolated restore caller draft diverges from persisted D1 epoch bytes");
  const actualManifestDigest = await backupSha256Hex(Object.entries(draft.manifest_digests).sort(([a], [b]) => a.localeCompare(b)).map(([name, digest]) => `${name}:${digest}`).join("\n"));
  if (actualManifestDigest !== epochAuthority.manifest_digest) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "isolated restore manifest digest diverges from persisted D1 epoch authority");
  const names = Object.keys(draft.manifest_digests).sort();
  if (names.length !== MANIFESTS.length || !names.every((name, index) => name === [...MANIFESTS].sort()[index])) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "isolated restore epoch manifest set is incomplete or includes unknown names");
  let result: D1Result<CopyAuthorityRow>;
  try { result = await db.prepare("SELECT epoch_id,destination_id,key_generation,policy_digest,epoch_json,expires_at,failure_domain,descriptor_digest,authority_authorized_at FROM backup_offsite_copy_receipt WHERE epoch_id=?1 ORDER BY created_at DESC LIMIT 2").bind(draft.epoch_id).all<CopyAuthorityRow>(); }
  catch (cause) { failBackup("BACKUP_TABLE_MISSING", "isolated restore offsite copy receipt is unavailable", true, {}, cause); }
  if (result.success !== true || !Array.isArray(result.results)) failBackup("BACKUP_TABLE_MISSING", "isolated restore offsite copy receipt returned an unsuccessful or malformed result", true);
  const rows = result.results;
  if (rows.length !== 1) failBackup("BACKUP_RESTORE_NOT_IMPLEMENTED", "isolated restore requires one unambiguous current D1 copy receipt", false, {});
  const row = rows[0] as CopyAuthorityRow;
  if (row.epoch_id !== draft.epoch_id || typeof row.destination_id !== "string" || typeof row.key_generation !== "string" || typeof row.policy_digest !== "string" || !SHA256.test(row.policy_digest) || typeof row.expires_at !== "string" || Date.parse(row.expires_at) <= Date.now() || typeof row.failure_domain !== "string" || typeof row.descriptor_digest !== "string" || !SHA256.test(row.descriptor_digest) || typeof row.authority_authorized_at !== "string") {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "isolated restore offsite copy receipt is stale or malformed");
  }
  const parsedEpoch = BackupEpochSchema.safeParse(parseJson<BackupEpoch>(row.epoch_json, "offsite copy epoch"));
  if (!parsedEpoch.success || parsedEpoch.data.epoch_ref.id !== draft.epoch_id || parsedEpoch.data.encryption_key_generation !== row.key_generation || parsedEpoch.data.offsite_failure_domain !== row.failure_domain || parsedEpoch.data.expires_at !== row.expires_at || parsedEpoch.data.purge_ledger_digest !== draft.purge_ledger_digest || parsedEpoch.data.purge_ledger_revision !== draft.purge_ledger_revision) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "isolated restore copy receipt diverges from the supplied epoch draft");
  }
  let grants: D1Result<DestinationAuthorityRow>;
  try { grants = await db.prepare("SELECT policy_json,policy_digest,state,authorized_at FROM backup_destination_authority WHERE destination_id=?1 AND policy_digest=?2 AND authorized_at=?3 LIMIT 2")
    .bind(row.destination_id, row.policy_digest, row.authority_authorized_at).all<DestinationAuthorityRow>(); }
  catch (cause) { failBackup("BACKUP_TABLE_MISSING", "isolated restore current destination policy authority is unavailable", true, {}, cause); }
  if (grants.success !== true || !Array.isArray(grants.results)) failBackup("BACKUP_TABLE_MISSING", "isolated restore destination authority returned an unsuccessful or malformed result", true);
  if (grants.results.length !== 1) failBackup("BACKUP_DESTINATION_POLICY_MISMATCH", "isolated restore current destination policy authority is absent or ambiguous");
  const grant = grants.results[0] as DestinationAuthorityRow;
  if (grant.state !== "AUTHORIZED" || grant.policy_digest !== row.policy_digest || grant.authorized_at !== row.authority_authorized_at) failBackup("BACKUP_DESTINATION_POLICY_MISMATCH", "isolated restore destination authority was revoked or rotated");
  const policy = parseJson<BackupDestinationPolicy>(grant.policy_json, "destination policy");
  if (await destinationPolicyDigest(policy) !== row.policy_digest || policy.destination_id !== row.destination_id || policy.failure_domain !== row.failure_domain) failBackup("BACKUP_DESTINATION_POLICY_MISMATCH", "isolated restore current destination policy does not bind its copy receipt");
  const descriptor = await adapter.describe();
  if (descriptor.destination_id !== row.destination_id || descriptor.failure_domain !== row.failure_domain || await destinationDescriptorDigest(descriptor) !== row.descriptor_digest) failBackup("BACKUP_DESTINATION_POLICY_MISMATCH", "isolated restore offsite descriptor diverges from its persisted copy authority");
  return { policy, row };
}

async function openVerifiedManifests(input: IsolatedRestorePreflightInput, policy: BackupDestinationPolicy, row: CopyAuthorityRow): Promise<VerifiedPortableBackupManifests> {
  const draft = input.draft;
  if (draft.part_index.length === 0 || draft.part_index.length > RESTORE_READ_LIMITS.max_parts) failBackup("BACKUP_BOUND_EXCEEDED", "isolated restore part index is empty or exceeds its bound");
  let total = 0;
  const positions = new Set<string>();
  for (const part of draft.part_index) {
    if (!(MANIFESTS as readonly string[]).includes(part.manifest) || !Number.isSafeInteger(part.index) || part.index < 1 || !SHA256.test(part.sha256) || !Number.isSafeInteger(part.size_bytes) || part.size_bytes < 0 || part.size_bytes > RESTORE_READ_LIMITS.max_part_bytes || typeof part.part_key !== "string" || part.part_key.length === 0 || typeof part.etag !== "string" || part.etag.length === 0) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "isolated restore part index contains a malformed entry");
    const position = `${part.manifest}\u0000${part.index}`;
    if (positions.has(position)) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "isolated restore part index contains a duplicate position");
    positions.add(position);
    total += part.size_bytes;
    if (total > RESTORE_READ_LIMITS.max_total_manifest_bytes) failBackup("BACKUP_BOUND_EXCEEDED", "isolated restore manifest bytes exceed their total bound");
  }
  const authority: BackupOffsiteReadAuthority = {
    destination_id: row.destination_id as string,
    key_generation: row.key_generation as string,
    expires_at: row.expires_at as string,
    primary_failure_domain: input.primary.failure_domain,
    destination_policy_digest: row.policy_digest as string,
    descriptor_digest: row.descriptor_digest as string,
  };
  const plaintextParts: PlaintextBackupPart[] = [];
  for (const part of draft.part_index) {
    abortIfNeeded(input.signal);
    const bytes = await openOffsiteBackupPart({
      draft,
      part,
      encryption_key: input.encryption_key,
      destination_policy: policy,
      authority,
      adapter: input.offsite,
    });
    if (bytes.byteLength !== part.size_bytes || bytes.byteLength > RESTORE_READ_LIMITS.max_part_bytes) failBackup("BACKUP_PART_READBACK_MISMATCH", "isolated restore part byte length diverges from the persisted epoch", false, { manifest: part.manifest });
    plaintextParts.push({ manifest: part.manifest, index: part.index, bytes });
  }
  return verifyPortableBackupManifests({ draft, plaintext_parts: plaintextParts });
}

/**
 * Verifies an epoch, its current D1 copy authority, target isolation and schema,
 * current purge frontier, encrypted manifest bytes, and separate restore
 * admission. It performs no payload writes and never asserts traffic readiness.
 */
export async function verifyIsolatedRestorePreflight(input: IsolatedRestorePreflightInput): Promise<IsolatedRestorePreflight> {
  const { draft, primary, target } = input;
  if (draft.manifest_protocol !== BACKUP_MANIFEST_PROTOCOL || draft.part_index.length === 0 || !SHA256.test(draft.vector_digest) || !SHA256.test(draft.purge_ledger_digest)) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "isolated restore epoch draft is incomplete or uses an unknown protocol");
  if (draft.r2_payload_protocol !== BACKUP_R2_PAYLOAD_PROTOCOL || !Array.isArray(draft.payload_part_index)) failBackup("BACKUP_PAYLOAD_UNSUPPORTED", "legacy backup epoch has no authenticated R2 payload index and cannot be restored");
  if (!input.encryption_key || input.encryption_key.type !== "secret" || (input.encryption_key.algorithm as { name?: unknown; length?: unknown }).name !== "AES-GCM" || (input.encryption_key.algorithm as { name?: unknown; length?: unknown }).length !== 256 || !input.encryption_key.usages.includes("decrypt")) failBackup("BACKUP_KEY_INVALID", "isolated restore key must be a decrypt-capable AES-256-GCM secret");
  assertBoundResourceIds(primary, target);
  if (primary.failure_domain === target.failure_domain || primary.db === target.db || primary.evidence_bucket === target.evidence_bucket || primary.work_bucket === target.work_bucket) {
    failBackup("BACKUP_RESTORE_NOT_IMPLEMENTED", "isolated restore requires separately identified primary and target resources in distinct failure domains", false, {});
  }
  const primaryDb = checkedDatabase(primary.db);
  const targetDb = checkedDatabase(target.db);
  const copyAuthority = await assertCurrentCopyAuthority(primaryDb, draft, input.offsite);
  const { policy, row } = copyAuthority;
  const hold = await readBlockingHoldAuthority(primaryDb, draft.epoch_id);
  if (hold !== null) failBackup("BACKUP_PURGE_BLOCKED", "isolated restore is blocked by a current erasure hold", false, {});
  const purge = await currentPurge(primaryDb);
  if (purge.revision !== draft.purge_ledger_revision || purge.digest !== draft.purge_ledger_digest) failBackup("BACKUP_RESTORE_NOT_IMPLEMENTED", "current purge ledger differs from this epoch; exact O4 purge reconciliation is required before restore", false, {});
  if (purge.blocked_count > 0) failBackup("BACKUP_PURGE_BLOCKED", "isolated restore cannot proceed while the current purge ledger includes blocked erasures", false, {});
  await assertNoUnsettledErasure(primaryDb);
  await assertCleanTarget(targetDb);
  await Promise.all([assertEmptyBucket(target.evidence_bucket, input.signal), assertEmptyBucket(target.work_bucket, input.signal)]);
  const expectedNames = TABLE_SPECS.map((spec) => spec.table);
  const [targetGeneration, targetMigrations, targetInventory] = await Promise.all([
    schemaGeneration(targetDb), migrationDigest(targetDb),
    readCoreColumnInventory(targetDb, expectedNames),
  ]);
  const targetInventoryDigest = await digestCoreColumnInventory(targetInventory);
  if (targetGeneration !== draft.schema_generation || targetMigrations !== draft.migration_ledger_digest) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "isolated restore target schema generation or migration ledger does not exactly match the epoch");
  const request: RestoreAdmissionRequest = {
    epoch_id: draft.epoch_id,
    offsite_copy_ref: (BackupEpochSchema.parse(parseJson<BackupEpoch>(row.epoch_json, "offsite copy epoch"))).offsite_copy_ref,
    target_account_id: target.account_id,
    target_failure_domain: target.failure_domain,
    target_environment_ref: target.environment_ref,
    primary_account_id: primary.account_id,
    primary_failure_domain: primary.failure_domain,
    primary_resources: primary.resources,
    target_resources: target.resources,
    migration_ledger_digest: draft.migration_ledger_digest,
    purge_ledger_revision: draft.purge_ledger_revision,
    purge_ledger_digest: draft.purge_ledger_digest,
  };
  await input.admission.assertCurrentAdmission(request);
  abortIfNeeded(input.signal);
  const manifests = await openVerifiedManifests(input, policy, row);
  if (!manifests.payload_supported) failBackup("BACKUP_PAYLOAD_UNSUPPORTED", "backup R2 inventory predates authenticated payload transport and cannot be restored");
  const inventoryLines = manifests.manifests["schema-inventory"] ?? [];
  if (inventoryLines.length !== targetInventory.length + 1) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "isolated restore schema inventory has missing or extra lines");
  const inventoryRecords = inventoryLines.map((line) => {
    if (typeof line !== "object" || line === null || Array.isArray(line)) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "isolated restore schema inventory contains a malformed record");
    return line as Record<string, unknown>;
  });
  const roots = inventoryRecords.filter((record) => record.table === undefined);
  if (roots.length !== 1) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "isolated restore schema inventory must contain exactly one root record");
  const root = roots[0] as Record<string, unknown>;
  if (Object.keys(root).sort().join(",") !== "cut_id,inventory_protocol,protocol,schema_inventory_digest" || root.protocol !== BACKUP_MANIFEST_PROTOCOL || root.inventory_protocol !== BACKUP_SCHEMA_INVENTORY_PROTOCOL || root.schema_inventory_digest !== targetInventoryDigest || root.cut_id !== draft.cut_id) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "isolated restore schema inventory root is unknown or diverges from the target");
  }
  const tableLines = inventoryRecords.filter((record) => record.table !== undefined);
  const seenTables = new Set<string>();
  for (const record of tableLines) {
    if (Object.keys(record).sort().join(",") !== "column_shapes,columns,table" || typeof record.table !== "string" || !Array.isArray(record.columns) || !Array.isArray(record.column_shapes) || seenTables.has(record.table)) {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", "isolated restore schema inventory has an unknown or duplicate table record");
    }
    seenTables.add(record.table);
  }
  if (tableLines.length !== targetInventory.length || targetInventory.some((table) => {
    const found = tableLines.find((record) => record.table === table.table);
    const names = table.columns.map((column) => column.name);
    return found === undefined || canonicalBackupJson(found.columns) !== canonicalBackupJson(names) || canonicalBackupJson(found.column_shapes) !== canonicalBackupJson(table.columns);
  })) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "isolated restore target table inventory diverges from the epoch manifest");
  // Recheck mutable authority and target state after the awaited remote reads.
  const [finalPurge, finalHold, finalCopy] = await Promise.all([
    currentPurge(primaryDb),
    readBlockingHoldAuthority(primaryDb, draft.epoch_id),
    assertCurrentCopyAuthority(primaryDb, draft, input.offsite),
  ]);
  if (finalPurge.revision !== purge.revision || finalPurge.digest !== purge.digest) failBackup("BACKUP_VECTOR_DRIFT", "primary purge ledger changed while isolated restore manifests were being verified", true);
  if (finalPurge.blocked_count > 0) failBackup("BACKUP_PURGE_BLOCKED", "isolated restore cannot proceed while the current purge ledger includes blocked erasures", false, {});
  await assertNoUnsettledErasure(primaryDb);
  if (finalHold !== null) failBackup("BACKUP_PURGE_BLOCKED", "isolated restore became blocked by a current erasure hold", false, {});
  if (finalCopy.row.policy_digest !== row.policy_digest || finalCopy.row.authority_authorized_at !== row.authority_authorized_at || finalCopy.row.descriptor_digest !== row.descriptor_digest) failBackup("BACKUP_DESTINATION_POLICY_MISMATCH", "offsite restore authority changed while manifests were being verified");
  await input.admission.assertCurrentAdmission(request);
  await assertCleanTarget(targetDb);
  await Promise.all([assertEmptyBucket(target.evidence_bucket, input.signal), assertEmptyBucket(target.work_bucket, input.signal)]);
  const [finalGeneration, finalMigrations, finalInventory] = await Promise.all([
    schemaGeneration(targetDb), migrationDigest(targetDb), readCoreColumnInventory(targetDb, expectedNames),
  ]);
  if (finalGeneration !== targetGeneration || finalMigrations !== targetMigrations || await digestCoreColumnInventory(finalInventory) !== targetInventoryDigest) failBackup("BACKUP_VECTOR_DRIFT", "isolated restore target schema changed while manifests were being verified", true);
  return {
    state: "PREFLIGHT_VERIFIED_NO_WRITES", draft, copy_ref: request.offsite_copy_ref,
    target: { account_id: target.account_id, failure_domain: target.failure_domain, environment_ref: target.environment_ref, resources: target.resources },
    manifests, schema_inventory: targetInventory, current_purge: purge,
    offsite_authority: {
      destination_policy: policy,
      read_authority: {
        destination_id: row.destination_id as string,
        key_generation: row.key_generation as string,
        expires_at: row.expires_at as string,
        primary_failure_domain: primary.failure_domain,
        destination_policy_digest: row.policy_digest as string,
        descriptor_digest: row.descriptor_digest as string,
      },
    },
    payload_writes_performed: false, traffic_ready: false,
  };
}
