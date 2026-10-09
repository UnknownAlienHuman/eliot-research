import {
  BranchFindingDraftSchema,
  BranchQueryPlanSchema,
  BranchQueryResultSchema,
  branchQueryResultMatchesPlan,
  ResearchBranchRoleSchema,
  VersionedRefSchema,
  type ResearchBranchRole,
} from "@eliotr/contracts";
import { fail } from "@eliotr/cloudflare-workflows";
import { z } from "zod";
import { refKey } from "./research-branch-execution-shared.js";

/**
 * Substantive per-role model output. The model analyzes only the branch's
 * pre-selected evidence; the selected handle refs are validated against the
 * role's evidence selection before the result is built.
 */
export const ResearchBranchRoleModelOutputSchema = z.object({
  protocol: z.literal("eliotr.research.branch-role-output.v1"),
  role: ResearchBranchRoleSchema,
  status: z.enum(["CANDIDATE_READY", "BLOCKED"]),
  evidence_handle_refs: z.array(VersionedRefSchema).max(512),
  unknowns: z.array(z.string().min(1).max(1024)).max(64),
  limitations: z.array(z.string().min(1).max(1024)).max(64),
}).strict();
export type ResearchBranchRoleModelOutput = z.infer<typeof ResearchBranchRoleModelOutputSchema>;

export const ResearchBranchRoleModelOutputV2Schema = z.object({
  protocol: z.literal("eliotr.research.branch-role-output.v2"),
  role: ResearchBranchRoleSchema,
  root_question_ref: VersionedRefSchema,
  root_question_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  branch_question_ref: VersionedRefSchema,
  branch_question_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  query_plan_ref: VersionedRefSchema,
  query_plan_digest: z.string().regex(/^[a-f0-9]{64}$/u),
  finding: BranchFindingDraftSchema,
}).strict();
export type ResearchBranchRoleModelOutputV2 = z.infer<typeof ResearchBranchRoleModelOutputV2Schema>;

function corrupt(message: string): never {
  fail("WORKFLOW_OUTPUT_CORRUPT");
  throw new Error(message);
}

/**
 * Parses raw model output bytes and binds them to the role's evidence selection.
 * Every handle the model cites must be one of the role's pre-selected handles;
 * anything else is a reference-firewall violation and fails closed.
 */
export function parseBranchRoleModelOutput(
  outputBytes: Uint8Array,
  role: ResearchBranchRole,
  selectedHandleRefs: readonly { readonly id: string; readonly revision: number }[],
): ResearchBranchRoleModelOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(outputBytes));
  } catch {
    return corrupt("branch role model output is not valid JSON");
  }
  const output = ResearchBranchRoleModelOutputSchema.safeParse(parsed);
  if (!output.success) return corrupt("branch role model output does not match the installed schema");
  if (output.data.role !== role) return corrupt("branch role model output is bound to another role");
  const allowed = new Set(selectedHandleRefs.map((ref) => refKey(ref)));
  for (const ref of output.data.evidence_handle_refs) {
    if (!allowed.has(refKey(ref))) return corrupt("branch role model output cites evidence outside the role selection");
  }
  if (new Set(output.data.evidence_handle_refs.map((ref) => refKey(ref))).size !== output.data.evidence_handle_refs.length) {
    return corrupt("branch role model output contains duplicate evidence handles");
  }
  if (output.data.status === "CANDIDATE_READY" && output.data.evidence_handle_refs.length === 0 && role !== "SOURCE_AUDIT") {
    return corrupt("ready branch role output requires evidence");
  }
  if (output.data.status === "BLOCKED" && output.data.evidence_handle_refs.length !== 0) {
    return corrupt("blocked branch role output must not cite evidence");
  }
  return output.data;
}

/** Parse a substantive finding and bind every model-authored ref to the exact frozen query result. */
export function parseBranchRoleModelOutputV2(
  outputBytes: Uint8Array,
  plan: z.infer<typeof BranchQueryPlanSchema>,
  result: z.infer<typeof BranchQueryResultSchema>,
): ResearchBranchRoleModelOutputV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(outputBytes));
  } catch {
    return corrupt("v2 branch role model output is not valid JSON");
  }
  const output = ResearchBranchRoleModelOutputV2Schema.safeParse(parsed);
  if (!output.success) return corrupt("v2 branch role model output does not match the installed schema");
  const value = output.data;
  const parsedPlan = BranchQueryPlanSchema.safeParse(plan);
  const parsedResult = BranchQueryResultSchema.safeParse(result);
  if (!parsedPlan.success || !parsedResult.success ||
      !branchQueryResultMatchesPlan(parsedPlan.data, parsedResult.data)) {
    return corrupt("v2 branch role output received an invalid query plan/result pair");
  }
  const boundPlan = parsedPlan.data;
  const boundResult = parsedResult.data;
  if (value.role !== boundPlan.role || boundResult.role !== boundPlan.role ||
      refKey(value.root_question_ref) !== refKey(boundPlan.root_question.question_ref) ||
      value.root_question_sha256 !== boundPlan.root_question.text_sha256 ||
      refKey(value.branch_question_ref) !== refKey(boundPlan.branch_question.question_ref) ||
      value.branch_question_sha256 !== boundPlan.branch_question.text_sha256 ||
      refKey(value.query_plan_ref) !== refKey(boundPlan.query_plan_ref) ||
      value.query_plan_digest !== boundPlan.identity_digest ||
      value.finding.role !== boundPlan.role ||
      refKey(value.finding.question_ref) !== refKey(boundPlan.branch_question.question_ref) ||
      value.finding.question_sha256 !== boundPlan.branch_question.text_sha256) {
    return corrupt("v2 branch role output is bound to a different role, question, plan, or result");
  }
  const allowed = new Set(boundResult.resolved_evidence.map((item) => refKey(item.handle.handle_ref)));
  if (value.finding.evidence_handle_refs.some((ref) => !allowed.has(refKey(ref)))) {
    return corrupt("v2 branch finding cites evidence outside its exact query result");
  }
  if (value.finding.state === "CANDIDATE" && boundResult.resolved_evidence.length === 0) {
    return corrupt("candidate finding has no exact query evidence");
  }
  return value;
}
