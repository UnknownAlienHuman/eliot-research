import {
  ArtifactRevisionSchema,
  ArtifactSpecSchema,
  ObjectResidencyKeySchema,
  type ArtifactRevision,
  type ArtifactSpec,
  type ObjectResidencyKey,
} from "@eliotr/contracts";
import {
  RUNTIME_LIMITS,
  bufferBounded,
  canonicalEvidenceObjectKey,
  canonicalJson,
  objectResidencyKeyDigest,
  type EvidenceObjectStore,
  type ImmutableObjectReceipt,
} from "@eliotr/platform-cloudflare";
import { failArtifactDraftRead as fail } from "./artifact-draft-reader-contracts.js";

export const MANIFEST_PREFIX = "artifact-draft/manifest";
export const SECTION_PREFIX = "artifact-draft/section";
export const REFERENCE_PREFIX = "artifact-draft/reference";
const SHA256 = /^[a-f0-9]{64}$/u;

export interface ArtifactRow {
  readonly artifact_id: unknown;
  readonly revision: unknown;
  readonly kind: unknown;
  readonly spec_digest: unknown;
  readonly evidence_freeze_id: unknown;
  readonly evidence_freeze_revision: unknown;
  readonly manifest_r2_key: unknown;
  readonly dependency_manifest_ref: unknown;
  readonly status: unknown;
  readonly created_at: unknown;
}

export interface BindingRow {
  readonly artifact_id: unknown;
  readonly revision: unknown;
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly expected_head_revision: unknown;
  readonly principal_ref: unknown;
  readonly spec_ref_id: unknown;
  readonly spec_ref_revision: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly manifest_r2_key: unknown;
  readonly manifest_sha256: unknown;
  readonly manifest_size_bytes: unknown;
  readonly created_at: unknown;
}

export interface ReservationRow {
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly artifact_id: unknown;
  readonly artifact_revision: unknown;
  readonly request_sha256: unknown;
  readonly spec_digest: unknown;
  readonly manifest_r2_key: unknown;
  readonly expected_head_revision: unknown;
  readonly spec_ref_id: unknown;
  readonly spec_ref_revision: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly intent_json: unknown;
  readonly principal_ref: unknown;
  readonly idempotency_key: unknown;
  readonly payload_ref: unknown;
  readonly topic: unknown;
  readonly planned_objects_json: unknown;
  readonly state: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface AuthorityRow {
  readonly intent_id: unknown;
  readonly revision: unknown;
  readonly operation_kind: unknown;
  readonly principal_ref: unknown;
  readonly idempotency_key: unknown;
  readonly payload_ref: unknown;
  readonly policy_decision_ref: unknown;
  readonly budget_reservation_ref: unknown;
  readonly cancellation_ref: unknown;
  readonly created_at: unknown;
  readonly outbox_id: unknown;
  readonly topic: unknown;
  readonly payload_sha256: unknown;
}

export interface HeadRow {
  readonly artifact_id: unknown;
  readonly head_revision: unknown;
  readonly manifest_r2_key: unknown;
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly updated_at: unknown;
}

export interface ObjectRow {
  readonly artifact_id: unknown;
  readonly revision: unknown;
  readonly object_kind: unknown;
  readonly object_ref: unknown;
  readonly section_ordinal: unknown;
  readonly receipt_json: unknown;
  readonly residency_key_json: unknown;
  readonly residency_key_digest: unknown;
  readonly created_at: unknown;
}

export type DraftObjectKind = "MANIFEST" | "SECTION_BODY" | "DEPENDENCY_MANIFEST" | "EVIDENCE_LEDGER" | "VERIFICATION_RECEIPT" | "EXPORT";

export interface ExpectedObject {
  readonly object_ref: string;
  readonly object_kind: DraftObjectKind;
  readonly section_ordinal: number | null;
  readonly sha256?: string;
  readonly prefix: string;
  readonly content_type: string;
}

export interface StoredObject {
  readonly row: ObjectRow;
  readonly receipt: ImmutableObjectReceipt;
  readonly residency: ObjectResidencyKey;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly physical_key: string;
  readonly bytes?: Uint8Array;
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, `${label} is invalid`);
  try { return JSON.parse(value); }
  catch { fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, `${label} is invalid`); }
}

export function parseCanonical(value: unknown, label: string): unknown {
  const parsed = parseJson(value, label);
  if (canonicalJson(parsed) !== value) fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, `${label} is not canonical`);
  return parsed;
}

export function parseReceipt(value: unknown): ImmutableObjectReceipt {
  const parsed = parseCanonical(value, "draft object receipt");
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "draft object receipt is invalid");
  const receipt = parsed as Record<string, unknown>;
  const keys = ["key", "expected_sha256", "readback_sha256", "size_bytes", "etag", "existed_identically"];
  if (Object.keys(receipt).some((key) => !keys.includes(key)) ||
      typeof receipt.key !== "string" || typeof receipt.expected_sha256 !== "string" || !SHA256.test(receipt.expected_sha256) ||
      typeof receipt.readback_sha256 !== "string" || !SHA256.test(receipt.readback_sha256) ||
      !Number.isSafeInteger(receipt.size_bytes) || (receipt.size_bytes as number) < 0 ||
      typeof receipt.etag !== "string" || typeof receipt.existed_identically !== "boolean") {
    fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "draft object receipt is invalid");
  }
  return receipt as unknown as ImmutableObjectReceipt;
}

async function digestBytes(bytes: Uint8Array): Promise<string> {
  const owned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(owned).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", owned);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readStoredObject(
  store: EvidenceObjectStore,
  row: ObjectRow,
  expected: ExpectedObject,
  retainBytes = false,
): Promise<StoredObject> {
  if (row.object_kind !== expected.object_kind || row.object_ref !== expected.object_ref || row.section_ordinal !== expected.section_ordinal) {
    fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "draft object mapping is inconsistent");
  }
  const receipt = parseReceipt(row.receipt_json);
  let residency: ObjectResidencyKey;
  try { residency = ObjectResidencyKeySchema.parse(parseCanonical(row.residency_key_json, "draft residency")); }
  catch { fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "draft residency is invalid"); }
  const sha256 = receipt.expected_sha256;
  if (receipt.readback_sha256 !== sha256 || residency.content_digest.digest !== sha256 ||
      row.residency_key_digest !== await objectResidencyKeyDigest(residency)) {
    fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "draft object integrity is inconsistent");
  }
  if (expected.sha256 !== undefined && expected.sha256 !== sha256) fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "draft declared digest is inconsistent");
  const physicalKey = await canonicalEvidenceObjectKey(residency, expected.prefix, sha256);
  if (receipt.key !== physicalKey) fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "draft object key is inconsistent");
  let stored: R2ObjectBody | null;
  try { stored = await store.open(physicalKey); }
  catch { fail("ARTIFACT_DRAFT_READ_UNAVAILABLE", 503, "draft object read is unavailable", true); }
  if (stored === null) fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "draft object is missing");
  const metadata = stored.customMetadata ?? {};
  if (stored.etag !== receipt.etag || stored.size !== receipt.size_bytes ||
      stored.httpMetadata?.contentType !== expected.content_type || Object.keys(metadata).length !== 3 ||
      metadata.eliotr_sha256 !== sha256 || metadata.eliotr_size_bytes !== String(receipt.size_bytes) || metadata.eliotr_immutable !== "true") {
    fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "draft object metadata is inconsistent");
  }
  let actual: Uint8Array;
  try { actual = await bufferBounded(stored.body, RUNTIME_LIMITS.buffered_r2_bytes); }
  catch { fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "draft object body is unreadable"); }
  if (actual.byteLength !== receipt.size_bytes || await digestBytes(actual) !== sha256) {
    fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "draft object bytes are inconsistent");
  }
  return {
    row, receipt, residency, sha256, size_bytes: actual.byteLength, physical_key: physicalKey,
    ...(retainBytes ? { bytes: actual } : {}),
  };
}

export function addExpected(map: Map<string, ExpectedObject>, expected: ExpectedObject): void {
  if (map.has(expected.object_ref)) fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "draft object references are duplicated");
  map.set(expected.object_ref, expected);
}

export function parseManifest(bytes: Uint8Array): { readonly spec: ArtifactSpec; readonly revision: ArtifactRevision } {
  let manifestText: string;
  try { manifestText = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "draft manifest encoding is invalid"); }
  const raw = parseCanonical(manifestText, "draft manifest");
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "draft manifest is invalid");
  try {
    const value = raw as { readonly spec?: unknown; readonly revision?: unknown };
    const spec = ArtifactSpecSchema.parse(value.spec);
    const revision = ArtifactRevisionSchema.parse(value.revision);
    return { spec, revision };
  } catch { fail("ARTIFACT_DRAFT_READ_INTEGRITY", 409, "draft manifest contract is invalid"); }
}
