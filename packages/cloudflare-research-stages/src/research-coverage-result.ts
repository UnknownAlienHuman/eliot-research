import {
  canonicalEvidenceJson,
  citationResolutionReceiptDigestPayload,
  evidenceSha256,
} from "@eliotr/cloudflare-evidence";
import {
  ClaimAuditDispositionSchema,
  CitationResolutionReceiptSchema,
  CoverageReceiptSchema,
  EvidenceGradeSchema,
  IdentifierSchema,
  InquiryLaneSchema,
  Sha256Schema,
  UnsupportedPrecisionItemSchema,
  VersionedRefSchema,
  type CitationResolutionReceipt,
  type CoverageReceipt,
  type VersionedRef,
} from "@eliotr/contracts";
import { validateCoverageReceipt as validateDomainCoverageReceipt } from "@eliotr/domain";
import { fail, MAX_WORKFLOW_RECEIPT_BYTES } from "@eliotr/cloudflare-workflows";
import type {
  ResearchCitationsClaim,
  ResearchCitationsResult,
} from "./research-citations-result.js";
import { z } from "zod";

const PROTOCOL = "eliotr.research.coverage.v2" as const;
const CITATIONS_PROTOCOL = "eliotr.research.citations.v2" as const;
const CITATIONS_STAGE = "RESOLVE_CITATIONS" as const;
const STAGE = "CALCULATE_COVERAGE" as const;
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

/* The Stage15 result carries the complete compact Stage14 semantics forward. */
const CompactCoverageClaimSchema = z.object({
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
  protocol: z.literal("eliotr.research.audit-claims-result.v1"),
  stage_attempt_ref: IdentifierSchema,
  stage_request_sha256: Sha256Schema,
  output_sha256: Sha256Schema,
  synthesis: StageLineageSchema,
  verification: VerificationLineageSchema,
  audit_input_sha256: Sha256Schema,
  normalization_binding_sha256: Sha256Schema,
}).strict();

const StageFifteenLineageSchema = z.object({
  protocol: z.literal(CITATIONS_PROTOCOL),
  operation_id: IdentifierSchema,
  investigation_ref: VersionedRefSchema,
  stage: z.literal(CITATIONS_STAGE),
  stage_attempt_ref: IdentifierSchema,
  stage_request_sha256: Sha256Schema,
  /** SHA-256 of the committed Stage15 output manifest bytes. */
  output_sha256: Sha256Schema,
  citation_resolution_receipt: CitationResolutionReceiptSchema,
}).strict();

const ResearchCoverageResultSchema = z.object({
  protocol: z.literal(PROTOCOL),
  operation_id: IdentifierSchema,
  investigation_ref: VersionedRefSchema,
  stage: z.literal(STAGE),
  stage_attempt_ref: IdentifierSchema,
  stage_request_sha256: Sha256Schema,
  /** Exact compact Stage14 lineage retained by the committed Stage15 result. */
  audit: AuditLineageSchema,
  /** Stage15 request/output identity and its canonical resolver receipt. */
  stage_fifteen: StageFifteenLineageSchema,
  freeze_ref: VersionedRefSchema,
  scope_snapshot_ref: VersionedRefSchema,
  manifest_ref: VersionedRefSchema,
  evidence_pack_ref: VersionedRefSchema,
  claims: z.array(CompactCoverageClaimSchema).min(1).max(MAX_CLAIMS),
  coverage_receipt: CoverageReceiptSchema,
}).strict();

export type ResearchCoverageResult = z.infer<typeof ResearchCoverageResultSchema>;

export interface ResearchCoverageResultInput {
  /** Decoded, committed compact Stage15 result. */
  readonly citations: ResearchCitationsResult;
  /** Stage16's own request identity; the predecessor revision is retained below. */
  readonly operation_id: string;
  readonly investigation_ref: VersionedRef;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  /** SHA-256 from the committed Stage15 workflow output manifest. */
  readonly stage_fifteen_output_sha256: string;
  /** Server-produced coverage receipt; no model text is accepted. */
  readonly coverage_receipt: CoverageReceipt;
}

type ResultErrorCode = "WORKFLOW_INPUT_INVALID" | "WORKFLOW_OUTPUT_CORRUPT";

function failResult(code: ResultErrorCode): never {
  return fail(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function sameRefSet(left: readonly VersionedRef[], right: readonly VersionedRef[]): boolean {
  if (left.length !== right.length) return false;
  const leftKeys = left.map(refKey).sort();
  const rightKeys = right.map(refKey).sort();
  return leftKeys.every((key, index) => key === rightKeys[index]);
}

function uniqueRefs(refs: readonly VersionedRef[]): boolean {
  return new Set(refs.map(refKey)).size === refs.length;
}

function validateCoverageReceiptValue(value: unknown, code: ResultErrorCode): CoverageReceipt {
  const parsed = CoverageReceiptSchema.safeParse(value);
  if (!parsed.success) failResult(code);

  const domainValidation = validateDomainCoverageReceipt(parsed.data);
  if (!domainValidation.ok) failResult(code);

  const sourceLists = [
    parsed.data.eligible_source_refs,
    parsed.data.represented_source_refs,
    parsed.data.cited_source_refs,
    parsed.data.omitted_sources.map((item) => item.source_ref),
  ];
  if (sourceLists.some((refs) => new Set(refs).size !== refs.length)) failResult(code);

  /* Absence is meaningful only when the server proved a complete denominator. */
  if (parsed.data.terminal_disposition === "NO_MATCH_IN_COMPLETE_SCOPE" &&
      parsed.data.denominator_kind !== "complete_scope") {
    failResult(code);
  }
  return parsed.data;
}

function citationRefsFromClaims(
  claims: readonly ResearchCitationsClaim[],
  code: ResultErrorCode,
): readonly VersionedRef[] {
  const parsed = z.array(CompactCoverageClaimSchema).min(1).max(MAX_CLAIMS).safeParse(claims);
  if (!parsed.success) failResult(code);

  const claimRefs = new Set<string>();
  const handles = new Map<string, VersionedRef>();
  for (const claim of parsed.data) {
    const claimRefKey = refKey(claim.claim_ref);
    if (claimRefs.has(claimRefKey)) failResult(code);
    claimRefs.add(claimRefKey);

    const claimHandles = [...claim.support_handle_refs, ...claim.counterevidence_handle_refs];
    if (!uniqueRefs(claimHandles)) failResult(code);
    for (const handle of claimHandles) handles.set(refKey(handle), { ...handle });
  }
  return [...handles.values()];
}

async function validateCitationReceipt(
  receipt: CitationResolutionReceipt,
  expectedRefs: readonly VersionedRef[],
  expectedScope: VersionedRef,
  code: ResultErrorCode,
): Promise<void> {
  if (!sameRef(receipt.scope_snapshot_ref, expectedScope)) failResult(code);

  const resolvedRefs = receipt.resolved.map((item) => item.handle_ref);
  const rejectedRefs = receipt.rejected.map((item) => item.handle_ref);
  const allReceiptRefs = [...resolvedRefs, ...rejectedRefs];
  if (!uniqueRefs(receipt.requested_handle_refs) ||
      !uniqueRefs(allReceiptRefs) ||
      !sameRefSet(receipt.requested_handle_refs, expectedRefs) ||
      !sameRefSet(allReceiptRefs, expectedRefs)) {
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

function cloneClaim(claim: ResearchCitationsClaim): ResearchCitationsClaim {
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

function cloneAudit(audit: ResearchCitationsResult["audit"]): ResearchCitationsResult["audit"] {
  return {
    ...audit,
    synthesis: { ...audit.synthesis },
    verification: { ...audit.verification },
  };
}

function cloneReceipt(receipt: CitationResolutionReceipt): CitationResolutionReceipt {
  return {
    ...receipt,
    receipt_ref: { ...receipt.receipt_ref },
    scope_snapshot_ref: { ...receipt.scope_snapshot_ref },
    requested_handle_refs: receipt.requested_handle_refs.map((ref) => ({ ...ref })),
    resolved: receipt.resolved.map((item) => ({ ...item, handle_ref: { ...item.handle_ref } })),
    rejected: receipt.rejected.map((item) => ({ ...item, handle_ref: { ...item.handle_ref } })),
  };
}

function cloneCoverageReceipt(receipt: CoverageReceipt): CoverageReceipt {
  return {
    ...receipt,
    receipt_ref: { ...receipt.receipt_ref },
    frozen_scope_snapshot_ref: { ...receipt.frozen_scope_snapshot_ref },
    coverage_denominator_ref: { ...receipt.coverage_denominator_ref },
    eligible_source_refs: [...receipt.eligible_source_refs],
    represented_source_refs: [...receipt.represented_source_refs],
    cited_source_refs: [...receipt.cited_source_refs],
    omitted_sources: receipt.omitted_sources.map((item) => ({ ...item })),
    lanes_used: [...receipt.lanes_used],
    stale_or_skipped_lanes: [...receipt.stale_or_skipped_lanes],
    failed_acquisition_refs: [...receipt.failed_acquisition_refs],
    provider_degradation_refs: [...receipt.provider_degradation_refs],
    parser_degradation_refs: [...receipt.parser_degradation_refs],
    redacted_dependency_refs: [...receipt.redacted_dependency_refs],
    budget_limitations: [...receipt.budget_limitations],
  };
}

async function validateResult(value: unknown, code: ResultErrorCode): Promise<ResearchCoverageResult> {
  const parsed = ResearchCoverageResultSchema.safeParse(value);
  if (!parsed.success) failResult(code);
  const result = parsed.data;

  if (result.stage_fifteen.operation_id !== result.operation_id ||
      result.stage_fifteen.investigation_ref.id !== result.investigation_ref.id ||
      result.investigation_ref.revision !== result.stage_fifteen.investigation_ref.revision + 1 ||
      result.stage_fifteen.stage !== CITATIONS_STAGE ||
      result.stage_fifteen.stage_attempt_ref.length < 1 ||
      result.stage_fifteen.stage_request_sha256.length !== 64 ||
      result.stage_fifteen.citation_resolution_receipt.scope_snapshot_ref.id !== result.scope_snapshot_ref.id ||
      result.stage_fifteen.citation_resolution_receipt.scope_snapshot_ref.revision !== result.scope_snapshot_ref.revision ||
      result.audit.normalization_binding_sha256 !== result.audit.verification.normalization_binding_sha256) {
    failResult(code);
  }

  const coverageReceipt = validateCoverageReceiptValue(result.coverage_receipt, code);
  if (!sameRef(coverageReceipt.frozen_scope_snapshot_ref, result.scope_snapshot_ref)) failResult(code);

  const expectedRefs = citationRefsFromClaims(result.claims, code);
  await validateCitationReceipt(
    result.stage_fifteen.citation_resolution_receipt,
    expectedRefs,
    result.scope_snapshot_ref,
    code,
  );
  return result;
}

function resultFromInput(input: ResearchCoverageResultInput): unknown {
  if (!isRecord(input) || !isRecord(input.citations)) failResult("WORKFLOW_INPUT_INVALID");
  const citations = input.citations as ResearchCitationsResult;
  if (input.operation_id !== citations.operation_id) failResult("WORKFLOW_INPUT_INVALID");

  return {
    protocol: PROTOCOL,
    operation_id: input.operation_id,
    investigation_ref: input.investigation_ref,
    stage: STAGE,
    stage_attempt_ref: input.stage_attempt_ref,
    stage_request_sha256: input.stage_request_sha256,
    audit: cloneAudit(citations.audit),
    stage_fifteen: {
      protocol: citations.protocol,
      operation_id: citations.operation_id,
      investigation_ref: { ...citations.investigation_ref },
      stage: citations.stage,
      stage_attempt_ref: citations.stage_attempt_ref,
      stage_request_sha256: citations.stage_request_sha256,
      output_sha256: input.stage_fifteen_output_sha256,
      citation_resolution_receipt: cloneReceipt(citations.citation_resolution_receipt),
    },
    freeze_ref: { ...citations.freeze_ref },
    scope_snapshot_ref: { ...citations.scope_snapshot_ref },
    manifest_ref: { ...citations.manifest_ref },
    evidence_pack_ref: { ...citations.evidence_pack_ref },
    claims: citations.claims.map(cloneClaim),
    coverage_receipt: cloneCoverageReceipt(input.coverage_receipt),
  };
}

/** Encode a private, compact Stage16 result without semantic promotion. */
export async function encodeResearchCoverageResult(
  input: ResearchCoverageResultInput,
): Promise<Uint8Array> {
  let value: unknown;
  try {
    value = resultFromInput(input);
  } catch (error) {
    if (error instanceof Error && "code" in error) throw error;
    failResult("WORKFLOW_INPUT_INVALID");
  }
  const parsed = await validateResult(value, "WORKFLOW_INPUT_INVALID");
  let text: string;
  try {
    text = canonicalEvidenceJson(parsed);
  } catch {
    failResult("WORKFLOW_INPUT_INVALID");
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > MAX_WORKFLOW_RECEIPT_BYTES) failResult("WORKFLOW_INPUT_INVALID");
  return bytes;
}

/** Decode only canonical, strict, handle-only v2 coverage results. */
export async function decodeResearchCoverageResult(bytes: Uint8Array): Promise<ResearchCoverageResult> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_WORKFLOW_RECEIPT_BYTES) {
    failResult("WORKFLOW_OUTPUT_CORRUPT");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
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
  try {
    if (canonicalEvidenceJson(parsed) !== text) failResult("WORKFLOW_OUTPUT_CORRUPT");
  } catch {
    failResult("WORKFLOW_OUTPUT_CORRUPT");
  }
  return parsed;
}
