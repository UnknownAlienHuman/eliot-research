import { backupSha256Hex, canonicalBackupJson } from "@eliotr/backup-o2";

export const PRIMARY_INVENTORY_PROTOCOL = "eliotr.backup-primary-inventory.v1" as const;
const PRIMARY_PREFIX = "backup-parts/" as const;
const MAX_ROWS = 100_000;
const MAX_PAGES = 128;
const SHA256 = /^[a-f0-9]{64}$/u;
const PART_METADATA_KEYS = new Set(["backup_epoch", "backup_vector_digest", "backup_manifest", "backup_part_index", "backup_part_sha256", "backup_object_identity_digest", "backup_part_count", "eliotr_sha256", "eliotr_size_bytes", "eliotr_immutable"]);

export interface PrimaryWriterInventoryEnvironment {
  readonly CORE_DB: D1Database;
  readonly BACKUP_PARTS_BUCKET: R2Bucket;
  readonly DEPLOYMENT_GENERATION: string;
  readonly VERSION_METADATA: { readonly id: string };
}

async function rows(database: D1Database, table: string): Promise<readonly Record<string, unknown>[]> {
  const result = await database.prepare(`SELECT * FROM ${table} ORDER BY 1 LIMIT ${MAX_ROWS + 1}`).all<Record<string, unknown>>();
  if (result.success !== true || !Array.isArray(result.results) || result.results.length > MAX_ROWS) {
    throw new Error(`primary inventory ${table} is unavailable or over its bound`);
  }
  return result.results;
}

function primaryPart(object: R2Object): Record<string, unknown> {
  if (typeof object.key !== "string" || !object.key.startsWith(PRIMARY_PREFIX) || typeof object.size !== "number" || !Number.isSafeInteger(object.size) || object.size < 0 || typeof object.etag !== "string" || object.etag.length === 0 || typeof object.customMetadata !== "object" || object.customMetadata === null || Array.isArray(object.customMetadata)) throw new Error("primary inventory R2 object readback is malformed");
  const metadata = object.customMetadata as Record<string, unknown>;
  if (Object.keys(metadata).some((key) => !PART_METADATA_KEYS.has(key)) || Object.keys(metadata).some((key) => typeof metadata[key] !== "string")) throw new Error("primary inventory R2 metadata is malformed");
  const custom = metadata as Record<string, string>;
  const epoch = custom.backup_epoch;
  const vector = custom.backup_vector_digest;
  const manifest = custom.backup_manifest;
  const index = custom.backup_part_index;
  const partSha = custom.backup_part_sha256;
  if (epoch === undefined || epoch.length === 0 || epoch.length > 256 || vector === undefined || !SHA256.test(vector) || manifest === undefined || manifest.length === 0 || manifest.length > 256 || index === undefined || !/^(?:0|[1-9]\d*)$/u.test(index) || !Number.isSafeInteger(Number(index)) || partSha === undefined || !SHA256.test(partSha) || custom.eliotr_sha256 !== partSha || custom.eliotr_size_bytes !== String(object.size) || custom.eliotr_immutable !== "true") throw new Error("primary inventory R2 metadata does not contain an exact immutable part pin");
  const payloadIdentity = custom.backup_object_identity_digest;
  const payloadCount = custom.backup_part_count;
  if ((payloadIdentity === undefined) !== (payloadCount === undefined) || (payloadIdentity !== undefined && (!SHA256.test(payloadIdentity) || payloadCount === undefined || !/^(?:0|[1-9]\d*)$/u.test(payloadCount) || !Number.isSafeInteger(Number(payloadCount))))) throw new Error("primary inventory R2 payload metadata is incomplete");
  return { key: object.key, epoch_id: epoch, manifest, part_index: Number(index), part_sha256: partSha, ...(payloadIdentity === undefined ? {} : { payload_identity_digest: payloadIdentity, payload_part_count: Number(payloadCount) }), size_bytes: object.size, etag: object.etag, custom_metadata: { ...custom } };
}

/** Read-only owner diagnostic. Every identity value comes from server bindings. */
export async function readPrimaryWriterInventory(env: PrimaryWriterInventoryEnvironment): Promise<Record<string, unknown>> {
  const names = ["backup_epoch", "backup_epoch_receipt", "backup_export_cut", "erasure_case", "erasure_execution", "backup_epoch_producer_claim"] as const;
  const inventory: Record<string, readonly Record<string, unknown>[]> = {};
  for (const name of names) inventory[name] = await rows(env.CORE_DB, name);

  const objects: Record<string, unknown>[] = [];
  const objectKeys = new Set<string>();
  let cursor: string | undefined;
  const cursors = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const listed = await env.BACKUP_PARTS_BUCKET.list({ prefix: PRIMARY_PREFIX, limit: 1000, ...(cursor === undefined ? {} : { cursor }), include: ["customMetadata"] });
    for (const object of listed.objects) {
      const parsed = primaryPart(object);
      if (objectKeys.has(String(parsed.key))) throw new Error("primary inventory R2 listing contains a duplicate object key");
      objectKeys.add(String(parsed.key));
      objects.push(parsed);
    }
    if (!listed.truncated) break;
    if (typeof listed.cursor !== "string" || listed.cursor.length === 0 || cursors.has(listed.cursor)) throw new Error("primary inventory pagination did not advance");
    cursors.add(listed.cursor);
    cursor = listed.cursor;
  }
  if (cursor !== undefined && cursors.size >= MAX_PAGES) throw new Error("primary inventory exceeds its bound");

  const canonical = (value: unknown): string => canonicalBackupJson(value);
  const digestOf = async (value: unknown): Promise<string> => backupSha256Hex(canonical(value));
  const orderedObjects = objects.sort((left, right) => String(left.key).localeCompare(String(right.key)));
  const counts = Object.fromEntries(names.map((name) => [name, (inventory[name] ?? []).length]));
  const d1Digests: Record<string, string> = {};
  for (const name of names) d1Digests[name] = await digestOf(inventory[name] ?? []);
  const result = {
    protocol: PRIMARY_INVENTORY_PROTOCOL,
    deployment_generation: env.DEPLOYMENT_GENERATION,
    version_metadata: { version_id: env.VERSION_METADATA.id, controller_generation: env.DEPLOYMENT_GENERATION },
    bucket_binding_ref: "BACKUP_PARTS_BUCKET",
    prefix: PRIMARY_PREFIX,
    object_count: orderedObjects.length,
    inventory_digest: await digestOf(orderedObjects),
    d1_counts: counts,
    d1_digests: d1Digests,
    zero_baseline: Object.values(counts).every((count) => count === 0) && orderedObjects.length === 0,
    observed_at: new Date().toISOString(),
  };
  return { ...result, evidence_digest: await digestOf(result) };
}
