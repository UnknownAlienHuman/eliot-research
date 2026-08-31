import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, Sha256Schema } from "./common.js";
import { OwnershipModeSchema } from "./source.js";

export const NORMALIZED_BUNDLE_PROTOCOL = "eliotr.normalized.v1" as const;
export const NORMALIZED_BUNDLE_CANONICAL_BODY_SHA256 = "3a5f9fd2b254eebe574b2c4a28f9804df0da9df359e59ceee125fa7da90fef22" as const;

export const NormalizedBundleManifestSchema = z.object({
  protocol: z.literal(NORMALIZED_BUNDLE_PROTOCOL),
  origin: z.object({
    owner_system_id: IdentifierSchema,
    source_namespace_id: IdentifierSchema,
    source_owner_generation: IdentifierSchema,
    source_revision_ref: IdentifierSchema,
    source_view_ref: IdentifierSchema,
    workspace_view_revision_ref: IdentifierSchema.optional(),
    ownership_mode: OwnershipModeSchema.exclude(["erc_owned"]),
    ownership_cutover_receipt_ref: IdentifierSchema.optional(),
  }).strict(),
  source: z.object({
    logical_id: IdentifierSchema,
    original_name: z.string().min(1),
    original_sha256: Sha256Schema,
    origin_location_class: z.enum(["local_only", "cloud", "external"]),
    mime_type: z.string().min(1),
  }).strict(),
  residency_and_disclosure: z.object({
    scope_domain_id: IdentifierSchema,
    access_domain_id: IdentifierSchema,
    confidentiality_domain_id: IdentifierSchema,
    encryption_key_domain_id: IdentifierSchema,
    retention_domain_id: IdentifierSchema,
    erasure_domain_id: IdentifierSchema,
    disclosure_ceiling: IdentifierSchema,
    allowed_use: z.array(IdentifierSchema),
    expiry: IsoDateTimeSchema.optional(),
  }).strict(),
  normalization: z.object({
    analyzer: IdentifierSchema,
    analyzer_version: z.string().min(1),
    profile: IdentifierSchema,
    config_hash: Sha256Schema,
    created_at: IsoDateTimeSchema,
  }).strict(),
  content: z.object({
    markdown: z.literal("content.md"),
    markdown_sha256: Sha256Schema,
    structure: z.string().optional(),
    mappings: z.string().optional(),
    tables: z.string().optional(),
    coordinate_map_digest: Sha256Schema.optional(),
    loss_map_digest: Sha256Schema.optional(),
  }).strict(),
  capabilities: z.object({
    text_ranges: z.boolean(),
    pages: z.boolean(),
    bounding_boxes: z.boolean(),
    tables: z.boolean(),
    figures: z.boolean(),
  }).strict(),
  quality: z.object({
    state: z.enum(["high_fidelity", "standard", "degraded"]),
    assurance_ceiling: IdentifierSchema,
    warnings: z.array(z.string()),
  }).strict(),
  export: z.object({
    purpose: z.string().min(1),
    receipt_ref: IdentifierSchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  const hasReceipt = value.origin.ownership_cutover_receipt_ref !== undefined;
  if (value.origin.ownership_mode === "ownership_cutover" && !hasReceipt) {
    context.addIssue({ code: "custom", path: ["origin", "ownership_cutover_receipt_ref"], message: "required for ownership_cutover" });
  }
  if (value.origin.ownership_mode !== "ownership_cutover" && hasReceipt) {
    context.addIssue({ code: "custom", path: ["origin", "ownership_cutover_receipt_ref"], message: "must be absent outside ownership_cutover" });
  }
});
export type NormalizedBundleManifest = z.infer<typeof NormalizedBundleManifestSchema>;

export const BundleAdmissionReceiptSchema = z.object({
  operation_id: IdentifierSchema,
  manifest_sha256: Sha256Schema,
  source_revision_ref: IdentifierSchema,
  normalized_artifact_ref: IdentifierSchema,
  object_residency_key_digest: Sha256Schema,
  decision: z.enum(["ADMITTED", "DUPLICATE", "QUARANTINED", "REJECTED"]),
  reason_codes: z.array(IdentifierSchema),
  readback_sha256: Sha256Schema,
  committed_at: IsoDateTimeSchema,
}).strict();
export type BundleAdmissionReceipt = z.infer<typeof BundleAdmissionReceiptSchema>;
