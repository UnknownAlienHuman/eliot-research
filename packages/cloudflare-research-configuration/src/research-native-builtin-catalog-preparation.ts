import { canonicalModelGatewayJson, modelGatewayRequestParametersSha256, modelGatewaySha256,
  validateModelGatewayTransportPolicy, type DynamicRouteProvisioningInput, type DynamicRouteProvisioningReceipt,
  type ModelGatewayTransportPolicyV1, type ModelCallInput } from "@eliotr/cloudflare-ai";
import { decodeModelRouteDeployment } from "@eliotr/platform-cloudflare";
import { readResearchOwnerSpendPolicyTemplate, type ResearchProjectModelConfigurationBundle } from "@eliotr/cloudflare-research";
import type { ResearchModelPricingSnapshot, ResearchQualificationPromptConfig } from "@eliotr/cloudflare-model-control";
import type { ResearchCatalogModelUseAuthorizationRow } from "./research-catalog-model-use-store.js";
import { parseResearchSemanticConfiguration } from "./research-semantic-configuration-schema.js";
import { nativeBuiltinCatalogProbeKey, type NativeBuiltinCatalogPreparation,
  type NativeBuiltinCatalogPreparedStage } from "./research-native-builtin-catalog-driver.js";
import type { createResearchNativeBuiltinCatalogPricing } from "./research-native-builtin-catalog-pricing.js";

type Stage = NativeBuiltinCatalogPreparedStage["stage"];

export function nativeBuiltinCatalogRouteVersion(operationId: string, stage: Stage): string {
  return `native-catalog-${operationId.replaceAll("-", "")}-${stage.toLowerCase()}`;
}

export interface NativeBuiltinCatalogStageSeed {
  readonly stage: Stage;
  /** Trusted normal DynamicRoute plan input, not provider inventory presented as a receipt. */
  readonly route_definition: unknown;
  readonly transport_policy: ModelGatewayTransportPolicyV1;
  /** Existing approved exact-model token-price observation; the driver re-reads it from D1. */
  readonly pricing_snapshot: ResearchModelPricingSnapshot;
  /** Existing authorized qualification context; evidence/scope and byte ceilings are retained. */
  readonly model_call: ModelCallInput;
  readonly prompt: ResearchQualificationPromptConfig;
  readonly expires_at: string;
}

/** Build the alternate model's real native preparations, without copying an old candidate/qualification. */
export async function prepareResearchNativeBuiltinCatalog(input: {
  readonly operation: ResearchCatalogModelUseAuthorizationRow;
  readonly source_configuration: ResearchProjectModelConfigurationBundle;
  readonly seeds: readonly NativeBuiltinCatalogStageSeed[];
  /** Existing operator DynamicRoute preparation capability. No credentials or account resources are created here. */
  readonly prepare_route: (input: DynamicRouteProvisioningInput) => Promise<DynamicRouteProvisioningReceipt>;
}): Promise<NativeBuiltinCatalogPreparation> {
  const source = JSON.parse(canonicalModelGatewayJson(input.source_configuration)) as ResearchProjectModelConfigurationBundle;
  const seeds = JSON.parse(canonicalModelGatewayJson(input.seeds)) as NativeBuiltinCatalogStageSeed[];
  const operation = { ...input.operation };
  const spend = readResearchOwnerSpendPolicyTemplate(source.vars.ELIOTR_MODEL_SPEND_POLICY_JSON,
    source.vars.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF);
  const semantic = parseResearchSemanticConfiguration(source.vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON);
  if (operation.provider_id !== "cloudflare-workers-ai" || operation.provider_operation_id !== null ||
      !operation.model_id.startsWith("@cf/") || seeds.length !== spend.rules.length ||
      new Set(seeds.map(seed => seed.stage)).size !== spend.rules.length) throw new Error("Exact native owner/model stage preparation is required");
  const plans = [];
  // Bind every stage before invoking even the existing route preparation capability.
  for (const rule of spend.rules) {
    const seed = seeds.find(seed => seed.stage === rule.stage);
    if (seed === undefined) throw new Error("Missing native stage seed");
    const policy = validateModelGatewayTransportPolicy(seed.transport_policy);
    const price = seed.pricing_snapshot;
    const routeVersion = nativeBuiltinCatalogRouteVersion(operation.operation_id, seed.stage);
    if (policy.provider !== "workers-ai" || policy.model !== operation.model_id || policy.api !== "compat-chat-completions" ||
        policy.billing.mode !== "unified" || price.provider !== "workers-ai" || price.exact_model_id !== operation.model_id ||
        price.route_ref !== rule.deployment.route_ref || price.route_version !== routeVersion ||
        price.pricing_basis !== "EXACT_TOKEN_RATES_V1" || !price.approval_receipt_ref ||
        seed.model_call.max_input_bytes > rule.max_input_bytes || seed.model_call.max_output_bytes > rule.max_output_bytes) {
      throw new Error("Native stage price, model or owner byte limits do not match");
    }
    const parameters = seed.stage === "SYNTHESIZE" ? semantic.synthesis.trusted_parameters
      : seed.stage === "AUDIT_CLAIMS" ? semantic.audit.trusted_parameters : semantic.roles?.trusted_parameters;
    if (parameters === undefined) throw new Error("Native stage parameters are missing");
    if ((seed.stage === "SYNTHESIZE" || seed.stage === "AUDIT_CLAIMS") &&
        canonicalModelGatewayJson(seed.prompt.trusted_parameters) !== canonicalModelGatewayJson(parameters)) {
      throw new Error("Native probe must preserve the exact owner parameter ceilings");
    }
    const parametersDigest = await modelGatewayRequestParametersSha256({ model: rule.deployment.route_ref, messages: [],
      [policy.capabilities.max_output_tokens_field]: parameters.max_tokens,
      ...(parameters.reasoning_effort === undefined ? {} : { reasoning_effort: parameters.reasoning_effort }),
      ...(parameters.response_format === undefined ? {} : { response_format: parameters.response_format }), stream: false,
    }, policy.capabilities, policy.api);
    const deployment = decodeModelRouteDeployment({ ...rule.deployment, route_version: routeVersion,
      parameters_digest: parametersDigest, pricing_snapshot_ref: price.pricing_snapshot_ref });
    const definitionSha = await modelGatewaySha256(canonicalModelGatewayJson(seed.route_definition));
    const expiresAtMs = Math.min(Date.parse(seed.expires_at), Date.parse(price.expires_at));
    const verifiedAtMs = Math.max(Date.parse(operation.created_at), Date.parse(price.effective_at));
    if (!Number.isSafeInteger(expiresAtMs) || !Number.isSafeInteger(verifiedAtMs) || expiresAtMs <= verifiedAtMs) {
      throw new Error("Native price/preparation interval is invalid");
    }
    const outputSha = await modelGatewaySha256(canonicalModelGatewayJson({ operation: operation.operation_id,
      stage: seed.stage, model: operation.model_id, source_output: seed.model_call.output_object_ref }));
    plans.push({ seed, policy, deployment, definitionSha, expires_at: new Date(expiresAtMs).toISOString(),
      verified_at: new Date(verifiedAtMs).toISOString(),
      output_object_ref: `model-qualification-output-${outputSha}` });
  }
  const stages: NativeBuiltinCatalogPreparedStage[] = [];
  for (const plan of plans) {
    const provisioning = await input.prepare_route({ deployment: plan.deployment, route_definition: plan.seed.route_definition,
      route_definition_sha256: plan.definitionSha });
    if (canonicalModelGatewayJson(provisioning.deployment) !== canonicalModelGatewayJson(plan.deployment) ||
        provisioning.route_definition_sha256 !== plan.definitionSha) throw new Error("Native route preparation readback differs");
    stages.push({ stage: plan.seed.stage, transport_policy: plan.policy, prompt: plan.seed.prompt,
      probe: { provisioning, route_definition: plan.seed.route_definition, route_definition_sha256: plan.definitionSha,
        expected_provider: "workers-ai", expected_model: operation.model_id,
        model_call: { ...plan.seed.model_call, route_ref: plan.deployment.route_ref,
          prompt_generation: plan.deployment.prompt_generation, schema_generation: plan.deployment.schema_generation,
          output_object_ref: plan.output_object_ref },
        probe_idempotency_key: nativeBuiltinCatalogProbeKey(operation.operation_id, plan.seed.stage),
        verified_at: plan.verified_at, expires_at: plan.expires_at } });
  }
  return { source_configuration: source, stages };
}

/** Core adapter: reuse authorized native qualification contexts and owner templates,
 * observe the chosen model's real catalog prices, then use the existing route preparer.
 */
export function createResearchNativeBuiltinCatalogPreparation(input: {
  readonly pricing: ReturnType<typeof createResearchNativeBuiltinCatalogPricing>;
  readonly assert_current: (operation: ResearchCatalogModelUseAuthorizationRow) => Promise<void>;
  readonly read_source: (operation: ResearchCatalogModelUseAuthorizationRow) => Promise<{
    readonly source_configuration: ResearchProjectModelConfigurationBundle;
    readonly seeds: readonly Omit<NativeBuiltinCatalogStageSeed, "pricing_snapshot">[];
    readonly expires_at: string;
  }>;
  readonly prepare_route: (input: DynamicRouteProvisioningInput) => Promise<DynamicRouteProvisioningReceipt>;
}) {
  return async (operation: ResearchCatalogModelUseAuthorizationRow): Promise<NativeBuiltinCatalogPreparation> => {
    await input.assert_current(operation);
    const raw = await input.read_source(operation);
    const source = JSON.parse(canonicalModelGatewayJson(raw)) as typeof raw;
    const spend = readResearchOwnerSpendPolicyTemplate(source.source_configuration.vars.ELIOTR_MODEL_SPEND_POLICY_JSON,
      source.source_configuration.vars.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF);
    const routes = spend.rules.map(rule => ({ route_ref: rule.deployment.route_ref,
      route_version: nativeBuiltinCatalogRouteVersion(operation.operation_id, rule.stage) }));
    const prices = await input.pricing.ensure(operation, routes, source.expires_at);
    const seeds = source.seeds.map(seed => {
      const rule = spend.rules.find(rule => rule.stage === seed.stage);
      const price = prices.find(price => price.route_ref === rule?.deployment.route_ref &&
        price.route_version === nativeBuiltinCatalogRouteVersion(operation.operation_id, seed.stage));
      if (price === undefined) throw new Error("Native exact-model price was not durably acknowledged");
      return { ...seed, pricing_snapshot: price };
    });
    return prepareResearchNativeBuiltinCatalog({ operation, source_configuration: source.source_configuration,
      seeds, prepare_route: async desired => {
        await input.assert_current(operation);
        const prepared = await input.prepare_route(desired);
        await input.assert_current(operation);
        return prepared;
      } });
  };
}
