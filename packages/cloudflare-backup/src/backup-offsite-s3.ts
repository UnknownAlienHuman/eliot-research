import { BackupError, type BackupErrorCode, type OffsiteCopyAdapter, type OffsiteStoredPart } from "@eliotr/backup-o2";
import type { OffsiteDestinationDescriptor } from "@eliotr/backup-o2";

const TOMBSTONE_BODY = new TextEncoder().encode("ELIOTR_OFFSITE_TOMBSTONE_V1\n");
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PART_BYTES = 16 * 1024 * 1024;
const HARD_MAX_PART_BYTES = 64 * 1024 * 1024;
const MAX_TOMBSTONE_BYTES = 128;
const MAX_STREAM_CHUNKS = 16_384;
const META_PREFIX = "x-amz-meta-eliotr-";
const encoder = new TextEncoder();

export interface S3OffsiteCopyAdapterConfig {
  /** Provider contract is pinned so generic/versioned S3 buckets cannot claim this tombstone protocol. */
  readonly provider_kind: "cloudflare-r2";
  /** Must be verified by operator configuration; a versioned bucket retains old ciphertext versions. */
  readonly bucket_versioning: "disabled";
  /** Exact HTTPS R2 S3 endpoint selected by the trusted composition root. */
  readonly endpoint: string;
  /** Bucket selected by the trusted composition root; never inferred from the host. */
  readonly bucket: string;
  /** R2 requires the S3 region value `auto`. */
  readonly region: "auto";
  /** Policy endpoint identity resolved by the trusted controller/configuration path. */
  readonly endpoint_identity: string;
  readonly access_key_id: string;
  readonly secret_access_key: string;
  /** Descriptor from the approved destination authority. It is not derived from endpoint text. */
  readonly descriptor: OffsiteDestinationDescriptor;
  readonly fetch_impl?: typeof fetch;
  readonly now?: () => Date;
  readonly timeout_ms?: number;
  readonly max_part_bytes?: number;
}

type PartMetadata = Omit<OffsiteStoredPart, "ciphertext">;
type RemoteRecord =
  | { readonly kind: "missing" }
  | { readonly kind: "part"; readonly ciphertext: Uint8Array; readonly stored: PartMetadata; readonly ciphertext_sha256: string; readonly etag: string }
  | { readonly kind: "tombstone"; readonly reason_sha256: string; readonly etag: string };

function fail(code: BackupErrorCode, message: string): never {
  throw new BackupError(code, message, false, {});
}

function validIdentifier(value: unknown, name: string, max = 256): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(value)) {
    fail("BACKUP_INPUT_INVALID", `${name} is malformed`);
  }
}

function validatePartRef(partRef: string): string {
  if (typeof partRef !== "string" || partRef.length > 1024 || partRef.startsWith("/") || partRef.endsWith("/") || partRef.includes("\\") || /[%?#\u0000-\u001f\u007f]/.test(partRef)) {
    fail("BACKUP_INPUT_INVALID", "offsite part reference is malformed");
  }
  const segments = partRef.split("/");
  if (segments.length < 2 || segments[0] !== "offsite" || segments.some((part) => part.length === 0 || part === "." || part === ".." || !/^[A-Za-z0-9._:@-]{1,255}$/.test(part))) {
    fail("BACKUP_INPUT_INVALID", "offsite part reference is malformed");
  }
  return segments.map(awsUriEncode).join("/");
}

function validateReason(reason: string): void {
  if (typeof reason !== "string" || reason.length < 1 || reason.length > 256 || /[\u0000-\u001f\u007f]/.test(reason)) {
    fail("BACKUP_INPUT_INVALID", "offsite expiry reason is malformed");
  }
}

function validateMetadata(stored: PartMetadata): void {
  if (stored === null || typeof stored !== "object") fail("BACKUP_INPUT_INVALID", "offsite part metadata is malformed");
  if (!/^[a-f0-9]{64}$/.test(stored.content_digest)) fail("BACKUP_INPUT_INVALID", "offsite content digest is malformed");
  if (!Number.isSafeInteger(stored.size_bytes) || stored.size_bytes < 0) fail("BACKUP_INPUT_INVALID", "offsite part size is malformed");
  validIdentifier(stored.key_generation, "offsite key generation");
  validIdentifier(stored.epoch_id, "offsite epoch identity");
  if (typeof stored.expires_at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(stored.expires_at) || !Number.isFinite(Date.parse(stored.expires_at))) {
    fail("BACKUP_INPUT_INVALID", "offsite expiry timestamp is malformed");
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  return owned.buffer;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytesToArrayBuffer(bytes))));
}

async function sha256Text(value: string): Promise<string> {
  return sha256Hex(encoder.encode(value));
}

function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function normalizeHeader(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function dateParts(date: Date): { readonly amzDate: string; readonly shortDate: string } {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) fail("BACKUP_OBJECT_UNREADABLE", "offsite request clock is invalid");
  const iso = date.toISOString();
  return { amzDate: `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`, shortDate: iso.slice(0, 10).replaceAll("-", "") };
}

async function hmac(key: Uint8Array | ArrayBuffer, value: string): Promise<Uint8Array> {
  const keyBytes = key instanceof Uint8Array ? bytesToArrayBuffer(key) : key;
  const imported = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, bytesToArrayBuffer(encoder.encode(value))));
}

async function signingKey(secret: string, day: string, region: string): Promise<Uint8Array> {
  const dateKey = await hmac(encoder.encode(`AWS4${secret}`), day);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

export async function signSigV4S3Request(input: {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly payloadHash: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  readonly date: Date;
}): Promise<string> {
  const { amzDate, shortDate } = dateParts(input.date);
  input.headers.set("x-amz-date", amzDate);
  input.headers.set("x-amz-content-sha256", input.payloadHash);
  const signedNames = ["host", ...[...input.headers.keys()].filter((name) => name !== "authorization").sort()];
  const uniqueNames = [...new Set(signedNames)].sort();
  const canonicalHeaders = uniqueNames.map((name) => {
    const value = name === "host" ? input.url.host : input.headers.get(name);
    if (value === null || value === undefined) fail("BACKUP_OBJECT_UNREADABLE", "offsite request could not be signed");
    return `${name}:${normalizeHeader(value)}\n`;
  }).join("");
  const canonicalRequest = [input.method, input.url.pathname, "", canonicalHeaders, uniqueNames.join(";"), input.payloadHash].join("\n");
  const canonicalHash = await sha256Hex(encoder.encode(canonicalRequest));
  const scope = `${shortDate}/${input.region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${canonicalHash}`;
  const signature = bytesToHex(await hmac(await signingKey(input.secretAccessKey, shortDate, input.region), stringToSign));
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope},SignedHeaders=${uniqueNames.join(";")},Signature=${signature}`;
}

async function readLimit(response: Response, maxBytes: number): Promise<void> {
  const length = response.headers.get("content-length");
  if (length === null) return;
  if (!/^\d+$/.test(length) || Number(length) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    fail("BACKUP_OBJECT_UNREADABLE", "offsite response exceeds the configured bound");
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  await readLimit(response, maxBytes);
  if (response.body === null) {
    if (response.headers.get("content-length") === "0") return new Uint8Array();
    fail("BACKUP_OBJECT_UNREADABLE", "offsite response body is missing");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let chunkCount = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkCount += 1;
      if (chunkCount > MAX_STREAM_CHUNKS) {
        await reader.cancel().catch(() => undefined);
        fail("BACKUP_OBJECT_UNREADABLE", "offsite response exceeds the configured stream-chunk bound");
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        fail("BACKUP_OBJECT_UNREADABLE", "offsite response exceeds the configured bound");
      }
      chunks.push(value.slice());
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    fail("BACKUP_OBJECT_UNREADABLE", "offsite response could not be read");
  }
  if (response.headers.get("content-length") !== null && total !== Number(response.headers.get("content-length"))) {
    fail("BACKUP_OBJECT_UNREADABLE", "offsite response length is inconsistent");
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function metadataHeaders(metadata: Record<string, string>): Headers {
  const headers = new Headers({ "content-type": "application/octet-stream" });
  for (const [key, value] of Object.entries(metadata)) headers.set(`${META_PREFIX}${key}`, value);
  return headers;
}

function responseMetadata(headers: Headers): Record<string, string> {
  const keys = ["format", "record", "content-digest", "size-bytes", "ciphertext-bytes", "ciphertext-sha256", "key-generation", "epoch-id", "expires-at", "reason-sha256"];
  const values: Record<string, string> = {};
  for (const key of keys) {
    const value = headers.get(`${META_PREFIX}${key}`);
    if (value !== null) values[key] = value;
  }
  return values;
}

function rejectUnknownEliotrMetadata(headers: Headers): void {
  const allowed = new Set(["format", "record", "content-digest", "size-bytes", "ciphertext-bytes", "ciphertext-sha256", "key-generation", "epoch-id", "expires-at", "reason-sha256"]);
  for (const name of headers.keys()) {
    if (name.startsWith(META_PREFIX) && !allowed.has(name.slice(META_PREFIX.length))) fail("BACKUP_OBJECT_UNREADABLE", "offsite object has unknown adapter metadata");
  }
}

function requiredMetadata(metadata: Record<string, string>, key: string): string {
  const value = metadata[key];
  if (value === undefined) fail("BACKUP_OBJECT_UNREADABLE", "offsite object metadata is incomplete");
  return value;
}

function validEtag(headers: Headers): string {
  const etag = headers.get("etag");
  if (etag === null || etag.length > 256 || /[\r\n\u0000]/.test(etag)) fail("BACKUP_OBJECT_UNREADABLE", "offsite response omitted a valid ETag");
  return etag;
}

function rejectVersionedOrRetainedObject(headers: Headers): void {
  if (headers.has("x-amz-version-id") || headers.has("x-amz-object-lock-mode")
    || headers.has("x-amz-object-lock-retain-until-date") || headers.has("x-amz-object-lock-legal-hold")) {
    fail("BACKUP_OFFSITE_INADMISSIBLE", "offsite bucket reports versioning or object retention; expiry cannot prove ciphertext removal");
  }
}

function stableReceipt(prefix: string, identity: string): Promise<string> {
  return sha256Text(identity).then((digest) => `${prefix}:${digest}`);
}

function ensureNoRedirect(response: Response): void {
  if (response.status >= 300 && response.status < 400) {
    void response.body?.cancel().catch(() => undefined);
    fail("BACKUP_OBJECT_UNREADABLE", "offsite endpoint returned a redirect");
  }
}

export function createS3OffsiteCopyAdapter(config: S3OffsiteCopyAdapterConfig): OffsiteCopyAdapter {
  const descriptor = config.descriptor;
  if (config.provider_kind !== "cloudflare-r2" || config.bucket_versioning !== "disabled") {
    fail("BACKUP_OFFSITE_INADMISSIBLE", "offsite expiry requires an operator-verified nonversioned Cloudflare R2 bucket");
  }
  if (descriptor === null || typeof descriptor !== "object"
    || typeof descriptor.destination_id !== "string" || descriptor.destination_id.length === 0
    || typeof descriptor.failure_domain !== "string" || descriptor.failure_domain.length === 0
    || descriptor.supports_deletion_journal !== true || descriptor.supports_expiry !== true
    || descriptor.retention_locked !== false || descriptor.legal_hold_ref !== undefined) {
    fail("BACKUP_DESTINATION_POLICY_MISMATCH", "approved offsite descriptor does not permit this adapter's expiry protocol");
  }
  validIdentifier(config.endpoint_identity, "offsite endpoint identity");
  if (config.region !== "auto") fail("BACKUP_INPUT_INVALID", "R2 S3 region must be auto");
  validIdentifier(config.bucket, "offsite bucket", 63);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) || config.bucket.includes("..")) fail("BACKUP_INPUT_INVALID", "offsite bucket name is malformed");
  if (typeof config.access_key_id !== "string" || !/^[A-Za-z0-9]{8,128}$/.test(config.access_key_id)
    || typeof config.secret_access_key !== "string" || config.secret_access_key.length < 16 || config.secret_access_key.length > 256 || /[\r\n]/.test(config.secret_access_key)) {
    fail("BACKUP_INPUT_INVALID", "offsite credentials are malformed");
  }
  let endpoint: URL;
  try { endpoint = new URL(config.endpoint); }
  catch { return fail("BACKUP_INPUT_INVALID", "offsite endpoint is malformed"); }
  if (endpoint.protocol !== "https:" || endpoint.port !== "" || endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "" || !["", "/"].includes(endpoint.pathname)
    || !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/i.test(endpoint.hostname)) {
    fail("BACKUP_INPUT_INVALID", "offsite endpoint must be a canonical Cloudflare R2 S3 endpoint");
  }
  const timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const maxPartBytes = config.max_part_bytes ?? DEFAULT_MAX_PART_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS) fail("BACKUP_INPUT_INVALID", "offsite request timeout is outside the allowed range");
  if (!Number.isSafeInteger(maxPartBytes) || maxPartBytes < 1 || maxPartBytes > HARD_MAX_PART_BYTES) fail("BACKUP_INPUT_INVALID", "offsite part bound is outside the allowed range");
  const fetchImpl = config.fetch_impl ?? fetch;
  const now = config.now ?? (() => new Date());
  const frozenDescriptor = Object.freeze({ ...descriptor });

  function objectUrl(partRef: string): { readonly url: URL; readonly canonicalKey: string } {
    const encodedRef = validatePartRef(partRef);
    const path = `/${awsUriEncode(config.bucket)}/${encodedRef}`;
    const url = new URL(`${endpoint.origin}${path}`);
    return { url, canonicalKey: encodedRef };
  }

  async function request<T>(method: string, partRef: string, body: Uint8Array, extraHeaders: Headers | undefined, consume: (response: Response) => Promise<T>): Promise<T> {
    const { url } = objectUrl(partRef);
    const headers = new Headers(extraHeaders);
    if (method === "PUT") headers.set("content-type", "application/octet-stream");
    const payloadHash = await sha256Hex(body);
    const date = now();
    headers.set("x-amz-content-sha256", payloadHash);
    headers.set("x-amz-date", dateParts(date).amzDate);
    const authorization = await signSigV4S3Request({ method, url, headers, payloadHash, accessKeyId: config.access_key_id, secretAccessKey: config.secret_access_key, region: config.region, date });
    headers.set("authorization", authorization);
    const abortController = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const promise = (async () => {
        const response = await fetchImpl(url.toString(), {
          method,
          headers,
          ...(method === "PUT" ? { body: bytesToArrayBuffer(body) } : {}),
          redirect: "manual",
          cache: "no-store",
          signal: abortController.signal,
        });
        ensureNoRedirect(response);
        try { return await consume(response); }
        catch (error) {
          await response.body?.cancel().catch(() => undefined);
          throw error;
        }
      })();
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abortController.abort();
          reject(method === "PUT"
            ? new BackupError("BACKUP_OFFSITE_UNCERTAIN", "offsite write acknowledgement is uncertain after its time bound", true, {})
            : new BackupError("BACKUP_OBJECT_UNREADABLE", "offsite request exceeded its time bound", true, {}));
        }, timeoutMs);
      });
      return await Promise.race([promise, timeout]);
    } catch (error) {
      if (error instanceof BackupError) throw error;
      if (method === "PUT") throw new BackupError("BACKUP_OFFSITE_UNCERTAIN", "offsite write acknowledgement is uncertain", true, {});
      return fail("BACKUP_OBJECT_UNREADABLE", "offsite request failed");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function readRecord(partRef: string): Promise<RemoteRecord> {
    return request("GET", partRef, new Uint8Array(), undefined, async (response) => {
      if (response.status === 404) { await response.body?.cancel().catch(() => undefined); return { kind: "missing" }; }
      if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); fail("BACKUP_OBJECT_UNREADABLE", "offsite readback returned an unexpected status"); }
      const metadata = responseMetadata(response.headers);
      rejectUnknownEliotrMetadata(response.headers);
      rejectVersionedOrRetainedObject(response.headers);
      const etag = validEtag(response.headers);
      if (metadata.format !== "1") { await response.body?.cancel().catch(() => undefined); fail("BACKUP_OBJECT_UNREADABLE", "offsite object has unknown metadata format"); }
      if (metadata.record === "tombstone") {
        const body = await readBoundedBody(response, MAX_TOMBSTONE_BYTES);
        if (bytesToHex(body) !== bytesToHex(TOMBSTONE_BODY) || !/^[a-f0-9]{64}$/.test(metadata["reason-sha256"] ?? "")) fail("BACKUP_OBJECT_UNREADABLE", "offsite deletion journal is malformed");
        return { kind: "tombstone", reason_sha256: requiredMetadata(metadata, "reason-sha256"), etag };
      }
      if (metadata.record !== "part" || !/^[a-f0-9]{64}$/.test(metadata["content-digest"] ?? "")
        || !/^[a-f0-9]{64}$/.test(metadata["ciphertext-sha256"] ?? "")
        || !/^[0-9]+$/.test(metadata["size-bytes"] ?? "")
        || !/^[0-9]+$/.test(metadata["ciphertext-bytes"] ?? "")) {
        await response.body?.cancel().catch(() => undefined);
        fail("BACKUP_OBJECT_UNREADABLE", "offsite part metadata is malformed");
      }
      const ciphertextLength = Number(metadata["ciphertext-bytes"]);
      if (!Number.isSafeInteger(ciphertextLength) || ciphertextLength > maxPartBytes) { await response.body?.cancel().catch(() => undefined); fail("BACKUP_OBJECT_UNREADABLE", "offsite part exceeds the configured bound"); }
      const ciphertext = await readBoundedBody(response, maxPartBytes);
      const ciphertextDigest = requiredMetadata(metadata, "ciphertext-sha256");
      if (ciphertext.byteLength !== ciphertextLength || await sha256Hex(ciphertext) !== ciphertextDigest) fail("BACKUP_OBJECT_UNREADABLE", "offsite ciphertext readback digest failed");
      const stored: PartMetadata = {
        content_digest: requiredMetadata(metadata, "content-digest"),
        size_bytes: Number(requiredMetadata(metadata, "size-bytes")),
        key_generation: metadata["key-generation"] ?? "",
        epoch_id: metadata["epoch-id"] ?? "",
        expires_at: metadata["expires-at"] ?? "",
      };
      validateMetadata(stored);
      return { kind: "part", ciphertext, stored, ciphertext_sha256: ciphertextDigest, etag };
    });
  }

  async function headRecord(partRef: string): Promise<{ readonly kind: "missing" } | { readonly kind: "part" | "tombstone"; readonly metadata: Record<string, string>; readonly etag: string }> {
    return request("HEAD", partRef, new Uint8Array(), undefined, async (response) => {
      if (response.status === 404) return { kind: "missing" };
      if (response.status !== 200) fail("BACKUP_OBJECT_UNREADABLE", "offsite metadata read returned an unexpected status");
      const metadata = responseMetadata(response.headers);
      rejectUnknownEliotrMetadata(response.headers);
      rejectVersionedOrRetainedObject(response.headers);
      const etag = validEtag(response.headers);
      if (metadata.format !== "1") fail("BACKUP_OBJECT_UNREADABLE", "offsite object has unknown metadata format");
      if (metadata.record === "tombstone" && /^[a-f0-9]{64}$/.test(metadata["reason-sha256"] ?? "")) return { kind: "tombstone", metadata, etag };
      if (metadata.record === "part" && /^[a-f0-9]{64}$/.test(metadata["content-digest"] ?? "")
        && /^[a-f0-9]{64}$/.test(metadata["ciphertext-sha256"] ?? "")
        && /^[0-9]+$/.test(metadata["size-bytes"] ?? "")
        && /^[0-9]+$/.test(metadata["ciphertext-bytes"] ?? "")) {
        const sizeBytes = Number(metadata["size-bytes"]);
        const ciphertextBytes = Number(metadata["ciphertext-bytes"]);
        if (!Number.isSafeInteger(sizeBytes) || !Number.isSafeInteger(ciphertextBytes) || ciphertextBytes > maxPartBytes) fail("BACKUP_OBJECT_UNREADABLE", "offsite part metadata exceeds its configured bound");
        validateMetadata({
          content_digest: requiredMetadata(metadata, "content-digest"),
          size_bytes: sizeBytes,
          key_generation: requiredMetadata(metadata, "key-generation"),
          epoch_id: requiredMetadata(metadata, "epoch-id"),
          expires_at: requiredMetadata(metadata, "expires-at"),
        });
        const contentLength = response.headers.get("content-length");
        if (contentLength !== null && Number(contentLength) !== ciphertextBytes) fail("BACKUP_OBJECT_UNREADABLE", "offsite part size metadata disagrees with its object length");
        return { kind: "part", metadata, etag };
      }
      fail("BACKUP_OBJECT_UNREADABLE", "offsite object metadata is malformed");
    });
  }

  function partHeaders(ciphertextSha256: string, ciphertextBytes: number, stored: PartMetadata): Headers {
    return metadataHeaders({
      format: "1", record: "part", "content-digest": stored.content_digest,
      "size-bytes": String(stored.size_bytes), "ciphertext-bytes": String(ciphertextBytes),
      "ciphertext-sha256": ciphertextSha256, "key-generation": stored.key_generation,
      "epoch-id": stored.epoch_id, "expires-at": stored.expires_at,
    });
  }

  return {
    describe() { return frozenDescriptor; },

    async put(partRef, ciphertext, stored) {
      validatePartRef(partRef);
      validateMetadata(stored);
      if (!(ciphertext instanceof Uint8Array) || ciphertext.byteLength > maxPartBytes) fail("BACKUP_INPUT_INVALID", "offsite ciphertext exceeds the configured bound");
      const ciphertextSha256 = await sha256Hex(ciphertext);
      const headers = partHeaders(ciphertextSha256, ciphertext.byteLength, stored);
      headers.set("if-none-match", "*");
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const outcome = await request("PUT", partRef, ciphertext, headers, async (response) => {
          rejectVersionedOrRetainedObject(response.headers);
          if (response.status === 200) {
            const etag = validEtag(response.headers);
            await response.body?.cancel().catch(() => undefined);
            return { status: 200, etag };
          }
          await response.body?.cancel().catch(() => undefined);
          return { status: response.status };
        });
        if (outcome.status === 200) {
          if (outcome.etag === undefined) fail("BACKUP_OBJECT_UNREADABLE", "offsite write omitted its ETag");
          // ETag is only an opaque operation receipt; copyOffsiteExport performs the independent GET/decrypt/digest readback.
          return { ack_ref: await stableReceipt("r2-etag", outcome.etag) };
        }
        if (outcome.status >= 500) throw new BackupError("BACKUP_OFFSITE_UNCERTAIN", "offsite write acknowledgement is uncertain after a server error", true, {});
        if (outcome.status !== 409 && outcome.status !== 412) fail("BACKUP_OBJECT_UNREADABLE", "offsite conditional write returned an unexpected status");
        const existing = await readRecord(partRef);
        if (existing.kind === "tombstone") fail("BACKUP_RESURRECTION_REFUSED", "offsite part has a deletion tombstone; resurrection refused");
        if (existing.kind === "part") {
          const same = existing.ciphertext_sha256 === ciphertextSha256
            && existing.ciphertext.byteLength === ciphertext.byteLength
            && existing.stored.content_digest === stored.content_digest
            && existing.stored.size_bytes === stored.size_bytes
            && existing.stored.key_generation === stored.key_generation
            && existing.stored.epoch_id === stored.epoch_id
            && existing.stored.expires_at === stored.expires_at;
          if (same) return { ack_ref: await stableReceipt("r2-etag", existing.etag) };
          fail("BACKUP_INTENT_CONFLICT", "offsite part reference already contains divergent immutable bytes");
        }
      }
      fail("BACKUP_OBJECT_UNREADABLE", "offsite conditional write could not be reconciled within its retry bound");
    },

    async get(partRef) {
      const record = await readRecord(partRef);
      if (record.kind !== "part") return null;
      return { ciphertext: record.ciphertext, stored: record.stored };
    },

    async delete(partRef, reason) {
      validatePartRef(partRef);
      validateReason(reason);
      const reasonSha256 = await sha256Text(reason);
      const journalRef = await stableReceipt("r2-tombstone", `${partRef}\n${reasonSha256}`);
      const tombstoneHeaders = metadataHeaders({ format: "1", record: "tombstone", "reason-sha256": reasonSha256 });
      // Replace the current part at its own key using ETag CAS. The durable
      // tombstone is the journal and remains as the If-None-Match fence that
      // blocks future writes; GET deliberately treats it as logical absence.
      // The provider/versioning gate above is essential: a versioned bucket
      // could retain the old ciphertext as a noncurrent version.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const current = await headRecord(partRef);
        if (current.kind === "tombstone") {
          if (current.metadata["reason-sha256"] !== reasonSha256) fail("BACKUP_INTENT_CONFLICT", "offsite deletion journal already binds this reference to another expiry reason");
          const readback = await readRecord(partRef);
          if (readback.kind !== "tombstone" || readback.reason_sha256 !== reasonSha256) fail("BACKUP_EXPIRY_ABSENCE_UNPROVEN", "offsite deletion journal readback was not verified");
          return { journal_ref: journalRef };
        }
        const headers = new Headers(tombstoneHeaders);
        if (current.kind === "missing") headers.set("if-none-match", "*");
        else headers.set("if-match", current.etag);
        const outcome = await request("PUT", partRef, TOMBSTONE_BODY, headers, async (response) => {
          rejectVersionedOrRetainedObject(response.headers);
          await response.body?.cancel().catch(() => undefined);
          return response.status;
        });
        if (outcome === 200) {
          const readback = await readRecord(partRef);
          if (readback.kind !== "tombstone" || readback.reason_sha256 !== reasonSha256) fail("BACKUP_EXPIRY_ABSENCE_UNPROVEN", "offsite deletion journal readback was not verified");
          return { journal_ref: journalRef };
        }
        if (outcome >= 500) throw new BackupError("BACKUP_OFFSITE_UNCERTAIN", "offsite deletion journal acknowledgement is uncertain after a server error", true, {});
        if (outcome !== 409 && outcome !== 412) fail("BACKUP_OBJECT_UNREADABLE", "offsite deletion journal write returned an unexpected status");
      }
      fail("BACKUP_OBJECT_UNREADABLE", "offsite deletion journal could not be reconciled within its retry bound");
    },
  };
}
