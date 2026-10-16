import { useEffect, useState, useSyncExternalStore } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { ResearchCatalogModelUseReceipt, ResearchModelConfigurationRevision, ServiceModelCatalogPage } from '@eliotr/owner-api-client';
import { ResearchPanel } from './ResearchPanel';
import { createWorkspaceRuntime } from './runtime';
import { createPrivacyController } from './privacy';
import { createWorkspaceQueryClient, clearWorkspaceQueries, protectedQueryKey } from '../query/client';
import { modelCatalogEntryKey } from '../query/modelCatalog';
import { announcementUntil, paneAnnouncement } from './announcementAssertions';

const stamp = '2026-10-16T12:00:00.000Z', generation = 'catalog-preview';
const providerOperationId = '11111111-1111-4111-8111-111111111111';
const existingOperationId = '22222222-2222-4222-8222-222222222222';
const model = { provider_id: 'opencode-go', model_id: 'step-5-preview-free' };
const selected: ResearchModelConfigurationRevision = { configuration_ref: `rpmc-${'a'.repeat(64)}`, configuration_sha256: 'a'.repeat(64),
  created_at: stamp, qualification_state: 'qualified', semantic_revision: { revision_ref: 'semantic-1', config_sha256: 'b'.repeat(64) },
  model_selections: [{ candidate_kind: 'provider-native-v2', stage: 'SYNTHESIZE', route_ref: 'route/research', route_version: 'v1',
    candidate_ref: 'candidate-1', candidate_sha256: 'c'.repeat(64), qualification_ref: 'qualification-1', qualification_sha256: 'd'.repeat(64),
    ...model, effective_reasoning_effort: null, transport_policy: { version: 1, transport: 'cloudflare-ai-gateway',
      api: 'custom-chat-completions', provider: 'custom-opencode-go', model: model.model_id, billing: { mode: 'byok', alias: 'saved-go' },
      capabilities: { max_output_tokens_field: 'max_tokens', reasoning_efforts: [] } } }],
};
interface Probe {
  readonly baseReads: () => number; readonly statusReads: () => number; readonly posts: () => number; readonly errors: () => string;
  readonly finishQualification: () => void; readonly assertNoResearch: () => void;
}
let probe: Probe | undefined;

function CatalogOperationPreview({ existing, holdQualification = false, locale = 'en' }: {
  readonly existing: boolean; readonly holdQualification?: boolean; readonly locale?: 'en' | 'ru';
}) {
  const [environment] = useState(() => {
    const client = createWorkspaceQueryClient(), timers = { setTimeout: () => 0, clearTimeout() {} };
    let baseReads = 0, statusReads = 0, posts = 0, researchPosts = 0, completed = false, operationId = existingOperationId;
    let finishQualification = () => {};
    const qualification = new Promise<void>(resolve => { finishQualification = resolve; });
    const json = (data: unknown) => new Response(JSON.stringify({ data, trace_id: 'catalog-preview-trace', deployment_generation: generation }),
      { headers: { 'content-type': 'application/json' } });
    const receipt = (): ResearchCatalogModelUseReceipt => ({ protocol: 'eliotr.research.catalog-model-use-receipt.v1', project_id: 'project-chat',
      operation_id: operationId, provider_operation_id: providerOperationId, ...model, state: completed ? 'selected' : 'qualifying',
      phase: completed ? 'complete' : 'qualification', selected_configuration_ref: completed ? selected.configuration_ref : null,
      selected_configuration_sha256: completed ? selected.configuration_sha256 : null, selection_revision: completed ? 4 : null,
      failure_code: null, created_at: stamp, updated_at: stamp });
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input), 'https://fixture.invalid');
      if (url.pathname === '/api/v1/research/run' && init?.method === 'POST') researchPosts++;
      if (url.pathname === '/api/v1/system/health') return json({ ready: true, deployment_generation: generation,
        core_schema_generation: 'schema-1', search_schema_generation: 'schema-1', blocking_reason_codes: [], checked_at: stamp });
      if (url.pathname === '/api/v1/system/session') return json({ protocol: 'eliotr.owner-session.v1', principal_ref: 'owner-1',
        credential_generation: 'credential-1', client_class: 'owner_pwa', expires_at: '2027-01-01T00:00:00.000Z' });
      if (url.pathname === '/api/v1/system/model-settings') return json({ protocol: 'eliotr.service-model-settings.v1',
        cloudflare: { provider_id: 'cloudflare-workers-ai', connection: 'builtin', binding_available: true, default_model_id: '@cf/zai-org/glm-5.3-flash' },
        indexing: { provider_id: 'cloudflare-ai-search', managed: true }, external: { management_available: true, state: 'ready', connections: [], truncated: false } });
      if (url.pathname === '/api/v2/system/model-providers') return json({ protocol: 'eliotr.service-model-provider-read.v2', truncated: false,
        connections: [{ provider_id: model.provider_id, operation_id: providerOperationId, display_name: 'OpenCode Go', base_url: null,
          model_registration_mode: 'explicit_allowlist', model_ids: ['legacy-muse'], status: 'configured', provider_config_id: 'provider-1',
          alias: 'saved-go', failure_code: null, provider_http_status: null, created_at: stamp, updated_at: stamp }] });
      if (url.pathname === '/api/v2/system/model-provider-catalog-preferences') return json({ protocol: 'eliotr.service-model-provider-catalog-preferences.v1',
        provider_id: url.searchParams.get('provider_id'), visibility: { mode: 'all' }, search: '', updated_at: null });
      if (url.pathname === '/api/v1/system/research-models') {
        const provider = url.searchParams.get('provider_id') ?? '';
        const catalog: ServiceModelCatalogPage = { protocol: 'eliotr.service-model-catalog.v1', task: 'text-generation',
          catalog_scope: provider === 'cloudflare-workers-ai' ? 'workers_ai' : 'external_provider', provider_id: provider,
          models: provider === model.provider_id ? [{ ...model, name: 'Step 5 Preview Free', description: 'A discovered catalog model.',
            catalog_availability: 'listed', account_availability: 'unknown', capabilities: { text_generation: 'supported',
              input_output_schema: 'available_from_transport', schema_requirement: null }, source_id: null, source_task: null,
            billing: { selected_path: 'provider_catalog', support: 'unknown', account_entitlement: 'not_established_by_catalog' }, properties: [], tags: [] }] : [],
          pagination: { page: 1, per_page: 20, has_more: false, next_page: null, coverage: 'complete',
            probe: provider === 'cloudflare-workers-ai' ? 'next_page_empty' : 'provider_reported' } };
        return json(catalog);
      }
      if (url.pathname === '/api/v1/system/research-configuration') return json({ protocol: 'eliotr.research-configuration-readiness.v1',
        configuration: 'present', model_transport: 'available', qualification_state: 'current', run_readiness: 'ready',
        readiness_reason: 'QUALIFICATION_PROOFS_CURRENT', model_route: 'route/research', qualification_expires_at: '2027-01-01T00:00:00.000Z',
        missing_fields: [], invalid_fields: [], checked_at: stamp });
      if (url.pathname === '/api/v1/research/runs') return json({ protocol: 'eliotr.research-runs.v5', runs: [], saved_drafts: [],
        visibility_scan: { runs: 'SOURCE_EXHAUSTED', saved_drafts: 'SOURCE_EXHAUSTED' }, configuration_state: 'INSTALLED', checked_at: stamp });
      if (url.pathname === '/api/v1/research/projects/project-chat/model-configuration') return json({ protocol: 'eliotr.research-project-model-configuration.v1',
        project_id: 'project-chat', selection_revision: completed ? 4 : null, selected: completed ? selected : null,
        revisions: completed ? [selected] : [], next_cursor: null });
      const base = '/api/v1/research/projects/project-chat/catalog-model-use';
      if (url.pathname === base && init?.method === 'GET') { baseReads++; return json(existing && !completed ? receipt() : null); }
      if (url.pathname === base && init?.method === 'POST') {
        posts++;
        const body: unknown = JSON.parse(String(init.body));
        if (existing || posts !== 1 || !body || typeof body !== 'object' || !('operation_id' in body) || typeof body.operation_id !== 'string' ||
            !('provider_operation_id' in body) || body.provider_operation_id !== providerOperationId || !('provider_id' in body) ||
            body.provider_id !== model.provider_id || !('model_id' in body) || body.model_id !== model.model_id ||
            !('expected_selection_revision' in body) || body.expected_selection_revision !== null) throw new Error('Catalog preparation replaced the held operation or global connection');
        operationId = body.operation_id;
        if (holdQualification) await qualification;
        completed = true; return json(receipt());
      }
      if (url.pathname === base + '/' + operationId && init?.method === 'GET') {
        statusReads++;
        if (existing && statusReads > 1) completed = true;
        return json(receipt());
      }
      throw new Error('Unexpected catalog fixture request: ' + url.pathname);
    };
    const runtime = createWorkspaceRuntime({ fetch: fetcher, baseUrl: 'https://fixture.invalid', timers, now: () => Date.parse(stamp),
      mint: () => { throw new Error('Model recovery must not mint a research run'); }, sha256: async () => 'e'.repeat(64),
      isCurrent: context => privacy.isCurrent(context), onAuthorizationLoss() { privacy.close(); } });
    const privacy = createPrivacyController({ now: () => Date.parse(stamp), timers, mask() { runtime.close(); }, reveal() {},
      cancelReads() { void client.cancelQueries(); }, clearProtected() { clearWorkspaceQueries(client); }, verify: signal => runtime.verify(signal) });
    probe = { baseReads: () => baseReads, statusReads: () => statusReads, posts: () => posts, finishQualification,
      assertNoResearch() {
        const snapshot = privacy.getSnapshot();
        if (snapshot.phase !== 'available') throw new Error('Catalog fixture context is unavailable');
        const memory = client.getQueryData<{ intent?: unknown; observedLaunch?: unknown }>([
          ...protectedQueryKey(snapshot.context, 'research'), 'local-intent', 'project-chat',
        ]);
        if (researchPosts !== 0 || memory?.intent !== undefined || memory?.observedLaunch !== undefined)
          throw new Error('Model availability checking allocated research');
      },
      errors: () => client.getQueryCache().getAll().filter(query => query.state.error).map(query =>
        JSON.stringify(query.queryKey) + ': ' + String(query.state.error)).join('\n') };
    return { client, runtime, privacy };
  });
  const snapshot = useSyncExternalStore(environment.privacy.subscribe, environment.privacy.getSnapshot);
  useEffect(() => {
    const unsubscribe = environment.privacy.subscribe(() => { const next = environment.privacy.getSnapshot(); if (next.phase === 'available') environment.runtime.bind(next.context); });
    void environment.privacy.refresh();
    return () => { unsubscribe(); environment.privacy.dispose(); environment.runtime.dispose(); environment.client.clear(); };
  }, [environment]);
  const apis = snapshot.phase === 'available' ? environment.runtime.read(snapshot.context) : undefined;
  return <QueryClientProvider client={environment.client}><MemoryRouter><section aria-label="Research recovery fixture">
    {snapshot.phase === 'available' && apis && <ResearchPanel apis={apis} privacy={environment.privacy} context={snapshot.context}
      locale={locale} scope={[]} scopeCurrent isScopeCurrent={() => true} projectId="project-chat" isProjectCurrent={() => true} />}
  </section></MemoryRouter></QueryClientProvider>;
}

export interface CatalogModelOperationPlay {
  readonly canvas: { findByRole(role: string, options: { name: string }): Promise<HTMLElement>;
    findByText(text: string, options?: { selector: string }): Promise<HTMLElement> };
  readonly canvasElement: HTMLElement;
  readonly userEvent: { click(element: HTMLElement): Promise<void>; selectOptions(element: HTMLElement, value: string): Promise<void>;
    type(element: HTMLElement, text: string): Promise<void> };
}

function availabilityCheckingStory(locale: 'en' | 'ru') {
  const ru = locale === 'ru';
  return {
    render: () => <CatalogOperationPreview existing={false} holdQualification locale={locale} />,
    play: async ({ canvas, canvasElement, userEvent }: CatalogModelOperationPlay) => {
      const picker = await canvas.findByRole('combobox', { name: ru ? 'Модель чата' : 'Chat model' }) as HTMLSelectElement;
      await announcementUntil(() => !picker.disabled && Array.from(picker.options).some(option => option.value === modelCatalogEntryKey(model)),
        () => probe?.errors() ?? '');
      const draft = await canvas.findByRole('textbox', { name: ru ? 'Вопрос исследования' : 'Research question' }) as HTMLTextAreaElement;
      const question = ru ? 'Сравни источники.' : 'Compare the sources.';
      await userEvent.type(draft, question);
      const pane = canvasElement.querySelector('section[aria-label="Research recovery fixture"]');
      if (!(pane instanceof HTMLElement) || !probe) throw new Error('Missing model availability fixture');
      const channel = paneAnnouncement(pane), currentProbe = probe;
      await userEvent.selectOptions(picker, modelCatalogEntryKey(model));
      try {
        await announcementUntil(() => currentProbe.posts() === 1 && channel.textContent ===
          (ru ? 'Проверяем доступность моделей…' : 'Checking model availability…'));
        await canvas.findByText(ru ? 'Проверяем доступность модели…' : 'Checking model availability…', { selector: '.er-status > span' });
        const ask = await canvas.findByRole('button', { name: ru ? 'Спросить' : 'Ask' }) as HTMLButtonElement;
        if (!picker.disabled || !ask.disabled || draft.value !== question) throw new Error('Availability checking lost its lock or question draft');
        if (pane.querySelector('.er-research-run')?.getAttribute('data-phase') !== 'start' ||
            pane.querySelector('.er-research-run__heading')?.textContent !== (ru ? 'Спросите свои источники' : 'Ask your sources') ||
            pane.querySelector('.er-research-run__turn') !== null ||
            !pane.querySelector(`section[aria-label="${ru ? 'Предлагаемые вопросы' : 'Suggested questions'}"]`))
          throw new Error('Availability checking replaced the start view with research progress');
        if (paneAnnouncement(pane) !== channel) throw new Error('Model checking replaced the announcement channel');
        currentProbe.assertNoResearch();
        // A locked Ask cannot submit even though a nonempty question draft is present.
        await userEvent.click(ask);
        currentProbe.assertNoResearch();
      } finally { currentProbe.finishQualification(); }
      await canvas.findByText(ru ? 'Доступность модели подтверждена для запуска.' : 'Model availability confirmed for this run.',
        { selector: '.er-status > span' });
      const ask = await canvas.findByRole('button', { name: ru ? 'Спросить' : 'Ask' }) as HTMLButtonElement;
      await announcementUntil(() => !picker.disabled && !ask.disabled);
      currentProbe.assertNoResearch();
      if (currentProbe.posts() !== 1 || picker.value !== modelCatalogEntryKey(model) || draft.value !== question)
        throw new Error('Qualification repeated or replaced the chosen model or question draft');
    },
  };
}
export const CatalogModelAvailabilityChecking = availabilityCheckingStory('en');
export const CatalogModelAvailabilityCheckingRussian = availabilityCheckingStory('ru');
export const CatalogModelOperationReloadRecovery = {
  render: () => <CatalogOperationPreview existing />,
  play: async ({ canvas, canvasElement, userEvent }: CatalogModelOperationPlay) => {
    const picker = await canvas.findByRole('combobox', { name: 'Chat model' }) as HTMLSelectElement;
    await announcementUntil(() => picker.disabled && picker.value === modelCatalogEntryKey(model) && (probe?.statusReads() ?? 0) >= 1);
    if (probe?.errors()) throw new Error(probe.errors());
    const pane = canvasElement.querySelector('section[aria-label="Research recovery fixture"]');
    if (!(pane instanceof HTMLElement)) throw new Error('Missing research fixture pane');
    paneAnnouncement(pane);
    await userEvent.click(await canvas.findByRole('button', { name: 'Check availability' }));
    await canvas.findByText('Model availability confirmed for this run.', { selector: '.er-status > span' });
    await announcementUntil(() => !picker.disabled);
    if (probe?.posts() !== 0 || probe.baseReads() < 2 || probe.statusReads() < 2) throw new Error('Reload recovery did not stay GET-only on the original operation');
  },
};
export const CatalogModelOperationNullAllowsLegacyChoice = {
  render: () => <CatalogOperationPreview existing={false} />,
  play: async ({ canvas, userEvent }: CatalogModelOperationPlay) => {
    const picker = await canvas.findByRole('combobox', { name: 'Chat model' }) as HTMLSelectElement;
    await announcementUntil(() => !picker.disabled && Array.from(picker.options).some(option => option.value === modelCatalogEntryKey(model)), () => probe?.errors() ?? '');
    await userEvent.selectOptions(picker, modelCatalogEntryKey(model));
    await canvas.findByText('Model availability confirmed for this run.', { selector: '.er-status > span' });
    if (probe?.posts() !== 1 || probe.baseReads() < 2) throw new Error('A null discovery did not admit exactly one explicit legacy-connection catalog choice');
  },
};
