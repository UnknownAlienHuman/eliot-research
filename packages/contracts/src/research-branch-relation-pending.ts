import { z } from "zod";
import { ResearchBranchReconciliationCheckpointSchema } from "./research-branch.js";
import { reconciliationStateIssues } from "./research-branch-invariants.js";

/** Forward addressed-read topology; V7/V8/V9 generations remain historical. */
export const RESEARCH_RELATION_PENDING_HANDLER_GENERATION = "research-handlers.exploratory.relation-pending.v1" as const;

export const ResearchRelationAssessmentStateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("PENDING"), reason: z.literal("RELATION_EVALUATOR_NOT_INTEGRATED") }).strict(),
  z.object({ status: z.literal("NOT_REQUIRED") }).strict(),
]);
export type ResearchRelationAssessmentState = z.infer<typeof ResearchRelationAssessmentStateSchema>;

/** Preserve all original V1 branch results; counter handles cannot establish a relation. */
export const ResearchBranchReconciliationPendingCheckpointSchema = z.object({
  ...ResearchBranchReconciliationCheckpointSchema.shape,
  protocol: z.literal("eliotr.research.branch-reconciliation-pending.v1"),
  unresolved_contradiction_refs: z.array(z.string().min(1).max(256)).max(0),
  relation_assessment: ResearchRelationAssessmentStateSchema,
}).strict().superRefine((value, context) => {
  if (value.checkpoint_ref.id !== `eliotr.research.branch-reconciliation-pending-${value.identity_digest}` || value.checkpoint_ref.revision !== 1) {
    context.addIssue({ code: "custom", path: ["checkpoint_ref"], message: "pending branch reconciliation identity mismatch" });
  }
  for (const issue of reconciliationStateIssues(value)) context.addIssue({ code: "custom", ...issue });
  const expected = value.required_roles.includes("COUNTER") ? "PENDING" : "NOT_REQUIRED";
  if (value.relation_assessment.status !== expected) {
    context.addIssue({ code: "custom", path: ["relation_assessment"], message: "relation assessment state differs from required counter role" });
  }
});
export type ResearchBranchReconciliationPendingCheckpoint = z.infer<typeof ResearchBranchReconciliationPendingCheckpointSchema>;
