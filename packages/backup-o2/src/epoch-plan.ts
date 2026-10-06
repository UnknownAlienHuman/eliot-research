import type { OperationIntent } from "@eliotr/contracts";
import { backupSha256Hex, canonicalBackupJson, failBackup } from "./shared.js";
import { BACKUP_R2_PAYLOAD_PROTOCOL, type R2ObjectEntry } from "./r2-inventory.js";
import { canonicalEpochIntentDigest } from "./intent-digest.js";
import { canonicalCutDigest, BACKUP_MANIFEST_PROTOCOL, BACKUP_SCHEMA_INVENTORY_PROTOCOL, type CutInputs } from "./coherent-cut.js";
import { rebuildManifestLines } from "./coverage.js";
import type { AuthorityVector, D1Snapshot } from "./epoch.js";

const MANIFEST_NAMES = [
  "schema", "schema-inventory", "ownership", "sources", "revisions", "projects", "scopes", "handles",
  "heads", "generations", "retention", "purge", "r2-objects", "rebuild", "vector",
] as const;

export interface EpochPlanR2Snapshot {
  readonly entries: readonly R2ObjectEntry[];
  readonly fingerprint: string;
  readonly total_bytes: number;
}

export interface EpochManifestBundle {
  readonly name: string;
  readonly jsonl: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly digest: string;
}

export interface BackupEpochCandidatePlan {
  readonly cut_inputs: CutInputs;
  readonly cut: { readonly cut_id: string; readonly cut_digest: string };
  readonly vector: AuthorityVector;
  readonly vector_digest: string;
  readonly bundles: readonly EpochManifestBundle[];
  readonly manifest_digests: Readonly<Record<string, string>>;
  readonly vector_manifest_digest: string;
  readonly group_digests: Readonly<Record<string, string>>;
  readonly manifest_digest: string;
  readonly epoch_id: string;
  readonly intent_digest: string;
}

export function cutInputsFor(snapshot: D1Snapshot, r2Generation: string): CutInputs {
  return {
    schema_generation: snapshot.schema_generation,
    migration_ledger_digest: snapshot.migration_ledger_digest,
    table_digests: snapshot.vector_tables,
    purge_frontier: snapshot.purge_frontier,
    purge_digest: snapshot.purge_digest,
    r2_generation: r2Generation,
    schema_inventory_digest: snapshot.inventory_digest,
  };
}

async function buildManifest(name: string, lines: readonly string[], maxBytes: number): Promise<EpochManifestBundle> {
  const jsonl = lines.join("\n");
  const bytes = new TextEncoder().encode(jsonl);
  if (bytes.byteLength > maxBytes) {
    failBackup("BACKUP_BOUND_EXCEEDED", `backup manifest ${name} exceeds its byte bound`, false, { manifest: name, limit: String(maxBytes) });
  }
  return { name, jsonl, bytes, digest: await backupSha256Hex(bytes) };
}

/** Builds deterministic candidate pins without opening or mutating backup_export_cut. */
export async function planBackupEpoch(input: {
  readonly frozen: D1Snapshot;
  readonly r2: EpochPlanR2Snapshot;
  readonly intent: OperationIntent;
  readonly absentHeadTables: readonly string[];
  readonly max_manifest_bytes: number;
}): Promise<BackupEpochCandidatePlan> {
  const { frozen, r2, intent } = input;
  const cutInputs = cutInputsFor(frozen, r2.fingerprint);
  const cutDigest = await canonicalCutDigest(cutInputs);
  const cut = { cut_id: `cut-${cutDigest.slice(0, 32)}`, cut_digest: cutDigest };
  const vector: AuthorityVector = {
    schema_generation: frozen.schema_generation,
    migration_names: frozen.migration_names,
    migration_ledger_digest: frozen.migration_ledger_digest,
    tables: frozen.vector_tables,
    purge_frontier: frozen.purge_frontier,
    purge_digest: frozen.purge_digest,
    r2_keys: r2.entries.length,
    r2_bytes: r2.total_bytes,
    r2_digest: r2.fingerprint,
  };
  const vectorDigest = await backupSha256Hex(canonicalBackupJson(vector));
  const vectorManifestLine = canonicalBackupJson({
    protocol: BACKUP_MANIFEST_PROTOCOL,
    vector,
    vector_digest: vectorDigest,
    schema_inventory_digest: frozen.inventory_digest,
    cut_id: cut.cut_id,
    cut_digest: cut.cut_digest,
  });
  const byManifest = new Map<string, string[]>();
  const record = (manifest: string, line: string): void => {
    const lines = byManifest.get(manifest);
    if (lines === undefined) byManifest.set(manifest, [line]);
    else lines.push(line);
  };
  const specManifest = new Map<string, string>();
  for (const spec of frozen.table_specs) specManifest.set(spec.table, spec.manifest);
  for (const row of frozen.rows) {
    // Purge rows are emitted once below from the dedicated stable ledger read.
    if (row.table === "purge_ledger") continue;
    record(specManifest.get(row.table) ?? "sources", canonicalBackupJson({ table: row.table, row: row.row }));
  }
  for (const row of frozen.purge_rows) record("purge", canonicalBackupJson({ table: row.table, row: row.row }));
  for (const table of input.absentHeadTables) record("heads", canonicalBackupJson({ table, status: "TABLE_ABSENT" }));
  const heads = new Map<string, number>();
  for (const row of frozen.rows) {
    if (row.table !== "investigation") continue;
    const id = row.row["investigation_id"];
    const revision = row.row["revision"];
    if (typeof id !== "string" || typeof revision !== "number") continue;
    if (revision > (heads.get(id) ?? 0)) heads.set(id, revision);
  }
  for (const [id, head] of [...heads.entries()].sort()) record("heads", canonicalBackupJson({ kind: "investigation", id, head_revision: head }));
  for (const line of rebuildManifestLines()) record("rebuild", line);
  record("schema", canonicalBackupJson({
    manifest_protocol: BACKUP_MANIFEST_PROTOCOL,
    schema_generation: vector.schema_generation,
    migration_ledger_digest: vector.migration_ledger_digest,
    migration_ledger: "PRESENT",
    migration_count: vector.migration_names.length,
  }));
  record("schema-inventory", canonicalBackupJson({
    protocol: BACKUP_MANIFEST_PROTOCOL,
    inventory_protocol: BACKUP_SCHEMA_INVENTORY_PROTOCOL,
    schema_inventory_digest: frozen.inventory_digest,
    cut_id: cut.cut_id,
  }));
  for (const table of specManifest.keys()) {
    const inventory = frozen.column_inventory.find((entry) => entry.table === table);
    const columns = inventory?.columns.map((column) => column.name) ?? [];
    const columnShapes = inventory?.columns ?? [];
    record("schema-inventory", canonicalBackupJson({ table, columns, column_shapes: columnShapes }));
  }
  record("purge", canonicalBackupJson({ purge_frontier: vector.purge_frontier, purge_digest: vector.purge_digest }));
  record("r2-objects", canonicalBackupJson({
    object_count: r2.entries.length,
    total_bytes: r2.total_bytes,
    fingerprint: r2.fingerprint,
    payload_protocol: BACKUP_R2_PAYLOAD_PROTOCOL,
  }));
  for (const entry of r2.entries) record("r2-objects", canonicalBackupJson(entry));
  record("vector", vectorManifestLine);
  const bundles: EpochManifestBundle[] = [];
  for (const name of MANIFEST_NAMES) bundles.push(await buildManifest(name, (byManifest.get(name) ?? []).sort(), input.max_manifest_bytes));
  const manifestDigests: Record<string, string> = {};
  for (const bundle of bundles) manifestDigests[bundle.name] = bundle.digest;
  const vectorManifestDigest = manifestDigests["vector"] ?? "";
  const group = async (members: readonly string[]): Promise<string> => backupSha256Hex(
    members.map((name) => `${name}:${manifestDigests[name] ?? "ABSENT"}`).sort().join("\n"),
  );
  const groupDigests: Record<string, string> = {
    core: await group(["schema", "schema-inventory", "ownership", "sources", "revisions", "projects", "scopes", "handles", "retention", "purge", "vector"]),
    heads: await group(["heads"]),
    generations: await group(["generations"]),
    r2: await group(["r2-objects"]),
  };
  const manifestDigest = await backupSha256Hex(Object.entries(manifestDigests)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, digest]) => `${name}:${digest}`).join("\n"));
  const epochId = `epoch-${(await backupSha256Hex(`backup-epoch\u0000${intent.intent_ref.id}\u0000${vectorDigest}\u0000${manifestDigest}`)).slice(0, 48)}`;
  const intentDigest = await canonicalEpochIntentDigest(intent, {
    vector_digest: vectorDigest,
    manifest_digest: manifestDigest,
    epoch_id: epochId,
  });
  return {
    cut_inputs: cutInputs,
    cut,
    vector,
    vector_digest: vectorDigest,
    bundles,
    manifest_digests: manifestDigests,
    vector_manifest_digest: vectorManifestDigest,
    group_digests: groupDigests,
    manifest_digest: manifestDigest,
    epoch_id: epochId,
    intent_digest: intentDigest,
  };
}
