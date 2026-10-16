import { useEffect, useState, useSyncExternalStore } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { ProviderModelCatalogSettings } from './ProviderModelCatalogSettings';
import { createWorkspaceRuntime } from './runtime';
import { createPrivacyController } from './privacy';
import { createWorkspaceQueryClient, clearWorkspaceQueries } from '../query/client';
import { serviceModelCatalogPreferencesQueryOptions } from '../query/globalModelSettings';
import { announcementUntil } from './announcementAssertions';

const stamp = '2026-10-16T12:00:00.000Z', generation = 'preference-race-fixture';
const original = { protocol: 'eliotr.service-model-provider-catalog-preferences.v1', provider_id: 'opencode-go',
  visibility: { mode: 'include', model_ids: ['muse-spark-1.3'] }, search: 'muse-spark-1.3', updated_at: stamp } as const;
let probe: { reads: () => number; writes: () => number; stored: () => unknown } | undefined;

function ProviderCatalogPreferencesPreview() {
  const [environment] = useState(() => {
    const client = createWorkspaceQueryClient(), timers = { setTimeout: () => 0, clearTimeout() {} };
    let reads = 0, writes = 0, stored: unknown = original, finishOldRead: (() => void) | undefined;
    const json = (data: unknown) => new Response(JSON.stringify({ data, trace_id: 'preferences-trace', deployment_generation: generation }),
      { headers: { 'content-type': 'application/json' } });
    const runtime = createWorkspaceRuntime({ baseUrl: 'https://fixture.invalid', timers, now: () => Date.parse(stamp),
      mint: () => { throw new Error('A filter save cannot mint an operation'); }, sha256: async () => 'a'.repeat(64),
      isCurrent: context => privacy.isCurrent(context), onAuthorizationLoss() { privacy.close(); },
      fetch: async (input, init) => {
        const url = new URL(String(input), 'https://fixture.invalid');
        if (url.pathname === '/api/v2/system/model-provider-catalog-preferences' && init?.method === 'GET' && url.searchParams.get('provider_id') === 'opencode-go') {
          reads++;
          if (reads === 2) return new Promise<Response>(resolve => { finishOldRead = () => resolve(json(original)); });
          return json(original);
        }
        if (url.pathname === '/api/v2/system/model-provider-catalog-preferences' && init?.method === 'PUT' && !url.search) {
          writes++;
          const body: unknown = JSON.parse(String(init.body));
          if (!body || typeof body !== 'object' || !('provider_id' in body) || body.provider_id !== 'opencode-go' ||
              !('search' in body) || body.search !== '' || !('visibility' in body) || !body.visibility ||
              typeof body.visibility !== 'object' || !('mode' in body.visibility) || body.visibility.mode !== 'all') {
            throw new Error('Filter save did not freeze Show all and empty search');
          }
          stored = { ...body, updated_at: '2026-10-16T12:00:01.000Z' };
          return json(stored);
        }
        if (url.pathname === '/api/v1/system/research-models' && init?.method === 'GET' && url.searchParams.get('provider_id') === 'opencode-go') {
          return json({ protocol: 'eliotr.service-model-catalog.v1', task: 'text-generation', catalog_scope: 'external_provider', provider_id: 'opencode-go',
            models: [{ provider_id: 'opencode-go', model_id: 'muse-spark-1.3', name: 'Muse Spark', description: 'Catalog model',
              catalog_availability: 'listed', account_availability: 'unknown', source_id: null, source_task: null,
              capabilities: { text_generation: 'supported', input_output_schema: 'available_from_transport', schema_requirement: null },
              billing: { selected_path: 'provider_catalog', support: 'unknown', account_entitlement: 'not_established_by_catalog' }, properties: [], tags: [] }],
            pagination: { page: 1, per_page: 20, has_more: false, next_page: null, coverage: 'complete', probe: 'provider_reported' } });
        }
        throw new Error('Unexpected filter fixture request: ' + url.pathname);
      },
    });
    const privacy = createPrivacyController({ now: () => Date.parse(stamp), timers, mask() { runtime.close(); }, reveal() {},
      cancelReads() { void client.cancelQueries(); }, clearProtected() { clearWorkspaceQueries(client); },
      verify: async () => ({ principal: 'owner-1', credentialGeneration: 'credential-1', deploymentGeneration: generation, expiresAt: '2027-01-01T00:00:00.000Z' }) });
    probe = { reads: () => reads, writes: () => writes, stored: () => stored };
    return { client, runtime, privacy, release: () => finishOldRead?.() };
  });
  const snapshot = useSyncExternalStore(environment.privacy.subscribe, environment.privacy.getSnapshot);
  useEffect(() => {
    const unsubscribe = environment.privacy.subscribe(() => { const next = environment.privacy.getSnapshot(); if (next.phase === 'available') environment.runtime.bind(next.context); });
    void environment.privacy.refresh();
    return () => { unsubscribe(); environment.privacy.dispose(); environment.runtime.dispose(); environment.client.clear(); };
  }, [environment]);
  const apis = snapshot.phase === 'available' ? environment.runtime.read(snapshot.context) : undefined;
  return <QueryClientProvider client={environment.client}>
    {snapshot.phase === 'available' && apis && <>
      <ProviderModelCatalogSettings locale="en" apis={apis} privacy={environment.privacy} context={snapshot.context} providerId="opencode-go" />
      <button type="button" onClick={() => { void environment.client.fetchQuery(serviceModelCatalogPreferencesQueryOptions(apis.settings.models,
        environment.privacy, snapshot.context, 'opencode-go')).catch(() => {}); }}>Start stale filter read</button>
      <button type="button" onClick={environment.release}>Release stale filter read</button>
    </>}
  </QueryClientProvider>;
}

export interface ProviderCatalogPreferencesPlay {
  readonly canvas: { findByRole(role: string, options: { name: string }): Promise<HTMLElement>;
    findByText(text: string, options?: { selector: string }): Promise<HTMLElement> };
  readonly userEvent: { click(element: HTMLElement): Promise<void>; clear(element: HTMLElement): Promise<void> };
}
export const ProviderCatalogPreferencesSaveRace = {
  render: () => <ProviderCatalogPreferencesPreview />,
  play: async ({ canvas, userEvent }: ProviderCatalogPreferencesPlay) => {
    const search = await canvas.findByRole('searchbox', { name: 'Search model inventory' }) as HTMLInputElement;
    await userEvent.click(await canvas.findByRole('button', { name: 'Start stale filter read' }));
    await announcementUntil(() => probe?.reads() === 2);
    const showAll = await canvas.findByRole('button', { name: 'Show all models' }) as HTMLButtonElement;
    await userEvent.click(showAll); await userEvent.clear(search);
    const save = await canvas.findByRole('button', { name: 'Save filters' }) as HTMLButtonElement;
    await userEvent.click(save);
    await canvas.findByText('Model filters saved.', { selector: '.er-status > span' });
    await userEvent.click(await canvas.findByRole('button', { name: 'Release stale filter read' }));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (search.value !== '' || !showAll.disabled || !save.disabled || probe?.writes() !== 1 || probe.reads() !== 2) {
      throw new Error('A stale preference read replaced the saved all/empty filter');
    }
    const stored = probe.stored();
    if (!stored || typeof stored !== 'object' || !('search' in stored) || stored.search !== '' || !('visibility' in stored) ||
        JSON.stringify(stored.visibility) !== '{"mode":"all"}') throw new Error('The exact owner filter was not persisted once');
  },
};
