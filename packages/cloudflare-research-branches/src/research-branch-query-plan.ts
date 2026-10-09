import {
  BranchQueryPlanSchema,
  BranchQueryProposalSchema,
  type BranchQueryPlan,
  type ResearchBranchRole,
  type ResearchPlanningManifest,
  type VersionedRef,
} from "@eliotr/contracts";
import { canonicalEvidenceJson, evidenceSha256 } from "@eliotr/cloudflare-evidence";

const ROLE_QUESTION_KIND: Readonly<Record<ResearchBranchRole, ResearchPlanningManifest["questions"][number]["kind"]>> = {
  SUPPORT: "support",
  COUNTER: "counter",
  ALTERNATIVE: "alternative",
  CHRONOLOGY: "chronology",
  IMPLEMENTATION: "implementation",
  LITERATURE: "literature",
  SOURCE_AUDIT: "source_audit",
};

function ref(questionId: string): VersionedRef {
  return { id: questionId, revision: 1 };
}

function normalizeQuery(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

async function questionBinding(question: ResearchPlanningManifest["questions"][number]) {
  const questionRef = ref(question.question_id);
  return {
    question_ref: questionRef,
    text: question.text,
    text_sha256: await evidenceSha256({
      domain: "eliotr.research.branch-query-question.v1",
      value: { question_ref: questionRef, text: question.text },
    }),
  };
}

/** Build one deterministic query for the ordinary direct path; accept only bounded, question-bound proposals. */
export async function createResearchBranchQueryPlan(input: {
  readonly planning: ResearchPlanningManifest;
  readonly role: ResearchBranchRole;
  readonly scope_snapshot_digest: string;
  readonly protocol_digest: string;
  readonly required: boolean;
  /** Exact server-selected limits; structural ceilings do not select a budget. */
  readonly budgets: BranchQueryPlan["budgets"];
  readonly proposal?: unknown;
}): Promise<BranchQueryPlan> {
  const budgets = BranchQueryPlanSchema.shape.budgets.parse(input.budgets);
  const rootQuestion = input.planning.questions.find((question) => question.question_id === input.planning.primary_question_id);
  const branchQuestion = input.planning.questions.find((question) => question.kind === ROLE_QUESTION_KIND[input.role]);
  if (rootQuestion === undefined || branchQuestion === undefined) throw new RangeError("branch query plan requires named root and branch questions");

  const root = await questionBinding(rootQuestion);
  const branch = await questionBinding(branchQuestion);
  let proposalDisposition: BranchQueryPlan["proposal_disposition"] = "NOT_PROPOSED";
  let proposedLegs: readonly { readonly query: string; readonly literal_probes: readonly string[] }[] | undefined;
  if (input.proposal !== undefined) {
    const parsed = BranchQueryProposalSchema.safeParse(input.proposal);
    if (!parsed.success) {
      proposalDisposition = "REJECTED_INVALID";
    } else if (parsed.data.role !== input.role ||
        parsed.data.root_question_ref.id !== root.question_ref.id || parsed.data.root_question_sha256 !== root.text_sha256 ||
        parsed.data.branch_question_ref.id !== branch.question_ref.id || parsed.data.branch_question_sha256 !== branch.text_sha256) {
      proposalDisposition = "REJECTED_UNBOUND";
    } else {
      proposalDisposition = "ACCEPTED";
      proposedLegs = parsed.data.query_legs;
    }
  }

  const directQuery = normalizeQuery(`${root.text} ${branch.text}`);
  if (directQuery.length > 2_048) throw new RangeError("bound root and branch query exceeds the installed query bound");
  const sourceLegs = proposedLegs ?? [{ query: directQuery, literal_probes: [] }];
  const queryLegs = await Promise.all(sourceLegs.map(async (leg, index) => {
    const query = normalizeQuery(leg.query);
    const literalProbes = [...new Set(leg.literal_probes.map(normalizeQuery))];
    const querySha256 = await evidenceSha256({ domain: "eliotr.research.branch-query-leg.v1", value: { query, literal_probes: literalProbes } });
    return {
      query_id: `branch-query-${querySha256.slice(0, 40)}-${index}`,
      query_sha256: querySha256,
      query,
      literal_probes: literalProbes,
    };
  }));
  const questionRefs = [root.question_ref, branch.question_ref];
  const hypothesisRefs = input.planning.hypotheses
    .filter((hypothesis) => input.role === "ALTERNATIVE" || hypothesis.question_id === rootQuestion.question_id)
    .map((hypothesis) => hypothesis.hypothesis_id)
    .sort();
  const branchIdentity = await evidenceSha256({
    domain: "eliotr.research.branch-query-branch.v1",
    value: { role: input.role, planning_manifest_ref: input.planning.manifest_ref, branch_question_ref: branch.question_ref },
  });
  const material = {
    protocol: "eliotr.research.branch-query-plan.v1" as const,
    branch_ref: { id: `eliotr.research.branch-query-${branchIdentity}`, revision: 1 },
    role: input.role,
    planning_manifest_ref: input.planning.manifest_ref,
    planning_manifest_digest: input.planning.identity_digest,
    inquiry_protocol_ref: input.planning.inquiry_protocol_ref,
    protocol_digest: input.protocol_digest,
    scope_snapshot_ref: input.planning.scope_snapshot_ref,
    scope_snapshot_digest: input.scope_snapshot_digest,
    root_question: root,
    branch_question: branch,
    question_refs: questionRefs,
    hypothesis_refs: hypothesisRefs,
    query_legs: queryLegs,
    retrieval_product: "RESEARCH" as const,
    budgets,
    required: input.required,
    stop_rule: "FIRST_ADMISSIBLE_EVIDENCE" as const,
    proposal_disposition: proposalDisposition,
    plan_generation: "server.branch-query-planner.v1" as const,
  };
  const digest = await evidenceSha256({ domain: "eliotr.research.branch-query-plan.v1", value: material });
  const plan = BranchQueryPlanSchema.parse({
    ...material,
    query_plan_ref: { id: `eliotr.research.branch-query-plan-${digest}`, revision: 1 },
    identity_digest: digest,
  });
  if (canonicalEvidenceJson(plan.query_legs.map((leg) => leg.query)) !==
      canonicalEvidenceJson(queryLegs.map((leg) => leg.query))) throw new Error("branch query plan normalization mismatch");
  return plan;
}
