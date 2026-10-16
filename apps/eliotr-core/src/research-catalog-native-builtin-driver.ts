import { modelGatewaySha256, validateModelGatewayTransportPolicy, createCloudflareDynamicRouteRestControlPlane, provisionDynamicRouteGeneration,
  type DynamicRouteControlPlanePort, type ModelGatewayTransportPolicyV1 } from "@eliotr/cloudflare-ai";
import { createResearchModelCatalogService, createResearchQualificationPromptCompiler,
  parseResearchQualificationPromptConfig } from "@eliotr/cloudflare-model-control";
import { createD1DynamicRouteRestBindingStore,
  readResearchOwnerSpendPolicyTemplate, type ResearchProjectModelConfigurationBundle } from "@eliotr/cloudflare-research";
import { createResearchNativeBuiltinCatalogDriver, createResearchNativeBuiltinCatalogPreparation,
  createResearchNativeBuiltinCatalogPricing, nativeBuiltinCatalogRequestCapabilities,
  type NativeBuiltinCatalogStageSeed } from "@eliotr/cloudflare-research-configuration";
import { createD1ResearchCatalogModelUseStore, type ResearchCatalogModelUseAuthorizationRow } from
  "@eliotr/cloudflare-research-configuration/research-catalog-model-use-store.js";
import { parseResearchSemanticConfiguration } from
  "@eliotr/cloudflare-research-configuration/research-semantic-configuration-schema.js";
import type { ResearchProjectModelConfigurationService } from "./research-project-configuration.js";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { composeResearchModelGatewayConfiguration } from "./research-prepared-model-transport.js";
import { installedGatewayIdentity } from "./research-provider-key-configuration-composition.js";
import { readInstalledNativeResearchRunConfiguration } from "./research-run-configuration.js";
import { readNativeBuiltinQualificationContext, readNativeBuiltinRouteDefinition } from "./research-catalog-native-builtin-context.js";
import type { Env } from "./env.js";

type Operation = ResearchCatalogModelUseAuthorizationRow;

/** Default Core native adapter: existing account/bindings/credentials only; no BYOK configuration. */
export function createResearchCatalogNativeBuiltinDriver(input: {
  readonly env: Env;
  readonly context: AuthenticatedRequestContext;
  readonly project_id: string;
  readonly project_configuration: ResearchProjectModelConfigurationService;
}) {
  const { env, context, project_id: projectId, project_configuration: configuration } = input;
  const store = createD1ResearchCatalogModelUseStore(env.CORE_DB);
  let controlPlane: ReturnType<typeof createCloudflareDynamicRouteRestControlPlane> | undefined;
  function control() {
    if (controlPlane !== undefined) return controlPlane;
    const identity = installedGatewayIdentity(env.AI_GATEWAY_REASONING_URL);
    const token = env.ELIOTR_MODEL_PROVIDER_CONTROL_TOKEN;
    if (identity?.gateway_id !== "eliotr-reasoning" || typeof token !== "string" || token.length === 0) {
      throw new Error("Existing native route preparation authority is unavailable");
    }
    controlPlane = createCloudflareDynamicRouteRestControlPlane({ account_id: identity.account_id,
      bindings: createD1DynamicRouteRestBindingStore(env.CORE_DB), credentials: { readApiToken: async () => token },
      fetch: { fetch: (url, init) => globalThis.fetch(url, init) } });
    return controlPlane;
  }
  const current = async (operation: Operation): Promise<Operation | null> => {
    if (context.request.signal.aborted || context.client_class !== "owner_pwa" ||
        context.credential_generation !== operation.owner_credential_generation ||
        context.access?.credential_generation !== undefined && context.access.credential_generation !== context.credential_generation ||
        operation.owner_id !== context.principal_ref || operation.project_id !== projectId ||
        operation.deployment_generation !== env.DEPLOYMENT_GENERATION) return null;
    const project = await env.CORE_DB.prepare("SELECT p.generation FROM project p JOIN project_owner o ON o.project_id=p.project_id " +
      "WHERE p.project_id=?1 AND o.principal_ref=?2 LIMIT 1")
      .bind(projectId, context.principal_ref).first<{ generation: number }>();
    if (project?.generation !== operation.project_generation) return null;
    const found = await store.read(context.principal_ref, projectId, operation.operation_id);
    if (found === null) return null;
    const selected = await configuration.readSelected(context, projectId);
    const original = (selected?.configuration_ref ?? null) === operation.source_configuration_ref &&
      (selected?.configuration_sha256 ?? null) === operation.source_configuration_sha256 &&
      (selected?.selection_revision ?? null) === operation.expected_selection_revision;
    const ownImport = (found.state === "IMPORTING" || found.state === "SELECTED") && selected !== null &&
      selected.configuration.model_selections.every(selection => selection.transport_policy.provider === "workers-ai" &&
        selection.transport_policy.model === operation.model_id &&
        selection.route_version === `native-catalog-${operation.operation_id.replaceAll("-", "")}-${selection.stage.toLowerCase()}`);
    return original || ownImport ? found : null;
  };
  const assertCurrent = async (operation: Operation) => { if (await current(operation) === null) throw new Error("Native owner/project selection changed"); };
  const advertised = async (modelId: string) => {
    const nativeAi = typeof env.AI?.models === "function" ? env.AI as Pick<Ai, "models"> : undefined;
    // The native API may expose its catalog-record UUID as id and the callable @cf reference as name.
    const workersAi: Pick<Ai, "models"> | undefined = nativeAi === undefined ? undefined : {
      models: async (...args) => (await nativeAi.models(...args)).map(model =>
        model.name.startsWith("@cf/") && !model.id.startsWith("@cf/") ? { ...model, id: model.name } : model),
    };
    const page = await createResearchModelCatalogService({ database: env.CORE_DB,
      ...(workersAi === undefined ? {} : { workersAi }) }).listWorkersAi(context, projectId, { search: modelId });
    return page.models.find(model => model.model_id === modelId) ?? null;
  };
  const pricing = createResearchNativeBuiltinCatalogPricing({ database: env.CORE_DB,
    read_current_authority: current, read_advertised_model: advertised });
  const prepare = createResearchNativeBuiltinCatalogPreparation({ pricing, assert_current: assertCurrent,
    prepare_route: desired => provisionDynamicRouteGeneration(control(), desired),
    read_source: async operation => {
      const selected = await configuration.readSelected(context, projectId);
      const installed = await readInstalledNativeResearchRunConfiguration(env, context.principal_ref);
      const semanticSha = await modelGatewaySha256(installed.vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON);
      const source: ResearchProjectModelConfigurationBundle = selected?.configuration ?? {
        protocol: "eliotr.research-project-model-configuration.v1", vars: installed.vars,
        semantic_revision: { revision_ref: `scr-${semanticSha.slice(0, 12)}`, config_sha256: semanticSha },
        model_selections: installed.model_selections.map(selection => ({ ...selection,
          transport_policy: validateModelGatewayTransportPolicy(selection.transport_policy) })),
      };
      const held = await readNativeBuiltinQualificationContext(env, context, projectId, operation.operation_id);
      const spend = readResearchOwnerSpendPolicyTemplate(source.vars.ELIOTR_MODEL_SPEND_POLICY_JSON, source.vars.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF);
      const semantic = parseResearchSemanticConfiguration(source.vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON);
      const profile = JSON.parse(source.vars.ELIOTR_MODEL_PROFILE_DEFINITION_JSON) as { expires_at?: string; policy: Record<string, unknown> };
      const expiry = [held.expires_at, profile.expires_at, typeof profile.policy.expires_at === "string" ? profile.policy.expires_at : undefined,
        "expires_at" in spend ? spend.expires_at : undefined, context.access?.expires_at]
        .filter((value): value is string => typeof value === "string").map(Date.parse);
      const expiresAt = new Date(Math.min(...expiry)).toISOString();
      const model = await advertised(operation.model_id);
      if (model === null) throw new Error("Exact advertised native model is unavailable");
      const capabilities = nativeBuiltinCatalogRequestCapabilities(model);
      const policy: ModelGatewayTransportPolicyV1 = { version: 1, transport: "cloudflare-ai-gateway", provider: "workers-ai",
        api: "compat-chat-completions", model: operation.model_id, billing: { mode: "unified" }, capabilities };
      const seeds: Omit<NativeBuiltinCatalogStageSeed, "pricing_snapshot">[] = [];
      for (const rule of spend.rules) {
        const native = installed.model_selections.find(selection => selection.stage === rule.stage && selection.transport_policy.provider === "workers-ai");
        if (native === undefined) throw new Error("Installed native route preparation is unavailable for this owner stage");
        const definition = await readNativeBuiltinRouteDefinition(env, control(), native,
          validateModelGatewayTransportPolicy(native.transport_policy).model, operation.model_id);
        const parameters = rule.stage === "SYNTHESIZE" ? semantic.synthesis.trusted_parameters
          : rule.stage === "AUDIT_CLAIMS" ? semantic.audit.trusted_parameters : semantic.roles?.trusted_parameters;
        const requestTimeout = rule.stage === "SYNTHESIZE" ? semantic.synthesis.request_timeout_ms
          : rule.stage === "AUDIT_CLAIMS" ? semantic.audit.request_timeout_ms : semantic.roles?.request_timeout_ms;
        if (parameters === undefined || requestTimeout === undefined) throw new Error("Owner native prompt parameters are unavailable");
        const prompt = parseResearchQualificationPromptConfig({ access: { principal_ref: context.principal_ref,
          credential_generation: context.credential_generation, client_class: "owner_pwa" },
        policy: { ...profile.policy, expires_at: expiresAt }, manifest_ref: { id: `native-manifest-${operation.operation_id}-${rule.stage.toLowerCase()}`, revision: 1 },
        manifest_residency_template: { scope_domain_id: held.scope_snapshot_id, access_domain_id: context.principal_ref,
          confidentiality_domain_id: `native-catalog-${projectId}`, encryption_key_domain_id: `native-catalog-${projectId}`,
          retention_domain_id: `native-catalog-${projectId}`, erasure_domain_id: `native-catalog-${projectId}` },
        trusted_parameters: parameters, request_timeout_ms: requestTimeout });
        seeds.push({ stage: rule.stage, route_definition: definition, transport_policy: policy, prompt, expires_at: expiresAt,
          model_call: { route_ref: rule.deployment.route_ref, prompt_generation: rule.deployment.prompt_generation,
            schema_generation: rule.deployment.schema_generation, evidence_pack: held.evidence_pack,
            max_input_bytes: rule.max_input_bytes, max_output_bytes: rule.max_output_bytes,
            output_object_ref: `native-qualification-${operation.operation_id}-${rule.stage.toLowerCase()}`,
            budget_reservation_ref: operation.operation_id } });
      }
      return { source_configuration: source, seeds, expires_at: expiresAt };
    } });
  // Lazy construction keeps an installed native default usable when setup authority is absent.
  return Object.freeze({ async run(operation: Operation) {
    const gateway = composeResearchModelGatewayConfiguration(env, "workers-ai");
    const native = createResearchNativeBuiltinCatalogDriver({ database: env.CORE_DB, work_bucket: env.WORK_BUCKET,
      context, project_id: projectId, deployment_generation: env.DEPLOYMENT_GENERATION, gateway,
      control_plane: { get: (gatewayId, routeId) => control().get(gatewayId, routeId) } satisfies Pick<DynamicRouteControlPlanePort, "get">,
      project_configuration: configuration, read_current_authority: current, read_advertised_model: advertised, prepare,
      prompt_compiler: stage => createResearchQualificationPromptCompiler({ core_database: env.CORE_DB,
        search_database: env.SEARCH_DB, evidence_bucket: env.EVIDENCE_BUCKET, work_bucket: env.WORK_BUCKET,
        probe: stage.probe, config: stage.prompt, request_capabilities: stage.transport_policy.capabilities }) });
    return native.run(operation);
  } });
}
