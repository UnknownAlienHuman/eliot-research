import { describe, expect, it, vi } from 'vitest';
import type { ResearchCatalogModelUseReceipt } from '@eliotr/owner-api-client';
import { createPrivacyController } from '../app/privacy';
import { chatCatalogModelOperationQueryOptions, chatCurrentCatalogModelOperationQueryOptions } from './chatModelQueries';
import { protectedQueryKey } from './client';

const operationId = '22222222-2222-4222-8222-222222222222';
const receipt: ResearchCatalogModelUseReceipt = {
  protocol: 'eliotr.research.catalog-model-use-receipt.v1', project_id: 'project-chat', operation_id: operationId,
  provider_id: 'openrouter', model_id: 'stealth/model-a', provider_operation_id: '11111111-1111-4111-8111-111111111111',
  state: 'qualifying', phase: 'qualification', selected_configuration_ref: null, selected_configuration_sha256: null,
  selection_revision: null, failure_code: null, created_at: '2026-10-16T12:00:00.000Z', updated_at: '2026-10-16T12:00:01.000Z',
};

async function fixture() {
  const privacy = createPrivacyController({ mask() {}, reveal() {}, cancelReads() {}, clearProtected() {},
    now: () => Date.parse('2026-10-16T12:00:00.000Z'), timers: { setTimeout: () => 0, clearTimeout() {} },
    verify: async () => ({ principal: 'owner-1', credentialGeneration: 'credential-1', deploymentGeneration: 'deployment-1',
      expiresAt: '2027-01-01T00:00:00.000Z' }) });
  await privacy.refresh();
  const snapshot = privacy.getSnapshot();
  if (snapshot.phase !== 'available') throw new Error('Query fixture authority unavailable');
  const api = { readResearchCatalogModelUse: vi.fn().mockResolvedValue(receipt),
    readCurrentResearchCatalogModelUse: vi.fn().mockResolvedValue(null) };
  const models = { readResearchProjectModelConfiguration: vi.fn() };
  let projectCurrent = true;
  const options = (id: string | undefined = operationId) => chatCatalogModelOperationQueryOptions(api, models,
    privacy, snapshot.context, 'project-chat', () => projectCurrent, id);
  const read = (query = options(), signal = new AbortController().signal) => {
    if (typeof query.queryFn !== 'function') throw new Error('Operation read function unavailable');
    return query.queryFn({ signal } as never);
  };
  return { privacy, context: snapshot.context, api, models, options, read, loseProject: () => { projectCurrent = false; } };
}

describe('server-identified catalog operation protected query', () => {
  it.each([null, receipt])('mounts fresh base discovery and preserves ReceiptV1|null without a POST capability', async active => {
    const test = await fixture(), signal = new AbortController().signal;
    test.api.readCurrentResearchCatalogModelUse.mockResolvedValue(active);
    const query = chatCurrentCatalogModelOperationQueryOptions(test.api, test.privacy, test.context, 'project-chat', () => true);
    if (typeof query.queryFn !== 'function') throw new Error('Current discovery read unavailable');
    expect(await query.queryFn({ signal } as never)).toEqual(active);
    expect(query.refetchOnMount).toBe('always'); expect(query.retry).toBe(false);
    expect(test.api.readCurrentResearchCatalogModelUse).toHaveBeenCalledExactlyOnceWith('project-chat', 'deployment-1', signal);
    expect(test.api.readResearchCatalogModelUse).not.toHaveBeenCalled();
    test.privacy.dispose();
  });
  it('keys and reads the exact project/operation with the protected epoch and supplied signal', async () => {
    const test = await fixture(), signal = new AbortController().signal, options = test.options();
    expect(options.queryKey).toEqual([...protectedQueryKey(test.context, 'connections'), 'chat-catalog-operation', 'project-chat', operationId]);
    expect(options.enabled).toBe(true); expect(options.retry).toBe(false);
    expect(await test.read(options, signal)).toEqual({ receipt, selection: null });
    expect(test.api.readResearchCatalogModelUse).toHaveBeenCalledExactlyOnceWith('project-chat', 'deployment-1', operationId, signal);
    expect(test.models.readResearchProjectModelConfiguration).not.toHaveBeenCalled();
    test.privacy.dispose();
  });

  it('does not issue a request when the server has supplied no operation ID', async () => {
    const test = await fixture();
    const query = chatCatalogModelOperationQueryOptions(test.api, test.models, test.privacy, test.context,
      'project-chat', () => true, undefined);
    expect(query.enabled).toBe(false);
    await expect(async () => test.read(query)).rejects.toThrow();
    expect(test.api.readResearchCatalogModelUse).not.toHaveBeenCalled();
    test.privacy.dispose();
  });

  it.each(['project', 'privacy', 'abort'])('rejects late results after %s currentness loss', async loss => {
    const test = await fixture(); let finish: ((value: ResearchCatalogModelUseReceipt) => void) | undefined;
    test.api.readResearchCatalogModelUse.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const controller = new AbortController(), pending = test.read(test.options(), controller.signal);
    await vi.waitFor(() => expect(finish).toBeDefined());
    if (loss === 'project') test.loseProject();
    else if (loss === 'privacy') test.privacy.close();
    else controller.abort();
    finish?.(receipt);
    await expect(pending).rejects.toThrow();
    expect(test.models.readResearchProjectModelConfiguration).not.toHaveBeenCalled();
    test.privacy.dispose();
  });
});
