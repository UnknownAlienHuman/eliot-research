import { IdentifierSchema, VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import { z } from "zod";
import type { MaterialClaim } from "./claim-audit.js";

const PROTOCOL = "eliotr.research.synthesis-claims-candidate.v2" as const;
const MAX_SECTION_TEXT_CHARS = 128 * 1024;
const MAX_CLAIM_TEXT_CHARS = 16 * 1024;
const MAX_HANDLES_PER_CLAIM = 512;

const SpanSchema = z.object({
  // Offsets are JavaScript UTF-16 code-unit positions, never UTF-8 byte offsets.
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
}).strict();

const MaterialClaimCandidateSchema = z.object({
  text: z.string().min(1).max(MAX_CLAIM_TEXT_CHARS),
  kind: z.enum(["observation", "interpretation", "assumption", "recommendation"]),
  support_handle_refs: z.array(VersionedRefSchema).max(MAX_HANDLES_PER_CLAIM),
  counterevidence_handle_refs: z.array(VersionedRefSchema).max(MAX_HANDLES_PER_CLAIM),
  span: SpanSchema,
}).strict();

export const SynthesisClaimsCandidateV2Schema = z.object({
  schema: z.literal(PROTOCOL),
  section_text: z.string().min(1).max(MAX_SECTION_TEXT_CHARS),
  material_claims: z.array(MaterialClaimCandidateSchema).min(1).max(MAX_HANDLES_PER_CLAIM),
}).strict();

export type SynthesisClaimsCandidateV2 = z.infer<typeof SynthesisClaimsCandidateV2Schema>;
export type MaterialClaimCandidateV2 = z.infer<typeof MaterialClaimCandidateSchema>;

export type SynthesisClaimsCandidateErrorCode =
  | "SYNTHESIS_CLAIMS_CANDIDATE_INPUT_INVALID"
  | "SYNTHESIS_CLAIMS_CANDIDATE_AUTHORITY_INVALID";

export class SynthesisClaimsCandidateError extends Error {
  public readonly code: SynthesisClaimsCandidateErrorCode;

  public constructor(code: SynthesisClaimsCandidateErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SynthesisClaimsCandidateError";
    this.code = code;
  }
}

function fail(code: SynthesisClaimsCandidateErrorCode, message: string, cause?: unknown): never {
  throw new SynthesisClaimsCandidateError(code, message, cause);
}

function refKey(ref: VersionedRef): string {
  return `${ref.id}:${ref.revision}`;
}

function compareUtf16(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function freezeRef(value: VersionedRef): VersionedRef {
  const parsed = VersionedRefSchema.parse(value);
  return Object.freeze({ id: parsed.id, revision: parsed.revision });
}

function parseCandidate(value: unknown): SynthesisClaimsCandidateV2 {
  const parsed = SynthesisClaimsCandidateV2Schema.safeParse(value);
  if (!parsed.success) fail("SYNTHESIS_CLAIMS_CANDIDATE_INPUT_INVALID", "synthesis claims candidate is invalid", parsed.error);
  return parsed.data;
}

export function decodeSynthesisClaimsCandidateV2(content: string): SynthesisClaimsCandidateV2 {
  let value: unknown;
  try { value = JSON.parse(content) as unknown; }
  catch (error) { return fail("SYNTHESIS_CLAIMS_CANDIDATE_INPUT_INVALID", "synthesis claims candidate is not JSON", error); }
  return parseCandidate(value);
}

export interface SynthesisClaimsNormalizationInput {
  readonly candidate: SynthesisClaimsCandidateV2;
  readonly operation_id: string;
  readonly section_ref: VersionedRef;
  readonly allowed_handle_refs: readonly VersionedRef[];
  /** Server-owned section contract values; the model cannot supply these. */
  readonly required_precision: string;
  readonly required_source_class: string;
}

export interface NormalizedMaterialClaim extends MaterialClaim {
  readonly span: Readonly<{ start: number; end: number }>;
}

export interface NormalizedSynthesisClaims {
  readonly schema: typeof PROTOCOL;
  readonly operation_id: string;
  readonly section_ref: VersionedRef;
  readonly section_text: string;
  readonly claims: readonly NormalizedMaterialClaim[];
  /** Exact sorted union of support and counterevidence refs, derived by the server. */
  readonly cited_handle_refs: readonly VersionedRef[];
}

async function sha256Json(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Utf8(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateTrustedInput(input: SynthesisClaimsNormalizationInput): void {
  if (!IdentifierSchema.safeParse(input.operation_id).success || !VersionedRefSchema.safeParse(input.section_ref).success ||
      input.allowed_handle_refs.some((ref) => !VersionedRefSchema.safeParse(ref).success) ||
      !IdentifierSchema.safeParse(input.required_precision).success || !IdentifierSchema.safeParse(input.required_source_class).success) {
    fail("SYNTHESIS_CLAIMS_CANDIDATE_AUTHORITY_INVALID", "trusted claims normalization input is invalid");
  }
  const allowed = input.allowed_handle_refs.map(refKey);
  if (new Set(allowed).size !== allowed.length) fail("SYNTHESIS_CLAIMS_CANDIDATE_AUTHORITY_INVALID", "trusted allowed handles contain duplicates");
}

export async function normalizeSynthesisClaimsCandidateV2(
  input: SynthesisClaimsNormalizationInput,
): Promise<NormalizedSynthesisClaims> {
  validateTrustedInput(input);
  const candidate = parseCandidate(input.candidate);
  const trusted = Object.freeze({
    operation_id: input.operation_id,
    section_ref: freezeRef(input.section_ref),
    allowed_handle_refs: Object.freeze(input.allowed_handle_refs.map(freezeRef)),
    required_precision: input.required_precision,
    required_source_class: input.required_source_class,
  });
  const allowed = new Set(trusted.allowed_handle_refs.map(refKey));
  const cited = new Map<string, VersionedRef>();
  const claims: NormalizedMaterialClaim[] = [];

  const isSurrogateBoundary = (index: number): boolean => index > 0 && index < candidate.section_text.length &&
    candidate.section_text.charCodeAt(index - 1) >= 0xd800 && candidate.section_text.charCodeAt(index - 1) <= 0xdbff &&
    candidate.section_text.charCodeAt(index) >= 0xdc00 && candidate.section_text.charCodeAt(index) <= 0xdfff;

  for (const [index, material] of candidate.material_claims.entries()) {
    if (material.span.end <= material.span.start || material.span.end > candidate.section_text.length ||
        isSurrogateBoundary(material.span.start) || isSurrogateBoundary(material.span.end) ||
        candidate.section_text.slice(material.span.start, material.span.end) !== material.text) {
      fail("SYNTHESIS_CLAIMS_CANDIDATE_INPUT_INVALID", `material claim ${index} span does not contain its exact text`);
    }
    const refs = [...material.support_handle_refs, ...material.counterevidence_handle_refs];
    const keys = refs.map(refKey);
    if (new Set(keys).size !== keys.length || keys.some((key) => !allowed.has(key))) {
      fail("SYNTHESIS_CLAIMS_CANDIDATE_INPUT_INVALID", `material claim ${index} has duplicate or non-frozen evidence refs`);
    }
    for (const ref of refs) cited.set(refKey(ref), ref);

    const support = Object.freeze([...material.support_handle_refs.map(freezeRef)].sort((left, right) => compareUtf16(refKey(left), refKey(right))));
    const counter = Object.freeze([...material.counterevidence_handle_refs.map(freezeRef)].sort((left, right) => compareUtf16(refKey(left), refKey(right))));
    const textDigest = await sha256Utf8(material.text);
    const claimDigest = await sha256Json({ protocol: PROTOCOL, operation_id: trusted.operation_id, section_ref: trusted.section_ref,
      text: material.text, kind: material.kind, span: material.span, support_handle_refs: support, counterevidence_handle_refs: counter });
    claims.push(Object.freeze({
      claim_ref: Object.freeze({ id: `research-claim:${claimDigest}`, revision: 1 }),
      text: material.text,
      text_digest: textDigest,
      kind: material.kind,
      support_handle_refs: support,
      counterevidence_handle_refs: counter,
      required_precision: trusted.required_precision,
      required_source_class: trusted.required_source_class,
      span: Object.freeze({ ...material.span }),
    }));
  }

  return Object.freeze({ schema: PROTOCOL, operation_id: trusted.operation_id, section_ref: trusted.section_ref,
    section_text: candidate.section_text, claims: Object.freeze(claims), cited_handle_refs: Object.freeze([...cited.values()].map(freezeRef).sort((left, right) => compareUtf16(refKey(left), refKey(right)))) });
}
