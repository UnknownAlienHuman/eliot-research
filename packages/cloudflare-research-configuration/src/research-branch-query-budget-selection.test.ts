import { describe, expect, it } from "vitest";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import {
  RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_PROTOCOL,
  branchQueryBudgetSelectionMatchesRun,
  captureResearchBranchQueryBudgetSelection,
  parseResearchBranchQueryBudgetSelection,
  type SelectedResearchProjectConfigurationProvenance,
} from "./research-branch-query-budget-selection.js";

const selectedConfiguration: SelectedResearchProjectConfigurationProvenance = {
  owner_ref: "owner-1",
  project_id: "project-1",
  configuration_ref: `rpmc-${"a".repeat(64)}`,
  configuration_sha256: "a".repeat(64),
  selection_revision: 7,
};

const profileBudgets = {
  candidate_limit: 7,
  scan_limit: 20,
  evidence_limit: 2,
  max_evidence_bytes: 1024,
  max_query_legs: 3,
} as const;

function profileJson(overrides: Record<string, unknown> = {}): string {
  return canonicalJson({
    protocol: RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_PROTOCOL,
    profile_id: "research-query-profile-1",
    profile_generation: 2,
    budgets: profileBudgets,
    ...overrides,
  });
}

describe("owner-selected branch query budget profile capture", () => {
  it("captures the complete profile tuple with the exact selected bundle provenance", () => {
    const selection = captureResearchBranchQueryBudgetSelection({
      profile_json: profileJson(),
      selected_configuration: selectedConfiguration,
      expected_owner_ref: "owner-1",
    });

    expect(selection).toEqual({
      protocol: "eliotr.research.branch-query-budget-selection.v1",
      profile_id: "research-query-profile-1",
      profile_generation: 2,
      budgets: profileBudgets,
      selected_configuration: selectedConfiguration,
    });
    expect(parseResearchBranchQueryBudgetSelection(selection)).toEqual(selection);
  });

  it("fails closed when a declared profile is malformed", () => {
    expect(() => captureResearchBranchQueryBudgetSelection({
      profile_json: "{",
      selected_configuration: selectedConfiguration,
      expected_owner_ref: "owner-1",
    })).toThrowError(expect.objectContaining({ code: "WORKFLOW_CONFIGURATION_INVALID" }));

    expect(() => captureResearchBranchQueryBudgetSelection({
      profile_json: profileJson({ unrecognized: true }),
      selected_configuration: selectedConfiguration,
      expected_owner_ref: "owner-1",
    })).toThrowError(expect.objectContaining({ code: "WORKFLOW_CONFIGURATION_INVALID" }));

    expect(() => captureResearchBranchQueryBudgetSelection({
      profile_json: "",
      selected_configuration: selectedConfiguration,
      expected_owner_ref: "owner-1",
    })).toThrowError(expect.objectContaining({ code: "WORKFLOW_CONFIGURATION_INVALID" }));
  });

  it("rejects a selected bundle from another owner", () => {
    expect(() => captureResearchBranchQueryBudgetSelection({
      profile_json: profileJson(),
      selected_configuration: { ...selectedConfiguration, owner_ref: "owner-foreign" },
      expected_owner_ref: "owner-1",
    })).toThrowError(expect.objectContaining({ code: "WORKFLOW_AUTHORITY_STALE" }));
  });

  it("detects selected profile provenance drift without reading current selection", () => {
    const selection = captureResearchBranchQueryBudgetSelection({
      profile_json: profileJson(),
      selected_configuration: selectedConfiguration,
      expected_owner_ref: "owner-1",
    });
    if (selection === undefined) throw new Error("declared profile was not captured");

    expect(branchQueryBudgetSelectionMatchesRun({
      selection,
      owner_ref: "owner-1",
      project_configuration: selectedConfiguration,
    })).toBe(true);
    expect(branchQueryBudgetSelectionMatchesRun({
      selection,
      owner_ref: "owner-1",
      project_configuration: { ...selectedConfiguration, selection_revision: 8 },
    })).toBe(false);
    expect(branchQueryBudgetSelectionMatchesRun({
      selection,
      owner_ref: "owner-1",
      project_configuration: { ...selectedConfiguration, configuration_sha256: "b".repeat(64) },
    })).toBe(false);
  });
});
