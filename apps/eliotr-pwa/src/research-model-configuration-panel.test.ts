import { describe, expect, it } from "vitest";
import { ApiRequestError } from "./api.js";
import {
  researchModelBillingLabel,
  researchModelSelectionBillingLabel,
  researchModelSelectionEffortLabel,
  researchModelSelectionEffectiveEffortLabel,
  type ResearchModelCatalogEntry,
  type ResearchModelConfigurationRevision,
  type ResearchModelTransportPolicy,
} from "./research-model-configuration-api.js";
import {
  notifyResearchModelSelectionSaved,
  RESEARCH_MODEL_SELECTION_SAVED_EVENT,
  researchModelConfigurationErrorCopy,
} from "./research-model-configuration-panel.js";
import {
  researchModelConfigurationMatchesCatalog,
  researchModelConfigurationIsSelectable,
  researchModelConfigurationRevisionLabel,
  researchModelCatalogProviderOptions,
} from "./research-model-configuration-view.js";

const policy: ResearchModelTransportPolicy = {
  version: 1,
  transport: "cloudflare-ai-gateway",
  api: "compat-chat-completions",
  provider: "openai",
  model: "glm-5.3-flash",
  billing: { mode: "byok", alias: "default" },
  capabilities: { max_output_tokens_field: "max_tokens", reasoning_efforts: ["max", "high", "low"] },
};

const revision: ResearchModelConfigurationRevision = {
  configuration_ref: "model-config-1",
  configuration_sha256: "a".repeat(64),
  created_at: "2026-10-03T12:00:00.000Z",
  qualification_state: "qualified",
  semantic_revision: { revision_ref: "semantic-1", config_sha256: "b".repeat(64) },
  model_selections: [{
    stage: "SYNTHESIZE",
    route_ref: "route/research",
    route_version: "v1",
    candidate_ref: "candidate-1",
    candidate_sha256: "c".repeat(64),
    qualification_ref: "qualification-1",
    qualification_sha256: "d".repeat(64),
    provider_id: "openai",
    model_id: "glm-5.3-flash",
    effective_reasoning_effort: "max",
    transport_policy: policy,
  }],
};

const catalogEntry: ResearchModelCatalogEntry = {
  provider_id: "openai",
  model_id: "glm-5.3-flash",
  name: "GLM 5.3 Flash",
  description: "Listed model entry.",
  catalog_availability: "listed",
  account_availability: "unknown",
  capabilities: { text_generation: "supported", input_output_schema: "unknown", schema_requirement: null },
  source_id: null,
  source_task: null,
  billing: { selected_path: "provider_catalog", support: "byok", account_entitlement: "not_established_by_catalog" },
  properties: [],
  tags: ["text-generation"],
};

describe("project model selector copy and boundaries", () => {
  it("signals successful project model selection to readiness listeners", () => {
    const target = new EventTarget();
    let saved = 0;
    target.addEventListener(RESEARCH_MODEL_SELECTION_SAVED_EVENT, () => { saved += 1; });

    notifyResearchModelSelectionSaved(target);

    expect(saved).toBe(1);
  });

  it("distinguishes an Access session loss from an ordinary project policy denial", () => {
    const sessionLoss = researchModelConfigurationErrorCopy(new ApiRequestError({
      status: 403, code: "ACCESS_SESSION_REQUIRED", message: "Sign in",
    }));
    const policyDenial = researchModelConfigurationErrorCopy(new ApiRequestError({
      status: 403, code: "RESEARCH_PROJECT_MODEL_CONFIGURATION_READ_FORBIDDEN", message: "Denied",
    }));

    expect(sessionLoss.summary).toContain("Sign in again");
    expect(policyDenial.summary).toContain("current access policy");
    expect(policyDenial.explanation).toContain("remains active");
  });

  it("labels a catalog item as selectable only when a saved exact revision matches provider and model", () => {
    expect(researchModelConfigurationMatchesCatalog(revision, catalogEntry)).toBe(true);
    expect(researchModelConfigurationMatchesCatalog(revision, { ...catalogEntry, model_id: "another-model" })).toBe(false);
    expect(researchModelConfigurationRevisionLabel(revision)).toContain("openai/glm-5.3-flash (SYNTHESIZE");
    expect(researchModelConfigurationRevisionLabel(revision)).toContain("effective effort max");
    expect(researchModelConfigurationIsSelectable(revision)).toBe(true);
    const expired = { ...revision, qualification_state: "qualification_required" as const };
    expect(researchModelConfigurationIsSelectable(expired)).toBe(false);
    expect(researchModelConfigurationRevisionLabel(expired)).toContain("qualification required");
  });

  it("matches Workers AI catalog rows to the canonical route provider and offers only the adapter ID", () => {
    const selection = revision.model_selections[0];
    if (!selection) throw new Error("model test fixture has no selection");
    const workersRevision: ResearchModelConfigurationRevision = {
      ...revision,
      model_selections: [{
        ...selection,
        provider_id: "workers-ai",
        model_id: "@cf/example/model",
        transport_policy: { ...policy, provider: "workers-ai", model: "@cf/example/model" },
      }],
    };
    const workersEntry = { ...catalogEntry, provider_id: "cloudflare-workers-ai", model_id: "@cf/example/model" };

    expect(researchModelConfigurationMatchesCatalog(workersRevision, workersEntry)).toBe(true);
    expect(researchModelConfigurationMatchesCatalog(workersRevision, { ...workersEntry, model_id: "@cf/other/model" })).toBe(false);
    expect(researchModelCatalogProviderOptions(["workers-ai", "openai"]))
      .toEqual(["cloudflare-workers-ai", "openai"]);
  });

  it("shows BYOK alias without exposing a secret and retains max in declared effort capabilities", () => {
    expect(researchModelSelectionBillingLabel(policy)).toContain("BYOK · default alias");
    expect(researchModelSelectionBillingLabel(policy)).toContain("secret stays server-side");
    expect(researchModelSelectionEffortLabel(policy)).toContain("max");
    const selection = revision.model_selections[0];
    if (!selection) throw new Error("model test fixture has no selection");
    expect(researchModelSelectionEffectiveEffortLabel(selection)).toBe("Effective reasoning effort: max");
    expect(researchModelSelectionEffectiveEffortLabel({ ...selection, effective_reasoning_effort: null })).toContain("unspecified");
    expect(researchModelBillingLabel(catalogEntry)).toContain("account entitlement not established by catalog");
  });

  it("explains that a stale qualification or concurrent selection must be refreshed", () => {
    const qualification = researchModelConfigurationErrorCopy(new ApiRequestError({
      status: 409, code: "RESEARCH_MODEL_CONFIGURATION_QUALIFICATION_REQUIRED", message: "Requalify",
    }));
    const conflict = researchModelConfigurationErrorCopy(new ApiRequestError({
      status: 409, code: "RESEARCH_PROJECT_MODEL_CONFIGURATION_CONFLICT", message: "Conflict",
    }));

    expect(qualification.explanation).toContain("prepare and qualify");
    expect(conflict.explanation).toContain("latest saved qualified configurations");
  });
});
