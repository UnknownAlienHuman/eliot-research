import { describe, expect, it } from "vitest";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import type { ResearchConfigurationReadiness } from "./research-configuration-readiness.js";
import { isEvidenceReviewMethodReady, resolveEvidenceReviewMethod } from "./research-configuration-readiness.js";
import { RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_PROTOCOL, captureResearchBranchQueryBudgetSelection } from "./research-branch-query-budget-selection.js";

const provenance = { owner_ref: "owner-1", project_id: "project-1", configuration_ref: `rpmc-${"a".repeat(64)}`,
  configuration_sha256: "a".repeat(64), selection_revision: 3 } as const;
const pin = { configuration_project_id: provenance.project_id, configuration_ref: provenance.configuration_ref,
  configuration_sha256: provenance.configuration_sha256, selection_revision: provenance.selection_revision } as const;
const readiness: ResearchConfigurationReadiness = { protocol: "eliotr.research-configuration-readiness.v1",
  configuration: "present", model_transport: "available", qualification_state: "current", run_readiness: "ready",
  readiness_reason: "QUALIFICATION_PROOFS_CURRENT", model_route: "route/research", qualification_expires_at: null,
  missing_fields: [], invalid_fields: [], checked_at: "2026-10-17T12:00:00.000Z" };
const stages = ["ANALYZE_BRANCHES", "COUNTER_SEARCH", "SYNTHESIZE", "AUDIT_CLAIMS"].map(stage => ({ stage }));
const managed = { namespace: "eliotr", instance_id: "private-prose-g2", index_generation: "gen-1", registry_revision: 2,
  registry_artifact_sha256: "b".repeat(64), max_num_results: 16, reranking_model: "@cf/rerank" } as const;
const budget = captureResearchBranchQueryBudgetSelection({ expected_owner_ref: provenance.owner_ref,
  selected_configuration: provenance, profile_json: canonicalJson({ protocol: RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_PROTOCOL,
    profile_id: "profile-1", profile_generation: 1, budgets: { candidate_limit: 4, scan_limit: 8, evidence_limit: 4,
      max_evidence_bytes: 1024, max_query_legs: 2 } }) });

const input = () => ({ readiness, expected_pin: pin, selected_pin: pin, selected_provenance: provenance,
  model_selections: stages, branch_query_budget_profile_present: true,
  branch_query_budget_selection: budget, managed_primary: managed });

describe("evidence-review method readiness", () => {
  it("requires current readiness, the exact four qualified stage bindings, captured same-pin budget, and managed registry", () => {
    expect(isEvidenceReviewMethodReady(input())).toBe(true);
    expect(isEvidenceReviewMethodReady({ ...input(), readiness: { ...readiness, run_readiness: "lazy_renewal" } })).toBe(false);
    expect(isEvidenceReviewMethodReady({ ...input(), expected_pin: { ...pin, selection_revision: 4 } })).toBe(false);
    expect(isEvidenceReviewMethodReady({ ...input(), model_selections: stages.slice(1) })).toBe(false);
    expect(isEvidenceReviewMethodReady({ ...input(), model_selections: [...stages, { stage: "SYNTHESIZE" }] })).toBe(false);
    const { branch_query_budget_selection: _budget, ...withoutBudget } = input();
    const { managed_primary: _managed, ...withoutManaged } = input();
    expect(isEvidenceReviewMethodReady(withoutBudget)).toBe(false);
    expect(isEvidenceReviewMethodReady(withoutManaged)).toBe(false);
  });

  it("fails closed when the captured profile is bound to another selection or exceeds the run evidence cap", () => {
    const otherBudget = captureResearchBranchQueryBudgetSelection({ expected_owner_ref: provenance.owner_ref,
      selected_configuration: { ...provenance, selection_revision: 4 }, profile_json: canonicalJson({
        protocol: RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_PROTOCOL, profile_id: "profile-1", profile_generation: 1,
        budgets: { candidate_limit: 4, scan_limit: 8, evidence_limit: 4, max_evidence_bytes: 1024, max_query_legs: 2 } }) });
    expect(isEvidenceReviewMethodReady({ ...input(), branch_query_budget_selection: otherBudget })).toBe(false);
    const oversizedBudget = captureResearchBranchQueryBudgetSelection({ expected_owner_ref: provenance.owner_ref,
      selected_configuration: provenance, profile_json: canonicalJson({ protocol: RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_PROTOCOL,
        profile_id: "profile-1", profile_generation: 1, budgets: { candidate_limit: 4, scan_limit: 8,
          evidence_limit: 17, max_evidence_bytes: 1024, max_query_legs: 2 } }) });
    expect(isEvidenceReviewMethodReady({ ...input(), branch_query_budget_selection: oversizedBudget })).toBe(false);
  });

  it("reports the legacy V7 path when no V9 branch profile is configured", () => {
    const { branch_query_budget_profile_present: _profile, branch_query_budget_selection: _budget,
      managed_primary: _managed, ...base } = input();
    const decision = resolveEvidenceReviewMethod({ ...base, branch_query_budget_profile_present: false });
    expect(decision).toEqual({ handler_generation: "V7", unavailable_reason: null });
    expect(isEvidenceReviewMethodReady({ ...base, branch_query_budget_profile_present: false })).toBe(true);
  });

  it("names the missing V9 managed registry rather than claiming legacy V7 is unavailable", () => {
    const { managed_primary: _managed, ...withoutManaged } = input();
    const decision = resolveEvidenceReviewMethod(withoutManaged);
    expect(decision).toEqual({ handler_generation: null, unavailable_reason: "V9_MANAGED_SEARCH_UNAVAILABLE" });
  });
});
