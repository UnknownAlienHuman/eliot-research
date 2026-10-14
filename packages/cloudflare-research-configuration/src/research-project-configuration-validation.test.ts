import { describe, expect, it, vi } from "vitest";
import { canonicalModelGatewayJson, modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import { createResearchProjectModelConfigurationValidator } from "./research-project-configuration-validation.js";

describe("research project branch query budget profile validation", () => {
  it("rejects an unsupported declared profile before model qualification reads", async () => {
    const semantic = canonicalModelGatewayJson({
      protocol: "eliotr.research-semantic-config.v1",
      test: true,
    });
    const semanticSha = await modelGatewaySha256(semantic);
    const budgetProfile = canonicalJson({
      protocol: "eliotr.research.branch-query-budget-profile.v2",
      profile_id: "branch-profile-foreign-version",
      profile_generation: 3,
      budgets: {
        candidate_limit: 9,
        scan_limit: 23,
        evidence_limit: 2,
        max_evidence_bytes: 2048,
        max_query_legs: 3,
      },
    });
    const configuration = {
      protocol: "eliotr.research-project-model-configuration.v1",
      semantic_revision: {
        revision_ref: `scr-${semanticSha.slice(0, 12)}`,
        config_sha256: semanticSha,
      },
      model_selections: [],
      vars: {
        ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: semantic,
        ELIOTR_MODEL_PROFILE_DEFINITION_JSON: canonicalModelGatewayJson({ schema: "profile" }),
        ELIOTR_MODEL_PROFILE_PROVENANCE_REF: "profile-provenance-1",
        ELIOTR_MODEL_SPEND_POLICY_JSON: canonicalModelGatewayJson({ schema: "spend" }),
        ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: "spend-provenance-1",
        ELIOTR_RESEARCH_REPORT_CONFIG_JSON: canonicalModelGatewayJson({ schema: "report" }),
        ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: "report-provenance-1",
        ELIOTR_RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_JSON: budgetProfile,
      },
    };
    const prepare = vi.fn(() => { throw new Error("invalid profile must fail before qualification reads"); });
    const validate = createResearchProjectModelConfigurationValidator({
      database: { prepare } as unknown as D1Database,
    });

    await expect(validate(configuration, "owner-1", "project-1"))
      .rejects.toMatchObject({ code: "RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", status: 400 });
    expect(prepare).not.toHaveBeenCalled();
  });
});
