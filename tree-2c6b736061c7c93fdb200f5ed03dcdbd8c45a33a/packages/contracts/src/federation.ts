import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, Sha256Schema, VersionedRefSchema } from "./common.js";
import { CompletionDispositionSchema, CoverageReceiptSchema, EvidenceGradeSchema, UnsupportedPrecisionItemSchema } from "./research.js";
import { ScopeExpressionSchema } from "./scope.js";

export const FederationTransportStateSchema = z.enum(["ACCEPTED", "RUNNING", "PARTIAL", "BLOCKED", "CANCELLED", "COMPLETED", "FAILED"]);

export const FederationRequestSchema = z.object({
  protocol: z.literal("eliotr.federation.v1"),
  exchange_id: IdentifierSchema,
  bridge_generation: IdentifierSchema,
  idempotency_key: IdentifierSchema,
  requester_principal_ref: IdentifierSchema,
  client_fence_ref: IdentifierSchema,
  question: z.string().min(1),
  scope_expression: ScopeExpressionSchema,
  expected_decision_or_artifact: z.string().min(1),
  source_classes: z.array(IdentifierSchema),
  coverage_goal: z.enum(["exploratory", "representative", "high_recall", "exhaustive"]),
  allowed_input_handle_refs: z.array(VersionedRefSchema),
  export_manifest_ref: IdentifierSchema.optional(),
  privacy_policy_ref: IdentifierSchema,
  disclosure_policy_ref: IdentifierSchema,
  retention_policy_ref: IdentifierSchema,
  license_policy_ref: IdentifierSchema,
  residency_profile_ref: IdentifierSchema,
  budget_ref: IdentifierSchema,
  deadline: IsoDateTimeSchema,
  stop_rule_ref: IdentifierSchema,
  progress_contract_ref: IdentifierSchema,
  required_result_schema_ref: IdentifierSchema,
  evidence_grade: EvidenceGradeSchema,
}).strict();
export type FederationRequest = z.infer<typeof FederationRequestSchema>;

export const FederationEvidenceBundleSchema = z.object({
  protocol: z.literal("eliotr.federation.v1"),
  exchange_id: IdentifierSchema,
  request_digest: Sha256Schema,
  job_id: IdentifierSchema,
  system_generation: IdentifierSchema,
  immutable_bundle_digest: Sha256Schema,
  origin_authentication_ref: IdentifierSchema,
  source_owner_generations: z.record(IdentifierSchema, IdentifierSchema),
  source_catalog_snapshot_refs: z.array(VersionedRefSchema),
  exact_citation_handle_refs: z.array(VersionedRefSchema),
  claim_counterclaim_matrix_ref: IdentifierSchema,
  independence_matrix_ref: IdentifierSchema,
  bounded_excerpt_refs: z.array(IdentifierSchema),
  artifact_handle_refs: z.array(VersionedRefSchema),
  coverage_receipt: CoverageReceiptSchema,
  unknowns: z.array(z.string()),
  failed_acquisition_refs: z.array(IdentifierSchema),
  research_debt_refs: z.array(VersionedRefSchema),
  completion_disposition: CompletionDispositionSchema,
  reopen_conditions: z.array(z.string()),
  synthesis_candidate_ref: IdentifierSchema.optional(),
  synthesis_is_candidate: z.literal(true),
  disclosure_ref: IdentifierSchema,
  retention_ref: IdentifierSchema,
  expires_at: IsoDateTimeSchema,
  invalidation_ref: IdentifierSchema.optional(),
  unsupported_precision: z.array(UnsupportedPrecisionItemSchema),
}).strict();
export type FederationEvidenceBundle = z.infer<typeof FederationEvidenceBundleSchema>;

export const FederationJobStatusSchema = z.object({
  exchange_id: IdentifierSchema,
  idempotency_key: IdentifierSchema,
  job_id: IdentifierSchema,
  attempt: z.number().int().positive(),
  transport_state: FederationTransportStateSchema,
  completion_disposition: CompletionDispositionSchema.nullable(),
  progress_cursor: IdentifierSchema.optional(),
  completed_obligation_refs: z.array(VersionedRefSchema),
  partial_bundle_refs: z.array(IdentifierSchema),
  coverage_receipt_ref: VersionedRefSchema.optional(),
  open_research_debt_refs: z.array(VersionedRefSchema),
  cancellation_receipt_ref: IdentifierSchema.optional(),
  terminal_receipt_ref: IdentifierSchema.optional(),
}).strict();
export type FederationJobStatus = z.infer<typeof FederationJobStatusSchema>;
