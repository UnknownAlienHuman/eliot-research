import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, PositiveIntegerSchema, Sha256Schema, VersionedRefSchema } from "./common.js";
import { EvidenceHandleSchema } from "./evidence.js";
import { ScopeSnapshotSchema } from "./scope.js";


interface CoverageReceiptRefinementValue {
  readonly terminal_disposition: string;
  readonly denominator_kind: "complete_scope" | "sampled_with_method" | "unknown";
}

interface CoverageReceiptRefinementContext {
  addIssue(issue: { readonly code: "custom"; readonly path: readonly (string | number)[]; readonly message: string }): void;
}

export const EvidenceGradeSchema = z.enum(["E0", "E1", "E2", "E3"]);
export type EvidenceGrade = z.infer<typeof EvidenceGradeSchema>;

export const InquiryLaneSchema = z.enum(["confirmatory", "exploratory", "mixed_with_declared_split"]);
export const InquiryProtocolKindSchema = z.enum([
  "lookup", "evidence_review", "causal_diagnosis", "formal_proof", "program_synthesis",
  "architecture_decision", "algorithm_search", "empirical_discovery", "theory_development", "decision_support",
]);
export const CoverageGoalSchema = z.enum(["exploratory", "representative", "high_recall", "exhaustive"]);

export const CompletionDispositionSchema = z.enum([
  "ANSWERED_WITH_SUPPORTED_RESULT",
  "NO_MATCH_IN_COMPLETE_SCOPE",
  "NO_NEW_USEFUL_EVIDENCE",
  "SOURCE_UNAVAILABLE",
  "STALE_SOURCE_OR_INDEX",
  "POLICY_OR_DISCLOSURE_DENIED",
  "INCOMPLETE_COVERAGE",
  "INCONCLUSIVE",
  "CANCELLED",
]);
export type CompletionDisposition = z.infer<typeof CompletionDispositionSchema>;

export const ResearchWorkflowStageSchema = z.enum([
  "FREEZE_PROTOCOL_AND_SCOPE", "ORIENT", "INTERPRET", "COMPILE_OBLIGATIONS", "PLAN",
  "RETRIEVE_BRANCHES", "ACQUIRE_AND_CAPTURE", "READ_AND_EXTRACT", "ANALYZE_BRANCHES",
  "COUNTER_SEARCH", "RECONCILE", "FREEZE_EVIDENCE", "SYNTHESIZE", "VERIFY",
  "AUDIT_CLAIMS", "RESOLVE_CITATIONS", "CALCULATE_COVERAGE", "MATERIALIZE",
]);
export type ResearchWorkflowStage = z.infer<typeof ResearchWorkflowStageSchema>;

export const InquiryProtocolProfileSchema = z.object({
  profile_ref: VersionedRefSchema,
  question: z.string().min(1),
  intended_decision_or_artifact: z.string().min(1),
  protocol: InquiryProtocolKindSchema,
  evidence_grade: EvidenceGradeSchema,
  lane: InquiryLaneSchema,
  source_mode: z.enum(["corpus_only", "corpus_plus_web", "web_discovery"]),
  admissible_provider_classes: z.array(IdentifierSchema),
  truth_surfaces: z.array(IdentifierSchema),
  source_policy: z.object({
    primary_required: z.boolean(),
    peer_reviewed_preferred: z.boolean(),
    authority_classes: z.array(IdentifierSchema),
    excluded_classes: z.array(IdentifierSchema),
  }).strict(),
  coverage_goal: CoverageGoalSchema,
  alternatives_required: z.boolean(),
  counter_search_required: z.boolean(),
  falsification_required: z.boolean(),
  independence_policy_ref: IdentifierSchema,
  chronology_policy_ref: IdentifierSchema,
  fidelity_ceiling: IdentifierSchema,
  model_profile_ref: IdentifierSchema,
  budget_ref: IdentifierSchema,
  deadline: IsoDateTimeSchema.optional(),
  stop_rule_ref: IdentifierSchema,
  output_contract_ref: IdentifierSchema,
  reopen_conditions: z.array(z.string()),
}).strict();
export type InquiryProtocolProfile = z.infer<typeof InquiryProtocolProfileSchema>;

export const ResearchDebtSchema = z.object({
  debt_ref: VersionedRefSchema,
  kind: z.enum(["epistemic", "verification", "replication", "coverage", "contradiction", "fidelity", "provenance", "authority"]),
  blocked_refs: z.array(IdentifierSchema),
  basis_and_evidence_refs: z.array(IdentifierSchema),
  owner: IdentifierSchema,
  blocking_effect: z.string().min(1),
  next_probe: z.string().min(1),
  review_condition: z.string().min(1),
  expires_at: IsoDateTimeSchema.optional(),
  status: z.enum(["OPEN", "RESOLVED", "WAIVED", "SUPERSEDED"]),
  resolution_or_waiver_receipt_ref: IdentifierSchema.optional(),
}).strict();
export type ResearchDebt = z.infer<typeof ResearchDebtSchema>;

export const EvidenceFreezeSchema = z.object({
  freeze_ref: VersionedRefSchema,
  scope_snapshot_ref: VersionedRefSchema,
  client_fence_ref: IdentifierSchema.optional(),
  coverage_denominator_ref: VersionedRefSchema,
  contract_protocol_digest: Sha256Schema,
  lane_digest: Sha256Schema,
  included_evidence: z.array(z.object({ handle_ref: VersionedRefSchema, digest: Sha256Schema }).strict()),
  excluded_evidence: z.array(z.object({ evidence_ref: IdentifierSchema, reason: IdentifierSchema }).strict()),
  unresolved_contradiction_refs: z.array(IdentifierSchema),
  open_research_debt_refs: z.array(VersionedRefSchema),
  provider_model_prompt_tool_generations: z.record(IdentifierSchema, IdentifierSchema),
  frozen_at: IsoDateTimeSchema,
}).strict();
export type EvidenceFreeze = z.infer<typeof EvidenceFreezeSchema>;

export const ClaimAuditDispositionSchema = z.enum([
  "SUPPORTED", "PARTIALLY_SUPPORTED", "UNSUPPORTED", "CONTRADICTED", "NOT_VERIFIABLE_IN_SCOPE",
]);
export const UnsupportedPrecisionItemSchema = z.object({
  asserted_reference_or_coordinate: z.string(),
  highest_supported_precision: z.string(),
  source_and_coverage_basis: z.array(IdentifierSchema),
  risk_of_false_precision: z.string(),
  required_probe_or_narrower_wording: z.string(),
}).strict();
export type UnsupportedPrecisionItem = z.infer<typeof UnsupportedPrecisionItemSchema>;

export const ClaimAuditItemSchema = z.object({
  claim_id: IdentifierSchema,
  claim_text_digest: Sha256Schema,
  claim_kind: z.enum(["observation", "interpretation", "assumption", "recommendation"]),
  exact_support_handles: z.array(EvidenceHandleSchema),
  counterevidence_handles: z.array(EvidenceHandleSchema),
  reference_verification: z.enum(["PASS", "FAIL", "NOT_APPLICABLE"]),
  value_or_measurement_verification: z.enum(["PASS", "FAIL", "NOT_APPLICABLE"]),
  specification_compliance: z.enum(["PASS", "FAIL", "NOT_APPLICABLE"]),
  method_artifact_alignment: z.enum(["PASS", "FAIL", "NOT_APPLICABLE"]),
  source_satisfies_requirement: z.boolean(),
  supplied_excerpt_supports_requirement: z.boolean(),
  independence_and_fidelity_notes: z.array(z.string()),
  evidence_grade: EvidenceGradeSchema,
  lane: InquiryLaneSchema,
  coverage_limitations: z.array(z.string()),
  unsupported_precision: z.array(UnsupportedPrecisionItemSchema),
  disposition: ClaimAuditDispositionSchema,
}).strict();
export type ClaimAuditItem = z.infer<typeof ClaimAuditItemSchema>;

export const CoverageReceiptSchema = z.object({
  receipt_ref: VersionedRefSchema,
  requested_scope_expression: z.unknown(),
  frozen_scope_snapshot_ref: VersionedRefSchema,
  coverage_denominator_ref: VersionedRefSchema,
  denominator_kind: z.enum(["complete_scope", "sampled_with_method", "unknown"]),
  eligible_source_refs: z.array(IdentifierSchema),
  represented_source_refs: z.array(IdentifierSchema),
  cited_source_refs: z.array(IdentifierSchema),
  omitted_sources: z.array(z.object({ source_ref: IdentifierSchema, reason: IdentifierSchema }).strict()),
  unknown_coverage_reason: z.string().optional(),
  source_families_and_independence_profile_ref: IdentifierSchema,
  lanes_used: z.array(IdentifierSchema),
  stale_or_skipped_lanes: z.array(IdentifierSchema),
  failed_acquisition_refs: z.array(IdentifierSchema),
  provider_degradation_refs: z.array(IdentifierSchema),
  parser_degradation_refs: z.array(IdentifierSchema),
  redacted_dependency_refs: z.array(IdentifierSchema),
  counter_search_status: z.enum(["NOT_REQUIRED", "NOT_RUN", "PARTIAL", "COMPLETE"]),
  budget_limitations: z.array(z.string()),
  terminal_disposition: CompletionDispositionSchema,
}).strict().superRefine((value: CoverageReceiptRefinementValue, context: CoverageReceiptRefinementContext) => {
  if (value.terminal_disposition === "NO_MATCH_IN_COMPLETE_SCOPE" && value.denominator_kind !== "complete_scope") {
    context.addIssue({ code: "custom", path: ["terminal_disposition"], message: "absence requires complete_scope denominator" });
  }
});
export type CoverageReceipt = z.infer<typeof CoverageReceiptSchema>;

export const InvestigationSchema = z.object({
  investigation_ref: VersionedRefSchema,
  goal: z.string().min(1),
  intended_decision_or_artifact: z.string().min(1),
  interpretations: z.array(z.string()),
  scope_snapshot: ScopeSnapshotSchema,
  inquiry_protocol_ref: VersionedRefSchema,
  evidence_grade: EvidenceGradeSchema,
  lane_registration_refs: z.array(VersionedRefSchema),
  source_portfolio_ref: VersionedRefSchema.optional(),
  coverage_denominator_ref: VersionedRefSchema.optional(),
  obligation_refs: z.array(VersionedRefSchema),
  hypothesis_refs: z.array(VersionedRefSchema),
  branch_refs: z.array(VersionedRefSchema),
  evidence_handle_refs: z.array(VersionedRefSchema),
  counterevidence_handle_refs: z.array(VersionedRefSchema),
  contradiction_refs: z.array(VersionedRefSchema),
  unknowns: z.array(z.string()),
  research_debt_refs: z.array(VersionedRefSchema),
  evidence_freeze_ref: VersionedRefSchema.optional(),
  claim_audit_ref: VersionedRefSchema.optional(),
  artifact_refs: z.array(VersionedRefSchema),
  model_profile_ref: IdentifierSchema,
  execution_product: z.enum(["ASK", "BRIEF", "COMPARE", "HYPOTHESIS_REVIEW", "FACT_CHECK", "PROJECT_VS_LITERATURE_AUDIT", "DEEP_RESEARCH", "REPORT"]),
  budget_ref: IdentifierSchema,
  stop_rule_ref: IdentifierSchema,
  current_stage: ResearchWorkflowStageSchema,
  terminal_disposition: CompletionDispositionSchema.optional(),
  reopen_conditions: z.array(z.string()),
  parent_investigation_ref: VersionedRefSchema.optional(),
  created_at: IsoDateTimeSchema,
  revision: PositiveIntegerSchema,
}).strict();
export type Investigation = z.infer<typeof InvestigationSchema>;
