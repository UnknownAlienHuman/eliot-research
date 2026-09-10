import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, PositiveIntegerSchema, VersionedRefSchema } from "./common.js";

export const StoragePolicySchema = z.enum([
  "ORIGINAL_CLOUD", "NORMALIZED_CLOUD_ONLY", "METADATA_ONLY", "LOCAL_FEDERATED", "REDACTED_CLOUD_COPY",
]);
export const ClientClassSchema = z.enum([
  "owner_pwa", "named_api_client", "trusted_agent", "chatgpt_drive_exchange", "public_demo",
]);

export const PolicyDecisionInputSchema = z.object({
  principal_ref: IdentifierSchema,
  client_class: ClientClassSchema,
  operation: IdentifierSchema,
  scope_snapshot_ref: VersionedRefSchema,
  source_revision_refs: z.array(IdentifierSchema),
  model_route_ref: IdentifierSchema.optional(),
  requested_output_class: IdentifierSchema,
  purpose: z.string().min(1),
}).strict();
export type PolicyDecisionInput = z.infer<typeof PolicyDecisionInputSchema>;

export const PolicyDecisionSchema = z.object({
  decision_id: IdentifierSchema,
  policy_revision: PositiveIntegerSchema,
  decision: z.enum(["ALLOW", "ALLOW_WITH_MINIMIZATION", "DENY"]),
  reason_codes: z.array(IdentifierSchema),
  admitted_source_revision_refs: z.array(IdentifierSchema),
  denied_source_revision_refs: z.array(IdentifierSchema),
  inference_route_ref: IdentifierSchema.optional(),
  output_disclosure_ceiling: IdentifierSchema,
  expires_at: IsoDateTimeSchema,
}).strict();
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const AllowedReferenceManifestSchema = z.object({
  manifest_ref: VersionedRefSchema,
  scope_snapshot_ref: VersionedRefSchema,
  allowed_source_revision_refs: z.array(IdentifierSchema),
  allowed_evidence_handle_refs: z.array(VersionedRefSchema),
  allowed_tool_definition_refs: z.array(IdentifierSchema),
  allowed_verifier_refs: z.array(IdentifierSchema),
  permitted_anchor_and_precision_ceilings: z.array(IdentifierSchema),
  provider_and_policy_generations: z.record(IdentifierSchema, IdentifierSchema),
  stale_or_revoked_entries: z.array(IdentifierSchema),
  permitted_acquisition_or_expansion_routes: z.array(IdentifierSchema),
  disclosure_ceiling: IdentifierSchema,
  allowed_use: z.array(IdentifierSchema),
  expires_at: IsoDateTimeSchema,
  manifest_digest: z.string().regex(/^[a-f0-9]{64}$/),
  client_fence_ref: IdentifierSchema.optional(),
}).strict();
export type AllowedReferenceManifest = z.infer<typeof AllowedReferenceManifestSchema>;
