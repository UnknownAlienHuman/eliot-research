import { z } from "zod";
import { IdentifierSchema, Sha256Schema, VersionedRefSchema } from "./common.js";
import { CoverageReceiptSchema } from "./research.js";

export const PROJECT_GUIDE_PROTOCOL = "eliotr.project-guide.v1" as const;
export const PROJECT_GUIDE_PROMPT_REVISION = "project-guide-evidence-v1" as const;
export const ProjectGuideLanguageSchema = z.enum(["en", "ru"]);
export const ProjectGuideRequestSchema = z.object({
  protocol: z.literal(PROJECT_GUIDE_PROTOCOL), language: ProjectGuideLanguageSchema,
}).strict();
export const ProjectGuideClaimSchema = z.object({
  claim_ref: VersionedRefSchema, section_ref: VersionedRefSchema, text: z.string().min(1),
  label: z.enum(["SOURCE_SUPPORTED", "DERIVED_INFERENCE", "EDITORIAL_RECOMMENDATION"]),
  support_handle_refs: z.array(VersionedRefSchema).min(1),
  counterevidence_handle_refs: z.array(VersionedRefSchema),
}).strict();
export const ProjectGuideDocumentSchema = z.object({
  summary: z.array(ProjectGuideClaimSchema).min(1),
  questions: z.array(ProjectGuideClaimSchema).min(3).max(5),
  coverage: CoverageReceiptSchema,
  source_basis: z.array(z.object({ source_revision_ref: IdentifierSchema, title: z.string().min(1) }).strict()).min(1),
}).strict().superRefine((guide, ctx) => {
  if (guide.summary.some(claim => claim.label === "EDITORIAL_RECOMMENDATION") ||
      guide.questions.some(claim => claim.label !== "EDITORIAL_RECOMMENDATION" || !claim.text.trimEnd().endsWith("?"))) {
    ctx.addIssue({ code: "custom", message: "Guide summary and question roles must preserve their audited labels" });
  }
  const refs = [...guide.summary, ...guide.questions].map(claim => `${claim.claim_ref.id}:${claim.claim_ref.revision}`);
  if (new Set(refs).size !== refs.length) ctx.addIssue({ code: "custom", message: "Guide repeats an audited claim" });
  const basis = guide.source_basis.map(source => source.source_revision_ref).sort();
  if (JSON.stringify(basis) !== JSON.stringify([...guide.coverage.represented_source_refs].sort()) || new Set(basis).size !== basis.length) {
    ctx.addIssue({ code: "custom", message: "Guide source basis must match its actual represented evidence" });
  }
});
export const ProjectGuideViewSchema = z.object({
  protocol: z.literal(PROJECT_GUIDE_PROTOCOL), project_id: IdentifierSchema,
  language: ProjectGuideLanguageSchema,
  state: z.enum(["EMPTY", "MISSING", "BLOCKED", "PENDING", "UNKNOWN", "FAILED", "STALE", "INVALID", "PARTIAL", "READY"]),
  identity_digest: Sha256Schema.nullable(), corpus_digest: Sha256Schema,
  source_count: z.number().int().nonnegative(), workflow_instance_id: IdentifierSchema.nullable(),
  artifact_ref: VersionedRefSchema.nullable(), reason_code: IdentifierSchema.nullable(),
  guide: ProjectGuideDocumentSchema.nullable(),
}).strict().superRefine((view, ctx) => {
  const disclosed = view.state === "READY" || view.state === "PARTIAL";
  if (disclosed && (view.guide === null || view.artifact_ref === null ||
      view.workflow_instance_id === null || view.identity_digest === null)) {
    ctx.addIssue({ code: "custom", message: "Ready guide requires a verified report and guide" });
  }
  if (!disclosed && view.guide !== null) ctx.addIssue({ code: "custom", message: "Only a verified guide discloses text" });
  if (view.state === "READY" && view.guide !== null && (view.guide.coverage.denominator_kind !== "complete_scope" ||
      view.guide.coverage.represented_source_refs.length !== view.source_count || view.guide.coverage.omitted_sources.length !== 0)) {
    ctx.addIssue({ code: "custom", message: "Coverage-limited guide must remain partial" });
  }
  if (view.state === "EMPTY" && (view.source_count !== 0 || view.workflow_instance_id !== null)) {
    ctx.addIssue({ code: "custom", message: "Empty project cannot own a guide run" });
  }
});
export type ProjectGuideLanguage = z.infer<typeof ProjectGuideLanguageSchema>;
export type ProjectGuideRequest = z.infer<typeof ProjectGuideRequestSchema>;
export type ProjectGuideClaim = z.infer<typeof ProjectGuideClaimSchema>;
export type ProjectGuideDocument = z.infer<typeof ProjectGuideDocumentSchema>;
export type ProjectGuideView = z.infer<typeof ProjectGuideViewSchema>;
