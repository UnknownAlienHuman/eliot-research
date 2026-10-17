import { describe, expect, it } from "vitest";
import type { ResearchModelConfigurationRevision, ResearchProjectModelConfiguration, ServiceModelCatalogPage } from "@eliotr/owner-api-client";
import { buildChatModelOptions, type ChatModelCatalogSlice } from "./chatModelCatalog";
import type { ModelCatalogEntry } from "./modelCatalog";
import type { ServiceModelProviderConnectionV2 } from "./globalModelSettings";
import { readWorkersAiCatalogFixture } from "./workersAiCatalog.test-fixture";

const digest = "a".repeat(64);
const configuredRevision = (modelId: string, qualificationState: ResearchModelConfigurationRevision["qualification_state"] = "qualified"):
  ResearchModelConfigurationRevision => ({
    configuration_ref: `rpmc-${digest}`, configuration_sha256: digest, created_at: "2026-10-16T12:00:00.000Z",
    qualification_state: qualificationState,
    semantic_revision: { revision_ref: "semantic-1", config_sha256: "b".repeat(64) },
    model_selections: [{ stage: "SYNTHESIZE", route_ref: "route/research", route_version: "v1",
      candidate_ref: "candidate-1", candidate_sha256: "e".repeat(64), qualification_ref: "qualification-1",
      qualification_sha256: "f".repeat(64), provider_id: "openrouter", model_id: modelId,
      effective_reasoning_effort: "high", transport_policy: { version: 1, transport: "cloudflare-ai-gateway",
        api: "compat-chat-completions", provider: "openrouter", model: modelId,
        billing: { mode: "byok", alias: "default" },
        capabilities: { max_output_tokens_field: "max_tokens", reasoning_efforts: ["high", "low"] } } }],
  });

const entry = (providerId: string, modelId: string): ModelCatalogEntry => ({
  provider_id: providerId, model_id: modelId, name: modelId, description: "Catalog entry",
  catalog_availability: "listed", account_availability: "unknown",
  capabilities: { text_generation: "supported", input_output_schema: "available_from_transport", schema_requirement: null },
  source_id: null, source_task: null,
  billing: { selected_path: "provider_catalog", support: "unknown", account_entitlement: "not_established_by_catalog" },
  properties: [], tags: [],
});

function catalog(providerId: string, models: readonly ModelCatalogEntry[]): ServiceModelCatalogPage {
  return { protocol: "eliotr.service-model-catalog.v1", task: "text-generation", catalog_scope: "external_provider",
    provider_id: providerId, models, pagination: { page: 1, per_page: 20, has_more: false, next_page: null,
      coverage: "complete", probe: "provider_reported" } };
}

function preferences(providerId: string, visibility: { mode: "all" } | { mode: "exclude"; model_ids: string[] }) {
  return { protocol: "eliotr.service-model-provider-catalog-preferences.v1", provider_id: providerId,
    visibility, search: "", updated_at: null } as const;
}

function externalSlice(models: readonly ModelCatalogEntry[], visibility: ReturnType<typeof preferences>["visibility"] = { mode: "all" }): ChatModelCatalogSlice {
  return { catalogProviderId: "openrouter", preferenceProviderId: "openrouter",
    connection: { provider_id: "openrouter", status: "configured", model_registration_mode: "catalog_managed",
      operation_id: "11111111-1111-4111-8111-111111111111", display_name: "OpenRouter", base_url: null,
      provider_config_id: "provider-1", alias: "owner-provider-1", failure_code: null, provider_http_status: null,
      created_at: "2026-10-16T12:00:00.000Z", updated_at: "2026-10-16T12:00:00.000Z" } satisfies ServiceModelProviderConnectionV2,
    catalog: catalog("openrouter", models), preferences: preferences("openrouter", visibility) };
}

const project = (revision: ResearchModelConfigurationRevision): ResearchProjectModelConfiguration => ({
  protocol: "eliotr.research-project-model-configuration.v1", project_id: "project-1", selection_revision: 3,
  selected: revision, revisions: [revision], next_cursor: null,
});

describe("chat model catalog eligibility", () => {
  it('retains an included Go Muse option when another configured provider has no readable catalog', () => {
    const muse = { ...entry('opencode-go', 'muse-spark-1.3'), properties: [
      { property_id: 'opencode_transport', value: { status: 'eligible_unverified', api: 'custom-responses' } },
    ] };
    const external = externalSlice([]);
    if (!external.connection) throw new Error('Expected saved connection');
    const options = buildChatModelOptions({ slices: [external, { catalogProviderId: 'opencode-go', preferenceProviderId: 'opencode-go',
      connection: { ...external.connection, provider_id: 'opencode-go', model_registration_mode: 'explicit_allowlist', model_ids: ['legacy-muse'] },
      catalog: catalog('opencode-go', [muse]), preferences: { ...preferences('opencode-go', { mode: 'all' }),
        visibility: { mode: 'include', model_ids: ['muse-spark-1.3'] } },
    }] });
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ model: muse, canRun: true, availabilityCheckRequired: true });
  });
  it("applies saved visibility and requires an exact saved synthesis configuration", () => {
    const visible = entry("openrouter", "model-visible"), hidden = entry("openrouter", "model-hidden");
    const revision = configuredRevision(visible.model_id);
    const options = buildChatModelOptions({ slices: [externalSlice([visible, hidden],
      { mode: "exclude", model_ids: [hidden.model_id] })], configuration: project(revision) });
    expect(options.map(option => option.model.model_id)).toEqual([visible.model_id]);
    expect(options[0]).toMatchObject({ canRun: true, candidate: revision, builtin: false });
  });

  it("allows a discovered model to be prepared using its exact global connection without a saved configuration", () => {
    const model = entry("openrouter", "listed-only");
    const options = buildChatModelOptions({ slices: [externalSlice([model])], configuration: project(configuredRevision("other")) });
    expect(options).toEqual([{ model, providerLabel: "openrouter", key: expect.any(String), canRun: true, builtin: false,
      providerOperationId: "11111111-1111-4111-8111-111111111111", availabilityCheckRequired: true }]);
  });

  it("prepares an unqualified catalog model from the global connection without a separate project credential", () => {
    const model = entry("openrouter", "model-needs-qualification");
    const revision = configuredRevision(model.model_id, "qualification_required");
    const options = buildChatModelOptions({ slices: [externalSlice([model])], configuration: project(revision) });
    expect(options[0]).toMatchObject({ canRun: true, availabilityCheckRequired: true,
      providerOperationId: "11111111-1111-4111-8111-111111111111" });
  });

  it("uses the canonical Workers AI catalog decoded from a route-selector request", async () => {
    const { catalog, paths } = await readWorkersAiCatalogFixture();
    expect(paths).toEqual(["/api/v1/system/research-models?page=1&per_page=20&task=text-generation&provider_id=cloudflare-workers-ai"]);
    expect(catalog.provider_id).toBe("cloudflare-workers-ai");
    const defaultModel = catalog.models[0];
    if (!defaultModel) throw new Error("Workers AI fixture must contain its default model");
    expect(defaultModel.provider_id).toBe("cloudflare-workers-ai");
    const otherModel = { ...defaultModel, model_id: "@cf/other-model" };
    const slice: ChatModelCatalogSlice = { catalogProviderId: "workers-ai", preferenceProviderId: "cloudflare-workers-ai",
      catalog: { ...catalog, models: [defaultModel, otherModel] }, preferences: preferences("cloudflare-workers-ai", { mode: "all" }),
      builtin: { bindingAvailable: true, defaultModelId: defaultModel.model_id } };
    const options = buildChatModelOptions({ slices: [slice] });
    expect(options).toMatchObject([
      { model: defaultModel, canRun: true, builtin: true },
      { model: otherModel, canRun: true, builtin: true, availabilityCheckRequired: true },
    ]);
    const noBinding = buildChatModelOptions({ slices: [{ ...slice, builtin: { bindingAvailable: false, defaultModelId: defaultModel.model_id } }] });
    expect(noBinding[0]).toMatchObject({ canRun: false, unavailableReason: "builtin-default" });
  });

  it("does not use a provider whose connection outcome is not configured", () => {
    const model = entry("openrouter", "model-1");
    const slice = { ...externalSlice([model]), connection: { provider_id: "openrouter", status: "uncertain" } as never };
    expect(buildChatModelOptions({ slices: [slice], configuration: project(configuredRevision(model.model_id)) })).toEqual([]);
  });

  it.each(['opencode-go', 'opencode-zen', 'openai', 'anthropic'])("offers %s catalog models for a selected-model check without project setup", providerId => {
    const model = entry(providerId, "discovered-model"), source = externalSlice([model]);
    if (providerId === 'opencode-go' || providerId === 'opencode-zen') {
      (model as { properties: ModelCatalogEntry['properties'] }).properties = [
        { property_id: 'opencode_transport', value: { status: 'eligible_unverified', api: 'custom-responses' } },
      ];
    }
    if (!source.connection) throw new Error("Missing configured provider fixture");
    const options = buildChatModelOptions({ slices: [{ ...source, catalogProviderId: providerId, preferenceProviderId: providerId,
      connection: { ...source.connection, provider_id: providerId }, catalog: catalog(providerId, [model]),
      preferences: preferences(providerId, { mode: 'all' }) }] });
    expect(options[0]).toMatchObject({ canRun: true, availabilityCheckRequired: true,
      providerOperationId: "11111111-1111-4111-8111-111111111111" });
  });

  it.each([undefined, { status: 'blocked', reason: 'SDK_UNSUPPORTED' }, { status: 'blocked', reason: 'REGISTERED_BASE_INCOMPATIBLE' }])(
    'keeps an incompatible or unverified Go model visible but not callable', readiness => {
      const model = { ...entry('opencode-go', 'discovered-model'), properties: readiness === undefined ? [] : [
        { property_id: 'opencode_transport', value: readiness },
      ] };
      const source = externalSlice([model]);
      if (!source.connection) throw new Error('Missing connection');
      const options = buildChatModelOptions({ slices: [{ ...source, catalogProviderId: 'opencode-go', preferenceProviderId: 'opencode-go',
        connection: { ...source.connection, provider_id: 'opencode-go' }, catalog: catalog('opencode-go', [model]),
        preferences: preferences('opencode-go', { mode: 'all' }) }] });
      expect(options).toHaveLength(1);
      expect(options[0]).toMatchObject({ canRun: false, availabilityCheckRequired: true });
    },
  );

  it("offers a newly discovered model on a legacy connection for exact qualification without changing its allowlist", () => {
    const model = entry('openrouter', 'outside-allowlist'), source = externalSlice([model]);
    if (!source.connection) throw new Error("Missing configured provider fixture");
    const legacy = { ...source.connection, model_registration_mode: 'explicit_allowlist' as const, model_ids: ['legacy-muse'] };
    const options = buildChatModelOptions({ slices: [{ ...source, connection: legacy }], configuration: project(configuredRevision('legacy-muse')) });
    expect(options[0]).toMatchObject({ canRun: true, availabilityCheckRequired: true,
      providerOperationId: legacy.operation_id });
    expect(options[0]?.candidate).toBeUndefined();
    expect(legacy.model_ids).toEqual(['legacy-muse']);
    expect(buildChatModelOptions({ slices: [{ ...source, connection: legacy,
      preferences: preferences('openrouter', { mode: 'exclude', model_ids: [model.model_id] }) }] })).toEqual([]);
    expect(buildChatModelOptions({ slices: [{ ...source, connection: { ...legacy, status: 'uncertain' } as never }] })).toEqual([]);
  });
});
