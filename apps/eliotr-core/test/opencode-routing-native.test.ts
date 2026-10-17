import { applyD1Migrations, env as generatedEnv } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL } from '@eliotr/contracts';
import type { AuthenticatedRequestContext } from '@eliotr/interfaces';
import { createServiceModelProviderService } from '@eliotr/cloudflare-model-control/service-model-provider-service.js';
import { createResearchProviderModelCatalogTransports } from '@eliotr/cloudflare-model-control/research-provider-model-catalog.js';
import { createResearchCatalogModelUseComposition } from '../src/research-catalog-model-use-composition.js';
import { createOpenCodeDiscoveryRouting, createOpenCodeRegisteredProviderReader } from '../src/research-opencode-routing.js';
import { createNativeUseEnvironment } from './research-provider-key-model-use-fixture.js';
import type { Env } from '../src/env.js';
import { composeResearchModelGatewayConfiguration } from '../src/research-prepared-model-transport.js';
import { createResearchModelGatewayRuntime } from '@eliotr/cloudflare-model-control/research-model-gateway-runtime.js';
import type { ModelGatewayTransportPolicyV1 } from '@eliotr/cloudflare-ai';

const env = generatedEnv as unknown as Env & { CORE_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const db = env.CORE_DB;
const model = 'exact-catalog-model';
const root = `https://gateway.ai.cloudflare.com/v1/${'a'.repeat(32)}/eliotr-reasoning`;
beforeAll(async () => { await applyD1Migrations(db, env.CORE_MIGRATIONS); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('OpenCode discovery through native qualification multiplexing', () => {
  it('routes the actual prepared runtime transport for each qualified codec through the same CF base', async () => {
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url.startsWith('https://api.cloudflare.com/')) {
        expect(request.headers.get('authorization')).toBe('Bearer synthetic-control');
        return Response.json({ success: true, result: [{ slug: 'custom-opencode-go', enable: true, base_url: 'https://opencode.ai' }],
          result_info: { page: 1, total_count: 1 } });
      }
      expect(request.method).toBe('POST');
      expect(request.redirect).toBe('manual');
      expect(request.headers.get('cf-aig-byok-alias')).toBe('saved-alias');
      requests.push(request.url);
      return Response.json({ ok: true });
    };
    vi.stubGlobal('fetch', fetcher);
    const configuration = composeResearchModelGatewayConfiguration({ ...env, AI_GATEWAY_REASONING_URL: root,
      ELIOTR_MODEL_GATEWAY_TOKEN: 'synthetic-gateway', ELIOTR_MODEL_PROVIDER_CONTROL_TOKEN: 'synthetic-control' }, 'custom-opencode-go');
    for (const [api, oldPath, path, field] of [
      ['custom-responses', 'responses', 'openai/v1/responses', 'max_output_tokens'],
      ['custom-chat-completions', 'chat/completions', 'openai/v1/chat/completions', 'max_tokens'],
      ['custom-anthropic-messages', 'v1/messages', 'anthropic/v1/messages', 'max_tokens'],
    ] as const) {
      const policy: ModelGatewayTransportPolicyV1 = { version: 1, transport: 'cloudflare-ai-gateway', provider: 'custom-opencode-go', api, model,
        billing: { mode: 'byok', alias: 'saved-alias' }, capabilities: { max_output_tokens_field: field, reasoning_efforts: [] } };
      const runtime = createResearchModelGatewayRuntime({ ...configuration, transport_policy: policy });
      if (!('prepare_request' in runtime) || runtime.prepare_request === undefined) throw new Error('missing preparation seam');
      const original = { url: `${root}/custom-custom-opencode-go/${oldPath}`, method: 'POST' as const,
        headers: { 'cf-aig-request-timeout': '5000', 'cf-aig-byok-alias': 'saved-alias' }, body: JSON.stringify({ model }),
        body_sha256: 'a'.repeat(64), parameters_sha256: 'b'.repeat(64), request_timeout_ms: 5000 };
      await expect(runtime.transport.fetch(original.url, { method: 'POST', headers: original.headers, body: original.body, redirect: 'error' }))
        .rejects.toMatchObject({ code: 'MODEL_GATEWAY_REQUEST_INVALID' });
      const prepared = await runtime.prepare_request(original);
      expect(prepared).toEqual({ ...original, url: `${root}/custom-custom-opencode-go/inference/go/${path}` });
      const response = await runtime.transport.fetch(prepared.url, { method: 'POST', headers: prepared.headers, body: prepared.body, redirect: 'error' });
      expect(response).toBeInstanceOf(Response);
    }
    expect(requests).toHaveLength(3);
  });
  it.each([
    ['@ai-sdk/openai', 'openai/v1', 'responses', false],
    ['@ai-sdk/openai-compatible', 'openai/v1', 'chat/completions', false],
    ['@ai-sdk/anthropic', 'anthropic/v1', 'messages', false],
    ['@ai-sdk/google', 'google/v1beta', 'models', true],
    ['@ai-sdk/anthropic', 'anthropic/v1', 'messages', true],
  ] as const)('uses exact %s metadata and refuses incompatible routing before dispatch', async (sdk, family, suffix, blocked) => {
    const owner = `mux-owner-${crypto.randomUUID()}`, project = `mux-project-${crypto.randomUUID()}`;
    const providerOperation = crypto.randomUUID(), operation = crypto.randomUUID(), now = new Date().toISOString();
    const context: AuthenticatedRequestContext = { request: new Request('https://eliot.test/owner'), principal_ref: owner,
      credential_generation: `credential-${crypto.randomUUID()}`, client_class: 'owner_pwa', trace_id: crypto.randomUUID() };
    await db.prepare("INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref," +
      "default_model_profile_ref,default_depth_profile_ref,generation,created_at) VALUES(?1,'mux','private','retention','source','profile','depth',1,?2)")
      .bind(project, now).run();
    await db.prepare("INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at) VALUES(?1,?2,'mux-test',?3,?3)")
      .bind(project, owner, now).run();
    const providers = createServiceModelProviderService({ database: db, managementPort: { available: true,
      create: async input => ({ provider_config_id: `config-${input.operation_id}`, provider_slug: 'custom-opencode-go', alias: input.alias }),
      read: async () => null } });
    const connection = await providers.create(context, { protocol: SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL, operation_id: providerOperation,
      provider_id: 'opencode-go', display_name: 'Go', base_url: 'https://opencode.ai/inference/go/v1', model_ids: [model], api_key: 'synthetic-test-key' });
    const installed = await createNativeUseEnvironment(owner, db, { ...env, ENVIRONMENT: 'development', DEPLOYMENT_GENERATION: 'mux-test', AI_GATEWAY_REASONING_URL: root });
    const installedEnv = { ...installed, ELIOTR_MODEL_PROVIDER_CONTROL_TOKEN: 'synthetic-control' } as Env;
    const registeredBase = blocked && sdk === '@ai-sdk/anthropic' ? 'https://opencode.ai/inference/go/openai/v1' : 'https://opencode.ai';
    let calls = 0, modelSourceReads = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === 'https://api.cloudflare.com') {
        expect(request.method).toBe('GET');
        expect(url.pathname).toBe(`/client/v4/accounts/${'a'.repeat(32)}/ai-gateway/custom-providers`);
        expect(request.headers.get('authorization')).toBe('Bearer synthetic-control');
        return Response.json({ success: true, result: [{ id: 'existing-provider', slug: 'custom-opencode-go', enable: true, base_url: registeredBase }],
          result_info: { page: 1, per_page: 100, total_count: 1 } });
      }
      if (url.href === 'https://opencode.ai/inference/go/v1/models') {
        expect(request.headers.has('authorization')).toBe(false);
        return Response.json({ object: 'list', data: [{ id: model }] });
      }
      if (url.href === 'https://models.dev/api.json') {
        modelSourceReads += 1;
        expect(request.headers.has('authorization')).toBe(false);
        return Response.json({ 'opencode-go': { id: 'opencode-go', models: { [model]: { id: model, cost: { input: 0.1, output: 0.2 },
          reasoning: true, structured_output: false, temperature: false, provider: { npm: sdk, api: `https://opencode.ai/inference/go/${family}` } } } } });
      }
      calls += 1;
      expect(request.url).toBe(`${root}/custom-custom-opencode-go/inference/go/${family}/${suffix}`);
      expect(request.headers.get('cf-aig-byok-alias')).toBe(connection.receipt.alias);
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      expect(body.model).toBe(model);
      const text = JSON.stringify({ connected: true, qualification_purpose: 'structured-output-connectivity' });
      const response = sdk === '@ai-sdk/anthropic'
        ? { id: 'msg-result', type: 'message', role: 'assistant', model, stop_reason: 'end_turn', stop_sequence: null,
          content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 6 } }
        : sdk === '@ai-sdk/openai'
          ? { object: 'response', id: 'response-result', created_at: 1_760_000_000, model, status: 'completed',
            output: [{ id: 'output-result', type: 'message', role: 'assistant', status: 'completed',
              content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 6, total_tokens: 16 } }
          : { id: 'chat-result', object: 'chat.completion', created: 1, model,
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
            usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 } };
      return Response.json(response, { headers: { 'cf-aig-log-id': `mux-log-${calls}`, 'cf-aig-provider': 'custom-custom-opencode-go', 'cf-aig-model': model } });
    };
    vi.stubGlobal('fetch', fetcher);
    const transports = createResearchProviderModelCatalogTransports({ gateway_base_url: root, fetcher,
      resolve_opencode_routes: createOpenCodeDiscoveryRouting(installedEnv, context.request.signal, fetcher) });
    const catalog = await transports.find(item => item.provider_id === 'opencode-go')?.listTextGeneration({ page: 1, per_page: 50, task: 'text-generation' });
    expect(catalog?.models).toHaveLength(1);
    expect(catalog?.models[0]?.properties).toContainEqual(expect.objectContaining({ property_id: 'opencode_transport',
      value: expect.objectContaining({ status: blocked ? 'blocked' : 'eligible_unverified' }) }));
    expect(modelSourceReads).toBe(1);
    const api = createResearchCatalogModelUseComposition(installedEnv, context, project);
    const result = await api.start({ protocol: 'eliotr.research.catalog-model-use-request.v1', operation_id: operation,
      expected_selection_revision: null, provider_id: 'opencode-go', provider_operation_id: providerOperation, model_id: model });
    expect(result).toMatchObject(blocked ? { state: 'blocked', failure_code: 'MODEL_NOT_SUPPORTED' } : { state: 'selected', phase: 'complete' });
    expect(blocked ? calls === 0 : calls > 0).toBe(true);
    const after = await db.prepare('SELECT provider_slug,provider_config_id,alias,base_url FROM service_model_provider_operation WHERE owner_id=?1 AND operation_id=?2')
      .bind(owner, providerOperation).first();
    expect(after).toMatchObject({ provider_slug: 'custom-opencode-go', alias: connection.receipt.alias, base_url: 'https://opencode.ai/inference/go/v1' });
    expect(await createOpenCodeRegisteredProviderReader({ ...installedEnv, ELIOTR_MODEL_PROVIDER_CONTROL_TOKEN: '' })( 'custom-opencode-go')).toBeNull();
  }, 30_000);
});
