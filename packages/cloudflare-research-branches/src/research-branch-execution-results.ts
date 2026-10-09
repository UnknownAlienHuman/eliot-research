import {
  BranchFindingCandidateSchema,
  ResearchReadExtractCheckpointV2Schema,
  ResearchBranchResultV2Schema,
  ResearchBranchRoleSchema,
  ResearchDebtSchema,
  type BranchFindingDraft,
  type BranchQueryPlan,
  type BranchQueryResult,
  type ResearchBranchEvidenceItem,
  type ResearchBranchResult,
  type ResearchBranchResultV2,
  type ResearchBranchRole,
  type ResearchDebt,
  type ResearchPlanningManifest,
  type ResearchReadExtractCheckpointV2,
} from "@eliotr/contracts";
import {
  ModelGatewayExecutionError,
  type ModelGatewayExecutionErrorCode,
} from "@eliotr/cloudflare-ai";
import { evidenceSha256 } from "@eliotr/cloudflare-evidence";
import { ModelAttemptError } from "@eliotr/cloudflare-model-execution";
import { fail, WorkflowCheckpointError } from "@eliotr/cloudflare-workflows";
import { branchResult, refKey, uniqueSorted } from "./research-branch-execution-shared.js";
import {
  parseBranchRoleModelOutputV2,
  type ResearchBranchRoleModelOutput,
  type ResearchBranchRoleModelOutputV2,
} from "./research-branch-role-output.js";
import type { ResearchBranchRoleModelExecutor, ResearchBranchRoleModelInput } from "./research-branch-role-model.js";

type CapturedModelGatewayFailureCode = Extract<ModelGatewayExecutionErrorCode,
  | "MODEL_GATEWAY_DEPLOYMENT_MISSING"
  | "MODEL_GATEWAY_PROMPT_COMPILE_FAILED"
  | "MODEL_GATEWAY_REQUEST_INVALID"
  | "MODEL_GATEWAY_LIMIT_REJECTED"
  | "MODEL_GATEWAY_UPSTREAM_REJECTED"
  | "MODEL_GATEWAY_RESPONSE_INVALID"
  | "MODEL_GATEWAY_OUTPUT_TRUNCATED">;

export type BranchRoleFailureDisposition =
  | { readonly outcome: "BLOCKED"; readonly kind: "MODEL_FAILURE"; readonly code: CapturedModelGatewayFailureCode }
  | { readonly outcome: "BLOCKED"; readonly kind: "OUTCOME_UNKNOWN"; readonly code: "WORKFLOW_EFFECT_UNCERTAIN" | "MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN" }
  | { readonly outcome: "BLOCKED"; readonly kind: "OUTPUT_INVALID"; readonly code: "WORKFLOW_OUTPUT_CORRUPT" | "MODEL_ATTEMPT_READBACK_CORRUPT" }
  | { readonly outcome: "BLOCKED"; readonly kind: "PREPARATION_FAILED"; readonly code: "WORKFLOW_PREPARATION_FAILED" };

const CAPTURED_MODEL_GATEWAY_FAILURES = new Set<CapturedModelGatewayFailureCode>([
  "MODEL_GATEWAY_DEPLOYMENT_MISSING",
  "MODEL_GATEWAY_PROMPT_COMPILE_FAILED",
  "MODEL_GATEWAY_REQUEST_INVALID",
  "MODEL_GATEWAY_LIMIT_REJECTED",
  "MODEL_GATEWAY_UPSTREAM_REJECTED",
  "MODEL_GATEWAY_RESPONSE_INVALID",
  "MODEL_GATEWAY_OUTPUT_TRUNCATED",
]);

/** Map only the typed failures listed below; access, cancellation, budget and untyped transport/persistence errors propagate. */
export function branchRoleFailureDisposition(error: unknown): BranchRoleFailureDisposition | null {
  if (error instanceof ModelGatewayExecutionError && CAPTURED_MODEL_GATEWAY_FAILURES.has(error.code as CapturedModelGatewayFailureCode)) {
    return { outcome: "BLOCKED", kind: "MODEL_FAILURE", code: error.code as CapturedModelGatewayFailureCode };
  }
  if (error instanceof WorkflowCheckpointError) {
    if (error.code === "WORKFLOW_EFFECT_UNCERTAIN") return { outcome: "BLOCKED", kind: "OUTCOME_UNKNOWN", code: error.code };
    if (error.code === "WORKFLOW_OUTPUT_CORRUPT") return { outcome: "BLOCKED", kind: "OUTPUT_INVALID", code: error.code };
    if (error.code === "WORKFLOW_PREPARATION_FAILED") return { outcome: "BLOCKED", kind: "PREPARATION_FAILED", code: error.code };
  }
  if (error instanceof ModelAttemptError) {
    if (error.code === "MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN") return { outcome: "BLOCKED", kind: "OUTCOME_UNKNOWN", code: error.code };
    if (error.code === "MODEL_ATTEMPT_READBACK_CORRUPT") return { outcome: "BLOCKED", kind: "OUTPUT_INVALID", code: error.code };
  }
  return null;
}

/** Run roles sequentially, materializing only typed role failures while retaining completed siblings. */
export async function executeBranchRolesWithFailureDisposition<T>(
  roles: readonly ResearchBranchRole[],
  execute: (role: ResearchBranchRole) => Promise<T>,
  blocked: (role: ResearchBranchRole, disposition: BranchRoleFailureDisposition) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  for (const role of roles) {
    let result: T;
    try {
      result = await execute(role);
    } catch (error) {
      const disposition = branchRoleFailureDisposition(error);
      if (disposition === null) throw error;
      result = await blocked(role, disposition);
    }
    results.push(result);
  }
  return results;
}

interface BranchRoleModelAttemptV2 {
  readonly role: ResearchBranchRole;
  readonly plan: BranchQueryPlan;
  readonly result: BranchQueryResult;
  readonly selected: readonly ResearchBranchEvidenceItem[];
}

type BranchRoleModelOutcomeV2 =
  | { readonly kind: "OUTPUT"; readonly output: ResearchBranchRoleModelOutputV2 }
  | { readonly kind: "FAILURE"; readonly failure: BranchRoleFailureDisposition };

type BranchRoleModelInvocationV2 = Omit<ResearchBranchRoleModelInput, "role" | "branch_query"> & {
  readonly role_model?: ResearchBranchRoleModelExecutor | undefined;
};

/** Execute selected roles in order, retaining typed blocked outcomes and materializing every sibling result. */
export async function executeResearchBranchRolesV2(
  planning: ResearchPlanningManifest,
  roles: readonly ResearchBranchRole[],
  read: ResearchReadExtractCheckpointV2,
  invocation: BranchRoleModelInvocationV2,
): Promise<ResearchBranchResultV2[]> {
  const parsedRead = ResearchReadExtractCheckpointV2Schema.safeParse(read);
  if (!parsedRead.success) fail("WORKFLOW_OUTPUT_CORRUPT");
  const checkpoint = parsedRead.data;
  const contexts: BranchRoleModelAttemptV2[] = await Promise.all(roles.map(async (role) => {
    const query = checkpoint.role_queries.find((item) => item.query_plan.role === role);
    if (query === undefined) fail("WORKFLOW_OUTPUT_CORRUPT");
    if (!(await branchPlanMatchesPlanningManifest(planning, query.query_plan))) fail("WORKFLOW_OUTPUT_CORRUPT");
    const handles = new Set(query.query_result.resolved_evidence.map((item) => refKey(item.handle.handle_ref)));
    return {
      role,
      plan: query.query_plan,
      result: query.query_result,
      selected: checkpoint.evidence.filter((item) => handles.has(refKey(item.handle_ref))),
    };
  }));
  const modelContexts = contexts.filter((item) => item.selected.length > 0);
  const outcomes = new Map<ResearchBranchRole, BranchRoleModelOutcomeV2>();
  if (modelContexts.length > 0) {
    const roleModel = invocation.role_model;
    if (roleModel === undefined) fail("WORKFLOW_CONFIGURATION_MISSING");
    const modelOutcomes = await executeBranchRolesWithFailureDisposition<BranchRoleModelOutcomeV2>(
      modelContexts.map((item) => item.role),
      async (role) => {
        const item = modelContexts.find((candidate) => candidate.role === role);
        if (item === undefined) throw new Error("branch model role disappeared from its validated execution batch");
        const outputBytes = await roleModel.executeRole({
          role,
          request: invocation.request,
          principal: invocation.principal,
          attempt_ref: invocation.attempt_ref,
          budget_receipt_ref: invocation.budget_receipt_ref,
          input_bytes: invocation.input_bytes,
          branch_query: { plan: item.plan, result: item.result },
        });
        return { kind: "OUTPUT", output: parseBranchRoleModelOutputV2(outputBytes, item.plan, item.result) } as const;
      },
      async (_role, failure) => ({ kind: "FAILURE", failure }) as const,
    );
    modelContexts.forEach((item, index) => {
      const outcome = modelOutcomes[index];
      if (outcome === undefined) fail("WORKFLOW_OUTPUT_CORRUPT");
      outcomes.set(item.role, outcome);
    });
  }

  const results: ResearchBranchResultV2[] = [];
  for (const item of contexts) {
    const outcome = outcomes.get(item.role);
    results.push(await buildRoleResultV2(
      planning,
      item.plan,
      item.result,
      item.selected,
      outcome?.kind === "OUTPUT" ? outcome.output : undefined,
      outcome?.kind === "FAILURE" ? outcome.failure : undefined,
    ));
  }
  return results;
}

function roleForQuestionKind(kind: ResearchPlanningManifest["questions"][number]["kind"]): ResearchBranchRole | null {
  switch (kind) {
    case "support": return "SUPPORT";
    case "counter": return "COUNTER";
    case "alternative": return "ALTERNATIVE";
    case "chronology": return "CHRONOLOGY";
    case "implementation": return "IMPLEMENTATION";
    case "literature": return "LITERATURE";
    case "source_audit": return "SOURCE_AUDIT";
    case "primary": return "SUPPORT";
  }
}

function questionsForRole(planning: ResearchPlanningManifest, role: ResearchBranchRole): string[] {
  return uniqueSorted(planning.questions.filter((item) => roleForQuestionKind(item.kind) === role).map((item) => item.question_id));
}

function hypothesesForRole(planning: ResearchPlanningManifest, role: ResearchBranchRole): string[] {
  if (role !== "ALTERNATIVE") return [];
  return uniqueSorted(planning.hypotheses.map((item) => item.hypothesis_id));
}

export function evidenceForRole(role: ResearchBranchRole, evidence: readonly ResearchBranchEvidenceItem[]): ResearchBranchEvidenceItem[] {
  const contains = (value: string, terms: readonly string[]): boolean => terms.some((term) => value.toLowerCase().includes(term));
  switch (role) {
    case "COUNTER": return evidence.filter((item) => contains(item.source_class, ["counter", "contradict", "refutation"]));
    case "IMPLEMENTATION": return evidence.filter((item) => contains(item.source_class, ["project", "implementation", "runtime", "code", "spec"]));
    case "LITERATURE": return evidence.filter((item) => contains(item.source_class, ["literature", "primary", "secondary", "normative", "empirical"]));
    case "SOURCE_AUDIT": return [...evidence];
    case "SUPPORT": return evidence.filter((item) => !contains(item.source_class, ["counter", "contradict", "refutation"]));
    case "ALTERNATIVE":
    case "CHRONOLOGY":
      return [...evidence];
  }
}

async function observations(role: ResearchBranchRole, evidence: readonly ResearchBranchEvidenceItem[]): Promise<string[]> {
  return Promise.all(evidence.map(async (item) => `eliotr.research.observation-${await evidenceSha256({
    domain: "eliotr.research.branch-observation.v1",
    role,
    handle_ref: item.handle_ref,
    source_revision_ref: item.source_revision_ref,
    source_class: item.source_class,
    source_family_ref: item.source_family_ref,
  })}`));
}

function blockedProbe(role: ResearchBranchRole, failure?: BranchRoleFailureDisposition): string {
  const roleId = role.toLowerCase().replaceAll("_", "-");
  if (failure === undefined) return `eliotr.research.probe.${roleId}.required-evidence`;
  const kind = failure.kind.toLowerCase().replaceAll("_", "-");
  const code = failure.code.toLowerCase().replaceAll("_", "-");
  return `eliotr.research.probe.${roleId}.${kind}.${code}`;
}

function roleFailureUnknown(failure: BranchRoleFailureDisposition): string {
  if (failure.kind === "OUTCOME_UNKNOWN") return `The role model outcome is unknown (${failure.code}); it was not relaunched.`;
  if (failure.kind === "OUTPUT_INVALID") return `The role model output was not trustworthy (${failure.code}); no finding was accepted.`;
  if (failure.kind === "PREPARATION_FAILED") return `The role model could not be prepared (${failure.code}); no finding was accepted.`;
  return `The role model did not produce a finding (${failure.code}).`;
}

function roleLimitations(role: ResearchBranchRole, selected: readonly ResearchBranchEvidenceItem[]): string[] {
  const limitations = [
    "Branch output is candidate material; authoritative claim disposition is assigned only by verification and claim audit.",
  ];
  if (selected.some((item) => item.independence === "UNKNOWN")) {
    limitations.push("At least one selected source family has unknown independence.");
  }
  if (role === "CHRONOLOGY") limitations.push("Chronology ordering requires source-bound dates; evidence selection alone does not establish temporal order.");
  if (role === "IMPLEMENTATION") limitations.push("Project/specification evidence does not by itself establish observed runtime behavior.");
  if (role === "LITERATURE") limitations.push("Source-class metadata does not by itself establish primary-source authority or peer review.");
  if (role === "ALTERNATIVE") limitations.push("Persisted alternatives remain candidates until a named verifier evaluates discriminating checks.");
  return limitations;
}

export async function buildRoleResult(
  planning: ResearchPlanningManifest,
  role: ResearchBranchRole,
  evidence: readonly ResearchBranchEvidenceItem[],
): Promise<ResearchBranchResult> {
  const selected = evidenceForRole(role, evidence);
  const questionIds = questionsForRole(planning, role);
  const hypothesisIds = hypothesesForRole(planning, role);
  const blocked = selected.length === 0 && role !== "SOURCE_AUDIT";
  return branchResult({
    role,
    status: blocked ? "BLOCKED" : "CANDIDATE_READY",
    question_ids: questionIds,
    hypothesis_ids: hypothesisIds,
    evidence_handle_refs: selected.map((item) => item.handle_ref),
    observation_refs: await observations(role, selected),
    unknowns: blocked ? [`No exact admitted evidence was selected for the required ${role} branch.`] : [],
    limitations: roleLimitations(role, selected),
    failed_probe_refs: blocked ? [blockedProbe(role)] : [],
    authoritative_disposition: "UNASSESSED",
  });
}

/**
 * Builds the branch result from validated substantive model output. The model's
 * evidence selection is already bound to the role's pre-selected evidence; the
 * deterministic guardrails (questions, observations, base limitations, blocked
 * probes) are merged, never replaced.
 */
export async function buildRoleResultFromModelOutput(
  planning: ResearchPlanningManifest,
  role: ResearchBranchRole,
  selected: readonly ResearchBranchEvidenceItem[],
  output: ResearchBranchRoleModelOutput,
): Promise<ResearchBranchResult> {
  const selectedByRef = new Map(selected.map((item) => [refKey(item.handle_ref), item]));
  const cited = output.evidence_handle_refs.map((ref) => selectedByRef.get(refKey(ref))).filter((item) => item !== undefined);
  const blocked = output.status === "BLOCKED";
  return branchResult({
    role,
    status: output.status,
    question_ids: questionsForRole(planning, role),
    hypothesis_ids: hypothesesForRole(planning, role),
    evidence_handle_refs: cited.map((item) => item.handle_ref),
    observation_refs: await observations(role, cited),
    unknowns: blocked
      ? [`The ${role} model analysis reported no usable evidence.`]
      : [...output.unknowns],
    limitations: uniqueSorted([...roleLimitations(role, cited), ...output.limitations]),
    failed_probe_refs: blocked ? [blockedProbe(role)] : [],
    authoritative_disposition: "UNASSESSED",
  });
}

function findingKindForRole(role: ResearchBranchRole): BranchFindingDraft["kind"] {
  switch (role) {
    case "COUNTER": return "COUNTEREVIDENCE";
    case "ALTERNATIVE": return "ALTERNATIVE";
    case "CHRONOLOGY": return "CHRONOLOGY";
    case "IMPLEMENTATION": return "IMPLEMENTATION";
    case "SOURCE_AUDIT": return "SOURCE_QUALITY";
    case "SUPPORT":
    case "LITERATURE": return "SUPPORT";
  }
}

async function branchPlanMatchesPlanningManifest(
  planning: ResearchPlanningManifest,
  plan: BranchQueryPlan,
): Promise<boolean> {
  const rootQuestion = planning.questions.find((question) => question.question_id === planning.primary_question_id);
  const branchQuestion = planning.questions.find((question) => question.question_id === plan.branch_question.question_ref.id);
  if (planning.identity_digest !== plan.planning_manifest_digest ||
      refKey(planning.manifest_ref) !== refKey(plan.planning_manifest_ref) ||
      rootQuestion === undefined || branchQuestion === undefined ||
      rootQuestion.question_id !== plan.root_question.question_ref.id ||
      rootQuestion.text !== plan.root_question.text ||
      branchQuestion.text !== plan.branch_question.text ||
      roleForQuestionKind(branchQuestion.kind) !== plan.role) {
    return false;
  }
  const [rootDigest, branchDigest] = await Promise.all([
    evidenceSha256({
      domain: "eliotr.research.branch-query-question.v1",
      value: { question_ref: plan.root_question.question_ref, text: rootQuestion.text },
    }),
    evidenceSha256({
      domain: "eliotr.research.branch-query-question.v1",
      value: { question_ref: plan.branch_question.question_ref, text: branchQuestion.text },
    }),
  ]);
  return rootDigest === plan.root_question.text_sha256 && branchDigest === plan.branch_question.text_sha256;
}

/** Server binds a validated model draft to its exact plan, result and resolved evidence. */
export async function buildRoleResultV2(
  planning: ResearchPlanningManifest,
  plan: BranchQueryPlan,
  queryResult: BranchQueryResult,
  evidence: readonly ResearchBranchEvidenceItem[],
  output?: ResearchBranchRoleModelOutputV2,
  failure?: BranchRoleFailureDisposition,
): Promise<ResearchBranchResultV2> {
  const role = ResearchBranchRoleSchema.parse(plan.role);
  if (!(await branchPlanMatchesPlanningManifest(planning, plan))) {
    throw new Error("branch result plan is not bound to the committed planning manifest questions");
  }
  if (output !== undefined && failure !== undefined) throw new Error("branch role result cannot accept both model output and failure disposition");
  const blocked = failure !== undefined || output === undefined || output.finding.state === "BLOCKED";
  const draft: BranchFindingDraft = output?.finding ?? {
    protocol: "eliotr.research.branch-finding-draft.v1",
    role,
    question_ref: { ...plan.branch_question.question_ref },
    question_sha256: plan.branch_question.text_sha256,
    kind: findingKindForRole(role),
    state: "BLOCKED",
    statement: "",
    conditions: [],
    scope: plan.branch_question.text,
    evidence_handle_refs: [],
    unknowns: failure === undefined
      ? ["No exact admissible evidence was resolved for this required branch question."]
      : [roleFailureUnknown(failure)],
    limitations: [],
  };
  const allowed = new Map(evidence.map((item) => [refKey(item.handle_ref), item]));
  const cited = draft.evidence_handle_refs.map((ref) => allowed.get(refKey(ref)));
  if (cited.some((item) => item === undefined)) throw new Error("finding cites a handle outside the exact branch evidence");
  const selected = cited.filter((item): item is ResearchBranchEvidenceItem => item !== undefined);
  if (!blocked && selected.length === 0) throw new Error("candidate finding has no exact branch evidence");
  const candidateMaterial = {
    protocol: "eliotr.research.branch-finding.v1" as const,
    role,
    question_ref: { ...plan.branch_question.question_ref },
    question_sha256: plan.branch_question.text_sha256,
    kind: draft.kind,
    state: blocked ? "BLOCKED" as const : "CANDIDATE" as const,
    statement: blocked ? "" : draft.statement,
    conditions: blocked ? [] : [...draft.conditions],
    scope: draft.scope,
    evidence_handle_refs: blocked ? [] : selected.map((item) => ({ ...item.handle_ref })),
    unknowns: [...draft.unknowns],
    limitations: uniqueSorted([...roleLimitations(role, selected), ...draft.limitations]),
  };
  const findingDigest = await evidenceSha256({ domain: "eliotr.research.branch-finding.v1", value: candidateMaterial });
  const finding = BranchFindingCandidateSchema.parse({
    ...candidateMaterial,
    finding_ref: { id: `eliotr.research.branch-finding-${findingDigest}`, revision: 1 },
    identity_digest: findingDigest,
  });
  const value = {
    protocol: "eliotr.research.branch-result.v2" as const,
    branch_ref: { ...plan.branch_ref },
    role,
    status: blocked ? "BLOCKED" as const : "CANDIDATE_READY" as const,
    question_ids: uniqueSorted(plan.question_refs.map((ref) => ref.id)),
    hypothesis_ids: [...plan.hypothesis_refs],
    evidence_handle_refs: finding.evidence_handle_refs.map((ref) => ({ ...ref })),
    observation_refs: await observations(role, selected),
    unknowns: [...finding.unknowns],
    limitations: [...finding.limitations],
    failed_probe_refs: blocked ? [blockedProbe(role, failure)] : [],
    authoritative_disposition: "UNASSESSED" as const,
    query_plan: plan,
    query_result: queryResult,
    findings: [finding],
  };
  const identity = await evidenceSha256({ domain: "eliotr.research.branch-result.v2", value });
  return ResearchBranchResultV2Schema.parse({
    ...value,
    result_ref: { id: `eliotr.research.branch-result-v2-${identity}`, revision: 1 },
    identity_digest: identity,
  });
}

export async function debtFor(result: ResearchBranchResult | ResearchBranchResultV2): Promise<ResearchDebt> {
  const kind: ResearchDebt["kind"] = result.role === "COUNTER" ? "contradiction"
    : result.role === "SOURCE_AUDIT" ? "provenance"
      : result.role === "IMPLEMENTATION" ? "verification"
        : "epistemic";
  const base = {
    kind,
    blocked_refs: [result.role],
    basis_and_evidence_refs: result.evidence_handle_refs.map(refKey),
    owner: "research-workflow",
    blocking_effect: `Required ${result.role} branch is not satisfied.`,
    next_probe: `Execute ${result.role} against exact admitted evidence within the frozen scope.`,
    review_condition: `A persisted ${result.role} branch result is available and passes currentness checks.`,
    status: "OPEN" as const,
  };
  const digest = await evidenceSha256({ domain: "eliotr.research.branch-debt.v1", value: base });
  return ResearchDebtSchema.parse({ ...base, debt_ref: { id: `eliotr.research.debt-${digest}`, revision: 1 } });
}

export function sortedRoles(roles: readonly ResearchBranchRole[]): ResearchBranchRole[] {
  return uniqueSorted(roles).map((role) => ResearchBranchRoleSchema.parse(role));
}
