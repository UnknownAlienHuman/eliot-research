import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import type { ModelAttemptReadback } from "@eliotr/cloudflare-research";
import {
  ClaimAuditDispositionSchema,
  EvidenceGradeSchema,
  IdentifierSchema,
  InquiryLaneSchema,
  IsoDateTimeSchema,
  Sha256Schema,
  UnsupportedPrecisionItemSchema,
  VersionedRefSchema,
  type VersionedRef,
} from "@eliotr/contracts";
import {
  fail,
  MAX_WORKFLOW_OUTPUT_BYTES,
  MAX_WORKFLOW_RECEIPT_BYTES,
} from "@eliotr/cloudflare-workflows";
import type {
  ResearchClaimAuditInputSnapshot,
} from "./research-claim-audit-input.js";
import { z } from "zod";

const PROTOCOL = "eliotr.research.audit-claims-result.v1" as const;
const INPUT_PROTOCOL = "eliotr.research.audit-claims-input.v1" as const;
const STAGE = "AUDIT_CLAIMS" as const;
const MAX_REFS = 512;
const MAX_CLAIMS = 512;
const MAX_COVERAGE_LIMITATIONS = 32;
const MAX_UNSUPPORTED_PRECISION = 32;
const MAX_SERVER_TEXT_CHARS = 4096;

const ClaimKindSchema = z.enum(["observation", "interpretation", "assumption", "recommendation"]);
const VerificationDimensionSchema = z.enum(["PASS", "FAIL", "NOT_APPLICABLE"]);
const BoundedServerTextSchema = z.string().max(MAX_SERVER_TEXT_CHARS);

/* These fields are server-owned in the audit input. They are bounded here so a
 * compact receipt cannot be enlarged by an untrusted model or caller. */
const BoundedUnsupportedPrecisionItemSchema = UnsupportedPrecisionItemSchema.extend({
  asserted_reference_or_coordinate: BoundedServerTextSchema,
  highest_supported_precision: BoundedServerTextSchema,
  source_and_coverage_basis: z.array(IdentifierSchema).max(MAX_REFS),
  risk_of_false_precision: BoundedServerTextSchema,
  required_probe_or_narrower_wording: BoundedServerTextSchema,
}).strict();

const CompactClaimAuditItemSchema = z.object({
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

const LineageSchema = z.object({
  stage_attempt_ref: IdentifierSchema,
  stage_request_sha256: Sha256Schema,
  output_sha256: Sha256Schema,
}).strict();

const VerificationLineageSchema = z.object({
  stage_attempt_ref: IdentifierSchema,
  stage_request_sha256: Sha256Schema,
  output_sha256: Sha256Schema,
  normalization_binding_sha256: Sha256Schema,
}).strict();

const ModelDeploymentSchema = z.object({
  route_ref: IdentifierSchema,
  route_version: IdentifierSchema,
  prompt_generation: IdentifierSchema,
  schema_generation: IdentifierSchema,
  parameters_digest: Sha256Schema,
  pricing_snapshot_ref: IdentifierSchema,
}).strict();

/* Keep this shape in lockstep with the server-owned Stage14 input authority. */
const VerifierAuthoritySchema = z.object({
  allowed_verifier_refs: z.array(IdentifierSchema).min(1).max(MAX_REFS),
  verifier_ref: IdentifierSchema,
  verifier_schema_generation: IdentifierSchema,
  deployment: ModelDeploymentSchema,
  deployment_generation: IdentifierSchema,
  qualification_receipt_ref: IdentifierSchema,
  qualification_expires_at: IsoDateTimeSchema,
  qualified: z.boolean(),
  current: z.boolean(),
}).strict();

const ModelOutputBindingSchema = z.object({
  output_object_ref: IdentifierSchema,
  output_sha256: Sha256Schema,
  output_size_bytes: z.number().int().nonnegative().max(MAX_WORKFLOW_OUTPUT_BYTES),
  readback_sha256: Sha256Schema,
}).strict();

const ModelAttemptLineageSchema = z.object({
  attempt_id: IdentifierSchema,
  intent_ref: VersionedRefSchema,
  request_sha256: Sha256Schema,
  stage_attempt_ref: IdentifierSchema,
  stage_request_sha256: Sha256Schema,
  workflow_budget_receipt_ref: IdentifierSchema,
  receipt: z.object({
    receipt_ref: IdentifierSchema,
    route_fingerprint_ref: IdentifierSchema,
    output_object_ref: IdentifierSchema,
    output_sha256: Sha256Schema,
  }).strict(),
  operation_receipt_ref: VersionedRefSchema,
  output: ModelOutputBindingSchema,
}).strict();

const ResearchClaimAuditResultSchema = z.object({
  protocol: z.literal(PROTOCOL),
  operation_id: IdentifierSchema,
  investigation_ref: VersionedRefSchema,
  stage: z.literal(STAGE),
  stage_attempt_ref: IdentifierSchema,
  stage_request_sha256: Sha256Schema,
  synthesis: LineageSchema,
  verification: VerificationLineageSchema,
  freeze_ref: VersionedRefSchema,
  scope_snapshot_ref: VersionedRefSchema,
  manifest_ref: VersionedRefSchema,
  audit_input_sha256: Sha256Schema,
  verifier: VerifierAuthoritySchema,
  model_attempt: ModelAttemptLineageSchema,
  claims: z.array(CompactClaimAuditItemSchema).min(1).max(MAX_CLAIMS),
}).strict();

export type ResearchClaimAuditResult = z.infer<typeof ResearchClaimAuditResultSchema>;
export type ResearchClaimAuditClaim = ResearchClaimAuditResult["claims"][number];
export type ResearchClaimAuditUnsupportedPrecisionItem = ResearchClaimAuditClaim["unsupported_precision"][number];
export type ResearchClaimAuditModelAttemptLineage = ResearchClaimAuditResult["model_attempt"];
export type ResearchClaimAuditVerifier = ResearchClaimAuditResult["verifier"];

export type ResearchClaimAuditClaimInput = Omit<
  ResearchClaimAuditClaim,
  "support_handle_refs" | "counterevidence_handle_refs" | "coverage_limitations" | "unsupported_precision"
> & {
  readonly support_handle_refs: readonly VersionedRef[];
  readonly counterevidence_handle_refs: readonly VersionedRef[];
  readonly coverage_limitations: readonly string[];
  readonly unsupported_precision: readonly (Omit<ResearchClaimAuditUnsupportedPrecisionItem, "source_and_coverage_basis"> & {
    readonly source_and_coverage_basis: readonly string[];
  })[];
};

export interface ResearchClaimAuditResultInput {
  /** The server-built, immutable AUDIT_CLAIMS input snapshot. */
  readonly audit_input: ResearchClaimAuditInputSnapshot;
  /** Current W2 identity, supplied by the stage executor. */
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  /** Durable W3 readback for the semantic verifier call. */
  readonly model_attempt: ModelAttemptReadback;
  /** Translator output projected to the compact, handle-only claim shape. */
  readonly claims: readonly ResearchClaimAuditClaimInput[];
}

type ResultErrorCode = "WORKFLOW_INPUT_INVALID" | "WORKFLOW_OUTPUT_CORRUPT";

function failResult(code: ResultErrorCode): never {
  return fail(code);
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function uniqueRefs(refs: readonly VersionedRef[]): boolean {
  return new Set(refs.map(refKey)).size === refs.length;
}

function sameRefSet(left: readonly VersionedRef[], right: readonly VersionedRef[]): boolean {
  if (!uniqueRefs(left) || !uniqueRefs(right) || left.length !== right.length) return false;
  const leftKeys = left.map(refKey).sort();
  const rightKeys = right.map(refKey).sort();
  return leftKeys.every((key, index) => key === rightKeys[index]);
}

function sameRefSequence(left: readonly VersionedRef[], right: readonly VersionedRef[]): boolean {
  return left.length === right.length && left.every((ref, index) => sameRef(ref, right[index]!));
}

function validateVerifierAuthority(
  verifier: ResearchClaimAuditVerifier,
  code: ResultErrorCode,
): void {
  if (new Set(verifier.allowed_verifier_refs).size !== verifier.allowed_verifier_refs.length ||
      !verifier.allowed_verifier_refs.includes(verifier.verifier_ref)) {
    failResult(code);
  }
}

function validateClaimIdentities(
  result: ResearchClaimAuditResult,
  code: ResultErrorCode,
): void {
  const claims = result.claims;
  if (!uniqueRefs(claims.map((claim) => claim.claim_ref))) failResult(code);

  for (const claim of claims) {
    const refs = [...claim.support_handle_refs, ...claim.counterevidence_handle_refs];
    if (!uniqueRefs(refs)) failResult(code);
  }

  const model = result.model_attempt;
  if (model.stage_attempt_ref !== result.stage_attempt_ref ||
      model.stage_request_sha256 !== result.stage_request_sha256 ||
      model.receipt.output_object_ref !== model.output.output_object_ref ||
      model.receipt.output_sha256 !== model.output.output_sha256 ||
      model.output.readback_sha256 !== model.output.output_sha256) {
    failResult(code);
  }
  validateVerifierAuthority(result.verifier, code);
}

function parseResult(value: unknown, code: ResultErrorCode): ResearchClaimAuditResult {
  const parsed = ResearchClaimAuditResultSchema.safeParse(value);
  if (!parsed.success) failResult(code);
  validateClaimIdentities(parsed.data, code);
  return parsed.data;
}

function modelAttemptLineageFromReadback(readback: ModelAttemptReadback): ResearchClaimAuditModelAttemptLineage {
  const receipt = readback?.receipt;
  const operationReceipt = readback?.operation_receipt;
  const output = readback?.output;
  if (readback === null || typeof readback !== "object" ||
      readback.state !== "SUCCEEDED" || readback.persisted_state !== "SUCCEEDED" ||
      receipt === null || operationReceipt === null || output === null ||
      receipt.output_object_ref !== output.output_object_ref ||
      receipt.output_sha256 !== output.output_sha256 ||
      output.readback_sha256 !== output.output_sha256) {
    failResult("WORKFLOW_INPUT_INVALID");
  }

  const lineage = {
    attempt_id: readback.attempt_id,
    intent_ref: readback.intent.intent_ref,
    request_sha256: readback.request_sha256,
    stage_attempt_ref: readback.stage_attempt_ref,
    stage_request_sha256: readback.stage_request_sha256,
    workflow_budget_receipt_ref: readback.workflow_budget_receipt_ref,
    receipt: {
      receipt_ref: receipt.receipt_ref,
      route_fingerprint_ref: receipt.route_fingerprint_ref,
      output_object_ref: receipt.output_object_ref,
      output_sha256: receipt.output_sha256,
    },
    operation_receipt_ref: operationReceipt.receipt_ref,
    output: {
      output_object_ref: output.output_object_ref,
      output_sha256: output.output_sha256,
      output_size_bytes: output.output_size_bytes,
      readback_sha256: output.readback_sha256,
    },
  };
  const parsed = ModelAttemptLineageSchema.safeParse(lineage);
  if (!parsed.success) failResult("WORKFLOW_INPUT_INVALID");
  return parsed.data;
}

function validateAuditInputBindings(input: ResearchClaimAuditResultInput): void {
  const audit = input.audit_input;
  const request = audit?.request;
  const verify = audit?.verify;
  const context = audit?.context;
  if (audit === null || typeof audit !== "object" || request === null || typeof request !== "object" ||
      verify === null || typeof verify !== "object" || context === null || typeof context !== "object" ||
      audit.protocol !== INPUT_PROTOCOL || request.stage !== STAGE || verify.stage !== "VERIFY" ||
      verify.operation_id !== request.operation_id || context.operation_id !== request.operation_id ||
      context.investigation_id !== request.investigation_ref.id ||
      context.current_revision !== request.investigation_ref.revision ||
      audit.synthesis.stage_attempt_ref !== verify.synthesis.stage_attempt_ref ||
      audit.synthesis.stage_request_sha256 !== verify.synthesis.stage_request_sha256 ||
      audit.synthesis.output_sha256 !== verify.synthesis.output_sha256 ||
      !sameRef(verify.freeze_ref, context.freeze.freeze_ref) ||
      !sameRef(verify.scope_snapshot_ref, context.freeze.scope_snapshot_ref) ||
      !sameRef(verify.manifest_ref, context.manifest.manifest_ref) ||
      !Sha256Schema.safeParse(request.input_manifest.sha256).success ||
      !Sha256Schema.safeParse(audit.evidence_input_sha256).success) {
    failResult("WORKFLOW_INPUT_INVALID");
  }
}

function validateNormalizedClaims(input: ResearchClaimAuditResultInput): void {
  const expected = input.audit_input.claims.claims;
  const actual = input.claims;
  if (expected.length !== actual.length || expected.length < 1) failResult("WORKFLOW_INPUT_INVALID");

  const byClaimRef = new Map(actual.map((claim) => [refKey(claim.claim_ref), claim]));
  if (byClaimRef.size !== actual.length) failResult("WORKFLOW_INPUT_INVALID");
  for (const normalized of expected) {
    const claim = byClaimRef.get(refKey(normalized.claim_ref));
    if (claim === undefined || claim.claim_text_digest !== normalized.text_digest ||
        claim.claim_kind !== normalized.kind ||
        !sameRefSequence(claim.support_handle_refs, normalized.support_handle_refs) ||
        !sameRefSequence(claim.counterevidence_handle_refs, normalized.counterevidence_handle_refs)) {
      failResult("WORKFLOW_INPUT_INVALID");
    }
  }

  const cited = new Map<string, VersionedRef>();
  for (const claim of actual) {
    for (const ref of [...claim.support_handle_refs, ...claim.counterevidence_handle_refs]) {
      cited.set(refKey(ref), ref);
    }
  }
  if (!sameRefSet([...cited.values()], input.audit_input.claims.cited_handle_refs)) {
    failResult("WORKFLOW_INPUT_INVALID");
  }
}

function resultFromInput(input: ResearchClaimAuditResultInput): ResearchClaimAuditResult {
  if (input === null || typeof input !== "object") failResult("WORKFLOW_INPUT_INVALID");
  validateAuditInputBindings(input);
  validateNormalizedClaims(input);

  const audit = input.audit_input;
  const request = audit.request;
  const modelAttempt = modelAttemptLineageFromReadback(input.model_attempt);
  if (modelAttempt.stage_attempt_ref !== input.stage_attempt_ref ||
      modelAttempt.stage_request_sha256 !== input.stage_request_sha256) {
    failResult("WORKFLOW_INPUT_INVALID");
  }

  return {
    protocol: PROTOCOL,
    operation_id: request.operation_id,
    investigation_ref: request.investigation_ref,
    stage: STAGE,
    stage_attempt_ref: input.stage_attempt_ref,
    stage_request_sha256: input.stage_request_sha256,
    synthesis: audit.synthesis,
    verification: {
      stage_attempt_ref: audit.verify.stage_attempt_ref,
      stage_request_sha256: audit.verify.stage_request_sha256,
      output_sha256: request.input_manifest.sha256,
      normalization_binding_sha256: audit.verify.normalization.binding_sha256,
    },
    freeze_ref: audit.context.freeze.freeze_ref,
    scope_snapshot_ref: audit.context.freeze.scope_snapshot_ref,
    manifest_ref: audit.context.manifest.manifest_ref,
    audit_input_sha256: audit.evidence_input_sha256,
    verifier: {
      ...audit.verifier,
      allowed_verifier_refs: [...audit.verifier.allowed_verifier_refs],
      deployment: { ...audit.verifier.deployment },
    },
    model_attempt: modelAttempt,
    claims: input.claims.map((claim) => ({
      ...claim,
      support_handle_refs: [...claim.support_handle_refs],
      counterevidence_handle_refs: [...claim.counterevidence_handle_refs],
      coverage_limitations: [...claim.coverage_limitations],
      unsupported_precision: claim.unsupported_precision.map((item) => ({
        ...item,
        source_and_coverage_basis: [...item.source_and_coverage_basis],
      })),
    })),
  };
}

/** Build the compact Stage14 output from server-owned audit input and durable readbacks. */
export function encodeResearchClaimAuditResult(input: ResearchClaimAuditResultInput): Uint8Array {
  let parsed: ResearchClaimAuditResult;
  try {
    parsed = parseResult(resultFromInput(input), "WORKFLOW_INPUT_INVALID");
  } catch (error) {
    if (error instanceof Error && "code" in error) throw error;
    failResult("WORKFLOW_INPUT_INVALID");
  }
  const bytes = new TextEncoder().encode(canonicalEvidenceJson(parsed));
  if (bytes.byteLength > MAX_WORKFLOW_RECEIPT_BYTES) failResult("WORKFLOW_INPUT_INVALID");
  return bytes;
}

/** Decode only the strict canonical, handle-only Stage14 receipt. */
export function decodeResearchClaimAuditResult(bytes: Uint8Array): ResearchClaimAuditResult {
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
  const parsed = parseResult(value, "WORKFLOW_OUTPUT_CORRUPT");
  if (canonicalEvidenceJson(parsed) !== text) failResult("WORKFLOW_OUTPUT_CORRUPT");
  return parsed;
}
