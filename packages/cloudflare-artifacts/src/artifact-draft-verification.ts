import {
  ClaimAuditDispositionSchema,
  IdentifierSchema,
  Sha256Schema,
  VersionedRefSchema,
  type VersionedRef,
} from "@eliotr/contracts";
import { canonicalEvidenceJson, evidenceSha256Bytes } from "@eliotr/cloudflare-evidence";
import { RUNTIME_LIMITS } from "@eliotr/platform-cloudflare";

const PROTOCOL = "eliotr.research.draft-verification.v1" as const;
const PROTOCOL_V2 = "eliotr.research.draft-verification.v2" as const;
const MAX_BYTES = RUNTIME_LIMITS.buffered_r2_bytes;
const MAX_AUDIT_ITEMS = 512;
const MAX_CLAIM_TEXT_CHARS = 16 * 1024;
type ClaimAuditDisposition = ReturnType<typeof ClaimAuditDispositionSchema.parse>;

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

export interface ArtifactDraftSemanticAuditClaim {
  readonly claim_ref: VersionedRef;
  readonly claim_text: string;
  readonly claim_text_digest: string;
  readonly disposition: ClaimAuditDisposition;
  readonly support_handle_refs: readonly VersionedRef[];
  readonly counterevidence_handle_refs: readonly VersionedRef[];
}

export interface ArtifactDraftSemanticAudit {
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  /** SHA-256 of the persisted AUDIT W2 output bytes. */
  readonly output_sha256: string;
  readonly synthesis_output_sha256: string;
  readonly normalization_binding_sha256: string;
  readonly verifier_ref: string;
  readonly verifier_schema_generation: string;
  readonly model_receipt_ref: string;
  readonly claims: readonly ArtifactDraftSemanticAuditClaim[];
}

export interface ArtifactDraftVerificationV2Record
  extends Omit<ArtifactDraftVerificationRecord, "schema" | "semantic_verification"> {
  readonly schema: typeof PROTOCOL_V2;
  readonly semantic_verification: "EXECUTED";
  readonly audit: ArtifactDraftSemanticAudit;
}

export interface ArtifactDraftVerificationV2Encoded {
  readonly record: ArtifactDraftVerificationV2Record;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly verification_receipt_ref: string;
}

export type ArtifactDraftVerificationAnyEncoded =
  | ArtifactDraftVerificationEncoded
  | ArtifactDraftVerificationV2Encoded;

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

function auditRefs(value: unknown, label: string): readonly VersionedRef[] {
  if (!Array.isArray(value) || value.length > MAX_AUDIT_ITEMS) {
    fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", `${label} is invalid`);
  }
  const refs = value.map((entry, index) => versionedRef(entry, `${label} ${index}`));
  const keys = refs.map((ref) => `${ref.id}:${ref.revision}`);
  if (new Set(keys).size !== keys.length) {
    fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", `${label} contains duplicate references`);
  }
  return Object.freeze(refs);
}

function auditDisposition(value: unknown, label: string): ClaimAuditDisposition {
  const parsed = ClaimAuditDispositionSchema.safeParse(value);
  if (!parsed.success) fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", `${label} is invalid`);
  return parsed.data;
}

function auditClaimText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_CLAIM_TEXT_CHARS) {
    fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", `${label} is invalid`);
  }
  return value;
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

async function decodeAuditClaim(value: unknown, index: number): Promise<ArtifactDraftSemanticAuditClaim> {
  const root = record(value, `semantic audit claim ${index}`);
  exactKeys(root, ["claim_ref", "claim_text", "claim_text_digest", "disposition", "support_handle_refs", "counterevidence_handle_refs"], `semantic audit claim ${index}`);
  const claimText = auditClaimText(root.claim_text, `semantic audit claim ${index} claim_text`);
  const claimTextDigest = sha256(root.claim_text_digest, `semantic audit claim ${index} claim_text_digest`);
  if (await evidenceSha256Bytes(new TextEncoder().encode(claimText)) !== claimTextDigest) {
    fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", `semantic audit claim ${index} text digest does not match claim_text`);
  }
  return Object.freeze({
    claim_ref: versionedRef(root.claim_ref, `semantic audit claim ${index} claim_ref`),
    claim_text: claimText,
    claim_text_digest: claimTextDigest,
    disposition: auditDisposition(root.disposition, `semantic audit claim ${index} disposition`),
    support_handle_refs: auditRefs(root.support_handle_refs, `semantic audit claim ${index} support_handle_refs`),
    counterevidence_handle_refs: auditRefs(root.counterevidence_handle_refs, `semantic audit claim ${index} counterevidence_handle_refs`),
  });
}

async function decodeAudit(value: unknown, outputSha256: string): Promise<ArtifactDraftSemanticAudit> {
  const root = record(value, "semantic audit");
  exactKeys(root, ["stage_attempt_ref", "stage_request_sha256", "output_sha256", "synthesis_output_sha256", "normalization_binding_sha256", "verifier_ref", "verifier_schema_generation", "model_receipt_ref", "claims"], "semantic audit");
  const auditOutputSha256 = sha256(root.output_sha256, "semantic audit output_sha256");
  const synthesisOutputSha256 = sha256(root.synthesis_output_sha256, "semantic audit synthesis_output_sha256");
  if (synthesisOutputSha256 !== outputSha256) {
    fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", "semantic audit synthesis output is not the verification output");
  }
  if (!Array.isArray(root.claims) || root.claims.length < 1 || root.claims.length > MAX_AUDIT_ITEMS) {
    fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", "semantic audit claims are invalid");
  }
  const claims: ArtifactDraftSemanticAuditClaim[] = [];
  for (const [index, claim] of root.claims.entries()) claims.push(await decodeAuditClaim(claim, index));
  const claimRefs = claims.map((claim) => `${claim.claim_ref.id}:${claim.claim_ref.revision}`);
  if (new Set(claimRefs).size !== claimRefs.length) {
    fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", "semantic audit contains duplicate claim references");
  }
  return Object.freeze({
    stage_attempt_ref: identifier(root.stage_attempt_ref, "semantic audit stage_attempt_ref"),
    stage_request_sha256: sha256(root.stage_request_sha256, "semantic audit stage_request_sha256"),
    output_sha256: auditOutputSha256,
    synthesis_output_sha256: synthesisOutputSha256,
    normalization_binding_sha256: sha256(root.normalization_binding_sha256, "semantic audit normalization_binding_sha256"),
    verifier_ref: identifier(root.verifier_ref, "semantic audit verifier_ref"),
    verifier_schema_generation: identifier(root.verifier_schema_generation, "semantic audit verifier_schema_generation"),
    model_receipt_ref: identifier(root.model_receipt_ref, "semantic audit model_receipt_ref"),
    claims: Object.freeze(claims),
  });
}

async function decodeValueV2(value: unknown): Promise<ArtifactDraftVerificationV2Record> {
  const root = record(value, "verification receipt");
  exactKeys(root, ["schema", "semantic_verification", "source_readback", "operation_id", "investigation_ref", "output_sha256", "freeze_ref", "freeze_sha256", "manifest_ref", "manifest_sha256", "evidence_pack_ref", "trace_ref", "cited_evidence", "section_sha256", "audit"], "verification receipt");
  if (root.schema !== PROTOCOL_V2 || root.semantic_verification !== "EXECUTED" || root.source_readback !== "AUTHORITATIVE_RESOLVED") {
    fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", "verification receipt protocol is invalid");
  }
  if (!Array.isArray(root.cited_evidence) || root.cited_evidence.length < 1 || root.cited_evidence.length > MAX_AUDIT_ITEMS) {
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
  const outputSha256 = sha256(root.output_sha256, "output_sha256");
  return Object.freeze({
    schema: PROTOCOL_V2,
    semantic_verification: "EXECUTED",
    source_readback: "AUTHORITATIVE_RESOLVED",
    operation_id: identifier(root.operation_id, "operation_id"),
    investigation_ref: versionedRef(root.investigation_ref, "investigation_ref"),
    output_sha256: outputSha256,
    freeze_ref: versionedRef(root.freeze_ref, "freeze_ref"),
    freeze_sha256: sha256(root.freeze_sha256, "freeze_sha256"),
    manifest_ref: versionedRef(root.manifest_ref, "manifest_ref"),
    manifest_sha256: sha256(root.manifest_sha256, "manifest_sha256"),
    evidence_pack_ref: versionedRef(root.evidence_pack_ref, "evidence_pack_ref"),
    trace_ref: versionedRef(root.trace_ref, "trace_ref"),
    cited_evidence: Object.freeze(cited),
    section_sha256: sha256(root.section_sha256, "section_sha256"),
    audit: await decodeAudit(root.audit, outputSha256),
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

async function encodeArtifactDraftVerificationV1(
  input: ArtifactDraftVerificationRecord,
): Promise<ArtifactDraftVerificationEncoded> {
  const parsed = decodeValue(input);
  const bytes = new TextEncoder().encode(canonicalEvidenceJson(parsed));
  if (bytes.byteLength > MAX_BYTES) fail("ARTIFACT_DRAFT_VERIFICATION_INPUT_INVALID", "verification receipt exceeds the bounded object limit");
  const digest = await evidenceSha256Bytes(bytes);
  const owned = new Uint8Array(bytes.byteLength); owned.set(bytes);
  return { record: parsed, bytes: owned, sha256: digest, verification_receipt_ref: `verification-${digest}` };
}

export function encodeArtifactDraftVerification(input: ArtifactDraftVerificationRecord): Promise<ArtifactDraftVerificationEncoded>;
export function encodeArtifactDraftVerification(input: ArtifactDraftVerificationV2Record): Promise<ArtifactDraftVerificationV2Encoded>;
export function encodeArtifactDraftVerification(input: ArtifactDraftVerificationRecord | ArtifactDraftVerificationV2Record): Promise<ArtifactDraftVerificationAnyEncoded>;
export async function encodeArtifactDraftVerification(
  input: ArtifactDraftVerificationRecord | ArtifactDraftVerificationV2Record,
): Promise<ArtifactDraftVerificationAnyEncoded> {
  if (isPlainRecord(input) && input.schema === PROTOCOL_V2) {
    return encodeArtifactDraftVerificationV2(input as unknown as ArtifactDraftVerificationV2Record);
  }
  return encodeArtifactDraftVerificationV1(input as ArtifactDraftVerificationRecord);
}

export async function encodeArtifactDraftVerificationV2(
  input: ArtifactDraftVerificationV2Record,
): Promise<ArtifactDraftVerificationV2Encoded> {
  const parsed = await decodeValueV2(input);
  const bytes = new TextEncoder().encode(canonicalEvidenceJson(parsed));
  if (bytes.byteLength > MAX_BYTES) fail("ARTIFACT_DRAFT_VERIFICATION_INPUT_INVALID", "verification receipt exceeds the bounded object limit");
  const digest = await evidenceSha256Bytes(bytes);
  const owned = new Uint8Array(bytes.byteLength); owned.set(bytes);
  return { record: parsed, bytes: owned, sha256: digest, verification_receipt_ref: `verification-${digest}` };
}

export async function decodeArtifactDraftVerificationV2(
  bytes: Uint8Array,
  expectedVerificationReceiptRef?: string,
): Promise<ArtifactDraftVerificationV2Encoded> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_BYTES) {
    fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", "verification receipt bytes exceed the bounded object limit");
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (cause) { fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", "verification receipt is not valid UTF-8", cause); }
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch (cause) { fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", "verification receipt is not valid JSON", cause); }
  const parsed = await decodeValueV2(value);
  if (canonicalEvidenceJson(parsed) !== text) fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", "verification receipt is not canonical JSON");
  const digest = await evidenceSha256Bytes(bytes);
  const verificationReceiptRef = `verification-${digest}`;
  if (expectedVerificationReceiptRef !== undefined && expectedVerificationReceiptRef !== verificationReceiptRef) {
    fail("ARTIFACT_DRAFT_VERIFICATION_CORRUPT", "verification receipt reference does not match its bytes");
  }
  const owned = new Uint8Array(bytes.byteLength); owned.set(bytes);
  return { record: parsed, bytes: owned, sha256: digest, verification_receipt_ref: verificationReceiptRef };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export async function decodeArtifactDraftVerificationAny(
  bytes: Uint8Array,
  expectedVerificationReceiptRef?: string,
): Promise<ArtifactDraftVerificationAnyEncoded> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_BYTES) {
    return decodeArtifactDraftVerification(bytes, expectedVerificationReceiptRef);
  }
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text) as unknown;
  } catch {
    return decodeArtifactDraftVerification(bytes, expectedVerificationReceiptRef);
  }
  if (isPlainRecord(value) && value.schema === PROTOCOL_V2) {
    return decodeArtifactDraftVerificationV2(bytes, expectedVerificationReceiptRef);
  }
  return decodeArtifactDraftVerification(bytes, expectedVerificationReceiptRef);
}
