import { assertErasureIdentifier, erasureDigest, erasureFail, utf8ErasureLength } from "@eliotr/cloudflare-erasure";
import { parseBackupEpochScopeDraft } from "./backup-epoch-scope.js";
import type { BackupEpochScopeArchive, BackupPrimaryObjectPin, BackupPrimaryPartInventorySnapshot } from "@eliotr/cloudflare-erasure";

const PREFIX = "backup-parts/";
const PAGE_SIZE = 1000;
const MAX_PAGES = 1024;
const MAX_PARTS = 100_000;
// Admission accounting for strings/records, not a measurement of JavaScript heap.
const MAX_DRAFT_BYTES = 8 * 1024 * 1024;
const MAX_EXPECTED_BYTES = 8 * 1024 * 1024;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const STORE_METADATA = ["eliotr_sha256", "eliotr_size_bytes", "eliotr_immutable"] as const;

interface PartPins {
  readonly key: string;
  readonly epoch_id: string;
  readonly manifest: string;
  readonly part_index: number;
  readonly part_sha256: string;
  readonly payload_identity_digest?: string;
  readonly payload_part_count?: number;
  readonly size: number;
  readonly etag: string;
  readonly metadata: Readonly<Record<string, string>>;
}

type ListedPart = Pick<PartPins, "key" | "size" | "etag" | "metadata">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function incomplete(message: string): never {
  erasureFail("ERASURE_CLOSURE_INCOMPLETE", message);
}

function textBytes(value: string): number {
  return Math.max(value.length * 2, utf8ErasureLength(value));
}

function partBytes(part: ListedPart): number {
  return 64 + textBytes(part.key) + textBytes(part.etag) + Object.entries(part.metadata)
    .reduce((bytes, [name, value]) => bytes + 16 + textBytes(name) + textBytes(value), 0);
}

async function expectedParts(archives: readonly BackupEpochScopeArchive[]): Promise<Map<string, PartPins>> {
  if (!Array.isArray(archives) || archives.length > 10_000) {
    incomplete("primary backup archive inventory is malformed or over its bound");
  }
  const expected = new Map<string, PartPins>();
  const epochs = new Set<string>();
  let expectedBytes = 0;
  let draftBytes = 0;
  const add = (
    epoch: string,
    vector: string,
    manifest: string,
    part: { readonly part_key: string; readonly index: number; readonly size_bytes: number; readonly etag: string; readonly sha256: string },
    payload?: { readonly identity: string; readonly count: number },
  ): void => {
    const key = part.part_key;
    if (!key.startsWith(PREFIX)) incomplete("persisted primary backup part escaped its exact prefix");
    if (expected.has(key)) incomplete("persisted primary backup part inventory contains a duplicate key");
    if (expected.size >= MAX_PARTS) incomplete("persisted primary backup part inventory exceeds its bound");
    const pins: PartPins = {
      key,
      epoch_id: epoch,
      manifest,
      part_index: part.index,
      part_sha256: part.sha256,
      ...(payload === undefined ? {} : {
        payload_identity_digest: payload.identity,
        payload_part_count: payload.count,
      }),
      size: part.size_bytes,
      etag: part.etag,
      metadata: {
        backup_epoch: epoch,
        backup_vector_digest: vector,
        backup_manifest: manifest,
        backup_part_index: String(part.index),
        backup_part_sha256: part.sha256,
        ...(payload === undefined ? {} : {
          backup_object_identity_digest: payload.identity,
          backup_part_count: String(payload.count),
        }),
      },
    };
    expectedBytes += partBytes(pins);
    if (expectedBytes > MAX_EXPECTED_BYTES) incomplete("persisted primary backup part inventory exceeds its byte budget");
    expected.set(key, pins);
  };

  for (const archive of archives) {
    if (typeof archive !== "object" || archive === null || Array.isArray(archive) ||
      typeof archive.read_draft_json !== "function") {
      incomplete("primary backup archive entry is malformed");
    }
    const epoch = assertErasureIdentifier(archive.epoch_id, "canonical backup epoch ID");
    if (epochs.has(epoch)) incomplete("primary backup archive inventory contains a duplicate epoch");
    epochs.add(epoch);

    let draftJson: unknown;
    try { draftJson = await archive.read_draft_json(); }
    catch (cause) {
      erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "persisted primary backup draft readback is unavailable", true, cause);
    }
    if (typeof draftJson === "string") {
      // Bound the encoder input before allocating its UTF-8 view or decoding JSON.
      if (draftJson.length > 1_048_576) incomplete("primary backup draft exceeds its individual byte budget");
      draftBytes += textBytes(draftJson);
      if (draftBytes > MAX_DRAFT_BYTES) incomplete("primary backup drafts exceed their aggregate byte budget");
    }
    const draft = parseBackupEpochScopeDraft(draftJson, epoch);
    for (const part of draft.part_index) add(epoch, draft.vector_digest, part.manifest, part);
    for (const part of draft.payload_part_index ?? []) {
      add(epoch, draft.vector_digest, "r2-payload", part, {
        identity: part.object_identity_digest,
        count: part.count,
      });
    }
  }
  return expected;
}

function parseListedPart(value: unknown): ListedPart {
  if (!isRecord(value)) incomplete("primary backup prefix inventory contains a malformed object");
  const key = value.key;
  if (typeof key !== "string" || !key.startsWith(PREFIX)) {
    erasureFail("ERASURE_IDENTITY_CONFLICT", "primary backup prefix inventory escaped its exact prefix");
  }
  if (key.length <= PREFIX.length || key.length > 1024 || key !== key.trim() || /[\u0000-\u001f\u007f]/u.test(key)) {
    incomplete("primary backup prefix inventory returned an invalid object key");
  }
  if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 ||
    typeof value.etag !== "string" || value.etag.length === 0 || value.etag.length > 256) {
    incomplete("primary backup prefix inventory returned malformed object pins");
  }
  if (!isRecord(value.customMetadata) || Object.keys(value.customMetadata).length > 16) {
    incomplete("primary backup part metadata is missing or malformed");
  }
  for (const [name, field] of Object.entries(value.customMetadata)) {
    if (name.length === 0 || name.length > 128 || typeof field !== "string" || field.length > 1024) {
      incomplete("primary backup part metadata is malformed");
    }
  }
  return { key, size: value.size, etag: value.etag, metadata: value.customMetadata as Readonly<Record<string, string>> };
}

async function compareListedParts(
  bucket: R2Bucket,
  expected: Map<string, PartPins>,
  allowedMissingKeys: ReadonlySet<string>,
): Promise<{ readonly objects: readonly BackupPrimaryObjectPin[]; readonly missing_keys: readonly string[] }> {
  for (const key of allowedMissingKeys) {
    if (!expected.has(key)) incomplete("persisted primary delete obligation names a key outside the immutable draft inventory");
  }
  const cursors = new Set<string>();
  const objects: BackupPrimaryObjectPin[] = [];
  let cursor: string | undefined;
  let listedParts = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    let value: unknown;
    try {
      value = await bucket.list({ prefix: PREFIX, limit: PAGE_SIZE, include: ["customMetadata"],
        ...(cursor === undefined ? {} : { cursor }) });
    } catch (cause) {
      erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "primary backup part prefix inventory failed", true, cause);
    }
    if (!isRecord(value) || !Array.isArray(value.objects) || value.objects.length > PAGE_SIZE ||
      typeof value.truncated !== "boolean") {
      incomplete("primary backup part prefix inventory returned a malformed page");
    }
    if (value.cursor !== undefined &&
      (typeof value.cursor !== "string" || value.cursor.length === 0 || value.cursor.length > 2048)) {
      erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "primary backup part pagination cursor is malformed", true);
    }
    listedParts += value.objects.length;
    if (listedParts > MAX_PARTS) incomplete("primary backup part prefix exceeds its inventory bound");
    let pageBytes = typeof value.cursor === "string" ? textBytes(value.cursor) : 0;
    for (const raw of value.objects) {
      const part = parseListedPart(raw);
      pageBytes += partBytes(part);
      if (pageBytes > MAX_PAGE_BYTES) incomplete("primary backup part page exceeds its byte budget");
      const wanted = expected.get(part.key);
      if (wanted === undefined) incomplete("primary backup store contains untracked, repeated, or pre-claim bytes");
      assertExactPart(wanted, part);
      objects.push({
        key: wanted.key,
        epoch_id: wanted.epoch_id,
        manifest: wanted.manifest,
        part_index: wanted.part_index,
        part_sha256: wanted.part_sha256,
        ...(wanted.payload_identity_digest === undefined ? {} : {
          payload_identity_digest: wanted.payload_identity_digest,
          payload_part_count: wanted.payload_part_count,
        }),
        size_bytes: part.size,
        etag: part.etag,
        custom_metadata: { ...part.metadata },
      });
      expected.delete(part.key);
    }
    if (!value.truncated) {
      if (value.cursor !== undefined) incomplete("primary backup part terminal page contains a continuation cursor");
      const missing = [...expected.keys()].sort((left, right) => left.localeCompare(right));
      if (missing.some((key) => !allowedMissingKeys.has(key))) {
        incomplete("persisted primary backup part is absent without its exact durable delete obligation");
      }
      return {
        objects: objects.sort((left, right) => left.key.localeCompare(right.key)),
        missing_keys: missing,
      };
    }
    const next = value.cursor;
    if (typeof next !== "string") {
      erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "primary backup part pagination cursor is missing", true);
    }
    if (next === cursor || cursors.has(next)) {
      erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "primary backup part pagination cursor did not advance", true);
    }
    cursors.add(next);
    cursor = next;
  }
  incomplete("primary backup part inventory exceeded its page ceiling");
}

function assertExactPart(wanted: PartPins, found: ListedPart): void {
  // Exact keys reject partial store metadata as well as unknown extra fields.
  const metadata = !STORE_METADATA.some((name) => Object.hasOwn(found.metadata, name)) ? wanted.metadata : {
    ...wanted.metadata,
    eliotr_sha256: wanted.metadata["backup_part_sha256"] as string,
    eliotr_size_bytes: String(wanted.size),
    eliotr_immutable: "true",
  };
  const wantedKeys = Object.keys(metadata).sort();
  const foundKeys = Object.keys(found.metadata).sort();
  if (found.size !== wanted.size || found.etag !== wanted.etag || wantedKeys.length !== foundKeys.length ||
    wantedKeys.some((name, index) => name !== foundKeys[index] || found.metadata[name] !== metadata[name])) {
    incomplete("primary backup part differs from its persisted size, etag, or metadata pins");
  }
}

/** Snapshot audit only; producer fencing is required before deletion. */
export async function readPrimaryBackupPartInventory(
  bucket: R2Bucket,
  archives: readonly BackupEpochScopeArchive[],
  options: { readonly allowed_missing_keys?: ReadonlySet<string> } = {},
): Promise<BackupPrimaryPartInventorySnapshot> {
  const expected = await expectedParts(archives);
  const compared = await compareListedParts(bucket, expected, options.allowed_missing_keys ?? new Set());
  return {
    object_count: compared.objects.length,
    inventory_digest: await erasureDigest(compared.objects),
    objects: compared.objects,
    missing_keys: compared.missing_keys,
  };
}

export async function assertPrimaryBackupPartInventory(
  bucket: R2Bucket,
  archives: readonly BackupEpochScopeArchive[],
): Promise<void> {
  await readPrimaryBackupPartInventory(bucket, archives);
}
