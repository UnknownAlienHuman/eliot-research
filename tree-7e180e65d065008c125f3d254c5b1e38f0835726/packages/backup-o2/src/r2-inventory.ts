import { backupSha256Hex, canonicalBackupJson, failBackup, hashBackupStream, type BackupExportLimits, type Sha256DigestSinkFactory } from "./shared.js";

// ER-34 O2 FIX2 R2 list/get coherence. The digest binds key, size, etag,
// version, content digest, custom metadata AND httpMetadata plus the stable
// inventory generation (the ordered fingerprint); list/get races on any bound
// field fail closed. Version is mandatory: a missing or changed version fails
// closed instead of passing as an empty string. Raw object keys never enter
// error text or receipts (bucket label only); keys live solely in the export
// payload manifests they belong to.

const SHA256 = /^[a-f0-9]{64}$/u;

export interface R2ObjectEntry {
  readonly bucket: "evidence" | "work";
  readonly key: string;
  readonly size_bytes: number;
  readonly etag: string;
  readonly version: string;
  readonly sha256: string;
  readonly admitted_sha256: string | null;
  readonly metadata_digest: string;
  readonly http_metadata_digest: string;
}

export interface BackupR2Tally {
  keys: number;
  bytes: number;
}

export function freshBackupR2Tally(): BackupR2Tally {
  return { keys: 0, bytes: 0 };
}

interface ListedObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly version?: unknown;
  readonly customMetadata?: Record<string, string> | undefined;
  readonly httpMetadata?: Record<string, string> | undefined;
}

export async function snapshotBackupR2Bucket(
  bucket: R2Bucket,
  label: "evidence" | "work",
  limits: BackupExportLimits,
  createSink: Sha256DigestSinkFactory | undefined,
  tally: BackupR2Tally,
  signal?: AbortSignal,
): Promise<{ readonly entries: readonly R2ObjectEntry[]; readonly fingerprint: string }> {
  const entries: R2ObjectEntry[] = [];
  const seen = new Set<string>();
  let pages = 0;
  let cursor: string | undefined;
  let previousCursor: string | undefined;
  for (;;) {
    if (signal?.aborted === true) failBackup("BACKUP_CANCELLED", "backup export was cancelled", true);
    pages += 1;
    if (pages > limits.max_r2_pages) failBackup("BACKUP_BOUND_EXCEEDED", `backup R2 ${label} listing exceeds its page bound`, false, { bucket: label, limit: String(limits.max_r2_pages) });
    let page: R2Objects;
    try {
      page = await bucket.list({ limit: limits.r2_list_page_size, include: ["customMetadata", "httpMetadata"], ...(cursor === undefined ? {} : { cursor }) });
    } catch (cause) {
      failBackup("BACKUP_OBJECT_UNREADABLE", `backup R2 ${label} listing is unavailable`, true, { bucket: label }, cause);
    }
    if (cursor !== undefined && page.truncated && (page as { readonly cursor?: unknown }).cursor === previousCursor) {
      failBackup("BACKUP_OBJECT_UNREADABLE", `backup R2 ${label} pagination cursor stalled; omission risk`, true, { bucket: label });
    }
    for (const object of page.objects) {
      const listed = object as unknown as ListedObject;
      if (typeof listed.key !== "string" || listed.key.length === 0) failBackup("BACKUP_OBJECT_UNREADABLE", `backup R2 ${label} listing carries a malformed key`, false, { bucket: label });
      if (seen.has(listed.key)) failBackup("BACKUP_OBJECT_UNREADABLE", `backup R2 ${label} pagination duplicated an object key`, false, { bucket: label });
      seen.add(listed.key);
      if (tally.keys >= limits.max_r2_keys) failBackup("BACKUP_BOUND_EXCEEDED", `backup R2 ${label} objects exceed the key bound`, false, { bucket: label, limit: String(limits.max_r2_keys) });
      if (listed.size > limits.max_object_bytes) failBackup("BACKUP_BOUND_EXCEEDED", "backup R2 object exceeds the per-object byte bound", false, { bucket: label, limit: String(limits.max_object_bytes) });
      tally.bytes += listed.size;
      if (tally.bytes > limits.max_total_object_bytes) failBackup("BACKUP_BOUND_EXCEEDED", `backup R2 ${label} objects exceed the total byte bound`, false, { bucket: label, limit: String(limits.max_total_object_bytes) });
      if (typeof listed.etag !== "string" || listed.etag.length === 0) failBackup("BACKUP_OBJECT_UNREADABLE", `backup R2 ${label} object is missing its etag`, false, { bucket: label });
      if (typeof listed.version !== "string" || listed.version.length === 0) failBackup("BACKUP_OBJECT_UNREADABLE", `backup R2 ${label} object is missing its version; refusing version-less acceptance`, false, { bucket: label });
      const listedVersion: string = listed.version;
      let body: R2ObjectBody | null;
      try {
        body = await bucket.get(listed.key);
      } catch (cause) {
        failBackup("BACKUP_OBJECT_UNREADABLE", "backup R2 object read is unavailable", true, { bucket: label }, cause);
      }
      if (body === null) failBackup("BACKUP_OBJECT_UNREADABLE", "backup R2 object vanished during export", true, { bucket: label });
      if (body.size !== listed.size) failBackup("BACKUP_OBJECT_UNREADABLE", "backup R2 object size mutated between list and get", false, { bucket: label });
      if (body.etag !== listed.etag) failBackup("BACKUP_OBJECT_UNREADABLE", "backup R2 object etag mutated between list and get", false, { bucket: label });
      const bodyVersion = (body as unknown as { readonly version?: unknown }).version;
      if (typeof bodyVersion !== "string" || bodyVersion.length === 0) failBackup("BACKUP_OBJECT_UNREADABLE", "backup R2 object version is absent on readback", false, { bucket: label });
      if (bodyVersion !== listedVersion) {
        failBackup("BACKUP_OBJECT_UNREADABLE", "backup R2 object version mutated between list and get", false, { bucket: label });
      }
      const listedMeta = listed.customMetadata ?? {};
      const bodyMeta = body.customMetadata ?? {};
      if (canonicalBackupJson(listedMeta) !== canonicalBackupJson(bodyMeta)) {
        failBackup("BACKUP_OBJECT_UNREADABLE", "backup R2 object metadata mutated between list and get", false, { bucket: label });
      }
      const listedHttp = listed.httpMetadata ?? {};
      const bodyHttp = (body as unknown as { readonly httpMetadata?: Record<string, string> | undefined }).httpMetadata ?? {};
      if (canonicalBackupJson(listedHttp) !== canonicalBackupJson(bodyHttp)) {
        failBackup("BACKUP_OBJECT_UNREADABLE", "backup R2 object http metadata mutated between list and get", false, { bucket: label });
      }
      const hash = await hashBackupStream(body.body, listed.size, createSink);
      if (hash.size_bytes !== listed.size) failBackup("BACKUP_OBJECT_UNREADABLE", "backup R2 object truncated during readback", false, { bucket: label });
      const admitted = bodyMeta["eliotr_sha256"];
      if (admitted !== undefined && admitted !== hash.sha256) failBackup("BACKUP_OBJECT_DIGEST_MISMATCH", "backup R2 object digest disagrees with its admitted digest", false, { bucket: label });
      if (typeof admitted === "string" && !SHA256.test(admitted)) failBackup("BACKUP_OBJECT_DIGEST_MISMATCH", "backup R2 object carries a malformed admitted digest", false, { bucket: label });
      entries.push({
        bucket: label,
        key: listed.key,
        size_bytes: listed.size,
        etag: listed.etag,
        version: listedVersion,
        sha256: hash.sha256,
        admitted_sha256: typeof admitted === "string" ? admitted : null,
        metadata_digest: await backupSha256Hex(canonicalBackupJson(bodyMeta)),
        http_metadata_digest: await backupSha256Hex(canonicalBackupJson(bodyHttp)),
      });
      tally.keys += 1;
    }
    if (!page.truncated) break;
    previousCursor = cursor;
    const nextCursor = (page as { readonly cursor?: string | undefined }).cursor;
    cursor = nextCursor;
    if (cursor === undefined) failBackup("BACKUP_OBJECT_UNREADABLE", `backup R2 ${label} pagination truncated without a cursor`, true, { bucket: label });
  }
  const ordered = [...entries].sort((left, right) => {
    const leftKey = `${left.bucket}\u0000${left.key}`;
    const rightKey = `${right.bucket}\u0000${right.key}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  // The ordered fingerprint is the stable inventory generation bound into the
  // coherent cut and the epoch vector.
  return { entries: ordered, fingerprint: await backupSha256Hex(ordered.map((entry) => canonicalBackupJson(entry)).join("\n")) };
}
