import { z } from "zod";
import { VersionedRefSchema } from "./common.js";
import { ResearchDebtSchema } from "./research.js";

export const ResearchBranchRoleSchema = z.enum([
  "SUPPORT",
  "COUNTER",
  "ALTERNATIVE",
  "CHRONOLOGY",
  "IMPLEMENTATION",
  "LITERATURE",
  "SOURCE_AUDIT",
]);
export type ResearchBranchRole = z.infer<typeof ResearchBranchRoleSchema>;

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
