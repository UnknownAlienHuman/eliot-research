import { assertErasureIdentifier, erasureFail } from "./canonical.js";
import { parseBackupEpochScopeDraft, type BackupEpochScopeArchive } from "./backup-epoch-scope.js";

const PREFIX = "backup-parts/";
const PAGE_SIZE = 1000;
const MAX_PAGES = 1024;
const MAX_PARTS = 100_000;
const STORE_METADATA = ["eliotr_sha256", "eliotr_size_bytes", "eliotr_immutable"] as const;

interface PartPins {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly metadata: Readonly<Record<string, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function incomplete(message: string): never {
  erasureFail("ERASURE_CLOSURE_INCOMPLETE", message);
}

async function expectedParts(archives: readonly BackupEpochScopeArchive[]): Promise<Map<string, PartPins>> {
  if (!Array.isArray(archives) || archives.length > 10_000) {
    incomplete("primary backup archive inventory is malformed or over its bound");
  }
  const expected = new Map<string, PartPins>();
  const epochs = new Set<string>();
  const add = (
    epoch: string,
    vector: string,
    manifest: string,
    part: { readonly part_key: string; readonly index: number; readonly size_bytes: number; readonly etag: string; readonly sha256: string },
    payload?: { readonly identity: string; readonly index: number; readonly count: number },
  ): void => {
    const key = part.part_key;
    if (!key.startsWith(PREFIX)) incomplete("persisted primary backup part escaped its exact prefix");
    if (expected.has(key)) incomplete("persisted primary backup part inventory contains a duplicate key");
    if (expected.size >= MAX_PARTS) incomplete("persisted primary backup part inventory exceeds its bound");
    expected.set(key, {
      key,
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
    });
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
    const draft = parseBackupEpochScopeDraft(draftJson, epoch);
    for (const part of draft.part_index) add(epoch, draft.vector_digest, part.manifest, part);
    for (const part of draft.payload_part_index ?? []) {
      add(epoch, draft.vector_digest, "r2-payload", part, {
        identity: part.object_identity_digest,
        index: part.index,
        count: part.count,
      });
    }
  }
  return expected;
}

function parseListedPart(value: unknown): PartPins {
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
  const metadata = Object.create(null) as Record<string, string>;
  for (const [name, field] of Object.entries(value.customMetadata)) {
    if (name.length === 0 || name.length > 128 || typeof field !== "string" || field.length > 1024) {
      incomplete("primary backup part metadata is malformed");
    }
    metadata[name] = field;
  }
  return { key, size: value.size, etag: value.etag, metadata };
}

async function listParts(bucket: R2Bucket): Promise<Map<string, PartPins>> {
  const actual = new Map<string, PartPins>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
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
    for (const raw of value.objects) {
      const part = parseListedPart(raw);
      if (actual.has(part.key)) incomplete("primary backup prefix inventory contains a duplicate key");
      if (actual.size >= MAX_PARTS) incomplete("primary backup part prefix exceeds its inventory bound");
      actual.set(part.key, part);
    }
    if (value.cursor !== undefined &&
      (typeof value.cursor !== "string" || value.cursor.length === 0 || value.cursor.length > 2048)) {
      erasureFail("ERASURE_SETTLEMENT_UNCERTAIN", "primary backup part pagination cursor is malformed", true);
    }
    if (!value.truncated) {
      if (value.cursor !== undefined) incomplete("primary backup part terminal page contains a continuation cursor");
      return actual;
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

function assertExactInventory(expected: ReadonlyMap<string, PartPins>, actual: ReadonlyMap<string, PartPins>): void {
  for (const [key, found] of actual) {
    const wanted = expected.get(key);
    if (wanted === undefined) incomplete("primary backup store contains untracked or pre-claim bytes");
    const standardPins = STORE_METADATA.filter((name) => Object.hasOwn(found.metadata, name));
    if (standardPins.length !== 0 && standardPins.length !== STORE_METADATA.length) {
      incomplete("primary backup part has a partial immutable-store metadata pin set");
    }
    if (standardPins.length === STORE_METADATA.length &&
      (found.metadata["eliotr_sha256"] !== wanted.metadata["backup_part_sha256"] ||
        found.metadata["eliotr_size_bytes"] !== String(wanted.size) || found.metadata["eliotr_immutable"] !== "true")) {
      incomplete("primary backup part immutable-store metadata disagrees with its persisted pins");
    }
    const metadata = standardPins.length === 0 ? wanted.metadata : {
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
  for (const key of expected.keys()) {
    if (!actual.has(key)) incomplete("persisted primary backup part is absent from the part store");
  }
}

/** Snapshot audit only; producer fencing is required before deletion. */
export async function assertPrimaryBackupPartInventory(
  bucket: R2Bucket,
  archives: readonly BackupEpochScopeArchive[],
): Promise<void> {
  const expected = await expectedParts(archives);
  assertExactInventory(expected, await listParts(bucket));
}
