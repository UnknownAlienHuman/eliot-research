import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, NonNegativeIntegerSchema, Sha256Schema, VersionedRefSchema } from "./common.js";

export const BackupEpochSchema = z.object({
  epoch_ref: VersionedRefSchema,
  schema_generation: IdentifierSchema,
  migration_ledger_digest: Sha256Schema,
  core_export_manifest_ref: IdentifierSchema,
  r2_object_manifest_ref: IdentifierSchema,
  head_manifest_ref: IdentifierSchema,
  generation_manifest_ref: IdentifierSchema,
  purge_ledger_revision: NonNegativeIntegerSchema,
  purge_ledger_digest: Sha256Schema,
  offsite_copy_ref: IdentifierSchema,
  offsite_failure_domain: IdentifierSchema,
  encryption_key_generation: IdentifierSchema,
  audit_sample_receipt_ref: IdentifierSchema,
  created_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
}).strict();
export type BackupEpoch = z.infer<typeof BackupEpochSchema>;

export const RestoreVerificationReceiptSchema = z.object({
  receipt_ref: VersionedRefSchema,
  backup_epoch_ref: VersionedRefSchema,
  isolated_restore_environment_ref: IdentifierSchema,
  applied_purge_ledger_revision: NonNegativeIntegerSchema,
  restored_live_handle_count: NonNegativeIntegerSchema,
  verified_redacted_handle_count: NonNegativeIntegerSchema,
  rebuilt_search_generations: z.array(IdentifierSchema),
  exact_acceptance_passed: z.boolean(),
  high_recall_acceptance_passed: z.boolean(),
  erasure_acceptance_passed: z.boolean(),
  unresolved_failures: z.array(IdentifierSchema),
  ready_for_traffic: z.boolean(),
  issued_at: IsoDateTimeSchema,
}).strict();
export type RestoreVerificationReceipt = z.infer<typeof RestoreVerificationReceiptSchema>;
