import { IdentifierSchema, Sha256Schema, VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import { canonicalEvidenceJson, evidenceSha256Bytes } from "@eliotr/cloudflare-evidence";
import { RUNTIME_LIMITS } from "@eliotr/platform-cloudflare";

const PROTOCOL = "eliotr.research.draft-verification.v1" as const;
const MAX_BYTES = RUNTIME_LIMITS.buffered_r2_bytes;

export interface ArtifactDraftVerificationCitation {
  readonly handle_ref: VersionedRef;
  readonly excerpt_sha256: string;
  readonly source_revision_content_sha256: string;
  readonly scope_snapshot_digest: string;
  readonly authorization_receipt_ref: string;
  readonly credential_generation: string;
}

export interface ArtifactDraftVerificationRecord {
  readonly schema: typeof PROTOCOL;
  readonly semantic_verification: "NOT_EXECUTED";
  readonly source_readback: "AUTHORITATIVE_RESOLVED";
  readonly operation_id: string;
  readonly investigation_ref: VersionedRef;
  readonly output_sha256: string;
  readonly freeze_ref: VersionedRef;
  readonly freeze_sha256: string;
  readonly manifest_ref: VersionedRef;
  readonly manifest_sha256: string;
  readonly evidence_pack_ref: VersionedRef;
  readonly trace_ref: VersionedRef;
  readonly cited_evidence: readonly ArtifactDraftVerificationCitation[];
  readonly section_sha256: string;
}

export interface ArtifactDraftVerificationEncoded {
  readonly record: ArtifactDraftVerificationRecord;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly verification_receipt_ref: string;
}

export class ArtifactDraftVerificationError extends Error {
  public readonly code: "ARTIFACT_DRAFT_VERIFICATION_INPUT_INVALID" | "ARTIFACT_DRAFT_VERIFICATION_CORRUPT";

  public constructor(code: ArtifactDraftVerificationError["code"], message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ArtifactDraftVerificationError";
    this.code = code;
  }
}

function fail(code: ArtifactDraftVerificationError["code"], message: string, cause?: unknown): never {
  throw new ArtifactDraftVerificationError(code, message, cause);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", `${label} is not a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !expected.has(key))) {
    fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", `${label} contains unsupported fields`);
  }
}

function identifier(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", `${label} is invalid`);
  return parsed.data;
}

function sha256(value: unknown, label: string): string {
  const parsed = Sha256Schema.safeParse(value);
  if (!parsed.success) fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", `${label} is invalid`);
  return parsed.data;
}

function versionedRef(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", `${label} is invalid`);
  return Object.freeze({ ...parsed.data });
}

function decodeValue(value: unknown): ArtifactDraftVerificationRecord {
  const root = record(value, "verification receipt");
  exactKeys(root, ["schema", "semantic_verification", "source_readback", "operation_id", "investigation_ref", "output_sha256", "freeze_ref", "freeze_sha256", "manifest_ref", "manifest_sha256", "evidence_pack_ref", "trace_ref", "cited_evidence", "section_sha256"], "verification receipt");
  if (root.schema !== PROTOCOL || root.semantic_verification !== "NOT_EXECUTED" || root.source_readback !== "AUTHORITATIVE_RESOLVED") {
    fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", "verification receipt protocol is invalid");
  }
  if (!Array.isArray(root.cited_evidence) || root.cited_evidence.length < 1 || root.cited_evidence.length > 512) {
    fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", "verification cited evidence is invalid");
  }
  const cited = root.cited_evidence.map((item, index) => {
    const value = record(item, `cited evidence ${index}`);
    exactKeys(value, ["handle_ref", "excerpt_sha256", "source_revision_content_sha256", "scope_snapshot_digest", "authorization_receipt_ref", "credential_generation"], `cited evidence ${index}`);
    return {
      handle_ref: versionedRef(value.handle_ref, `cited evidence ${index} handle_ref`),
      excerpt_sha256: sha256(value.excerpt_sha256, `cited evidence ${index} excerpt_sha256`),
      source_revision_content_sha256: sha256(value.source_revision_content_sha256, `cited evidence ${index} source digest`),
      scope_snapshot_digest: sha256(value.scope_snapshot_digest, `cited evidence ${index} scope digest`),
      authorization_receipt_ref: identifier(value.authorization_receipt_ref, `cited evidence ${index} authorization receipt`),
      credential_generation: identifier(value.credential_generation, `cited evidence ${index} credential generation`),
    } satisfies ArtifactDraftVerificationCitation;
  });
  const handles = cited.map((item) => `${item.handle_ref.id}:${item.handle_ref.revision}`);
  if (new Set(handles).size !== handles.length) fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", "verification cited evidence contains duplicate handles");
  return Object.freeze({
    schema: PROTOCOL,
    semantic_verification: "NOT_EXECUTED",
    source_readback: "AUTHORITATIVE_RESOLVED",
    operation_id: identifier(root.operation_id, "operation_id"),
    investigation_ref: versionedRef(root.investigation_ref, "investigation_ref"),
    output_sha256: sha256(root.output_sha256, "output_sha256"),
    freeze_ref: versionedRef(root.freeze_ref, "freeze_ref"),
    freeze_sha256: sha256(root.freeze_sha256, "freeze_sha256"),
    manifest_ref: versionedRef(root.manifest_ref, "manifest_ref"),
    manifest_sha256: sha256(root.manifest_sha256, "manifest_sha256"),
    evidence_pack_ref: versionedRef(root.evidence_pack_ref, "evidence_pack_ref"),
    trace_ref: versionedRef(root.trace_ref, "trace_ref"),
    cited_evidence: Object.freeze(cited),
    section_sha256: sha256(root.section_sha256, "section_sha256"),
  });
}

export async function decodeArtifactDraftVerification(
  bytes: Uint8Array,
  expectedVerificationReceiptRef?: string,
): Promise<ArtifactDraftVerificationEncoded> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_BYTES) {
    fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", "verification receipt bytes exceed the bounded object limit");
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (cause) { fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", "verification receipt is not valid UTF-8", cause); }
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch (cause) { fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", "verification receipt is not valid JSON", cause); }
  const parsed = decodeValue(value);
  if (canonicalEvidenceJson(parsed) !== text) fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", "verification receipt is not canonical JSON");
  const digest = await evidenceSha256Bytes(bytes);
  const verificationReceiptRef = `verification-${digest}`;
  if (expectedVerificationReceiptRef !== undefined && expectedVerificationReceiptRef !== verificationReceiptRef) {
    fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", "verification receipt reference does not match its bytes");
  }
  const owned = new Uint8Array(bytes.byteLength); owned.set(bytes);
  return { record: parsed, bytes: owned, sha256: digest, verification_receipt_ref: verificationReceiptRef };
}

export async function encodeArtifactDraftVerification(
  input: ArtifactDraftVerificationRecord,
): Promise<ArtifactDraftVerificationEncoded> {
  const parsed = decodeValue(input);
  const bytes = new TextEncoder().encode(canonicalEvidenceJson(parsed));
  if (bytes.byteLength > MAX_BYTES) fail("ARTIFACT_DRAFT_VERIFICATION_INPUT_INVALID", "verification receipt exceeds the bounded object limit");
  const digest = await evidenceSha256Bytes(bytes);
  const owned = new Uint8Array(bytes.byteLength); owned.set(bytes);
  return { record: parsed, bytes: owned, sha256: digest, verification_receipt_ref: `verification-${digest}` };
}
