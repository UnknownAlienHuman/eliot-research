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

  it('explicitly reruns a done understanding without a POST on ordinary mount', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    sessionStorage.clear();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const done: Understanding = {
      sourceId: 's1', revisionId: 'r1', state: 'done', error: null, canRecover: false,
      attemptId: 'attempt-1', currentAttemptId: 'attempt-1', authors: '', published: null,
      recordedUsage: { tokenLimit: null, tokenLimitKind: 'unknown', calls: 0, inputTokens: null,
        cachedTokens: null, outputTokens: null, estimatedCostMicrousd: null, pricingCheckedOn: null, startedAt: null, wallMs: null },
      progress: { attempts: 0, limit: 2, maximumTokens: null, model: null, configuredModel: 'gateway:test/test-model' },
      guide: 'Done guide', digest: null, glossary: [], report: null, claims: [], citations: [] };
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
      if (url.pathname === '/api/models') return json({ models: [{
        route: 'gateway:test/test-model', id: 'test-model', label: 'Test model', enabled: true,
        contextTokens: 1024, maxOutputTokens: 128, checkedOn: null,
      }] });
      if (url.pathname === '/api/sources/s1/understanding') return json(done);
      return json({});
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const waitFor = async (predicate: () => boolean): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return;
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
      }
      throw new Error('Timed out waiting for the done retry control.');
    };
    try {
      await act(async () => { root.render(<QueryClientProvider client={client}><MemoryRouter>
        <SourceUnderstanding projectId='p1' sourceId='s1' revisionId='r1' sourceTitle='BERT' />
      </MemoryRouter></QueryClientProvider>); });
      await waitFor(() => Array.from(host.querySelectorAll('button'))
        .some(button => button.textContent === 'Run understanding again'));
      expect(posts).toEqual([]);
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
});
