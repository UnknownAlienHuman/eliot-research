import { describe, expect, it } from 'vitest';

import type { LegacyErrorFactory } from '../../legacy/http';
import { createSessionEpoch } from '../../transport/session/epoch';
import {
  createResearchModelConfigurationApi,
  researchModelCatalogAdapterForRouteProvider,
  type ResearchModelCatalogEntry,
  type ResearchModelConfigurationRevision,
  type ResearchModelSelectionSummary,
  type ModelsHttp,
} from './models';

const projectId = 'project-1';
const generation = 'deploy-1';
const digest = 'a'.repeat(64);

const errors: LegacyErrorFactory = (detail) => new Error(`${detail.code}:${detail.status}`);

function envelope(data: unknown): unknown {
  return { data, trace_id: 'trace-1', deployment_generation: generation };
}

interface Call {
  readonly path: string;
  readonly init: RequestInit | undefined;
  readonly statuses: readonly number[];
}

function recorder(response: unknown): { http: ModelsHttp; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    http: {
      requestApiWithStatuses(path: string, init: RequestInit | undefined, statuses: readonly number[]) {
        calls.push({ path, init, statuses });
        return Promise.resolve(response);
      },
    },
  };
}

const catalogEntry = (overrides: Partial<ResearchModelCatalogEntry> = {}): ResearchModelCatalogEntry => ({
  provider_id: 'cloudflare-workers-ai',
  model_id: '@cf/example/model',
  name: 'Example model',
  description: 'A catalog entry.',
  catalog_availability: 'listed',
  account_availability: 'unknown',
  capabilities: {
    text_generation: 'supported',
    input_output_schema: 'not_exposed_by_workers_ai_binding',
    schema_requirement: 'GET /client/v4/accounts/{account_id}/ai/models/schema?model={model_id}',
  },
  source_id: 7,
  source_task: { id: 'text-generation', name: 'Text Generation', description: 'Generate text' },
  billing: { selected_path: 'workers_ai_binding', support: 'unknown', account_entitlement: 'not_established_by_catalog' },
  properties: [],
  tags: ['text-generation'],
  ...overrides,
});

const modelSelection = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  stage: 'SYNTHESIZE',
  route_ref: 'route/research',
  route_version: 'v1',
  candidate_ref: 'candidate-1',
  candidate_sha256: digest,
  qualification_ref: 'qualification-1',
  qualification_sha256: 'b'.repeat(64),
  provider_id: 'openai',
  model_id: 'glm-5.3-flash',
  effective_reasoning_effort: 'max',
  transport_policy: {
    version: 1,
    transport: 'cloudflare-ai-gateway',
    api: 'compat-chat-completions',
    provider: 'openai',
    model: 'glm-5.3-flash',
    billing: { mode: 'byok', alias: 'default' },
    capabilities: { max_output_tokens_field: 'max_tokens', reasoning_efforts: ['max', 'high', 'low'] },
  },
  ...overrides,
});

const revision = (overrides: Record<string, unknown> = {}): ResearchModelConfigurationRevision => ({
  configuration_ref: 'model-config-1',
  configuration_sha256: digest,
  created_at: '2026-10-03T12:00:00.000Z',
  qualification_state: 'qualified',
  semantic_revision: { revision_ref: 'semantic-1', config_sha256: 'c'.repeat(64) },
  model_selections: [modelSelection() as unknown as ResearchModelSelectionSummary],
  ...overrides,
});

const configurationBody = (selected: unknown, revisions: readonly unknown[] = [selected]) => ({
  protocol: 'eliotr.research-project-model-configuration.v1',
  project_id: projectId,
  selection_revision: 3,
  selected,
  revisions,
  next_cursor: null,
});

describe('research model catalog request shape', () => {
  it('maps the Workers AI route provider to its catalog adapter without aliasing others', () => {
    expect(researchModelCatalogAdapterForRouteProvider('workers-ai')).toBe('cloudflare-workers-ai');
    expect(researchModelCatalogAdapterForRouteProvider('openrouter')).toBe('openrouter');
  });

  it('sends the exact catalog query and the 200-only status', async () => {
    const body = {
      protocol: 'eliotr.research-model-catalog.v1',
      project_id: projectId,
      task: 'text-generation',
      catalog_scope: 'workers_ai',
      provider_id: 'cloudflare-workers-ai',
      models: [],
      pagination: { page: 1, per_page: 20, has_more: false, next_page: null, coverage: 'complete', probe: 'next_page_empty' },
    };
    const { http, calls } = recorder(envelope(body));
    const api = createResearchModelConfigurationApi(http, errors, createSessionEpoch());
    const page = await api.readResearchModelCatalog(projectId, generation, { providerId: 'workers-ai' });
    expect(calls[0]?.path).toBe('/api/v1/system/research-models?project_id=project-1&page=1&per_page=20&task=text-generation&provider_id=cloudflare-workers-ai');
    expect(calls[0]?.statuses).toEqual([200]);
    expect(page.models).toEqual([]);
  });

  it('decodes catalog availability, capability and billing as separate facts', async () => {
    const body = {
      protocol: 'eliotr.research-model-catalog.v1',
      project_id: projectId,
      task: 'text-generation',
      catalog_scope: 'workers_ai',
      provider_id: 'cloudflare-workers-ai',
      models: [catalogEntry()],
      pagination: { page: 1, per_page: 20, has_more: false, next_page: null, coverage: 'complete', probe: 'next_page_empty' },
    };
    const { http } = recorder(envelope(body));
    const api = createResearchModelConfigurationApi(http, errors, createSessionEpoch());
    const page = await api.readResearchModelCatalog(projectId, generation);
    expect(page.models).toHaveLength(1);
    const model = page.models[0];
    expect(model?.capabilities.text_generation).toBe('supported');
    expect(model?.billing.support).toBe('unknown');
    expect(model?.account_availability).toBe('unknown');
  });

  it('accepts the plain default catalog entry', async () => {
    const { http } = recorder(envelope({
      protocol: 'eliotr.research-model-catalog.v1',
      project_id: projectId,
      task: 'text-generation',
      catalog_scope: 'workers_ai',
      provider_id: 'cloudflare-workers-ai',
      models: [catalogEntry()],
      pagination: { page: 1, per_page: 20, has_more: false, next_page: null, coverage: 'complete', probe: 'next_page_empty' },
    }));
    const api = createResearchModelConfigurationApi(http, errors, createSessionEpoch());
    const page = await api.readResearchModelCatalog(projectId, generation);
    expect(page.models[0]?.capabilities.text_generation).toBe('supported');
  });

  it('rejects a catalog response for another deployment generation', async () => {
    const body = {
      protocol: 'eliotr.research-model-catalog.v1',
      project_id: projectId,
      task: 'text-generation',
      catalog_scope: 'workers_ai',
      provider_id: 'cloudflare-workers-ai',
      models: [],
      pagination: { page: 1, per_page: 20, has_more: false, next_page: null, coverage: 'complete', probe: 'next_page_empty' },
      trace_id: 'trace-1',
      deployment_generation: 'deploy-2',
    };
    const { trace_id, deployment_generation, ...data } = body;
    const { http } = recorder({ data, trace_id, deployment_generation });
    const api = createResearchModelConfigurationApi(http, errors, createSessionEpoch());
    await expect(api.readResearchModelCatalog(projectId, generation))
      .rejects.toThrow('API_GENERATION_MISMATCH:409');
  });
});

describe('research project model configuration', () => {
  it('reads exact saved revisions and retains the BYOK alias without key material', async () => {
    const { http } = recorder(envelope(configurationBody(revision())));
    const api = createResearchModelConfigurationApi(http, errors, createSessionEpoch());
    const result = await api.readResearchProjectModelConfiguration(projectId, generation);
    const selection = result.selected?.model_selections[0];
    expect(selection?.provider_id).toBe('openai');
    expect(JSON.stringify(result)).not.toMatch(/api[_-]?key|secret/iu);
  });

  it('keeps a missing legacy effort unknown instead of deriving it', async () => {
    const legacySelection = modelSelection();
    delete legacySelection.effective_reasoning_effort;
    const { http } = recorder(envelope(configurationBody(revision({
      model_selections: [legacySelection as unknown as ResearchModelSelectionSummary],
    }))));
    const api = createResearchModelConfigurationApi(http, errors, createSessionEpoch());
    const result = await api.readResearchProjectModelConfiguration(projectId, generation);
    expect(result.selected?.model_selections[0]?.effective_reasoning_effort).toBeNull();
  });

  it('preserves the exact native marker while an unmarked sibling gains none', async () => {
    // A native marker is legal only with a free-only OpenRouter BYOK policy, so both selections
    // here carry that policy exactly as the original fixture does.
    const nativePolicy = {
      version: 1,
      transport: 'cloudflare-ai-gateway',
      api: 'openrouter-chat-completions',
      provider: 'openrouter',
      model: 'stealth/space-bunny-alpha',
      billing: { mode: 'byok', alias: 'openrouter-test', free_only: true },
      capabilities: { max_output_tokens_field: 'max_tokens', reasoning_efforts: ['max'] },
    };
    const marked = modelSelection({
      candidate_kind: 'provider-native-v1',
      provider_id: 'openrouter',
      model_id: nativePolicy.model,
      transport_policy: nativePolicy,
    });
    const unmarked = modelSelection({
      stage: 'AUDIT_CLAIMS',
      provider_id: 'openrouter',
      model_id: nativePolicy.model,
      transport_policy: nativePolicy,
    });
    const { http } = recorder(envelope(configurationBody(revision({
      model_selections: [marked as unknown as ResearchModelSelectionSummary, unmarked as unknown as ResearchModelSelectionSummary],
    }))));
    const api = createResearchModelConfigurationApi(http, errors, createSessionEpoch());
    const result = await api.readResearchProjectModelConfiguration(projectId, generation);
    const selections = result.selected?.model_selections ?? [];
    expect(selections[0]?.candidate_kind).toBe('provider-native-v1');
    expect(Object.hasOwn(selections[1] ?? {}, 'candidate_kind')).toBe(false);
  });

  it('rejects an unknown saved qualification state', async () => {
    const { http } = recorder(envelope(configurationBody(revision({ qualification_state: 'unknown' }))));
    const api = createResearchModelConfigurationApi(http, errors, createSessionEpoch());
    await expect(api.readResearchProjectModelConfiguration(projectId, generation))
      .rejects.toThrow('API_RESPONSE_SCHEMA_MISMATCH:502');
  });
});

describe('research model selection mutation', () => {
  it('sends the compare-and-swap body with a caller-supplied idempotency key', async () => {
    const { http, calls } = recorder(envelope({
      protocol: 'eliotr.research-project-model-configuration.v1',
      project_id: projectId,
      selection_revision: 4,
      selected: revision(),
    }));
    const api = createResearchModelConfigurationApi(http, errors, createSessionEpoch());
    const view = await api.selectResearchProjectModelConfiguration(
      projectId, generation, 3, 'model-config-1', 'model-config-client-key',
    );
    expect(view.selection_revision).toBe(4);
    expect(calls[0]?.path).toBe(`/api/v1/research/projects/${encodeURIComponent(projectId)}/model-configuration`);
    expect(calls[0]?.init?.method).toBe('PUT');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('model-config-client-key');
    expect(headers['x-eliotr-csrf']).toBe('1');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      expected_revision: 3,
      select_configuration_ref: 'model-config-1',
    });
    expect(calls[0]?.statuses).toEqual([200]);
  });

  it('rejects a receipt that names a different configuration', async () => {
    const { http } = recorder(envelope({
      protocol: 'eliotr.research-project-model-configuration.v1',
      project_id: projectId,
      selection_revision: 4,
      selected: revision({ configuration_ref: 'model-config-other' }),
    }));
    const api = createResearchModelConfigurationApi(http, errors, createSessionEpoch());
    await expect(api.selectResearchProjectModelConfiguration(projectId, generation, 3, 'model-config-1', 'k'))
      .rejects.toThrow('API_RESPONSE_SCHEMA_MISMATCH:502');
  });

  it('rejects a selection whose expected revision is negative', async () => {
    const { http, calls } = recorder(envelope({}));
    const api = createResearchModelConfigurationApi(http, errors, createSessionEpoch());
    await expect(api.selectResearchProjectModelConfiguration(projectId, generation, -1, 'model-config-1', 'k'))
      .rejects.toThrow('MODEL_CONFIGURATION_INPUT_INVALID:400');
    expect(calls).toHaveLength(0);
  });

  it('rejects a decoded selection produced after the shared epoch advanced', async () => {
    const epoch = createSessionEpoch();
    const { http } = recorder(envelope({
      protocol: 'eliotr.research-project-model-configuration.v1',
      project_id: projectId,
      selection_revision: 4,
      selected: revision(),
    }));
    const api = createResearchModelConfigurationApi(http, errors, epoch);
    const pending = api.selectResearchProjectModelConfiguration(projectId, generation, 3, 'model-config-1', 'k');
    epoch.advance();
    await expect(pending).rejects.toThrow('API_SESSION_CLOSED:503');
  });
});
