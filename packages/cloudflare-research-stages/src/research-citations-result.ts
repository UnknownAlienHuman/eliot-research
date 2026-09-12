import {
  canonicalEvidenceJson,
  citationResolutionReceiptDigestPayload,
  evidenceSha256,
} from "@eliotr/cloudflare-evidence";
import {
  ClaimAuditDispositionSchema,
  CitationResolutionReceiptSchema,
  EvidenceGradeSchema,
  IdentifierSchema,
  InquiryLaneSchema,
  Sha256Schema,
  UnsupportedPrecisionItemSchema,
  VersionedRefSchema,
  type CitationResolutionReceipt,
  type VersionedRef,
} from "@eliotr/contracts";
import { fail, MAX_WORKFLOW_RECEIPT_BYTES } from "@eliotr/cloudflare-workflows";
import type {
  ResearchClaimAuditClaim,
  ResearchClaimAuditResult,
} from "./research-claim-audit-result.js";
import { z } from "zod";

const PROTOCOL = "eliotr.research.citations.v2" as const;
const AUDIT_PROTOCOL = "eliotr.research.audit-claims-result.v1" as const;
const STAGE = "RESOLVE_CITATIONS" as const;
const MAX_REFS = 512;
const MAX_CLAIMS = 512;
const MAX_COVERAGE_LIMITATIONS = 32;
const MAX_UNSUPPORTED_PRECISION = 32;
const MAX_SERVER_TEXT_CHARS = 4096;

const ClaimKindSchema = z.enum(["observation", "interpretation", "assumption", "recommendation"]);
const VerificationDimensionSchema = z.enum(["PASS", "FAIL", "NOT_APPLICABLE"]);
const BoundedServerTextSchema = z.string().max(MAX_SERVER_TEXT_CHARS);
const BoundedUnsupportedPrecisionItemSchema = UnsupportedPrecisionItemSchema.extend({
  asserted_reference_or_coordinate: BoundedServerTextSchema,
  highest_supported_precision: BoundedServerTextSchema,
  source_and_coverage_basis: z.array(IdentifierSchema).max(MAX_REFS),
  risk_of_false_precision: BoundedServerTextSchema,
  required_probe_or_narrower_wording: BoundedServerTextSchema,
}).strict();

/** Stage14 semantics are copied as refs and dimensions only; no raw text or EvidenceHandle objects cross W2. */
const CompactCitationClaimSchema = z.object({
  claim_ref: VersionedRefSchema,
  claim_text_digest: Sha256Schema,
  claim_kind: ClaimKindSchema,
  support_handle_refs: z.array(VersionedRefSchema).max(MAX_REFS),
  counterevidence_handle_refs: z.array(VersionedRefSchema).max(MAX_REFS),
  reference_verification: VerificationDimensionSchema,
  value_or_measurement_verification: VerificationDimensionSchema,
  specification_compliance: VerificationDimensionSchema,
  method_artifact_alignment: VerificationDimensionSchema,
  source_satisfies_requirement: z.boolean(),
  supplied_excerpt_supports_requirement: z.boolean(),
  evidence_grade: EvidenceGradeSchema,
  lane: InquiryLaneSchema,
  coverage_limitations: z.array(BoundedServerTextSchema).max(MAX_COVERAGE_LIMITATIONS),
  unsupported_precision: z.array(BoundedUnsupportedPrecisionItemSchema).max(MAX_UNSUPPORTED_PRECISION),
  disposition: ClaimAuditDispositionSchema,
}).strict();

const StageLineageSchema = z.object({
  stage_attempt_ref: IdentifierSchema,
  stage_request_sha256: Sha256Schema,
  output_sha256: Sha256Schema,
}).strict();

const VerificationLineageSchema = StageLineageSchema.extend({
  normalization_binding_sha256: Sha256Schema,
}).strict();

const AuditLineageSchema = z.object({
  protocol: z.literal(AUDIT_PROTOCOL),
  stage_attempt_ref: IdentifierSchema,
  stage_request_sha256: Sha256Schema,
  /** SHA-256 of the committed Stage14 output manifest bytes. */
  output_sha256: Sha256Schema,
  synthesis: StageLineageSchema,
  verification: VerificationLineageSchema,
  audit_input_sha256: Sha256Schema,
  normalization_binding_sha256: Sha256Schema,
}).strict();

const ResearchCitationsResultSchema = z.object({
  protocol: z.literal(PROTOCOL),
  operation_id: IdentifierSchema,
  investigation_ref: VersionedRefSchema,
  stage: z.literal(STAGE),
  stage_attempt_ref: IdentifierSchema,
  stage_request_sha256: Sha256Schema,
  audit: AuditLineageSchema,
  freeze_ref: VersionedRefSchema,
  scope_snapshot_ref: VersionedRefSchema,
  manifest_ref: VersionedRefSchema,
  evidence_pack_ref: VersionedRefSchema,
  claims: z.array(CompactCitationClaimSchema).min(1).max(MAX_CLAIMS),
  citation_resolution_receipt: CitationResolutionReceiptSchema,
}).strict();

export type ResearchCitationsResult = z.infer<typeof ResearchCitationsResultSchema>;
export type ResearchCitationsClaim = ResearchCitationsResult["claims"][number];

export interface ResearchCitationsResultInput {
  /** Decoded, committed compact Stage14 result. */
  readonly audit: ResearchClaimAuditResult;
  /** SHA-256 from the committed Stage14 workflow output manifest. */
  readonly audit_output_sha256: string;
  readonly evidence_pack_ref: VersionedRef;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  /** Durable citation resolver receipt; no resolved excerpt text is accepted. */
  readonly citation_resolution_receipt: CitationResolutionReceipt;
}

type ResultCode = "WORKFLOW_INPUT_INVALID" | "WORKFLOW_OUTPUT_CORRUPT";

function failResult(code: ResultCode): never {
  return fail(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

function compareRefs(left: VersionedRef, right: VersionedRef): number {
  return refKey(left).localeCompare(refKey(right));
}

function uniqueRefs(refs: readonly VersionedRef[]): boolean {
  return new Set(refs.map(refKey)).size === refs.length;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function sameRefSet(left: readonly VersionedRef[], right: readonly VersionedRef[]): boolean {
  if (!uniqueRefs(left) || !uniqueRefs(right) || left.length !== right.length) return false;
  const leftKeys = left.map(refKey).sort();
  const rightKeys = right.map(refKey).sort();
  return leftKeys.every((key, index) => key === rightKeys[index]);
}

function cloneClaim(claim: ResearchClaimAuditClaim): ResearchClaimAuditClaim {
  return {
    ...claim,
    claim_ref: { ...claim.claim_ref },
    support_handle_refs: claim.support_handle_refs.map((ref) => ({ ...ref })),
    counterevidence_handle_refs: claim.counterevidence_handle_refs.map((ref) => ({ ...ref })),
    coverage_limitations: [...claim.coverage_limitations],
    unsupported_precision: claim.unsupported_precision.map((item) => ({
      ...item,
      source_and_coverage_basis: [...item.source_and_coverage_basis],
    })),
  };
}

function citationRefsFromClaims(
  claims: readonly ResearchClaimAuditClaim[],
  code: ResultCode,
): readonly VersionedRef[] {
  const parsed = z.array(CompactCitationClaimSchema).min(1).max(MAX_CLAIMS).safeParse(claims);
  if (!parsed.success) failResult(code);
  const claimRefs = new Set<string>();
  const refs = new Map<string, VersionedRef>();
  for (const claim of parsed.data) {
    const claimKey = refKey(claim.claim_ref);
    if (claimRefs.has(claimKey)) failResult(code);
    claimRefs.add(claimKey);
    const claimEvidenceRefs = [...claim.support_handle_refs, ...claim.counterevidence_handle_refs];
    if (!uniqueRefs(claimEvidenceRefs)) failResult(code);
    for (const ref of claimEvidenceRefs) refs.set(refKey(ref), { ...ref });
  }
  return [...refs.values()].sort(compareRefs);
}

async function validateReceipt(
  receipt: CitationResolutionReceipt,
  expectedRefs: readonly VersionedRef[],
  expectedScope: VersionedRef,
  code: ResultCode,
): Promise<void> {
  if (!sameRef(receipt.scope_snapshot_ref, expectedScope)) failResult(code);
  const resolvedRefs = receipt.resolved.map((item) => item.handle_ref);
  const rejectedRefs = receipt.rejected.map((item) => item.handle_ref);
  if (!sameRefSet(receipt.requested_handle_refs, expectedRefs) ||
      !uniqueRefs([...resolvedRefs, ...rejectedRefs]) ||
      !sameRefSet([...resolvedRefs, ...rejectedRefs], expectedRefs)) {
    failResult(code);
  }
  let expectedDigest: string;
  try {
    expectedDigest = await evidenceSha256(citationResolutionReceiptDigestPayload(receipt));
  } catch {
    failResult(code);
  }
  if (expectedDigest !== receipt.receipt_digest) failResult(code);
}

async function validateResult(value: unknown, code: ResultCode): Promise<ResearchCitationsResult> {
  const parsed = ResearchCitationsResultSchema.safeParse(value);
  if (!parsed.success) failResult(code);
  if (parsed.data.audit.normalization_binding_sha256 !==
      parsed.data.audit.verification.normalization_binding_sha256) {
    failResult(code);
  }
  const expectedRefs = citationRefsFromClaims(parsed.data.claims, code);
  await validateReceipt(parsed.data.citation_resolution_receipt, expectedRefs, parsed.data.scope_snapshot_ref, code);
  return parsed.data;
}

function resultFromInput(input: ResearchCitationsResultInput): unknown {
  if (!isRecord(input) || !isRecord(input.audit)) failResult("WORKFLOW_INPUT_INVALID");
  const audit = input.audit as Partial<ResearchClaimAuditResult>;
  const verification = isRecord(audit.verification) ? audit.verification : undefined;
  return {
    protocol: PROTOCOL,
    operation_id: audit.operation_id,
    investigation_ref: audit.investigation_ref,
    stage: STAGE,
    stage_attempt_ref: input.stage_attempt_ref,
    stage_request_sha256: input.stage_request_sha256,
    audit: {
      protocol: audit.protocol,
      stage_attempt_ref: audit.stage_attempt_ref,
      stage_request_sha256: audit.stage_request_sha256,
      output_sha256: input.audit_output_sha256,
      synthesis: audit.synthesis,
      verification: audit.verification,
      audit_input_sha256: audit.audit_input_sha256,
      normalization_binding_sha256: verification?.["normalization_binding_sha256"],
    },
    freeze_ref: audit.freeze_ref,
    scope_snapshot_ref: audit.scope_snapshot_ref,
    manifest_ref: audit.manifest_ref,
    evidence_pack_ref: input.evidence_pack_ref,
    claims: audit.claims?.map(cloneClaim),
    citation_resolution_receipt: input.citation_resolution_receipt,
  };
}

/** Encode a compact v2 RESOLVE_CITATIONS receipt without semantic promotion. */
export async function encodeResearchCitationsResult(
  input: ResearchCitationsResultInput,
): Promise<Uint8Array> {
  const parsed = await validateResult(resultFromInput(input), "WORKFLOW_INPUT_INVALID");
  const bytes = new TextEncoder().encode(canonicalEvidenceJson(parsed));
  if (bytes.byteLength > MAX_WORKFLOW_RECEIPT_BYTES) failResult("WORKFLOW_INPUT_INVALID");
  return bytes;
}

/** Decode only canonical, strict, handle-only v2 citation results. */
export async function decodeResearchCitationsResult(bytes: Uint8Array): Promise<ResearchCitationsResult> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_WORKFLOW_RECEIPT_BYTES) {
    failResult("WORKFLOW_OUTPUT_CORRUPT");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    failResult("WORKFLOW_OUTPUT_CORRUPT");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    failResult("WORKFLOW_OUTPUT_CORRUPT");
  }
  const parsed = await validateResult(value, "WORKFLOW_OUTPUT_CORRUPT");
  if (canonicalEvidenceJson(parsed) !== text) failResult("WORKFLOW_OUTPUT_CORRUPT");
  return parsed;
}
