import { z } from "zod";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  JsonObjectSchema,
  Sha256Schema,
  VersionedRefSchema,
} from "./common.js";
import { OwnershipModeSchema, SourceCurrentnessSchema, SourceRevisionSchema } from "./source.js";

export const ProjectSchema = z.object({
  project_ref: VersionedRefSchema,
  title: z.string().min(1).max(512),
  default_disclosure_policy_ref: IdentifierSchema,
  default_retention_policy_ref: IdentifierSchema,
  default_source_policy_ref: IdentifierSchema,
  default_model_profile_ref: IdentifierSchema,
  instructions_object_ref: IdentifierSchema.optional(),
  created_at: IsoDateTimeSchema,
  archived_at: IsoDateTimeSchema.optional(),
}).strict();
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectSourceMembershipSchema = z.object({
  membership_ref: VersionedRefSchema,
  project_id: IdentifierSchema,
  source_id: IdentifierSchema,
  role: IdentifierSchema,
  valid_from: IsoDateTimeSchema,
  valid_to: IsoDateTimeSchema.optional(),
  membership_generation: IdentifierSchema,
  admitted_by_receipt_ref: IdentifierSchema,
}).strict();
export type ProjectSourceMembership = z.infer<typeof ProjectSourceMembershipSchema>;

export const ReadinessChannelSchema = z.enum([
  "captured", "normalized", "structure_qualified", "exact_ready", "lexical_ready",
  "semantic_ready", "sourcecard_ready", "atlas_included", "distillates_ready", "wiki_published",
]);
export type ReadinessChannel = z.infer<typeof ReadinessChannelSchema>;

export const ReadinessStateSchema = z.enum([
  "not_requested", "queued", "running", "ready", "degraded", "failed", "stale", "redacted",
]);
export type ReadinessState = z.infer<typeof ReadinessStateSchema>;

export const ChannelReadinessSchema = z.object({
  source_revision_ref: IdentifierSchema,
  channel: ReadinessChannelSchema,
  state: ReadinessStateSchema,
  generation: IdentifierSchema.optional(),
  reason_codes: z.array(IdentifierSchema),
  receipt_ref: IdentifierSchema.optional(),
  observed_at: IsoDateTimeSchema,
}).strict();
export type ChannelReadiness = z.infer<typeof ChannelReadinessSchema>;

export const QualificationCheckSchema = z.object({
  check: z.enum([
    "extraction_coverage", "empty_or_truncated_pages", "reading_order", "heading_continuity",
    "tables_and_cell_mapping", "ocr_confidence", "replacement_or_corrupt_characters",
    "duplicate_pages", "soft_404_waf_login_stub", "identity_title_authors",
    "source_mapping_completeness", "parser_warnings",
  ]),
  disposition: z.enum(["PASS", "DEGRADED", "FAIL", "NOT_APPLICABLE"]),
  measurement: JsonObjectSchema.optional(),
  reason_codes: z.array(IdentifierSchema),
}).strict();

export const QualificationReportSchema = z.object({
  report_ref: VersionedRefSchema,
  source_revision_ref: IdentifierSchema,
  parser_profile_generation: IdentifierSchema,
  checks: z.array(QualificationCheckSchema).min(1),
  overall: z.enum(["QUALIFIED", "DEGRADED", "REJECTED"]),
  exact_precision_ceiling: z.enum(["byte", "line", "page", "bounding_box", "table_cell"]),
  warnings: z.array(z.string()),
  created_at: IsoDateTimeSchema,
}).strict();
export type QualificationReport = z.infer<typeof QualificationReportSchema>;

export const SourceCatalogEntrySchema = z.object({
  source_id: IdentifierSchema,
  head_revision: SourceRevisionSchema,
  ownership_mode: OwnershipModeSchema,
  currentness: SourceCurrentnessSchema,
  projects: z.array(ProjectSourceMembershipSchema),
  readiness: z.array(ChannelReadinessSchema),
  qualification_report_ref: VersionedRefSchema.optional(),
  catalog_generation: IdentifierSchema,
  catalog_digest: Sha256Schema,
}).strict();
export type SourceCatalogEntry = z.infer<typeof SourceCatalogEntrySchema>;

export const SourceRevisionSetSchema = z.object({
  set_ref: VersionedRefSchema,
  source_revision_refs: z.array(IdentifierSchema),
  owner_generations: z.record(IdentifierSchema, IdentifierSchema),
  digest: Sha256Schema,
  created_at: IsoDateTimeSchema,
}).strict();
export type SourceRevisionSet = z.infer<typeof SourceRevisionSetSchema>;
