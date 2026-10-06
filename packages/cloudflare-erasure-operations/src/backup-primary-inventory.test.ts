import { describe, expect, it, vi } from "vitest";
import { BACKUP_R2_PAYLOAD_PROTOCOL } from "@eliotr/backup-o2";
import type { BackupEpochScopeArchive } from "@eliotr/cloudflare-erasure";
import { assertPrimaryBackupPartInventory } from "./backup-primary-inventory.js";

const MANIFESTS = [
  "schema", "schema-inventory", "ownership", "sources", "revisions", "projects", "scopes",
  "handles", "heads", "generations", "retention", "purge", "r2-objects", "rebuild", "vector",
] as const;
const SHA = "a".repeat(64);
const VECTOR = "b".repeat(64);
const IDENTITY = "c".repeat(64);

interface ListedPart {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly customMetadata?: Readonly<Record<string, string>> | undefined;
}

function hash(index: number): string { return index.toString(16).padStart(2, "0").repeat(32); }

function makeArchive(epoch: string, payload = true, partsPerManifest = 1, etagChars = 0) {
  const manifestParts = MANIFESTS.flatMap((manifest, index) => Array.from({ length: partsPerManifest }, (_, offset) => {
    const sha256 = hash(index + 1);
    return { manifest, index: offset + 1, part_key: `backup-parts/${epoch}/${manifest}/${String(offset + 1).padStart(6, "0")}-${sha256}`,
      sha256, size_bytes: 1, etag: `manifest-etag-${index + 1}`.padEnd(etagChars, "e"), existed_identically: false };
  }));
  const payloadPart = { object_identity_digest: IDENTITY, index: 1, count: 1,
    part_key: `backup-parts/${epoch}/r2-payload/${IDENTITY}/000001-${SHA}`,
    sha256: SHA, size_bytes: 3, etag: "payload-etag-1", existed_identically: false };
  const draft = {
    epoch_id: epoch, schema_generation: "schema-generation-1", migration_ledger_digest: SHA,
    manifest_digests: Object.fromEntries(MANIFESTS.map((name, index) => [name, hash(index + 20)])),
    group_digests: { core: SHA, heads: SHA, generations: SHA, r2: SHA }, part_index: manifestParts,
    ...(payload ? { r2_payload_protocol: BACKUP_R2_PAYLOAD_PROTOCOL, payload_part_index: [payloadPart] } : {}),
    purge_ledger_revision: 0, purge_ledger_digest: SHA, r2_object_count: payload ? 1 : 0,
    r2_total_bytes: payload ? 3 : 0, audit_sample_receipt_ref: `audit-${epoch}`,
    vector_digest: VECTOR, vector_manifest_digest: hash(40), cut_id: `cut-${epoch}`,
    manifest_protocol: "eliotr.backup-manifest.v1", created_at: "2026-10-01T00:00:00.000Z",
    expires_at: "2027-10-01T00:00:00.000Z",
  };
  const listPart = (part: { readonly part_key: string; readonly size_bytes: number; readonly etag: string;
    readonly index: number; readonly sha256: string }, manifest: string, payloadPins?: { identity: string; count: number }): ListedPart => ({
    key: part.part_key, size: part.size_bytes, etag: part.etag,
    customMetadata: {
      backup_epoch: epoch, backup_vector_digest: VECTOR, backup_manifest: manifest,
      backup_part_index: String(part.index), backup_part_sha256: part.sha256,
      ...(payloadPins === undefined ? {} : {
        backup_object_identity_digest: payloadPins.identity, backup_part_count: String(payloadPins.count),
      }),
    },
  });
  const listed = [
    ...manifestParts.map((part) => listPart(part, part.manifest)),
    ...(payload ? [listPart(payloadPart, "r2-payload", { identity: IDENTITY, count: 1 })] : []),
  ];
  const archive: BackupEpochScopeArchive = {
    epoch_id: epoch, verification_state: "VERIFIED",
    async read_draft_json() { return JSON.stringify(draft); },
    async read_plaintext_part() { return null; },
  };
  return { archive, listed, draft };
}

function bucketForPage(readPage: (request: unknown, index: number) => unknown) {
  let count = 0;
  const requests: unknown[] = [];
  const list = vi.fn(async (request: unknown) => {
    requests.push(request);
    return readPage(request, count++);
  });
  const remove = vi.fn(async () => undefined);
  return { bucket: { list, delete: remove } as unknown as R2Bucket, list, requests, remove };
}

function bucketFor(entries: readonly unknown[], pageSize = 1000) {
  return bucketForPage((_request, number) => {
    const start = number * pageSize;
    const end = Math.min(start + pageSize, entries.length);
    return { objects: entries.slice(start, end), truncated: end < entries.length,
      ...(end < entries.length ? { cursor: `cursor-${end}` } : {}) };
  });
}

function scriptedBucket(pages: readonly unknown[]) {
  return bucketForPage((_request, number) => pages[number]);
}

async function expectBlocked(bucket: R2Bucket, archives: readonly BackupEpochScopeArchive[], code = "ERASURE_CLOSURE_INCOMPLETE") {
  await expect(assertPrimaryBackupPartInventory(bucket, archives)).rejects.toMatchObject({ code });
}

function withFirstPart(parts: readonly ListedPart[], patch: Partial<ListedPart>): ListedPart[] {
  return [{ ...(parts[0] as ListedPart), ...patch }, ...parts.slice(1)];
}

describe("primary backup part inventory", () => {
  it("matches committed legacy and payload parts across pages, with either supported metadata shape", async () => {
    const modern = makeArchive("epoch-modern");
    const legacy = makeArchive("epoch-legacy", false);
    const parts = modern.listed.map((part, index) => index === 0 ? {
      ...part,
      customMetadata: { ...(part.customMetadata ?? {}), eliotr_sha256: part.customMetadata?.backup_part_sha256 ?? "",
        eliotr_size_bytes: String(part.size), eliotr_immutable: "true" },
    } : part);
    const all = [...parts, ...legacy.listed];
    const bucket = bucketFor(all, 10);

    await expect(assertPrimaryBackupPartInventory(bucket.bucket, [modern.archive, legacy.archive])).resolves.toBeUndefined();
    expect(bucket.list).toHaveBeenCalledTimes(4);
    expect(bucket.requests[0]).toMatchObject({ prefix: "backup-parts/", limit: 1000, include: ["customMetadata"] });
    expect(bucket.requests[1]).toMatchObject({ cursor: "cursor-10" });
    expect(bucket.remove).not.toHaveBeenCalled();
  });

  it.each([
    ["unclaimed epoch part", makeArchive("epoch-preclaim").listed[0] as ListedPart],
    ["extra payload chunk", {
      key: `backup-parts/epoch-committed/r2-payload/${IDENTITY}/000002-${hash(41)}`, size: 1, etag: "extra-etag",
      customMetadata: { backup_epoch: "epoch-committed", backup_vector_digest: VECTOR, backup_manifest: "r2-payload",
        backup_part_index: "2", backup_part_sha256: hash(41), backup_object_identity_digest: IDENTITY, backup_part_count: "2" },
    } satisfies ListedPart],
  ])("blocks %s without deleting", async (_name, extra) => {
    const archive = makeArchive("epoch-committed");
    const bucket = bucketFor([...archive.listed, extra]);
    await expectBlocked(bucket.bucket, [archive.archive]);
    expect(bucket.remove).not.toHaveBeenCalled();
  });

  it("blocks pre-claim bytes even when no committed epoch is listed", async () => {
    const orphan = makeArchive("epoch-without-receipt").listed[0] as ListedPart;
    const bucket = scriptedBucket([
      { objects: [orphan], truncated: true, cursor: "never-read" }, { objects: [], truncated: false },
    ]);
    await expectBlocked(bucket.bucket, []);
    expect(bucket.list).toHaveBeenCalledTimes(1);
    expect(bucket.remove).not.toHaveBeenCalled();
  });

  it.each([
    ["missing part", (parts: readonly ListedPart[]) => parts.slice(1)],
    ["missing metadata", (parts: readonly ListedPart[]) => withFirstPart(parts, { customMetadata: undefined })],
    ["wrong size", (parts: readonly ListedPart[]) => withFirstPart(parts, { size: 2 })],
    ["wrong etag", (parts: readonly ListedPart[]) => withFirstPart(parts, { etag: "foreign-etag" })],
    ["wrong vector pin", (parts: readonly ListedPart[]) => withFirstPart(parts, {
      customMetadata: { ...(parts[0]?.customMetadata ?? {}), backup_vector_digest: SHA },
    })],
    ["extra unknown metadata", (parts: readonly ListedPart[]) => withFirstPart(parts, {
      customMetadata: { ...(parts[0]?.customMetadata ?? {}), unrelated: "value" },
    })],
    ["partial standard metadata trio", (parts: readonly ListedPart[]) => withFirstPart(parts, {
      customMetadata: { ...(parts[0]?.customMetadata ?? {}), eliotr_sha256: SHA },
    })],
    ["corrupt standard metadata trio", (parts: readonly ListedPart[]) => withFirstPart(parts, {
      customMetadata: { ...(parts[0]?.customMetadata ?? {}), eliotr_sha256: SHA,
        eliotr_size_bytes: "999", eliotr_immutable: "true" },
    })],
    ["wrong payload count", (parts: readonly ListedPart[]) => parts.map((part) => part.key.includes("/r2-payload/")
      ? { ...part, customMetadata: { ...(part.customMetadata ?? {}), backup_part_count: "2" } } : part)],
    ["missing payload identity", (parts: readonly ListedPart[]) => parts.map((part) => part.key.includes("/r2-payload/")
      ? { ...part, customMetadata: Object.fromEntries(Object.entries(part.customMetadata ?? {})
        .filter(([key]) => key !== "backup_object_identity_digest")) } : part)],
  ])("blocks %s", async (_name, mutate) => {
    const archive = makeArchive("epoch-pinned");
    await expectBlocked(bucketFor(mutate(archive.listed)).bucket, [archive.archive]);
  });

  it("rejects a repeated key across pages before fetching the remaining prefix", async () => {
    const archive = makeArchive("epoch-pages");
    const valid = archive.listed;
    const bucket = scriptedBucket([
      { objects: valid.slice(0, 1), truncated: true, cursor: "cursor-1" },
      { objects: [valid[0]], truncated: true, cursor: "never-read" },
      { objects: valid.slice(1), truncated: false },
    ]);
    await expectBlocked(bucket.bucket, [archive.archive]);
    expect(bucket.list).toHaveBeenCalledTimes(2);
    expect(bucket.remove).not.toHaveBeenCalled();
  });

  it("rejects prefix escape, malformed pages, and invalid cursors", async () => {
    const archive = makeArchive("epoch-pages");
    const valid = archive.listed;
    const escaped = withFirstPart(valid, { key: "other-bucket/object" });
    await expectBlocked(bucketFor(escaped).bucket, [archive.archive], "ERASURE_IDENTITY_CONFLICT");
    for (const page of [
      { objects: null, truncated: false }, { objects: [], truncated: "false" }, { objects: [null], truncated: false },
      { objects: [], truncated: false, cursor: "hidden-next-page" },
      { objects: [{ key: "backup-parts/epoch-pages/x", size: -1, etag: "e", customMetadata: {} }], truncated: false },
      { objects: [{ key: "backup-parts/", size: 1, etag: "e", customMetadata: {} }], truncated: false },
      { objects: Array.from({ length: 1001 }, () => null), truncated: false },
    ]) await expectBlocked(scriptedBucket([page]).bucket, []);

    await expectBlocked(scriptedBucket([{ objects: [], truncated: true }]).bucket, [], "ERASURE_SETTLEMENT_UNCERTAIN");
    await expectBlocked(scriptedBucket([
      { objects: [], truncated: true, cursor: "cycle" }, { objects: [], truncated: true, cursor: "cycle" },
    ]).bucket, [], "ERASURE_SETTLEMENT_UNCERTAIN");
  });

  it("blocks object and page ceilings", async () => {
    const overflow = bucketForPage((_request, page) => {
      const start = page * 1000;
      const end = Math.min(start + 1000, 100_001);
      return { objects: Array.from({ length: end - start }, (_unused, offset) => ({
        key: `backup-parts/orphan-${String(start + offset).padStart(6, "0")}`, size: 0, etag: "e", customMetadata: {},
      })), truncated: end < 100_001, ...(end < 100_001 ? { cursor: `cursor-${end}` } : {}) };
    });
    await expectBlocked(overflow.bucket, []);
    expect(overflow.list).toHaveBeenCalledTimes(1);

    const pages = bucketForPage((_request, page) => ({ objects: [], truncated: true, cursor: `cursor-${page}` }));
    await expectBlocked(pages.bucket, []);
    expect(pages.list).toHaveBeenCalledTimes(1024);
  });

  it("refuses aggregate draft bytes before parsing or listing the next archive", async () => {
    const archives = Array.from({ length: 6 }, (_, index) => {
      const epoch = makeArchive(`epoch-draft-budget-${index}`, false);
      return { ...epoch.archive, read_draft_json: vi.fn(async () =>
        JSON.stringify(epoch.draft).replace("{", `{${" ".repeat(900_000)}`)) };
    });
    const bucket = bucketFor([]);
    await expect(assertPrimaryBackupPartInventory(bucket.bucket, archives)).rejects.toMatchObject({
      code: "ERASURE_CLOSURE_INCOMPLETE", message: "primary backup drafts exceed their aggregate byte budget",
    });
    expect(archives[5]?.read_draft_json).not.toHaveBeenCalled();
    expect(bucket.list).not.toHaveBeenCalled();
  });

  it("refuses accumulated expected pin bytes before listing", async () => {
    const archives = Array.from({ length: 20 }, (_, index) =>
      makeArchive(`epoch-pin-budget-${index}-${"e".repeat(220)}`, false, 25).archive);
    const bucket = bucketFor([]);
    await expect(assertPrimaryBackupPartInventory(bucket.bucket, archives)).rejects.toMatchObject({
      code: "ERASURE_CLOSURE_INCOMPLETE", message: "persisted primary backup part inventory exceeds its byte budget",
    });
    expect(bucket.list).not.toHaveBeenCalled();
  });

  it("refuses a matching page over its byte budget before requesting another page", async () => {
    const epoch = makeArchive(`epoch-page-budget-${"e".repeat(224)}`, false, 70, 256);
    const bucket = bucketFor(epoch.listed);
    await expect(assertPrimaryBackupPartInventory(bucket.bucket, [epoch.archive])).rejects.toMatchObject({
      code: "ERASURE_CLOSURE_INCOMPLETE", message: "primary backup part page exceeds its byte budget",
    });
    expect(bucket.list).toHaveBeenCalledTimes(1);
    expect(bucket.remove).not.toHaveBeenCalled();
  });
});
