import { describe, expect, it } from "vitest";
import { BACKUP_MANIFEST_PROTOCOL, BACKUP_SCHEMA_INVENTORY_PROTOCOL, coreTableSpecsForMigrationNames, digestCoreColumnInventory, type CoreTableInventory } from "./coherent-cut.js";
import { backupSha256Hex, canonicalBackupJson } from "./shared.js";
import { rebuildManifestLines } from "./coverage.js";
import { BACKUP_PORTABLE_MANIFEST_NAMES, verifyPortableBackupManifests } from "./portable-manifest.js";
import { BACKUP_R2_PAYLOAD_PROTOCOL } from "./r2-inventory.js";
import type { BackupEpochDraft } from "./epoch.js";

const HEX = "a".repeat(64);

async function fixture(): Promise<{
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
    { protocol: BACKUP_MANIFEST_PROTOCOL, inventory_protocol: BACKUP_SCHEMA_INVENTORY_PROTOCOL, schema_inventory_digest: schemaInventoryDigest, cut_id: "cut-1" },
    ...tableInventory,
  ].map(canonicalBackupJson).sort();
  const purgeDigest = emptyDigest;
  const vector = {
    schema_generation: "schema-v1",
    migration_names: migrationNames,
    migration_ledger_digest: migrationDigest,
    tables,
    purge_frontier: 0,
    purge_digest: purgeDigest,
    r2_keys: 0,
    r2_bytes: 0,
    r2_digest: emptyDigest,
  };
  const vectorDigest = await backupSha256Hex(canonicalBackupJson(vector));
  const rows: Record<string, readonly string[]> = {
    schema: [canonicalBackupJson({ manifest_protocol: BACKUP_MANIFEST_PROTOCOL, schema_generation: "schema-v1", migration_ledger_digest: migrationDigest, migration_ledger: "PRESENT", migration_count: 1 })],
    "schema-inventory": schemaInventory,
    ownership: [], sources: [], revisions: [], projects: [], scopes: [], handles: [], heads: [], generations: [], retention: [],
    purge: [canonicalBackupJson({ purge_frontier: 0, purge_digest: purgeDigest })],
    "r2-objects": [canonicalBackupJson({ object_count: 0, total_bytes: 0, fingerprint: emptyDigest, payload_protocol: BACKUP_R2_PAYLOAD_PROTOCOL })],
    rebuild: rebuildManifestLines().map((line) => canonicalBackupJson(JSON.parse(line) as unknown)).sort(),
    vector: [canonicalBackupJson({ protocol: BACKUP_MANIFEST_PROTOCOL, vector, vector_digest: vectorDigest, schema_inventory_digest: schemaInventoryDigest, cut_id: "cut-1", cut_digest: HEX })],
  };
  const manifestDigests: Record<string, string> = {};
  const plaintextParts: { manifest: string; index: number; bytes: Uint8Array }[] = [];
  for (const name of BACKUP_PORTABLE_MANIFEST_NAMES) {
    const bytes = new TextEncoder().encode((rows[name] ?? []).join("\n"));
    const partSha = await backupSha256Hex(bytes);
    manifestDigests[name] = partSha;
    plaintextParts.push({ manifest: name, index: 1, bytes });
  }
  const group = async (names: readonly string[]) => backupSha256Hex(names.map((name) => `${name}:${manifestDigests[name] ?? "ABSENT"}`).sort().join("\n"));
  const draft: BackupEpochDraft = {
    epoch_id: "epoch-1",
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
      manifest: part.manifest,
      index: part.index,
      part_key: `part/${part.manifest}`,
      sha256: await backupSha256Hex(part.bytes),
      size_bytes: part.bytes.byteLength,
      etag: `etag-${part.manifest}`,
      existed_identically: false,
    }))),
    r2_payload_protocol: BACKUP_R2_PAYLOAD_PROTOCOL,
    payload_part_index: [],
    purge_ledger_revision: 0,
    purge_ledger_digest: purgeDigest,
    r2_object_count: 0,
    r2_total_bytes: 0,
    audit_sample_receipt_ref: "audit-1",
    vector_digest: vectorDigest,
    vector_manifest_digest: manifestDigests["vector"] ?? "",
    cut_id: "cut-1",
    manifest_protocol: BACKUP_MANIFEST_PROTOCOL,
    created_at: "2025-01-01T00:00:00.000Z",
    expires_at: "2026-01-01T00:00:00.000Z",
  };
  return { draft, plaintext_parts: plaintextParts };
}

describe("ER-34 portable manifest verification", () => {
  it("verifies part index, all manifest digests, vector, schema and purge bindings", async () => {
    const input = await fixture();
    const result = await verifyPortableBackupManifests(input);
    expect(result.vector["schema_generation"]).toBe("schema-v1");
    expect(result.manifests["schema-inventory"]).toHaveLength(new Set(coreTableSpecsForMigrationNames(["0001_base.sql"]).map((spec) => spec.table)).size + 1);
    expect(result.source_rows).toEqual([]);
    expect(result.purge_ledger).toEqual([]);
  });

  it("rejects missing or changed plaintext even when the other manifests are intact", async () => {
    const input = await fixture();
    await expect(verifyPortableBackupManifests({ ...input, plaintext_parts: input.plaintext_parts.slice(1) }))
      .rejects.toMatchObject({ code: "BACKUP_VECTOR_UNVERIFIABLE" });
    const tampered = input.plaintext_parts.map((part) => ({ ...part, bytes: part.bytes.slice() }));
    const changed = tampered[0];
    if (changed !== undefined) changed.bytes[0] = (changed.bytes[0] ?? 0) ^ 1;
    await expect(verifyPortableBackupManifests({ ...input, plaintext_parts: tampered }))
      .rejects.toMatchObject({ code: "BACKUP_VECTOR_UNVERIFIABLE" });
  });
});
