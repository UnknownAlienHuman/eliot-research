import { describe, expect, it } from "vitest";
import { evidenceSha256Bytes, evidenceUtf8Bytes } from "@eliotr/cloudflare-evidence";
import type { ResearchProjectModelConfigurationBundle } from "@eliotr/cloudflare-research";
import { createResearchOwnerRuntimeConfiguration } from "@eliotr/cloudflare-research-configuration/research-owner-runtime-config.js";
import type { Env } from "../src/env.js";
import { readResearchConfigurationStatus } from "../src/research-configuration-status.js";
import { readResearchSemanticConfigSource } from "../src/research-semantic-config-revision.js";
import { composeSelectedProjectResearchReadinessEnv } from "../src/research-project-configuration-composition.js";
import { admissionTestConfiguration } from "./research-current-dispatch-config.js";

const OWNER = Object.freeze({
  principal_ref: "project-readiness-owner",
  credential_generation: "project-readiness-credential",
  client_class: "owner_pwa" as const,
});

async function runtimeVars() {
  const compiled = await createResearchOwnerRuntimeConfiguration(
    admissionTestConfiguration("project-readiness-generation", OWNER.principal_ref, "project-readiness"),
  );
  return compiled.vars as typeof compiled.vars & ResearchProjectModelConfigurationBundle["vars"];
}

describe("selected project research readiness environment", () => {
  it("uses the selected revision with qualified pins and leaves global legacy readiness unchanged", async () => {
    const vars = await runtimeVars();
    const semanticJson = vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON;
    const semanticSha = await evidenceSha256Bytes(evidenceUtf8Bytes(semanticJson));
    const bundle: ResearchProjectModelConfigurationBundle = {
      protocol: "eliotr.research-project-model-configuration.v1",
      semantic_revision: { revision_ref: `scr-${semanticSha.slice(0, 12)}`, config_sha256: semanticSha },
      model_selections: ["SYNTHESIZE", "AUDIT_CLAIMS"].map((stage, index) => ({
        stage,
        route_ref: index === 0 ? "dynamic/eliotr-balanced" : "dynamic/eliotr-audit-verifier",
        route_version: `project-readiness-${stage.toLowerCase()}`,
        candidate_ref: `candidate-project-readiness-${stage.toLowerCase()}`,
        candidate_sha256: (index === 0 ? "a" : "b").repeat(64),
        qualification_ref: `qualification-project-readiness-${stage.toLowerCase()}`,
        qualification_sha256: (index === 0 ? "c" : "d").repeat(64),
        transport_policy: {
          version: 1,
          transport: "cloudflare-ai-gateway",
          api: "compat-chat-completions",
          provider: "admission-fixture-provider",
          model: "admission-fixture-model",
          billing: { mode: "unified" },
          capabilities: { max_output_tokens_field: "max_tokens", reasoning_efforts: ["low", "medium", "high", "max"] },
        },
      })),
      vars,
    };
    const base = {
      ...vars,
      ENVIRONMENT: "development",
      DEPLOYMENT_GENERATION: "project-readiness-generation",
      AI_GATEWAY_REASONING_URL: "https://gateway.example/v1",
      AI: { gateway: async () => new Response() },
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: "stale-global-semantic-json",
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0: "stale-global-chunk-0",
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_1: "stale-global-chunk-1",
    } as unknown as Env;

    const selectedEnv = composeSelectedProjectResearchReadinessEnv(base, bundle);
    expect(readResearchSemanticConfigSource(selectedEnv)).toEqual({
      kind: "revision",
      revision_ref: bundle.semantic_revision.revision_ref,
      config_sha256: bundle.semantic_revision.config_sha256,
    });
    const selectedStatus = readResearchConfigurationStatus(selectedEnv, OWNER);
    expect(selectedStatus.configuration).toBe("present");
    expect(selectedStatus.invalid_fields).not.toContain("ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF");
    expect(selectedStatus.invalid_fields).not.toContain("ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256");
    expect(bundle.model_selections).toHaveLength(2);

    const globalLegacyEnv = {
      ...vars,
      ENVIRONMENT: "development",
      DEPLOYMENT_GENERATION: "project-readiness-generation",
      AI_GATEWAY_REASONING_URL: "https://gateway.example/v1",
      AI: { gateway: async () => new Response() },
    } as unknown as Env;
    expect(readResearchConfigurationStatus(globalLegacyEnv, OWNER).configuration).toBe("present");

    const ambiguous = {
      ...selectedEnv,
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: semanticJson,
    } as Env;
    expect(readResearchConfigurationStatus(ambiguous, OWNER).invalid_fields).toEqual(expect.arrayContaining([
      "ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF",
      "ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256",
    ]));
  });
});
