import { describe, expect, it, vi } from 'vitest';
import { createResearchRunsApi, createSessionEpoch, type ResearchProjectModelConfiguration, type ServiceModelCatalogPage } from '@eliotr/owner-api-client';
import { createPrivacyController } from '../app/privacy';
import { buildChatModelOptions, preferredChatModelIdentity, type ChatModelCatalogSlice } from './chatModelCatalog';
import { chatPreferredModelCatalogQueryOptions } from './chatModelQueries';
import { chatCatalogProviderForRouteProvider } from './chatModelProviderIdentity';
import { configurationMatchesChatModel, prepareChatModelRunV4 } from './chatModelSelection';
import { workersAiCatalogFixture } from './workersAiCatalog.test-fixture';

const project: ResearchProjectModelConfiguration = { protocol: 'eliotr.research-project-model-configuration.v1', project_id: 'project-1',
  selection_revision: null, selected: null, revisions: [], next_cursor: null };
const preferences = { protocol: 'eliotr.service-model-provider-catalog-preferences.v1', provider_id: 'cloudflare-workers-ai',
  visibility: { mode: 'all' }, search: '', updated_at: null } as const;

describe('preferred chat model catalog integration', () => {
  it('retains the installed default missing from page one using separate exact catalog metadata and saved visibility', () => {
    const installed = workersAiCatalogFixture.models[0];
    const firstModel = { ...installed, model_id: '@cf/first-on-page' };
    const browse: ServiceModelCatalogPage = { ...workersAiCatalogFixture, models: [firstModel],
      pagination: { page: 1, per_page: 20, has_more: true, next_page: 2, coverage: 'partial', probe: 'next_page_non_empty' } };
    const exact: ServiceModelCatalogPage = { ...workersAiCatalogFixture, models: [installed, { ...installed, model_id: '@cf/similar-result' }] };
    const preferred = preferredChatModelIdentity(project, installed.model_id);
    if (!preferred) throw new Error('Expected installed default');
    const slice: ChatModelCatalogSlice = { catalogProviderId: 'workers-ai', preferenceProviderId: 'cloudflare-workers-ai',
      catalog: browse, preferences, builtin: { bindingAvailable: true, defaultModelId: installed.model_id } };
    const bytes = JSON.stringify({ browse, exact });
    const options = buildChatModelOptions({ slices: [slice], configuration: project, preferred: { model: preferred, catalog: exact } });
    expect(preferred).toEqual({ provider_id: 'cloudflare-workers-ai', model_id: installed.model_id });
    expect(options.map(choice => choice.model.model_id)).toEqual([firstModel.model_id, installed.model_id]);
    expect(options[1]?.model).toBe(installed);
    expect(JSON.stringify({ browse, exact })).toBe(bytes);
    expect(browse.pagination).toMatchObject({ coverage: 'partial', has_more: true, next_page: 2 });
    expect(buildChatModelOptions({ slices: [{ ...slice, preferences: { ...preferences,
      visibility: { mode: 'exclude', model_ids: [installed.model_id] } } }], preferred: { model: preferred, catalog: exact } })
      .some(choice => choice.model.model_id === installed.model_id)).toBe(false);
    expect(preferredChatModelIdentity(undefined, installed.model_id)).toBeUndefined();
  });

  it('uses an exact Go synthesis pin under known physical slugs without falling back to the native default', async () => {
    const sha = 'a'.repeat(64), modelId = 'step-5-preview-free';
    const candidate: NonNullable<ResearchProjectModelConfiguration['selected']> = { configuration_ref: `rpmc-${sha}`,
      configuration_sha256: sha, created_at: '2026-10-16T12:00:00.000Z', qualification_state: 'qualified',
      semantic_revision: { revision_ref: 'semantic-1', config_sha256: 'b'.repeat(64) }, model_selections: [{ candidate_kind: 'provider-native-v2',
        stage: 'SYNTHESIZE', route_ref: 'route/research', route_version: 'v1', candidate_ref: 'candidate-1', candidate_sha256: 'c'.repeat(64),
        qualification_ref: 'qualification-1', qualification_sha256: 'd'.repeat(64), provider_id: 'custom-opencode-go', model_id: modelId,
        effective_reasoning_effort: null, transport_policy: { version: 1, transport: 'cloudflare-ai-gateway', api: 'custom-chat-completions',
          provider: 'custom-opencode-go', model: modelId, billing: { mode: 'byok', alias: 'saved-go' },
          capabilities: { max_output_tokens_field: 'max_tokens', reasoning_efforts: [] } } }] };
    const configured = { ...project, selected: candidate, revisions: [candidate], selection_revision: 4 };
    const preferred = preferredChatModelIdentity(configured, '@cf/installed-default');
    expect(preferred).toEqual({ provider_id: 'opencode-go', model_id: modelId });
    if (!preferred) throw new Error('Expected selected Go model');
    expect(configurationMatchesChatModel(candidate, preferred)).toBe(true);
    expect(chatCatalogProviderForRouteProvider('custom-opencode-zen')).toBe('opencode-zen');
    expect(chatCatalogProviderForRouteProvider('custom-unknown-provider')).toBe('custom-unknown-provider');
    const model = { ...workersAiCatalogFixture.models[0], ...preferred, source_id: null, source_task: null,
      capabilities: { text_generation: 'supported', input_output_schema: 'available_from_transport', schema_requirement: null },
      billing: { selected_path: 'provider_catalog', support: 'unknown', account_entitlement: 'not_established_by_catalog' } } as const;
    const catalog: ServiceModelCatalogPage = { ...workersAiCatalogFixture, provider_id: 'opencode-go', catalog_scope: 'external_provider',
      models: [model], pagination: { ...workersAiCatalogFixture.pagination, probe: 'provider_reported' } };
    const options = buildChatModelOptions({ configuration: configured, preferred: { model: preferred, catalog }, slices: [{
      catalogProviderId: 'opencode-go', preferenceProviderId: 'opencode-go', preferences: { ...preferences, provider_id: 'opencode-go' },
      connection: { provider_id: 'opencode-go', operation_id: '11111111-1111-4111-8111-111111111111', status: 'configured',
        model_registration_mode: 'explicit_allowlist', model_ids: ['legacy-muse'], display_name: 'Go', base_url: null,
        provider_config_id: 'provider-1', alias: 'saved-go', failure_code: null, provider_http_status: null,
        created_at: '2026-10-16T12:00:00.000Z', updated_at: '2026-10-16T12:00:00.000Z' },
    }] });
    expect(options[0]).toMatchObject({ canRun: true, candidate });
    const models = { readResearchProjectModelConfiguration: vi.fn().mockResolvedValue(configured), selectResearchProjectModelConfiguration: vi.fn() };
    const runs = createResearchRunsApi({ request: async () => { throw new Error('No run dispatch during preparation'); },
      errors: detail => new Error(detail.code), epoch: createSessionEpoch() });
    const result = await prepareChatModelRunV4({ models: models as never, runs, projectId: project.project_id, generation: 'deploy-1',
      candidate, modelChoice: preferred, request: { query: 'Compare selected sources', scope_expression: { kind: 'PROJECT', project_id: project.project_id } },
      signal: new AbortController().signal, isCurrent: () => true, mintSelectionOperation: () => { throw new Error('Selected pin must be retained'); } });
    expect(JSON.parse(result.body).selection).toEqual({ configuration_project_id: project.project_id,
      configuration_ref: candidate.configuration_ref, configuration_sha256: sha, selection_revision: 4 });
    expect(models.selectResearchProjectModelConfiguration).not.toHaveBeenCalled();
  });

  it('reads one protected full-ID catalog page and rejects project/epoch loss without changing the response DTO', async () => {
    const privacy = createPrivacyController({ mask() {}, reveal() {}, cancelReads() {}, clearProtected() {},
      timers: { setTimeout: () => 0, clearTimeout() {} }, now: () => Date.parse('2026-10-16T12:00:00.000Z'),
      verify: async () => ({ principal: 'owner-1', credentialGeneration: 'credential-1', deploymentGeneration: 'deploy-1', expiresAt: '2027-01-01T00:00:00.000Z' }) });
    await privacy.refresh(); const snapshot = privacy.getSnapshot();
    if (snapshot.phase !== 'available') throw new Error('Fixture authority unavailable');
    const preferred = workersAiCatalogFixture.models[0];
    const models = { readServiceModelCatalog: vi.fn().mockResolvedValue(workersAiCatalogFixture) };
    let current = true;
    const query = chatPreferredModelCatalogQueryOptions(models, privacy, snapshot.context, preferred, () => current, project.project_id);
    if (typeof query.queryFn !== 'function') throw new Error('Preferred catalog reader missing');
    const signal = new AbortController().signal;
    expect(await query.queryFn({ signal } as never)).toBe(workersAiCatalogFixture);
    expect(models.readServiceModelCatalog).toHaveBeenCalledExactlyOnceWith('deploy-1', {
      providerId: preferred.provider_id, search: preferred.model_id, page: 1, perPage: 20 }, signal);
    expect(query.queryKey).toContain(snapshot.context.cacheEpoch); expect(query.queryKey).toContain(preferred.model_id); expect(query.queryKey).toContain(project.project_id);
    let finish: ((page: ServiceModelCatalogPage) => void) | undefined;
    models.readServiceModelCatalog.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = query.queryFn({ signal } as never);
    current = false; finish?.(workersAiCatalogFixture);
    await expect(pending).rejects.toThrow();
    privacy.close();
    await expect(async () => query.queryFn && typeof query.queryFn === 'function' && query.queryFn({ signal } as never)).rejects.toThrow();
    expect(models.readServiceModelCatalog).toHaveBeenCalledTimes(2);
    privacy.dispose();
  });
});
