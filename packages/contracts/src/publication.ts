import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, JsonObjectSchema, Sha256Schema, VersionedRefSchema } from "./common.js";

export const EvidenceLabelSchema = z.enum([
  "SOURCE_SUPPORTED", "DERIVED_INFERENCE", "HYPOTHESIS", "CONTESTED", "UNRESOLVED",
  "EDITORIAL_RECOMMENDATION", "REDACTED_DEPENDENCY",
]);
export type EvidenceLabel = z.infer<typeof EvidenceLabelSchema>;

export const ArtifactKindSchema = z.enum([
  "research_report", "technical_audit", "literature_review", "architecture_report",
  "hypothesis_dossier", "comparison_report", "wiki_generation",
]);

export const ArtifactSectionContractSchema = z.object({
  section_id: IdentifierSchema,
  title: z.string().min(1),
  purpose: z.string().min(1),
  required_claim_kinds: z.array(IdentifierSchema),
  required_evidence_classes: z.array(IdentifierSchema),
  maximum_utf8_bytes: z.number().int().positive().max(1_048_576),
}).strict();

export const ArtifactSpecSchema = z.object({
  spec_ref: VersionedRefSchema,
  kind: ArtifactKindSchema,
  title: z.string().min(1),
  scope_snapshot_ref: VersionedRefSchema,
  inquiry_protocol_ref: VersionedRefSchema,
  audience: z.string().min(1),
  language: IdentifierSchema,
  section_contracts: z.array(ArtifactSectionContractSchema).min(1),
  citation_policy_ref: IdentifierSchema,
  verification_policy_ref: IdentifierSchema,
  include_counterevidence: z.boolean(),
  include_methodology: z.boolean(),
  length_policy_ref: IdentifierSchema,
  export_formats: z.array(z.enum(["markdown", "html", "pdf", "docx"])),
  budget_ref: IdentifierSchema,
}).strict();
export type ArtifactSpec = z.infer<typeof ArtifactSpecSchema>;

export const ArtifactSectionRevisionSchema = z.object({
  section_ref: VersionedRefSchema,
  contract_id: IdentifierSchema,
  body_object_ref: IdentifierSchema,
  body_sha256: Sha256Schema,
  statement_labels: z.record(IdentifierSchema, EvidenceLabelSchema),
  evidence_ledger_ref: IdentifierSchema,
  verification_receipt_ref: IdentifierSchema,
  reused_from_revision_ref: VersionedRefSchema.optional(),
}).strict();
export type ArtifactSectionRevision = z.infer<typeof ArtifactSectionRevisionSchema>;

export const ArtifactRevisionSchema = z.object({
  artifact_ref: VersionedRefSchema,
  spec_ref: VersionedRefSchema,
  spec_digest: Sha256Schema,
  evidence_freeze_ref: VersionedRefSchema,
  sections: z.array(ArtifactSectionRevisionSchema),
  dependency_manifest_ref: IdentifierSchema,
  deterministic_export_refs: z.record(IdentifierSchema, IdentifierSchema),
  status: z.enum(["DRAFT", "VERIFIED", "ACCEPTED", "SUPERSEDED", "PENDING_REVALIDATION", "REDACTED_DEPENDENCY"]),
  created_at: IsoDateTimeSchema,
}).strict();
export type ArtifactRevision = z.infer<typeof ArtifactRevisionSchema>;

export const WikiPageTypeSchema = z.enum([
  "Project", "Topic", "Source", "Method", "Hypothesis", "Comparison", "Audit", "Contradiction",
  "Timeline", "Report", "FailedPath", "OpenQuestion", "Glossary",
]);
export const WikiPageRevisionSchema = z.object({
  page_ref: VersionedRefSchema,
  page_type: WikiPageTypeSchema,
  title: z.string().min(1),
  scope_snapshot_ref: VersionedRefSchema,
  body_object_ref: IdentifierSchema,
  body_sha256: Sha256Schema,
  statement_labels: z.record(IdentifierSchema, EvidenceLabelSchema),
  evidence_map_ref: IdentifierSchema,
  counterposition_refs: z.array(IdentifierSchema),
  coverage_receipt_ref: VersionedRefSchema,
  limitations: z.array(z.string()),
  dependency_refs: z.array(IdentifierSchema),
  generator_generation: IdentifierSchema,
  reviewer_ref: IdentifierSchema.optional(),
  status: z.enum(["DRAFT", "PUBLISHED", "SUPERSEDED", "PENDING_REVALIDATION", "REDACTED_DEPENDENCY"]),
  supersedes_ref: VersionedRefSchema.optional(),
  publication_metadata: JsonObjectSchema,
  created_at: IsoDateTimeSchema,
}).strict();
export type WikiPageRevision = z.infer<typeof WikiPageRevisionSchema>;
