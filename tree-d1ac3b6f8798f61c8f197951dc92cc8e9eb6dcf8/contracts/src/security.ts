import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, Sha256Schema, VersionedRefSchema } from "./common.js";

export const InstructionTaintSchema = z.enum(["CLEARED", "DATA_ONLY", "UNTRUSTED", "COMMAND_LIKE"]);
export type InstructionTaint = z.infer<typeof InstructionTaintSchema>;

export const EffectCeilingSchema = z.enum(["READ_ONLY", "CANDIDATE_ONLY", "NO_EXTERNAL_EFFECT"]);
export type EffectCeiling = z.infer<typeof EffectCeilingSchema>;

export const SourceAssuranceSchema = z.enum(["UNVERIFIED", "LOCATOR_ONLY", "CAPTURED", "QUALIFIED", "EXACT"]);
export type SourceAssurance = z.infer<typeof SourceAssuranceSchema>;

export const EvidenceContextBlockSchema = z.object({
  evidence_handle_ref: VersionedRefSchema,
  source_revision_ref: IdentifierSchema,
  instruction_taint: InstructionTaintSchema,
  allowed_effects: EffectCeilingSchema,
  quoted_content: z.string(),
  excerpt_sha256: Sha256Schema,
}).strict();
export type EvidenceContextBlock = z.infer<typeof EvidenceContextBlockSchema>;

export const SelectionIntegrityReceiptSchema = z.object({
  receipt_ref: VersionedRefSchema,
  operation_kind: z.enum(["RERANK", "PRUNE", "SUMMARY", "CONTEXT_COMPILE", "EXPORT"]),
  input_candidate_refs: z.array(IdentifierSchema),
  admitted_candidate_refs: z.array(IdentifierSchema),
  rejected_candidates: z.array(z.object({ ref: IdentifierSchema, reason_code: IdentifierSchema }).strict()),
  untrusted_structure_changed_membership: z.boolean(),
  policy_generation: IdentifierSchema,
  created_at: IsoDateTimeSchema,
}).strict();
export type SelectionIntegrityReceipt = z.infer<typeof SelectionIntegrityReceiptSchema>;

export const DeclassificationReceiptSchema = z.object({
  receipt_ref: VersionedRefSchema,
  input_sha256: Sha256Schema,
  output_sha256: Sha256Schema,
  removed_or_generalized_domains: z.array(IdentifierSchema),
  preserved_domains: z.array(IdentifierSchema),
  verifier_ref: IdentifierSchema,
  transformation_generation: IdentifierSchema,
  residual_limitations: z.array(z.string()),
  created_at: IsoDateTimeSchema,
}).strict();
export type DeclassificationReceipt = z.infer<typeof DeclassificationReceiptSchema>;
