import { describe, expect, it, vi } from 'vitest';
import { createSessionEpoch } from '../transport/session/epoch';
import { createResearchCatalogModelUseApi } from './catalog-model-use';
import type { ResearchCatalogModelUseReceipt } from '@eliotr/contracts';

const operationId = '22222222-2222-4222-8222-222222222222';
const receipt: ResearchCatalogModelUseReceipt = { protocol: 'eliotr.research.catalog-model-use-receipt.v1', project_id: 'project-chat',
  operation_id: operationId, provider_id: 'opencode-go', model_id: 'step-5-preview-free',
  provider_operation_id: '11111111-1111-4111-8111-111111111111', state: 'uncertain', phase: 'qualification',
  selected_configuration_ref: null, selected_configuration_sha256: null, selection_revision: null,
  failure_code: 'QUALIFICATION_OUTCOME_UNCERTAIN', created_at: '2026-10-16T12:00:00.000Z', updated_at: '2026-10-16T12:00:01.000Z' };
const envelope = (data: unknown) => ({ data, trace_id: 'catalog-trace', deployment_generation: 'deploy-1' });
function fixture(raw: unknown) {
  const epoch = createSessionEpoch();
  const request = vi.fn(async (_path: string, _init: RequestInit | undefined, _statuses: readonly number[]) => raw);
  return { epoch, request, api: createResearchCatalogModelUseApi({ requestApiWithStatuses: request }, details => new Error(details.code), epoch) };
}

describe('current catalog model operation read contract', () => {
  it.each([receipt, null])('GETs the base route with a strict ReceiptV1|null envelope', async data => {
    const test = fixture(envelope(data)), signal = new AbortController().signal;
    expect(await test.api.readCurrentResearchCatalogModelUse('project-chat', 'deploy-1', signal)).toEqual(data);
    expect(test.request).toHaveBeenCalledExactlyOnceWith('/api/v1/research/projects/project-chat/catalog-model-use', { method: 'GET', signal }, [200]);
  });

  it.each([
    { trace_id: 'catalog-trace', deployment_generation: 'deploy-1' },
    { ...envelope(null), data: undefined },
    { ...envelope(null), trace_id: '' },
    { ...envelope(null), extra: true },
    envelope({ ...receipt, project_id: 'foreign-project' }),
  ])('fails closed on a malformed or foreign discovery response', async raw => {
    const test = fixture(raw);
    await expect(test.api.readCurrentResearchCatalogModelUse('project-chat', 'deploy-1')).rejects.toThrow('API_RESPONSE_SCHEMA_MISMATCH');
  });

  it('validates generation before accepting null and keeps GET-by-ID non-null', async () => {
    const test = fixture({ ...envelope(null), deployment_generation: 'foreign-generation' });
    await expect(test.api.readCurrentResearchCatalogModelUse('project-chat', 'deploy-1')).rejects.toThrow('API_GENERATION_MISMATCH');
    const byId = fixture(envelope(null));
    await expect(byId.api.readResearchCatalogModelUse('project-chat', 'deploy-1', operationId)).rejects.toThrow('API_RESPONSE_SCHEMA_MISMATCH');
  });

  it('rejects closed authority before dispatch and after a late response', async () => {
    const test = fixture(envelope(receipt));
    test.epoch.close();
    await expect(test.api.readCurrentResearchCatalogModelUse('project-chat', 'deploy-1')).rejects.toThrow('API_SESSION_CLOSED');
    expect(test.request).not.toHaveBeenCalled();
    const late = fixture(envelope(receipt)); let finish: ((value: unknown) => void) | undefined;
    late.request.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = late.api.readCurrentResearchCatalogModelUse('project-chat', 'deploy-1');
    late.epoch.close(); finish?.(envelope(receipt));
    await expect(pending).rejects.toThrow('API_SESSION_CLOSED');
    expect(late.request).toHaveBeenCalledTimes(1);
  });
});

it('gives the explicit catalog qualification POST the existing ten-minute operation window', async () => {
  const test = fixture(envelope(receipt));
  const signal = new AbortController().signal;
  const request = { protocol: 'eliotr.research.catalog-model-use-request.v1' as const,
    operation_id: operationId, expected_selection_revision: null, provider_id: 'opencode-go',
    model_id: 'step-5-preview-free', provider_operation_id: receipt.provider_operation_id };
  await test.api.startResearchCatalogModelUse('project-chat', 'deploy-1', request, signal);
  expect(test.request).toHaveBeenCalledExactlyOnceWith('/api/v1/research/projects/project-chat/catalog-model-use', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': operationId,
      'x-eliotr-csrf': '1' }, body: JSON.stringify(request), signal,
  }, [200, 202], 600_000);
});
