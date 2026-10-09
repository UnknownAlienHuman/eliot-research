import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, Sha256Schema, VersionedRefSchema, type VersionedRef } from "./common.js";
import { EvidenceAnchorSchema } from "./evidence.js";
import { serializeCanonicalContractJson } from "./schema-registry.js";

export const RESEARCH_RELATION_CANDIDATE_PROTOCOL = "eliotr.research.relation-candidate.v1" as const;

// Reuse the per-query evidence-byte ceiling and finding-context/source-ref bounds already in
// research-branch-query.ts and research-branch-finding.ts. R04 defines no separate relation budget.
const MAX_CANDIDATE_FACT_TEXT_BYTES = 64 * 1024;
const MAX_CONTEXT_TEXT_LENGTH = 1_024;
const MAX_CONTEXT_ITEMS = 32;
const MAX_CONTEXT_SOURCE_REFS = 64;
const MAX_SOURCE_REFS_PER_FACT = 64;

const SourceFactTextSchema = z.string().min(1).max(MAX_CANDIDATE_FACT_TEXT_BYTES)
  .refine((value) => value.isWellFormed(), "fact text must be well-formed Unicode");

const CanonicalContextTextSchema = z.string().min(1).max(MAX_CONTEXT_TEXT_LENGTH)
  .refine((value) => value === value.trim() && value.trim().length > 0,
    "known context text must be nonblank and have no outer whitespace");

const CanonicalConditionSetSchema = z.array(CanonicalContextTextSchema).min(1).max(MAX_CONTEXT_ITEMS)
  .superRefine((values, context) => {
    for (let index = 1; index < values.length; index += 1) {
      const previous = values[index - 1];
      const current = values[index];
      if (previous !== undefined && current !== undefined && previous >= current) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "condition descriptors must be unique and in ascending code-unit order",
        });
      }
    }
  });

const SourceEvidenceRefsSchema = z.array(VersionedRefSchema).min(1).max(MAX_CONTEXT_SOURCE_REFS)
  .superRefine((refs, context) => {
    const keys = refs.map((ref) => `${ref.id}:${ref.revision}`);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: "custom", message: "source evidence refs contain duplicates" });
    }
  });

const SourceSpanRefSchema = z.object({
  evidence_handle_ref: VersionedRefSchema,
  source_revision_ref: IdentifierSchema,
  anchor: EvidenceAnchorSchema,
}).strict();

const SourceBoundTextSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("KNOWN"),
    value: CanonicalContextTextSchema,
    source_refs: SourceEvidenceRefsSchema,
  }).strict(),
  z.object({ state: z.literal("UNKNOWN") }).strict(),
]);

const SourceBoundConditionsSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("KNOWN"),
    values: CanonicalConditionSetSchema,
    source_refs: SourceEvidenceRefsSchema,
  }).strict(),
  z.object({ state: z.literal("UNKNOWN") }).strict(),
]);

const SourceBoundPolaritySchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("KNOWN"),
    value: z.enum(["AFFIRMATIVE", "NEGATIVE", "NON_DIRECTIONAL"]),
    source_refs: SourceEvidenceRefsSchema,
  }).strict(),
  z.object({ state: z.literal("UNKNOWN") }).strict(),
]);

const SourceBoundIntervalSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("KNOWN"),
    start_at: IsoDateTimeSchema,
    /** Inclusive end; omission denotes an open-ended interval. Equal endpoints denote a point. */
    end_at: IsoDateTimeSchema.optional(),
    source_refs: SourceEvidenceRefsSchema,
  }).strict().superRefine((value, context) => {
    if (value.end_at !== undefined && Date.parse(value.end_at) < Date.parse(value.start_at)) {
      context.addIssue({ code: "custom", path: ["end_at"], message: "interval end precedes start" });
    }
  }),
  z.object({ state: z.literal("UNKNOWN") }).strict(),
]);

const RelationFactContextSchema = z.object({
  units: SourceBoundTextSchema,
  population: SourceBoundTextSchema,
  conditions: SourceBoundConditionsSchema,
  polarity: SourceBoundPolaritySchema,
  observed_interval: SourceBoundIntervalSchema,
  validity_interval: SourceBoundIntervalSchema,
}).strict();

function getContextSourceRefs(
  value: { readonly state: "KNOWN"; readonly source_refs: readonly VersionedRef[] } | { readonly state: "UNKNOWN" },
): readonly VersionedRef[] {
  return value.state === "KNOWN" ? value.source_refs : [];
}

export const ResearchRelationFactSchema = z.object({
  /** Exact source text; consumers must preserve it byte-for-byte and verify it against the span. */
  fact_text: SourceFactTextSchema,
  fact_text_sha256: Sha256Schema,
  source_span_ref: SourceSpanRefSchema,
  context: RelationFactContextSchema,
}).strict().superRefine((value, context) => {
  if (new TextEncoder().encode(value.fact_text).byteLength > MAX_CANDIDATE_FACT_TEXT_BYTES) {
    context.addIssue({ code: "custom", path: ["fact_text"], message: "fact text exceeds the source evidence byte bound" });
  }
  const sourceRefs = [
    value.source_span_ref.evidence_handle_ref,
    ...getContextSourceRefs(value.context.units),
    ...getContextSourceRefs(value.context.population),
    ...getContextSourceRefs(value.context.conditions),
    ...getContextSourceRefs(value.context.polarity),
    ...getContextSourceRefs(value.context.observed_interval),
    ...getContextSourceRefs(value.context.validity_interval),
  ];
  if (sourceRefs.length > MAX_SOURCE_REFS_PER_FACT) {
    context.addIssue({ code: "custom", path: ["context"], message: "fact context exceeds the existing evidence-ref bound" });
  }
});
export type ResearchRelationFact = z.infer<typeof ResearchRelationFactSchema>;

export const ResearchRelationTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("QUESTION"),
    question_ref: VersionedRefSchema,
    question_sha256: Sha256Schema,
  }).strict(),
  // Reuse ClaimAuditItemSchema's identity pair; this does not resolve or verify the claim.
  z.object({
    kind: z.literal("CLAIM"),
    claim_id: IdentifierSchema,
    claim_text_digest: Sha256Schema,
  }).strict(),
  z.object({
    kind: z.literal("HYPOTHESIS"),
    planning_manifest_ref: VersionedRefSchema,
    planning_manifest_digest: Sha256Schema,
    hypothesis_id: IdentifierSchema,
  }).strict(),
]);
export type ResearchRelationTarget = z.infer<typeof ResearchRelationTargetSchema>;

const RelationComparisonSchema = z.enum(["MATCH", "DIFFERENT", "UNKNOWN"]);

export const ResearchRelationAssessmentSchema = z.object({
  units: RelationComparisonSchema,
  population: RelationComparisonSchema,
  conditions: RelationComparisonSchema,
  polarity: RelationComparisonSchema,
  observed_time: RelationComparisonSchema,
  validity_time: RelationComparisonSchema,
}).strict();
export type ResearchRelationAssessment = z.infer<typeof ResearchRelationAssessmentSchema>;

function intervalOverlaps(
  left: Extract<z.infer<typeof SourceBoundIntervalSchema>, { state: "KNOWN" }>,
  right: Extract<z.infer<typeof SourceBoundIntervalSchema>, { state: "KNOWN" }>,
): boolean {
  const leftStart = Date.parse(left.start_at);
  const rightStart = Date.parse(right.start_at);
  const leftEnd = left.end_at === undefined ? Number.POSITIVE_INFINITY : Date.parse(left.end_at);
  const rightEnd = right.end_at === undefined ? Number.POSITIVE_INFINITY : Date.parse(right.end_at);
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function intervalAssessment(
  left: z.infer<typeof SourceBoundIntervalSchema>,
  right: z.infer<typeof SourceBoundIntervalSchema>,
): ResearchRelationAssessment["validity_time"] {
  if (left.state !== "KNOWN" || right.state !== "KNOWN") return "UNKNOWN";
  return intervalOverlaps(left, right) ? "MATCH" : "DIFFERENT";
}

function polarityAssessment(
  left: z.infer<typeof SourceBoundPolaritySchema>,
  right: z.infer<typeof SourceBoundPolaritySchema>,
): ResearchRelationAssessment["polarity"] {
  if (left.state !== "KNOWN" || right.state !== "KNOWN") return "UNKNOWN";
  return left.value === right.value ? "MATCH" : "DIFFERENT";
}

function textContextAssessment(
  left: z.infer<typeof SourceBoundTextSchema>,
  right: z.infer<typeof SourceBoundTextSchema>,
): ResearchRelationAssessment["units"] {
  if (left.state !== "KNOWN" || right.state !== "KNOWN") return "UNKNOWN";
  return left.value === right.value ? "MATCH" : "DIFFERENT";
}

function conditionsAssessment(
  left: z.infer<typeof SourceBoundConditionsSchema>,
  right: z.infer<typeof SourceBoundConditionsSchema>,
): ResearchRelationAssessment["conditions"] {
  if (left.state !== "KNOWN" || right.state !== "KNOWN") return "UNKNOWN";
  return left.values.length === right.values.length &&
      left.values.every((value, index) => value === right.values[index])
    ? "MATCH"
    : "DIFFERENT";
}

function sourceSpanKey(fact: ResearchRelationFact): string {
  return JSON.stringify([fact.source_span_ref.source_revision_ref, fact.source_span_ref.anchor]);
}

/** Structural candidate shape only; evidence, span, target and context refs require owner resolution. */
export const ResearchRelationCandidateSchema = z.object({
  protocol: z.literal(RESEARCH_RELATION_CANDIDATE_PROTOCOL),
  candidate_ref: VersionedRefSchema,
  identity_digest: Sha256Schema,
  target: ResearchRelationTargetSchema,
  relation_kind: z.enum(["CONTRADICTS", "QUALIFIES", "ALTERNATIVE_EXPLANATION"]),
  left: ResearchRelationFactSchema,
  right: ResearchRelationFactSchema,
  assessment: ResearchRelationAssessmentSchema,
}).strict().superRefine((value, context) => {
  if (value.candidate_ref.id !== `eliotr.research.relation-candidate-${value.identity_digest}` ||
      value.candidate_ref.revision !== 1) {
    context.addIssue({ code: "custom", path: ["candidate_ref"], message: "relation candidate identity mismatch" });
  }
  if (value.target.kind === "QUESTION" && value.target.question_ref.revision !== 1) {
    context.addIssue({ code: "custom", path: ["target", "question_ref"], message: "question target revision is unsupported" });
  }
  if (sourceSpanKey(value.left) === sourceSpanKey(value.right)) {
    context.addIssue({ code: "custom", path: ["right", "source_span_ref"], message: "relation facts must use distinct source spans" });
  }
  if (new TextEncoder().encode(value.left.fact_text).byteLength + new TextEncoder().encode(value.right.fact_text).byteLength >
      MAX_CANDIDATE_FACT_TEXT_BYTES) {
    context.addIssue({ code: "custom", path: ["right", "fact_text"], message: "candidate fact text exceeds the existing per-query evidence byte bound" });
  }

  const contextComparisons: Array<{
    readonly field: "units" | "population" | "conditions";
    readonly assessment: ResearchRelationAssessment["units"];
  }> = [
    {
      field: "units",
      assessment: textContextAssessment(value.left.context.units, value.right.context.units),
    },
    {
      field: "population",
      assessment: textContextAssessment(value.left.context.population, value.right.context.population),
    },
    {
      field: "conditions",
      assessment: conditionsAssessment(value.left.context.conditions, value.right.context.conditions),
    },
  ];
  for (const item of contextComparisons) {
    if (value.assessment[item.field] !== item.assessment) {
      context.addIssue({ code: "custom", path: ["assessment", item.field], message: "context assessment must match exact source-bound values" });
    }
  }

  if (value.assessment.polarity !== polarityAssessment(value.left.context.polarity, value.right.context.polarity)) {
    context.addIssue({ code: "custom", path: ["assessment", "polarity"], message: "polarity assessment does not match source-bound polarity" });
  }
  if (value.assessment.observed_time !== intervalAssessment(value.left.context.observed_interval, value.right.context.observed_interval)) {
    context.addIssue({ code: "custom", path: ["assessment", "observed_time"], message: "observed-time assessment does not match source-bound intervals" });
  }
  if (value.assessment.validity_time !== intervalAssessment(value.left.context.validity_interval, value.right.context.validity_interval)) {
    context.addIssue({ code: "custom", path: ["assessment", "validity_time"], message: "validity-time assessment does not match source-bound intervals" });
  }

  if (value.relation_kind === "CONTRADICTS" && (
    value.assessment.units !== "MATCH" ||
    value.assessment.population !== "MATCH" ||
    value.assessment.conditions !== "MATCH" ||
    value.assessment.polarity !== "DIFFERENT" ||
    value.assessment.validity_time !== "MATCH" ||
    value.left.context.polarity.state !== "KNOWN" ||
    value.right.context.polarity.state !== "KNOWN" ||
    value.left.context.polarity.value === value.right.context.polarity.value ||
    value.left.context.polarity.value === "NON_DIRECTIONAL" ||
    value.right.context.polarity.value === "NON_DIRECTIONAL" ||
    value.left.context.observed_interval.state !== "KNOWN" ||
    value.right.context.observed_interval.state !== "KNOWN" ||
    value.left.context.validity_interval.state !== "KNOWN" ||
    value.right.context.validity_interval.state !== "KNOWN" ||
    !intervalOverlaps(value.left.context.validity_interval, value.right.context.validity_interval)
  )) {
    context.addIssue({ code: "custom", path: ["relation_kind"], message: "contradiction requires source-backed comparability, opposite polarity, and overlapping validity" });
  }
});
export type ResearchRelationCandidate = z.infer<typeof ResearchRelationCandidateSchema>;

export type ResearchRelationCandidateIdentity = Omit<ResearchRelationCandidate, "candidate_ref" | "identity_digest">;

export interface ResearchRelationCandidateIdentityVerification {
  readonly candidate_schema_valid: boolean;
  readonly fact_text_digests_match: boolean;
  readonly canonical_identity_matches: boolean;
  /** This helper never dereferences source, evidence, span, or target refs. */
  readonly source_references_verified: false;
}

/** SHA-256 over exactly the supplied bytes, using the contracts package's lowercase hex convention. */
export async function digestResearchRelationBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function digestResearchRelationFactText(text: string): Promise<string> {
  const sourceFactText = SourceFactTextSchema.parse(text);
  return digestResearchRelationBytes(new TextEncoder().encode(sourceFactText));
}

/**
 * Identity hashes the versioned candidate body without candidate_ref or identity_digest,
 * canonicalized by the contracts registry serializer. It does not establish source authority.
 */
export async function researchRelationCandidateIdentityDigest(
  identity: ResearchRelationCandidateIdentity,
): Promise<string> {
  const bytes = new TextEncoder().encode(serializeCanonicalContractJson(identity));
  return digestResearchRelationBytes(bytes);
}

/** Checks schema shape, each exact UTF-8 fact digest, and canonical candidate identity only. */
export async function verifyResearchRelationCandidateIdentity(
  input: unknown,
): Promise<ResearchRelationCandidateIdentityVerification> {
  const parsed = ResearchRelationCandidateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      candidate_schema_valid: false,
      fact_text_digests_match: false,
      canonical_identity_matches: false,
      source_references_verified: false,
    };
  }
  const candidate = parsed.data;
  const factTextDigestsMatch =
    await digestResearchRelationFactText(candidate.left.fact_text) === candidate.left.fact_text_sha256 &&
    await digestResearchRelationFactText(candidate.right.fact_text) === candidate.right.fact_text_sha256;
  const { candidate_ref: candidateRef, identity_digest: identityDigest, ...identity } = candidate;
  const computedIdentityDigest = await researchRelationCandidateIdentityDigest(identity);
  return {
    candidate_schema_valid: true,
    fact_text_digests_match: factTextDigestsMatch,
    canonical_identity_matches: computedIdentityDigest === identityDigest &&
      candidateRef.id === `eliotr.research.relation-candidate-${computedIdentityDigest}`,
    source_references_verified: false,
  };
}
