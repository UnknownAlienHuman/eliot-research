import {
  ResearchBranchRoleSchema,
  ResearchDebtSchema,
  type ResearchBranchEvidenceItem,
  type ResearchBranchResult,
  type ResearchBranchRole,
  type ResearchDebt,
  type ResearchPlanningManifest,
} from "@eliotr/contracts";
import { evidenceSha256 } from "@eliotr/cloudflare-evidence";
import { branchResult, refKey, uniqueSorted } from "./research-branch-execution-shared.js";

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

function evidenceForRole(role: ResearchBranchRole, evidence: readonly ResearchBranchEvidenceItem[]): ResearchBranchEvidenceItem[] {
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

function blockedProbe(role: ResearchBranchRole): string {
  return `eliotr.research.probe.${role.toLowerCase().replaceAll("_", "-")}.required-evidence`;
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

export async function debtFor(result: ResearchBranchResult): Promise<ResearchDebt> {
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
