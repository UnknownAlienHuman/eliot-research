import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, Sha256Schema } from "./common.js";

export const SOURCE_OWNER_CUTOVER_PROTOCOL = "source.owner-cutover.v1" as const;
export const SOURCE_OWNER_CUTOVER_CANONICAL_BODY_SHA256 = "b659806e37a4bc60ea67b4416e35212f559213bbadb28618b7edcee686b9277e" as const;

export const SourceOwnerCutoverReceiptSchema = z.object({
  protocol: z.literal(SOURCE_OWNER_CUTOVER_PROTOCOL),
  cutover: z.object({
    cutover_id: IdentifierSchema,
    source_namespace_id: IdentifierSchema,
    identity_mapping_digest: Sha256Schema,
    prepared_at: IsoDateTimeSchema,
    effective_at: IsoDateTimeSchema,
  }).strict(),
  old_owner: z.object({
    owner_system_id: IdentifierSchema,
    source_owner_generation_before_fence: IdentifierSchema,
    fence_revision: IdentifierSchema,
    final_source_view_ref: IdentifierSchema,
    final_revision_set_digest: Sha256Schema,
    terminal_status: z.enum(["FENCED", "RETIRED"]),
  }).strict(),
  new_owner: z.object({
    owner_system_id: IdentifierSchema,
    source_owner_generation_after_activation: IdentifierSchema,
    activation_revision: IdentifierSchema,
    admitted_revision_set_digest: Sha256Schema,
    status: z.literal("ACTIVE"),
  }).strict(),
  validation: z.object({
    compatibility_receipt_refs: z.array(IdentifierSchema),
    integrity_receipt_refs: z.array(IdentifierSchema),
    unresolved_sources_and_reasons: z.array(z.object({
      source_ref: IdentifierSchema,
      reason_code: IdentifierSchema,
    }).strict()),
  }).strict(),
  authorization: z.object({
    old_owner_authorization_ref: IdentifierSchema,
    new_owner_authorization_ref: IdentifierSchema,
    issued_at: IsoDateTimeSchema,
  }).strict(),
}).strict();
export type SourceOwnerCutoverReceipt = z.infer<typeof SourceOwnerCutoverReceiptSchema>;
