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
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_NOTE_CHARS = 2048;
const MAX_NOTES = 16;
const DIMENSION = z.enum(["PASS", "FAIL", "NOT_APPLICABLE"]);

const SemanticVerifierObservationSchema = z.object({
  schema: z.literal(PROTOCOL),
  verifier_ref: IdentifierSchema,
  verifier_schema_generation: IdentifierSchema,
  claim_ref: VersionedRefSchema,
  claim_text_digest: Sha256Schema,
  value_or_measurement_verification: DIMENSION,
  specification_compliance: DIMENSION,
  method_artifact_alignment: DIMENSION,
  notes: z.array(z.string().min(1).max(MAX_NOTE_CHARS)).max(MAX_NOTES),
}).strict();

export type SemanticVerifierObservation = z.infer<typeof SemanticVerifierObservationSchema>;

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
  return `${ref.id}:${ref.revision}`;
}

function exactRefSet(left: readonly VersionedRef[], right: readonly VersionedRef[]): boolean {
  const leftKeys = left.map(refKey).sort();
  const rightKeys = right.map(refKey).sort();
  return JSON.stringify(leftKeys) === JSON.stringify(rightKeys);
}

function uniqueRefs(refs: readonly VersionedRef[]): boolean {
  return new Set(refs.map(refKey)).size === refs.length;
}

function parseObservation(value: unknown): SemanticVerifierObservation {
  const parsed = SemanticVerifierObservationSchema.safeParse(value);
  if (!parsed.success) fail("SEMANTIC_VERIFIER_OUTPUT_INVALID", "semantic verifier output is invalid", parsed.error);
  return parsed.data;
}

export interface ExpectedSemanticVerifier {
  readonly verifier_ref: string;
  readonly verifier_schema_generation: string;
}

export function decodeSemanticVerifierObservation(
  content: string,
  expected: ExpectedSemanticVerifier,
): SemanticVerifierObservation {
  if (new TextEncoder().encode(content).byteLength > MAX_OUTPUT_BYTES) {
    fail("SEMANTIC_VERIFIER_OUTPUT_INVALID", "semantic verifier output exceeds its byte bound");
  }
  let value: unknown;
  try { value = JSON.parse(content) as unknown; }
  catch (cause) { fail("SEMANTIC_VERIFIER_OUTPUT_INVALID", "semantic verifier output is not JSON", cause); }
  const observation = parseObservation(value);
  if (observation.verifier_ref !== expected.verifier_ref ||
      observation.verifier_schema_generation !== expected.verifier_schema_generation) {
    fail("SEMANTIC_VERIFIER_OUTPUT_BINDING_MISMATCH", "semantic verifier output is bound to another verifier");
  }
  return observation;
}

export interface TrustedSemanticClaimAuditInput {
  readonly claim: MaterialClaim;
  readonly exact_support_handles: readonly EvidenceHandle[];
  readonly counterevidence_handles: readonly EvidenceHandle[];
  /** Computed from independently resolved current source and excerpt bytes. */
  readonly source_satisfies_requirement: boolean;
  readonly supplied_excerpt_supports_requirement: boolean;
  readonly evidence_grade: ClaimAuditItem["evidence_grade"];
  readonly lane: ClaimAuditItem["lane"];
  readonly coverage_limitations: readonly string[];
  readonly unsupported_precision: readonly UnsupportedPrecisionItem[];
  readonly contradiction_detected?: boolean;
}

function validateTrustedInput(input: TrustedSemanticClaimAuditInput): void {
  if (!VersionedRefSchema.safeParse(input.claim.claim_ref).success ||
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
    fail("SEMANTIC_VERIFIER_OUTPUT_BINDING_MISMATCH", "trusted claim audit input is not bound to its exact evidence");
  }
}

function disposition(
  observation: SemanticVerifierObservation | null,
  input: TrustedSemanticClaimAuditInput,
): ClaimAuditItem["disposition"] {
  if (observation === null) return "NOT_VERIFIABLE_IN_SCOPE";
  const dimensions = [
    observation.value_or_measurement_verification,
    observation.specification_compliance,
    observation.method_artifact_alignment,
  ];
  if (input.contradiction_detected === true) return "CONTRADICTED";
  if (!input.source_satisfies_requirement || !input.supplied_excerpt_supports_requirement || input.exact_support_handles.length === 0) return "UNSUPPORTED";
  if (dimensions.includes("FAIL")) return "UNSUPPORTED";
  if (dimensions.every((value) => value === "NOT_APPLICABLE") || input.unsupported_precision.length > 0) return "NOT_VERIFIABLE_IN_SCOPE";
  return "SUPPORTED";
}

export function translateSemanticVerifierObservation(
  observation: SemanticVerifierObservation | null,
  input: TrustedSemanticClaimAuditInput,
): ClaimAuditItem {
  validateTrustedInput(input);
  if (observation !== null &&
      (!sameRef(observation.claim_ref, input.claim.claim_ref) || observation.claim_text_digest !== input.claim.text_digest)) {
    fail("SEMANTIC_VERIFIER_OUTPUT_BINDING_MISMATCH", "semantic verifier output is bound to another claim");
  }
  const result = {
    claim_id: input.claim.claim_ref.id,
    claim_text_digest: input.claim.text_digest,
    claim_kind: input.claim.kind,
    exact_support_handles: [...input.exact_support_handles],
    counterevidence_handles: [...input.counterevidence_handles],
    reference_verification: observation === null ? "NOT_APPLICABLE" : input.exact_support_handles.length > 0 ? "PASS" : "FAIL",
    value_or_measurement_verification: observation?.value_or_measurement_verification ?? "NOT_APPLICABLE",
    specification_compliance: observation?.specification_compliance ?? "NOT_APPLICABLE",
    method_artifact_alignment: observation?.method_artifact_alignment ?? "NOT_APPLICABLE",
    source_satisfies_requirement: input.source_satisfies_requirement,
    supplied_excerpt_supports_requirement: input.supplied_excerpt_supports_requirement,
    independence_and_fidelity_notes: observation?.notes === undefined ? [] : [...observation.notes],
    evidence_grade: input.evidence_grade,
    lane: input.lane,
    coverage_limitations: [...input.coverage_limitations],
    unsupported_precision: [...input.unsupported_precision],
    disposition: disposition(observation, input),
  } satisfies ClaimAuditItem;
  return ClaimAuditItemSchema.parse(result);
}

export const SEMANTIC_VERIFIER_OUTPUT_PROTOCOL = PROTOCOL;
