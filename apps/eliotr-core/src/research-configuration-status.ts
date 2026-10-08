import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { ResearchModelGatewayBinding } from "@eliotr/cloudflare-research";
import {
  readResearchConfigurationStatus as readConfigurationStatus,
  type ResearchConfigurationRuntimeValues,
} from "@eliotr/cloudflare-research-configuration/research-configuration-status.js";
import type { ResearchConfigurationStatus } from "@eliotr/cloudflare-research-configuration/research-configuration-status.js";
import type { Env } from "./env.js";
import { readResearchSemanticConfiguration } from "./env.js";
import { readResearchSemanticConfigSource } from "./research-semantic-config-revision.js";

export type { ResearchConfigurationStatus };

export function researchConfigurationRuntimeValuesFromEnv(env: Env): ResearchConfigurationRuntimeValues {
  let semanticSource: ResearchConfigurationRuntimeValues["semantic_source"];
  try { semanticSource = readResearchSemanticConfigSource(env); }
  catch { semanticSource = null; }
  const semanticConfigurationJson = readResearchSemanticConfiguration(env);
  const deploymentGeneration = env.DEPLOYMENT_GENERATION;
  return {
    configuration_fields: {
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF: env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF,
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256: env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256,
      ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON,
      ELIOTR_MODEL_PROFILE_DEFINITION_JSON: env.ELIOTR_MODEL_PROFILE_DEFINITION_JSON,
      ELIOTR_MODEL_PROFILE_PROVENANCE_REF: env.ELIOTR_MODEL_PROFILE_PROVENANCE_REF,
      ELIOTR_MODEL_SPEND_POLICY_JSON: env.ELIOTR_MODEL_SPEND_POLICY_JSON,
      ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: env.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF,
      ELIOTR_RESEARCH_REPORT_CONFIG_JSON: env.ELIOTR_RESEARCH_REPORT_CONFIG_JSON,
      ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: env.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF,
      ELIOTR_MODEL_GATEWAY_TOKEN: env.ELIOTR_MODEL_GATEWAY_TOKEN,
    },
    semantic_source: semanticSource,
    ...(semanticConfigurationJson === undefined ? {} : { semantic_configuration_json: semanticConfigurationJson }),
    semantic_json_chunks_present: env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0 !== undefined ||
      env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_1 !== undefined,
    ...(deploymentGeneration === undefined ? {} : { deployment_generation: deploymentGeneration }),
    native_model_gateway_available: typeof (env.AI as Partial<ResearchModelGatewayBinding> | undefined)?.gateway === "function" &&
      typeof env.AI_GATEWAY_REASONING_URL === "string" && env.AI_GATEWAY_REASONING_URL.trim() !== "",
  };
}

/** Compatibility adapter: installed Worker bindings are reduced to status inputs. */
export function readResearchConfigurationStatus(
  env: Env,
  owner?: Pick<AuthenticatedRequestContext, "principal_ref" | "credential_generation" | "client_class">,
): ResearchConfigurationStatus {
  return readConfigurationStatus(researchConfigurationRuntimeValuesFromEnv(env), owner);
}
