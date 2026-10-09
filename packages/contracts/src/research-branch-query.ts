import { z } from "zod";
import { IdentifierSchema, Sha256Schema, VersionedRefSchema } from "./common.js";
import { ResolvedEvidenceSchema } from "./evidence.js";
import { RetrievalTraceSchema } from "./retrieval.js";
import { ResearchBranchRoleSchema } from "./research-branch-role.js";

const MAX_QUERY_LEGS = 4;
const MAX_QUERY_CHARS = 2_048;

function duplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function normalizedQuery(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

export const BranchQuestionBindingSchema = z.object({
  question_ref: VersionedRefSchema,
  text: z.string().min(1).max(8_192),
  text_sha256: Sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.question_ref.revision !== 1) {
    context.addIssue({ code: "custom", path: ["question_ref", "revision"], message: "question revision is unsupported" });
  }
});
export type BranchQuestionBinding = z.infer<typeof BranchQuestionBindingSchema>;

export const BranchQueryProposalLegSchema = z.object({
  query: z.string().min(1).max(MAX_QUERY_CHARS),
  literal_probes: z.array(z.string().min(1).max(256)).max(16),
}).strict().superRefine((value, context) => {
  if (value.query.trim().length === 0) {
    context.addIssue({ code: "custom", path: ["query"], message: "query is blank" });
  }
  if (value.literal_probes.some((probe) => probe.trim().length === 0)) {
    context.addIssue({ code: "custom", path: ["literal_probes"], message: "literal probe is blank" });
  }
  if (duplicate(value.literal_probes.map(normalizedQuery))) {
    context.addIssue({ code: "custom", path: ["literal_probes"], message: "literal probes contain duplicates" });
  }
});
export type BranchQueryProposalLeg = z.infer<typeof BranchQueryProposalLegSchema>;

/** Untrusted model proposal. The server binds it to the exact root and branch questions. */
export const BranchQueryProposalSchema = z.object({
  protocol: z.literal("eliotr.research.branch-query-proposal.v1"),
  role: ResearchBranchRoleSchema,
  root_question_ref: VersionedRefSchema,
  root_question_sha256: Sha256Schema,
  branch_question_ref: VersionedRefSchema,
  branch_question_sha256: Sha256Schema,
  query_legs: z.array(BranchQueryProposalLegSchema).min(1).max(MAX_QUERY_LEGS),
}).strict().superRefine((value, context) => {
  if (value.root_question_ref.revision !== 1 || value.branch_question_ref.revision !== 1) {
    context.addIssue({ code: "custom", path: ["root_question_ref"], message: "question revision is unsupported" });
  }
  if (duplicate(value.query_legs.map((leg) => normalizedQuery(leg.query)))) {
    context.addIssue({ code: "custom", path: ["query_legs"], message: "query proposal contains duplicate queries" });
  }
});
export type BranchQueryProposal = z.infer<typeof BranchQueryProposalSchema>;

export const BranchQueryPlanLegSchema = BranchQueryProposalLegSchema.extend({
  query_id: IdentifierSchema,
  query_sha256: Sha256Schema,
}).strict();
export type BranchQueryPlanLeg = z.infer<typeof BranchQueryPlanLegSchema>;

export const BranchQueryPlanSchema = z.object({
  protocol: z.literal("eliotr.research.branch-query-plan.v1"),
  query_plan_ref: VersionedRefSchema,
  identity_digest: Sha256Schema,
  branch_ref: VersionedRefSchema,
  role: ResearchBranchRoleSchema,
  planning_manifest_ref: VersionedRefSchema,
  planning_manifest_digest: Sha256Schema,
  inquiry_protocol_ref: VersionedRefSchema,
  protocol_digest: Sha256Schema,
  scope_snapshot_ref: VersionedRefSchema,
  scope_snapshot_digest: Sha256Schema,
  root_question: BranchQuestionBindingSchema,
  branch_question: BranchQuestionBindingSchema,
  question_refs: z.array(VersionedRefSchema).min(2).max(32),
  hypothesis_refs: z.array(IdentifierSchema).max(32),
  query_legs: z.array(BranchQueryPlanLegSchema).min(1).max(MAX_QUERY_LEGS),
  retrieval_product: z.enum(["FAST_SEARCH", "RESEARCH"]),
  budgets: z.object({
    candidate_limit: z.number().int().min(1).max(512),
    scan_limit: z.number().int().min(1).max(4_096),
    evidence_limit: z.number().int().min(1).max(64),
    max_evidence_bytes: z.number().int().min(1).max(64 * 1024),
    max_query_legs: z.number().int().min(1).max(MAX_QUERY_LEGS),
  }).strict(),
  required: z.boolean(),
  stop_rule: z.enum(["FIRST_ADMISSIBLE_EVIDENCE", "EXHAUST_QUERY_LEGS"]),
  proposal_disposition: z.enum(["NOT_PROPOSED", "ACCEPTED", "REJECTED_INVALID", "REJECTED_UNBOUND"]),
  plan_generation: z.literal("server.branch-query-planner.v1"),
}).strict().superRefine((value, context) => {
  if (value.query_plan_ref.id !== `eliotr.research.branch-query-plan-${value.identity_digest}` || value.query_plan_ref.revision !== 1) {
    context.addIssue({ code: "custom", path: ["query_plan_ref"], message: "query plan identity mismatch" });
  }
  if (value.branch_ref.revision !== 1 || value.question_refs.some((ref) => ref.revision !== 1)) {
    context.addIssue({ code: "custom", path: ["branch_ref"], message: "branch or question revision is unsupported" });
  }
  if (value.query_legs.length > value.budgets.max_query_legs ||
      duplicate(value.query_legs.map((leg) => leg.query_id)) ||
      duplicate(value.query_legs.map((leg) => normalizedQuery(leg.query)))) {
    context.addIssue({ code: "custom", path: ["query_legs"], message: "query legs exceed bounds or contain duplicates" });
  }
  if (value.budgets.evidence_limit < 1 || value.question_refs.length < 2) {
    context.addIssue({ code: "custom", path: ["budgets"], message: "query plan bounds are invalid" });
  }
  if (value.root_question.question_ref.id === value.branch_question.question_ref.id ||
      !value.question_refs.some((ref) => ref.id === value.root_question.question_ref.id) ||
      !value.question_refs.some((ref) => ref.id === value.branch_question.question_ref.id)) {
    context.addIssue({ code: "custom", path: ["question_refs"], message: "root and branch questions are not both bound" });
  }
});
export type BranchQueryPlan = z.infer<typeof BranchQueryPlanSchema>;

const BranchQueryResolvedHandleSchema = z.object({
  handle_ref: VersionedRefSchema,
  excerpt_sha256: Sha256Schema,
  excerpt_byte_length: z.number().int().nonnegative().max(8 * 1024 * 1024),
}).strict();

/** A transport cancellation escapes the stage; it cannot be reported as a completed query leg. */
export function branchQueryLegOutcomeIsConsistent(value: {
  readonly status: "COMPLETED" | "FAILED";
  readonly stop_reason: string;
  readonly resolved_handle_refs: readonly unknown[];
}): boolean {
  if (value.status === "FAILED") return value.stop_reason === "LEG_FAILED" && value.resolved_handle_refs.length === 0;
  return ["LEG_COMPLETED", "NO_HITS", "CANDIDATE_BUDGET", "SCAN_BUDGET", "EVIDENCE_BUDGET"].includes(value.stop_reason) &&
    (value.stop_reason !== "NO_HITS" || value.resolved_handle_refs.length === 0);
}

function branchQueryStopMatchesOutcome(
  legs: readonly { readonly status: "COMPLETED" | "FAILED" }[],
  stop: "PLAN_COMPLETED" | "FIRST_ADMISSIBLE_EVIDENCE" | "NO_HITS" | "BUDGET_EXHAUSTED" | "ALL_LEGS_FAILED",
  hasEvidence: boolean,
): boolean {
  if (stop === "ALL_LEGS_FAILED") return !hasEvidence && legs.length > 0 && legs.every((leg) => leg.status === "FAILED");
  if (stop === "NO_HITS") return !hasEvidence && legs.some((leg) => leg.status === "COMPLETED");
  if (stop === "FIRST_ADMISSIBLE_EVIDENCE") return hasEvidence && legs.some((leg) => leg.status === "COMPLETED");
  return true;
}

export const BranchQueryLegResultSchema = z.object({
  status: z.enum(["COMPLETED", "FAILED"]),
  query_id: IdentifierSchema,
  query_sha256: Sha256Schema,
  retrieval_request_digest: Sha256Schema,
  scope_snapshot_ref: VersionedRefSchema,
  scope_snapshot_digest: Sha256Schema,
  trace: RetrievalTraceSchema.optional(),
  failure_code: IdentifierSchema.optional(),
  resolved_handle_refs: z.array(BranchQueryResolvedHandleSchema).max(64),
  omitted_candidates: z.array(z.object({ candidate_id: IdentifierSchema, reason_code: IdentifierSchema }).strict()).max(512),
  stop_reason: z.enum(["LEG_COMPLETED", "NO_HITS", "CANDIDATE_BUDGET", "SCAN_BUDGET", "EVIDENCE_BUDGET", "CANCELLED", "LEG_FAILED"]),
}).strict().superRefine((value, context) => {
  if ((value.status === "COMPLETED" && (value.trace === undefined || value.failure_code !== undefined)) ||
      (value.status === "FAILED" && (value.failure_code === undefined || value.trace !== undefined)) ||
      !branchQueryLegOutcomeIsConsistent(value)) {
    context.addIssue({ code: "custom", path: ["status"], message: "query leg completion/failure fields are inconsistent" });
  }
  if (value.trace !== undefined && (value.trace.trace_ref.revision !== 1 ||
      value.trace.scope_snapshot.snapshot_id !== value.scope_snapshot_ref.id ||
      value.trace.scope_snapshot.revision !== value.scope_snapshot_ref.revision ||
      value.trace.scope_snapshot.digest !== value.scope_snapshot_digest)) {
    context.addIssue({ code: "custom", path: ["trace"], message: "query trace is not bound to the held scope" });
  }
  if (duplicate(value.resolved_handle_refs.map((item) => `${item.handle_ref.id}:${item.handle_ref.revision}`))) {
    context.addIssue({ code: "custom", path: ["resolved_handle_refs"], message: "query leg contains duplicate handles" });
  }
  if (value.stop_reason === "NO_HITS" && value.resolved_handle_refs.length !== 0) {
    context.addIssue({ code: "custom", path: ["stop_reason"], message: "no-hit stop contains resolved evidence" });
  }
});
export type BranchQueryLegResult = z.infer<typeof BranchQueryLegResultSchema>;

const BranchQueryResultFields = {
  query_result_ref: VersionedRefSchema,
  identity_digest: Sha256Schema,
  query_plan_ref: VersionedRefSchema,
  query_plan_digest: Sha256Schema,
  role: ResearchBranchRoleSchema,
  scope_snapshot_ref: VersionedRefSchema,
  scope_snapshot_digest: Sha256Schema,
  query_legs: z.array(BranchQueryLegResultSchema).min(1).max(MAX_QUERY_LEGS),
  resolved_evidence: z.array(ResolvedEvidenceSchema).max(64),
  omitted_candidate_refs: z.array(IdentifierSchema).max(2_048),
  total_utf8_bytes: z.number().int().nonnegative().max(64 * 1024),
  stop_reason: z.enum(["PLAN_COMPLETED", "FIRST_ADMISSIBLE_EVIDENCE", "NO_HITS", "BUDGET_EXHAUSTED", "ALL_LEGS_FAILED"]),
} as const;

function validateBranchQueryResult(
  value: z.infer<z.ZodObject<typeof BranchQueryResultFields>>,
  context: z.RefinementCtx,
  failureDisposition: "NONE" | "PARTIAL" | "ALL_FAILED",
): void {
  if (value.query_result_ref.id !== `eliotr.research.branch-query-result-${value.identity_digest}` || value.query_result_ref.revision !== 1 ||
      value.query_plan_ref.revision !== 1 || value.query_legs.some((leg) =>
        leg.scope_snapshot_ref.id !== value.scope_snapshot_ref.id ||
        leg.scope_snapshot_ref.revision !== value.scope_snapshot_ref.revision ||
        leg.scope_snapshot_digest !== value.scope_snapshot_digest)) {
    context.addIssue({ code: "custom", path: ["query_result_ref"], message: "query result identity or scope binding mismatch" });
  }
  const resolved = new Map(value.resolved_evidence.map((item) => [
    `${item.handle.handle_ref.id}:${item.handle.handle_ref.revision}`,
    item,
  ]));
  const legRefs = value.query_legs.flatMap((leg) => leg.resolved_handle_refs);
  const queriedRefs = new Set(legRefs.map((item) => `${item.handle_ref.id}:${item.handle_ref.revision}`));
  if (duplicate(value.resolved_evidence.map((item) => `${item.handle.handle_ref.id}:${item.handle.handle_ref.revision}`)) ||
      duplicate(value.query_legs.map((leg) => leg.query_id)) ||
      value.resolved_evidence.some((item) => item.handle.scope_snapshot_ref.id !== value.scope_snapshot_ref.id ||
        item.handle.scope_snapshot_ref.revision !== value.scope_snapshot_ref.revision ||
        item.scope_snapshot_digest !== value.scope_snapshot_digest ||
        item.handle.excerpt_byte_length !== new TextEncoder().encode(item.exact_excerpt).byteLength) ||
      [...resolved.keys()].some((ref) => !queriedRefs.has(ref)) ||
      legRefs.some((item) => {
        const evidence = resolved.get(`${item.handle_ref.id}:${item.handle_ref.revision}`);
        return evidence === undefined || evidence.handle.excerpt_sha256 !== item.excerpt_sha256 ||
          new TextEncoder().encode(evidence.exact_excerpt).byteLength !== item.excerpt_byte_length;
      })) {
    context.addIssue({ code: "custom", path: ["resolved_evidence"], message: "exact evidence does not match query leg handles" });
  }
  const bytes = value.resolved_evidence.reduce((sum, item) => sum + new TextEncoder().encode(item.exact_excerpt).byteLength, 0);
  if (bytes !== value.total_utf8_bytes) {
    context.addIssue({ code: "custom", path: ["total_utf8_bytes"], message: "resolved evidence byte total mismatch" });
  }
  if (!branchQueryStopMatchesOutcome(value.query_legs, value.stop_reason, value.resolved_evidence.length > 0)) {
    context.addIssue({ code: "custom", path: ["stop_reason"], message: "query stop reason contradicts leg outcomes or evidence" });
  }
  const failed = value.query_legs.filter((leg) => leg.status === "FAILED").length;
  const expected = failed === 0 ? "NONE" : failed === value.query_legs.length ? "ALL_FAILED" : "PARTIAL";
  if (failureDisposition !== expected) {
    context.addIssue({ code: "custom", path: ["failure_disposition"], message: "failure disposition does not match query legs" });
  }
}

/** New, not-yet-published query result separates leg failure from why execution stopped. */
export const BranchQueryResultSchema = z.object({
  protocol: z.literal("eliotr.research.branch-query-result.v1"),
  ...BranchQueryResultFields,
  failure_disposition: z.enum(["NONE", "PARTIAL", "ALL_FAILED"]),
}).strict().superRefine((value, context) => validateBranchQueryResult(value, context, value.failure_disposition));
export type BranchQueryResult = z.infer<typeof BranchQueryResultSchema>;

/** Exact pairing for checkpoints: a stopped plan may retain only an ordered prefix of its legs. */
export function branchQueryResultMatchesPlan(plan: BranchQueryPlan, result: BranchQueryResult): boolean {
  return plan.role === result.role && plan.query_plan_ref.id === result.query_plan_ref.id &&
    plan.query_plan_ref.revision === result.query_plan_ref.revision && plan.identity_digest === result.query_plan_digest &&
    plan.scope_snapshot_ref.id === result.scope_snapshot_ref.id &&
    plan.scope_snapshot_ref.revision === result.scope_snapshot_ref.revision && plan.scope_snapshot_digest === result.scope_snapshot_digest &&
    branchQueryLegsMatchPlan(plan, result.query_legs, result.stop_reason, result.resolved_evidence.length > 0);
}

export function branchQueryLegsMatchPlan(
  plan: BranchQueryPlan,
  legs: readonly Pick<BranchQueryLegResult, "query_id" | "query_sha256" | "status">[],
  stop: BranchQueryResult["stop_reason"],
  hasEvidence: boolean,
): boolean {
  const fullPlanStop = ["PLAN_COMPLETED", "NO_HITS", "ALL_LEGS_FAILED"].includes(stop);
  return legs.length > 0 && legs.length <= plan.query_legs.length && (!fullPlanStop || legs.length === plan.query_legs.length) &&
    branchQueryStopMatchesOutcome(legs, stop, hasEvidence) &&
    (stop !== "FIRST_ADMISSIBLE_EVIDENCE" || (plan.stop_rule === "FIRST_ADMISSIBLE_EVIDENCE" && hasEvidence)) &&
    legs.every((leg, index) => {
      const planned = plan.query_legs[index];
      return planned !== undefined && leg.query_id === planned.query_id && leg.query_sha256 === planned.query_sha256;
    });
}
