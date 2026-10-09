import { z } from "zod";
import { IdentifierSchema, Sha256Schema, VersionedRefSchema } from "./common.js";
import { BranchFindingCandidateSchema } from "./research-branch-finding.js";
import { BranchQueryPlanSchema, BranchQueryResultSchema, branchQueryResultMatchesPlan } from "./research-branch-query.js";
import { ResearchBranchRoleSchema } from "./research-branch-role.js";
import { ResearchDebtSchema } from "./research.js";

export { ResearchBranchRoleSchema } from "./research-branch-role.js";
export type { ResearchBranchRole } from "./research-branch-role.js";

export const ResearchBranchEvidenceItemSchema = z.object({
  handle_ref: VersionedRefSchema,
  source_revision_ref: z.string().min(1).max(256),
  source_id: z.string().min(1).max(256),
  source_class: z.string().min(1).max(256),
  source_namespace_id: z.string().min(1).max(256),
  source_owner_generation: z.string().min(1).max(256),
  source_family_ref: z.string().min(1).max(256),
  independence: z.enum(["KNOWN_SHARED_ORIGIN", "UNKNOWN"]),
  excerpt_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  excerpt_byte_length: z.number().int().nonnegative().max(8 * 1024 * 1024),
  verification_receipt_ref: z.string().min(1).max(256),
  authorization_receipt_ref: z.string().min(1).max(256),
}).strict();
export type ResearchBranchEvidenceItem = z.infer<typeof ResearchBranchEvidenceItemSchema>;

function refKey(value: { readonly id: string; readonly revision: number }): string {
  return `${value.id}:${value.revision}`;
}

function duplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

export const ResearchReadExtractCheckpointSchema = z.object({
  protocol: z.literal("eliotr.research.read-extract.v1"),
  checkpoint_ref: VersionedRefSchema,
  identity_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  operation_id: z.string().min(1).max(128),
  investigation_ref: VersionedRefSchema,
  principal_ref: z.string().min(1).max(256),
  scope_snapshot_ref: VersionedRefSchema,
  inquiry_protocol_ref: VersionedRefSchema,
  protocol_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  planning_manifest_ref: VersionedRefSchema,
  planning_manifest_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  retrieval_request_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  evidence: z.array(ResearchBranchEvidenceItemSchema).max(512),
  omitted_candidate_refs: z.array(z.string().min(1).max(256)).max(512),
  created_at: z.string().datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  if (value.checkpoint_ref.id !== `eliotr.research.read-extract-${value.identity_digest}` || value.checkpoint_ref.revision !== 1) {
    context.addIssue({ code: "custom", path: ["checkpoint_ref"], message: "read/extract checkpoint identity mismatch" });
  }
  if (duplicate(value.evidence.map((item) => refKey(item.handle_ref)))) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "read/extract checkpoint contains duplicate handles" });
  }
  if (duplicate(value.omitted_candidate_refs)) {
    context.addIssue({ code: "custom", path: ["omitted_candidate_refs"], message: "omitted candidates are duplicated" });
  }
});
export type ResearchReadExtractCheckpoint = z.infer<typeof ResearchReadExtractCheckpointSchema>;

/** Additive v2 checkpoint; the legacy v1 checkpoint decoder and bytes remain unchanged. */
export const ResearchReadExtractCheckpointV2Schema = z.object({
  protocol: z.literal("eliotr.research.read-extract.v2"),
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
  role_queries: z.array(z.object({
    query_plan: BranchQueryPlanSchema,
    query_result: BranchQueryResultSchema,
  }).strict()).max(16),
  evidence: z.array(ResearchBranchEvidenceItemSchema).max(512),
  omitted_candidate_refs: z.array(IdentifierSchema).max(2_048),
  created_at: z.string().datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  if (value.checkpoint_ref.id !== `eliotr.research.read-extract-v2-${value.identity_digest}` || value.checkpoint_ref.revision !== 1) {
    context.addIssue({ code: "custom", path: ["checkpoint_ref"], message: "v2 read/extract checkpoint identity mismatch" });
  }
  const roles = value.role_queries.map((item) => item.query_plan.role);
  const evidenceByRef = new Map(value.evidence.map((item) => [refKey(item.handle_ref), item.excerpt_sha256]));
  const queryEvidence = value.role_queries.flatMap((item) => item.query_result.resolved_evidence.map((evidence) => ({
    ref: refKey(evidence.handle.handle_ref),
    digest: evidence.handle.excerpt_sha256,
  })));
  if (duplicate(roles) || duplicate(value.evidence.map((item) => refKey(item.handle_ref))) ||
      duplicate(value.omitted_candidate_refs) ||
      value.role_queries.some(({ query_plan, query_result }) => !branchQueryResultMatchesPlan(query_plan, query_result) ||
        query_plan.planning_manifest_ref.id !== value.planning_manifest_ref.id ||
        query_plan.planning_manifest_ref.revision !== value.planning_manifest_ref.revision ||
        query_plan.planning_manifest_digest !== value.planning_manifest_digest ||
        query_plan.scope_snapshot_ref.id !== value.scope_snapshot_ref.id ||
        query_plan.scope_snapshot_ref.revision !== value.scope_snapshot_ref.revision ||
        query_plan.scope_snapshot_digest !== query_result.scope_snapshot_digest ||
        query_result.scope_snapshot_ref.id !== value.scope_snapshot_ref.id ||
        query_result.scope_snapshot_ref.revision !== value.scope_snapshot_ref.revision) ||
      queryEvidence.some((item) => evidenceByRef.get(item.ref) !== item.digest) ||
      [...evidenceByRef.keys()].some((ref) => !queryEvidence.some((item) => item.ref === ref))) {
    context.addIssue({ code: "custom", path: ["role_queries"], message: "v2 read/extract query provenance or evidence is inconsistent" });
  }
});
export type ResearchReadExtractCheckpointV2 = z.infer<typeof ResearchReadExtractCheckpointV2Schema>;

export const ResearchBranchResultSchema = z.object({
  branch_ref: VersionedRefSchema,
  identity_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  role: ResearchBranchRoleSchema,
  status: z.enum(["CANDIDATE_READY", "BLOCKED"]),
  question_ids: z.array(z.string().min(1).max(256)).max(32),
  hypothesis_ids: z.array(z.string().min(1).max(256)).max(32),
  evidence_handle_refs: z.array(VersionedRefSchema).max(512),
  observation_refs: z.array(z.string().min(1).max(256)).max(512),
  unknowns: z.array(z.string().min(1).max(1024)).max(64),
  limitations: z.array(z.string().min(1).max(1024)).max(64),
  failed_probe_refs: z.array(z.string().min(1).max(256)).max(64),
  authoritative_disposition: z.literal("UNASSESSED"),
}).strict().superRefine((value, context) => {
  if (value.branch_ref.id !== `eliotr.research.branch-${value.identity_digest}` || value.branch_ref.revision !== 1) {
    context.addIssue({ code: "custom", path: ["branch_ref"], message: "branch result identity mismatch" });
  }
  for (const [path, values] of [
    ["question_ids", value.question_ids],
    ["hypothesis_ids", value.hypothesis_ids],
    ["observation_refs", value.observation_refs],
    ["failed_probe_refs", value.failed_probe_refs],
  ] as const) {
    if (duplicate(values)) context.addIssue({ code: "custom", path: [path], message: `${path} contains duplicates` });
  }
  if (duplicate(value.evidence_handle_refs.map(refKey))) {
    context.addIssue({ code: "custom", path: ["evidence_handle_refs"], message: "branch result contains duplicate evidence handles" });
  }
  if (value.status === "CANDIDATE_READY" && value.evidence_handle_refs.length === 0 && value.role !== "SOURCE_AUDIT") {
    context.addIssue({ code: "custom", path: ["status"], message: "ready branch requires evidence" });
  }
  if (value.status === "BLOCKED" && value.failed_probe_refs.length === 0) {
    context.addIssue({ code: "custom", path: ["failed_probe_refs"], message: "blocked branch requires a failed probe" });
  }
});
export type ResearchBranchResult = z.infer<typeof ResearchBranchResultSchema>;

export const ResearchBranchAnalysisCheckpointSchema = z.object({
  protocol: z.literal("eliotr.research.branch-analysis.v1"),
  checkpoint_ref: VersionedRefSchema,
  identity_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  operation_id: z.string().min(1).max(128),
  investigation_ref: VersionedRefSchema,
  principal_ref: z.string().min(1).max(256),
  scope_snapshot_ref: VersionedRefSchema,
  inquiry_protocol_ref: VersionedRefSchema,
  protocol_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  planning_manifest_ref: VersionedRefSchema,
  planning_manifest_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  read_extract_ref: VersionedRefSchema,
  required_roles: z.array(ResearchBranchRoleSchema).max(16),
  branch_results: z.array(ResearchBranchResultSchema).max(16),
  created_at: z.string().datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  if (value.checkpoint_ref.id !== `eliotr.research.branch-analysis-${value.identity_digest}` || value.checkpoint_ref.revision !== 1) {
    context.addIssue({ code: "custom", path: ["checkpoint_ref"], message: "branch analysis identity mismatch" });
  }
  if (duplicate(value.required_roles)) {
    context.addIssue({ code: "custom", path: ["required_roles"], message: "required branch roles are duplicated" });
  }
  const roles = value.branch_results.map((item) => item.role);
  if (duplicate(roles) || roles.some((role) => role === "COUNTER" || !value.required_roles.includes(role))) {
    context.addIssue({ code: "custom", path: ["branch_results"], message: "branch analysis contains an unexpected role" });
  }
});
export type ResearchBranchAnalysisCheckpoint = z.infer<typeof ResearchBranchAnalysisCheckpointSchema>;

export const ResearchBranchReconciliationCheckpointSchema = z.object({
  protocol: z.literal("eliotr.research.branch-reconciliation.v1"),
  checkpoint_ref: VersionedRefSchema,
  identity_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  operation_id: z.string().min(1).max(128),
  investigation_ref: VersionedRefSchema,
  principal_ref: z.string().min(1).max(256),
  scope_snapshot_ref: VersionedRefSchema,
  inquiry_protocol_ref: VersionedRefSchema,
  protocol_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  planning_manifest_ref: VersionedRefSchema,
  planning_manifest_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  branch_analysis_ref: VersionedRefSchema,
  required_roles: z.array(ResearchBranchRoleSchema).max(16),
  branch_results: z.array(ResearchBranchResultSchema).max(16),
  unmet_required_roles: z.array(ResearchBranchRoleSchema).max(16),
  unresolved_contradiction_refs: z.array(z.string().min(1).max(256)).max(512),
  research_debts: z.array(ResearchDebtSchema).max(16),
  counter_search_status: z.enum(["NOT_REQUIRED", "PARTIAL", "COMPLETE"]),
  created_at: z.string().datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  if (value.checkpoint_ref.id !== `eliotr.research.branch-reconciliation-${value.identity_digest}` || value.checkpoint_ref.revision !== 1) {
    context.addIssue({ code: "custom", path: ["checkpoint_ref"], message: "branch reconciliation identity mismatch" });
  }
  const required = new Set(value.required_roles);
  const roles = value.branch_results.map((item) => item.role);
  if (required.size !== value.required_roles.length || duplicate(roles) || roles.some((role) => !required.has(role))) {
    context.addIssue({ code: "custom", path: ["branch_results"], message: "branch reconciliation roles are inconsistent" });
  }
  const blocked = value.branch_results.filter((item) => item.status === "BLOCKED").map((item) => item.role).sort();
  const unmet = [...value.unmet_required_roles].sort();
  if (blocked.length !== unmet.length || blocked.some((role, index) => role !== unmet[index])) {
    context.addIssue({ code: "custom", path: ["unmet_required_roles"], message: "unmet roles are not derived from branch results" });
  }
  const debtRefs = value.research_debts.map((item) => refKey(item.debt_ref));
  if (duplicate(debtRefs) || value.research_debts.some((item) => item.status !== "OPEN")) {
    context.addIssue({ code: "custom", path: ["research_debts"], message: "branch debts are duplicated or not open" });
  }
  if (!required.has("COUNTER") && value.counter_search_status !== "NOT_REQUIRED") {
    context.addIssue({ code: "custom", path: ["counter_search_status"], message: "counter search ran for an unrequired role" });
  }
  if (required.has("COUNTER")) {
    const counter = value.branch_results.find((item) => item.role === "COUNTER");
    const expected = counter?.status === "CANDIDATE_READY" ? "COMPLETE" : "PARTIAL";
    if (counter === undefined || value.counter_search_status !== expected) {
      context.addIssue({ code: "custom", path: ["counter_search_status"], message: "counter search status does not match its branch result" });
    }
  }
});
export type ResearchBranchReconciliationCheckpoint = z.infer<typeof ResearchBranchReconciliationCheckpointSchema>;

/** Additive v2 result. The v1 result codec above remains byte-for-byte unchanged. */
export const ResearchBranchResultV2Schema = z.object({
  protocol: z.literal("eliotr.research.branch-result.v2"),
  branch_ref: VersionedRefSchema,
  result_ref: VersionedRefSchema,
  identity_digest: Sha256Schema,
  role: ResearchBranchRoleSchema,
  status: z.enum(["CANDIDATE_READY", "BLOCKED"]),
  question_ids: z.array(IdentifierSchema).max(32),
  hypothesis_ids: z.array(IdentifierSchema).max(32),
  evidence_handle_refs: z.array(VersionedRefSchema).max(64),
  observation_refs: z.array(IdentifierSchema).max(64),
  unknowns: z.array(z.string().min(1).max(1_024)).max(64),
  limitations: z.array(z.string().min(1).max(1_024)).max(64),
  failed_probe_refs: z.array(IdentifierSchema).max(64),
  authoritative_disposition: z.literal("UNASSESSED"),
  query_plan: BranchQueryPlanSchema,
  query_result: BranchQueryResultSchema,
  findings: z.array(BranchFindingCandidateSchema).max(64),
}).strict().superRefine((value, context) => {
  if (value.result_ref.id !== `eliotr.research.branch-result-v2-${value.identity_digest}` || value.result_ref.revision !== 1 ||
      value.branch_ref.id !== value.query_plan.branch_ref.id || value.branch_ref.revision !== value.query_plan.branch_ref.revision) {
    context.addIssue({ code: "custom", path: ["result_ref"], message: "v2 branch result identity mismatch" });
  }
  if (value.query_plan.role !== value.role || !branchQueryResultMatchesPlan(value.query_plan, value.query_result)) {
    context.addIssue({ code: "custom", path: ["query_plan"], message: "branch query provenance does not match result" });
  }
  const handleKeys = value.evidence_handle_refs.map(refKey);
  const findingKeys = value.findings.flatMap((finding) => finding.evidence_handle_refs.map(refKey));
  const queryKeys = value.query_result.resolved_evidence.map((item) => refKey(item.handle.handle_ref));
  if (duplicate(value.question_ids) || duplicate(value.hypothesis_ids) || duplicate(value.observation_refs) ||
      duplicate(value.failed_probe_refs) || duplicate(handleKeys) || duplicate(value.findings.map((item) => refKey(item.finding_ref))) ||
      handleKeys.some((key) => !queryKeys.includes(key)) || findingKeys.some((key) => !queryKeys.includes(key))) {
    context.addIssue({ code: "custom", path: ["evidence_handle_refs"], message: "v2 branch result contains foreign or duplicate references" });
  }
  if (value.status === "CANDIDATE_READY" &&
      (value.evidence_handle_refs.length === 0 || !value.findings.some((finding) => finding.state === "CANDIDATE"))) {
    context.addIssue({ code: "custom", path: ["status"], message: "ready v2 branch requires a substantive finding with evidence" });
  }
  if (value.status === "BLOCKED" && value.failed_probe_refs.length === 0) {
    context.addIssue({ code: "custom", path: ["failed_probe_refs"], message: "blocked v2 branch requires a failed probe" });
  }
  if (value.findings.some((finding) => finding.role !== value.role || !value.question_ids.includes(finding.question_ref.id))) {
    context.addIssue({ code: "custom", path: ["findings"], message: "finding is not bound to this branch question" });
  }
  if (value.findings.some((finding) => finding.question_ref.id !== value.query_plan.branch_question.question_ref.id ||
      finding.question_sha256 !== value.query_plan.branch_question.text_sha256)) {
    context.addIssue({ code: "custom", path: ["findings"], message: "finding question digest does not match the branch plan" });
  }
});
export type ResearchBranchResultV2 = z.infer<typeof ResearchBranchResultV2Schema>;

export const ResearchBranchAnalysisCheckpointV2Schema = z.object({
  protocol: z.literal("eliotr.research.branch-analysis.v2"),
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
  read_extract_ref: VersionedRefSchema,
  required_roles: z.array(ResearchBranchRoleSchema).max(16),
  branch_results: z.array(ResearchBranchResultV2Schema).max(16),
  created_at: z.string().datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  if (value.checkpoint_ref.id !== `eliotr.research.branch-analysis-v2-${value.identity_digest}` || value.checkpoint_ref.revision !== 1) {
    context.addIssue({ code: "custom", path: ["checkpoint_ref"], message: "v2 analysis identity mismatch" });
  }
  const roles = value.branch_results.map((item) => item.role);
  if (duplicate(value.required_roles) || duplicate(roles) ||
      roles.some((role) => role === "COUNTER" || !value.required_roles.includes(role))) {
    context.addIssue({ code: "custom", path: ["branch_results"], message: "v2 analysis roles are inconsistent" });
  }
});
export type ResearchBranchAnalysisCheckpointV2 = z.infer<typeof ResearchBranchAnalysisCheckpointV2Schema>;

export const ResearchBranchReconciliationCheckpointV2Schema = z.object({
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
  branch_results: z.array(ResearchBranchResultV2Schema).max(16),
  unmet_required_roles: z.array(ResearchBranchRoleSchema).max(16),
  unresolved_contradiction_refs: z.array(IdentifierSchema).max(512),
  research_debts: z.array(ResearchDebtSchema).max(16),
  counter_search_status: z.enum(["NOT_REQUIRED", "PARTIAL", "COMPLETE"]),
  created_at: z.string().datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  if (value.checkpoint_ref.id !== `eliotr.research.branch-reconciliation-v2-${value.identity_digest}` || value.checkpoint_ref.revision !== 1) {
    context.addIssue({ code: "custom", path: ["checkpoint_ref"], message: "v2 reconciliation identity mismatch" });
  }
  const required = new Set(value.required_roles);
  const roles = value.branch_results.map((item) => item.role);
  if (required.size !== value.required_roles.length || duplicate(roles) || roles.some((role) => !required.has(role))) {
    context.addIssue({ code: "custom", path: ["branch_results"], message: "v2 reconciliation roles are inconsistent" });
  }
  const blocked = value.branch_results.filter((item) => item.status === "BLOCKED").map((item) => item.role).sort();
  const unmet = [...value.unmet_required_roles].sort();
  if (blocked.length !== unmet.length || blocked.some((role, index) => role !== unmet[index])) {
    context.addIssue({ code: "custom", path: ["unmet_required_roles"], message: "v2 unmet roles are not derived from results" });
  }
  if (duplicate(value.unresolved_contradiction_refs) || duplicate(value.research_debts.map((item) => refKey(item.debt_ref))) ||
      value.research_debts.some((item) => item.status !== "OPEN")) {
    context.addIssue({ code: "custom", path: ["research_debts"], message: "v2 debts or contradictions are duplicated or invalid" });
  }
  const counter = value.branch_results.find((item) => item.role === "COUNTER");
  const expectedCounter = !required.has("COUNTER") ? "NOT_REQUIRED" : counter?.status === "CANDIDATE_READY" ? "COMPLETE" : "PARTIAL";
  if (value.counter_search_status !== expectedCounter) {
    context.addIssue({ code: "custom", path: ["counter_search_status"], message: "v2 counter status does not match branch result" });
  }
});
export type ResearchBranchReconciliationCheckpointV2 = z.infer<typeof ResearchBranchReconciliationCheckpointV2Schema>;
