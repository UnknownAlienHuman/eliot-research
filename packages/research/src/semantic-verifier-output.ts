import {
  ClaimAuditItemSchema,
  EvidenceHandleSchema,
  IdentifierSchema,
  Sha256Schema,
  UnsupportedPrecisionItemSchema,
  VersionedRefSchema,
  type ClaimAuditItem,
  type EvidenceHandle,
  type UnsupportedPrecisionItem,
  type VersionedRef,
} from "@eliotr/contracts";
import { z } from "zod";
import type { MaterialClaim } from "./claim-audit.js";

const PROTOCOL = "eliotr.research.semantic-verifier-observation.v1" as const;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_NOTE_CHARS = 2048;
const MAX_NOTES = 16;
const MAX_CLAIMS = 512;
const DIMENSION = z.enum(["PASS", "FAIL", "NOT_APPLICABLE"]);

export const SemanticVerifierObservationSchema = z.object({
  claim_ref: VersionedRefSchema,
  claim_text_digest: Sha256Schema,
  value_or_measurement_verification: DIMENSION,
  specification_compliance: DIMENSION,
  method_artifact_alignment: DIMENSION,
  source_satisfies_requirement: DIMENSION,
  supplied_excerpt_supports_requirement: DIMENSION,
  contradiction_observed: z.boolean(),
  unsupported_precision_observed: z.boolean(),
  notes: z.array(z.string().min(1).max(MAX_NOTE_CHARS)).max(MAX_NOTES),
}).strict();

export type SemanticVerifierObservation = z.infer<typeof SemanticVerifierObservationSchema>;

export const SemanticVerifierBatchSchema = z.object({
  schema: z.literal(PROTOCOL),
  verifier_ref: IdentifierSchema,
  verifier_schema_generation: IdentifierSchema,
  evidence_input_sha256: Sha256Schema,
  claims: z.array(SemanticVerifierObservationSchema).min(1).max(MAX_CLAIMS),
}).strict();

export type SemanticVerifierBatch = z.infer<typeof SemanticVerifierBatchSchema>;

export type SemanticVerifierOutputErrorCode =
  | "SEMANTIC_VERIFIER_OUTPUT_INVALID"
  | "SEMANTIC_VERIFIER_OUTPUT_BINDING_MISMATCH";

export class SemanticVerifierOutputError extends Error {
  public readonly code: SemanticVerifierOutputErrorCode;

  public constructor(code: SemanticVerifierOutputErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SemanticVerifierOutputError";
    this.code = code;
  }
}

function fail(code: SemanticVerifierOutputErrorCode, message: string, cause?: unknown): never {
  throw new SemanticVerifierOutputError(code, message, cause);
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function refKey(ref: VersionedRef): string {
  return ref.id + ":" + ref.revision;
}

function exactRefSet(left: readonly VersionedRef[], right: readonly VersionedRef[]): boolean {
  const leftKeys = left.map(refKey).sort();
  const rightKeys = right.map(refKey).sort();
  return JSON.stringify(leftKeys) === JSON.stringify(rightKeys);
}

function uniqueRefs(refs: readonly VersionedRef[]): boolean {
  return new Set(refs.map(refKey)).size === refs.length;
}

function exactClaimSet(left: readonly SemanticVerifierObservation[], right: readonly MaterialClaim[]): boolean {
  if (left.length !== right.length) return false;
  if (new Set(left.map((observation) => refKey(observation.claim_ref))).size !== left.length) return false;
  const expected = new Map(right.map((claim) => [refKey(claim.claim_ref), claim.text_digest]));
  if (expected.size !== right.length) return false;
  return left.every((observation) => expected.get(refKey(observation.claim_ref)) === observation.claim_text_digest);
}

function parseBatch(value: unknown): SemanticVerifierBatch {
  const parsed = SemanticVerifierBatchSchema.safeParse(value);
  if (!parsed.success) fail("SEMANTIC_VERIFIER_OUTPUT_INVALID", "semantic verifier batch is invalid", parsed.error);
  return parsed.data;
}

export interface ExpectedSemanticVerifier {
  readonly verifier_ref: string;
  readonly verifier_schema_generation: string;
  readonly evidence_input_sha256: string;
  readonly claims: readonly MaterialClaim[];
}

export function decodeSemanticVerifierBatch(
  content: string,
  expected: ExpectedSemanticVerifier,
): SemanticVerifierBatch {
  if (new TextEncoder().encode(content).byteLength > MAX_OUTPUT_BYTES) {
    fail("SEMANTIC_VERIFIER_OUTPUT_INVALID", "semantic verifier batch exceeds its byte bound");
  }
  let value: unknown;
  try { value = JSON.parse(content) as unknown; }
  catch (cause) { fail("SEMANTIC_VERIFIER_OUTPUT_INVALID", "semantic verifier batch is not JSON", cause); }
  const batch = parseBatch(value);
  if (batch.verifier_ref !== expected.verifier_ref ||
      batch.verifier_schema_generation !== expected.verifier_schema_generation ||
      batch.evidence_input_sha256 !== expected.evidence_input_sha256 ||
      !exactClaimSet(batch.claims, expected.claims)) {
    fail("SEMANTIC_VERIFIER_OUTPUT_BINDING_MISMATCH", "semantic verifier batch is bound to another verifier or claim set");
  }
  return batch;
}

export type SemanticAuditDimension =
  | "value_or_measurement_verification"
  | "specification_compliance"
  | "method_artifact_alignment";

export interface TrustedSemanticClaimAuditInput {
  readonly claim: MaterialClaim;
  readonly exact_support_handles: readonly EvidenceHandle[];
  readonly counterevidence_handles: readonly EvidenceHandle[];
  /** Current scope/grant/owner/R2 resolution fact; it is not semantic support. */
  readonly reference_resolution_verified: boolean;
  /** Server-owned qualification for this verifier invocation. */
  readonly semantic_verifier_qualified: boolean;
  /** Required semantic dimensions; the model cannot waive one with NOT_APPLICABLE. */
  readonly required_dimensions: readonly SemanticAuditDimension[];
  readonly source_requirement_applicable: boolean;
  readonly excerpt_requirement_applicable: boolean;
  readonly evidence_grade: ClaimAuditItem["evidence_grade"];
  readonly lane: ClaimAuditItem["lane"];
  readonly coverage_limitations: readonly string[];
  readonly unsupported_precision: readonly UnsupportedPrecisionItem[];
}

function validateTrustedInput(input: TrustedSemanticClaimAuditInput): void {
  const required = new Set(input.required_dimensions);
  const validDimensions: readonly string[] = [
    "value_or_measurement_verification",
    "specification_compliance",
    "method_artifact_alignment",
  ];
  if (required.size !== input.required_dimensions.length ||
      input.required_dimensions.some((dimension) => !validDimensions.includes(dimension)) ||
      !VersionedRefSchema.safeParse(input.claim.claim_ref).success ||
      !Sha256Schema.safeParse(input.claim.text_digest).success ||
      input.exact_support_handles.some((handle) => !EvidenceHandleSchema.safeParse(handle).success) ||
      input.counterevidence_handles.some((handle) => !EvidenceHandleSchema.safeParse(handle).success) ||
      input.exact_support_handles.some((handle) => handle.terminal_state !== "LIVE") ||
      input.counterevidence_handles.some((handle) => handle.terminal_state !== "LIVE") ||
      !uniqueRefs(input.claim.support_handle_refs) || !uniqueRefs(input.claim.counterevidence_handle_refs) ||
      !uniqueRefs(input.exact_support_handles.map((handle) => handle.handle_ref)) ||
      !uniqueRefs(input.counterevidence_handles.map((handle) => handle.handle_ref)) ||
      !exactRefSet(input.exact_support_handles.map((handle) => handle.handle_ref), input.claim.support_handle_refs) ||
      !exactRefSet(input.counterevidence_handles.map((handle) => handle.handle_ref), input.claim.counterevidence_handle_refs) ||
      input.coverage_limitations.some((value) => typeof value !== "string" || value.length === 0) ||
      input.unsupported_precision.some((value) => !UnsupportedPrecisionItemSchema.safeParse(value).success)) {
    fail("SEMANTIC_VERIFIER_OUTPUT_BINDING_MISMATCH", "trusted claim audit input is not bound to its exact evidence and policy");
  }
}

function dimensionStatus(
  observation: SemanticVerifierObservation | null,
  field: "value_or_measurement_verification" | "specification_compliance" | "method_artifact_alignment",
  required: boolean,
): "PASS" | "FAIL" | "NOT_APPLICABLE" {
  return observation === null || !required ? "NOT_APPLICABLE" : observation[field];
}

function disposition(
  observation: SemanticVerifierObservation | null,
  input: TrustedSemanticClaimAuditInput,
): ClaimAuditItem["disposition"] {
  if (observation === null || !input.semantic_verifier_qualified || !input.reference_resolution_verified) {
    return "NOT_VERIFIABLE_IN_SCOPE";
  }
  const statuses = [
    ...input.required_dimensions.map((dimension) => dimensionStatus(observation, dimension, true)),
    ...(input.source_requirement_applicable ? [observation.source_satisfies_requirement] : []),
    ...(input.excerpt_requirement_applicable ? [observation.supplied_excerpt_supports_requirement] : []),
  ];
  if (observation.unsupported_precision_observed || input.unsupported_precision.length > 0) return "NOT_VERIFIABLE_IN_SCOPE";
  if (observation.contradiction_observed) {
    return input.counterevidence_handles.length > 0 ? "CONTRADICTED" : "NOT_VERIFIABLE_IN_SCOPE";
  }
  if (statuses.length === 0 || statuses.some((status) => status === "NOT_APPLICABLE")) return "NOT_VERIFIABLE_IN_SCOPE";
  if (statuses.some((status) => status === "FAIL")) return "UNSUPPORTED";
  if (input.exact_support_handles.length === 0) return "UNSUPPORTED";
  return "SUPPORTED";
}

function observationFor(
  batch: SemanticVerifierBatch | null,
  claim: MaterialClaim,
): SemanticVerifierObservation | null {
  return batch?.claims.find((observation) => sameRef(observation.claim_ref, claim.claim_ref)) ?? null;
}

export function translateSemanticVerifierBatch(
  batch: SemanticVerifierBatch | null,
  inputs: readonly TrustedSemanticClaimAuditInput[],
): readonly ClaimAuditItem[] {
  if (inputs.length === 0 || inputs.length > MAX_CLAIMS) {
    fail("SEMANTIC_VERIFIER_OUTPUT_BINDING_MISMATCH", "semantic verifier claim batch size is invalid");
  }
  const expectedClaims = inputs.map((input) => input.claim);
  if (new Set(expectedClaims.map((claim) => refKey(claim.claim_ref))).size !== expectedClaims.length) {
    fail("SEMANTIC_VERIFIER_OUTPUT_BINDING_MISMATCH", "trusted semantic verifier claims are duplicated");
  }
  inputs.forEach(validateTrustedInput);
  if (batch !== null && !exactClaimSet(batch.claims, expectedClaims)) {
    fail("SEMANTIC_VERIFIER_OUTPUT_BINDING_MISMATCH", "semantic verifier batch does not cover the trusted claims");
  }
  return inputs.map((input) => {
    const observation = observationFor(batch, input.claim);
    const usableObservation = input.semantic_verifier_qualified ? observation : null;
    const required = new Set(input.required_dimensions);
    const valueStatus = dimensionStatus(usableObservation, "value_or_measurement_verification", required.has("value_or_measurement_verification"));
    const specificationStatus = dimensionStatus(usableObservation, "specification_compliance", required.has("specification_compliance"));
    const methodStatus = dimensionStatus(usableObservation, "method_artifact_alignment", required.has("method_artifact_alignment"));
    const sourceStatus = usableObservation === null || !input.source_requirement_applicable ? "NOT_APPLICABLE" : usableObservation.source_satisfies_requirement;
    const excerptStatus = usableObservation === null || !input.excerpt_requirement_applicable ? "NOT_APPLICABLE" : usableObservation.supplied_excerpt_supports_requirement;
    const result = {
      claim_id: input.claim.claim_ref.id,
      claim_text_digest: input.claim.text_digest,
      claim_kind: input.claim.kind,
      exact_support_handles: [...input.exact_support_handles],
      counterevidence_handles: [...input.counterevidence_handles],
      reference_verification: !input.reference_resolution_verified ? "NOT_APPLICABLE" : input.exact_support_handles.length > 0 ? "PASS" : "FAIL",
      value_or_measurement_verification: valueStatus,
      specification_compliance: specificationStatus,
      method_artifact_alignment: methodStatus,
      source_satisfies_requirement: input.source_requirement_applicable ? sourceStatus === "PASS" : true,
      supplied_excerpt_supports_requirement: input.excerpt_requirement_applicable ? excerptStatus === "PASS" : true,
      independence_and_fidelity_notes: usableObservation?.notes === undefined ? [] : [...usableObservation.notes],
      evidence_grade: input.evidence_grade,
      lane: input.lane,
      coverage_limitations: [...input.coverage_limitations],
      unsupported_precision: [...input.unsupported_precision],
      disposition: disposition(usableObservation, input),
    } satisfies ClaimAuditItem;
    return ClaimAuditItemSchema.parse(result);
  });
}

export const SEMANTIC_VERIFIER_OUTPUT_PROTOCOL = PROTOCOL;
export const SEMANTIC_VERIFIER_MAX_CLAIMS = MAX_CLAIMS;
