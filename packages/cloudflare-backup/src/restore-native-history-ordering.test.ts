/// <reference types="node" />
/// <reference types="vite/client" />
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { OperationIntent } from "@eliotr/contracts";
import {
  BACKUP_MANIFEST_PROTOCOL, BACKUP_R2_PAYLOAD_PROTOCOL, BACKUP_SCHEMA_INVENTORY_PROTOCOL,
  TABLE_SPECS, backupR2ObjectIdentity, backupSha256Hex, canonicalBackupJson,
  destinationDescriptorDigest, destinationPolicyDigest, digestCoreColumnInventory, readCoreColumnInventory,
  type BackupDestinationPolicy, type BackupPartRef,
} from "@eliotr/backup-o2";
import type { BackupEpoch } from "@eliotr/contracts";
import type { BackupEpochDraft, OffsiteCopyAdapter, OffsiteStoredPart } from "@eliotr/backup-o2";
import { rebuildManifestLines } from "@eliotr/backup-o2";
import type { IsolatedRestorePreflightInput } from "./isolated-restore-preflight.js";
import { executeIsolatedBackupRestore, type RestoreErasureGate } from "./restore-executor.js";
import { createD1BackupRestoreStore } from "./restore-store.js";

const MIGRATION_DIR = fileURLToPath(new URL("../../../infra/d1/core/migrations/", import.meta.url));
const MANIFEST_NAMES = ["schema", "schema-inventory", "ownership", "sources", "revisions", "projects", "scopes", "handles", "heads", "generations", "retention", "purge", "r2-objects", "rebuild", "vector"] as const;
const NOW = "2026-10-01T00:00:00.000Z";
const EXPIRY = "2030-10-01T00:00:00.000Z";
const FENCE_ID = "research-erasure-restore-shared-fence-v1";
const FENCE_KIND = "ERASURE_RESTORE_SHARED_FENCE";
const H = (value: string): string => value.repeat(64);
const NATIVE_EMPTY_QUERY = 'SELECT 1 AS present FROM "research_provider_key_configuration_operation" LIMIT 1';

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

interface ContaminationState {
  put_reached: boolean;
  native_row_present: boolean;
  delete_count: number;
}

function d1Database(database: DatabaseSync, contamination?: ContaminationState): D1Database {
  return { prepare(sql: string) {
    const statement = database.prepare(sql);
    const bound = (params: unknown[]) => ({
      async all<T>(): Promise<D1Result<T>> {
        const rows = statement.all(...params as never[]) as unknown as T[];
        if (sql === NATIVE_EMPTY_QUERY && contamination?.native_row_present === true) {
          return { results: [{ present: 1 } as unknown as T], success: true, meta: {} } as unknown as D1Result<T>;
        }
        return { results: rows, success: true, meta: {} } as unknown as D1Result<T>;
      },
      async first<T>(): Promise<T | null> { return (statement.get(...params as never[]) as T | undefined) ?? null; },
      async run<T>(): Promise<D1Result<T>> { statement.run(...params as never[]); return { results: [], success: true, meta: {} } as unknown as D1Result<T>; },
    });
    return { bind(...params: unknown[]) { return bound(params); }, ...bound([]) };
  } } as unknown as D1Database;
}

async function migratedDatabase(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  const migrations = (await readdir(MIGRATION_DIR)).filter((name) => /^\d{4}_.*\.sql$/u.test(name)).sort();
  for (const name of migrations) {
    database.exec(await readFile(join(MIGRATION_DIR, name), "utf8"));
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='d1_migrations'").get() !== undefined) {
      database.prepare("INSERT OR IGNORE INTO d1_migrations(name,applied_at) VALUES(?,?)").run(name, NOW);
    }
  }
  for (const name of migrations) database.prepare("INSERT OR IGNORE INTO d1_migrations(name,applied_at) VALUES(?,?)").run(name, NOW);
  database.prepare("UPDATE schema_state SET value=?,updated_at=? WHERE key='schema_generation'").run("schema-main-1", NOW);
  return database;
}

function fixtureColumnValue(kind: string, column: string): unknown {
  if (kind === "text") return column.endsWith("_json") ? "{}" : "fixture";
  if (kind.endsWith("-or-null")) return null;
  if (kind === "int" || kind === "real") return 1;
  throw new Error(`unclassified fixture column kind ${kind}`);
}

function emptyBucket(): R2Bucket {
  return { async list() { return { objects: [], truncated: false, delimitedPrefixes: [] }; } } as unknown as R2Bucket;
}

function workTargetBucket(contamination: ContaminationState): { readonly bucket: R2Bucket; readonly objects: Map<string, { readonly custom: Record<string, string>; readonly http: R2HTTPMetadata | Headers }>; } {
  const objects = new Map<string, { readonly custom: Record<string, string>; readonly http: R2HTTPMetadata | Headers }>();
  const bucket = {
    async list() { return { objects: [], truncated: false, delimitedPrefixes: [] }; },
    async put(key: string, body: ReadableStream<Uint8Array>, options?: R2PutOptions) {
      const reader = body.getReader();
      for (;;) { const next = await reader.read(); if (next.done) break; }
      objects.set(key, { custom: options?.customMetadata ?? {}, http: options?.httpMetadata ?? {} });
      contamination.put_reached = true;
      contamination.native_row_present = true;
      return { key, version: "target-version", size: 0, etag: "target-etag" };
    },
    async get(key: string) {
      const stored = objects.get(key);
      if (stored === undefined) return null;
      return {
        key, version: "target-version", size: 0, etag: "target-etag",
        customMetadata: stored.custom, httpMetadata: stored.http,
        body: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
      };
    },
    async delete(key: string) { contamination.delete_count += 1; objects.delete(key); return {}; },
  } as unknown as R2Bucket;
  return { bucket, objects };
}

function makeAdapter(descriptor: { destination_id: string; failure_domain: string; supports_deletion_journal: boolean; supports_expiry: boolean; retention_locked: boolean }): OffsiteCopyAdapter & { readonly objects: Map<string, { ciphertext: Uint8Array; stored: Omit<OffsiteStoredPart, "ciphertext"> }> } {
  const objects = new Map<string, { ciphertext: Uint8Array; stored: Omit<OffsiteStoredPart, "ciphertext"> }>();
  return {
    objects,
    describe: () => descriptor,
    async put(ref, ciphertext, stored) { objects.set(ref, { ciphertext: ciphertext.slice(), stored }); return { ack_ref: `ack-${ref}` }; },
    async get(ref) { const value = objects.get(ref); return value === undefined ? null : { ciphertext: value.ciphertext.slice(), stored: value.stored }; },
    async delete(ref) { objects.delete(ref); return { journal_ref: `journal-${ref}` }; },
  };
}

async function fixture(): Promise<{
  readonly input: IsolatedRestorePreflightInput;
  readonly primary: DatabaseSync;
  readonly target: DatabaseSync;
  readonly contamination: ContaminationState;
  readonly targetObjects: ReturnType<typeof workTargetBucket>["objects"];
}> {
  const primary = await migratedDatabase();
  const target = await migratedDatabase();
  const primaryDb = d1Database(primary);
  const contamination: ContaminationState = { put_reached: false, native_row_present: false, delete_count: 0 };
  const targetDb = d1Database(target, contamination);
  const inventory = await readCoreColumnInventory(primaryDb, TABLE_SPECS.map((spec) => spec.table));
  const inventoryDigest = await digestCoreColumnInventory(inventory);
  const names = (await readdir(MIGRATION_DIR)).filter((name) => /^\d{4}_.*\.sql$/u.test(name)).sort();
  const migrationSet = new Set(names);
  const nativeRows = TABLE_SPECS.filter((spec) => spec.table === "research_provider_key_configuration_operation" && migrationSet.has("0109_research_provider_key_configuration.sql"))
    .map((spec) => ({ table: spec.table, row: Object.fromEntries(Object.entries(spec.columns).map(([column, kind]) => [column, fixtureColumnValue(kind, column)])) }));
  const rowsByTable = new Map(nativeRows.map((entry) => [entry.table, [entry.row]]));
  const migrationDigest = await backupSha256Hex(`migration-ledger\n${names.join("\n")}`);
  const purgeDigest = await backupSha256Hex("");
  const tables = Object.fromEntries(await Promise.all(TABLE_SPECS.map(async (spec) => {
    const schema = inventory.find((entry) => entry.table === spec.table);
    const rows = rowsByTable.get(spec.table) ?? [];
    const digest = rows.length === 0
      ? await backupSha256Hex(schema === undefined || schema.columns.length === 0 ? `${spec.table}:TABLE_ABSENT` : `${spec.table}:EMPTY`)
      : await backupSha256Hex(`\n${await backupSha256Hex(rows.map(canonicalBackupJson).sort().join("\n"))}`);
    return [spec.table, { count: rows.length, digest }];
  })));
  const objectBytes = new Uint8Array(0);
  const objectSha = await backupSha256Hex(objectBytes);
  const customMetadata: Record<string, string> = {};
  const httpMetadata: Record<string, string> = {};
  const r2Entry = {
    bucket: "work" as const, key: "empty-object", size_bytes: 0, etag: "source-etag", version: "source-version",
    sha256: objectSha, admitted_sha256: null,
    metadata_digest: await backupSha256Hex(canonicalBackupJson(customMetadata)),
    http_metadata_digest: await backupSha256Hex(canonicalBackupJson(httpMetadata)),
    custom_metadata: customMetadata, http_metadata: httpMetadata,
    payload_protocol: BACKUP_R2_PAYLOAD_PROTOCOL,
    payload_parts: [{ index: 1, sha256: objectSha, size_bytes: 0 }],
  };
  const r2Fingerprint = await backupSha256Hex(canonicalBackupJson(r2Entry));
  const vector = {
    schema_generation: "schema-main-1", migration_names: names, migration_ledger_digest: migrationDigest, tables,
    purge_frontier: 0, purge_digest: purgeDigest, r2_keys: 1, r2_bytes: 0, r2_digest: r2Fingerprint,
  };
  const vectorDigest = await backupSha256Hex(canonicalBackupJson(vector));
  const manifests: Record<string, string> = Object.fromEntries(MANIFEST_NAMES.map((name) => [name, ""]));
  manifests["schema"] = canonicalBackupJson({ manifest_protocol: BACKUP_MANIFEST_PROTOCOL, schema_generation: "schema-main-1", migration_ledger_digest: migrationDigest, migration_ledger: "PRESENT", migration_count: names.length });
  manifests["schema-inventory"] = [
    canonicalBackupJson({ protocol: BACKUP_MANIFEST_PROTOCOL, inventory_protocol: BACKUP_SCHEMA_INVENTORY_PROTOCOL, schema_inventory_digest: inventoryDigest, cut_id: "cut-r2-ordering" }),
    ...inventory.map((table) => canonicalBackupJson({ table: table.table, columns: table.columns.map((column) => column.name), column_shapes: table.columns })),
  ].sort().join("\n");
  manifests["heads"] = nativeRows.map((entry) => canonicalBackupJson({ table: entry.table, row: entry.row })).sort().join("\n");
  manifests["generations"] = "";
  manifests["purge"] = canonicalBackupJson({ purge_frontier: 0, purge_digest: purgeDigest });
  manifests["r2-objects"] = [canonicalBackupJson({ object_count: 1, total_bytes: 0, fingerprint: r2Fingerprint, payload_protocol: BACKUP_R2_PAYLOAD_PROTOCOL }), canonicalBackupJson(r2Entry)].sort().join("\n");
  manifests["rebuild"] = [...rebuildManifestLines()].sort().join("\n");
  manifests["vector"] = canonicalBackupJson({ protocol: BACKUP_MANIFEST_PROTOCOL, vector, vector_digest: vectorDigest, schema_inventory_digest: inventoryDigest, cut_id: "cut-r2-ordering", cut_digest: H("b") });

  const manifestDigests: Record<string, string> = {};
  const manifestBytes = new Map<string, Uint8Array>();
  for (const name of MANIFEST_NAMES) {
    const bytes = new TextEncoder().encode(manifests[name] ?? "");
    manifestBytes.set(name, bytes);
    manifestDigests[name] = await backupSha256Hex(bytes);
  }
  const parts: BackupPartRef[] = MANIFEST_NAMES.map((manifest, index) => ({ manifest, index: 1, part_key: `backup/${manifest}`, sha256: manifestDigests[manifest] as string, size_bytes: manifestBytes.get(manifest)?.byteLength ?? 0, etag: `etag-${index}`, existed_identically: false }));
  const group = async (members: readonly string[]): Promise<string> => backupSha256Hex(members.map((name) => `${name}:${manifestDigests[name] ?? "ABSENT"}`).sort().join("\n"));
  const groupDigests = {
    core: await group(["schema", "schema-inventory", "ownership", "sources", "revisions", "projects", "scopes", "handles", "retention", "purge", "vector"]),
    heads: await group(["heads"]), generations: await group(["generations"]), r2: await group(["r2-objects"]),
  };
  const epochId = "epoch-r2-ordering";
  const payloadIdentity = await backupR2ObjectIdentity(r2Entry);
  const payloadPartKey = `backup-parts/${epochId}/r2-payload/${payloadIdentity}/000001-${objectSha}`;
  const payloadPart = { object_identity_digest: payloadIdentity, index: 1, count: 1, part_key: payloadPartKey, sha256: objectSha, size_bytes: 0, etag: "payload-etag", existed_identically: false };
  const draft: BackupEpochDraft = {
    epoch_id: epochId, schema_generation: "schema-main-1", migration_ledger_digest: migrationDigest,
    manifest_digests: manifestDigests, group_digests: groupDigests, part_index: parts,
    r2_payload_protocol: BACKUP_R2_PAYLOAD_PROTOCOL, payload_part_index: [payloadPart],
    purge_ledger_revision: 0, purge_ledger_digest: purgeDigest, r2_object_count: 1, r2_total_bytes: 0,
    audit_sample_receipt_ref: "audit-r2-ordering", vector_digest: vectorDigest,
    vector_manifest_digest: manifestDigests["vector"] as string, cut_id: "cut-r2-ordering",
    manifest_protocol: BACKUP_MANIFEST_PROTOCOL, created_at: NOW, expires_at: EXPIRY,
  };
  const policy: BackupDestinationPolicy = {
    destination_id: "offsite-ordering", failure_domain: "offsite-domain", endpoint_identity: "r2://test/bucket",
    supports_deletion_journal: true, supports_expiry: true, retention_locked: false,
    retention_policy_ref: "retention-ordering", expiry_identity: "expiry-ordering", policy_version: "v1",
    owner_ref: "owner-ordering", authorization_receipt_ref: "authz-ordering",
  };
  const policyDigest = await destinationPolicyDigest(policy);
  const descriptor = { destination_id: policy.destination_id, failure_domain: policy.failure_domain, supports_deletion_journal: true, supports_expiry: true, retention_locked: false };
  const descriptorDigest = await destinationDescriptorDigest(descriptor);
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const adapter = makeAdapter(descriptor);
  const keyGeneration = "key-generation-ordering";
  const offsiteEpoch: BackupEpoch = {
    epoch_ref: { id: epochId, revision: 1 }, schema_generation: draft.schema_generation,
    migration_ledger_digest: draft.migration_ledger_digest, core_export_manifest_ref: "core-group",
    r2_object_manifest_ref: "r2-group", head_manifest_ref: "heads-group", generation_manifest_ref: "generation-group",
    purge_ledger_revision: draft.purge_ledger_revision, purge_ledger_digest: draft.purge_ledger_digest,
    offsite_copy_ref: "offsite-copy-ordering", offsite_failure_domain: policy.failure_domain,
    encryption_key_generation: keyGeneration, audit_sample_receipt_ref: draft.audit_sample_receipt_ref,
    created_at: draft.created_at, expires_at: draft.expires_at,
  };
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] as BackupPartRef;
    const ref = `offsite/${epochId}/${part.manifest}/${String(part.index).padStart(6, "0")}-${part.sha256}`;
    const aad = new TextEncoder().encode(canonicalBackupJson({ epoch_id: epochId, manifest: part.manifest, index: part.index, part_ref: ref, part_sha256: part.sha256,
      destination_policy_digest: policyDigest, key_generation: keyGeneration, expires_at: draft.expires_at, retention_policy_ref: policy.retention_policy_ref, expiry_identity: policy.expiry_identity }));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, ownedArrayBuffer(manifestBytes.get(part.manifest) as Uint8Array)));
    const ciphertext = new Uint8Array(iv.byteLength + sealed.byteLength);
    ciphertext.set(iv); ciphertext.set(sealed, iv.byteLength);
    adapter.objects.set(ref, { ciphertext, stored: { content_digest: part.sha256, size_bytes: part.size_bytes, key_generation: keyGeneration, epoch_id: epochId, expires_at: draft.expires_at } });
  }
  const payloadRef = `offsite/${epochId}/r2-payload/${payloadIdentity}/000001-${objectSha}`;
  const payloadAad = new TextEncoder().encode(canonicalBackupJson({ epoch_id: epochId, manifest: "r2-payload", index: 1, part_ref: payloadRef,
    part_sha256: objectSha, destination_policy_digest: policyDigest, key_generation: keyGeneration, expires_at: draft.expires_at,
    retention_policy_ref: policy.retention_policy_ref, expiry_identity: policy.expiry_identity }));
  const payloadIv = crypto.getRandomValues(new Uint8Array(12));
  const payloadSealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: payloadIv, additionalData: payloadAad }, key, ownedArrayBuffer(objectBytes)));
  const payloadCiphertext = new Uint8Array(payloadIv.byteLength + payloadSealed.byteLength);
  payloadCiphertext.set(payloadIv); payloadCiphertext.set(payloadSealed, payloadIv.byteLength);
  adapter.objects.set(payloadRef, { ciphertext: payloadCiphertext, stored: { content_digest: objectSha, size_bytes: 0, key_generation: keyGeneration, epoch_id: epochId, expires_at: draft.expires_at } });

  const receipt = { receipt_ref: { id: "backup-copy-receipt", revision: 1 }, intent_ref: { id: "backup-intent", revision: 1 }, attempt_id: "backup-attempt", outcome: "SUCCEEDED", output_refs: [epochId, offsiteEpoch.offsite_copy_ref], readback_receipt_refs: ["readback"], reconciliation_required: false, reason_codes: [], created_at: NOW };
  const attempt = { attempt_id: "backup-attempt", intent_ref: receipt.intent_ref, attempt_number: 1, state: "SUCCEEDED", started_at: NOW, ended_at: NOW };
  primary.prepare("INSERT INTO backup_epoch_receipt(idempotency_key,intent_id,intent_digest,vector_digest,manifest_digest,epoch_id,receipt_json,draft_json,attempt_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("ordering-test", "backup-intent", H("1"), vectorDigest, await backupSha256Hex(Object.entries(manifestDigests).sort(([a], [b]) => a.localeCompare(b)).map(([name, digest]) => `${name}:${digest}`).join("\n")), epochId, JSON.stringify(receipt), JSON.stringify(draft), JSON.stringify(attempt), Date.now());
  primary.prepare("INSERT INTO backup_destination_authority(destination_id,principal_ref,policy_decision_ref,policy_json,policy_digest,authorization_receipt_ref,state,authorized_at,revoked_at) VALUES(?,?,?,?,?,?,'AUTHORIZED',?,NULL)")
    .run(policy.destination_id, "principal-ordering", "decision-ordering", JSON.stringify(policy), policyDigest, policy.authorization_receipt_ref, Date.now());
  primary.prepare("INSERT INTO backup_offsite_copy_receipt(copy_id,epoch_id,destination_id,key_generation,policy_digest,intent_digest,receipt_json,epoch_json,attempt_json,readback_digest,expires_at,failure_domain,descriptor_digest,authority_authorized_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("copy-ordering", epochId, policy.destination_id, keyGeneration, policyDigest, H("2"), JSON.stringify(receipt), JSON.stringify(offsiteEpoch), JSON.stringify(attempt), H("3"), EXPIRY, policy.failure_domain, descriptorDigest, Date.now(), Date.now());
  const targetR2 = workTargetBucket(contamination);
  const input: IsolatedRestorePreflightInput = {
    draft,
    primary: { account_id: "primary-account", failure_domain: "primary-domain", resources: { core_database: "primary-core", evidence_bucket: "primary-evidence", work_bucket: "primary-work" }, db: primaryDb, evidence_bucket: emptyBucket(), work_bucket: emptyBucket() },
    target: { account_id: "isolated-account", failure_domain: "isolated-domain", environment_ref: "restore-target", resources: { core_database: "target-core", evidence_bucket: "target-evidence", work_bucket: "target-work" }, db: targetDb, evidence_bucket: emptyBucket(), work_bucket: targetR2.bucket },
    offsite: adapter, encryption_key: key,
    admission: { async assertCurrentAdmission(request) { if (request.target_environment_ref !== "restore-target" || request.target_resources.core_database !== "target-core" || request.epoch_id !== epochId) throw new Error("unbound restore admission request"); } },
  };
  return { input, primary, target, contamination, targetObjects: targetR2.objects };
}

function restoreFence(database: DatabaseSync) {
  const now = Date.now();
  const owner = "ordering-test-owner";
  database.prepare("INSERT INTO operation_execution_lease(operation_id,operation_kind,lease_owner,lease_generation,lease_until,attempt,state,created_at,updated_at) VALUES(?,?,?,?,?,1,'LEASED',?,?)")
    .run(FENCE_ID, FENCE_KIND, owner, 1, now + 60_000, now, now);
  return {
    kind: "RESTORE" as const, operation_id: FENCE_ID, lease_owner: owner, lease_generation: 1,
    async assertCurrent() {}, async release() {},
  };
}

describe("native-history restore final ordering", () => {
  it("keeps simulated R2-triggered native-table contamination and records UNKNOWN without a receipt", async () => {
    const f = await fixture();
    try {
      const gate: RestoreErasureGate = {
        async acquire(request) {
          return {
            state: "ACQUIRED", epoch_id: request.draft.epoch_id,
            purge_ledger_revision: request.current_purge.revision, purge_ledger_digest: request.current_purge.digest,
            epoch_subject_scope_digest: H("6"), obligation_inventory_digest: H("7"),
            terminal_erasure_targets_verified: true, backup_obligations_verified: true,
            unsettled_erasure_count: 0, backup_obligations: [], shared_execution_fence: restoreFence(f.primary),
            async assertCurrent() {}, async release() {},
          };
        },
      };
      const intent: OperationIntent = {
        intent_ref: { id: "restore-ordering", revision: 1 }, operation_kind: "RESTORE_VERIFY", principal_ref: "owner-ordering",
        idempotency_key: "restore-r2-contamination", payload_ref: f.input.draft.epoch_id,
        policy_decision_ref: "restore-admission-ordering", created_at: NOW,
      };
      await expect(executeIsolatedBackupRestore({
        intent, preflight: f.input, erasure_gate: gate, restore_store: createD1BackupRestoreStore(d1Database(f.primary)),
      })).rejects.toMatchObject({ code: "BACKUP_RESTORE_UNCERTAIN" });
      expect(f.contamination.put_reached).toBe(true);
      expect(f.contamination.native_row_present).toBe(true);
      expect(f.contamination.delete_count).toBe(0);
      expect(f.targetObjects.size).toBe(1);
      expect(f.primary.prepare("SELECT state FROM backup_restore_intent").get()).toEqual({ state: "UNKNOWN" });
      expect(f.primary.prepare("SELECT state FROM backup_restore_attempt").get()).toEqual({ state: "UNKNOWN" });
      expect(f.primary.prepare("SELECT COUNT(*) AS n FROM backup_restore_receipt").get()).toEqual({ n: 0 });
    } finally { f.primary.close(); f.target.close(); }
  });
});
