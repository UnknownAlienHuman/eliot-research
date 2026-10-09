import { z } from "zod";
import { IdentifierSchema, Sha256Schema, VersionedRefSchema } from "./common.js";
import { ResolvedEvidenceSchema } from "./evidence.js";
import { EvidenceFreezeSchema, ResearchDebtSchema } from "./research.js";
import { BranchQueryPlanSchema, branchQueryLegsMatchPlan, branchQueryLegOutcomeIsConsistent } from "./research-branch-query.js";
import { ResearchBranchRoleSchema } from "./research-branch-role.js";
import { branchDebtsMatchBlockedRoles, sameStrings } from "./research-branch-invariants.js";

function refKey(ref: { readonly id: string; readonly revision: number }): string {
  return `${ref.id}:${ref.revision}`;
}

export const BranchFindingKindSchema = z.enum([
  "SUPPORT",
  "COUNTEREVIDENCE",
  "ALTERNATIVE",
  "CHRONOLOGY",
  "IMPLEMENTATION",
  "SOURCE_QUALITY",
  "OTHER",
]);
export type BranchFindingKind = z.infer<typeof BranchFindingKindSchema>;

/** Untrusted model-authored finding content; the server supplies identity and exact question binding. */
export const BranchFindingDraftSchema = z.object({
  protocol: z.literal("eliotr.research.branch-finding-draft.v1"),
  role: ResearchBranchRoleSchema,
  question_ref: VersionedRefSchema,
  question_sha256: Sha256Schema,
  kind: BranchFindingKindSchema,
  state: z.enum(["CANDIDATE", "BLOCKED"]),
  statement: z.string().max(8_192),
  conditions: z.array(z.string().min(1).max(1_024)).max(32),
  scope: z.string().min(1).max(2_048),
  evidence_handle_refs: z.array(VersionedRefSchema).max(64),
  unknowns: z.array(z.string().min(1).max(1_024)).max(64),
  limitations: z.array(z.string().min(1).max(1_024)).max(64),
}).strict().superRefine((value, context) => {
  if (value.question_ref.revision !== 1 ||
      new Set(value.evidence_handle_refs.map(refKey)).size !== value.evidence_handle_refs.length) {
    context.addIssue({ code: "custom", path: ["question_ref"], message: "finding draft question or evidence refs are invalid" });
  }
  if (value.state === "CANDIDATE" && (value.statement.trim().length === 0 || value.evidence_handle_refs.length === 0)) {
    context.addIssue({ code: "custom", path: ["state"], message: "candidate finding draft requires a statement and exact evidence" });
  }
  if (value.state === "BLOCKED" && (value.statement.trim().length !== 0 || value.evidence_handle_refs.length !== 0)) {
    context.addIssue({ code: "custom", path: ["state"], message: "blocked finding draft cannot carry a claim or evidence" });
  }
});
export type BranchFindingDraft = z.infer<typeof BranchFindingDraftSchema>;

export const BranchFindingCandidateSchema = z.object({
  protocol: z.literal("eliotr.research.branch-finding.v1"),
  finding_ref: VersionedRefSchema,
  identity_digest: Sha256Schema,
  role: ResearchBranchRoleSchema,
  question_ref: VersionedRefSchema,
  question_sha256: Sha256Schema,
  kind: BranchFindingKindSchema,
  state: z.enum(["CANDIDATE", "BLOCKED"]),
  statement: z.string().max(8_192),
  conditions: z.array(z.string().min(1).max(1_024)).max(32),
  scope: z.string().min(1).max(2_048),
  evidence_handle_refs: z.array(VersionedRefSchema).max(64),
  unknowns: z.array(z.string().min(1).max(1_024)).max(64),
  limitations: z.array(z.string().min(1).max(1_024)).max(64),
}).strict().superRefine((value, context) => {
  if (value.finding_ref.id !== `eliotr.research.branch-finding-${value.identity_digest}` || value.finding_ref.revision !== 1 ||
      value.question_ref.revision !== 1) {
    context.addIssue({ code: "custom", path: ["finding_ref"], message: "finding identity mismatch" });
  }
  if (new Set(value.evidence_handle_refs.map(refKey)).size !== value.evidence_handle_refs.length) {
    context.addIssue({ code: "custom", path: ["evidence_handle_refs"], message: "finding contains duplicate evidence handles" });
  }
  if (value.state === "CANDIDATE" && (value.statement.trim().length === 0 || value.evidence_handle_refs.length === 0)) {
    context.addIssue({ code: "custom", path: ["state"], message: "candidate finding requires a statement and exact evidence" });
  }
  if (value.state === "BLOCKED" && (value.statement.trim().length !== 0 || value.evidence_handle_refs.length !== 0)) {
    context.addIssue({ code: "custom", path: ["state"], message: "blocked finding cannot carry a claim or evidence" });
  }
});
export type BranchFindingCandidate = z.infer<typeof BranchFindingCandidateSchema>;

const FrozenQueryHandleSchema = z.object({
  handle_ref: VersionedRefSchema,
  excerpt_sha256: Sha256Schema,
  excerpt_byte_length: z.number().int().nonnegative().max(8 * 1024 * 1024),
}).strict();

const FrozenOmittedCandidateSchema = z.object({
  candidate_id: IdentifierSchema,
  reason_code: IdentifierSchema,
}).strict();

const FrozenRetrievalLegSchema = z.object({
  query_id: IdentifierSchema,
  query_sha256: Sha256Schema,
  retrieval_request_digest: Sha256Schema,
  scope_snapshot_ref: VersionedRefSchema,
  scope_snapshot_digest: Sha256Schema,
  status: z.enum(["COMPLETED", "FAILED"]),
  trace_ref: VersionedRefSchema.optional(),
  trace_sha256: Sha256Schema.optional(),
  failure_code: IdentifierSchema.optional(),
  stop_reason: z.string().min(1).max(64),
  resolved_handle_refs: z.array(FrozenQueryHandleSchema).max(64),
  omitted_candidates: z.array(FrozenOmittedCandidateSchema).max(512),
}).strict().superRefine((value, context) => {
  if ((value.trace_ref === undefined) !== (value.trace_sha256 === undefined) ||
      (value.trace_ref !== undefined && value.trace_ref.revision !== 1) ||
      new Set(value.resolved_handle_refs.map((item) => refKey(item.handle_ref))).size !== value.resolved_handle_refs.length ||
      (value.status === "COMPLETED" && (value.trace_ref === undefined || value.failure_code !== undefined)) ||
      (value.status === "FAILED" && (value.failure_code === undefined || value.trace_ref !== undefined || value.resolved_handle_refs.length !== 0)) ||
      new Set(value.omitted_candidates.map((item) => JSON.stringify([item.candidate_id, item.reason_code]))).size !== value.omitted_candidates.length ||
      !branchQueryLegOutcomeIsConsistent(value)) {
    context.addIssue({ code: "custom", path: ["status"], message: "frozen query leg status/provenance is inconsistent" });
  }
});

const FrozenBranchRoleSchema = z.object({
  role: ResearchBranchRoleSchema,
  branch_ref: VersionedRefSchema,
  status: z.enum(["CANDIDATE_READY", "BLOCKED"]),
  query_plan: BranchQueryPlanSchema,
  query_result_ref: VersionedRefSchema,
  query_result_digest: Sha256Schema,
  failure_disposition: z.enum(["NONE", "PARTIAL", "ALL_FAILED"]),
  stop_reason: z.enum(["PLAN_COMPLETED", "FIRST_ADMISSIBLE_EVIDENCE", "NO_HITS", "BUDGET_EXHAUSTED", "ALL_LEGS_FAILED"]),
  scope_snapshot_ref: VersionedRefSchema,
  scope_snapshot_digest: Sha256Schema,
  omitted_candidate_refs: z.array(IdentifierSchema).max(2_048),
  retrieval_legs: z.array(FrozenRetrievalLegSchema).min(1).max(4),
  finding_refs: z.array(VersionedRefSchema).max(64),
}).strict();

const FrozenBranchOmissionsSchema = z.object({
  role: ResearchBranchRoleSchema,
  omitted_candidate_refs: z.array(IdentifierSchema).max(2_048),
}).strict();

/** Verbatim authority summary copied from the committed v2 reconciliation checkpoint. */
export const EvidenceFreezeBranchReconciliationSummarySchema = z.object({
  protocol: z.literal("eliotr.research.branch-reconciliation.v2"),
  checkpoint_ref: VersionedRefSchema,
  identity_digest: Sha256Schema,
  operation_id: IdentifierSchema,
  investigation_ref: VersionedRefSchema,
  principal_ref: IdentifierSchema,
  scope_snapshot_ref: VersionedRefSchema,
  inquiry_protocol_ref: VersionedRefSchema,
  protocol_digest: Sha256Schema,
  planning_manifest_ref: VersionedRefSchema,
  planning_manifest_digest: Sha256Schema,
  branch_analysis_ref: VersionedRefSchema,
  required_roles: z.array(ResearchBranchRoleSchema).max(16),
  unmet_required_roles: z.array(ResearchBranchRoleSchema).max(16),
  unresolved_contradiction_refs: z.array(IdentifierSchema).max(512),
  research_debts: z.array(ResearchDebtSchema).max(16),
  counter_search_status: z.enum(["NOT_REQUIRED", "PARTIAL", "COMPLETE"]),
  omissions: z.array(FrozenBranchOmissionsSchema).max(16),
  created_at: z.string().datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  if (value.checkpoint_ref.id !== `eliotr.research.branch-reconciliation-v2-${value.identity_digest}` ||
      value.checkpoint_ref.revision !== 1 ||
      new Set(value.required_roles).size !== value.required_roles.length ||
      new Set(value.unmet_required_roles).size !== value.unmet_required_roles.length ||
      new Set(value.unresolved_contradiction_refs).size !== value.unresolved_contradiction_refs.length ||
      new Set(value.research_debts.map((debt) => refKey(debt.debt_ref))).size !== value.research_debts.length ||
      new Set(value.omissions.map((item) => item.role)).size !== value.omissions.length) {
    context.addIssue({ code: "custom", path: ["checkpoint_ref"], message: "frozen reconciliation summary identity or uniqueness is invalid" });
  }
  if (value.unmet_required_roles.some((role) => !value.required_roles.includes(role)) ||
      !sameStrings(value.omissions.map((item) => item.role), value.required_roles) ||
      !branchDebtsMatchBlockedRoles(value.research_debts, value.unmet_required_roles)) {
    context.addIssue({ code: "custom", path: ["research_debts"], message: "frozen debts do not correspond to blocked required roles" });
  }
  const counterRequired = value.required_roles.includes("COUNTER");
  if ((!counterRequired && value.counter_search_status !== "NOT_REQUIRED") ||
      (counterRequired && value.counter_search_status === "NOT_REQUIRED")) {
    context.addIssue({ code: "custom", path: ["counter_search_status"], message: "frozen counter status differs from required roles" });
  }
});
export type EvidenceFreezeBranchReconciliationSummary = z.infer<typeof EvidenceFreezeBranchReconciliationSummarySchema>;

const EvidenceFreezeBranchFindingsFields = {
  protocol: z.literal("eliotr.research.evidence-freeze-branch-findings.v1"),
  reconciliation_ref: VersionedRefSchema,
  reconciliation_digest: Sha256Schema,
  reconciliation_summary: EvidenceFreezeBranchReconciliationSummarySchema,
  roles: z.array(FrozenBranchRoleSchema).max(16),
  findings: z.array(BranchFindingCandidateSchema).max(256),
} as const;

function validateBranchFindingsProvenance(
  value: z.infer<z.ZodObject<typeof EvidenceFreezeBranchFindingsFields>>,
  context: z.RefinementCtx,
): void {
  const summary = value.reconciliation_summary;
  const roleNames = value.roles.map((role) => role.role);
  const expectedOmissions = value.roles.map((role) => ({
    role: role.role,
    omitted_candidate_refs: role.omitted_candidate_refs,
  }));
  if (value.reconciliation_ref.id !== summary.checkpoint_ref.id ||
      value.reconciliation_ref.revision !== summary.checkpoint_ref.revision ||
      value.reconciliation_digest !== summary.identity_digest ||
      new Set(roleNames).size !== roleNames.length ||
      !sameStrings(roleNames, summary.required_roles) ||
      !sameStrings(value.roles.filter((role) => role.status === "BLOCKED").map((role) => role.role), summary.unmet_required_roles) ||
      JSON.stringify([...expectedOmissions].sort((left, right) => left.role.localeCompare(right.role))) !==
        JSON.stringify([...summary.omissions].sort((left, right) => left.role.localeCompare(right.role))) ||
      value.roles.some((role) => role.query_plan.role !== role.role ||
        role.query_plan.required !== summary.required_roles.includes(role.role) ||
        role.branch_ref.id !== role.query_plan.branch_ref.id || role.branch_ref.revision !== role.query_plan.branch_ref.revision ||
        role.query_result_ref.id !== `eliotr.research.branch-query-result-${role.query_result_digest}` ||
        role.query_result_ref.revision !== 1 || role.scope_snapshot_ref.id !== role.query_plan.scope_snapshot_ref.id ||
        role.scope_snapshot_ref.revision !== role.query_plan.scope_snapshot_ref.revision ||
        role.scope_snapshot_digest !== role.query_plan.scope_snapshot_digest ||
        refKey(role.scope_snapshot_ref) !== refKey(summary.scope_snapshot_ref) ||
        refKey(role.query_plan.planning_manifest_ref) !== refKey(summary.planning_manifest_ref) ||
        role.query_plan.planning_manifest_digest !== summary.planning_manifest_digest ||
        refKey(role.query_plan.inquiry_protocol_ref) !== refKey(summary.inquiry_protocol_ref) ||
        role.query_plan.protocol_digest !== summary.protocol_digest ||
        value.roles.some((other) => other.scope_snapshot_digest !== role.scope_snapshot_digest) ||
        !branchQueryLegsMatchPlan(role.query_plan, role.retrieval_legs, role.stop_reason,
          role.retrieval_legs.some((leg) => leg.resolved_handle_refs.length > 0)) ||
        role.finding_refs.length > 64 || new Set(role.finding_refs.map(refKey)).size !== role.finding_refs.length ||
        new Set(role.omitted_candidate_refs).size !== role.omitted_candidate_refs.length ||
        !sameStrings([...new Set(role.retrieval_legs.flatMap((leg) => leg.omitted_candidates.map((item) => item.candidate_id)))],
          role.omitted_candidate_refs) ||
        new Set(role.retrieval_legs.map((leg) => leg.query_id)).size !== role.retrieval_legs.length ||
        role.retrieval_legs.some((leg) => leg.scope_snapshot_ref.id !== role.scope_snapshot_ref.id ||
          leg.scope_snapshot_ref.revision !== role.scope_snapshot_ref.revision ||
          leg.scope_snapshot_digest !== role.scope_snapshot_digest ||
          !role.query_plan.query_legs.some((planned) => planned.query_id === leg.query_id &&
            planned.query_sha256 === leg.query_sha256)) ||
        role.failure_disposition !== (role.retrieval_legs.every((leg) => leg.status === "COMPLETED") ? "NONE" :
          role.retrieval_legs.every((leg) => leg.status === "FAILED") ? "ALL_FAILED" : "PARTIAL"))) {
    context.addIssue({ code: "custom", path: ["reconciliation_summary"], message: "frozen branch provenance differs from reconciliation authority" });
  }
  const findingRefs = value.findings.map((finding) => refKey(finding.finding_ref));
  const declaredFindingRefs = value.roles.flatMap((role) => role.finding_refs.map(refKey));
  const roleByFinding = new Map(value.roles.flatMap((role) => role.finding_refs.map((ref) => [refKey(ref), role] as const)));
  const counter = value.roles.find((role) => role.role === "COUNTER");
  const expectedCounter = !summary.required_roles.includes("COUNTER") ? "NOT_REQUIRED" :
    counter?.status === "CANDIDATE_READY" ? "COMPLETE" : "PARTIAL";
  if (summary.counter_search_status !== expectedCounter ||
      value.roles.some((role) => {
        const findings = value.findings.filter((finding) => role.finding_refs.some((ref) => refKey(ref) === refKey(finding.finding_ref)));
        return role.status === "CANDIDATE_READY" ? !findings.some((finding) => finding.state === "CANDIDATE") :
          findings.some((finding) => finding.state === "CANDIDATE");
      }) ||
      summary.research_debts.some((debt) => {
        const findings = value.findings.filter((finding) => finding.role === debt.blocked_refs[0]);
        const handles = [...new Set(findings.flatMap((finding) => finding.evidence_handle_refs.map(refKey)))].sort();
        return !sameStrings(debt.basis_and_evidence_refs, handles);
      })) {
    context.addIssue({ code: "custom", path: ["roles"], message: "frozen readiness, counter status or debt evidence differs from findings" });
  }
  if (new Set(findingRefs).size !== findingRefs.length ||
      new Set(declaredFindingRefs).size !== declaredFindingRefs.length ||
      findingRefs.length !== declaredFindingRefs.length ||
      findingRefs.some((ref) => !declaredFindingRefs.includes(ref)) ||
      value.findings.some((finding) => {
        const role = roleByFinding.get(refKey(finding.finding_ref));
        const queriedRefs = new Set(role?.retrieval_legs.flatMap((leg) => leg.resolved_handle_refs.map((item) =>
          refKey(item.handle_ref))));
        return role === undefined || role.role !== finding.role ||
          finding.question_ref.id !== role.query_plan.branch_question.question_ref.id ||
          finding.question_ref.revision !== role.query_plan.branch_question.question_ref.revision ||
          finding.question_sha256 !== role.query_plan.branch_question.text_sha256 ||
          finding.evidence_handle_refs.some((ref) => !queriedRefs.has(refKey(ref)));
      })) {
    context.addIssue({ code: "custom", path: ["findings"], message: "frozen findings do not match their branch provenance" });
  }
}

/** Strict provenance material shared by the stage writer and the final v3 freeze. */
export const EvidenceFreezeBranchFindingsProvenanceSchema = z.object(EvidenceFreezeBranchFindingsFields).strict()
  .superRefine(validateBranchFindingsProvenance);
export type EvidenceFreezeBranchFindingsProvenance = z.infer<typeof EvidenceFreezeBranchFindingsProvenanceSchema>;

/** Compact, identity-bound finding and retrieval provenance embedded in freeze v3. */
export const EvidenceFreezeBranchFindingsSchema = z.object({
  ...EvidenceFreezeBranchFindingsFields,
  resolved_evidence: z.array(ResolvedEvidenceSchema).max(512),
  identity_digest: Sha256Schema,
}).strict().superRefine((value, context) => {
  const evidenceRefs = new Set(value.resolved_evidence.map((item) => refKey(item.handle.handle_ref)));
  const requiredEvidence = value.findings.flatMap((finding) => finding.evidence_handle_refs.map(refKey));
  validateBranchFindingsProvenance(value, context);
  const frozenHandles = value.roles.flatMap((role) => role.retrieval_legs.flatMap((leg) => leg.resolved_handle_refs));
  const evidenceByRef = new Map(value.resolved_evidence.map((item) => [refKey(item.handle.handle_ref), item]));
  const queriedRefs = new Set(frozenHandles.map((item) => refKey(item.handle_ref)));
  if (new Set(value.resolved_evidence.map((item) => refKey(item.handle.handle_ref))).size !== value.resolved_evidence.length ||
      requiredEvidence.some((ref) => !evidenceRefs.has(ref)) ||
      [...evidenceByRef.keys()].some((ref) => !queriedRefs.has(ref)) ||
      frozenHandles.some((frozen) => {
        const item = evidenceByRef.get(refKey(frozen.handle_ref));
        return item === undefined || frozen.excerpt_sha256 !== item.handle.excerpt_sha256 ||
          frozen.excerpt_byte_length !== new TextEncoder().encode(item.exact_excerpt).byteLength;
      }) ||
      value.resolved_evidence.some((item) => refKey(item.handle.scope_snapshot_ref) !==
          refKey(value.reconciliation_summary.scope_snapshot_ref) ||
        value.roles.some((role) => item.scope_snapshot_digest !== role.scope_snapshot_digest) ||
        item.handle.excerpt_byte_length !== new TextEncoder().encode(item.exact_excerpt).byteLength)) {
    context.addIssue({ code: "custom", path: ["resolved_evidence"], message: "frozen exact evidence does not match branch query provenance" });
  }
});
export type EvidenceFreezeBranchFindings = z.infer<typeof EvidenceFreezeBranchFindingsSchema>;

/** New frozen synthesis envelope; its nested v1 freeze stays byte-compatible and immutable. */
export const ResearchEvidenceFreezeV3Schema = z.object({
  protocol: z.literal("eliotr.research.evidence-freeze.v3"),
  freeze: EvidenceFreezeSchema,
  branch_findings: EvidenceFreezeBranchFindingsSchema,
  identity_digest: Sha256Schema,
}).strict().superRefine((value, context) => {
  const included = new Map(value.freeze.included_evidence.map((item) => [refKey(item.handle_ref), item.digest]));
  const resolved = new Map(value.branch_findings.resolved_evidence.map((item) => [
    refKey(item.handle.handle_ref), item.handle.excerpt_sha256,
  ]));
  const reconciliation = value.branch_findings.reconciliation_summary;
  const freezeDebts = value.freeze.open_research_debt_refs.map(refKey).sort();
  const summaryDebts = reconciliation.research_debts.map((debt) => refKey(debt.debt_ref)).sort();
  if (included.size !== value.freeze.included_evidence.length ||
      [...resolved].some(([ref, digest]) => included.get(ref) !== digest) ||
      refKey(reconciliation.scope_snapshot_ref) !== refKey(value.freeze.scope_snapshot_ref) ||
      value.branch_findings.resolved_evidence.some((item) => refKey(item.handle.scope_snapshot_ref) !== refKey(value.freeze.scope_snapshot_ref)) ||
      value.branch_findings.findings.some((finding) => finding.evidence_handle_refs.some((ref) => !resolved.has(refKey(ref)))) ||
      value.freeze.freeze_ref.id.length === 0 ||
      !sameStrings(value.freeze.unresolved_contradiction_refs, reconciliation.unresolved_contradiction_refs) ||
      !sameStrings(freezeDebts, summaryDebts)) {
    context.addIssue({ code: "custom", path: ["branch_findings"], message: "v3 branch findings are outside the frozen exact evidence set" });
  }
});
export type ResearchEvidenceFreezeV3 = z.infer<typeof ResearchEvidenceFreezeV3Schema>;
