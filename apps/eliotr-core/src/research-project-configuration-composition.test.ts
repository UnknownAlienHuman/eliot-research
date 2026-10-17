import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "./env.js";

const f = vi.hoisted(() => ({ selected: vi.fn(), readiness: vi.fn(), managed: vi.fn() }));
vi.mock("./research-project-configuration.js", () => ({
  createResearchProjectModelConfigurationServiceFromEnv: () => ({}),
  createResearchProjectCatalogNativeModelV2AuthorityFactory: () => () => ({}),
  readSelectedResearchProjectConfiguration: f.selected,
  ResearchProjectModelConfigurationAuthorityError: class extends Error {},
}));
vi.mock("./research-configuration-readiness.js", async original => ({
  ...await original<Record<string, unknown>>(), readResearchConfigurationReadiness: f.readiness,
}));
vi.mock("@eliotr/cloudflare-ai/project-search", async original => ({
  ...await original<Record<string, unknown>>(), assertProjectSearchManagedPrimaryAvailable: f.managed,
}));

import { readOwnerProjectResearchMethodReadiness } from "./research-project-configuration-composition.js";

const projectId = "project-1";
const selectionRevision = 7;
const configurationRef = `rpmc-${"a".repeat(64)}`;
const configurationSha = "a".repeat(64);
const selected = {
  project_id: projectId, owner_id: "owner-1", selection_revision: selectionRevision,
  configuration_ref: configurationRef, configuration_sha256: configurationSha,
  configuration: {
    semantic_revision: { revision_ref: "semantic-1", config_sha256: "c".repeat(64) },
    vars: { ELIOTR_RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_JSON: canonicalJson({
      protocol: "eliotr.research.branch-query-budget-profile.v1", profile_id: "profile-1", profile_generation: 2,
      budgets: { candidate_limit: 4, scan_limit: 8, evidence_limit: 4, max_evidence_bytes: 1024, max_query_legs: 2 },
    }) },
    model_selections: ["ANALYZE_BRANCHES", "COUNTER_SEARCH", "SYNTHESIZE", "AUDIT_CLAIMS"].map(stage => ({ stage })),
  },
};
const readiness = { protocol: "eliotr.research-configuration-readiness.v1", configuration: "present",
  model_transport: "available", qualification_state: "current", run_readiness: "ready",
  readiness_reason: "QUALIFICATION_PROOFS_CURRENT", model_route: "route/research", qualification_expires_at: null,
  missing_fields: [], invalid_fields: [], checked_at: "2026-10-17T12:00:00.000Z" };
const managed = { namespace: "eliotr", instance_id: "private-prose-g2", index_generation: "gen-1", registry_revision: 3,
  registry_artifact_sha256: "b".repeat(64), max_num_results: 16, reranking_model: "@cf/rerank" };
const context = { principal_ref: "owner-1", credential_generation: "credential-1", client_class: "owner_pwa",
  request: new Request("https://owner.invalid/api/v1/system/research-configuration") } as unknown as AuthenticatedRequestContext;
const env = { CORE_DB: {}, SEARCH_DB: {}, DEPLOYMENT_GENERATION: "deploy-1",
  AI_SEARCH: { get: () => ({ search: async () => ({}) }) } } as unknown as Env;
const pin = { configuration_project_id: projectId, configuration_ref: configurationRef,
  configuration_sha256: configurationSha, selection_revision: selectionRevision };

beforeEach(() => {
  f.selected.mockReset().mockResolvedValue(selected);
  f.readiness.mockReset().mockResolvedValue(readiness);
  f.managed.mockReset().mockResolvedValue(managed);
});

describe("owner project method readiness composition", () => {
  it("requires the current pin and the actual managed registry preflight before affirming review", async () => {
    const result = await readOwnerProjectResearchMethodReadiness(env, context, pin);
    expect(result).toMatchObject({ protocol: "eliotr.research-configuration-method-readiness.v1", project_id: projectId,
      selected_pin: pin, evidence_review_ready: true, evidence_review_handler_generation: "V9",
      evidence_review_unavailable_reason: null });
    expect(f.selected).toHaveBeenCalledTimes(2);
    expect(f.managed).toHaveBeenCalledExactlyOnceWith({ search_database: env.SEARCH_DB, namespace: env.AI_SEARCH });
  });

  it("returns unavailable when the registry preflight fails and rejects a pin that changes during the read", async () => {
    f.managed.mockRejectedValue(new Error("active registry unavailable"));
    const unavailable = await readOwnerProjectResearchMethodReadiness(env, context, pin);
    expect(unavailable.evidence_review_ready).toBe(false);
    expect(unavailable.evidence_review_unavailable_reason).toBe("V9_MANAGED_SEARCH_UNAVAILABLE");

    f.selected.mockResolvedValueOnce(selected).mockResolvedValueOnce({ ...selected, selection_revision: selectionRevision + 1 });
    await expect(readOwnerProjectResearchMethodReadiness(env, context, pin))
      .rejects.toMatchObject({ code: "RESEARCH_AUTHORITY_STALE", status: 409 });
  });

  it("affirms the V7 four-stage path without a V9 budget profile or managed-search registry", async () => {
    f.selected.mockResolvedValue({ ...selected, configuration: { ...selected.configuration, vars: {} } });
    const result = await readOwnerProjectResearchMethodReadiness(env, context, pin);
    expect(result).toMatchObject({ evidence_review_ready: true, evidence_review_handler_generation: "V7",
      evidence_review_unavailable_reason: null });
    expect(f.managed).not.toHaveBeenCalled();
  });
});
