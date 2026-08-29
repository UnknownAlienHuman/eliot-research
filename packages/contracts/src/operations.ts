import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, NonNegativeIntegerSchema, PositiveIntegerSchema, VersionedRefSchema } from "./common.js";

export const OperationKindSchema = z.enum([
  "INGEST", "PROJECTION", "QUERY", "RESEARCH", "AUDIT", "REPORT", "EXHAUSTIVE_SCAN",
  "REINDEX", "WIKI_PUBLISH", "ARTIFACT_PUBLISH", "DRIVE_IMPORT", "DRIVE_EXPORT", "ERASURE", "BACKUP", "RESTORE_VERIFY",
]);

export const OperationIntentSchema = z.object({
  intent_ref: VersionedRefSchema,
  operation_kind: OperationKindSchema,
  principal_ref: IdentifierSchema,
  idempotency_key: IdentifierSchema,
  payload_ref: IdentifierSchema,
  policy_decision_ref: IdentifierSchema,
  budget_reservation_ref: IdentifierSchema.optional(),
  cancellation_ref: IdentifierSchema.optional(),
  created_at: IsoDateTimeSchema,
}).strict();
export type OperationIntent = z.infer<typeof OperationIntentSchema>;

export const OperationAttemptSchema = z.object({
  attempt_id: IdentifierSchema,
  intent_ref: VersionedRefSchema,
  attempt_number: PositiveIntegerSchema,
  state: z.enum(["STARTED", "CHECKPOINTED", "SUCCEEDED", "FAILED", "CANCELLED"]),
  checkpoint_ref: IdentifierSchema.optional(),
  error_code: IdentifierSchema.optional(),
  started_at: IsoDateTimeSchema,
  ended_at: IsoDateTimeSchema.optional(),
}).strict();
export type OperationAttempt = z.infer<typeof OperationAttemptSchema>;

export const OperationReceiptSchema = z.object({
  receipt_ref: VersionedRefSchema,
  intent_ref: VersionedRefSchema,
  attempt_id: IdentifierSchema,
  outcome: z.enum(["ACCEPTED", "DUPLICATE", "SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED", "BLOCKED"]),
  output_refs: z.array(IdentifierSchema),
  readback_receipt_refs: z.array(IdentifierSchema),
  reconciliation_required: z.boolean(),
  reason_codes: z.array(IdentifierSchema),
  created_at: IsoDateTimeSchema,
}).strict();
export type OperationReceipt = z.infer<typeof OperationReceiptSchema>;

export const BudgetReservationSchema = z.object({
  reservation_id: IdentifierSchema,
  operation_kind: OperationKindSchema,
  project_id: IdentifierSchema.optional(),
  platform_usd: z.number().nonnegative(),
  workers_ai_usd: z.number().nonnegative(),
  byok_usd: z.number().nonnegative(),
  max_total_usd: z.number().nonnegative(),
  workflow_steps: NonNegativeIntegerSchema,
  expected_sources: NonNegativeIntegerSchema,
  expected_sections: NonNegativeIntegerSchema,
  confidence: z.number().min(0).max(1),
  state: z.enum(["QUOTED", "RESERVED", "SETTLED", "RELEASED", "EXPIRED"]),
  expires_at: IsoDateTimeSchema,
}).strict();
export type BudgetReservation = z.infer<typeof BudgetReservationSchema>;
