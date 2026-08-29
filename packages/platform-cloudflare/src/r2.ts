import type { ObjectResidencyKey } from "@eliotr/contracts";
import { ObjectResidencyKeySchema } from "@eliotr/contracts";
import { serializeObjectResidencyKey } from "@eliotr/domain";
import { RUNTIME_LIMITS, assertWithinBytes } from "./runtime-limits.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_R2_KEY_BYTES = 1024;
const MAX_CONTENT_TYPE_BYTES = 256;
const MAX_METADATA_ENTRIES = 16;
const MAX_METADATA_KEY_BYTES = 128;
const MAX_METADATA_VALUE_BYTES = 1024;
const MAX_STREAM_CHUNKS = 262_144;
const RESERVED_METADATA_PREFIX = "eliotr_";

export type R2IntegrityErrorCode =
  | "R2_KEY_INVALID"
  | "R2_SHA256_INVALID"
  | "R2_EXPECTED_SIZE_INVALID"
  | "R2_CONTENT_TYPE_INVALID"
  | "R2_METADATA_INVALID"
  | "R2_DIGEST_STREAM_UNAVAILABLE"
  | "R2_STREAM_INVALID"
  | "R2_STREAM_LIMIT_EXCEEDED"
  | "R2_WRITE_REJECTED"
  | "R2_CONDITIONAL_WRITE_INCONSISTENT"
  | "R2_IMMUTABLE_KEY_CONFLICT"
  | "R2_READBACK_MISSING"
  | "R2_READBACK_SIZE_MISMATCH"
  | "R2_READBACK_DIGEST_MISMATCH"
  | "R2_READBACK_METADATA_MISMATCH"
  | "R2_ETAG_INVALID"
  | "R2_DELETE_AUTHORIZATION_INVALID";

export class R2IntegrityError extends Error {
  public readonly code: R2IntegrityErrorCode;
  public readonly retryable: boolean;

  public constructor(
    code: R2IntegrityErrorCode,
    message: string,
    retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "R2IntegrityError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface ImmutableObjectWrite {
  readonly key: string;
  readonly body: ReadableStream<Uint8Array>;
  readonly expected_sha256: string;
  readonly expected_size_bytes: number;
  readonly content_type: string;
  readonly custom_metadata: Readonly<Record<string, string>>;
}

export interface ImmutableObjectReceipt {
  readonly key: string;
  readonly expected_sha256: string;
  readonly readback_sha256: string;
  readonly size_bytes: number;
  readonly etag: string;
  readonly existed_identically: boolean;
}

export interface ResidencyObjectWrite extends Omit<ImmutableObjectWrite, "key"> {
  readonly residency_key: ObjectResidencyKey;
  readonly prefix: string;
}

export interface EvidenceObjectStore {
  putImmutable(write: ImmutableObjectWrite): Promise<ImmutableObjectReceipt>;
  putResidencyObject(write: ResidencyObjectWrite): Promise<ImmutableObjectReceipt>;
  open(key: string, range?: { readonly offset: number; readonly length: number }): Promise<R2ObjectBody | null>;
  deleteForErasure(key: string, erasureAuthorizationRef: string): Promise<void>;
}

export interface StreamHashReceipt {
  readonly sha256: string;
  readonly size_bytes: number;
  readonly chunks: number;
}

export interface Sha256DigestSink {
  readonly writable: WritableStream<Uint8Array>;
  readonly digest: Promise<ArrayBuffer>;
}

export type Sha256DigestSinkFactory = () => Sha256DigestSink;

export interface R2ObjectStoreDependencies {
  readonly createSha256Sink?: Sha256DigestSinkFactory;
  readonly authorizeErasure?: (key: string, authorizationRef: string) => Promise<boolean>;
}

interface DigestStreamConstructor {
  new (algorithm: "SHA-256"): WritableStream<Uint8Array> & { readonly digest: Promise<ArrayBuffer> };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function fail(code: R2IntegrityErrorCode, message: string, retryable = false, cause?: unknown): never {
  throw new R2IntegrityError(code, message, retryable, cause);
}

function assertSha256(value: string, label: string): void {
  if (!SHA256.test(value)) fail("R2_SHA256_INVALID", `${label} must be a lowercase SHA-256 digest`);
}

function assertSafeInteger(value: number, label: string, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    fail("R2_EXPECTED_SIZE_INVALID", `${label} must be a ${allowZero ? "non-negative" : "positive"} safe integer`);
  }
}

function assertCanonicalPath(path: string, label: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("//") ||
    utf8Bytes(path) > MAX_R2_KEY_BYTES
  ) {
    fail("R2_KEY_INVALID", `${label} is not a bounded relative R2 key`);
  }
  for (const segment of path.split("/")) {
    if (segment === "." || segment === ".." || !SAFE_PATH_SEGMENT.test(segment)) {
      fail("R2_KEY_INVALID", `${label} contains an unsafe path segment`);
    }
  }
}

function assertIdentifierForKey(value: string, label: string): void {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    utf8Bytes(value) > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("R2_KEY_INVALID", `${label} is invalid`);
  }
}

function assertContentType(value: string): void {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    utf8Bytes(value) > MAX_CONTENT_TYPE_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("R2_CONTENT_TYPE_INVALID", "content_type is invalid");
  }
}

function assertEtag(value: string, label: string): void {
  if (
    value.length === 0
    || value !== value.trim()
    || utf8Bytes(value) > 512
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("R2_ETAG_INVALID", `${label} is invalid`);
  }
}

function validatedMetadata(input: Readonly<Record<string, string>>): Record<string, string> {
  const entries = Object.entries(input);
  if (entries.length > MAX_METADATA_ENTRIES) {
    fail("R2_METADATA_INVALID", "custom metadata exceeds its entry limit");
  }
  const output: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (
      key.length === 0 ||
      key !== key.trim() ||
      key.toLowerCase().startsWith(RESERVED_METADATA_PREFIX) ||
      utf8Bytes(key) > MAX_METADATA_KEY_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(key)
    ) {
      fail("R2_METADATA_INVALID", "custom metadata contains an invalid or reserved key");
    }
    if (
      typeof value !== "string" ||
      value !== value.trim() ||
      utf8Bytes(value) > MAX_METADATA_VALUE_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      fail("R2_METADATA_INVALID", `custom metadata value for ${key} is invalid`);
    }
    output[key] = value;
  }
  return output;
}

function objectMetadataMatches(
  object: Pick<R2Object, "customMetadata" | "httpMetadata">,
  expectedMetadata: Readonly<Record<string, string>>,
  expectedContentType: string,
): boolean {
  const actual = Object.entries(object.customMetadata ?? {})
    .sort(([left], [right]) => left.localeCompare(right));
  const expected = Object.entries(expectedMetadata)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(actual) === JSON.stringify(expected)
    && object.httpMetadata?.contentType === expectedContentType;
}

function defaultSha256Sink(): Sha256DigestSink {
  const DigestStream = (crypto as unknown as { readonly DigestStream?: DigestStreamConstructor }).DigestStream;
  if (DigestStream === undefined) {
    fail(
      "R2_DIGEST_STREAM_UNAVAILABLE",
      "Cloudflare crypto.DigestStream is unavailable; refusing buffered integrity fallback",
      true,
    );
  }
  const stream = new DigestStream("SHA-256");
  return { writable: stream, digest: stream.digest };
}

function bytesToHex(input: ArrayBuffer): string {
  return [...new Uint8Array(input)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function sha256Utf8(value: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function hashReadableStream(
  body: ReadableStream<Uint8Array>,
  maximumBytes: number,
  createSink: Sha256DigestSinkFactory = defaultSha256Sink,
): Promise<StreamHashReceipt> {
  assertSafeInteger(maximumBytes, "maximumBytes", true);
  const sink = createSink();
  const reader = body.getReader();
  const writer = sink.writable.getWriter();
  let size = 0;
  let chunks = 0;
  let closed = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        fail("R2_STREAM_INVALID", "R2 body yielded a non-byte stream chunk");
      }
      chunks += 1;
      if (chunks > MAX_STREAM_CHUNKS) {
        fail("R2_STREAM_LIMIT_EXCEEDED", "R2 body exceeds the stream chunk-count limit");
      }
      size += result.value.byteLength;
      if (!Number.isSafeInteger(size) || size > maximumBytes) {
        fail("R2_STREAM_LIMIT_EXCEEDED", "R2 body exceeds the expected byte envelope");
      }
      await writer.write(result.value);
    }
    await writer.close();
    closed = true;
    return { sha256: bytesToHex(await sink.digest), size_bytes: size, chunks };
  } finally {
    if (!closed) {
      try { await reader.cancel(); } catch { /* preserve the original integrity failure */ }
      try { await writer.abort(); } catch { /* preserve the original integrity failure */ }
    }
    reader.releaseLock();
    writer.releaseLock();
  }
}

export async function objectResidencyKeyDigest(residency: ObjectResidencyKey): Promise<string> {
  const parsed = ObjectResidencyKeySchema.parse(residency);
  return sha256Utf8(serializeObjectResidencyKey(parsed));
}

export function canonicalEvidenceObjectKeyFromDigest(
  residencyKeyDigest: string,
  prefix: string,
  contentDigest: string,
): string {
  assertSha256(residencyKeyDigest, "residencyKeyDigest");
  assertSha256(contentDigest, "contentDigest");
  assertCanonicalPath(prefix, "prefix");
  const key = `objects/${residencyKeyDigest}/${prefix}/${contentDigest}`;
  assertCanonicalPath(key, "canonical evidence object key");
  return key;
}

export async function canonicalEvidenceObjectKey(
  residency: ObjectResidencyKey,
  prefix: string,
  contentDigest: string,
): Promise<string> {
  return canonicalEvidenceObjectKeyFromDigest(await objectResidencyKeyDigest(residency), prefix, contentDigest);
}

export interface NormalizedBundleObjectIdentity {
  readonly owner_system_id: string;
  readonly source_namespace_id: string;
  readonly source_owner_generation: string;
  readonly source_logical_id: string;
  readonly source_revision_ref: string;
}

export async function canonicalNormalizedBundleKey(
  residencyKeyDigest: string,
  identity: NormalizedBundleObjectIdentity,
  logicalPath: string,
): Promise<string> {
  assertSha256(residencyKeyDigest, "residencyKeyDigest");
  for (const [label, value] of Object.entries(identity)) {
    assertIdentifierForKey(value, label);
  }
  assertCanonicalPath(logicalPath, "logicalPath");
  const sourceToken = await sha256Utf8(JSON.stringify([
    "eliotr.normalized-source.v1",
    identity.owner_system_id,
    identity.source_namespace_id,
    identity.source_owner_generation,
    identity.source_logical_id,
  ]));
  const revisionToken = await sha256Utf8(JSON.stringify([
    "eliotr.normalized-revision.v1",
    identity.owner_system_id,
    identity.source_namespace_id,
    identity.source_owner_generation,
    identity.source_revision_ref,
  ]));
  const key = `normalized/${residencyKeyDigest}/${sourceToken}/${revisionToken}/${logicalPath}`;
  assertCanonicalPath(key, "canonical normalized bundle key");
  return key;
}

async function verifiedReadback(
  bucket: R2Bucket,
  key: string,
  expectedSha256: string,
  expectedSize: number,
  expectedMetadata: Readonly<Record<string, string>>,
  expectedContentType: string,
  createSink: Sha256DigestSinkFactory,
): Promise<{ readonly object: R2ObjectBody; readonly hash: StreamHashReceipt }> {
  const object = await bucket.get(key);
  if (object === null) fail("R2_READBACK_MISSING", `R2 object ${key} is absent after immutable write`, true);
  assertEtag(object.etag, `R2 object ${key} ETag`);
  if (object.size !== expectedSize) {
    fail("R2_READBACK_SIZE_MISMATCH", `R2 object ${key} size does not match the admitted size`);
  }
  if (!objectMetadataMatches(object, expectedMetadata, expectedContentType)) {
    fail("R2_READBACK_METADATA_MISMATCH", `R2 object ${key} immutable metadata or media type is inconsistent`);
  }
  const hash = await hashReadableStream(object.body, expectedSize, createSink);
  if (hash.size_bytes !== expectedSize) {
    fail("R2_READBACK_SIZE_MISMATCH", `R2 object ${key} streamed size does not match the admitted size`);
  }
  if (hash.sha256 !== expectedSha256) {
    fail("R2_READBACK_DIGEST_MISMATCH", `R2 object ${key} digest does not match the admitted digest`);
  }
  return { object, hash };
}

function immutableConflict(key: string, cause: unknown): never {
  throw new R2IntegrityError(
    "R2_IMMUTABLE_KEY_CONFLICT",
    `immutable key ${key} already contains incompatible bytes or metadata`,
    false,
    cause,
  );
}

async function reconcileConditionalWrite(
  bucket: R2Bucket,
  key: string,
  expectedSha256: string,
  expectedSize: number,
  expectedMetadata: Readonly<Record<string, string>>,
  expectedContentType: string,
  createSink: Sha256DigestSinkFactory,
  writeError?: unknown,
): Promise<{ readonly object: R2ObjectBody; readonly hash: StreamHashReceipt }> {
  try {
    return await verifiedReadback(
      bucket,
      key,
      expectedSha256,
      expectedSize,
      expectedMetadata,
      expectedContentType,
      createSink,
    );
  } catch (readbackError) {
    if (readbackError instanceof R2IntegrityError && readbackError.code !== "R2_READBACK_MISSING") {
      immutableConflict(key, readbackError);
    }
    if (writeError !== undefined) {
      throw new R2IntegrityError(
        "R2_WRITE_REJECTED",
        `R2 write for ${key} failed and exact readback could not prove success`,
        true,
        { write_error: writeError, readback_error: readbackError },
      );
    }
    throw new R2IntegrityError(
      "R2_CONDITIONAL_WRITE_INCONSISTENT",
      `conditional write for ${key} did not create an object and no exact winner is readable`,
      true,
      readbackError,
    );
  }
}

export function createR2EvidenceObjectStore(
  bucket: R2Bucket,
  dependencies: R2ObjectStoreDependencies = {},
): EvidenceObjectStore {
  const createSink = dependencies.createSha256Sink ?? defaultSha256Sink;

  async function putImmutable(write: ImmutableObjectWrite): Promise<ImmutableObjectReceipt> {
    assertCanonicalPath(write.key, "immutable object key");
    assertSha256(write.expected_sha256, "expected_sha256");
    assertSafeInteger(write.expected_size_bytes, "expected_size_bytes", true);
    assertContentType(write.content_type);
    const metadata = validatedMetadata(write.custom_metadata);
    const authoritativeMetadata = {
      ...metadata,
      eliotr_sha256: write.expected_sha256,
      eliotr_size_bytes: String(write.expected_size_bytes),
      eliotr_immutable: "true",
    };

    let created: R2Object | null | undefined;
    let writeError: unknown;
    try {
      created = await bucket.put(write.key, write.body, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: write.expected_sha256,
        httpMetadata: { contentType: write.content_type },
        customMetadata: authoritativeMetadata,
      });
    } catch (error) {
      writeError = error;
    }

    if (created === null || writeError !== undefined) {
      const existing = await reconcileConditionalWrite(
        bucket,
        write.key,
        write.expected_sha256,
        write.expected_size_bytes,
        authoritativeMetadata,
        write.content_type,
        createSink,
        writeError,
      );
      return {
        key: write.key,
        expected_sha256: write.expected_sha256,
        readback_sha256: existing.hash.sha256,
        size_bytes: existing.hash.size_bytes,
        etag: existing.object.etag,
        existed_identically: true,
      };
    }

    if (created === undefined) {
      fail("R2_WRITE_REJECTED", `R2 write for ${write.key} returned no disposition`, true);
    }
    assertEtag(created.etag, `R2 write ${write.key} ETag`);
    const readback = await verifiedReadback(
      bucket,
      write.key,
      write.expected_sha256,
      write.expected_size_bytes,
      authoritativeMetadata,
      write.content_type,
      createSink,
    );
    return {
      key: write.key,
      expected_sha256: write.expected_sha256,
      readback_sha256: readback.hash.sha256,
      size_bytes: readback.hash.size_bytes,
      etag: readback.object.etag,
      existed_identically: false,
    };
  }

  return {
    putImmutable,
    async putResidencyObject(write: ResidencyObjectWrite): Promise<ImmutableObjectReceipt> {
      const residency = ObjectResidencyKeySchema.parse(write.residency_key);
      if (residency.content_digest.digest !== write.expected_sha256) {
        fail("R2_SHA256_INVALID", "residency content digest must equal the immutable object digest");
      }
      const key = await canonicalEvidenceObjectKey(residency, write.prefix, write.expected_sha256);
      return putImmutable({
        key,
        body: write.body,
        expected_sha256: write.expected_sha256,
        expected_size_bytes: write.expected_size_bytes,
        content_type: write.content_type,
        custom_metadata: write.custom_metadata,
      });
    },
    open(key, range) {
      assertCanonicalPath(key, "open key");
      if (range === undefined) return bucket.get(key);
      assertSafeInteger(range.offset, "range.offset", true);
      assertSafeInteger(range.length, "range.length", false);
      return bucket.get(key, { range: { offset: range.offset, length: range.length } });
    },
    async deleteForErasure(key, erasureAuthorizationRef): Promise<void> {
      assertCanonicalPath(key, "erasure key");
      if (
        erasureAuthorizationRef.length === 0 ||
        erasureAuthorizationRef !== erasureAuthorizationRef.trim() ||
        utf8Bytes(erasureAuthorizationRef) > 256 ||
        /[\u0000-\u001f\u007f]/u.test(erasureAuthorizationRef)
      ) {
        fail("R2_DELETE_AUTHORIZATION_INVALID", "erasure authorization reference is invalid");
      }
      if (dependencies.authorizeErasure === undefined
        || !await dependencies.authorizeErasure(key, erasureAuthorizationRef)) {
        fail(
          "R2_DELETE_AUTHORIZATION_INVALID",
          "R2 deletion requires a verified erasure authorization",
        );
      }
      await bucket.delete(key);
      if (await bucket.head(key) !== null) {
        fail("R2_READBACK_MISSING", `R2 object ${key} remains after authorized erasure`, true);
      }
    },
  };
}

export async function bufferBounded(
  body: ReadableStream<Uint8Array>,
  limit = RUNTIME_LIMITS.buffered_r2_bytes,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        completed = true;
        break;
      }
      if (!(next.value instanceof Uint8Array)) fail("R2_STREAM_INVALID", "R2 body yielded a non-byte chunk");
      total += next.value.byteLength;
      assertWithinBytes("buffered R2 object", total, limit);
      parts.push(next.value.slice());
    }
  } finally {
    if (!completed) {
      try { await reader.cancel(); } catch { /* preserve the original bounded-read failure */ }
    }
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}
