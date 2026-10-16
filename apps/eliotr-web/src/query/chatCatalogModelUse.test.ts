import { describe, expect, it, vi } from 'vitest';
import { createResearchCatalogModelUseApi, createResearchModelConfigurationApi, createResearchRunsApi, createSessionEpoch,
  type ResearchCatalogModelUseReceipt, type ResearchModelConfigurationRevision } from '@eliotr/owner-api-client';
import { WorkspaceRequestError } from '../app/runtime';
import { ChatModelSelectionClosedError } from './chatModelSelection';
import { ChatCatalogModelUseUnavailableError, ChatCatalogModelUseUnconfirmedError,
  ChatCatalogModelUseDiscoveredError, prepareCatalogChatModelSelection, readDiscoveredCatalogModelOperation, type ChatCatalogModelUseIntent } from './chatCatalogModelUse';
import { workersAiCatalogFixture } from './workersAiCatalog.test-fixture';

const projectId = 'project-chat', generation = 'deployment-1', operationId = '22222222-2222-4222-8222-222222222222';
const providerOperationId = '11111111-1111-4111-8111-111111111111', digest = 'a'.repeat(64);
const revision = (provider: string, model: string): ResearchModelConfigurationRevision => ({
  configuration_ref: `rpmc-${digest}`, configuration_sha256: digest, created_at: '2026-10-16T12:00:00.000Z',
  qualification_state: 'qualified', semantic_revision: { revision_ref: 'semantic-1', config_sha256: 'b'.repeat(64) },
  model_selections: [{ stage: 'SYNTHESIZE', route_ref: 'route/research', route_version: 'v1', candidate_ref: 'candidate-1',
    candidate_sha256: 'c'.repeat(64), qualification_ref: 'qualification-1', qualification_sha256: 'd'.repeat(64),
    provider_id: provider === 'cloudflare-workers-ai' ? 'workers-ai' : provider, model_id: model, effective_reasoning_effort: null,
    transport_policy: { version: 1, transport: 'cloudflare-ai-gateway', api: 'compat-chat-completions',
      provider: provider === 'cloudflare-workers-ai' ? 'workers-ai' : provider, model,
      billing: { mode: 'byok', alias: 'saved-provider' }, capabilities: { max_output_tokens_field: 'max_tokens', reasoning_efforts: [] } } }],
});
const envelope = (data: unknown) => ({ data, trace_id: 'catalog-use-trace', deployment_generation: generation });

function fixture(builtin = false) {
  const model = builtin ? workersAiCatalogFixture.models[0] : { provider_id: 'openrouter', model_id: 'stealth/model-a' };
  const providerOperation = builtin ? null : providerOperationId;
  let held: ChatCatalogModelUseIntent | undefined, posted = false, current = true;
  let selected = revision(model.provider_id, model.model_id), selectionRevision = 4;
  const receipt = (updates: Partial<ResearchCatalogModelUseReceipt> = {}): ResearchCatalogModelUseReceipt => ({
    protocol: 'eliotr.research.catalog-model-use-receipt.v1', project_id: projectId, operation_id: operationId,
    provider_id: model.provider_id, model_id: model.model_id, provider_operation_id: providerOperation,
    state: 'selected', phase: 'complete', selected_configuration_ref: selected.configuration_ref,
    selected_configuration_sha256: selected.configuration_sha256, selection_revision: 4, failure_code: null,
    created_at: '2026-10-16T12:00:00.000Z', updated_at: '2026-10-16T12:00:01.000Z', ...updates,
  });
  const config = () => ({ protocol: 'eliotr.research-project-model-configuration.v1', project_id: projectId,
    selection_revision: posted ? selectionRevision : null, selected: posted ? selected : null,
    revisions: posted ? [selected] : [], next_cursor: null });
  let reply = async (path: string, init: RequestInit | undefined): Promise<unknown> => {
    if (path.includes('/catalog-model-use')) {
      if (init?.method === 'POST') posted = true;
      return envelope(receipt());
    }
    return envelope(config());
  };
  let currentReceiptValue: ResearchCatalogModelUseReceipt | null = null;
  const request = vi.fn(async (path: string, init: RequestInit | undefined, _statuses: readonly number[]) =>
    path.endsWith('/catalog-model-use') && init?.method === 'GET' ? envelope(currentReceiptValue) : reply(path, init));
  const epoch = createSessionEpoch(), errors = (detail: ConstructorParameters<typeof WorkspaceRequestError>[0]) => new WorkspaceRequestError(detail);
  const http = { requestApiWithStatuses: request };
  const models = createResearchModelConfigurationApi(http, errors, epoch), api = createResearchCatalogModelUseApi(http, errors, epoch);
  const runs = createResearchRunsApi({ request, errors, epoch });
  const mint = vi.fn(() => operationId), writes = vi.fn((intent: ChatCatalogModelUseIntent) => { held = intent; });
  const invoke = (readOnly = false) => prepareCatalogChatModelSelection({ api, models, projectId, generation,
    modelChoice: model, providerOperationId: providerOperation, signal: controller.signal, isCurrent: () => current,
    mintOperationId: mint, readIntent: () => held, writeIntent: writes, readOnly });
  const controller = new AbortController();
  return { request, runs, epoch, writes, mint, invoke, controller, model, receipt, config, held: () => held,
    readDiscovered: () => readDiscoveredCatalogModelOperation({ api, models, projectId, generation, operationId,
      signal: controller.signal, isCurrent: () => current }),
    reply: (next: typeof reply) => { reply = next; }, markPosted: () => { posted = true; },
    currentReceipt: (next: ResearchCatalogModelUseReceipt | null) => { currentReceiptValue = next; },
    selection: (next: ResearchModelConfigurationRevision, rev = 4) => { selected = next; selectionRevision = rev; },
    loseAuthority: () => { current = false; epoch.close(); held = undefined; },
  };
}

describe('catalog choice preparation and exact V4 project pin', () => {
  it.each([false, true])('prepares only the chosen model with its global operation, then builds a project pin (builtin=%s)', async builtin => {
    const test = fixture(builtin);
    const pin = await test.invoke();
    const post = test.request.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe('/api/v1/research/projects/project-chat/catalog-model-use');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ protocol: 'eliotr.research.catalog-model-use-request.v1',
      operation_id: operationId, expected_selection_revision: null, provider_id: test.model.provider_id,
      model_id: test.model.model_id, provider_operation_id: builtin ? null : providerOperationId });
    expect(new Headers(post?.[1]?.headers).get('idempotency-key')).toBe(operationId);
    expect(test.request.mock.calls.some(([path, init]) => path.endsWith('/catalog-model-use/' + operationId) && init?.method === 'GET')).toBe(true);
    const body = JSON.parse(test.runs.researchRunBodyV4({ query: 'Compare selected sources', output_language: 'ru',
      scope_expression: { kind: 'PROJECT', project_id: projectId }, selection: pin }));
    expect(body.selection).toEqual({ configuration_project_id: projectId, configuration_ref: `rpmc-${digest}`,
      configuration_sha256: digest, selection_revision: 4 });
    expect(body.output_language).toBe('ru');
    expect(test.held()?.phase).toBe('selected');
    expect(test.mint).toHaveBeenCalledTimes(1);
    expect(test.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('pins an already selected exact qualified pair without another model-use operation', async () => {
    const test = fixture(); test.markPosted();
    expect((await test.invoke()).selection_revision).toBe(4);
    expect(test.mint).not.toHaveBeenCalled();
    expect(test.request.mock.calls.some(([path]) => path.includes('catalog-model-use'))).toBe(false);
  });

  it('retains a lost POST acknowledgement and reconciles the original ID without reposting or reminting', async () => {
    const test = fixture(); let reads = 0;
    test.reply(async (path, init) => {
      if (init?.method === 'POST') { test.markPosted(); throw new TypeError('lost model-use acknowledgement'); }
      if (path.includes('catalog-model-use') && ++reads === 1) throw new TypeError('read unavailable');
      return envelope(path.includes('catalog-model-use') ? test.receipt() : test.config());
    });
    await expect(test.invoke()).rejects.toBeInstanceOf(ChatCatalogModelUseUnconfirmedError);
    const request = test.held()?.request;
    expect(test.held()?.phase).toBe('unknown');
    expect((await test.invoke(true)).configuration_sha256).toBe(digest);
    expect(test.held()?.request).toEqual(request);
    expect(test.mint).toHaveBeenCalledTimes(1);
    expect(test.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('keeps an uncertain qualification held without a repeat provider call', async () => {
    const test = fixture();
    test.reply(async (path, init) => {
      if (init?.method === 'POST') test.markPosted();
      return envelope(path.includes('catalog-model-use') ? test.receipt({ state: 'uncertain', phase: 'qualification',
        selected_configuration_ref: null, selected_configuration_sha256: null, selection_revision: null,
        failure_code: 'QUALIFICATION_OUTCOME_UNCERTAIN' }) : test.config());
    });
    await expect(test.invoke()).rejects.toBeInstanceOf(ChatCatalogModelUseUnconfirmedError);
    await expect(test.invoke(true)).rejects.toBeInstanceOf(ChatCatalogModelUseUnconfirmedError);
    expect(test.held()?.phase).toBe('unknown');
    expect(test.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(test.mint).toHaveBeenCalledTimes(1);
  });

  it.each(['pair', 'digest', 'revision', 'qualification'])('rejects %s drift in the project readback without returning a run pin', async drift => {
    const test = fixture();
    const original = test.receipt();
    const candidate = revision('openrouter', drift === 'pair' ? 'other-model' : test.model.model_id);
    test.selection(drift === 'digest' ? { ...candidate, configuration_ref: `rpmc-${'e'.repeat(64)}`, configuration_sha256: 'e'.repeat(64) }
      : drift === 'qualification' ? { ...candidate, qualification_state: 'qualification_required' } : candidate, drift === 'revision' ? 5 : 4);
    test.reply(async (path, init) => { if (init?.method === 'POST') test.markPosted(); return envelope(path.includes('catalog-model-use') ? original : test.config()); });
    await expect(test.invoke()).rejects.toBeInstanceOf(ChatCatalogModelUseUnconfirmedError);
    expect(test.held()?.phase).toBe('unknown');
    expect(test.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('shows native V2 adapter unavailability honestly when the server refuses before saving an operation', async () => {
    const test = fixture();
    test.reply(async (path, init) => {
      if (!path.includes('catalog-model-use')) return envelope(test.config());
      throw new WorkspaceRequestError({ status: init?.method === 'POST' ? 409 : 404,
        code: init?.method === 'POST' ? 'RESEARCH_CATALOG_MODEL_USE_MODEL_UNSUPPORTED' : 'RESEARCH_CATALOG_MODEL_USE_NOT_FOUND',
        message: 'Unavailable', traceId: null, retryable: false });
    });
    await expect(test.invoke()).rejects.toMatchObject({ problem: 'unsupported' });
    expect(test.held()).toMatchObject({ phase: 'blocked', problem: 'unsupported' });
    await expect(test.invoke()).rejects.toBeInstanceOf(ChatCatalogModelUseUnavailableError);
    expect(test.mint).toHaveBeenCalledTimes(1);
  });

  it.each(['operation', 'provider-operation', 'model'])('rejects a receipt with a foreign %s identity', async foreign => {
    const test = fixture();
    test.reply(async (path, init) => {
      if (init?.method === 'POST') test.markPosted();
      return envelope(path.includes('catalog-model-use') ? test.receipt({
        ...(foreign === 'operation' ? { operation_id: '33333333-3333-4333-8333-333333333333' } : {}),
        ...(foreign === 'provider-operation' ? { provider_operation_id: '33333333-3333-4333-8333-333333333333' } : {}),
        ...(foreign === 'model' ? { model_id: 'foreign-model' } : {}),
      }) : test.config());
    });
    await expect(test.invoke()).rejects.toBeInstanceOf(ChatCatalogModelUseUnconfirmedError);
    expect(test.held()?.phase).toBe('unknown');
  });

  it('cannot start an operation from a read-only check', async () => {
    const test = fixture();
    await expect(test.invoke(true)).rejects.toBeInstanceOf(ChatCatalogModelUseUnconfirmedError);
    expect(test.request).not.toHaveBeenCalled(); expect(test.mint).not.toHaveBeenCalled();
  });

  it.each(['abort', 'authority'])('discards late model-use responses after %s loss', async loss => {
    const test = fixture(); let finish: (() => void) | undefined;
    test.reply(async (path, init) => {
      if (init?.method === 'POST') { test.markPosted(); await new Promise<void>(resolve => { finish = resolve; }); }
      return envelope(path.includes('catalog-model-use') ? test.receipt() : test.config());
    });
    const pending = test.invoke();
    await vi.waitFor(() => expect(finish).toBeDefined());
    const writes = test.writes.mock.calls.length;
    if (loss === 'abort') test.controller.abort(); else test.loseAuthority();
    finish?.();
    await expect(pending).rejects.toBeInstanceOf(ChatModelSelectionClosedError);
    expect(test.writes).toHaveBeenCalledTimes(writes);
    expect(test.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    if (loss === 'authority') expect(test.held()).toBeUndefined();
  });
});

describe('GET-only catalog operation recovery after browser memory loss', () => {
  it('discovers an existing operation before minting or posting a new selection', async () => {
    const test = fixture();
    test.currentReceipt(test.receipt({ state: 'qualifying', phase: 'qualification', selected_configuration_ref: null,
      selected_configuration_sha256: null, selection_revision: null }));
    await expect(test.invoke()).rejects.toBeInstanceOf(ChatCatalogModelUseDiscoveredError);
    expect(test.mint).not.toHaveBeenCalled();
    expect(test.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('discovers the original server operation after an UNRESOLVED race without a duplicate POST', async () => {
    const test = fixture();
    const active = test.receipt({ operation_id: '33333333-3333-4333-8333-333333333333', state: 'qualifying', phase: 'qualification',
      selected_configuration_ref: null, selected_configuration_sha256: null, selection_revision: null });
    test.reply(async (path, init) => {
      if (init?.method === 'POST') {
        test.currentReceipt(active);
        throw new WorkspaceRequestError({ code: 'RESEARCH_CATALOG_MODEL_USE_UNRESOLVED', status: 409, message: 'Reconcile existing operation', traceId: null, retryable: false });
      }
      return envelope(path.includes('catalog-model-use') ? test.receipt() : test.config());
    });
    await expect(test.invoke()).rejects.toMatchObject({ receipt: { operation_id: active.operation_id } });
    expect(test.held()?.request.operation_id).toBe(operationId);
    expect(test.held()?.phase).toBe('conflict');
    expect(test.mint).toHaveBeenCalledTimes(1);
    expect(test.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
  it('uses the server operation ID and verifies the selected pair/digest/revision without inventing or sending a request', async () => {
    const test = fixture(); test.markPosted();
    const result = await test.readDiscovered();
    expect(result.receipt.operation_id).toBe(operationId);
    expect(result.selection).toEqual({ configuration_project_id: projectId, configuration_ref: `rpmc-${digest}`,
      configuration_sha256: digest, selection_revision: 4 });
    expect(test.request.mock.calls[0]?.[0]).toBe('/api/v1/research/projects/project-chat/catalog-model-use/' + operationId);
    expect(test.request.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
    expect(test.held()).toBeUndefined(); expect(test.mint).not.toHaveBeenCalled(); expect(test.writes).not.toHaveBeenCalled();
  });

  it.each(['qualifying', 'uncertain', 'blocked', 'conflict'] as const)('retains server state %s without claiming a run pin or posting', async state => {
    const test = fixture();
    test.reply(async () => envelope(test.receipt({ state, phase: 'qualification', selected_configuration_ref: null,
      selected_configuration_sha256: null, selection_revision: null,
      failure_code: state === 'qualifying' ? null : state === 'uncertain' ? 'QUALIFICATION_OUTCOME_UNCERTAIN'
        : state === 'conflict' ? 'SELECTION_CAS_CONFLICT' : 'MODEL_NOT_SUPPORTED' })));
    expect(await test.readDiscovered()).toMatchObject({ receipt: { state }, selection: null });
    expect(test.request).toHaveBeenCalledTimes(1);
    expect(test.request.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(test.mint).not.toHaveBeenCalled(); expect(test.writes).not.toHaveBeenCalled();
  });

  it('rejects a foreign operation returned to the requested operation GET', async () => {
    const test = fixture();
    test.reply(async () => envelope(test.receipt({ operation_id: '33333333-3333-4333-8333-333333333333' })));
    await expect(test.readDiscovered()).rejects.toBeInstanceOf(ChatCatalogModelUseUnconfirmedError);
    expect(test.request).toHaveBeenCalledTimes(1);
  });

  it('rejects a selection changed since the server receipt', async () => {
    const test = fixture(); test.markPosted(); test.selection(revision('openrouter', test.model.model_id), 5);
    await expect(test.readDiscovered()).rejects.toBeInstanceOf(ChatCatalogModelUseUnconfirmedError);
    expect(test.request.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });
});
