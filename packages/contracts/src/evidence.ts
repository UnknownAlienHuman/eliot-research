import { z } from "zod";
import { ByteLengthSchema, IdentifierSchema, IsoDateTimeSchema, Sha256Schema, VersionedRefSchema } from "./common.js";
import { SourceAssuranceSchema } from "./security.js";

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
}).strict();
export type EvidenceHandle = z.infer<typeof EvidenceHandleSchema>;

export const ResolvedEvidenceSchema = z.object({
  handle: EvidenceHandleSchema,
  exact_excerpt: z.string(),
  neighboring_text_ref: IdentifierSchema.optional(),
  source_title: z.string().optional(),
  verification_receipt_ref: IdentifierSchema,
  resolved_at: IsoDateTimeSchema,
}).strict();
export type ResolvedEvidence = z.infer<typeof ResolvedEvidenceSchema>;
