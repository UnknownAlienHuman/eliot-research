import { describe, expect, it } from "vitest";
import {
  SERVER_OWNED_BRANCH_HANDLER_GENERATION,
  SERVER_OWNED_BRANCH_QUERY_HANDLER_GENERATION,
  SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION,
  SERVER_OWNED_SEMANTIC_HANDLER_GENERATION,
} from "@eliotr/cloudflare-research-runtime/research-stage-handlers.js";
import type { ResearchBranchQueryBudgetSelection } from
  "@eliotr/cloudflare-research-configuration/research-run-configuration.js";
import { selectResearchRunHandlerGeneration } from "./research-run-service.js";

const selectedBudgetProfile: ResearchBranchQueryBudgetSelection = {
  protocol: "eliotr.research.branch-query-budget-selection.v1",
  profile_id: "branch-budget-profile-1",
  profile_generation: 4,
  budgets: {
    candidate_limit: 9,
    scan_limit: 23,
    evidence_limit: 2,
    max_evidence_bytes: 2048,
    max_query_legs: 3,
  },
  selected_configuration: {
    owner_ref: "owner-1",
    project_id: "project-1",
    configuration_ref: `rpmc-${"a".repeat(64)}`,
    configuration_sha256: "a".repeat(64),
    selection_revision: 7,
  },
};

const newExplicitOwnerBranch = {
  lane: "exploratory" as const,
  prior_handler_generation: null,
  explicit_protocol: true,
  delegated: false,
  managed_primary_available: true,
};

describe("new-run branch handler generation admission", () => {
  it("selects V9 only after capture supplied a complete owner profile and managed primary", () => {
    expect(selectResearchRunHandlerGeneration({
      ...newExplicitOwnerBranch,
      branch_query_budget_selection: selectedBudgetProfile,
    })).toBe(SERVER_OWNED_BRANCH_QUERY_HANDLER_GENERATION);
  });

  it("keeps profile-absent protocol runs on the historical V7 generation", () => {
    expect(selectResearchRunHandlerGeneration(newExplicitOwnerBranch))
      .toBe(SERVER_OWNED_BRANCH_HANDLER_GENERATION);
  });

  it("fails closed when a declared profile has no managed primary binding", () => {
    expect(() => selectResearchRunHandlerGeneration({
      ...newExplicitOwnerBranch,
      managed_primary_available: false,
      branch_query_budget_selection: selectedBudgetProfile,
    })).toThrow(expect.objectContaining({ code: "RESEARCH_AGENT_NOT_CONFIGURED" }));
  });

  it("reuses a persisted generation during replay instead of reclassifying the request", () => {
    expect(selectResearchRunHandlerGeneration({
      ...newExplicitOwnerBranch,
      prior_handler_generation: SERVER_OWNED_SEMANTIC_HANDLER_GENERATION,
      explicit_protocol: false,
      delegated: true,
    })).toBe(SERVER_OWNED_SEMANTIC_HANDLER_GENERATION);
    expect(selectResearchRunHandlerGeneration({
      ...newExplicitOwnerBranch,
      prior_handler_generation: SERVER_OWNED_BRANCH_QUERY_HANDLER_GENERATION,
      explicit_protocol: false,
      delegated: true,
      branch_query_budget_selection: selectedBudgetProfile,
    })).toBe(SERVER_OWNED_BRANCH_QUERY_HANDLER_GENERATION);
    expect(() => selectResearchRunHandlerGeneration({
      ...newExplicitOwnerBranch,
      prior_handler_generation: SERVER_OWNED_BRANCH_QUERY_HANDLER_GENERATION,
      explicit_protocol: false,
      delegated: true,
    })).toThrow(expect.objectContaining({ code: "RESEARCH_AUTHORITY_STALE" }));
    expect(selectResearchRunHandlerGeneration({
      ...newExplicitOwnerBranch,
      prior_handler_generation: SERVER_OWNED_BRANCH_HANDLER_GENERATION,
      branch_query_budget_selection: selectedBudgetProfile,
    })).toBe(SERVER_OWNED_BRANCH_HANDLER_GENERATION);
    expect(selectResearchRunHandlerGeneration({
      ...newExplicitOwnerBranch,
      prior_handler_generation: SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION,
      branch_query_budget_selection: selectedBudgetProfile,
    })).toBe(SERVER_OWNED_EXTERNAL_AGENT_HANDLER_GENERATION);
  });
});
