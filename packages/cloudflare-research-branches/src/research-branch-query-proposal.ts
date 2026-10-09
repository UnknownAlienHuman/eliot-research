import {
  BranchQuestionBindingSchema,
  BranchQueryProposalSchema,
  ResearchBranchRoleSchema,
  type BranchQueryPlan,
} from "@eliotr/contracts";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import {
  StageRequestSchema,
  fail,
  type StageRequest,
  type WorkflowPrincipal,
  type WorkflowStageHandler,
} from "@eliotr/cloudflare-workflows";
import { BRANCH_QUERY_HANDLER_GENERATION } from "./research-branch-execution.js";
import { deriveBranchRoleStageRequest } from "./research-branch-role-model.js";

export type ResearchBranchQueryProposalPlanContext = Pick<
  BranchQueryPlan,
  "role" | "root_question" | "branch_question" | "required" | "proposal_disposition"
>;

export interface ResearchBranchQueryProposalInput {
  /** A server-built provisional plan whose proposal disposition is NOT_PROPOSED. */
  readonly plan: ResearchBranchQueryProposalPlanContext;
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
  readonly attempt_ref: string;
  readonly budget_receipt_ref: string;
  readonly signal?: AbortSignal;
}

function proposalCandidate(bytes: Uint8Array): unknown {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    // The existing plan builder records this as REJECTED_INVALID and uses its
    // bounded deterministic direct query. The completed model attempt is never retried here.
    return null;
  }
  const parsed = BranchQueryProposalSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Makes one role-scoped proposal call inside the existing READ_AND_EXTRACT
 * attempt. `execute_selected_attempt` must be the already-selected, W3-governed
 * handler for this stage/profile; this helper creates no model stage or route.
 *
 * The returned value is only an untrusted candidate. Pass it to
 * createResearchBranchQueryPlan, which binds question refs/digests and rejects
 * invalid or unbound candidates before any query leg can execute. Propagated
 * handler failures remain failures; this function never retries or swallows them.
 */
export async function produceResearchBranchQueryProposal(
  input: ResearchBranchQueryProposalInput,
  execute_selected_attempt: WorkflowStageHandler,
): Promise<unknown | undefined> {
  const request = StageRequestSchema.safeParse(input.request);
  if (!request.success || request.data.stage !== "READ_AND_EXTRACT" ||
      request.data.handler_generation !== BRANCH_QUERY_HANDLER_GENERATION) {
    fail("WORKFLOW_INPUT_INVALID");
  }
  const role = ResearchBranchRoleSchema.safeParse(input.plan.role);
  const rootQuestion = BranchQuestionBindingSchema.safeParse(input.plan.root_question);
  const branchQuestion = BranchQuestionBindingSchema.safeParse(input.plan.branch_question);
  if (!role.success || !rootQuestion.success || !branchQuestion.success ||
      input.plan.proposal_disposition !== "NOT_PROPOSED") {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  if (!input.plan.required) return undefined;
  if (typeof execute_selected_attempt !== "function") fail("WORKFLOW_CONFIGURATION_MISSING");
  if (input.attempt_ref.trim().length === 0 || input.budget_receipt_ref.trim().length === 0) {
    fail("WORKFLOW_INPUT_INVALID");
  }
  if (input.signal?.aborted || input.principal.signal?.aborted) fail("WORKFLOW_CANCELLED");

  const roleRequest = deriveBranchRoleStageRequest(request.data, role.data);
  const input_bytes = new TextEncoder().encode(canonicalEvidenceJson({
    protocol: "eliotr.research.branch-query-proposal-request.v1",
    output_protocol: "eliotr.research.branch-query-proposal.v1",
    role: role.data,
    root_question: rootQuestion.data,
    branch_question: branchQuestion.data,
  }));
  const output = await execute_selected_attempt({
    request: roleRequest,
    principal: input.principal,
    input_bytes,
    attempt_ref: input.attempt_ref,
    budget_receipt_ref: input.budget_receipt_ref,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return proposalCandidate(output);
}
