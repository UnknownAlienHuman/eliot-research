import { ObjectResidencyKeySchema } from "@eliotr/contracts";
import {
  canonicalEvidenceObjectKey,
  objectResidencyKeyDigest,
  sha256Utf8,
  type ImmutableObjectReceipt,
  R2IntegrityError,
} from "@eliotr/platform-cloudflare";
import { canonicalJson, exactSizeStream, IngestStorageError } from "@eliotr/platform-cloudflare";
import {
  RAW_CAPTURED_STATE,
  RAW_CAPTURE_INTENT_STATE,
  RAW_CAPTURE_PROTOCOL,
  RawCaptureError,
  type RawCaptureErrorCode,
  type RawCaptureDependencies,
  type RawCaptureInput,
  type RawCaptureLookup,
  type RawCapturePort,
  type RawCaptureReceipt,
  type RawCaptureResult,
} from "./raw-ingest-types.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SIZE_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_CONTENT_TYPE_BYTES = 256;
const MAX_FILE_NAME_BYTES = 512;
const MAX_RECEIPT_BYTES = 64 * 1024;

interface RawCaptureRow {
  readonly capture_id: unknown;
  readonly principal_ref: unknown;
  readonly owner_system_id: unknown;
  readonly source_namespace_id: unknown;
  readonly source_revision_ref: unknown;
  readonly source_logical_id: unknown;
  readonly source_owner_generation: unknown;
  readonly idempotency_key: unknown;
  readonly original_file_name: unknown;
  readonly request_digest: unknown;
  readonly residency_key_json: unknown;
  readonly residency_key_digest: unknown;
  readonly content_sha256: unknown;
  readonly size_bytes: unknown;
  readonly content_type: unknown;
  readonly state: unknown;
  readonly object_key: unknown;
  readonly receipt_json: unknown;
  readonly receipt_sha256: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly expires_at: unknown;
}

const SELECT = "SELECT capture_id,principal_ref,owner_system_id,source_namespace_id,source_revision_ref," +
  "source_logical_id,source_owner_generation,idempotency_key,original_file_name,request_digest,residency_key_json," +
  "residency_key_digest,content_sha256,size_bytes,content_type,state,object_key,receipt_json," +
  "receipt_sha256,created_at,updated_at,expires_at FROM raw_file_capture ";

function fail(code: RawCaptureErrorCode, message: string, retryable = false, cause?: unknown): never {
  throw new RawCaptureError(code, message, retryable, cause);
}

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail("RAW_CAPTURE_INPUT_INVALID", `${label} is invalid`);
}

function digest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) fail("RAW_CAPTURE_INPUT_INVALID", `${label} is invalid`);
}

function size(value: unknown, label: string, maximum: number): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail("RAW_CAPTURE_INPUT_INVALID", `${label} is outside the bounded raw-file envelope`);
  }
}

function contentType(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
      new TextEncoder().encode(value).byteLength > MAX_CONTENT_TYPE_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("RAW_CAPTURE_INPUT_INVALID", "content_type is invalid");
  }
}

function originalFileName(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
      new TextEncoder().encode(value).byteLength > MAX_FILE_NAME_BYTES ||
      /[\u0000-\u001f\u007f/\\]/u.test(value) || value === "." || value === "..") {
    fail("RAW_CAPTURE_INPUT_INVALID", "original_file_name is invalid");
  }
}

function timestamp(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 0) fail("RAW_CAPTURE_INPUT_INVALID", `${label} is invalid`);
  const result = new Date(value).toISOString();
  return result;
}

function persistedExpiry(row: RawCaptureRow, currentMs: number): void {
  if (typeof row.expires_at !== "string") fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "raw capture intent expiry is malformed", true);
  const expiresMs = Date.parse(row.expires_at);
  if (!Number.isSafeInteger(expiresMs) || expiresMs <= currentMs) {
    fail("RAW_CAPTURE_STATE_CONFLICT", "raw capture intent has expired");
  }
}

function authorityFields(input: RawCaptureInput): Record<string, unknown> {
  return {
    principal_ref: input.principal_ref,
    owner_system_id: input.owner_system_id,
    source_namespace_id: input.source_namespace_id,
    source_revision_ref: input.source_revision_ref,
    source_logical_id: input.source_logical_id,
    source_owner_generation: input.source_owner_generation,
    idempotency_key: input.idempotency_key,
    original_file_name: input.original_file_name,
    residency_key: input.residency_key,
    content_sha256: input.content_sha256,
    size_bytes: input.size_bytes,
    content_type: input.content_type,
  };
}

async function inputIdentity(input: RawCaptureInput): Promise<{ readonly captureId: string; readonly requestDigest: string; readonly residencyDigest: string; readonly objectKey: string }> {
  const identityJson = canonicalJson(authorityFields(input));
  const [requestDigest, residencyDigest] = await Promise.all([
    sha256Utf8(identityJson),
    objectResidencyKeyDigest(input.residency_key),
  ]);
  const captureId = `raw-capture-${(await sha256Utf8(`raw-capture\u0000${input.principal_ref}\u0000${input.idempotency_key}`)).slice(0, 48)}`;
  const sourceToken = await sha256Utf8(JSON.stringify([
    "eliotr.raw-source.v1", input.owner_system_id, input.source_namespace_id, input.source_logical_id,
  ]));
  const revisionToken = await sha256Utf8(JSON.stringify([
    "eliotr.raw-revision.v1", input.owner_system_id, input.source_namespace_id,
    input.source_owner_generation, input.source_revision_ref,
  ]));
  const objectKey = await canonicalEvidenceObjectKey(
    input.residency_key,
    `raw/${sourceToken}/${revisionToken}`,
    input.content_sha256,
  );
  return { captureId, requestDigest, residencyDigest, objectKey };
}

function validateInput(input: RawCaptureInput, maximum: number): void {
  if (input === null || typeof input !== "object" || typeof input.body?.getReader !== "function") {
    fail("RAW_CAPTURE_INPUT_INVALID", "raw capture input must contain a readable byte stream");
  }
  for (const [label, value] of Object.entries({
    principal_ref: input.principal_ref,
    owner_system_id: input.owner_system_id,
    source_namespace_id: input.source_namespace_id,
    source_revision_ref: input.source_revision_ref,
    source_logical_id: input.source_logical_id,
    source_owner_generation: input.source_owner_generation,
    idempotency_key: input.idempotency_key,
  })) identifier(value, label);
  originalFileName(input.original_file_name);
  digest(input.content_sha256, "content_sha256");
  size(input.size_bytes, "size_bytes", maximum);
  contentType(input.content_type);
  let residency: ReturnType<typeof ObjectResidencyKeySchema.parse>;
  try { residency = ObjectResidencyKeySchema.parse(input.residency_key); }
  catch (error) { fail("RAW_CAPTURE_INPUT_INVALID", "residency_key failed strict validation", false, error); }
  if (residency.content_digest.digest !== input.content_sha256) {
    fail("RAW_CAPTURE_RESIDENCY_MISMATCH", "raw content digest is not bound to the residency key");
  }
}

function sameRequest(row: RawCaptureRow, input: RawCaptureInput, requestDigest: string, residencyDigest: string): boolean {
  return row.principal_ref === input.principal_ref && row.owner_system_id === input.owner_system_id &&
    row.source_namespace_id === input.source_namespace_id && row.source_revision_ref === input.source_revision_ref &&
    row.source_logical_id === input.source_logical_id && row.source_owner_generation === input.source_owner_generation &&
    row.idempotency_key === input.idempotency_key && row.original_file_name === input.original_file_name &&
    row.request_digest === requestDigest &&
    row.residency_key_digest === residencyDigest && row.content_sha256 === input.content_sha256 &&
    row.size_bytes === input.size_bytes && row.content_type === input.content_type;
}

async function readByCaptureId(database: D1Database, captureId: string): Promise<RawCaptureRow | null> {
  try {
    return await database.prepare(`${SELECT}WHERE capture_id = ?1 LIMIT 1`).bind(captureId).first<RawCaptureRow>();
  } catch (error) {
    fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "raw capture intent readback is unavailable", true, error);
  }
}

async function readByIdempotency(database: D1Database, principalRef: string, key: string): Promise<RawCaptureRow | null> {
  try {
    return await database.prepare(`${SELECT}WHERE principal_ref = ?1 AND idempotency_key = ?2 LIMIT 1`)
      .bind(principalRef, key).first<RawCaptureRow>();
  } catch (error) {
    fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "raw capture idempotency readback is unavailable", true, error);
  }
}

function assertRequest(row: RawCaptureRow, input: RawCaptureInput, requestDigest: string, residencyDigest: string): void {
  if (!sameRequest(row, input, requestDigest, residencyDigest)) {
    fail("RAW_CAPTURE_IDEMPOTENCY_CONFLICT", "raw capture idempotency identity is bound to different input bytes or authority");
  }
  if (row.state !== RAW_CAPTURE_INTENT_STATE && row.state !== RAW_CAPTURED_STATE) {
    fail("RAW_CAPTURE_STATE_CONFLICT", "raw capture has an unknown durable state");
  }
}

function receiptFromRow(row: RawCaptureRow, input: RawCaptureInput, expectedKey: string, residencyDigest: string): RawCaptureReceipt | null {
  if (row.state !== RAW_CAPTURED_STATE) return null;
  const json = row.receipt_json;
  const receiptDigest = row.receipt_sha256;
  if (typeof json !== "string" || typeof receiptDigest !== "string" || row.object_key !== expectedKey) {
    fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "captured raw file receipt is incomplete", true);
  }
  digest(receiptDigest, "stored raw capture receipt digest");
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch (error) { fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "captured raw file receipt is not JSON", true, error); }
  if (canonicalJson(parsed) !== json) fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "captured raw file receipt is not canonical", true);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "captured raw file receipt has an invalid shape", true);
  }
  const value = parsed as Record<string, unknown>;
  const expectedKeys = ["protocol", "capture_id", "principal_ref", "owner_system_id", "source_namespace_id", "source_revision_ref", "source_logical_id", "source_owner_generation", "idempotency_key", "original_file_name", "object_key", "residency_key_digest", "content_sha256", "size_bytes", "content_type", "etag", "captured_at"];
  if (Object.keys(value).length !== expectedKeys.length || expectedKeys.some((key) => !Object.hasOwn(value, key)) ||
      value.protocol !== RAW_CAPTURE_PROTOCOL || value.capture_id !== row.capture_id || value.principal_ref !== input.principal_ref ||
      value.owner_system_id !== input.owner_system_id || value.source_namespace_id !== input.source_namespace_id ||
      value.source_revision_ref !== input.source_revision_ref || value.source_logical_id !== input.source_logical_id ||
      value.source_owner_generation !== input.source_owner_generation || value.idempotency_key !== input.idempotency_key ||
      value.original_file_name !== input.original_file_name ||
      value.object_key !== expectedKey || value.residency_key_digest !== residencyDigest || value.content_sha256 !== input.content_sha256 ||
      value.size_bytes !== input.size_bytes || value.content_type !== input.content_type || typeof value.etag !== "string" || typeof value.captured_at !== "string") {
    fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "captured raw file receipt does not match its intent", true);
  }
  return value as unknown as RawCaptureReceipt;
}

async function readCapturedReceipt(row: RawCaptureRow, input: RawCaptureInput, expectedKey: string, residencyDigest: string): Promise<RawCaptureReceipt | null> {
  const receipt = receiptFromRow(row, input, expectedKey, residencyDigest);
  if (receipt === null) return null;
  if (await sha256Utf8(row.receipt_json as string) !== row.receipt_sha256) {
    fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "captured raw file receipt digest does not match", true);
  }
  return receipt;
}

function storageFailure(error: unknown): never {
  if (error instanceof RawCaptureError) throw error;
  if (error instanceof IngestStorageError && error.code === "STAGING_PART_INVALID") {
    fail("RAW_CAPTURE_INPUT_INVALID", "raw capture stream does not match its declared byte envelope", false, error);
  }
  if (error instanceof R2IntegrityError && containsStreamBoundary(error)) {
    fail("RAW_CAPTURE_INPUT_INVALID", "raw capture stream does not match its declared byte envelope", false, error);
  }
  if (error instanceof R2IntegrityError && error.retryable) {
    fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "immutable raw object readback is unavailable", true, error);
  }
  fail("RAW_CAPTURE_STORAGE_CONFLICT", "immutable raw object publication failed", false, error);
}

function containsStreamBoundary(value: unknown, depth = 0): boolean {
  if (depth > 4 || value === null || typeof value !== "object") return false;
  if (value instanceof IngestStorageError) return value.code === "STAGING_PART_INVALID";
  const cause = (value as { readonly cause?: unknown }).cause;
  return containsStreamBoundary(cause, depth + 1) ||
    (cause !== undefined && typeof cause === "object" &&
      Object.values(cause as Record<string, unknown>).some((entry) => containsStreamBoundary(entry, depth + 1)));
}

function knownLengthBody(body: ReadableStream<Uint8Array>, expectedBytes: number): ReadableStream<Uint8Array> {
  const checked = exactSizeStream(body, expectedBytes);
  if (typeof FixedLengthStream !== "function") return checked;
  const fixed = new FixedLengthStream(expectedBytes);
  void checked.pipeTo(fixed.writable).catch(() => undefined);
  return fixed.readable;
}

function receiptFromObject(input: RawCaptureInput, captureId: string, key: string, residencyDigest: string, object: ImmutableObjectReceipt, now: number): RawCaptureReceipt {
  if (object.readback_sha256 !== input.content_sha256 || object.size_bytes !== input.size_bytes || object.key !== key) {
    fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "immutable raw object readback does not match its intent", true);
  }
  return {
    protocol: RAW_CAPTURE_PROTOCOL,
    capture_id: captureId,
    principal_ref: input.principal_ref,
    owner_system_id: input.owner_system_id,
    source_namespace_id: input.source_namespace_id,
    source_revision_ref: input.source_revision_ref,
    source_logical_id: input.source_logical_id,
    source_owner_generation: input.source_owner_generation,
    idempotency_key: input.idempotency_key,
    original_file_name: input.original_file_name,
    object_key: key,
    residency_key_digest: residencyDigest,
    content_sha256: input.content_sha256,
    size_bytes: input.size_bytes,
    content_type: input.content_type,
    etag: object.etag,
    captured_at: timestamp(now, "captured_at"),
  };
}

async function insertIntent(
  database: D1Database,
  input: RawCaptureInput,
  identity: Awaited<ReturnType<typeof inputIdentity>>,
  createdAt: string,
  expiresAt: string,
): Promise<RawCaptureRow> {
  const residencyJson = canonicalJson(input.residency_key);
  try {
    await database.prepare(
      "INSERT INTO raw_file_capture(capture_id,principal_ref,owner_system_id,source_namespace_id,source_revision_ref," +
      "source_logical_id,source_owner_generation,idempotency_key,original_file_name,request_digest,residency_key_json,residency_key_digest," +
      "content_sha256,size_bytes,content_type,state,object_key,receipt_json,receipt_sha256,created_at,updated_at,expires_at) " +
      "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,'INTENT',?16,NULL,NULL,?17,?17,?18)",
    ).bind(identity.captureId, input.principal_ref, input.owner_system_id, input.source_namespace_id,
      input.source_revision_ref, input.source_logical_id, input.source_owner_generation, input.idempotency_key,
      input.original_file_name, identity.requestDigest, residencyJson, identity.residencyDigest, input.content_sha256, input.size_bytes,
      input.content_type, identity.objectKey, createdAt, expiresAt).run();
  } catch (error) {
    const raced = await readByCaptureId(database, identity.captureId);
    if (raced === null) {
      const byKey = await readByIdempotency(database, input.principal_ref, input.idempotency_key);
      if (byKey === null) fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "raw capture intent append is uncertain", true, error);
      assertRequest(byKey, input, identity.requestDigest, identity.residencyDigest);
      return byKey;
    }
    assertRequest(raced, input, identity.requestDigest, identity.residencyDigest);
    return raced;
  }
  const row = await readByCaptureId(database, identity.captureId);
  if (row === null) fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "raw capture intent readback is missing", true);
  assertRequest(row, input, identity.requestDigest, identity.residencyDigest);
  return row;
}

async function markCaptured(
  database: D1Database,
  input: RawCaptureInput,
  identity: Awaited<ReturnType<typeof inputIdentity>>,
  receipt: RawCaptureReceipt,
  updatedAt: string,
): Promise<RawCaptureRow> {
  const receiptJson = canonicalJson(receipt);
  if (new TextEncoder().encode(receiptJson).byteLength > MAX_RECEIPT_BYTES) {
    fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "raw capture receipt exceeds its D1 envelope", true);
  }
  const receiptSha = await sha256Utf8(receiptJson);
  try {
    await database.prepare(
      "UPDATE raw_file_capture SET state='CAPTURED',object_key=?2,receipt_json=?3,receipt_sha256=?4,updated_at=?5 " +
      "WHERE capture_id=?1 AND state='INTENT'",
    ).bind(identity.captureId, identity.objectKey, receiptJson, receiptSha, updatedAt).run();
  } catch (error) {
    const row = await readByCaptureId(database, identity.captureId);
    if (row !== null) {
      assertRequest(row, input, identity.requestDigest, identity.residencyDigest);
      return row;
    }
    fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "raw capture receipt append is uncertain", true, error);
  }
  const row = await readByCaptureId(database, identity.captureId);
  if (row === null) fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "raw capture receipt readback is missing", true);
  assertRequest(row, input, identity.requestDigest, identity.residencyDigest);
  return row;
}

export function createRawCapturePort(dependencies: RawCaptureDependencies): RawCapturePort {
  const now = dependencies.now ?? Date.now;
  const ttl = dependencies.capture_ttl_ms ?? DEFAULT_TTL_MS;
  const maximum = dependencies.max_size_bytes ?? DEFAULT_MAX_SIZE_BYTES;
  if (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > 7 * 24 * 60 * 60 * 1000 ||
      !Number.isSafeInteger(maximum) || maximum < 1 || maximum > DEFAULT_MAX_SIZE_BYTES) {
    fail("RAW_CAPTURE_INPUT_INVALID", "raw capture bounds are invalid");
  }
  return {
    async read(lookup: RawCaptureLookup): Promise<RawCaptureReceipt | null> {
      identifier(lookup.principal_ref, "principal_ref");
      if ((lookup.idempotency_key === undefined) === (lookup.capture_id === undefined)) {
        fail("RAW_CAPTURE_INPUT_INVALID", "raw capture read requires exactly one lookup identity");
      }
      if (lookup.idempotency_key !== undefined) identifier(lookup.idempotency_key, "idempotency_key");
      if (lookup.capture_id !== undefined) identifier(lookup.capture_id, "capture_id");
      const row = lookup.capture_id === undefined
        ? await readByIdempotency(dependencies.database, lookup.principal_ref, lookup.idempotency_key as string)
        : await readByCaptureId(dependencies.database, lookup.capture_id);
      if (row === null || row.state !== RAW_CAPTURED_STATE || row.principal_ref !== lookup.principal_ref) return null;
      const residencyRaw = row.residency_key_json;
      if (typeof residencyRaw !== "string") fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "stored raw capture residency is missing", true);
      let residency: RawCaptureInput["residency_key"];
      try { residency = ObjectResidencyKeySchema.parse(JSON.parse(residencyRaw)); }
      catch (error) { fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "stored raw capture residency is malformed", true, error); }
      const stored = row as RawCaptureRow;
      if (typeof stored.content_sha256 !== "string" || typeof stored.size_bytes !== "number" ||
          typeof stored.idempotency_key !== "string" ||
          typeof stored.owner_system_id !== "string" || typeof stored.source_namespace_id !== "string" ||
          typeof stored.source_revision_ref !== "string" || typeof stored.source_logical_id !== "string" ||
          typeof stored.source_owner_generation !== "string" || typeof stored.original_file_name !== "string" ||
          typeof stored.content_type !== "string") {
        fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "stored raw capture authority fields are malformed", true);
      }
      const authority = {
        principal_ref: lookup.principal_ref,
        owner_system_id: stored.owner_system_id,
        source_namespace_id: stored.source_namespace_id,
        source_revision_ref: stored.source_revision_ref,
        source_logical_id: stored.source_logical_id,
        source_owner_generation: stored.source_owner_generation,
        idempotency_key: typeof row.idempotency_key === "string" ? row.idempotency_key : "",
        original_file_name: stored.original_file_name,
        residency_key: residency,
        content_sha256: stored.content_sha256,
        size_bytes: stored.size_bytes,
        content_type: stored.content_type,
      };
      await dependencies.assertCurrent(authority);
      const identity = await inputIdentity({ ...authority, body: new ReadableStream() });
      assertRequest(row, { ...authority, body: new ReadableStream() }, identity.requestDigest, identity.residencyDigest);
      const receipt = await readCapturedReceipt(row, { ...authority, body: new ReadableStream() }, identity.objectKey, identity.residencyDigest);
      if (receipt === null) fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "captured raw capture receipt is unavailable", true);
      await dependencies.assertCurrent(authority);
      return receipt;
    },
    async capture(input: RawCaptureInput): Promise<RawCaptureResult> {
      validateInput(input, maximum);
      const identity = await inputIdentity(input);
      await dependencies.assertCurrent(input);
      const currentMs = now();
      const createdAt = timestamp(currentMs, "created_at");
      const expiresAt = timestamp(currentMs + ttl, "expires_at");
      const intent = await insertIntent(dependencies.database, input, identity, createdAt, expiresAt);
      const existing = await readCapturedReceipt(intent, input, identity.objectKey, identity.residencyDigest);
      if (existing !== null) {
        await dependencies.assertCurrent(input);
        return { disposition: "CAPTURED", receipt: existing };
      }
      persistedExpiry(intent, currentMs);
      let object: ImmutableObjectReceipt;
      try {
        object = await dependencies.evidence_store.putImmutable({
          key: identity.objectKey,
          body: knownLengthBody(input.body, input.size_bytes),
          expected_sha256: input.content_sha256,
          expected_size_bytes: input.size_bytes,
          content_type: input.content_type,
          custom_metadata: {
            raw_capture_id: identity.captureId,
            principal_ref: input.principal_ref,
            source_namespace_id: input.source_namespace_id,
            source_revision_ref: input.source_revision_ref,
            source_owner_generation: input.source_owner_generation,
            original_file_name: input.original_file_name,
          },
        });
      } catch (error) {
        storageFailure(error);
      }
      await dependencies.assertCurrent(input);
      const receipt = receiptFromObject(input, identity.captureId, identity.objectKey, identity.residencyDigest, object, now());
      const captured = await markCaptured(dependencies.database, input, identity, receipt, timestamp(now(), "updated_at"));
      const readback = await readCapturedReceipt(captured, input, identity.objectKey, identity.residencyDigest);
      if (readback === null) fail("RAW_CAPTURE_SETTLEMENT_UNCERTAIN", "raw capture receipt did not settle", true);
      await dependencies.assertCurrent(input);
      return { disposition: "CAPTURED", receipt: readback };
    },
  };
}
