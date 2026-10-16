import { describe, expect, it, vi } from 'vitest';
import { createSessionEpoch } from '../transport/session/epoch';
import { createServiceModelSettingsApi } from './service-models';

const operation = '6f06e11b-e2d0-4b16-8e84-44aa52d37533';
const request = { protocol: 'eliotr.service-model-provider-create.v1' as const, operation_id: operation,
  provider_id: 'opencode-go', display_name: 'OpenCode Go', base_url: 'https://provider.example/v1',
  model_ids: ['step-5-preview-free'], api_key: 'synthetic-credential-test-only' };
const wrap = (data: unknown) => ({ data, trace_id: 'trace-1', deployment_generation: 'deploy-1' });
const errors = (value: { code: string }) => new Error(value.code);

describe('global service model client', () => {
  it('reads built-in Cloudflare settings without a project or external management', async () => {
    const http = { requestApiWithStatuses: vi.fn(async () => wrap({ protocol: 'eliotr.service-model-settings.v1',
      cloudflare: { provider_id: 'cloudflare-workers-ai', connection: 'builtin', binding_available: true,
        default_model_id: '@cf/zai-org/glm-5.3-flash' }, indexing: { provider_id: 'cloudflare-ai-search', managed: true },
      external: { state: 'unavailable', management_available: false, connections: [], truncated: false } })) };
    const api = createServiceModelSettingsApi(http, errors, createSessionEpoch());

    const result = await api.readServiceModelSettings('deploy-1');

    expect(http.requestApiWithStatuses).toHaveBeenCalledExactlyOnceWith('/api/v1/system/model-settings', { method: 'GET' }, [200]);
    expect(result.cloudflare.binding_available).toBe(true);
    expect(result.external.management_available).toBe(false);
  });

  it('sends a key once in a global POST body and returns only validated metadata', async () => {
    const http = { requestApiWithStatuses: vi.fn(async () => wrap({ protocol: request.protocol, operation_id: operation,
      provider_id: request.provider_id, display_name: request.display_name, model_ids: request.model_ids,
      base_url: request.base_url, alias: 'eliotr-global-test', provider_config_id: 'config-1',
      provider_slug: 'custom-opencode-go', status: 'configured', created_at: '2026-10-15T14:00:00.000Z' })) };
    const api = createServiceModelSettingsApi(http, errors, createSessionEpoch());

    const result = await api.createServiceModelProvider(request, 'deploy-1');

    expect(http.requestApiWithStatuses).toHaveBeenCalledExactlyOnceWith('/api/v1/system/model-providers', {
      method: 'POST', body: JSON.stringify(request), headers: { 'content-type': 'application/json',
        'x-eliotr-csrf': '1', 'idempotency-key': operation },
    }, [200, 201]);
    expect(result).not.toHaveProperty('api_key');
    expect(result).not.toHaveProperty('project_id');
  });

  it('connects a catalog-managed provider without a manually supplied model ID', async () => {
    const input = { protocol: 'eliotr.service-model-provider-catalog-connect.v2' as const,
      operation_id: operation, provider_id: 'opencode-go', display_name: 'OpenCode Go',
      model_registration_mode: 'catalog_managed' as const, api_key: 'synthetic-credential-test-only' };
    const http = { requestApiWithStatuses: vi.fn(async () => wrap({ protocol: input.protocol,
      operation_id: operation, provider_id: input.provider_id, display_name: input.display_name,
      model_registration_mode: 'catalog_managed', base_url: 'https://opencode.ai/inference/go/v1',
      alias: 'eliotr-global-test', provider_config_id: 'config-1', provider_slug: 'custom-opencode-go',
      status: 'configured', created_at: '2026-10-15T14:00:00.000Z' })) };
    const api = createServiceModelSettingsApi(http, errors, createSessionEpoch());

    const result = await api.createCatalogManagedServiceModelProvider(input, 'deploy-1');

    expect(http.requestApiWithStatuses).toHaveBeenCalledExactlyOnceWith('/api/v2/system/model-providers', {
      method: 'POST', body: JSON.stringify(input), headers: { 'content-type': 'application/json',
        'x-eliotr-csrf': '1', 'idempotency-key': operation },
    }, [200, 201]);
    expect(result.model_registration_mode).toBe('catalog_managed');
    expect(result).not.toHaveProperty('model_ids');
    expect(result).not.toHaveProperty('api_key');
  });

  it('reads and persists owner model visibility and search preferences', async () => {
    const prefs = { protocol: 'eliotr.service-model-provider-catalog-preferences.v1', provider_id: 'openrouter',
      visibility: { mode: 'exclude', model_ids: ['vendor/hidden-model'] }, search: 'reasoning',
      updated_at: '2026-10-15T14:00:00.000Z' };
    const http = { requestApiWithStatuses: vi.fn(async () => wrap(prefs)) };
    const api = createServiceModelSettingsApi(http, errors, createSessionEpoch());

    await api.readServiceModelProviderCatalogPreferences('openrouter', 'deploy-1');
    await api.updateServiceModelProviderCatalogPreferences({
      protocol: 'eliotr.service-model-provider-catalog-preferences.v1', provider_id: 'openrouter',
      visibility: { mode: 'exclude', model_ids: ['vendor/hidden-model'] }, search: 'reasoning',
    }, 'deploy-1');

    expect(http.requestApiWithStatuses).toHaveBeenNthCalledWith(1,
      '/api/v2/system/model-provider-catalog-preferences?provider_id=openrouter', { method: 'GET' }, [200]);
    expect(http.requestApiWithStatuses).toHaveBeenNthCalledWith(2, '/api/v2/system/model-provider-catalog-preferences', {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-eliotr-csrf': '1' },
      body: JSON.stringify({ protocol: 'eliotr.service-model-provider-catalog-preferences.v1', provider_id: 'openrouter',
        visibility: { mode: 'exclude', model_ids: ['vendor/hidden-model'] }, search: 'reasoning' }),
    }, [200]);
  });

  it('does not retry an uncertain write and reads only the original operation', async () => {
    const http = { requestApiWithStatuses: vi.fn()
      .mockRejectedValueOnce(new Error('lost acknowledgement'))
      .mockResolvedValueOnce(wrap({ protocol: 'eliotr.service-model-settings.v1', connection: null, truncated: false })) };
    const api = createServiceModelSettingsApi(http, errors, createSessionEpoch());

    await expect(api.createServiceModelProvider(request, 'deploy-1')).rejects.toThrow('lost acknowledgement');
    expect(http.requestApiWithStatuses).toHaveBeenCalledTimes(1);
    await api.readServiceModelProviderOperation(operation, 'deploy-1');

    expect(http.requestApiWithStatuses).toHaveBeenNthCalledWith(2,
      `/api/v1/system/model-providers?operation_id=${operation}`, { method: 'GET' }, [200]);
  });

  it('discards an in-flight result after the owner epoch changes', async () => {
    const epoch = createSessionEpoch();
    const http = { requestApiWithStatuses: vi.fn(async () => { epoch.advance(); return wrap({}); }) };
    const api = createServiceModelSettingsApi(http, errors, epoch);
    await expect(api.readServiceModelSettings('deploy-1')).rejects.toThrow('API_SESSION_CLOSED');
  });
});
