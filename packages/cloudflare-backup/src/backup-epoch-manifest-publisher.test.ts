/// <reference types="node" />
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { BackupEpochSchema, OperationAttemptSchema, OperationReceiptSchema, type BackupEpoch } from "@eliotr/contracts";
import {
  BACKUP_MANIFEST_PROTOCOL,
  BACKUP_R2_PAYLOAD_PROTOCOL,
  BACKUP_SCHEMA_INVENTORY_PROTOCOL,
  BACKUP_PORTABLE_MANIFEST_NAMES,
  backupEpochProducerReceiptDigest,
  backupSha256Hex,
  canonicalBackupJson,
  copyIdForDigest,
  coreTableSpecsForMigrationNames,
  digestCoreColumnInventory,
  rebuildManifestLines,
  type BackupEpochDraft,
  type CoreTableInventory,
} from "@eliotr/backup-o2";
import { BACKUP_EPOCH_MANIFEST_MIGRATION_SHA256 } from "./backup-epoch-manifest-schema.js";
import { publishPendingCanonicalBackupEpoch } from "./backup-epoch-manifest-publisher.js";
import m0119 from "../../../infra/d1/core/migrations/0119_backup_epoch_manifest_bindings.sql?raw";

const MIGRATION_DIR = fileURLToPath(new URL("../../../infra/d1/core/migrations/", import.meta.url));
const NOW = "2026-10-05T12:00:00.000Z";
const H = "a".repeat(64);
const CUT_ID = `cut-${H.slice(0, 32)}`;

async function portableFixture(): Promise<{
  readonly draft: BackupEpochDraft;
  readonly plaintext_parts: readonly { readonly manifest: string; readonly index: number; readonly bytes: Uint8Array }[];
}> {
  const migrationNames = ["0001_base.sql"];
  const tableSpecs = coreTableSpecsForMigrationNames(migrationNames);
  const emptyDigest = await backupSha256Hex("");
  const migrationDigest = await backupSha256Hex(`migration-ledger\n${migrationNames.join("\n")}`);
  const tableNames = [...new Set(tableSpecs.map((spec) => spec.table))].sort();
  const tables = Object.fromEntries(await Promise.all(tableNames.map(async (table) => [table, { count: 0, digest: await backupSha256Hex(`${table}:EMPTY`) }] as const)));
  const coreInventory: CoreTableInventory[] = tableNames.map((table) => {
    const spec = tableSpecs.find((entry) => entry.table === table);
    const columns = Object.entries(spec?.columns ?? {}).map(([name, kind]) => ({
      name,
      affinity: kind.startsWith("int") ? "INTEGER" as const : kind.startsWith("real") ? "REAL" as const : "TEXT" as const,
      notnull: !kind.endsWith("-or-null"),
    }));
    return { table, columns };
  });
  const tableInventory = coreInventory.map((entry) => ({ table: entry.table, columns: entry.columns.map((column) => column.name), column_shapes: entry.columns }));
  const schemaInventoryDigest = await digestCoreColumnInventory(coreInventory);
  const schemaInventory = [
    { protocol: BACKUP_MANIFEST_PROTOCOL, inventory_protocol: BACKUP_SCHEMA_INVENTORY_PROTOCOL, schema_inventory_digest: schemaInventoryDigest, cut_id: CUT_ID },
    ...tableInventory,
  ].map(canonicalBackupJson).sort();
  const vector = {
    schema_generation: "schema-v1",
    migration_names: migrationNames,
    migration_ledger_digest: migrationDigest,
    tables,
    purge_frontier: 0,
    purge_digest: emptyDigest,
    r2_keys: 0,
    r2_bytes: 0,
    r2_digest: emptyDigest,
  };
  const vectorDigest = await backupSha256Hex(canonicalBackupJson(vector));
  const rows: Record<string, readonly string[]> = {
    schema: [canonicalBackupJson({ manifest_protocol: BACKUP_MANIFEST_PROTOCOL, schema_generation: "schema-v1", migration_ledger_digest: migrationDigest, migration_ledger: "PRESENT", migration_count: 1 })],
    "schema-inventory": schemaInventory,
    ownership: [], sources: [], revisions: [], projects: [], scopes: [], handles: [], heads: [], generations: [], retention: [],
    purge: [canonicalBackupJson({ purge_frontier: 0, purge_digest: emptyDigest })],
    "r2-objects": [canonicalBackupJson({ object_count: 0, total_bytes: 0, fingerprint: emptyDigest, payload_protocol: BACKUP_R2_PAYLOAD_PROTOCOL })],
    rebuild: rebuildManifestLines().map((line) => canonicalBackupJson(JSON.parse(line) as unknown)).sort(),
    vector: [canonicalBackupJson({ protocol: BACKUP_MANIFEST_PROTOCOL, vector, vector_digest: vectorDigest, schema_inventory_digest: schemaInventoryDigest, cut_id: CUT_ID, cut_digest: H })],
  };
  const manifestDigests: Record<string, string> = {};
  const plaintextParts: { manifest: string; index: number; bytes: Uint8Array }[] = [];
  for (const name of BACKUP_PORTABLE_MANIFEST_NAMES) {
    const bytes = new TextEncoder().encode((rows[name] ?? []).join("\n"));
    manifestDigests[name] = await backupSha256Hex(bytes);
    plaintextParts.push({ manifest: name, index: 1, bytes });
  }
  const group = async (names: readonly string[]) => backupSha256Hex(names.map((name) => `${name}:${manifestDigests[name] ?? "ABSENT"}`).sort().join("\n"));
  const draft: BackupEpochDraft = {
    epoch_id: "epoch-publisher-fixture",
    schema_generation: "schema-v1",
    migration_ledger_digest: migrationDigest,
    manifest_digests: manifestDigests,
    group_digests: {
      core: await group(["schema", "schema-inventory", "ownership", "sources", "revisions", "projects", "scopes", "handles", "retention", "purge", "vector"]),
      heads: await group(["heads"]),
      generations: await group(["generations"]),
      r2: await group(["r2-objects"]),
    },
    part_index: await Promise.all(plaintextParts.map(async (part) => ({
      manifest: part.manifest, index: part.index, part_key: `part/${part.manifest}`,
      sha256: await backupSha256Hex(part.bytes), size_bytes: part.bytes.byteLength,
      etag: `etag-${part.manifest}`, existed_identically: false,
    }))),
    r2_payload_protocol: BACKUP_R2_PAYLOAD_PROTOCOL,
    payload_part_index: [],
    purge_ledger_revision: 0,
    purge_ledger_digest: emptyDigest,
    r2_object_count: 0,
    r2_total_bytes: 0,
    audit_sample_receipt_ref: "audit-fixture",
    vector_digest: vectorDigest,
    vector_manifest_digest: manifestDigests["vector"] ?? "",
    cut_id: CUT_ID,
    manifest_protocol: BACKUP_MANIFEST_PROTOCOL,
    created_at: NOW,
    expires_at: "2030-10-05T12:00:00.000Z",
  };
  return { draft, plaintext_parts: plaintextParts };
}

interface BoundStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
  bind(...values: unknown[]): BoundStatement;
  all<T>(): Promise<D1Result<T>>;
  first<T>(): Promise<T | null>;
  run<T>(): Promise<D1Result<T>>;
}

function d1Database(database: DatabaseSync): D1Database {
  const prepared = (sql: string, params: readonly unknown[] = []): BoundStatement => ({
    sql,
    params,
    bind: (...values) => prepared(sql, values),
    async all<T>() {
      return { results: database.prepare(sql).all(...params as never[]) as T[], success: true, meta: {} } as unknown as D1Result<T>;
    },
    async first<T>() {
      return (database.prepare(sql).get(...params as never[]) as T | undefined) ?? null;
    },
    async run<T>() {
      database.prepare(sql).run(...params as never[]);
      return { results: [], success: true, meta: {} } as unknown as D1Result<T>;
    },
  });
  const wrapper = {
    prepare(sql: string) { return prepared(sql) as unknown as D1PreparedStatement; },
    async batch(statements: D1PreparedStatement[]) {
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const statement of statements as unknown as readonly BoundStatement[]) database.prepare(statement.sql).run(...statement.params as never[]);
        database.exec("COMMIT");
        return statements.map(() => ({ results: [], success: true, meta: {} }));
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
  };
  return wrapper as unknown as D1Database;
}

async function migratedDatabase(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  const files = (await readdir(MIGRATION_DIR)).filter((name) => /^\d{4}_.*\.sql$/u.test(name)).sort();
  for (const name of files) {
    database.exec(await readFile(join(MIGRATION_DIR, name), "utf8"));
    if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='d1_migrations'").get() !== undefined) {
      database.prepare("INSERT OR IGNORE INTO d1_migrations(name,applied_at) VALUES(?,?)").run(name, NOW);
    }
  }
  for (const name of files) database.prepare("INSERT OR IGNORE INTO d1_migrations(name,applied_at) VALUES(?,?)").run(name, NOW);
  return database;
}

async function seedSources(database: DatabaseSync, draft: BackupEpochDraft, options: {
  readonly forgedProducerReceiptDigest?: boolean;
  readonly mismatchedIntentRevision?: "producer" | "offsite";
} = {}): Promise<{
  readonly offsite_copy: {
    readonly epoch: BackupEpoch;
    readonly offsite_copy_ref: string;
    readonly readback_digest: string;
    readonly attempt: ReturnType<typeof OperationAttemptSchema.parse>;
    readonly receipt: ReturnType<typeof OperationReceiptSchema.parse>;
  };
}> {
  const intentRef = { id: "backup-fixture", revision: 1 };
  const sourceAttempt = OperationAttemptSchema.parse({ attempt_id: "producer-attempt", intent_ref: intentRef, attempt_number: 1, state: "SUCCEEDED", started_at: NOW, ended_at: NOW });
  const sourceReceipt = OperationReceiptSchema.parse({ receipt_ref: { id: "producer-receipt", revision: 1 },
    intent_ref: options.mismatchedIntentRevision === "producer" ? { ...intentRef, revision: 2 } : intentRef, attempt_id: sourceAttempt.attempt_id,
    outcome: "SUCCEEDED", output_refs: [draft.epoch_id], readback_receipt_refs: ["source-readback"], reconciliation_required: false, reason_codes: [], created_at: NOW });
  const sourceIntentDigest = "b".repeat(64);
  const sourceManifestDigest = "c".repeat(64);
  const sourceReceiptJson = JSON.stringify(sourceReceipt);
  const sourceDraftJson = JSON.stringify(draft);
  const sourceAttemptJson = JSON.stringify(sourceAttempt);
  database.prepare("INSERT INTO backup_epoch_receipt (idempotency_key,intent_id,intent_digest,vector_digest,manifest_digest,epoch_id,receipt_json,draft_json,attempt_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("backup-idem-fixture", intentRef.id, sourceIntentDigest, draft.vector_digest, sourceManifestDigest, draft.epoch_id,
      sourceReceiptJson, sourceDraftJson, sourceAttemptJson, NOW);
  database.prepare("INSERT INTO backup_epoch_producer_claim (idempotency_key,base_intent_digest,attempt_nonce,state,created_at,updated_at) VALUES (?,?,?,'CAPTURING',?,?)")
    .run("backup-idem-fixture", sourceIntentDigest, "12345678-1234-1234-1234-123456789abc", NOW, NOW);
  database.prepare("UPDATE backup_epoch_producer_claim SET state='WRITING',epoch_id=?,part_prefix=?,cut_id=?,cut_digest=?,vector_digest=?,manifest_digest=?,intent_digest=?,updated_at=? WHERE idempotency_key=?")
    .run(draft.epoch_id, `backup-parts/${draft.epoch_id}/`, draft.cut_id, H, draft.vector_digest, sourceManifestDigest, sourceIntentDigest, NOW, "backup-idem-fixture");
  const producerReceiptDigest = await backupEpochProducerReceiptDigest({
    idempotency_key: "backup-idem-fixture", intent_id: intentRef.id, intent_digest: sourceIntentDigest,
    vector_digest: draft.vector_digest, manifest_digest: sourceManifestDigest, epoch_id: draft.epoch_id,
    receipt_json: sourceReceiptJson, draft_json: sourceDraftJson, attempt_json: sourceAttemptJson,
  });
  database.prepare("UPDATE backup_epoch_producer_claim SET state='COMMITTED',receipt_digest=?,updated_at=? WHERE idempotency_key=?")
    .run(options.forgedProducerReceiptDigest === true ? "d".repeat(64) : producerReceiptDigest, NOW, "backup-idem-fixture");

  const destinationId = "destination-fixture";
  const keyGeneration = "keygen-fixture";
  const policyDigest = "e".repeat(64);
  const authorizationReceiptRef = "destination-auth-fixture";
  const partRefs = draft.part_index.map((part) => `offsite/${draft.epoch_id}/${part.manifest}/${String(part.index).padStart(6, "0")}-${part.sha256}`);
  const readbackDigest = await backupSha256Hex(partRefs.join("\n"));
  const offsiteCopyRef = `offsite-${(await backupSha256Hex(`offsite-copy\u0000${draft.epoch_id}\u0000${draft.vector_digest}\u0000${policyDigest}\u0000${authorizationReceiptRef}\u0000${keyGeneration}\u0000${partRefs.join(",")}`)).slice(0, 48)}`;
  const copyId = await copyIdForDigest({ epoch_id: draft.epoch_id, destination_id: destinationId, key_generation: keyGeneration, policy_digest: policyDigest, intent_digest: sourceIntentDigest });
  const epoch = BackupEpochSchema.parse({
    epoch_ref: { id: draft.epoch_id, revision: 1 }, schema_generation: draft.schema_generation,
    migration_ledger_digest: draft.migration_ledger_digest, core_export_manifest_ref: draft.group_digests["core"],
    r2_object_manifest_ref: draft.group_digests["r2"], head_manifest_ref: draft.group_digests["heads"],
    generation_manifest_ref: draft.group_digests["generations"], purge_ledger_revision: draft.purge_ledger_revision,
    purge_ledger_digest: draft.purge_ledger_digest, offsite_copy_ref: offsiteCopyRef,
    offsite_failure_domain: "failure-domain-fixture", encryption_key_generation: keyGeneration,
    audit_sample_receipt_ref: draft.audit_sample_receipt_ref, created_at: draft.created_at, expires_at: draft.expires_at,
  });
  const offsiteAttempt = OperationAttemptSchema.parse({ attempt_id: "offsite-attempt", intent_ref: intentRef, attempt_number: 1, state: "SUCCEEDED", started_at: NOW, ended_at: NOW });
  const offsiteReceipt = OperationReceiptSchema.parse({ receipt_ref: { id: "offsite-receipt", revision: 1 },
    intent_ref: options.mismatchedIntentRevision === "offsite" ? { ...intentRef, revision: 2 } : intentRef,
    attempt_id: offsiteAttempt.attempt_id, outcome: "SUCCEEDED", output_refs: [draft.epoch_id, offsiteCopyRef],
    readback_receipt_refs: [draft.audit_sample_receipt_ref, readbackDigest, policyDigest, authorizationReceiptRef],
    reconciliation_required: false, reason_codes: ["POLICY:fixture"], created_at: NOW });
  const receiptValue = {
    copy_id: copyId, epoch_id: draft.epoch_id, destination_id: destinationId, key_generation: keyGeneration,
    policy_digest: policyDigest, intent_digest: sourceIntentDigest, receipt_json: JSON.stringify(offsiteReceipt),
    epoch_json: JSON.stringify(epoch), attempt_json: JSON.stringify(offsiteAttempt), readback_digest: readbackDigest,
    expires_at: draft.expires_at, failure_domain: epoch.offsite_failure_domain, descriptor_digest: "f".repeat(64),
    authority_authorized_at: NOW, created_at: NOW,
  };
  database.prepare("INSERT INTO backup_offsite_copy_receipt (copy_id,epoch_id,destination_id,key_generation,policy_digest,intent_digest,receipt_json,epoch_json,attempt_json,readback_digest,expires_at,failure_domain,descriptor_digest,authority_authorized_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(receiptValue.copy_id, receiptValue.epoch_id, receiptValue.destination_id, receiptValue.key_generation, receiptValue.policy_digest,
      receiptValue.intent_digest, receiptValue.receipt_json, receiptValue.epoch_json, receiptValue.attempt_json, receiptValue.readback_digest,
      receiptValue.expires_at, receiptValue.failure_domain, receiptValue.descriptor_digest, receiptValue.authority_authorized_at, receiptValue.created_at);
  for (const [index, part] of draft.part_index.entries()) {
    const partRef = partRefs[index];
    if (partRef === undefined) throw new Error("fixture part reference is missing");
    database.prepare("INSERT INTO backup_offsite_copy_part (copy_id,part_ref,content_digest,size_bytes,nonce_hex,state,updated_at) VALUES (?,?,?,?,?,'VERIFIED',?)")
      .run(copyId, partRef, part.sha256, part.size_bytes, String(index).padStart(24, "0"), NOW);
  }
  return { offsite_copy: { epoch, offsite_copy_ref: offsiteCopyRef, readback_digest: readbackDigest, attempt: offsiteAttempt, receipt: offsiteReceipt } };
}

describe("canonical backup epoch manifest publication", () => {
  it("replays exact descriptors and rolls back an interleaved conflicting insert atomically", async () => {
    expect(await backupSha256Hex(m0119.replace(/\r\n/g, "\n"))).toBe(BACKUP_EPOCH_MANIFEST_MIGRATION_SHA256);
    const fixture = await portableFixture();
    const database = await migratedDatabase();
    try {
      const { offsite_copy } = await seedSources(database, fixture.draft);
      const coreDb = d1Database(database);
      const first = await publishPendingCanonicalBackupEpoch({ core_db: coreDb, epoch_id: fixture.draft.epoch_id,
        plaintext_parts: fixture.plaintext_parts, offsite_copy });
      const retry = await publishPendingCanonicalBackupEpoch({ core_db: coreDb, epoch_id: fixture.draft.epoch_id,
        plaintext_parts: fixture.plaintext_parts, offsite_copy });
      expect(first.disposition).toBe("CREATED");
      expect(retry.disposition).toBe("REPLAYED");
      expect(first.bindings).toHaveLength(4);
      expect(first.epoch.verification_state).toBe("PENDING");
      const search = first.bindings.find((binding) => binding.role === "SEARCH_REBUILD_PLAN");
      expect(JSON.parse(search?.descriptor_json ?? "{}")).toMatchObject({ coverage: { kind: "d1-search", status: "REBUILD_REQUIRED", snapshot_present: false } });
      expect(database.prepare("SELECT COUNT(*) AS count FROM backup_epoch_manifest_binding WHERE backup_epoch_id=?").get(fixture.draft.epoch_id))
        .toMatchObject({ count: 4 });
      expect(() => database.prepare("UPDATE backup_epoch SET verification_state='VERIFIED',verified_at=? WHERE backup_epoch_id=?").run(NOW, fixture.draft.epoch_id))
        .toThrow(/exact immutable verification receipt/u);

      const raceDb = await migratedDatabase();
      try {
        const { offsite_copy: racedCopy } = await seedSources(raceDb, fixture.draft);
        const ordinary = d1Database(raceDb);
        let interleaved = false;
        const racingDb = {
          ...ordinary,
          async batch(statements: D1PreparedStatement[]) {
            if (!interleaved) {
              interleaved = true;
              raceDb.prepare("INSERT INTO backup_epoch (backup_epoch_id,core_export_ref,search_projection_manifest_ref,evidence_manifest_ref,work_manifest_ref,offsite_copy_ref,purge_ledger_revision,verification_state,created_at,verified_at) VALUES (?,?,?,?,?,?,?,'PENDING',?,NULL)")
                .run(fixture.draft.epoch_id, `sha256:${"1".repeat(64)}`, `sha256:${"2".repeat(64)}`, `sha256:${"3".repeat(64)}`,
                  `sha256:${"4".repeat(64)}`, racedCopy.offsite_copy_ref, fixture.draft.purge_ledger_revision, fixture.draft.created_at);
            }
            return ordinary.batch(statements);
          },
        } as unknown as D1Database;
        await expect(publishPendingCanonicalBackupEpoch({ core_db: racingDb, epoch_id: fixture.draft.epoch_id,
          plaintext_parts: fixture.plaintext_parts, offsite_copy: racedCopy })).rejects.toMatchObject({ code: "BACKUP_VECTOR_UNVERIFIABLE" });
        expect(raceDb.prepare("SELECT COUNT(*) AS count FROM backup_epoch_manifest_binding WHERE backup_epoch_id=?").get(fixture.draft.epoch_id))
          .toMatchObject({ count: 0 });
        expect(raceDb.prepare("SELECT core_export_ref,verification_state FROM backup_epoch WHERE backup_epoch_id=?").get(fixture.draft.epoch_id))
          .toMatchObject({ core_export_ref: `sha256:${"1".repeat(64)}`, verification_state: "PENDING" });
      } finally { raceDb.close(); }
    } finally { database.close(); }
  });

  it("rejects a shape-valid producer digest that does not cover persisted source fields", async () => {
    const fixture = await portableFixture();
    const database = await migratedDatabase();
    try {
      const { offsite_copy } = await seedSources(database, fixture.draft, { forgedProducerReceiptDigest: true });
      await expect(publishPendingCanonicalBackupEpoch({ core_db: d1Database(database), epoch_id: fixture.draft.epoch_id,
        plaintext_parts: fixture.plaintext_parts, offsite_copy })).rejects.toMatchObject({ code: "BACKUP_VECTOR_UNVERIFIABLE" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM backup_epoch WHERE backup_epoch_id=?1").get(fixture.draft.epoch_id))
        .toMatchObject({ count: 0 });
    } finally { database.close(); }
  });

  it("rejects a producer receipt and attempt with different intent revisions", async () => {
    const fixture = await portableFixture();
    const database = await migratedDatabase();
    try {
      const { offsite_copy } = await seedSources(database, fixture.draft, { mismatchedIntentRevision: "producer" });
      await expect(publishPendingCanonicalBackupEpoch({ core_db: d1Database(database), epoch_id: fixture.draft.epoch_id,
        plaintext_parts: fixture.plaintext_parts, offsite_copy })).rejects.toMatchObject({ code: "BACKUP_VECTOR_UNVERIFIABLE" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM backup_epoch WHERE backup_epoch_id=?1").get(fixture.draft.epoch_id))
        .toMatchObject({ count: 0 });
    } finally { database.close(); }
  });

  it("rejects an offsite receipt and attempt with different intent revisions", async () => {
    const fixture = await portableFixture();
    const database = await migratedDatabase();
    try {
      const { offsite_copy } = await seedSources(database, fixture.draft, { mismatchedIntentRevision: "offsite" });
      await expect(publishPendingCanonicalBackupEpoch({ core_db: d1Database(database), epoch_id: fixture.draft.epoch_id,
        plaintext_parts: fixture.plaintext_parts, offsite_copy })).rejects.toMatchObject({ code: "BACKUP_VECTOR_UNVERIFIABLE" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM backup_epoch WHERE backup_epoch_id=?1").get(fixture.draft.epoch_id))
        .toMatchObject({ count: 0 });
    } finally { database.close(); }
  });

  it("rejects a missing or altered same-name 0119 guard before inserting a pending epoch", async () => {
    const fixture = await portableFixture();
    const database = await migratedDatabase();
    try {
      const { offsite_copy } = await seedSources(database, fixture.draft);
      database.exec("DROP TRIGGER backup_epoch_manifest_binding_insert_guard;");
      await expect(publishPendingCanonicalBackupEpoch({ core_db: d1Database(database), epoch_id: fixture.draft.epoch_id,
        plaintext_parts: fixture.plaintext_parts, offsite_copy })).rejects.toMatchObject({ code: "BACKUP_TABLE_MISSING" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM backup_epoch WHERE backup_epoch_id=?1").get(fixture.draft.epoch_id))
        .toMatchObject({ count: 0 });

      database.exec("CREATE TRIGGER backup_epoch_manifest_binding_insert_guard BEFORE INSERT ON backup_epoch_manifest_binding " +
        "BEGIN SELECT 1; END;");
      await expect(publishPendingCanonicalBackupEpoch({ core_db: d1Database(database), epoch_id: fixture.draft.epoch_id,
        plaintext_parts: fixture.plaintext_parts, offsite_copy })).rejects.toMatchObject({ code: "BACKUP_TABLE_MISSING" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM backup_epoch WHERE backup_epoch_id=?1").get(fixture.draft.epoch_id))
        .toMatchObject({ count: 0 });
    } finally { database.close(); }
  });
});
