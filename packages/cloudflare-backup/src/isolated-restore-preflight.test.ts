/// <reference types="node" />
/// <reference types="vite/client" />
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { BackupEpoch, OperationIntent } from "@eliotr/contracts";
import { BACKUP_MANIFEST_PROTOCOL, BACKUP_R2_PAYLOAD_PROTOCOL, BACKUP_SCHEMA_INVENTORY_PROTOCOL, TABLE_SPECS, digestCoreColumnInventory, readCoreColumnInventory } from "@eliotr/backup-o2";
import { rebuildManifestLines } from "@eliotr/backup-o2";
import type { BackupEpochDraft, BackupPartRef } from "@eliotr/backup-o2";
import { destinationDescriptorDigest, destinationPolicyDigest, type BackupDestinationPolicy } from "@eliotr/backup-o2";
import type { OffsiteCopyAdapter, OffsiteStoredPart } from "@eliotr/backup-o2";
import { backupSha256Hex, canonicalBackupJson } from "@eliotr/backup-o2";
import { createD1ErasureRestoreFenceStore } from "@eliotr/cloudflare-erasure";
import { verifyIsolatedRestorePreflight, type IsolatedRestorePreflightInput } from "./isolated-restore-preflight.js";
import { executeIsolatedBackupRestore, type RestoreErasureGate } from "./restore-executor.js";
import {
  buildNativeHistoryArchive,
  digestNativeHistoryArchive,
  expectedNativeHistoryTables,
  NATIVE_HISTORY_TABLES,
  nativeHistoryArchiveSourceContext,
  validateNativeHistoryArchiveSummary,
} from "./restore-native-history.js";
import { createD1RestoreErasureGate } from "./restore-erasure-gate.js";
import { createD1BackupRestoreStore } from "./restore-store.js";
import { makeTestRestoreAdmissionBinding } from "./restore-admission-test-support.js";
import type { RestoreAdmissionRequest } from "./restore-admission.js";

const MIGRATION_DIR = fileURLToPath(new URL("../../../infra/d1/core/migrations/", import.meta.url));
const MANIFEST_NAMES = ["schema", "schema-inventory", "ownership", "sources", "revisions", "projects", "scopes", "handles", "heads", "generations", "retention", "purge", "r2-objects", "rebuild", "vector"] as const;
const NOW = "2026-10-01T00:00:00.000Z";
const EXPIRY = "2030-10-01T00:00:00.000Z";
const SHARED_FENCE_ID = "research-erasure-restore-shared-fence-v1";
const SHARED_FENCE_KIND = "ERASURE_RESTORE_SHARED_FENCE";
const H = (c: string): string => c.repeat(64);

function fixtureIntent(key = "restore-run-1", epochId = "epoch-fixture"): OperationIntent {
  return { intent_ref: { id: "restore-op", revision: 1 }, operation_kind: "RESTORE_VERIFY", principal_ref: "owner-test",
    idempotency_key: key, payload_ref: epochId, policy_decision_ref: "restore-admission-test", created_at: NOW };
}

function d1Database(db: DatabaseSync): D1Database {
  return { prepare(sql: string) {
    const statement = db.prepare(sql);
    const runBound = (params: unknown[]) => ({
      async all<T>(): Promise<D1Result<T>> { return { results: statement.all(...params as never[]) as unknown as T[], success: true, meta: {} } as unknown as D1Result<T>; },
      async first<T>(): Promise<T | null> { return (statement.get(...params as never[]) as T | undefined) ?? null; },
      async run<T>(): Promise<D1Result<T>> { statement.run(...params as never[]); return { results: [], success: true, meta: {} } as unknown as D1Result<T>; },
    });
    return { bind(...params: unknown[]) { return runBound(params); }, ...runBound([]) };
  } } as unknown as D1Database;
}

function failedReadDatabase(database: D1Database, sqlFragment: string): D1Database {
  return { prepare(sql: string) {
    const statement = database.prepare(sql);
    const bound = (params: unknown[]) => {
      const prepared = statement.bind(...params);
      return {
        async all<T>() {
          if (sql.includes(sqlFragment)) return { success: false, results: [] } as unknown as D1Result<T>;
          return prepared.all<T>();
        },
        async first<T>() { return prepared.first<T>(); },
        async run<T>() { return prepared.run<T>(); },
      };
    };
    return { bind(...params: unknown[]) { return bound(params); }, ...bound([]) };
  } } as unknown as D1Database;
}

async function migratedDatabase(): Promise<DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  const files = (await readdir(MIGRATION_DIR)).filter((name) => /^\d{4}_.*\.sql$/u.test(name)).sort();
  for (const name of files) {
    db.exec(await readFile(join(MIGRATION_DIR, name), "utf8"));
    const ledger = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='d1_migrations'").get();
    if (ledger !== undefined) db.prepare("INSERT OR IGNORE INTO d1_migrations(name,applied_at) VALUES(?,?)").run(name, NOW);
  }
  for (const name of files) db.prepare("INSERT OR IGNORE INTO d1_migrations(name,applied_at) VALUES(?,?)").run(name, NOW);
  db.prepare("UPDATE schema_state SET value=?,updated_at=? WHERE key='schema_generation'").run("schema-main-1", NOW);
  return db;
}

function emptyBucket(): R2Bucket {
  return { async list() { return { objects: [], truncated: false, delimitedPrefixes: [] }; } } as unknown as R2Bucket;
}

function fakeRestoreFence(database: DatabaseSync) {
  const leaseOwner = "restore-test-owner";
  const leaseGeneration = 1;
  const now = Date.now();
  const leaseUntil = now + 60_000;
  database.prepare(
    "INSERT INTO operation_execution_lease(operation_id,operation_kind,lease_owner,lease_generation,lease_until,attempt,state,created_at,updated_at) " +
    "VALUES(?,?,?,?,?,1,'LEASED',?,?)",
  ).run(SHARED_FENCE_ID, SHARED_FENCE_KIND, leaseOwner, leaseGeneration, leaseUntil, now, now);
  return {
    kind: "RESTORE" as const, operation_id: SHARED_FENCE_ID, lease_owner: leaseOwner, lease_generation: leaseGeneration,
    async assertCurrent() {
      const row = database.prepare("SELECT lease_owner,lease_generation,lease_until,state FROM operation_execution_lease WHERE operation_id=?")
        .get(SHARED_FENCE_ID) as { lease_owner: string; lease_generation: number; lease_until: number; state: string } | undefined;
      if (row?.lease_owner !== leaseOwner || row.lease_generation !== leaseGeneration || row.lease_until <= Date.now() || row.state !== "LEASED") {
        throw Object.assign(new Error("shared restore fence lost"), { code: "ERASURE_LEASE_LOST" });
      }
    },
    async release() {
      database.prepare("UPDATE operation_execution_lease SET state='FAILED' WHERE operation_id=? AND lease_owner=? AND lease_generation=? AND state='LEASED'")
        .run(SHARED_FENCE_ID, leaseOwner, leaseGeneration);
    },
  };
}

function makeAdapter(descriptor: { destination_id: string; failure_domain: string; supports_deletion_journal: boolean; supports_expiry: boolean; retention_locked: boolean; legal_hold_ref?: string }): OffsiteCopyAdapter & { readonly objects: Map<string, { ciphertext: Uint8Array; stored: Omit<OffsiteStoredPart, "ciphertext"> }> } {
  const objects = new Map<string, { ciphertext: Uint8Array; stored: Omit<OffsiteStoredPart, "ciphertext"> }>();
  return {
    objects,
    describe: () => descriptor,
    async put(ref, ciphertext, stored) { objects.set(ref, { ciphertext: ciphertext.slice(), stored }); return { ack_ref: `ack-${ref}` }; },
    async get(ref) { const value = objects.get(ref); return value === undefined ? null : { ciphertext: value.ciphertext.slice(), stored: value.stored }; },
    async delete(ref) { objects.delete(ref); return { journal_ref: `journal-${ref}` }; },
  };
}

function fixtureColumnValue(kind: string, column: string): unknown {
  if (kind === "text") return column.endsWith("_json") ? "{}" : "fixture";
  if (kind === "text-or-null" || kind === "int-or-null" || kind === "real-or-null") return null;
  if (kind === "int" || kind === "real") return 1;
  throw new Error(`unclassified fixture column kind ${kind}`);
}

async function fixture(options: { readonly includeNativeHistory?: boolean; readonly seedAdmission?: boolean; readonly targetAccountId?: string } = {}): Promise<{ input: IsolatedRestorePreflightInput; primary: DatabaseSync; target: DatabaseSync; adapter: ReturnType<typeof makeAdapter> }> {
  const primary = await migratedDatabase();
  const target = await migratedDatabase();
  const primaryDb = d1Database(primary);
  const targetDb = d1Database(target);
  const inventory = await readCoreColumnInventory(primaryDb, TABLE_SPECS.map((spec) => spec.table));
  const inventoryDigest = await digestCoreColumnInventory(inventory);
  const names = (await readdir(MIGRATION_DIR)).filter((name) => /^\d{4}_.*\.sql$/u.test(name)).sort();
  const migrations = new Set(names);
  const nativeRows = options.includeNativeHistory === true ? NATIVE_HISTORY_TABLES.flatMap((policy) => {
    if (!migrations.has(policy.introduced_by)) return [];
    const spec = TABLE_SPECS.find((entry) => entry.table === policy.table);
    if (spec === undefined) throw new Error(`unmapped native-history table ${policy.table}`);
    const row = Object.fromEntries(Object.entries(spec.columns).map(([column, kind]) => [column, fixtureColumnValue(kind, column)]));
    return [{ table: policy.table, manifest: policy.manifest, row }];
  }) : [];
  const rowsForTable = (table: string) => nativeRows.filter((entry) => entry.table === table).map((entry) => entry.row);
  const migrationDigest = await backupSha256Hex(`migration-ledger\n${names.join("\n")}`);
  const purgeDigest = await backupSha256Hex("");
  const tables = Object.fromEntries(await Promise.all(TABLE_SPECS.map(async (spec) => {
    const schema = inventory.find((entry) => entry.table === spec.table);
    const rows = rowsForTable(spec.table);
    const digest = rows.length === 0
      ? await backupSha256Hex(schema === undefined || schema.columns.length === 0 ? `${spec.table}:TABLE_ABSENT` : `${spec.table}:EMPTY`)
      : await backupSha256Hex(`\n${await backupSha256Hex(rows.map(canonicalBackupJson).sort().join("\n"))}`);
    return [spec.table, { count: rows.length, digest }];
  })));
  const emptyR2Fingerprint = await backupSha256Hex("");
  const vector = {
    schema_generation: "schema-main-1", migration_names: names,
    migration_ledger_digest: migrationDigest, tables, purge_frontier: 0,
    purge_digest: purgeDigest, r2_keys: 0, r2_bytes: 0, r2_digest: emptyR2Fingerprint,
  };
  const vectorDigest = await backupSha256Hex(canonicalBackupJson(vector));
  const manifests: Record<string, string> = Object.fromEntries(MANIFEST_NAMES.map((name) => [name, ""]));
  manifests["schema"] = canonicalBackupJson({ manifest_protocol: BACKUP_MANIFEST_PROTOCOL, schema_generation: "schema-main-1", migration_ledger_digest: migrationDigest, migration_ledger: "PRESENT", migration_count: names.length });
  manifests["schema-inventory"] = [
    canonicalBackupJson({ protocol: BACKUP_MANIFEST_PROTOCOL, inventory_protocol: BACKUP_SCHEMA_INVENTORY_PROTOCOL, schema_inventory_digest: inventoryDigest, cut_id: "cut-restore-test" }),
    ...inventory.map((table) => canonicalBackupJson({ table: table.table, columns: table.columns.map((column) => column.name), column_shapes: table.columns })),
  ].sort().join("\n");
  manifests["heads"] = nativeRows.filter((entry) => entry.manifest === "heads").map((entry) => canonicalBackupJson({ table: entry.table, row: entry.row })).sort().join("\n");
  manifests["generations"] = nativeRows.filter((entry) => entry.manifest === "generations").map((entry) => canonicalBackupJson({ table: entry.table, row: entry.row })).sort().join("\n");
  manifests["purge"] = canonicalBackupJson({ purge_frontier: 0, purge_digest: purgeDigest });
  manifests["r2-objects"] = canonicalBackupJson({ object_count: 0, total_bytes: 0, fingerprint: emptyR2Fingerprint, payload_protocol: BACKUP_R2_PAYLOAD_PROTOCOL });
  manifests["rebuild"] = [...rebuildManifestLines()].sort().join("\n");
  manifests["vector"] = canonicalBackupJson({ protocol: BACKUP_MANIFEST_PROTOCOL, vector, vector_digest: vectorDigest, schema_inventory_digest: inventoryDigest, cut_id: "cut-restore-test", cut_digest: H("b") });
  const manifestDigests: Record<string, string> = {};
  const manifestBytes = new Map<string, Uint8Array>();
  for (const name of MANIFEST_NAMES) {
    const bytes = new TextEncoder().encode(manifests[name] ?? "");
    manifestBytes.set(name, bytes);
    manifestDigests[name] = await backupSha256Hex(bytes);
  }
  const parts: BackupPartRef[] = MANIFEST_NAMES.map((manifest, i) => ({ manifest, index: 1, part_key: `backup/${manifest}`, sha256: manifestDigests[manifest] as string, size_bytes: manifestBytes.get(manifest)?.byteLength ?? 0, etag: `etag-${i}`, existed_identically: false }));
  const group = async (members: readonly string[]): Promise<string> => backupSha256Hex(members.map((name) => `${name}:${manifestDigests[name] ?? "ABSENT"}`).sort().join("\n"));
  const groupDigests = {
    core: await group(["schema", "schema-inventory", "ownership", "sources", "revisions", "projects", "scopes", "handles", "retention", "purge", "vector"]),
    heads: await group(["heads"]), generations: await group(["generations"]), r2: await group(["r2-objects"]),
  };
  const draft: BackupEpochDraft = {
    epoch_id: "epoch-restore-test", schema_generation: "schema-main-1", migration_ledger_digest: migrationDigest,
    manifest_digests: manifestDigests, group_digests: groupDigests, part_index: parts,
    r2_payload_protocol: BACKUP_R2_PAYLOAD_PROTOCOL, payload_part_index: [],
    purge_ledger_revision: 0, purge_ledger_digest: purgeDigest, r2_object_count: 0, r2_total_bytes: 0,
    audit_sample_receipt_ref: "audit-restore-test", vector_digest: vectorDigest,
    vector_manifest_digest: manifestDigests["vector"] as string, cut_id: "cut-restore-test",
    manifest_protocol: BACKUP_MANIFEST_PROTOCOL, created_at: NOW, expires_at: EXPIRY,
  };
  const policy: BackupDestinationPolicy = {
    destination_id: "offsite-test", failure_domain: "offsite-domain", endpoint_identity: "r2://test/bucket",
    supports_deletion_journal: true, supports_expiry: true, retention_locked: false,
    retention_policy_ref: "retention-test", expiry_identity: "expiry-test", policy_version: "v1",
    owner_ref: "owner-test", authorization_receipt_ref: "authz-test",
  };
  const policyDigest = await destinationPolicyDigest(policy);
  const descriptor = { destination_id: policy.destination_id, failure_domain: policy.failure_domain, supports_deletion_journal: true, supports_expiry: true, retention_locked: false };
  const descriptorDigest = await destinationDescriptorDigest(descriptor);
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const adapter = makeAdapter(descriptor);
  const keyGeneration = "key-gen-1";
  const offsiteEpoch: BackupEpoch = {
    epoch_ref: { id: draft.epoch_id, revision: 1 }, schema_generation: draft.schema_generation,
    migration_ledger_digest: draft.migration_ledger_digest, core_export_manifest_ref: "core-group",
    r2_object_manifest_ref: "r2-group", head_manifest_ref: "heads-group", generation_manifest_ref: "generation-group",
    purge_ledger_revision: draft.purge_ledger_revision, purge_ledger_digest: draft.purge_ledger_digest,
    offsite_copy_ref: "offsite-copy-test", offsite_failure_domain: policy.failure_domain,
    encryption_key_generation: keyGeneration, audit_sample_receipt_ref: draft.audit_sample_receipt_ref,
    created_at: draft.created_at, expires_at: draft.expires_at,
  };
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] as BackupPartRef;
    const ref = `offsite/${draft.epoch_id}/${part.manifest}/${String(part.index).padStart(6, "0")}-${part.sha256}`;
    const aad = new TextEncoder().encode(canonicalBackupJson({ epoch_id: draft.epoch_id, manifest: part.manifest, index: part.index, part_ref: ref, part_sha256: part.sha256, destination_policy_digest: policyDigest, key_generation: keyGeneration, expires_at: draft.expires_at, retention_policy_ref: policy.retention_policy_ref, expiry_identity: policy.expiry_identity }));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, new Uint8Array(manifestBytes.get(part.manifest) as Uint8Array)));
    const ciphertext = new Uint8Array(iv.byteLength + sealed.byteLength);
    ciphertext.set(iv); ciphertext.set(sealed, iv.byteLength);
    adapter.objects.set(ref, { ciphertext, stored: { content_digest: part.sha256, size_bytes: part.size_bytes, key_generation: keyGeneration, epoch_id: draft.epoch_id, expires_at: draft.expires_at } });
  }
  const receipt = { receipt_ref: { id: "backup-copy-receipt", revision: 1 }, intent_ref: { id: "backup-intent", revision: 1 }, attempt_id: "backup-attempt", outcome: "SUCCEEDED", output_refs: [draft.epoch_id, offsiteEpoch.offsite_copy_ref], readback_receipt_refs: ["readback"], reconciliation_required: false, reason_codes: [], created_at: NOW };
  const attempt = { attempt_id: "backup-attempt", intent_ref: receipt.intent_ref, attempt_number: 1, state: "SUCCEEDED", started_at: NOW, ended_at: NOW };
  primary.prepare("INSERT INTO backup_epoch_receipt(idempotency_key,intent_id,intent_digest,vector_digest,manifest_digest,epoch_id,receipt_json,draft_json,attempt_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("restore-test-idempotency", "backup-intent", H("1"), vectorDigest, await backupSha256Hex(Object.entries(manifestDigests).sort(([a], [b]) => a.localeCompare(b)).map(([name, digest]) => `${name}:${digest}`).join("\n")), draft.epoch_id, JSON.stringify(receipt), JSON.stringify(draft), JSON.stringify(attempt), NOW);
  primary.prepare("INSERT INTO backup_destination_authority(destination_id,principal_ref,policy_decision_ref,policy_json,policy_digest,authorization_receipt_ref,state,authorized_at,revoked_at) VALUES(?,?,?,?,?,?,'AUTHORIZED',?,NULL)")
    .run(policy.destination_id, "principal-test", "decision-test", JSON.stringify(policy), policyDigest, policy.authorization_receipt_ref, NOW);
  primary.prepare("INSERT INTO backup_offsite_copy_receipt(copy_id,epoch_id,destination_id,key_generation,policy_digest,intent_digest,receipt_json,epoch_json,attempt_json,readback_digest,expires_at,failure_domain,descriptor_digest,authority_authorized_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("copy-test", draft.epoch_id, policy.destination_id, keyGeneration, policyDigest, H("2"), JSON.stringify(receipt), JSON.stringify(offsiteEpoch), JSON.stringify(attempt), H("3"), EXPIRY, policy.failure_domain, descriptorDigest, NOW, NOW);
  const targetIdentity = { account_id: options.targetAccountId ?? "isolated-account", failure_domain: "isolated-domain",
    environment_ref: "restore-target", deployment_ref: "restore-deployment", configuration_sha256: H("8"),
    resources: { core_database: "target-core", evidence_bucket: "target-evidence", work_bucket: "target-work" } };
  const targetProfile = { protocol: "eliotr.backup-restore-target-profile.v1", profile_ref: "restore-target-profile-test", revision: 1, ...targetIdentity, created_at: NOW };
  const profileSha = await backupSha256Hex(canonicalBackupJson(targetProfile));
  const input: IsolatedRestorePreflightInput = {
    draft,
    primary: { account_id: "primary-account", failure_domain: "primary-domain", resources: { core_database: "primary-core", evidence_bucket: "primary-evidence", work_bucket: "primary-work" }, db: primaryDb, evidence_bucket: emptyBucket(), work_bucket: emptyBucket() },
    target: { ...targetIdentity, db: targetDb, evidence_bucket: emptyBucket(), work_bucket: emptyBucket() },
    offsite: adapter, encryption_key: key,
    admission_context: {
      actor: { principal_ref: "owner-test", credential_generation: "access-generation-1", client_class: "owner_pwa", authentication_method: "cloudflare_access", issuer: "https://access.example.test", verified_at: NOW, expires_at: EXPIRY },
      intent: fixtureIntent("restore-preflight-test", draft.epoch_id), permission_ref: "restore-permission-test", permission_revision: 1, target_profile: { profile_ref: targetProfile.profile_ref, revision: targetProfile.revision, profile_sha256: profileSha },
    },
    admission: { async assertCurrentAdmission(request) {
      if (canonicalBackupJson(request.target) !== canonicalBackupJson(targetIdentity) || request.epoch_id !== draft.epoch_id) throw new Error("unbound restore admission request");
      return makeTestRestoreAdmissionBinding(primary, request, { created_at: NOW, persist: options.seedAdmission === true });
    } },
  };
  return { input, primary, target, adapter };
}

describe("isolated restore preflight", () => {
  it("derives exact archive cutoffs from the authenticated 0109-0111 migration prefix", () => {
    const config = "0109_research_provider_key_configuration.sql";
    const modelUse = "0110_research_provider_key_model_use.sql";
    const nativeAuthority = "0111_provider_native_model_authority.sql";
    expect(expectedNativeHistoryTables([])).toHaveLength(0);
    expect(expectedNativeHistoryTables([config])).toHaveLength(1);
    expect(expectedNativeHistoryTables([config, modelUse])).toHaveLength(4);
    expect(expectedNativeHistoryTables([config, modelUse, nativeAuthority])).toHaveLength(10);
    expect(() => expectedNativeHistoryTables([modelUse])).toThrow();
  });

  it("verifies persisted D1 authority, current isolation/schema, and every encrypted manifest without writes", async () => {
    const f = await fixture();
    try {
      const verified = await verifyIsolatedRestorePreflight(f.input);
      expect(verified.state).toBe("PREFLIGHT_VERIFIED_NO_WRITES");
      expect(verified.payload_writes_performed).toBe(false);
      expect(verified.traffic_ready).toBe(false);
      expect(Object.keys(verified.manifests.manifests).length).toBe(MANIFEST_NAMES.length);
      expect(f.target.prepare("SELECT COUNT(*) AS n FROM source").get()).toEqual({ n: 0 });
    } finally { f.primary.close(); f.target.close(); }
  });

  it("acquires the D1 restore gate only after current purge, terminal-target, and epoch-obligation reconciliation", async () => {
    const f = await fixture();
    try {
      const verified = await verifyIsolatedRestorePreflight(f.input);
      const gate = createD1RestoreErasureGate();
      const fence = await gate.acquire({
        primary_database: f.input.primary.db,
        draft: verified.draft,
        current_purge: verified.current_purge,
        manifests: verified.manifests,
        target: verified.target,
      });
      expect(fence.state).toBe("ACQUIRED");
      expect(fence.terminal_erasure_targets_verified).toBe(true);
      expect(fence.backup_obligations_verified).toBe(true);
      expect(fence.backup_obligations).toEqual([]);
      await fence.assertCurrent();
      await fence.release();
    } finally { f.primary.close(); f.target.close(); }
  });

  it("records a real isolated data-restore receipt as unqualified and keeps traffic closed", async () => {
    const f = await fixture({ includeNativeHistory: true, seedAdmission: true });
    try {
      const intent = fixtureIntent("restore-run-1", f.input.draft.epoch_id);
      const preflight = { ...f.input, admission_context: { ...f.input.admission_context, intent } };
      const verified = await verifyIsolatedRestorePreflight(preflight);
      const archiveSource = nativeHistoryArchiveSourceContext(verified.draft, verified.manifests, verified.copy_ref);
      const gate: RestoreErasureGate = {
        async acquire(request) {
          return {
            state: "ACQUIRED", epoch_id: request.draft.epoch_id,
            purge_ledger_revision: request.current_purge.revision, purge_ledger_digest: request.current_purge.digest,
            epoch_subject_scope_digest: H("6"), obligation_inventory_digest: H("7"),
            terminal_erasure_targets_verified: true, backup_obligations_verified: true,
            unsettled_erasure_count: 0, backup_obligations: [], shared_execution_fence: fakeRestoreFence(f.primary),
            async assertCurrent() {}, async release() {},
          };
        },
      };
      const result = await executeIsolatedBackupRestore({
        intent, preflight, erasure_gate: gate, restore_store: createD1BackupRestoreStore(d1Database(f.primary)),
      });
      expect(result.state).toBe("RESTORED_UNQUALIFIED");
      expect(result.traffic_ready).toBe(false);
      expect(result.receipt.unresolved_acceptance).toContain("ERASURE_RESTORE_ACCEPTANCE");
      expect(result.receipt.protocol).toBe("eliotr.backup-restore.v2");
      if (result.receipt.protocol !== "eliotr.backup-restore.v2") throw new Error("new restore did not write a v2 archive receipt");
      const archive = result.receipt.native_history_archive;
      const expectedArchiveTables = NATIVE_HISTORY_TABLES.filter((entry) => archiveSource.source.migration_names.includes(entry.introduced_by));
      expect(archive.tables.map((entry) => entry.table)).toEqual(expectedArchiveTables.map((entry) => entry.table));
      expect(archive.tables.every((entry) => entry.source_row_count === 1 && entry.target_row_count === 0)).toBe(true);
      expect(result.receipt.restored_core_row_count).toBe(0);
      for (const entry of archive.tables) {
        expect(f.target.prepare(`SELECT COUNT(*) AS n FROM "${entry.table}"`).get()).toEqual({ n: 0 });
      }
      expect(f.target.prepare("SELECT COUNT(*) AS n FROM source").get()).toEqual({ n: 0 });
      expect(f.primary.prepare("SELECT state FROM backup_restore_intent").get()).toEqual({ state: "RESTORED_UNQUALIFIED" });
    } finally { f.primary.close(); f.target.close(); }
  });

  it("rejects forged native-history subsets and archive count or digest drift against the verified epoch", async () => {
    const f = await fixture({ includeNativeHistory: true });
    try {
      const verified = await verifyIsolatedRestorePreflight(f.input);
      const context = nativeHistoryArchiveSourceContext(verified.draft, verified.manifests, verified.copy_ref);
      const archive = await buildNativeHistoryArchive({ draft: verified.draft, manifests: verified.manifests, offsite_copy_ref: verified.copy_ref,
        target: f.input.target.db, async assertCurrentFence() {} });
      const nonemptyTarget = { prepare() { return { async all() { return { success: true, results: [{ present: 1 }], meta: {} }; } }; } } as unknown as D1Database;
      await expect(buildNativeHistoryArchive({ draft: verified.draft, manifests: verified.manifests, offsite_copy_ref: verified.copy_ref,
        target: nonemptyTarget, async assertCurrentFence() {} })).rejects.toMatchObject({ code: "BACKUP_RESTORE_UNCERTAIN" });
      const reseal = async (value: typeof archive) => ({
        ...value,
        archive_digest: await digestNativeHistoryArchive({ protocol: value.protocol, disposition: value.disposition, source: value.source, tables: value.tables,
          source_row_count: value.source_row_count, source_rows_sha256: value.source_rows_sha256, target_readback_digest: value.target_readback_digest }),
      });
      const firstArchiveTable = archive.tables[0];
      if (firstArchiveTable === undefined) throw new Error("native-history fixture must contain an archive table");
      const cases = [
        { ...archive, tables: archive.tables.slice(1) },
        { ...archive, tables: [firstArchiveTable, ...archive.tables.slice(0, -1)] },
        { ...archive, tables: archive.tables.map((entry, index) => index === 0 ? { ...entry, table: "unknown-native-history" } : entry) },
        { ...archive, tables: archive.tables.map((entry, index) => index === 0 ? { ...entry, source_row_count: entry.source_row_count + 1 } : entry) },
        { ...archive, tables: archive.tables.map((entry, index) => index === 0 ? { ...entry, source_rows_sha256: H("f") } : entry) },
        { ...archive, source: { ...archive.source, manifest_groups: { ...archive.source.manifest_groups, heads: { ...archive.source.manifest_groups.heads, group_sha256: H("f") } } } },
      ];
      for (const candidate of cases) {
        await expect(validateNativeHistoryArchiveSummary(await reseal(candidate), context)).rejects.toMatchObject({ code: "BACKUP_VECTOR_UNVERIFIABLE" });
      }
      await expect(validateNativeHistoryArchiveSummary({ ...archive, archive_digest: H("0") }, context)).rejects.toMatchObject({ code: "BACKUP_VECTOR_UNVERIFIABLE" });
    } finally { f.primary.close(); f.target.close(); }
  });

  it("refuses an epoch with a current O4 backup obligation before any target write", async () => {
    const f = await fixture();
    try {
      const gate: RestoreErasureGate = {
        async acquire(request) {
          return {
            state: "ACQUIRED", epoch_id: request.draft.epoch_id,
            purge_ledger_revision: request.current_purge.revision, purge_ledger_digest: request.current_purge.digest,
            epoch_subject_scope_digest: H("6"), obligation_inventory_digest: H("7"),
            terminal_erasure_targets_verified: true, backup_obligations_verified: true,
            unsettled_erasure_count: 0,
            backup_obligations: [{ kind: "BACKUP_PURGE", erasure_id: "erase-1", erasure_revision: 1, backup_epoch_id: request.draft.epoch_id,
              target_id: "backup-target-1", state: "ABSENT", delete_receipt_ref: "delete-receipt", absence_receipt_ref: "absence-receipt", policy_or_hold_ref: null }],
            shared_execution_fence: fakeRestoreFence(f.primary),
            async assertCurrent() {}, async release() {},
          };
        },
      };
      const restoreStore = createD1BackupRestoreStore(d1Database(f.primary));
      const intent = fixtureIntent("restore-run-erased", f.input.draft.epoch_id);
      const preflight = { ...f.input, admission_context: { ...f.input.admission_context, intent } };
      await expect(executeIsolatedBackupRestore({
        intent, preflight, erasure_gate: gate, restore_store: restoreStore,
      })).rejects.toMatchObject({ code: "BACKUP_PURGE_BLOCKED" });
      expect(f.target.prepare("SELECT COUNT(*) AS n FROM source").get()).toEqual({ n: 0 });
      expect(f.primary.prepare("SELECT COUNT(*) AS n FROM backup_restore_intent").get()).toEqual({ n: 0 });
    } finally { f.primary.close(); f.target.close(); }
  });

  it("rejects a same-domain target before offsite reads", async () => {
    const f = await fixture();
    try {
      const input = { ...f.input, target: { ...f.input.target, failure_domain: "primary-domain" } };
      await expect(verifyIsolatedRestorePreflight(input)).rejects.toMatchObject({ code: "BACKUP_RESTORE_NOT_IMPLEMENTED" });
    } finally { f.primary.close(); f.target.close(); }
  });

  it("permits a separately identified staging target in the same account", async () => {
    const f = await fixture({ targetAccountId: "primary-account" });
    try {
      const result = await verifyIsolatedRestorePreflight(f.input);
      expect(result.state).toBe("PREFLIGHT_VERIFIED_NO_WRITES");
    } finally { f.primary.close(); f.target.close(); }
  });

  it("refuses any existing target D1 data before opening encrypted parts", async () => {
    const f = await fixture();
    try {
      f.target.prepare("INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref,default_model_profile_ref,default_depth_profile_ref,generation,created_at) VALUES('target-project','t','exact','r','s','m','d',1,?)").run(NOW);
      const originalGet = f.input.offsite.get.bind(f.input.offsite);
      let reads = 0;
      f.input.offsite.get = async (...args) => { reads += 1; return originalGet(...args); };
      await expect(verifyIsolatedRestorePreflight(f.input)).rejects.toMatchObject({ code: "BACKUP_RESTORE_NOT_IMPLEMENTED" });
      expect(reads).toBe(0);
    } finally { f.primary.close(); f.target.close(); }
  });

  it("blocks a later purge before reading offsite bytes or writing to the isolated target", async () => {
    const f = await fixture();
    try {
      // The epoch was captured with an empty purge ledger. This row is a
      // later erasure, so restore must stop before opening the offsite copy
      // or exposing any bytes in the isolated target.
      f.primary.prepare("INSERT INTO purge_ledger(erasure_id,non_revealing_subject_digest,disposition,receipt_ref,created_at) VALUES(?,?,?,?,?)").run("erasure-new", H("4"), "COMPLETE", "receipt-new", NOW);
      let offsiteReads = 0;
      const originalGet = f.input.offsite.get.bind(f.input.offsite);
      const offsite = { ...f.input.offsite, async get(ref: string) { offsiteReads += 1; return originalGet(ref); } };
      const targetWrites: string[] = [];
      const trackTargetWrites = (bucket: R2Bucket, name: string): R2Bucket => ({
        ...bucket,
        async put() { targetWrites.push(name); throw new Error("preflight must never write target payloads"); },
      } as unknown as R2Bucket);
      const input = {
        ...f.input,
        offsite,
        target: {
          ...f.input.target,
          evidence_bucket: trackTargetWrites(f.input.target.evidence_bucket, "evidence"),
          work_bucket: trackTargetWrites(f.input.target.work_bucket, "work"),
        },
      };
      await expect(verifyIsolatedRestorePreflight(input)).rejects.toMatchObject({ code: "BACKUP_RESTORE_NOT_IMPLEMENTED" });
      expect(offsiteReads).toBe(0);
      expect(targetWrites).toEqual([]);
      expect(f.adapter.objects.size).toBe(MANIFEST_NAMES.length);
      expect(f.target.prepare("SELECT COUNT(*) AS n FROM source").get()).toEqual({ n: 0 });
    } finally { f.primary.close(); f.target.close(); }
  });

  it("fails closed when D1 reports an unsuccessful purge-ledger result with an empty result array", async () => {
    const f = await fixture();
    try {
      const input = { ...f.input, primary: { ...f.input.primary, db: failedReadDatabase(f.input.primary.db, "FROM purge_ledger") } };
      await expect(verifyIsolatedRestorePreflight(input)).rejects.toMatchObject({ code: "BACKUP_TABLE_MISSING" });
      expect(f.target.prepare("SELECT COUNT(*) AS n FROM source").get()).toEqual({ n: 0 });
    } finally { f.primary.close(); f.target.close(); }
  });

  it("rechecks the primary purge frontier after manifest reads", async () => {
    const f = await fixture();
    try {
      let changed = false;
      const originalGet = f.input.offsite.get.bind(f.input.offsite);
      f.input.offsite.get = async (...args) => {
        if (!changed) {
          changed = true;
          f.primary.prepare("INSERT INTO purge_ledger(erasure_id,non_revealing_subject_digest,disposition,receipt_ref,created_at) VALUES(?,?,?,?,?)").run("erasure-race", H("5"), "COMPLETE", "receipt-race", NOW);
        }
        return originalGet(...args);
      };
      await expect(verifyIsolatedRestorePreflight(f.input)).rejects.toMatchObject({ code: "BACKUP_VECTOR_DRIFT" });
      expect(f.target.prepare("SELECT COUNT(*) AS n FROM source").get()).toEqual({ n: 0 });
    } finally { f.primary.close(); f.target.close(); }
  });

  it("rejects reusing a primary resource ID even when the injected binding object differs", async () => {
    const f = await fixture();
    try {
      const input = { ...f.input, target: { ...f.input.target, resources: { ...f.input.target.resources, evidence_bucket: f.input.primary.resources.evidence_bucket } } };
      await expect(verifyIsolatedRestorePreflight(input)).rejects.toMatchObject({ code: "BACKUP_RESTORE_NOT_IMPLEMENTED" });
      expect(f.target.prepare("SELECT COUNT(*) AS n FROM source").get()).toEqual({ n: 0 });
    } finally { f.primary.close(); f.target.close(); }
  });

  it("rejects authenticated ciphertext mutation without leaking plaintext or marking readiness", async () => {
    const f = await fixture();
    try {
      const ref = [...f.adapter.objects.keys()][0] as string;
      const item = f.adapter.objects.get(ref) as { ciphertext: Uint8Array; stored: Omit<OffsiteStoredPart, "ciphertext"> };
      item.ciphertext[item.ciphertext.length - 1] = (item.ciphertext[item.ciphertext.length - 1] ?? 0) ^ 1;
      await expect(verifyIsolatedRestorePreflight(f.input)).rejects.toMatchObject({ code: "BACKUP_OFFSITE_READBACK_MISMATCH" });
      expect(f.target.prepare("SELECT COUNT(*) AS n FROM source").get()).toEqual({ n: 0 });
    } finally { f.primary.close(); f.target.close(); }
  });

  it("bounds ciphertext before authenticated decryption", async () => {
    const f = await fixture();
    try {
      const originalGet = f.input.offsite.get.bind(f.input.offsite);
      f.input.offsite.get = async (ref) => {
        const stored = await originalGet(ref);
        if (stored === null) return null;
        return { ...stored, ciphertext: new Uint8Array(stored.stored.size_bytes + 29) };
      };
      await expect(verifyIsolatedRestorePreflight(f.input)).rejects.toMatchObject({ code: "BACKUP_PART_READBACK_MISMATCH" });
      expect(f.target.prepare("SELECT COUNT(*) AS n FROM source").get()).toEqual({ n: 0 });
    } finally { f.primary.close(); f.target.close(); }
  });

  it("rechecks restore admission after decryption", async () => {
    const f = await fixture();
    try {
      let checks = 0;
      const input = { ...f.input, admission: { async assertCurrentAdmission(request: RestoreAdmissionRequest) {
        checks += 1;
        if (checks > 1) throw new Error("restore admission revoked");
        return makeTestRestoreAdmissionBinding(f.primary, request, { created_at: NOW });
      } } };
      await expect(verifyIsolatedRestorePreflight(input)).rejects.toThrow("restore admission revoked");
      expect(checks).toBe(2);
      expect(f.target.prepare("SELECT COUNT(*) AS n FROM source").get()).toEqual({ n: 0 });
    } finally { f.primary.close(); f.target.close(); }
  });

  it("requires a distinct, current target admission before decrypting", async () => {
    const f = await fixture();
    try {
      let reads = 0;
      const get = f.input.offsite.get.bind(f.input.offsite);
      f.input.offsite.get = async (...args) => { reads += 1; return get(...args); };
      const input = { ...f.input, admission: { async assertCurrentAdmission() { throw new Error("not admitted"); } } };
      await expect(verifyIsolatedRestorePreflight(input)).rejects.toThrow("not admitted");
      expect(reads).toBe(0);
    } finally { f.primary.close(); f.target.close(); }
  });

  it("keeps O4 blocked after the shared lease TTL while an R2 PUT may still settle", async () => {
    const f = await fixture({ seedAdmission: true });
    try {
      let nowMs = Date.now();
      const database = d1Database(f.primary);
      const fences = createD1ErasureRestoreFenceStore({ database, now: () => nowMs, lease_ms: 1_000 });
      const restoreFence = await fences.acquireRestore("restore-race-late-r2");
      expect(restoreFence).not.toBeNull();
      if (restoreFence === null) throw new Error("restore did not acquire the shared fence");

      const verified = await verifyIsolatedRestorePreflight(f.input);
      const request = { intent: f.input.admission_context.intent, epoch_id: f.input.draft.epoch_id,
        offsite_copy_ref: verified.copy_ref, target: verified.target, admission: verified.admission_binding };
      const restoreStore = createD1BackupRestoreStore(database);
      const claim = await restoreStore.claim(request, nowMs);
      if (claim.state !== "READY") throw new Error("restore intent was not admitted");
      const attempt = await restoreStore.beginAttempt(claim, request, restoreFence, nowMs);

      const lateObjects = new Set<string>();
      let settlePut!: () => void;
      const putInFlight = new Promise<void>((resolve) => { settlePut = resolve; })
        .then(() => { lateObjects.add("late/evidence-object"); });
      let putSettled = false;
      void putInFlight.then(() => { putSettled = true; });

      // Expire only the timestamp. The durable ATTEMPTING intent and exact
      // shared fence generation remain the authority while the provider call
      // is unresolved; O4 cannot steal the lease and purge a stale manifest.
      nowMs += 1_001;
      const duringPut = await fences.acquireErasure({ erasure_id: "erase-late-put", revision: 1 });
      expect(duringPut).toBeNull();
      expect(putSettled).toBe(false);

      settlePut();
      await putInFlight;
      expect(putSettled).toBe(true);
      lateObjects.delete("late/evidence-object");
      expect(lateObjects.size).toBe(0);
      await restoreStore.markUnknown(attempt, "BACKUP_RESTORE_UNCERTAIN", nowMs + 1);
      const afterUnknown = await fences.acquireErasure({ erasure_id: "erase-late-put", revision: 1 });
      expect(afterUnknown).toBeNull();
      expect(f.primary.prepare("SELECT state FROM backup_restore_intent").get()).toEqual({ state: "UNKNOWN" });
    } finally { f.primary.close(); f.target.close(); }
  });
});
