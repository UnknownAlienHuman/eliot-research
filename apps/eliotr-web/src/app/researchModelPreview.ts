import type { ResearchModelConfigurationRevision } from '@eliotr/owner-api-client';
import { workersAiCatalogFixture } from '../query/workersAiCatalog.test-fixture';

/** Explicit read fixtures for the already-qualified native model used by workspace journeys. */
export function researchPreviewModelRead(url: URL, projectId: string, stamp: string, qualified: boolean): unknown {
  const modelId = workersAiCatalogFixture.models[0].model_id;
  if (url.pathname === '/api/v1/system/model-settings') return {
    protocol: 'eliotr.service-model-settings.v1',
    cloudflare: { provider_id: 'cloudflare-workers-ai', connection: 'builtin', binding_available: true, default_model_id: modelId },
    indexing: { provider_id: 'cloudflare-ai-search', managed: true },
    external: { management_available: true, state: 'ready', connections: [], truncated: false },
  };
  if (url.pathname === '/api/v2/system/model-providers') return {
    protocol: 'eliotr.service-model-provider-read.v2', connections: [], truncated: false,
  };
  if (url.pathname === '/api/v2/system/model-provider-catalog-preferences' &&
      url.searchParams.get('provider_id') === 'cloudflare-workers-ai') return {
    protocol: 'eliotr.service-model-provider-catalog-preferences.v1', provider_id: 'cloudflare-workers-ai',
    visibility: { mode: 'all' }, search: '', updated_at: stamp,
  };
  if (url.pathname === '/api/v1/system/research-models' && url.searchParams.get('provider_id') === 'cloudflare-workers-ai') {
    return workersAiCatalogFixture;
  }
  if (qualified && url.pathname === `/api/v1/research/projects/${projectId}/model-configuration`) {
    const selected: ResearchModelConfigurationRevision = {
      configuration_ref: `rpmc-${'a'.repeat(64)}`, configuration_sha256: 'a'.repeat(64), created_at: stamp,
      qualification_state: 'qualified', semantic_revision: { revision_ref: 'semantic-fixture', config_sha256: 'b'.repeat(64) },
      model_selections: (['SYNTHESIZE', 'AUDIT_CLAIMS'] as const).map(stage => ({
        stage, route_ref: `route/${stage.toLowerCase()}`, route_version: 'fixture-v1',
        candidate_ref: `candidate-${stage}`, candidate_sha256: 'c'.repeat(64),
        qualification_ref: `qualification-${stage}`, qualification_sha256: 'd'.repeat(64),
        provider_id: 'workers-ai', model_id: modelId, effective_reasoning_effort: null,
        transport_policy: { version: 1, transport: 'cloudflare-ai-gateway', api: 'compat-chat-completions',
          provider: 'workers-ai', model: modelId, billing: { mode: 'unified' },
          capabilities: { max_output_tokens_field: 'max_completion_tokens', reasoning_efforts: [] } },
      })),
    };
    return { protocol: 'eliotr.research-project-model-configuration.v1', project_id: projectId,
      selection_revision: 1, selected, revisions: [selected], next_cursor: null };
  }
  return undefined;
}
