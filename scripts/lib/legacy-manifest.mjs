import { z } from 'zod';

// Pinned legacy wire schema only; no legacy package/runtime imports. See DONORS, K10.
const identifier = z.string().min(1).max(256);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const datetime = z.string().datetime({ offset: true });
export const legacyManifestSchema = z.object({
  protocol: z.literal('eliotr.normalized.v1'),
  origin: z.object({
    owner_system_id: identifier,
    source_namespace_id: identifier,
    source_owner_generation: identifier,
    source_revision_ref: identifier,
    source_view_ref: identifier,
    workspace_view_revision_ref: identifier.optional(),
    ownership_mode: z.enum(['federated_reference', 'immutable_import', 'ownership_cutover']),
    ownership_cutover_receipt_ref: identifier.optional(),
  }).strict(),
  source: z.object({
    logical_id: identifier,
    original_name: z.string().min(1),
    original_sha256: sha256,
    origin_location_class: z.enum(['local_only', 'cloud', 'external']),
    mime_type: z.string().min(1),
  }).strict(),
  residency_and_disclosure: z.object({
    scope_domain_id: identifier,
    access_domain_id: identifier,
    confidentiality_domain_id: identifier,
    encryption_key_domain_id: identifier,
    retention_domain_id: identifier,
    erasure_domain_id: identifier,
    disclosure_ceiling: identifier,
    allowed_use: z.array(identifier),
    expiry: datetime.optional(),
  }).strict(),
  normalization: z.object({
    analyzer: identifier,
    analyzer_version: z.string().min(1),
    profile: identifier,
    config_hash: sha256,
    created_at: datetime,
  }).strict(),
  content: z.object({
    markdown: z.literal('content.md'),
    markdown_sha256: sha256,
    structure: z.string().optional(),
    mappings: z.string().optional(),
    tables: z.string().optional(),
    coordinate_map_digest: sha256.optional(),
    loss_map_digest: sha256.optional(),
  }).strict(),
  capabilities: z.object({
    text_ranges: z.boolean(),
    pages: z.boolean(),
    bounding_boxes: z.boolean(),
    tables: z.boolean(),
    figures: z.boolean(),
  }).strict(),
  quality: z.object({
    state: z.enum(['high_fidelity', 'standard', 'degraded']),
    assurance_ceiling: identifier,
    warnings: z.array(z.string()),
  }).strict(),
  export: z.object({
    purpose: z.string().min(1),
    receipt_ref: identifier,
  }).strict(),
}).strict().superRefine((value, context) => {
  const hasReceipt = value.origin.ownership_cutover_receipt_ref !== undefined;
  if ((value.origin.ownership_mode === 'ownership_cutover') !== hasReceipt) {
    context.addIssue({ code: 'custom', path: ['origin', 'ownership_cutover_receipt_ref'],
      message: 'Required exactly for ownership_cutover' });
  }
});
