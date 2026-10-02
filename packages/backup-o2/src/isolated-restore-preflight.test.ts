/// <reference types="node" />
/// <reference types="vite/client" />
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { BackupEpoch } from "@eliotr/contracts";
import { BACKUP_MANIFEST_PROTOCOL, BACKUP_SCHEMA_INVENTORY_PROTOCOL, TABLE_SPECS, digestCoreColumnInventory, readCoreColumnInventory } from "./coherent-cut.js";
import { rebuildManifestLines } from "./coverage.js";
import type { BackupEpochDraft, BackupPartRef } from "./epoch.js";
import { destinationDescriptorDigest, destinationPolicyDigest, type BackupDestinationPolicy } from "./destination-policy.js";
import type { OffsiteCopyAdapter, OffsiteStoredPart } from "./offsite.js";
import { backupSha256Hex, canonicalBackupJson } from "./shared.js";
import { verifyIsolatedRestorePreflight, type IsolatedRestorePreflightInput } from "./isolated-restore-preflight.js";

const MIGRATION_DIR = fileURLToPath(new URL("../../../infra/d1/core/migrations/", import.meta.url));
const MANIFEST_NAMES = ["schema", "schema-inventory", "ownership", "sources", "revisions", "projects", "scopes", "handles", "heads", "generations", "retention", "purge", "r2-objects", "rebuild", "vector"] as const;
const NOW = "2026-10-01T00:00:00.000Z";
const EXPIRY = "2030-10-01T00:00:00.000Z";
const H = (c: string): string => c.repeat(64);

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

async function fixture(): Promise<{ input: IsolatedRestorePreflightInput; primary: DatabaseSync; target: DatabaseSync; adapter: ReturnType<typeof makeAdapter> }> {
  const primary = await migratedDatabase();
  const target = await migratedDatabase();
  const primaryDb = d1Database(primary);
  const targetDb = d1Database(target);
  const inventory = await readCoreColumnInventory(primaryDb, TABLE_SPECS.map((spec) => spec.table));
  const inventoryDigest = await digestCoreColumnInventory(inventory);
  const names = (await readdir(MIGRATION_DIR)).filter((name) => /^\d{4}_.*\.sql$/u.test(name)).sort();
  const migrationDigest = await backupSha256Hex(`migration-ledger\n${names.join("\n")}`);
  const purgeDigest = await backupSha256Hex("");
  const tables = Object.fromEntries(await Promise.all(TABLE_SPECS.map(async (spec) => {
    const schema = inventory.find((entry) => entry.table === spec.table);
    return [spec.table, { count: 0, digest: await backupSha256Hex(schema === undefined || schema.columns.length === 0 ? `${spec.table}:TABLE_ABSENT` : `${spec.table}:EMPTY`) }];
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
  manifests["purge"] = canonicalBackupJson({ purge_frontier: 0, purge_digest: purgeDigest });
  manifests["r2-objects"] = canonicalBackupJson({ object_count: 0, total_bytes: 0, fingerprint: emptyR2Fingerprint });
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
  const input: IsolatedRestorePreflightInput = {
    draft,
    primary: { account_id: "primary-account", failure_domain: "primary-domain", resources: { core_database: "primary-core", evidence_bucket: "primary-evidence", work_bucket: "primary-work" }, db: primaryDb, evidence_bucket: emptyBucket(), work_bucket: emptyBucket() },
    target: { account_id: "isolated-account", failure_domain: "isolated-domain", environment_ref: "restore-target", resources: { core_database: "target-core", evidence_bucket: "target-evidence", work_bucket: "target-work" }, db: targetDb, evidence_bucket: emptyBucket(), work_bucket: emptyBucket() },
    offsite: adapter, encryption_key: key,
    admission: { async assertCurrentAdmission(request) { if (request.target_environment_ref !== "restore-target" || request.target_resources.core_database !== "target-core" || request.epoch_id !== draft.epoch_id) throw new Error("unbound restore admission request"); } },
  };
  return { input, primary, target, adapter };
}

describe("isolated restore preflight", () => {
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

  it("rejects a same-domain target before offsite reads", async () => {
    const f = await fixture();
    try {
      const input = { ...f.input, target: { ...f.input.target, failure_domain: "primary-domain" } };
      await expect(verifyIsolatedRestorePreflight(input)).rejects.toMatchObject({ code: "BACKUP_RESTORE_NOT_IMPLEMENTED" });
    } finally { f.primary.close(); f.target.close(); }
  });

  it("permits a separately identified staging target in the same account", async () => {
    const f = await fixture();
    try {
      const input = { ...f.input, target: { ...f.input.target, account_id: f.input.primary.account_id } };
      const result = await verifyIsolatedRestorePreflight(input);
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
      const input = { ...f.input, admission: { async assertCurrentAdmission() { checks += 1; if (checks > 1) throw new Error("restore admission revoked"); } } };
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
});
