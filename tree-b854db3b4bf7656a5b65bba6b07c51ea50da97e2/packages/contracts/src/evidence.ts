import { z } from "zod";
import {
  ByteLengthSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  NonNegativeIntegerSchema,
  Sha256Schema,
  VersionedRefSchema,
} from "./common.js";
import {
  EffectCeilingSchema,
  InstructionTaintSchema,
  SourceAssuranceSchema,
} from "./security.js";

export const EvidenceHandleTerminalStateSchema = z.enum([
  "LIVE", "STALE", "COLD_RESTORABLE", "REDACTED", "RETENTION_BLOCKED", "BROKEN_INTEGRITY",
]);
export type EvidenceHandleTerminalState = z.infer<typeof EvidenceHandleTerminalStateSchema>;

export const EvidenceAnchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("normalized_byte_range"), start: ByteLengthSchema, end: ByteLengthSchema }).strict(),
  z.object({ kind: z.literal("normalized_line_range"), start_line: z.number().int().positive(), end_line: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("page_region"), page: z.number().int().positive(), bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]) }).strict(),
  z.object({ kind: z.literal("table_cell"), table_id: IdentifierSchema, row: z.number().int().nonnegative(), column: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("code_range"), commit_sha: Sha256Schema, path: z.string().min(1), start_line: z.number().int().positive(), end_line: z.number().int().positive() }).strict(),
]);
export type EvidenceAnchor = z.infer<typeof EvidenceAnchorSchema>;

export const EvidenceHandleSchema = z.object({
  handle_ref: VersionedRefSchema,
  source_namespace_id: IdentifierSchema,
  source_owner_generation: IdentifierSchema,
  source_revision_ref: IdentifierSchema,
  scope_snapshot_ref: VersionedRefSchema,
  anchor: EvidenceAnchorSchema,
  excerpt_sha256: Sha256Schema,
  excerpt_byte_length: ByteLengthSchema,
  coordinate_map_ref: IdentifierSchema.optional(),
  loss_map_ref: IdentifierSchema.optional(),
  object_residency_key_digest: Sha256Schema,
  source_assurance_ceiling: SourceAssuranceSchema,
  materializer_assurance_ceiling: SourceAssuranceSchema,
  terminal_state: EvidenceHandleTerminalStateSchema,
  invalidation_ref: IdentifierSchema.optional(),
  created_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.anchor.kind === "normalized_byte_range" && value.anchor.end <= value.anchor.start) {
    context.addIssue({
      code: "custom",
      path: ["anchor", "end"],
      message: "normalized byte range must be non-empty",
    });
  }
  if (value.anchor.kind === "normalized_line_range" && value.anchor.end_line < value.anchor.start_line) {
    context.addIssue({
      code: "custom",
      path: ["anchor", "end_line"],
      message: "normalized line range end precedes start",
    });
  }
  if (value.anchor.kind === "code_range" && value.anchor.end_line < value.anchor.start_line) {
    context.addIssue({
      code: "custom",
      path: ["anchor", "end_line"],
      message: "code range end precedes start",
    });
  }
  if (value.terminal_state === "LIVE" && value.invalidation_ref !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["invalidation_ref"],
      message: "live evidence cannot carry an invalidation reference",
    });
  }
  if (value.terminal_state !== "LIVE" && value.invalidation_ref === undefined) {
    context.addIssue({
      code: "custom",
      path: ["invalidation_ref"],
      message: "terminal evidence requires an invalidation reference",
    });
  }
});
export type EvidenceHandle = z.infer<typeof EvidenceHandleSchema>;

export const EvidenceResolutionReceiptSchema = z.object({
  receipt_ref: VersionedRefSchema,
  handle_ref: VersionedRefSchema,
  source_revision_ref: IdentifierSchema,
  scope_snapshot_ref: VersionedRefSchema,
  authorization_receipt_ref: IdentifierSchema,
  normalized_object_ref_digest: Sha256Schema,
  source_revision_content_sha256: Sha256Schema,
  source_object_size: ByteLengthSchema,
  scope_snapshot_digest: Sha256Schema,
  anchor_digest: Sha256Schema,
  excerpt_sha256: Sha256Schema,
  excerpt_byte_length: ByteLengthSchema,
  source_owner_generation: IdentifierSchema,
  purge_state: z.literal("LIVE"),
  terminal_state: z.literal("LIVE"),
  resolved_at: IsoDateTimeSchema,
  receipt_digest: Sha256Schema,
}).strict();
export type EvidenceResolutionReceipt = z.infer<typeof EvidenceResolutionReceiptSchema>;

export const ResolvedEvidenceSchema = z.object({
  handle: EvidenceHandleSchema,
  exact_excerpt: z.string(),
  neighboring_text_ref: IdentifierSchema.optional(),
  source_title: z.string().optional(),
  verification_receipt_ref: IdentifierSchema,
  authorization_receipt_ref: IdentifierSchema,
  credential_generation: IdentifierSchema,
  source_revision_content_sha256: Sha256Schema,
  scope_snapshot_digest: Sha256Schema,
  instruction_taint: InstructionTaintSchema,
  allowed_effects: EffectCeilingSchema,
  resolved_at: IsoDateTimeSchema,
}).strict();
export type ResolvedEvidence = z.infer<typeof ResolvedEvidenceSchema>;

export const CitationResolutionItemSchema = z.object({
  handle_ref: VersionedRefSchema,
  excerpt_sha256: Sha256Schema,
  verification_receipt_ref: IdentifierSchema,
}).strict();
export type CitationResolutionItem = z.infer<typeof CitationResolutionItemSchema>;

export const CitationResolutionRejectionSchema = z.object({
  handle_ref: VersionedRefSchema,
  reason_code: IdentifierSchema,
}).strict();
export type CitationResolutionRejection = z.infer<typeof CitationResolutionRejectionSchema>;

function versionedRefKey(value: { readonly id: string; readonly revision: number }): string {
  return `${value.id}:${value.revision}`;
}

export const CitationResolutionReceiptSchema = z.object({
  receipt_ref: VersionedRefSchema,
  scope_snapshot_ref: VersionedRefSchema,
  requested_handle_refs: z.array(VersionedRefSchema).max(512),
  resolved: z.array(CitationResolutionItemSchema).max(512),
  rejected: z.array(CitationResolutionRejectionSchema).max(512),
  requested_count: NonNegativeIntegerSchema,
  resolved_count: NonNegativeIntegerSchema,
  all_material_citations_resolved: z.boolean(),
  created_at: IsoDateTimeSchema,
  receipt_digest: Sha256Schema,
}).strict().superRefine((value, context) => {
  const requestedKeys = value.requested_handle_refs.map(versionedRefKey);
  const resolvedKeys = value.resolved.map((item) => versionedRefKey(item.handle_ref));
  const rejectedKeys = value.rejected.map((item) => versionedRefKey(item.handle_ref));
  if (new Set(requestedKeys).size !== requestedKeys.length) {
    context.addIssue({ code: "custom", path: ["requested_handle_refs"], message: "duplicate requested handle" });
  }
  if (new Set(resolvedKeys).size !== resolvedKeys.length) {
    context.addIssue({ code: "custom", path: ["resolved"], message: "duplicate resolved handle" });
  }
  if (new Set(rejectedKeys).size !== rejectedKeys.length) {
    context.addIssue({ code: "custom", path: ["rejected"], message: "duplicate rejected handle" });
  }
  if (value.requested_count !== requestedKeys.length) {
    context.addIssue({ code: "custom", path: ["requested_count"], message: "requested_count mismatch" });
  }
  if (value.resolved_count !== resolvedKeys.length) {
    context.addIssue({ code: "custom", path: ["resolved_count"], message: "resolved_count mismatch" });
  }
  const requested = new Set(requestedKeys);
  if (resolvedKeys.some((key) => !requested.has(key)) || rejectedKeys.some((key) => !requested.has(key))) {
    context.addIssue({ code: "custom", path: ["resolved"], message: "receipt contains an unrequested handle" });
  }
  if (resolvedKeys.some((key) => rejectedKeys.includes(key))) {
    context.addIssue({ code: "custom", path: ["rejected"], message: "one handle is both resolved and rejected" });
  }
  const complete = resolvedKeys.length === requestedKeys.length && rejectedKeys.length === 0;
  if (value.all_material_citations_resolved !== complete) {
    context.addIssue({
      code: "custom",
      path: ["all_material_citations_resolved"],
      message: "all_material_citations_resolved is not derived from receipt members",
    });
  }
});
export type CitationResolutionReceipt = z.infer<typeof CitationResolutionReceiptSchema>;
