import { canonicalModelGatewayJson, modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import { createResearchSemanticConfigRevisionStore } from "@eliotr/cloudflare-research";
import {
  createResearchOwnerRuntimeConfiguration,
  type ResearchOwnerModelProfileTemplateV2Input,
  type ResearchOwnerSpendPolicyTemplateV2Input,
} from "@eliotr/cloudflare-research-configuration/research-owner-runtime-config.js";
import {
  RESEARCH_OWNER_REPORT_ADMISSION_TEMPLATE_PROTOCOL,
  RESEARCH_OWNER_REPORT_ADMISSION_TEMPLATE_V2_PROTOCOL,
} from "@eliotr/cloudflare-research-configuration/research-owner-report-policy.js";
import { createResearchOwnerSemanticConfiguration } from "@eliotr/cloudflare-research-configuration/research-owner-semantic-config.js";
import { selectResearchOwnerPrompt } from "@eliotr/cloudflare-research-stages";
import type { ModelGatewayTransportPolicyV1 } from "@eliotr/cloudflare-ai";
import {
  RESEARCH_PREPARED_MODEL_TRANSPORT_PROTOCOL,
  type ResearchPreparedModelTransportPoliciesV1,
} from "../src/research-prepared-model-transport.js";
import type { Env } from "../src/env.js";
import { bindAdmissionPromptDeploymentIdentities, admissionTestConfiguration } from "./research-current-dispatch-config.js";
import type { AdmissionPromptBindingDependencies } from "./research-current-dispatch-config.js";

export const MODEL_ID = "stealth/space-bunny-alpha" as const;
export const GATEWAY_ACCOUNT_ID = "a".repeat(32);
export const MODEL_POLICY = Object.freeze({
  version: 1 as const,
  transport: "cloudflare-ai-gateway" as const,
  api: "openrouter-chat-completions" as const,
  provider: "openrouter" as const,
  model: MODEL_ID,
  billing: Object.freeze({ mode: "byok" as const, alias: `eliotr-${"0".repeat(48)}`, free_only: true as const }),
  capabilities: Object.freeze({
    max_output_tokens_field: "max_tokens" as const,
    reasoning_efforts: Object.freeze(["low", "medium", "high", "max"] as const),
    response_format_normalization: "json-schema-to-json-object" as const,
  }),
}) satisfies ModelGatewayTransportPolicyV1;

const PROMPT_BINDING_DEPENDENCIES = {
  canonicalModelGatewayJson,
  modelGatewaySha256,
  selectResearchOwnerPrompt,
  createResearchOwnerSemanticConfiguration,
} satisfies AdmissionPromptBindingDependencies;

/** Compile the complete permanent owner baseline and fixed native policy used by check/use. */
export async function createNativeUseEnvironment(owner: string, database: D1Database, base: Env): Promise<Env> {
  const legacy = admissionTestConfiguration(
    base.DEPLOYMENT_GENERATION, owner, `native-use-${crypto.randomUUID()}`,
  );
  const profile = legacy.model_profile;
  if (!("expires_at" in profile.policy)) throw new Error("The local owner profile fixture is not a V1 template");
  const { expires_at: _profilePolicyExpiry, ...permanentProfilePolicy } = profile.policy;
  const modelProfile: ResearchOwnerModelProfileTemplateV2Input = {
    config_provenance_ref: profile.config_provenance_ref,
    model_profile_ref: profile.model_profile_ref,
    max_context_bytes: profile.max_context_bytes,
    deployment: profile.deployment,
    policy: permanentProfilePolicy,
  };
  const spend = legacy.spend_policy;
  if (spend.protocol !== "eliotr.research-owner-spend-template.v1") {
    throw new Error("The local owner spend fixture is not a V1 template");
  }
  const { deployment_generation: _spendGeneration, expires_at: _spendExpiry, ...spendFields } = spend;
  const spendPolicy: ResearchOwnerSpendPolicyTemplateV2Input = {
    ...spendFields,
    protocol: "eliotr.research-owner-spend-template.v2",
  };
  const admission = legacy.report.admission_policy;
  if (!("protocol" in admission) || admission.protocol !== RESEARCH_OWNER_REPORT_ADMISSION_TEMPLATE_PROTOCOL) {
    throw new Error("The local owner report fixture is not a V1 template");
  }
  const { deployment_generation: _reportGeneration, expires_at: _reportExpiry, ...reportFields } = admission;
  const preparedPolicies: ResearchPreparedModelTransportPoliciesV1 = Object.freeze({
    protocol: RESEARCH_PREPARED_MODEL_TRANSPORT_PROTOCOL,
    model_selections: Object.freeze(spend.rules.map((rule) => Object.freeze({
      stage: rule.stage,
      route_ref: rule.deployment.route_ref,
      route_version: rule.deployment.route_version,
      provider: "openrouter",
      model: MODEL_ID,
      transport_policy: MODEL_POLICY,
    }))),
  });
  const installation = await bindAdmissionPromptDeploymentIdentities({
    ...legacy,
    model_profile: modelProfile,
    spend_policy: spendPolicy,
    report: {
      ...legacy.report,
      admission_policy: {
        ...reportFields,
        protocol: RESEARCH_OWNER_REPORT_ADMISSION_TEMPLATE_V2_PROTOCOL,
      },
    },
    transport_policies: preparedPolicies,
  }, PROMPT_BINDING_DEPENDENCIES);
  const compiled = await createResearchOwnerRuntimeConfiguration(installation);
  const semanticConfigJson = compiled.vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON;
  if (typeof semanticConfigJson !== "string") throw new Error("The local owner runtime fixture has no semantic configuration");
  const semanticRevision = await createResearchSemanticConfigRevisionStore(database).putImmutable({
    config_json: semanticConfigJson,
    created_by_principal_ref: owner,
  });
  const { ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: _semanticJson, ...installedVars } = compiled.vars;
  void _semanticJson;
  return {
    ...base,
    ...installedVars,
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF: semanticRevision.revision_ref,
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256: semanticRevision.config_sha256,
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0: undefined,
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_1: undefined,
    ELIOTR_MODEL_GATEWAY_TOKEN: "local-test-gateway-token",
  } as unknown as Env;
}

export function freeOnlyCatalogResponse(): Response {
  return new Response(JSON.stringify({
    data: {
      id: MODEL_ID,
      name: "Stealth Space Bunny Alpha",
      created: 1_759_000_000,
      description: "Local test metadata for the exact stealth endpoint",
      architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"], tokenizer: "test" },
      endpoints: [{
        name: "Stealth",
        model_id: MODEL_ID,
        model_name: MODEL_ID,
        context_length: 32_768,
        pricing: { prompt: "0", completion: "0", discount: 0 },
        provider_name: "Stealth",
        tag: "stealth",
        quantization: "fp8",
        max_completion_tokens: 1_024,
        max_prompt_tokens: 32_768,
        supported_parameters: ["max_tokens", "reasoning_effort", "response_format"],
        supports_tool_choice: false,
        status: 1,
        uptime_last_30m: 100,
        uptime_last_5m: 100,
        uptime_last_1d: 100,
        supports_implicit_caching: false,
        native_tools: false,
        supports_voice_cloning: false,
        supports_multiple_audio_references: false,
        supports_image_reference: false,
        latency_last_30m: 1,
        throughput_last_30m: 1,
      }],
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}
