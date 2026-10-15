import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";
import { readResearchOwnerSpendPolicyTemplate, type ResearchProjectModelConfigurationBundle } from "@eliotr/cloudflare-research";
import { parseResearchPreparedModelTransportPolicies } from "@eliotr/cloudflare-model-control/research-prepared-model-transport-policies.js";
import { createResearchProjectModelConfigurationValidator, fail } from "./research-project-configuration-validation.js";
import { parseResearchRunModelSelections, type ResearchRunModelSelection } from "./research-run-model-selection-codec.js";
import type { ResearchConfigurationRuntimeValues } from "./research-configuration-status.js";

export interface InstalledNativeResearchConfiguration {
  readonly vars: ResearchProjectModelConfigurationBundle["vars"];
  readonly model_selections: readonly ResearchRunModelSelection[];
}

/** Read the installed native default and existing global pins without creating project settings or qualifications. */
export async function readInstalledNativeResearchConfiguration(input: {
  readonly database: D1Database;
  readonly configuration_fields: ResearchConfigurationRuntimeValues["configuration_fields"];
  readonly semantic_json: string;
  readonly transport_policies_json: string | undefined;
  readonly native_binding_available: boolean;
  readonly deployment_generation: string;
  readonly deployment_environment: "TEST" | "PRODUCTION";
}, ownerRef: string, projectId?: string): Promise<InstalledNativeResearchConfiguration> {
  const required = (key: keyof ResearchConfigurationRuntimeValues["configuration_fields"]) => {
    const value = input.configuration_fields[key];
    if (typeof value !== "string" || value.trim() === "") {
      fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 503, "Installed native configuration is incomplete");
    }
    return value;
  };
  if (!input.native_binding_available) {
    fail("RESEARCH_MODEL_CONFIGURATION_QUALIFICATION_REQUIRED", 503, "The installed native model binding is unavailable");
  }
  const vars = {
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: input.semantic_json,
    ELIOTR_MODEL_PROFILE_DEFINITION_JSON: required("ELIOTR_MODEL_PROFILE_DEFINITION_JSON"),
    ELIOTR_MODEL_PROFILE_PROVENANCE_REF: required("ELIOTR_MODEL_PROFILE_PROVENANCE_REF"),
    ELIOTR_MODEL_SPEND_POLICY_JSON: required("ELIOTR_MODEL_SPEND_POLICY_JSON"),
    ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: required("ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF"),
    ELIOTR_RESEARCH_REPORT_CONFIG_JSON: required("ELIOTR_RESEARCH_REPORT_CONFIG_JSON"),
    ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: required("ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF"),
  };
  const installed = (() => {
    try {
      return { spend: readResearchOwnerSpendPolicyTemplate(vars.ELIOTR_MODEL_SPEND_POLICY_JSON,
        vars.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF),
      transports: parseResearchPreparedModelTransportPolicies(input.transport_policies_json) };
    } catch (cause) {
      fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 503, "Installed native model settings are invalid", cause);
    }
  })();
  const { spend, transports } = installed;
  const readSelections = async () => parseResearchRunModelSelections(await Promise.all(spend.rules.map(async (rule) => {
    const selected = transports?.model_selections.find((selection) => selection.stage === rule.stage);
    if (selected === undefined || selected.route_ref !== rule.deployment.route_ref ||
        selected.route_version !== rule.deployment.route_version || !selected.model.startsWith("@cf/") ||
        selected.transport_policy.api !== "compat-chat-completions" || selected.transport_policy.billing.mode !== "unified") {
      fail("RESEARCH_MODEL_CONFIGURATION_QUALIFICATION_REQUIRED", 409,
        "The installed default must select an exact native Cloudflare model for every spend stage");
    }
    const pin = await input.database.prepare(
      "SELECT a.candidate_ref,a.candidate_sha256,q.qualification_ref,q.qualification_sha256 " +
      "FROM dynamic_route_active_generation a JOIN dynamic_route_active_qualification q " +
      "ON q.route_ref=a.route_ref AND q.route_version=a.route_version " +
      "AND q.candidate_ref=a.candidate_ref AND q.candidate_sha256=a.candidate_sha256 " +
      "WHERE a.route_ref=?1 AND a.route_version=?2 LIMIT 1",
    ).bind(rule.deployment.route_ref, rule.deployment.route_version).first<{
      candidate_ref: string; candidate_sha256: string; qualification_ref: string; qualification_sha256: string;
    }>();
    if (pin === null) {
      fail("RESEARCH_MODEL_CONFIGURATION_QUALIFICATION_REQUIRED", 409,
        "The installed native route has no exact global qualification pin");
    }
    return { stage: rule.stage, route_ref: rule.deployment.route_ref, route_version: rule.deployment.route_version,
      ...pin, transport_policy: selected.transport_policy };
  })));
  const selections = await readSelections();
  const semanticSha = await sha256Utf8(input.semantic_json);
  const validated = await createResearchProjectModelConfigurationValidator({ database: input.database,
    deployment_generation: input.deployment_generation, deployment_environment: input.deployment_environment })({
    protocol: "eliotr.research-project-model-configuration.v1",
    semantic_revision: { revision_ref: `scr-${semanticSha.slice(0, 12)}`, config_sha256: semanticSha },
    model_selections: selections, vars,
  }, ownerRef, projectId);
  if (canonicalJson(selections) !== canonicalJson(await readSelections())) {
    fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_AUTHORITY_CHANGED", 409, "Installed native model pins changed during capture");
  }
  return Object.freeze({ vars: validated.bundle.vars, model_selections: selections });
}
