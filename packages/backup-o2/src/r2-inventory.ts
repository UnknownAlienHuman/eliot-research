import { backupSha256Hex, bufferBackupStream, canonicalBackupJson, failBackup, type BackupExportLimits, type Sha256DigestSinkFactory } from "./shared.js";

// ER-34 O2 FIX2 R2 list/get coherence. The digest binds key, size, etag,
// version, content digest, custom metadata AND httpMetadata plus the stable
// inventory generation (the ordered fingerprint); list/get races on any bound
// field fail closed. Version is mandatory: a missing or changed version fails
// closed instead of passing as an empty string. Raw object keys never enter
// error text or receipts (bucket label only); keys live solely in the export
// payload manifests they belong to.

const SHA256 = /^[a-f0-9]{64}$/u;
export const BACKUP_R2_PAYLOAD_PROTOCOL = "eliotr.r2-payload.v1" as const;

export interface R2PayloadPartDescriptor {
  readonly index: number;
  readonly sha256: string;
  readonly size_bytes: number;
}

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
  readonly custom_metadata: Readonly<Record<string, string>>;
  /** `cacheExpiry` is normalized to an ISO string so canonical JSON is stable. */
  readonly http_metadata: Readonly<Record<string, string>>;
  readonly payload_protocol: typeof BACKUP_R2_PAYLOAD_PROTOCOL;
  readonly payload_parts: readonly R2PayloadPartDescriptor[];
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
  readonly httpMetadata?: unknown;
}

const HTTP_METADATA_FIELDS = new Set(["contentType", "contentLanguage", "contentDisposition", "contentEncoding", "cacheControl", "cacheExpiry"]);

export function normalizeBackupR2CustomMetadata(value: unknown, label = "object"): Readonly<Record<string, string>> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) failBackup("BACKUP_OBJECT_UNREADABLE", `backup R2 ${label} metadata is malformed`);
  const normalized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key.length === 0 || typeof entry !== "string") failBackup("BACKUP_OBJECT_UNREADABLE", `backup R2 ${label} metadata contains an invalid value`);
    normalized[key] = entry;
  }
  return normalized;
}

export function normalizeBackupR2HttpMetadata(value: unknown, label = "object"): Readonly<Record<string, string>> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) failBackup("BACKUP_OBJECT_UNREADABLE", `backup R2 ${label} HTTP metadata is malformed`);
  const normalized: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!HTTP_METADATA_FIELDS.has(key)) failBackup("BACKUP_OBJECT_UNREADABLE", `backup R2 ${label} HTTP metadata contains an unsupported field`);
    if (key === "cacheExpiry") {
      const date = entry instanceof Date ? entry : typeof entry === "string" ? new Date(entry) : null;
      if (date === null || !Number.isFinite(date.getTime())) failBackup("BACKUP_OBJECT_UNREADABLE", `backup R2 ${label} cache expiry is malformed`);
      normalized[key] = date.toISOString();
      continue;
    }
    if (typeof entry !== "string") failBackup("BACKUP_OBJECT_UNREADABLE", `backup R2 ${label} HTTP metadata contains an invalid value`);
    normalized[key] = entry;
  }
  return normalized;
}

function hex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function joinByteChunks(chunks: readonly Uint8Array[], size: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function digestAndDescribePayload(
  body: ReadableStream<Uint8Array>,
  expectedSize: number,
  limits: BackupExportLimits,
  createSink?: Sha256DigestSinkFactory,
  label = "object",
): Promise<{ readonly sha256: string; readonly size_bytes: number; readonly payload_parts: readonly R2PayloadPartDescriptor[] }> {
  if (createSink === undefined) {
    const bytes = await bufferBackupStream(body, limits.max_object_bytes);
    const payloadParts: R2PayloadPartDescriptor[] = [];
    const count = Math.max(1, Math.ceil(bytes.byteLength / limits.part_bytes));
    for (let index = 0; index < count; index += 1) {
      const chunk = bytes.slice(index * limits.part_bytes, Math.min(bytes.byteLength, (index + 1) * limits.part_bytes));
      payloadParts.push({ index: index + 1, sha256: await backupSha256Hex(chunk), size_bytes: chunk.byteLength });
    }
    if (bytes.byteLength !== expectedSize) failBackup("BACKUP_OBJECT_UNREADABLE", `backup R2 ${label} object size changed during readback`);
    return { sha256: await backupSha256Hex(bytes), size_bytes: bytes.byteLength, payload_parts: payloadParts };
  }

  const sink = createSink();
  const reader = body.getReader();
  const writer = sink.writable.getWriter();
  const payloadParts: R2PayloadPartDescriptor[] = [];
  let pending: Uint8Array[] = [];
  let pendingSize = 0;
  let size = 0;
  let closed = false;
  const finishPart = async (): Promise<void> => {
    const bytes = joinByteChunks(pending, pendingSize);
    payloadParts.push({ index: payloadParts.length + 1, sha256: await backupSha256Hex(bytes), size_bytes: bytes.byteLength });
    pending = [];
    pendingSize = 0;
  };
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) failBackup("BACKUP_OBJECT_UNREADABLE", `backup R2 ${label} body yielded a non-byte chunk`, true);
      size += next.value.byteLength;
      if (!Number.isSafeInteger(size) || size > limits.max_object_bytes) failBackup("BACKUP_BOUND_EXCEEDED", "backup R2 object exceeds its per-object byte bound");
      await writer.write(next.value);
      let offset = 0;
      while (offset < next.value.byteLength) {
        const take = Math.min(limits.part_bytes - pendingSize, next.value.byteLength - offset);
        pending.push(next.value.slice(offset, offset + take));
        pendingSize += take;
        offset += take;
        if (pendingSize === limits.part_bytes) await finishPart();
      }
    }
    await writer.close();
    closed = true;
    if (pendingSize > 0 || payloadParts.length === 0) await finishPart();
    if (size !== expectedSize) failBackup("BACKUP_OBJECT_UNREADABLE", `backup R2 ${label} object size changed during readback`);
    return { sha256: hex(await sink.digest), size_bytes: size, payload_parts: payloadParts };
  } finally {
    if (!closed) {
      try { await reader.cancel(); } catch { /* preserve the primary error */ }
      try { await writer.abort(); } catch { /* preserve the primary error */ }
    }
    reader.releaseLock();
    writer.releaseLock();
  }
}

export async function backupR2ObjectIdentity(entry: Pick<R2ObjectEntry,
  "bucket" | "key" | "size_bytes" | "etag" | "version" | "sha256" | "admitted_sha256" | "metadata_digest" | "http_metadata_digest">): Promise<string> {
  return backupSha256Hex(canonicalBackupJson({
    bucket: entry.bucket, key: entry.key, size_bytes: entry.size_bytes, etag: entry.etag,
    version: entry.version, sha256: entry.sha256, admitted_sha256: entry.admitted_sha256,
    metadata_digest: entry.metadata_digest, http_metadata_digest: entry.http_metadata_digest,
  }));
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
      const listedMeta = normalizeBackupR2CustomMetadata(listed.customMetadata, label);
      const bodyMeta = normalizeBackupR2CustomMetadata(body.customMetadata, label);
      if (canonicalBackupJson(listedMeta) !== canonicalBackupJson(bodyMeta)) {
        failBackup("BACKUP_OBJECT_UNREADABLE", "backup R2 object metadata mutated between list and get", false, { bucket: label });
      }
      const listedHttp = normalizeBackupR2HttpMetadata(listed.httpMetadata, label);
      const bodyHttp = normalizeBackupR2HttpMetadata((body as unknown as { readonly httpMetadata?: unknown }).httpMetadata, label);
      if (canonicalBackupJson(listedHttp) !== canonicalBackupJson(bodyHttp)) {
        failBackup("BACKUP_OBJECT_UNREADABLE", "backup R2 object http metadata mutated between list and get", false, { bucket: label });
      }
      const hash = await digestAndDescribePayload(body.body, listed.size, limits, createSink, label);
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
        custom_metadata: bodyMeta,
        http_metadata: bodyHttp,
        payload_protocol: BACKUP_R2_PAYLOAD_PROTOCOL,
        payload_parts: hash.payload_parts,
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
