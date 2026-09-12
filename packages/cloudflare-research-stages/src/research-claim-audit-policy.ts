import {
  UnsupportedPrecisionItemSchema,
} from "@eliotr/contracts";
import type { SemanticAuditDimension } from "@eliotr/research";
import { z } from "zod";

export const MAX_RESEARCH_CLAIM_AUDIT_POLICY_ITEMS = 32;
export const MAX_RESEARCH_CLAIM_AUDIT_POLICY_TEXT_CHARS = 4096;

const AuditDimensionSchema = z.enum([
  "value_or_measurement_verification",
  "specification_compliance",
  "method_artifact_alignment",
]);

const BoundedUnsupportedPrecisionItemSchema = UnsupportedPrecisionItemSchema.extend({
  asserted_reference_or_coordinate: z.string().max(MAX_RESEARCH_CLAIM_AUDIT_POLICY_TEXT_CHARS),
  highest_supported_precision: z.string().max(MAX_RESEARCH_CLAIM_AUDIT_POLICY_TEXT_CHARS),
  risk_of_false_precision: z.string().max(MAX_RESEARCH_CLAIM_AUDIT_POLICY_TEXT_CHARS),
  required_probe_or_narrower_wording: z.string().max(MAX_RESEARCH_CLAIM_AUDIT_POLICY_TEXT_CHARS),
}).strict();

export const ResearchClaimAuditPolicySchema = z.object({
  required_dimensions: z.array(AuditDimensionSchema).max(3),
  source_requirement_applicable: z.boolean(),
  excerpt_requirement_applicable: z.boolean(),
  coverage_limitations: z.array(z.string().min(1).max(MAX_RESEARCH_CLAIM_AUDIT_POLICY_TEXT_CHARS)).max(MAX_RESEARCH_CLAIM_AUDIT_POLICY_ITEMS),
  unsupported_precision: z.array(BoundedUnsupportedPrecisionItemSchema).max(MAX_RESEARCH_CLAIM_AUDIT_POLICY_ITEMS),
}).strict();

export type ResearchClaimAuditPolicy = {
  readonly required_dimensions: readonly SemanticAuditDimension[];
  readonly source_requirement_applicable: boolean;
  readonly excerpt_requirement_applicable: boolean;
  readonly coverage_limitations: readonly string[];
  readonly unsupported_precision: readonly (Omit<z.infer<typeof UnsupportedPrecisionItemSchema>, "source_and_coverage_basis"> & {
    readonly source_and_coverage_basis: readonly string[];
  })[];
};

export class ResearchClaimAuditPolicyError extends Error {
  public constructor(message = "research claim audit policy is invalid") {
    super(message);
    this.name = "ResearchClaimAuditPolicyError";
  }
}

/** Parse and detach the one server-owned Stage14 policy; no field has a default. */
export function parseResearchClaimAuditPolicy(value: unknown): ResearchClaimAuditPolicy {
  const parsed = ResearchClaimAuditPolicySchema.safeParse(value);
  if (!parsed.success || new Set(parsed.data.required_dimensions).size !== parsed.data.required_dimensions.length) {
    throw new ResearchClaimAuditPolicyError();
  }
  return Object.freeze({
    required_dimensions: Object.freeze([...parsed.data.required_dimensions]),
    source_requirement_applicable: parsed.data.source_requirement_applicable,
    excerpt_requirement_applicable: parsed.data.excerpt_requirement_applicable,
    coverage_limitations: Object.freeze([...parsed.data.coverage_limitations]),
    unsupported_precision: Object.freeze(parsed.data.unsupported_precision.map((item) => Object.freeze({
      ...item,
      source_and_coverage_basis: Object.freeze([...item.source_and_coverage_basis]),
    }))),
  });
}
