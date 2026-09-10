import {
  NormalizedBundleManifestSchema,
  ObjectResidencyKeySchema,
  type NormalizedBundleManifest,
  type ObjectResidencyKey,
} from "@eliotr/contracts";
import {
  bufferBounded,
  canonicalNormalizedBundleKey,
  objectResidencyKeyDigest,
  sha256Utf8,
} from "./r2.js";
import {
  COMPLETION_PROTOCOL,
  PROMOTION_PROTOCOL,
  SESSION_PROTOCOL,
  TOMBSTONE_PROTOCOL,
  assertIdentifier,
  assertOpaqueToken,
  assertPath,
  assertSafeInteger,
  assertSha256,
  assertStorageKey,
  canonicalJson,
  fail,
  validateFileSet,
  validateResidency,
} from "./ingest-validation.js";
import type {
  BundlePromotionReceipt,
  InternalStagedBundleSession,
  MultipartUploadSession,
  PromotedObjectReceipt,
  StagedFileCompletionReceipt,
} from "./ingest-types.js";

const MAX_SESSION_DOCUMENT_BYTES = 1024 * 1024;
const MAX_TERMINAL_DOCUMENT_BYTES = 1024 * 1024;
const MIN_NONFINAL_PART_SIZE = 5 * 1024 * 1024;
const MAX_PART_SIZE = 256 * 1024 * 1024;
const HARD_MAX_TOTAL_BYTES = 50 * 1024 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface StagingTombstone {
  readonly protocol: typeof TOMBSTONE_PROTOCOL;
  readonly session_id: string;
  readonly input_fingerprint: string;
  readonly reason_code: string;
  readonly aborted_at: string;
}

export function sessionKey(sessionId: string): string {
  return `staging/session/${sessionId}/session.json`;
}

export function tombstoneKey(sessionId: string): string {
  return `staging-tombstones/${sessionId}.json`;
}

export function promotionKey(sessionId: string): string {
  return `staging-promotions/${sessionId}.json`;
}

export async function completionKey(sessionId: string, path: string): Promise<string> {
  return `staging/session/${sessionId}/completed/${await sha256Utf8(path)}.json`;
}

export function publicSession(session: InternalStagedBundleSession): MultipartUploadSession {
  return {
    session_id: session.session_id,
    staging_prefix: session.staging_prefix,
    part_size_bytes: session.part_size_bytes,
    expires_at: session.expires_at,
    uploads: session.uploads,
  };
}

export async function readText(
  bucket: R2Bucket,
  key: string,
  maximumBytes: number,
): Promise<string | null> {
  const object = await bucket.get(key);
  if (object === null) return null;
  if (object.size > maximumBytes) {
    fail("STAGING_SESSION_CORRUPT", `${key} exceeds its bounded text envelope`);
  }
  const bytes = await bufferBounded(object.body, maximumBytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail("STAGING_SESSION_CORRUPT", `${key} is not valid UTF-8`, false, error);
  }
}

export async function readImmutableJson(
  bucket: R2Bucket,
  key: string,
  maximumBytes: number,
): Promise<unknown | null> {
  const object = await bucket.get(key);
  if (object === null) return null;
  if (object.size > maximumBytes) {
    fail("STAGING_SESSION_CORRUPT", `${key} exceeds its immutable JSON envelope`);
  }
  const bytes = await bufferBounded(object.body, maximumBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail("STAGING_SESSION_CORRUPT", `${key} is not valid UTF-8`, false, error);
  }
  const metadata = object.customMetadata;
  const expectedDigest = metadata?.eliotr_sha256;
  if (
    metadata?.eliotr_immutable !== "true" ||
    expectedDigest === undefined ||
    !SHA256.test(expectedDigest) ||
    await sha256Utf8(text) !== expectedDigest
  ) {
    fail("STAGING_SESSION_CORRUPT", `${key} failed immutable JSON digest verification`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail("STAGING_SESSION_CORRUPT", `${key} is not valid JSON`, false, error);
  }
  if (canonicalJson(parsed) !== text) {
    fail("STAGING_SESSION_CORRUPT", `${key} is not canonical immutable JSON`);
  }
  return parsed;
}

function exactKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    fail("STAGING_SESSION_CORRUPT", `${label} contains unknown fields`);
  }
}

function parseManifest(value: unknown): NormalizedBundleManifest {
  try {
    return NormalizedBundleManifestSchema.parse(value);
  } catch (error) {
    fail("STAGING_SESSION_CORRUPT", "staging session manifest is invalid", false, error);
  }
}

function parseResidency(value: unknown): ObjectResidencyKey {
  try {
    return ObjectResidencyKeySchema.parse(value);
  } catch (error) {
    fail("STAGING_SESSION_CORRUPT", "staging session residency key is invalid", false, error);
  }
}

export function parseSession(
  value: unknown,
  expectedSessionId: string,
): InternalStagedBundleSession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("STAGING_SESSION_CORRUPT", "staging session is not an object");
  }
  const record = value as Record<string, unknown>;
  exactKeys(record, new Set([
    "protocol",
    "session_id",
    "staging_prefix",
    "created_at",
    "expires_at",
    "idempotency_scope",
    "idempotency_key",
    "input_fingerprint",
    "part_size_bytes",
    "total_bytes",
    "residency_key_digest",
    "residency_key",
    "manifest",
    "file_hashes",
    "uploads",
  ]), "staging session");
  if (record.protocol !== SESSION_PROTOCOL || record.session_id !== expectedSessionId) {
    fail("STAGING_SESSION_CORRUPT", "staging session protocol or identity mismatch");
  }
  assertIdentifier(record.session_id, "session_id");
  assertStorageKey(record.staging_prefix, "staging_prefix");
  if (record.staging_prefix !== `staging/session/${expectedSessionId}`) {
    fail("STAGING_SESSION_CORRUPT", "staging session prefix is not derived from its identity");
  }
  assertIdentifier(record.idempotency_scope, "idempotency_scope");
  assertIdentifier(record.idempotency_key, "idempotency_key");
  assertSha256(record.input_fingerprint, "input_fingerprint");
  assertSha256(record.residency_key_digest, "residency_key_digest");
  assertSafeInteger(
    record.part_size_bytes,
    "part_size_bytes",
    MIN_NONFINAL_PART_SIZE,
    MAX_PART_SIZE,
  );
  assertSafeInteger(record.total_bytes, "total_bytes", 1, HARD_MAX_TOTAL_BYTES);
  if (
    typeof record.created_at !== "string" ||
    typeof record.expires_at !== "string" ||
    !Number.isFinite(Date.parse(record.created_at)) ||
    !Number.isFinite(Date.parse(record.expires_at)) ||
    Date.parse(record.created_at) >= Date.parse(record.expires_at)
  ) {
    fail("STAGING_SESSION_CORRUPT", "staging session timestamps are invalid");
  }

  const manifest = parseManifest(record.manifest);
  const residency = parseResidency(record.residency_key);
  if (!Array.isArray(record.file_hashes) || !Array.isArray(record.uploads)) {
    fail("STAGING_SESSION_CORRUPT", "staging session file lists are invalid");
  }
  const fileHashes = record.file_hashes.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      fail("STAGING_SESSION_CORRUPT", "staging file hash entry is invalid");
    }
    const item = entry as Record<string, unknown>;
    exactKeys(item, new Set(["path", "sha256"]), "staging file hash entry");
    assertPath(item.path);
    assertSha256(item.sha256, "staging file digest");
    return { path: item.path, sha256: item.sha256 };
  });
  const uploads = record.uploads.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      fail("STAGING_SESSION_CORRUPT", "staging upload entry is invalid");
    }
    const item = entry as Record<string, unknown>;
    exactKeys(
      item,
      new Set(["path", "staging_key", "upload_id", "expected_sha256"]),
      "staging upload entry",
    );
    assertPath(item.path);
    assertStorageKey(item.staging_key, "staging_key");
    assertOpaqueToken(item.upload_id, "upload_id");
    assertSha256(item.expected_sha256, "expected_sha256");
    return {
      path: item.path,
      staging_key: item.staging_key,
      upload_id: item.upload_id,
      expected_sha256: item.expected_sha256,
    };
  });
  const hashes = new Map(fileHashes.map((entry) => [entry.path, entry.sha256]));
  const sortedPaths = fileHashes.map((entry) => entry.path).toSorted();
  if (
    hashes.size !== fileHashes.length ||
    uploads.length !== fileHashes.length ||
    fileHashes.some((entry, index) => entry.path !== sortedPaths[index]) ||
    uploads.some((upload, index) =>
      upload.path !== fileHashes[index]?.path ||
      hashes.get(upload.path) !== upload.expected_sha256 ||
      upload.staging_key !== `${record.staging_prefix}/files/${upload.path}`)
  ) {
    fail("STAGING_SESSION_CORRUPT", "staging session upload mapping is inconsistent");
  }
  validateFileSet(manifest, fileHashes);
  validateResidency(manifest, residency);
  return {
    ...record,
    manifest,
    residency_key: residency,
    file_hashes: fileHashes,
    uploads,
  } as unknown as InternalStagedBundleSession;
}

export async function loadSession(
  bucket: R2Bucket,
  sessionId: string,
): Promise<InternalStagedBundleSession> {
  assertIdentifier(sessionId, "session_id");
  const raw = await readImmutableJson(bucket, sessionKey(sessionId), MAX_SESSION_DOCUMENT_BYTES);
  if (raw === null) {
    fail("STAGING_SESSION_NOT_FOUND", `staging session ${sessionId} does not exist`);
  }
  const session = parseSession(raw, sessionId);
  const identity = await sha256Utf8(`${session.idempotency_scope}\u0000${session.idempotency_key}`);
  if (session.session_id !== `session-${identity}`) {
    fail("STAGING_SESSION_CORRUPT", "staging session identity does not match idempotency identity");
  }
  const fingerprint = await sha256Utf8(canonicalJson({
    manifest: session.manifest,
    residency_key: session.residency_key,
    file_hashes: session.file_hashes,
    total_bytes: session.total_bytes,
  }));
  const residencyDigest = await objectResidencyKeyDigest(session.residency_key);
  if (
    fingerprint !== session.input_fingerprint ||
    residencyDigest !== session.residency_key_digest
  ) {
    fail("STAGING_SESSION_CORRUPT", "staging session fingerprint or residency digest is invalid");
  }
  return session;
}

export function assertActive(session: InternalStagedBundleSession, currentTime: number): void {
  const expiry = Date.parse(session.expires_at);
  if (!Number.isFinite(expiry)) {
    fail("STAGING_SESSION_CORRUPT", "staging session expiry is invalid");
  }
  if (expiry <= currentTime) {
    fail("STAGING_SESSION_EXPIRED", "staging session has expired");
  }
}

export async function readCompletionReceipt(
  bucket: R2Bucket,
  session: InternalStagedBundleSession,
  path: string,
): Promise<StagedFileCompletionReceipt | null> {
  const raw = await readImmutableJson(
    bucket,
    await completionKey(session.session_id, path),
    64 * 1024,
  );
  if (raw === null) return null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("STAGING_SESSION_CORRUPT", `completion receipt for ${path} is invalid`);
  }
  const record = raw as Record<string, unknown>;
  exactKeys(
    record,
    new Set(["protocol", "session_id", "path", "sha256", "size_bytes", "etag", "completed_at"]),
    "completion receipt",
  );
  if (
    record.protocol !== COMPLETION_PROTOCOL ||
    record.session_id !== session.session_id ||
    record.path !== path
  ) {
    fail("STAGING_SESSION_CORRUPT", `completion receipt for ${path} is invalid`);
  }
  assertSha256(record.sha256, "completion receipt sha256");
  const upload = session.uploads.find((candidate) => candidate.path === path);
  if (upload === undefined || upload.expected_sha256 !== record.sha256) {
    fail(
      "STAGING_SESSION_CORRUPT",
      `completion receipt for ${path} is not bound to the prepared digest`,
    );
  }
  assertSafeInteger(record.size_bytes, "completion receipt size", 1, session.total_bytes);
  assertOpaqueToken(record.etag, "completion receipt etag");
  if (
    typeof record.completed_at !== "string" ||
    !Number.isFinite(Date.parse(record.completed_at))
  ) {
    fail("STAGING_SESSION_CORRUPT", `completion receipt for ${path} has an invalid timestamp`);
  }
  return record as unknown as StagedFileCompletionReceipt;
}

export function stablePromotionPayload(receipt: BundlePromotionReceipt): unknown {
  return {
    protocol: receipt.protocol,
    session_id: receipt.session_id,
    admission_receipt_ref: receipt.admission_receipt_ref,
    canonical_manifest_ref: receipt.canonical_manifest_ref,
    promoted_objects: receipt.promoted_objects.map((entry) => ({
      logical_path: entry.logical_path,
      canonical_key: entry.canonical_key,
      sha256: entry.sha256,
      size_bytes: entry.size_bytes,
    })),
  };
}

function parsePromotedObject(value: unknown): PromotedObjectReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("STAGING_SESSION_CORRUPT", "promotion object receipt is invalid");
  }
  const record = value as Record<string, unknown>;
  exactKeys(
    record,
    new Set([
      "logical_path",
      "canonical_key",
      "sha256",
      "size_bytes",
      "etag",
      "existed_identically",
    ]),
    "promotion object receipt",
  );
  assertPath(record.logical_path, "promotion logical_path");
  assertStorageKey(record.canonical_key, "promotion canonical_key");
  assertSha256(record.sha256, "promotion object sha256");
  assertSafeInteger(record.size_bytes, "promotion object size", 1, HARD_MAX_TOTAL_BYTES);
  assertOpaqueToken(record.etag, "promotion object etag");
  if (typeof record.existed_identically !== "boolean") {
    fail("STAGING_SESSION_CORRUPT", "promotion object idempotency flag is invalid");
  }
  return record as unknown as PromotedObjectReceipt;
}

export async function readPromotionReceipt(
  bucket: R2Bucket,
  sessionId: string,
  expectedAdmissionReceiptRef?: string,
  session?: InternalStagedBundleSession,
): Promise<BundlePromotionReceipt | null> {
  assertIdentifier(sessionId, "session_id");
  const raw = await readImmutableJson(
    bucket,
    promotionKey(sessionId),
    MAX_TERMINAL_DOCUMENT_BYTES,
  );
  if (raw === null) return null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("STAGING_SESSION_CORRUPT", "promotion receipt is invalid");
  }
  const record = raw as Record<string, unknown>;
  exactKeys(
    record,
    new Set([
      "protocol",
      "session_id",
      "admission_receipt_ref",
      "canonical_manifest_ref",
      "readback_digest",
      "promoted_objects",
      "promoted_at",
    ]),
    "promotion receipt",
  );
  if (record.protocol !== PROMOTION_PROTOCOL || record.session_id !== sessionId) {
    fail("STAGING_SESSION_CORRUPT", "promotion receipt protocol or session mismatch");
  }
  assertIdentifier(record.admission_receipt_ref, "promotion admission receipt");
  if (
    expectedAdmissionReceiptRef !== undefined &&
    record.admission_receipt_ref !== expectedAdmissionReceiptRef
  ) {
    fail("STAGING_STATE_CONFLICT", "promotion is already bound to another admission receipt");
  }
  assertStorageKey(record.canonical_manifest_ref, "canonical_manifest_ref");
  assertSha256(record.readback_digest, "promotion readback digest");
  if (
    !Array.isArray(record.promoted_objects) ||
    record.promoted_objects.length < 3 ||
    record.promoted_objects.length > 1024
  ) {
    fail("STAGING_SESSION_CORRUPT", "promotion receipt object set is invalid");
  }
  const promoted = record.promoted_objects.map(parsePromotedObject);
  const sorted = promoted.toSorted((left, right) => left.logical_path.localeCompare(right.logical_path));
  if (
    promoted.some((entry, index) => entry.logical_path !== sorted[index]?.logical_path) ||
    new Set(promoted.map((entry) => entry.logical_path)).size !== promoted.length ||
    new Set(promoted.map((entry) => entry.canonical_key)).size !== promoted.length
  ) {
    fail("STAGING_SESSION_CORRUPT", "promotion receipt is not unique and canonically ordered");
  }
  const manifestObject = promoted.find((item) => item.logical_path === "manifest.json");
  if (manifestObject?.canonical_key !== record.canonical_manifest_ref) {
    fail("STAGING_SESSION_CORRUPT", "promotion receipt canonical manifest mapping is inconsistent");
  }
  if (
    typeof record.promoted_at !== "string" ||
    !Number.isFinite(Date.parse(record.promoted_at))
  ) {
    fail("STAGING_SESSION_CORRUPT", "promotion timestamp is invalid");
  }
  const receipt = {
    ...record,
    promoted_objects: promoted,
  } as unknown as BundlePromotionReceipt;
  if (await sha256Utf8(canonicalJson(stablePromotionPayload(receipt))) !== receipt.readback_digest) {
    fail("STAGING_SESSION_CORRUPT", "promotion receipt stable digest is invalid");
  }
  if (session !== undefined) {
    if (session.session_id !== sessionId || promoted.length !== session.uploads.length) {
      fail("STAGING_SESSION_CORRUPT", "promotion receipt does not cover the prepared session");
    }
    for (const upload of session.uploads) {
      const promotedObject = promoted.find((candidate) => candidate.logical_path === upload.path);
      if (promotedObject === undefined || promotedObject.sha256 !== upload.expected_sha256) {
        fail("STAGING_SESSION_CORRUPT", "promotion receipt is not bound to the prepared file set");
      }
      const residencyDigest = await objectResidencyKeyDigest({
        ...session.residency_key,
        content_digest: { algorithm: "sha256", digest: upload.expected_sha256 },
      });
      const expectedKey = await canonicalNormalizedBundleKey(
        residencyDigest,
        {
          owner_system_id: session.manifest.origin.owner_system_id,
          source_namespace_id: session.manifest.origin.source_namespace_id,
          source_owner_generation: session.manifest.origin.source_owner_generation,
          source_logical_id: session.manifest.source.logical_id,
          source_revision_ref: session.manifest.origin.source_revision_ref,
        },
        upload.path,
      );
      if (promotedObject.canonical_key !== expectedKey) {
        fail("STAGING_SESSION_CORRUPT", "promotion receipt contains a non-canonical object key");
      }
    }
  }
  return receipt;
}

export async function readTombstone(
  bucket: R2Bucket,
  sessionId: string,
): Promise<StagingTombstone | null> {
  assertIdentifier(sessionId, "session_id");
  const raw = await readImmutableJson(bucket, tombstoneKey(sessionId), 64 * 1024);
  if (raw === null) return null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("STAGING_SESSION_CORRUPT", "staging tombstone is invalid");
  }
  const record = raw as Record<string, unknown>;
  exactKeys(
    record,
    new Set(["protocol", "session_id", "input_fingerprint", "reason_code", "aborted_at"]),
    "staging tombstone",
  );
  if (record.protocol !== TOMBSTONE_PROTOCOL || record.session_id !== sessionId) {
    fail("STAGING_SESSION_CORRUPT", "staging tombstone identity is invalid");
  }
  assertSha256(record.input_fingerprint, "tombstone input fingerprint");
  assertIdentifier(record.reason_code, "tombstone reason code");
  if (typeof record.aborted_at !== "string" || !Number.isFinite(Date.parse(record.aborted_at))) {
    fail("STAGING_SESSION_CORRUPT", "staging tombstone timestamp is invalid");
  }
  return record as unknown as StagingTombstone;
}
