import {
  BundleAdmissionReceiptSchema,
  type BundleAdmissionReceipt,
  type PromotedObjectReadback,
} from "../normalized-bundle.js";
import type { ObjectResidencyKey } from "../residency.js";

export type PromotionReadbackErrorCode =
  | "INGEST_AUTHORITY_INPUT_INVALID"
  | "INGEST_AUTHORITY_CONFLICT";

export class PromotionReadbackError extends Error {
  public readonly code: PromotionReadbackErrorCode;
  public readonly retryable: boolean;

  public constructor(
    code: PromotionReadbackErrorCode,
    message: string,
    retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PromotionReadbackError";
    this.code = code;
    this.retryable = retryable;
  }
}

function readbackFail(
  code: PromotionReadbackErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new PromotionReadbackError(code, message, retryable, cause);
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function authorityIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    readbackFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

function authoritySha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    readbackFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} is not a lowercase SHA-256 digest`);
  }
  return value;
}

function assertOpaqueToken(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    utf8Bytes(value) > 1024 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    readbackFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} is invalid`);
  }
}

function assertPath(path: unknown, label = "bundle path"): asserts path is string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("//") ||
    utf8Bytes(path) > 512
  ) {
    readbackFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} is not a bounded relative path`);
  }
  for (const segment of path.split("/")) {
    if (segment === "." || segment === ".." || !SAFE_PATH_SEGMENT.test(segment)) {
      readbackFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} contains an unsafe segment`);
    }
  }
}

function assertStorageKey(path: unknown, label = "storage key"): asserts path is string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("//") ||
    utf8Bytes(path) > 1024
  ) {
    readbackFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} is not a bounded relative storage key`);
  }
  for (const segment of path.split("/")) {
    if (segment === "." || segment === ".." || !SAFE_PATH_SEGMENT.test(segment)) {
      readbackFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} contains an unsafe segment`);
    }
  }
}

function assertSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    readbackFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} is outside its allowed integer range`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    readbackFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} must be a lowercase SHA-256 digest`);
  }
}

function promotionCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      readbackFail("INGEST_AUTHORITY_INPUT_INVALID", "canonical JSON cannot contain non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(promotionCanonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${promotionCanonicalJson(record[key])}`).join(",")}}`;
  }
  readbackFail("INGEST_AUTHORITY_INPUT_INVALID", "canonical JSON contains a non-JSON value");
}

function asPromotionField(attempt: () => void, label: string): void {
  try {
    attempt();
  } catch (cause) {
    readbackFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} is invalid`, false, cause);
  }
}

function assertReadbackToken(value: unknown, label: string): void {
  asPromotionField(() => assertOpaqueToken(value, label), label);
  if (new TextEncoder().encode(value as string).byteLength > 512) {
    readbackFail("INGEST_AUTHORITY_INPUT_INVALID", `${label} escapes its readback byte limit`);
  }
}

export interface PromotionReadbackOperationView {
  readonly staging_session_ref: string | null;
  readonly decision_receipt_ref: string | null;
  readonly residency_key: ObjectResidencyKey;
  readonly manifest: { readonly content: { readonly markdown_sha256: string } };
  readonly operation_id: string;
  readonly manifest_sha256: string;
  readonly source_revision_ref: string;
  readonly residency_key_digest: string;
}

export interface PromotionObjectView {
  readonly logical_path: string;
  readonly canonical_key: string;
  readonly residency_key_digest?: string | undefined;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly etag: string;
  readonly version?: string | undefined;
  readonly content_type?: string | undefined;
}

export interface PromotionReceiptView {
  readonly protocol: string;
  readonly session_id: string;
  readonly admission_receipt_ref: string;
  readonly canonical_manifest_ref: string;
  readonly readback_digest: string;
  readonly promoted_objects: readonly PromotionObjectView[];
}

export interface PromotionReadbackDeps {
  readonly residencyDigestFor: (residency: ObjectResidencyKey) => Promise<string>;
  readonly mediaTypeFor: (logicalPath: string) => string;
}

export interface PromotionReadbackResult {
  readonly promotionRef: string;
  readonly contentKey: string;
  readonly readbacks: readonly PromotedObjectReadback[];
}

/**
 * Canonical per-file promotion readbacks. Every promoted object contributes its
 * exact logical path, canonical R2 key, recomputed per-file residency digest,
 * content digest/size, canonical media type and the R2 readback identity (ETag
 * plus version when the bucket issues one). Fields the promotion receipt omits
 * are derived here from validated authority, never trusted from the caller, so
 * the durable admission receipt always carries the complete readback set.
 *
 * Platform-free: residency digests and media types arrive via injected
 * callbacks, so this validator never touches D1/R2/Cloudflare bindings.
 */
export async function validatePromotionStructure(
  operation: PromotionReadbackOperationView,
  promotion: PromotionReceiptView,
  deps: PromotionReadbackDeps,
): Promise<PromotionReadbackResult> {
  if (
    promotion.protocol !== "eliotr.bundle-promotion.v1" ||
    promotion.session_id !== operation.staging_session_ref ||
    promotion.admission_receipt_ref !== operation.decision_receipt_ref ||
    promotion.promoted_objects.length < 3 ||
    promotion.promoted_objects.length > 1024
  ) {
    readbackFail("INGEST_AUTHORITY_CONFLICT", "promotion receipt does not match admitted operation");
  }
  authoritySha256(promotion.readback_digest, "promotion readback digest");
  authorityIdentifier(promotion.canonical_manifest_ref, "canonical manifest ref");
  const seenPaths = new Set<string>();
  const seenKeys = new Set<string>();
  let previousPath: string | null = null;
  let contentKey: string | undefined;
  const readbacks: PromotedObjectReadback[] = [];
  for (const object of promotion.promoted_objects) {
    asPromotionField(() => assertPath(object.logical_path, "promoted logical path"), "promoted logical path");
    asPromotionField(() => assertStorageKey(object.canonical_key, "promoted canonical key"), "promoted canonical key");
    asPromotionField(() => assertSha256(object.sha256, "promoted object digest"), "promoted object digest");
    asPromotionField(
      () => assertSafeInteger(object.size_bytes, "promoted object size", 1, Number.MAX_SAFE_INTEGER),
      "promoted object size",
    );
    assertReadbackToken(object.etag, "promoted object ETag");
    if (object.version !== undefined) {
      assertReadbackToken(object.version, "promoted object version");
    }
    if (previousPath !== null && object.logical_path <= previousPath) {
      readbackFail("INGEST_AUTHORITY_CONFLICT", "promotion receipt is not canonically ordered");
    }
    previousPath = object.logical_path;
    if (seenPaths.has(object.logical_path) || seenKeys.has(object.canonical_key)) {
      readbackFail("INGEST_AUTHORITY_CONFLICT", "promotion receipt repeats a logical path or key");
    }
    seenPaths.add(object.logical_path);
    seenKeys.add(object.canonical_key);
    const expectedResidency = await deps.residencyDigestFor({
      ...operation.residency_key,
      content_digest: { algorithm: "sha256", digest: object.sha256 },
    });
    if (object.residency_key_digest !== undefined && object.residency_key_digest !== expectedResidency) {
      readbackFail("INGEST_AUTHORITY_CONFLICT", "promoted residency digest differs from admitted authority");
    }
    const expectedMediaType = deps.mediaTypeFor(object.logical_path);
    if (object.content_type !== undefined && object.content_type !== expectedMediaType) {
      readbackFail("INGEST_AUTHORITY_CONFLICT", "promoted media type is not canonical for its path");
    }
    if (object.logical_path === "content.md") {
      if (object.sha256 !== operation.manifest.content.markdown_sha256) {
        readbackFail("INGEST_AUTHORITY_CONFLICT", "promoted content digest differs from manifest");
      }
      contentKey = object.canonical_key;
    }
    readbacks.push({
      logical_path: object.logical_path,
      canonical_key: object.canonical_key,
      residency_key_digest: expectedResidency,
      sha256: object.sha256,
      size_bytes: object.size_bytes,
      etag: object.etag,
      ...(object.version === undefined ? {} : { version: object.version }),
      content_type: expectedMediaType,
    });
  }
  for (const required of ["content.md", "manifest.json", "hashes.sha256"]) {
    if (!seenPaths.has(required)) readbackFail("INGEST_AUTHORITY_CONFLICT", `promotion is missing ${required}`);
  }
  if (contentKey === undefined) readbackFail("INGEST_AUTHORITY_CONFLICT", "promotion content object is missing");
  const manifestEntry = readbacks.find((entry) => entry.logical_path === "manifest.json");
  if (manifestEntry?.canonical_key !== promotion.canonical_manifest_ref) {
    readbackFail("INGEST_AUTHORITY_CONFLICT", "promotion canonical manifest mapping is inconsistent");
  }
  return {
    promotionRef: `promotion:${promotion.session_id}:${promotion.readback_digest.slice(0, 24)}`,
    contentKey,
    readbacks,
  };
}

export function validateBundleReceiptStructure(
  operation: PromotionReadbackOperationView,
  promotion: PromotionReceiptView,
  raw: BundleAdmissionReceipt,
  canonicalReadbacks: readonly PromotedObjectReadback[],
): BundleAdmissionReceipt {
  let receipt: BundleAdmissionReceipt;
  try { receipt = BundleAdmissionReceiptSchema.parse(raw); }
  catch (cause) {
    readbackFail("INGEST_AUTHORITY_INPUT_INVALID", "bundle admission receipt failed strict validation", false, cause);
  }
  if (
    receipt.decision !== "ADMITTED" ||
    receipt.operation_id !== operation.operation_id ||
    receipt.manifest_sha256 !== operation.manifest_sha256 ||
    receipt.source_revision_ref !== operation.source_revision_ref ||
    receipt.normalized_artifact_ref !== promotion.canonical_manifest_ref ||
    receipt.object_residency_key_digest !== operation.residency_key_digest ||
    receipt.readback_sha256 !== promotion.readback_digest
  ) {
    readbackFail("INGEST_AUTHORITY_CONFLICT", "bundle admission receipt does not match promotion authority");
  }
  // The durable receipt must carry every promoted object's exact readback.
  // Callers built before per-file persistence omit the set; the commit choke
  // point derives it from the validated promotion instead of trusting caller
  // bytes. A caller-supplied set must equal the canonical derivation exactly.
  if (receipt.decision === "ADMITTED" && canonicalReadbacks.length === 0) {
    readbackFail("INGEST_AUTHORITY_CONFLICT", "admitted bundle has no durable promotion readbacks");
  }
  if (receipt.promoted_objects === undefined) {
    const enriched = { ...receipt, promoted_objects: [...canonicalReadbacks] };
    try { receipt = BundleAdmissionReceiptSchema.parse(enriched); }
    catch (cause) {
      readbackFail("INGEST_AUTHORITY_INPUT_INVALID", "canonical promotion readbacks failed strict validation", false, cause);
    }
  } else if (promotionCanonicalJson(receipt.promoted_objects) !== promotionCanonicalJson(canonicalReadbacks)) {
    readbackFail("INGEST_AUTHORITY_CONFLICT", "bundle admission receipt readbacks differ from promotion authority");
  }
  return receipt;
}
