import { z } from "zod";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  JsonObjectSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  VersionedRefSchema,
} from "./common.js";
import { EffectCeilingSchema, InstructionTaintSchema, SourceAssuranceSchema } from "./security.js";

export const SourceOwnerStatusSchema = z.enum(["ACTIVE", "CUTOVER_PREPARED", "FENCED", "RETIRED"]);
export type SourceOwnerStatus = z.infer<typeof SourceOwnerStatusSchema>;

export const SourceNamespaceOwnershipSchema = z.object({
  source_namespace_id: IdentifierSchema,
  owner_system_id: IdentifierSchema,
  owner_incarnation_ref: IdentifierSchema,
  ownership_record_revision: PositiveIntegerSchema,
  source_owner_generation: IdentifierSchema,
  source_admission_policy_revision: PositiveIntegerSchema,
  status: SourceOwnerStatusSchema,
  cutover_receipt_ref: IdentifierSchema.optional(),
}).strict();
export type SourceNamespaceOwnership = z.infer<typeof SourceNamespaceOwnershipSchema>;

export const OwnershipModeSchema = z.enum(["erc_owned", "federated_reference", "immutable_import", "ownership_cutover"]);
export type OwnershipMode = z.infer<typeof OwnershipModeSchema>;

export const SourceAcquisitionCandidateStateSchema = z.enum(["OBSERVED", "RESOLVING", "CAPTURED", "REJECTED", "EXPIRED"]);
export const SourceAcquisitionCandidateSchema = z.object({
  candidate_ref: VersionedRefSchema,
  observed_locator_identifier_or_upload_ref: z.string().min(1),
  proposer_principal_ref: IdentifierSchema,
  proposer_run_ref: IdentifierSchema.optional(),
  allowed_reference_manifest_ref: VersionedRefSchema.optional(),
  proposed_source_class: IdentifierSchema,
  purpose: z.string().min(1),
  requested_scope_expression: JsonObjectSchema,
  untrusted_metadata: JsonObjectSchema,
  staging_object_ref: IdentifierSchema.optional(),
  policy_refs: z.array(IdentifierSchema),
  state: SourceAcquisitionCandidateStateSchema,
  effect_ceiling: z.literal("NO_EXTERNAL_EFFECT"),
  created_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
  terminal_receipt_ref: IdentifierSchema.optional(),
}).strict();
export type SourceAcquisitionCandidate = z.infer<typeof SourceAcquisitionCandidateSchema>;

export const SourceAdmissionDecisionSchema = z.object({
  source_namespace_id: IdentifierSchema,
  owner_system_id: IdentifierSchema,
  source_owner_generation: IdentifierSchema,
  source_revision_ref: IdentifierSchema,
  origin_authentication_receipt_ref: IdentifierSchema,
  source_class: IdentifierSchema,
  assurance_ceiling: SourceAssuranceSchema,
  instruction_taint: InstructionTaintSchema,
  allowed_effects: EffectCeilingSchema,
  object_residency_key_digest: Sha256Schema,
  allowed_use: z.array(IdentifierSchema),
  disclosure_ceiling: IdentifierSchema,
  license_policy_ref: IdentifierSchema,
  expires_at: IsoDateTimeSchema.optional(),
  decision: z.enum(["ADMITTED", "QUARANTINED", "REJECTED"]),
  reason_codes: z.array(IdentifierSchema),
  decision_receipt_ref: IdentifierSchema,
}).strict();
export type SourceAdmissionDecision = z.infer<typeof SourceAdmissionDecisionSchema>;

export const SourceCurrentnessSchema = z.object({
  source_revision_ref: IdentifierSchema,
  owner_system_id: IdentifierSchema,
  source_owner_generation: IdentifierSchema,
  source_view_ref: IdentifierSchema,
  workspace_view_revision_ref: IdentifierSchema.optional(),
  observation_freshness: z.enum(["current_confirmed", "observed_with_age", "gap_detected", "unknown"]),
  observed_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema.optional(),
  gap_refs: z.array(IdentifierSchema),
}).strict();
export type SourceCurrentness = z.infer<typeof SourceCurrentnessSchema>;

export const SourceRevisionSchema = z.object({
  source_revision_ref: IdentifierSchema,
  source_id: IdentifierSchema,
  source_namespace_id: IdentifierSchema,
  source_owner_system_id: IdentifierSchema,
  source_owner_generation: IdentifierSchema,
  ownership_mode: OwnershipModeSchema,
  content_sha256: Sha256Schema,
  object_residency_key_digest: Sha256Schema,
  original_object_ref: IdentifierSchema.optional(),
  normalized_artifact_ref: IdentifierSchema.optional(),
  captured_at: IsoDateTimeSchema,
  parser_profile_generation: IdentifierSchema.optional(),
  quality_state: z.enum(["high_fidelity", "standard", "degraded", "unqualified"]),
  purge_state: z.enum(["LIVE", "QUARANTINED", "PURGE_REQUESTED", "REDACTED", "RETENTION_BLOCKED"]),
}).strict();
export type SourceRevision = z.infer<typeof SourceRevisionSchema>;
