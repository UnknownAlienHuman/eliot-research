import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, VersionedRefSchema } from "./common.js";

export const ErasureProtocolSchema = z.literal("erc.privacy.erasure.v1");
export const PurgeLocationSchema = z.enum([
  "CanonicalPayload", "Projection", "Index", "Blob", "OperationalRecovery", "ProviderCopy", "BackupRestorePath", "RouteContinuation",
]);
export type PurgeLocation = z.infer<typeof PurgeLocationSchema>;

export const PurgeStateSchema = z.enum([
  "REQUESTED", "QUARANTINE_AND_REVOKE", "ENUMERATE_DEPENDENCY_CLOSURE", "CHECK_RETENTION_AND_HOLDS",
  "PURGE_EACH_LOCATION", "VERIFY_ABSENCE_OR_BLOCK", "APPEND_PURGE_LEDGER", "INVALIDATE_DEPENDENTS", "COMPLETE", "BLOCKED",
]);
export type PurgeState = z.infer<typeof PurgeStateSchema>;

export const ErasureRequestSchema = z.object({
  protocol: ErasureProtocolSchema,
  erasure_ref: VersionedRefSchema,
  requested_by_principal_ref: IdentifierSchema,
  exact_subject_refs: z.array(IdentifierSchema).min(1),
  required_locations: z.array(PurgeLocationSchema).min(1),
  legal_basis_ref: IdentifierSchema,
  admitted_at: IsoDateTimeSchema,
  deadline: IsoDateTimeSchema,
}).strict();
export type ErasureRequest = z.infer<typeof ErasureRequestSchema>;

export const ErasureReceiptSchema = z.object({
  protocol: ErasureProtocolSchema,
  erasure_ref: VersionedRefSchema,
  state: z.enum(["COMPLETE", "BLOCKED"]),
  requested_locations: z.array(PurgeLocationSchema),
  completed_locations: z.array(PurgeLocationSchema),
  blocked_locations: z.array(z.object({ location: PurgeLocationSchema, policy_or_hold_ref: IdentifierSchema, next_review_at: IsoDateTimeSchema }).strict()),
  purge_ledger_entry_ref: IdentifierSchema.optional(),
  issued_at: IsoDateTimeSchema,
}).strict();
export type ErasureReceipt = z.infer<typeof ErasureReceiptSchema>;
