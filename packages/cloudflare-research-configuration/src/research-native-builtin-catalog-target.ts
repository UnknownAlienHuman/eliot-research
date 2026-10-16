import { canonicalModelGatewayJson, validateModelGatewayTransportPolicy } from "@eliotr/cloudflare-ai";
import { createModelProfileDefinition, createOwnerModelProfileTemplateV2, readOwnerModelProfileTemplateV2,
  readResearchOwnerSpendPolicyTemplate, decodeResearchProjectModelConfigurationBundle,
  type ResearchProjectModelConfigurationBundle, type ResearchProjectModelSelection } from "@eliotr/cloudflare-research";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";

export interface NativeBuiltinCatalogQualifiedStage {
  readonly stage: ResearchProjectModelSelection["stage"];
  readonly deployment: ModelRouteDeployment;
  readonly selection: ResearchProjectModelSelection;
}

/** Rebind deployments, not owner intent: byte/token/spend/expiry limits stay in their original templates. */
export async function buildNativeBuiltinCatalogTarget(
  source: ResearchProjectModelConfigurationBundle,
  modelId: string,
  stages: readonly NativeBuiltinCatalogQualifiedStage[],
): Promise<ResearchProjectModelConfigurationBundle> {
  const spend = readResearchOwnerSpendPolicyTemplate(source.vars.ELIOTR_MODEL_SPEND_POLICY_JSON,
    source.vars.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF);
  const byStage = new Map(stages.map(stage => [stage.stage, stage]));
  if (byStage.size !== stages.length || byStage.size !== spend.rules.length ||
      spend.rules.some(rule => !byStage.has(rule.stage))) throw new Error("Native catalog selection must qualify every exact spend stage");
  for (const stage of stages) {
    const policy = validateModelGatewayTransportPolicy(stage.selection.transport_policy);
    if (policy.provider !== "workers-ai" || policy.model !== modelId || policy.api !== "compat-chat-completions" ||
        policy.billing.mode !== "unified" || stage.selection.candidate_kind === "provider-native-v1" ||
        stage.selection.candidate_kind === "provider-native-v2" || stage.selection.stage !== stage.stage ||
        stage.selection.route_ref !== stage.deployment.route_ref || stage.selection.route_version !== stage.deployment.route_version) {
      throw new Error("Native catalog stage differs from its exact unified model/deployment");
    }
  }
  const synthesis = byStage.get("SYNTHESIZE");
  if (synthesis === undefined || !byStage.has("AUDIT_CLAIMS")) throw new Error("Native catalog requires synthesis and audit qualification");
  const raw = JSON.parse(source.vars.ELIOTR_MODEL_PROFILE_DEFINITION_JSON) as Record<string, unknown>;
  const provenance = source.vars.ELIOTR_MODEL_PROFILE_PROVENANCE_REF;
  let profile: unknown;
  if (raw.schema === "eliotr.research.model-profile-definition.v2") {
    const original = await readOwnerModelProfileTemplateV2(raw, provenance);
    profile = await createOwnerModelProfileTemplateV2({ config_provenance_ref: original.config_provenance_ref,
      model_profile_ref: original.model_profile_ref, ...(original.expires_at === undefined ? {} : { expires_at: original.expires_at }),
      max_context_bytes: original.max_context_bytes, policy: original.policy, deployment: synthesis.deployment });
  } else if (raw.schema === "eliotr.research.model-profile-definition.v1") {
    // The normal import validator still verifies the source/profile and rebuilt bundle in full.
    profile = await createModelProfileDefinition({ config_provenance_ref: provenance,
      model_profile_ref: raw.model_profile_ref as string, expires_at: raw.expires_at as string,
      max_context_bytes: raw.max_context_bytes as number, deployment: synthesis.deployment,
      policy: raw.policy as Parameters<typeof createModelProfileDefinition>[0]["policy"] });
  } else throw new Error("Native catalog source model profile is unsupported");
  const target: ResearchProjectModelConfigurationBundle = {
    protocol: "eliotr.research-project-model-configuration.v1", semantic_revision: source.semantic_revision,
    model_selections: stages.map(stage => stage.selection).sort((a, b) => a.stage.localeCompare(b.stage)),
    vars: { ...source.vars, ELIOTR_MODEL_PROFILE_DEFINITION_JSON: canonicalModelGatewayJson(profile),
      ELIOTR_MODEL_SPEND_POLICY_JSON: canonicalModelGatewayJson({ ...spend, rules: spend.rules.map(rule => ({
        ...rule, deployment: byStage.get(rule.stage)?.deployment,
      })) }) },
  };
  await decodeResearchProjectModelConfigurationBundle(target);
  return Object.freeze(target);
}
