// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useInfiniteQuery } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyClaims } from '../quotes';
import type { Understanding } from '../understanding';
import { SourceUnderstanding } from './Understanding';
import { ModelPicker, type ModelRoute } from './ModelPicker';
import { ModelSettings } from './ModelSettings';

afterEach(() => { vi.unstubAllGlobals(); });

type BadgeSource = { id: string; currentRevisionId: string | null; distillState: string; claimCount: number };
type SourcesPage = { sources: BadgeSource[]; nextCursor: string | null };
function SourcesRead({ projectId }: { projectId: string }) {
  useInfiniteQuery({
    queryKey: ['sources', projectId],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const response = await fetch('/api/projects/' + encodeURIComponent(projectId) + '/sources'
        + (pageParam ? '?cursor=' + encodeURIComponent(pageParam) : ''), { signal });
      return await response.json() as SourcesPage;
    },
    getNextPageParam: page => page.nextCursor ?? undefined,
    staleTime: Infinity,
  });
  return null;
}

describe('Source claim evidence presentation', () => {
  it('disambiguates provider origins and keeps an outside-filter selection separate without changing it', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div'); document.body.appendChild(host);
    const root = createRoot(host);
    const choices: ModelRoute[] = [
      { route: 'workers-ai:flash', id: 'flash', label: 'GLM Flash', enabled: true, selectable: true, contextTokens: 1024, maxOutputTokens: null, checkedOn: null },
      ...['openrouter', 'command-code'].map(provider => ({ route: 'gateway:' + provider + '/stealth/crouton-alpha', id: 'stealth/crouton-alpha',
        label: 'Crouton Alpha', enabled: false, selectable: true, unavailableReason: 'Connect AI Gateway in Settings.', contextTokens: null, maxOutputTokens: null, checkedOn: null })),
    ];
    let selected = 'workers-ai:flash';
    const blocked = vi.fn();
    const changed = vi.fn((route: string) => { selected = route; render(); });
    const render = () => root.render(<ModelPicker label='Answer model' choices={choices} value={selected} onChange={changed} onRoutePendingChange={blocked} />);
    const controls = () => {
      const provider = host.querySelector('select[aria-label="Answer model: provider"]');
      const model = host.querySelector('select[aria-label="Answer model"]');
      if (!(provider instanceof HTMLSelectElement) || !(model instanceof HTMLSelectElement)) throw new Error('The shared picker controls did not render.');
      return { provider, model };
    };
    try {
      await act(async () => render());
      const labels = Array.from(controls().model.options).filter(option => option.textContent?.includes('Crouton Alpha')).map(option => option.textContent);
      expect(labels).toEqual(['Crouton Alpha · OpenRouter — setup required', 'Crouton Alpha · Command Code — setup required']);
      await act(async () => { controls().provider.value = 'openrouter'; controls().provider.dispatchEvent(new Event('change', { bubbles: true })); });
      expect(changed).not.toHaveBeenCalled(); expect(selected).toBe('workers-ai:flash');
      expect(Array.from(controls().model.options).map(option => option.value)).toEqual(['', 'gateway:openrouter/stealth/crouton-alpha']);
      expect(host.textContent).toContain('Current selection: GLM Flash · Workers AI. Outside the current filter.');
      expect(controls().model.value).toBe('');
      await act(async () => { controls().model.value = 'gateway:openrouter/stealth/crouton-alpha'; controls().model.dispatchEvent(new Event('change', { bubbles: true })); });
      expect(changed).toHaveBeenLastCalledWith('gateway:openrouter/stealth/crouton-alpha');
      expect(blocked).toHaveBeenLastCalledWith(true); expect(host.textContent).toContain('Connect AI Gateway in Settings.');
      await act(async () => { controls().provider.value = 'command-code'; controls().provider.dispatchEvent(new Event('change', { bubbles: true })); });
      expect(controls().model.options).toHaveLength(2); expect(selected).toBe('gateway:openrouter/stealth/crouton-alpha');
      await act(async () => { controls().model.value = 'gateway:command-code/stealth/crouton-alpha'; controls().model.dispatchEvent(new Event('change', { bubbles: true })); });
      expect(changed.mock.calls.map(([route]) => route)).toEqual(['gateway:openrouter/stealth/crouton-alpha', 'gateway:command-code/stealth/crouton-alpha']);
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

  it.each(['answerModel', 'distillModel'] as const)('saves only changed %s while preserving the other missing default, without connecting credentials or starting a job', async field => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div'); document.body.appendChild(host);
    const root = createRoot(host), native = 'workers-ai:flash', external = 'gateway:openrouter/stealth/crouton-alpha';
    const choices: ModelRoute[] = [
      { route: native, id: 'flash', label: 'GLM Flash', enabled: true, selectable: true, contextTokens: 1024, maxOutputTokens: null, checkedOn: null },
      { route: external, id: 'stealth/crouton-alpha', label: 'Crouton Alpha', enabled: false, selectable: true,
        unavailableReason: 'Connect AI Gateway in Settings.', contextTokens: null, maxOutputTokens: null, checkedOn: null },
    ];
    const missing = 'gateway:removed/retired-model';
    let settings = { answerModel: field === 'answerModel' ? native : missing, distillModel: field === 'distillModel' ? native : missing, updatedAt: 0 };
    const writes: Array<{ path: string; method: string; body: unknown }> = [];
    const json = (value: unknown) => Response.json(value);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input), method = init?.method ?? 'GET';
      if (method !== 'GET') {
        writes.push({ path, method, body: JSON.parse(String(init?.body)) });
        if (path !== '/api/settings' || method !== 'PUT') throw new Error('Unexpected connection, refresh or job mutation.');
        settings = { ...settings, ...JSON.parse(String(init?.body)) }; return json({ settings });
      }
      if (path === '/api/settings') return json({ settings });
      if (path === '/api/models') return json({ models: choices, warnings: [], defaultModel: native });
      if (path === '/api/models/connection') return json({ connection: { gatewayId: null, provider: 'ai-gateway', alias: 'default' } });
      if (path === '/api/models/providers') return json({ providers: [
        { id: 'workers-ai', type: 'workers-ai', baseUrl: null, gatewaySlug: null, gatewayPath: '', enabled: true },
        { id: 'openrouter', type: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', gatewaySlug: 'openrouter', gatewayPath: 'v1', enabled: true, dataCollection: 'deny' },
      ] });
      throw new Error('Unexpected Settings read.');
    }));
    try {
      await act(async () => root.render(<ModelSettings />));
      expect(writes).toEqual([]); expect(host.querySelectorAll('.er-model-picker')).toHaveLength(1);
      expect(host.textContent).toContain('External requests are not connected.');
      expect(Array.from(host.querySelectorAll('button')).filter(button => button.textContent === 'AI Gateway connection')).toHaveLength(1);
      if (field === 'distillModel') {
        const target = host.querySelector('input[type="radio"][value="distill"]');
        if (!(target instanceof HTMLInputElement)) throw new Error('The shared catalogue target did not render.');
        await act(async () => target.click());
      }
      const picker = host.querySelector('select[aria-label="' + (field === 'answerModel' ? 'Answer model' : 'Understanding model') + '"]');
      if (!(picker instanceof HTMLSelectElement)) throw new Error('The Settings catalogue did not render.');
      await act(async () => { picker.value = external; picker.dispatchEvent(new Event('change', { bubbles: true })); });
      expect(host.textContent).toContain('Connect AI Gateway in Settings.');
      const save = host.querySelector<HTMLButtonElement>('.er-models__actions .er-button--primary');
      if (!save) throw new Error('The existing Settings Save action did not render.');
      await act(async () => save.click());
      expect(writes).toEqual([{ path: '/api/settings', method: 'PUT', body: { [field]: external } }]);
      expect(settings).toMatchObject({ [field]: external, [field === 'answerModel' ? 'distillModel' : 'answerModel']: missing });
      expect(host.textContent).toContain('External requests are not connected.');
      await act(async () => save.click());
      expect(writes).toHaveLength(1); // The untouched missing route must not cause a second Save.
      const target = host.querySelector('input[type="radio"][value="' + (field === 'answerModel' ? 'distill' : 'answer') + '"]');
      if (!(target instanceof HTMLInputElement)) throw new Error('The shared catalogue target did not render.');
      await act(async () => target.click());
      expect(host.querySelectorAll('.er-model-picker')).toHaveLength(1);
      expect(host.textContent).toContain('Current selection: not in the current catalogue.');
      expect(writes).toHaveLength(1);
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

  it.each(['OpenRouter model catalogue request timed out.', 'OpenRouter quota is unavailable.'])(
    'shows stored warnings and a truthful refresh outcome without changing the selected slice: %s', async warning => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
      const route = 'gateway:openrouter/retained-model';
      const retained = { route, id: 'retained-model', label: 'Retained model', contextTokens: null, maxOutputTokens: null, checkedOn: null,
        enabled: false, selectable: true, unavailableReason: 'Connect AI Gateway in Settings.' };
      const posts: string[] = []; let refreshed = false, catalogueGets = 0;
      vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = String(input), method = init?.method ?? 'GET';
        if (method !== 'GET') {
          if (path !== '/api/models/refresh' || method !== 'POST') throw new Error('Refresh must not save defaults, connect credentials or infer.');
          posts.push(path); refreshed = true;
          return Response.json({ models: [retained], defaultModel: route, warnings: [warning] });
        }
        if (path === '/api/settings') return Response.json({ settings: { answerModel: route, distillModel: route, updatedAt: 0 } });
        if (path === '/api/models') { catalogueGets++; return Response.json({ models: [retained], defaultModel: route, warnings: refreshed ? [] : ['Stored catalogue advisory.'] }); }
        if (path === '/api/models/providers') return Response.json({ providers: [] });
        if (path === '/api/models/connection') return Response.json({ connection: { gatewayId: null, provider: 'ai-gateway', alias: 'default' } });
        throw new Error('Unexpected Settings request.');
      }));
      try {
        await act(async () => root.render(<ModelSettings />));
        expect(posts).toEqual([]); expect(catalogueGets).toBe(1);
        expect(host.querySelector('details.er-model-picker__warnings')?.textContent).toContain('Stored catalogue advisory.');
        const button = Array.from(host.querySelectorAll('button')).find(item => item.textContent === 'Refresh models');
        if (!button) throw new Error('The explicit catalogue Refresh action did not render.');
        await act(async () => button.click());
        expect(posts).toEqual(['/api/models/refresh']); expect(catalogueGets).toBe(2);
        const picker = host.querySelector('select[aria-label="Answer model"]');
        if (!(picker instanceof HTMLSelectElement)) throw new Error('The retained catalogue choice did not render.');
        expect(picker.value).toBe(route); expect(picker.disabled).toBe(false);
        expect(Array.from(picker.options).filter(item => item.value === route)).toHaveLength(1);
        expect(host.querySelector('details.er-model-picker__warnings')?.textContent).toContain(warning);
        const outcome = Array.from(host.querySelectorAll('[role="status"]')).find(item => item.textContent === 'Models refreshed with warnings.');
        expect(outcome).toBeDefined();
      } finally { await act(async () => root.unmount()); host.remove(); }
    });

  it('shows the exact excerpt without presenting literal checks as semantic verification', () => {
    // The real BERT failure: the same 512 occurs in a bound and batch arithmetic.
    const quote = '50% of the time B is the actual next sentence that follows A and 50% of the time it is a random sentence, which is done for the ‘next sentence prediction’ task. '
      + 'They are sampled such that the combined length is ≤ 512 tokens. The LM masking is applied after WordPiece tokenization with a uniform masking rate of 15%, and no special consideration given to partial word pieces. '
      + 'We train with batch size of 256 sequences (256 sequences * 512 tokens = 128,000 tokens/batch) for 1,000,000 steps, which is approximately 40 epochs over the 3.3 billion word corpus. '
      + 'We use Adam with learning rate of 1e-4, β1 = 0.9, β2 = 0.999, L2 weight decay of 0.01, learning rate warmup over the first 10,000 steps, and linear decay of the learning rate. '
      + 'We use a dropout probability of 0.1 on all layers. We use a gelu activation (Hendrycks and Gimpel, 2016) rather than the standard relu, following OpenAI GPT. '
      + 'The training loss is the sum of the mean masked LM likelihood and the mean next sentence prediction likelihood.';
    const end = new TextEncoder().encode(quote).byteLength;
    const checked = verifyClaims(quote, [{ id: 91, type: 'paragraph', start: 0, end, heading: null }], [{
      kind: 'method', statement: '1 000 000 шагов при batch 256 последовательностей по 512 токенов',
      quote, block: 91, task: null, metric: null, dataset: null, valueText: null, unit: null, conditions: null,
    }]);
    expect(checked.claims).toHaveLength(1); // Literal/quote checks do not establish the bound's meaning.
    const view: Understanding = {
      sourceId: 's1', revisionId: 'r1', state: 'done', error: null, canRecover: false,
      attemptId: 'r1', currentAttemptId: 'r1', authors: '', published: null,
      recordedUsage: { tokenLimit: null, tokenLimitKind: 'unknown', calls: 0, inputTokens: null,
        cachedTokens: null, outputTokens: null, estimatedCostMicrousd: null, pricingCheckedOn: null, startedAt: null, wallMs: null },
      progress: { attempts: 0, limit: 2, maximumTokens: null, model: null, configuredModel: null },
      guide: null, digest: null, glossary: [], report: null,
      claims: checked.claims.map((claim, index) => ({ ...claim, id: String(index) })),
      citations: [{ block: 91, start: 0, end }],
    };
    const client = new QueryClient();
    client.setQueryData(['understanding', 's1', 'r1', ''], view);
    try {
      const render = () => renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter>
        <SourceUnderstanding projectId='p1' sourceId='s1' revisionId='r1' sourceTitle='BERT' />
      </MemoryRouter></QueryClientProvider>);
      const html = render();
      expect(html).toContain('<h3>Claims and source excerpts</h3>');
      expect(html).not.toContain('Verified claims');
      expect(html).toContain('<blockquote class="er-und__quote">' + quote + '</blockquote>');
      expect(html).toContain('по 512 токенов');
      expect(html).toContain('revisionId=r1&amp;start=0&amp;end=' + end);
      client.setQueryData(['understanding', 's1', 'r1', ''], { ...view, claims: [], citations: [] });
      const empty = render();
      expect(empty).toContain('No claims stored for this revision.');
      expect(empty).not.toContain('verified claims');
    } finally { client.clear(); }
  });

  it('refreshes the cached badge once reading the current revision becomes done', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const claims = Array.from({ length: 10 }, (_, i) => ({
      id: String(i), kind: 'other' as const, statement: 'Claim ' + i, quote: 'Quote ' + i,
      block: 91, start: 0, end: 5, task: null, metric: null, dataset: null,
      valueText: null, valueNumber: null, unit: null, conditions: null, ambiguous: false,
    }));
    const done: Understanding = {
      sourceId: 's1', revisionId: 'r1', state: 'done', error: null, canRecover: false,
      attemptId: 'attempt-1', currentAttemptId: 'attempt-1', authors: '', published: null,
      recordedUsage: { tokenLimit: null, tokenLimitKind: 'unknown', calls: 0, inputTokens: null,
        cachedTokens: null, outputTokens: null, estimatedCostMicrousd: null, pricingCheckedOn: null, startedAt: null, wallMs: null },
      progress: { attempts: 0, limit: 2, maximumTokens: null, model: null, configuredModel: null },
      guide: null, digest: null, glossary: [], report: null, claims, citations: [] };
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    const badge = (distillState: string, claimCount: number): BadgeSource => ({ id: 's1', currentRevisionId: 'r1', distillState, claimCount });
    let sourceReads = 0;
    let releaseInitialSources!: (response: Response) => void;
    const initialSources = new Promise<Response>(resolve => { releaseInitialSources = resolve; });
    let retryInProgress = false;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/models') return json({ models: [] });
      if (url.pathname === '/api/sources/s1/understanding') return json(done);
      if (url.pathname === '/api/projects/p1/sources') {
        sourceReads++;
        if (sourceReads === 1) return initialSources;
        return json({ sources: [badge(retryInProgress && sourceReads === 3 ? 'running' : 'done', 10)], nextCursor: null });
      }
      return json({});
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    try {
      await act(async () => { root.render(<QueryClientProvider client={client}><MemoryRouter>
        <><SourcesRead projectId='p1' /><SourceUnderstanding projectId='p1' sourceId='s1' revisionId='r1' sourceTitle='BERT' /></>
      </MemoryRouter></QueryClientProvider>); });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
      expect(sourceReads).toBe(1);
      expect(client.getQueryState(['sources', 'p1'])?.fetchStatus).toBe('fetching');
      await act(async () => {
        releaseInitialSources(json({ sources: [badge('none', 0)], nextCursor: null }));
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      expect(sourceReads).toBe(2);
      const cached = client.getQueryData<{ pages: { sources: { distillState: string; claimCount: number }[] }[] }>(['sources', 'p1']);
      expect(cached?.pages[0]?.sources[0]?.distillState).toBe('done');
      expect(cached?.pages[0]?.sources[0]?.claimCount).toBe(10);
      retryInProgress = true;
      await act(async () => { await client.invalidateQueries({ queryKey: ['sources', 'p1'], exact: true }); });
      expect(sourceReads).toBe(3);
      expect(client.getQueryData<{ pages: { sources: { distillState: string }[] }[] }>(['sources', 'p1'])?.pages[0]?.sources[0]?.distillState).toBe('running');
      await act(async () => {
        client.setQueryData(['understanding', 's1', 'r1', ''], { ...done, attemptId: 'attempt-2', currentAttemptId: 'attempt-2' });
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      expect(sourceReads).toBe(4);
      expect(client.getQueryData<{ pages: { sources: { distillState: string; claimCount: number }[] }[] }>(['sources', 'p1'])?.pages[0]?.sources[0])
        .toMatchObject({ distillState: 'done', claimCount: 10 });
      expect(host.textContent).toContain('Understood');
    } finally {
      await act(async () => root.unmount());
      host.remove(); client.clear(); vi.unstubAllGlobals();
    }
  });

  it.each([
    { label: 'a different current revision', revisionId: 'r0', attemptId: 'r0', currentAttemptId: 'r0' },
    { label: 'a historical attempt', revisionId: 'r1', attemptId: 'old', currentAttemptId: 'new' },
  ])('does not replace the current badge for $label', async ({ revisionId, attemptId, currentAttemptId }) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const historical: Understanding = {
      sourceId: 's1', revisionId, state: 'done', error: null, canRecover: false,
      attemptId, currentAttemptId, authors: '', published: null,
      recordedUsage: { tokenLimit: null, tokenLimitKind: 'unknown', calls: 0, inputTokens: null,
        cachedTokens: null, outputTokens: null, estimatedCostMicrousd: null, pricingCheckedOn: null, startedAt: null, wallMs: null },
      progress: { attempts: 0, limit: 2, maximumTokens: null, model: null, configuredModel: null },
      guide: null, digest: null, glossary: [], report: null, claims: [], citations: [] };
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    let sourceReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/models') return json({ models: [] });
      if (url.pathname === '/api/sources/s1/understanding') return json(historical);
      if (url.pathname === '/api/projects/p1/sources') { sourceReads++; return new Response('{}', { headers: { 'Content-Type': 'application/json' } }); }
      return json({});
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(['sources', 'p1'], { pages: [{ sources: [{ id: 's1', currentRevisionId: 'r1', distillState: 'none', claimCount: 0 }], nextCursor: null }] });
    try {
      await act(async () => { root.render(<QueryClientProvider client={client}><MemoryRouter>
        <SourceUnderstanding projectId='p1' sourceId='s1' revisionId={revisionId} sourceTitle='BERT' />
      </MemoryRouter></QueryClientProvider>); });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      expect(sourceReads).toBe(0);
      expect(client.getQueryState(['sources', 'p1'])?.isInvalidated).toBe(false);
      const cached = client.getQueryData<{ pages: { sources: { distillState: string }[] }[] }>(['sources', 'p1']);
      expect(cached?.pages[0]?.sources[0]?.distillState).toBe('none');
    } finally {
      await act(async () => root.unmount());
      host.remove(); client.clear(); vi.unstubAllGlobals();
    }
  });

  const retryFixture: Understanding = {
    sourceId: 's1', revisionId: 'r1', state: 'done', error: null, canRecover: false,
    attemptId: 'attempt-1', currentAttemptId: 'attempt-1', authors: '', published: null,
    recordedUsage: { tokenLimit: null, tokenLimitKind: 'unknown', calls: 0, inputTokens: null,
      cachedTokens: null, outputTokens: null, estimatedCostMicrousd: null, pricingCheckedOn: null, startedAt: null, wallMs: null },
    progress: { attempts: 0, limit: 2, maximumTokens: null, model: 'workers-ai:reasoning-fixture', configuredModel: 'workers-ai:reasoning-fixture' },
    guide: 'Done guide', digest: null, glossary: [], report: null, claims: [], citations: [] };
  const retryModel: ModelRoute = { route: 'workers-ai:reasoning-fixture', id: 'reasoning-fixture', label: 'Native fixture',
    enabled: true, contextTokens: 1024, maxOutputTokens: 128, nativeReasoningEffort: 'high', checkedOn: null };
  const waitFor = async (predicate: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return;
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    }
    throw new Error('Timed out waiting for understanding controls.');
  };

  it('explicitly reruns a done understanding without a POST on ordinary mount', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    sessionStorage.clear();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = retryFixture;
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    const posts: Array<{ url: string; method: string; body: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if ((init?.method ?? 'GET') === 'POST') {
        const body = String(init?.body ?? '');
        posts.push({ url: url.pathname, method: 'POST', body });
        const parsed = JSON.parse(body) as { retry?: { attemptId?: string } };
        return json({ revisionId: 'r1', attemptId: parsed.retry?.attemptId });
      }
      if (url.pathname === '/api/models') return json({ models: [retryModel], defaultModel: 'gateway:answers/other-model' });
      if (url.pathname === '/api/sources/s1/understanding') return json(done);
      return json({});
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    try {
      await act(async () => { root.render(<QueryClientProvider client={client}><MemoryRouter>
        <SourceUnderstanding projectId='p1' sourceId='s1' revisionId='r1' sourceTitle='BERT' />
      </MemoryRouter></QueryClientProvider>); });
      await waitFor(() => Array.from(host.querySelectorAll('button'))
        .some(button => button.textContent === 'Run understanding again' && !button.disabled));
      expect(posts).toEqual([]);
      const effort = host.querySelector<HTMLSelectElement>('select[aria-label="Understanding reasoning effort"]');
      expect(effort?.disabled).toBe(false); expect(effort?.value).toBe('');
      expect(host.textContent).toContain('Requested native reasoning effort: Unknown (not recorded).');
      const button = Array.from(host.querySelectorAll('button'))
        .find(candidate => candidate.textContent === 'Run understanding again');
      expect(button).toBeDefined();
      expect((button as HTMLButtonElement).disabled).toBe(false);
      await act(async () => { (button as HTMLButtonElement).click(); });
      await waitFor(() => posts.length === 1);
      expect(sessionStorage.getItem('understanding-retry:s1:r1')).toBe(posts[0]?.body);
      const stored = JSON.parse(sessionStorage.getItem('understanding-retry:s1:r1') ?? 'null') as
        { revisionId: string; retry: { attemptId: string; previousAttemptId: string } };
      expect(stored.revisionId).toBe('r1');
      expect(stored).not.toHaveProperty('nativeReasoningEffort');
      expect(stored.retry.previousAttemptId).toBe('attempt-1');
      expect(stored.retry.attemptId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(posts[0]).toMatchObject({ url: '/api/sources/s1/understanding', method: 'POST' });
      expect(JSON.parse(posts[0]?.body ?? '{}')).toEqual(stored);
    } finally {
      sessionStorage.removeItem('understanding-retry:s1:r1');
      await act(async () => root.unmount());
      host.remove(); client.clear(); vi.unstubAllGlobals();
    }
  });

  it('freezes Low across an uncertain retry reply and remount, then shows only the recorded requested profile', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    sessionStorage.clear();
    const host = document.createElement('div'); document.body.appendChild(host);
    const root = createRoot(host);
    const failed: Understanding = { ...retryFixture, state: 'failed', error: 'Offline failed attempt.' };
    let current = failed, profileKnown = true;
    const posts: string[] = [];
    let rejectFirst!: (reason: Error) => void;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost'), method = init?.method ?? 'GET';
      if (method === 'POST' && url.pathname === '/api/sources/s1/understanding') {
        const body = String(init?.body); posts.push(body);
        const parsed = JSON.parse(body) as { nativeReasoningEffort?: 'low' | 'high'; retry: { attemptId: string } };
        if (posts.length === 1) return new Promise<Response>((_resolve, reject) => { rejectFirst = reject; });
        current = { ...failed, state: 'queued', attemptId: parsed.retry.attemptId, currentAttemptId: parsed.retry.attemptId,
          knownRequestId: parsed.retry.attemptId, progress: { ...failed.progress, ...(parsed.nativeReasoningEffort ? { nativeReasoningEffort: parsed.nativeReasoningEffort } : {}) } };
        return Response.json({ revisionId: 'r1', attemptId: parsed.retry.attemptId });
      }
      if (method !== 'GET') throw new Error('Unexpected understanding mutation.');
      if (url.pathname === '/api/models') return Response.json({ models: [{ ...retryModel,
        ...(profileKnown ? {} : { nativeReasoningEffort: undefined }) }], defaultModel: 'gateway:answers/other-model' });
      if (url.pathname === '/api/sources/s1/understanding') return Response.json(current);
      throw new Error('Unexpected understanding read.');
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const render = (key: string) => root.render(<QueryClientProvider client={client}><MemoryRouter>
      <SourceUnderstanding key={key} projectId='p1' sourceId='s1' revisionId='r1' sourceTitle='BERT' />
    </MemoryRouter></QueryClientProvider>);
    const effort = () => {
      const select = host.querySelector('select[aria-label="Understanding reasoning effort"]');
      if (!(select instanceof HTMLSelectElement)) throw new Error('The native effort control did not render.');
      return select;
    };
    const button = (label: string) => {
      const found = Array.from(host.querySelectorAll('button')).find(candidate => candidate.textContent === label);
      if (!found) throw new Error('Missing understanding action: ' + label);
      return found;
    };
    try {
      await act(async () => render('initial'));
      await waitFor(() => host.querySelector<HTMLSelectElement>('select[aria-label="Understanding reasoning effort"]')?.disabled === false);
      expect(posts).toEqual([]);
      expect(host.textContent).toContain('Requested native reasoning effort: Unknown (not recorded).');
      await act(async () => { effort().value = 'low'; effort().dispatchEvent(new Event('change', { bubbles: true })); });
      expect(posts).toEqual([]);
      await act(async () => button('Retry understanding').click());
      await waitFor(() => posts.length === 1);
      const frozen = posts[0];
      if (frozen === undefined) throw new Error('The Low retry was not captured.');
      expect(JSON.parse(frozen)).toEqual({ revisionId: 'r1', nativeReasoningEffort: 'low',
        retry: { attemptId: expect.any(String), previousAttemptId: 'attempt-1' } });
      expect(sessionStorage.getItem('understanding-retry:s1:r1')).toBe(frozen);
      expect(effort().disabled).toBe(true);
      await act(async () => rejectFirst(new Error('Offline lost reply.')));
      await waitFor(() => host.textContent?.includes('Request outcome is unknown.') === true);
      expect(effort().disabled).toBe(true);
      expect(Array.from(host.querySelectorAll('button')).some(candidate => candidate.textContent === 'Retry understanding')).toBe(false);
      profileKnown = false;
      await act(async () => render('reopened'));
      await waitFor(() => Array.from(host.querySelectorAll('button')).some(candidate => candidate.textContent === 'Send same request'));
      expect(posts).toHaveLength(1); expect(effort().disabled).toBe(true); expect(effort().value).toBe('low');
      await act(async () => { effort().value = 'high'; effort().dispatchEvent(new Event('change', { bubbles: true })); });
      expect(sessionStorage.getItem('understanding-retry:s1:r1')).toBe(frozen);
      expect(posts).toHaveLength(1);
      await act(async () => button('Send same request').click());
      await waitFor(() => posts.length === 2 && sessionStorage.getItem('understanding-retry:s1:r1') === null);
      expect(posts[1]).toBe(frozen);
      expect(host.textContent).toContain('Requested native reasoning effort: Low.');
    } finally {
      sessionStorage.removeItem('understanding-retry:s1:r1');
      await act(async () => root.unmount());
      host.remove(); client.clear();
    }
  });

  it('clears unsupported effort drafts and creates a new retry intent only after durable rejection', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    sessionStorage.clear();
    const host = document.createElement('div'); document.body.appendChild(host);
    const root = createRoot(host);
    const unknownNative = { ...retryModel, route: 'workers-ai:unknown-fixture', id: 'unknown-fixture', nativeReasoningEffort: undefined };
    const external = { ...retryModel, route: 'gateway:test/test-model', id: 'test-model', label: 'External fixture' };
    let current: Understanding = { ...retryFixture, state: 'failed', canRecover: true,
      progress: { ...retryFixture.progress, nativeReasoningEffort: 'high' } };
    const posts: Array<{ revisionId: string; model?: string; nativeReasoningEffort?: 'low' | 'high'; saveAvailable?: boolean;
      retry?: { attemptId: string; previousAttemptId: string } }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost'), method = init?.method ?? 'GET';
      if (method === 'POST' && url.pathname === '/api/sources/s1/understanding') {
        const body = JSON.parse(String(init?.body)) as (typeof posts)[number]; posts.push(body);
        if (body.saveAvailable) return Response.json({ revisionId: 'r1' });
        if (!body.retry) throw new Error('The terminal fixture requires an explicit retry.');
        current = { ...current, knownRequestId: body.retry.attemptId, requestRejection: 'Offline durable profile rejection.' };
        return Response.json({ revisionId: 'r1', attemptId: body.retry.attemptId, rejected: current.requestRejection });
      }
      if (method !== 'GET') throw new Error('Unexpected understanding mutation.');
      if (url.pathname === '/api/models') return Response.json({ models: [retryModel, unknownNative, external], defaultModel: external.route });
      if (url.pathname === '/api/sources/s1/understanding') return Response.json(current);
      throw new Error('Unexpected understanding read.');
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const render = (projectId = 'p1') => root.render(<QueryClientProvider client={client}><MemoryRouter>
      <SourceUnderstanding projectId={projectId} sourceId='s1' revisionId='r1' sourceTitle='BERT' />
    </MemoryRouter></QueryClientProvider>);
    const select = (label: string) => {
      const found = host.querySelector('select[aria-label="' + label + '"]');
      if (!(found instanceof HTMLSelectElement)) throw new Error('Missing understanding control: ' + label);
      return found;
    };
    const change = async (label: string, value: string) => {
      await act(async () => { const control = select(label); control.value = value; control.dispatchEvent(new Event('change', { bubbles: true })); });
    };
    const chooseModel = async (provider: string, route: string) => {
      await change('Understanding model: provider', provider);
      await change('Understanding model', route);
    };
    const button = (label: string) => {
      const found = Array.from(host.querySelectorAll('button')).find(candidate => candidate.textContent === label);
      if (!found) throw new Error('Missing understanding action: ' + label);
      return found;
    };
    try {
      await act(async () => render());
      await waitFor(() => host.querySelector<HTMLSelectElement>('select[aria-label="Understanding reasoning effort"]')?.disabled === false);
      expect(host.textContent).toContain('Requested native reasoning effort: High.');
      await change('Understanding reasoning effort', 'low');
      await chooseModel('workers-ai', unknownNative.route);
      expect(select('Understanding reasoning effort').disabled).toBe(true);
      expect(select('Understanding reasoning effort').value).toBe('');
      expect(Array.from(select('Understanding reasoning effort').options).map(option => option.value)).toEqual(['']);
      expect(posts).toEqual([]);
      await chooseModel('workers-ai', retryModel.route);
      expect(select('Understanding reasoning effort').value).toBe('');
      await change('Understanding reasoning effort', 'low');
      await act(async () => button('Retry understanding').click());
      await waitFor(() => posts.length === 1 && sessionStorage.getItem('understanding-retry:s1:r1') === null && Array.from(host.querySelectorAll('button')).some(candidate => candidate.textContent === 'Retry understanding' && !candidate.disabled));
      expect(posts[0]).toMatchObject({ model: retryModel.route, nativeReasoningEffort: 'low' });
      await change('Understanding reasoning effort', 'high');
      expect(posts).toHaveLength(1);
      await act(async () => button('Retry understanding').click());
      await waitFor(() => posts.length === 2 && sessionStorage.getItem('understanding-retry:s1:r1') === null && Array.from(host.querySelectorAll('button')).some(candidate => candidate.textContent === 'Retry understanding' && !candidate.disabled));
      expect(posts[1]).toMatchObject({ model: retryModel.route, nativeReasoningEffort: 'high' });
      expect(posts[1]?.retry?.attemptId).not.toBe(posts[0]?.retry?.attemptId);
      await chooseModel('test', external.route);
      expect(select('Understanding reasoning effort').disabled).toBe(true);
      expect(select('Understanding reasoning effort').value).toBe('');
      expect(Array.from(select('Understanding reasoning effort').options).map(option => option.value)).toEqual(['']);
      await act(async () => button('Retry understanding').click());
      await waitFor(() => posts.length === 3 && sessionStorage.getItem('understanding-retry:s1:r1') === null && Array.from(host.querySelectorAll('button')).some(candidate => candidate.textContent === 'Retry understanding' && !candidate.disabled));
      expect(posts[2]?.model).toBe(external.route);
      expect(posts[2]).not.toHaveProperty('nativeReasoningEffort');
      await chooseModel('workers-ai', retryModel.route);
      await change('Understanding reasoning effort', 'low');
      await act(async () => button('Save available output').click());
      await waitFor(() => posts.length === 4 && Array.from(host.querySelectorAll('button')).some(candidate => candidate.textContent === 'Retry understanding' && !candidate.disabled));
      expect(posts[3]).toEqual({ revisionId: 'r1', saveAvailable: true });
      await act(async () => render('p2'));
      expect(select('Understanding reasoning effort').value).toBe('');
      expect(posts).toHaveLength(4);
    } finally {
      sessionStorage.removeItem('understanding-retry:s1:r1');
      await act(async () => root.unmount());
      host.remove(); client.clear();
    }
  });
});
