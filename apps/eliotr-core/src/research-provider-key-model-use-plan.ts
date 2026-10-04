import type { ConfiguredResearchProviderKeyOperation } from "@eliotr/cloudflare-model-control";
import type { Env } from "./env.js";
import type { SelectedResearchProjectConfiguration } from "./research-project-configuration.js";
import { resolveResearchSemanticConfig } from "./research-semantic-config-revision.js";
import {
  buildResearchProviderKeyModelUseTarget,
  createResearchProviderKeyModelUseBasis as createPackageResearchProviderKeyModelUseBasis,
  deploymentForStage,
  parseResearchProviderKeyModelUseBasis,
  probeDeploymentForStage,
  RESEARCH_PROVIDER_KEY_MODEL_USE_BASIS_PROTOCOL,
  ResearchProviderKeyModelUsePlanError,
  type ResearchProviderKeyModelUseBasisV1,
  type ResearchProviderKeyModelUseRuntimePolicyV1,
  type ResearchProviderKeyModelUseSemanticSourceV1,
  type ResearchProviderKeyModelUseStagePlanV1,
} from "@eliotr/cloudflare-research-configuration/research-provider-key-model-use-plan.js";

export {
  buildResearchProviderKeyModelUseTarget,
  deploymentForStage,
  parseResearchProviderKeyModelUseBasis,
  probeDeploymentForStage,
  RESEARCH_PROVIDER_KEY_MODEL_USE_BASIS_PROTOCOL,
  ResearchProviderKeyModelUsePlanError,
};
export type {
  ResearchProviderKeyModelUseBasisV1,
  ResearchProviderKeyModelUseRuntimePolicyV1,
  ResearchProviderKeyModelUseSemanticSourceV1,
  ResearchProviderKeyModelUseStagePlanV1,
};

export function createResearchProviderKeyModelUsePlanInputsFromEnv(env: Env): Readonly<{
  runtime_policy: ResearchProviderKeyModelUseRuntimePolicyV1;
  semantic_source: ResearchProviderKeyModelUseSemanticSourceV1;
}> {
  const runtime_policy: ResearchProviderKeyModelUseRuntimePolicyV1 = Object.freeze({
    ...(env.ELIOTR_MODEL_PROFILE_DEFINITION_JSON === undefined ? {} : {
      ELIOTR_MODEL_PROFILE_DEFINITION_JSON: env.ELIOTR_MODEL_PROFILE_DEFINITION_JSON,
    }),
    ...(env.ELIOTR_MODEL_PROFILE_PROVENANCE_REF === undefined ? {} : {
      ELIOTR_MODEL_PROFILE_PROVENANCE_REF: env.ELIOTR_MODEL_PROFILE_PROVENANCE_REF,
    }),
    ...(env.ELIOTR_MODEL_SPEND_POLICY_JSON === undefined ? {} : {
      ELIOTR_MODEL_SPEND_POLICY_JSON: env.ELIOTR_MODEL_SPEND_POLICY_JSON,
    }),
    ...(env.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF === undefined ? {} : {
      ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: env.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF,
    }),
    ...(env.ELIOTR_RESEARCH_REPORT_CONFIG_JSON === undefined ? {} : {
      ELIOTR_RESEARCH_REPORT_CONFIG_JSON: env.ELIOTR_RESEARCH_REPORT_CONFIG_JSON,
    }),
    ...(env.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF === undefined ? {} : {
      ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: env.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF,
    }),
    ...(env.ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON === undefined ? {} : {
      ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON: env.ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON,
    }),
  });
  return Object.freeze({
    runtime_policy,
    semantic_source: Object.freeze({
      resolve: (database: D1Database) => resolveResearchSemanticConfig({ env, database }),
    }),
  });
}

export function createResearchProviderKeyModelUseBasis(input: {
  readonly env: Env;
  readonly selected: SelectedResearchProjectConfiguration | null;
  readonly key: ConfiguredResearchProviderKeyOperation;
  readonly operation_id: string;
  readonly database: D1Database;
}): Promise<ResearchProviderKeyModelUseBasisV1> {
  const planInputs = createResearchProviderKeyModelUsePlanInputsFromEnv(input.env);
  return createPackageResearchProviderKeyModelUseBasis({
    ...planInputs,
    selected: input.selected,
    key: input.key,
    operation_id: input.operation_id,
    database: input.database,
  });
}
