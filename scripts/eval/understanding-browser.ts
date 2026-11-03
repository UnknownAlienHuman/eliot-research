// K3 progress and result recovery. Native text setup uses the local Worker; every
// browser understanding POST is fulfilled or rejected in-page before it can dispatch work.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { assertEvalBrowserOrigin, fetchEval } from './origin.mjs';

assert(process.env.ELIOT_K2_MODEL !== '1' && process.env.ELIOT_K3_MODEL !== '1', 'Understanding browser checks forbid model opt-in.');
const origin = assertEvalBrowserOrigin(process.env.ELIOT_URL || 'http://127.0.0.1:5173', process.env.ELIOT_ORIGIN);
const api = async (path: string, body?: unknown) => {
  const response = await fetchEval(origin + path, { headers: { Origin: origin, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) }, origin, process.env.ELIOT_ORIGIN);
  const data = await response.json();
  assert(response.ok, JSON.stringify({ path, status: response.status, data }));
  return data as any;
};

await mkdir('eval/out/k3', { recursive: true });
const browser = await chromium.launch();
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const projectId = (await api('/api/projects', { title: 'Understanding status ' + crypto.randomUUID() })).project.id as string;
    async function nativeSource(title: string) {
      const marker = 'Canonical text ' + crypto.randomUUID();
      const added = await api('/api/projects/' + projectId + '/sources/text', { title, text: '# ' + title + '\n\n' + marker });
      let source;
      await expect.poll(async () => { source = (await api('/api/sources/' + added.sourceId)).source; return source.readableState; }, { timeout: 30000 }).toBe('readable');
      assert.equal(source.conversionCalls, 0, 'Native text setup must not call a converter.');
      return { sourceId: source.id as string, revisionId: source.currentRevisionId as string, marker };
    }
    const a1 = await nativeSource('Status source A');
    const replacementMarker = 'Replacement text ' + crypto.randomUUID();
    await api('/api/projects/' + projectId + '/sources/text', { sourceId: a1.sourceId, title: 'Status source A', text: '# Current A\n\n' + replacementMarker });
    let latestA;
    await expect.poll(async () => { latestA = (await api('/api/sources/' + a1.sourceId)).source; return latestA.currentRevisionId; }, { timeout: 30000 }).not.toBe(a1.revisionId);
    assert.equal(latestA.conversionCalls, 0, 'Native replacement must not call a converter.');
    const a2 = { sourceId: a1.sourceId, revisionId: latestA.currentRevisionId as string, marker: replacementMarker };
    const b = await nativeSource('Status source B');
    const modelRoute = 'workers-ai:status-fixture';
    const model = { route: modelRoute, id: 'status-fixture', label: 'Status fixture', provider: 'workers-ai', enabled: true,
      contextTokens: 8192, maxOutputTokens: 1024, outputReserveTokens: 1024, checkedOn: null };
    let catalogModels = [model];
    const key = (sourceId: string, revisionId: string) => sourceId + ':' + revisionId;
    const makeView = (sourceId: string, revisionId: string, state: string, extras: Record<string, unknown> = {}) => ({
      sourceId, revisionId, state, error: state === 'failed' ? 'Stored failure is visible.' : null,
      canRecover: state === 'failed', authors: '', published: null,
      progress: { attempts: state === 'none' ? 0 : 1, limit: 2, maximumTokens: 18432, model: modelRoute, configuredModel: modelRoute },
      guide: state === 'partial' || state === 'done' ? 'Stored guide.' : null, digest: null, glossary: [], claims: [],
      report: null, citations: [], ...extras,
    });
    const entry = (sourceId: string, revisionId: string, state = 'none', extras: Record<string, unknown> = {}) => ({
      sourceId, revisionId, defaultView: makeView(sourceId, revisionId, state, extras), posts: [] as unknown[], reads: 0,
      inFlight: 0, maxInFlight: 0, nextPost: null as null | { failure?: string; hold?: boolean; after?: unknown[] },
      readActions: [] as unknown[], heldPosts: [] as { resolve: (accepted: boolean) => void }[], heldReads: [] as { resolve: () => void }[],
    });
    const states = new Map([
      [key(a1.sourceId, a1.revisionId), entry(a1.sourceId, a1.revisionId)],
      [key(a2.sourceId, a2.revisionId), entry(a2.sourceId, a2.revisionId)],
      [key(b.sourceId, b.revisionId), entry(b.sourceId, b.revisionId, 'failed')],
    ]);
    const getState = (sourceId: string, revisionId: string) => {
      const state = states.get(key(sourceId, revisionId)) ?? (revisionId === ''
        ? [...states.values()].filter(candidate => candidate.sourceId === sourceId).at(-1)
        : undefined);
      assert(state, 'Unexpected understanding read for ' + JSON.stringify({ sourceId, revisionId, configured: [...states.keys()] }));
      return state;
    };
    const actions = {
      error: (message: string) => ({ error: message }),
      view: (sourceId: string, revisionId: string, state: string, extras: Record<string, unknown> = {}) => ({ view: makeView(sourceId, revisionId, state, extras) }),
      held: (sourceId: string, revisionId: string, state: string, extras: Record<string, unknown> = {}) => ({ hold: true, view: makeView(sourceId, revisionId, state, extras) }),
    };
    const pageErrors: string[] = [], unexpectedWrites: string[] = [], requests: { sourceId: string; revisionId: string; method: string }[] = [];
    const context = await browser.newContext({ viewport });
    await context.route('https://**', route => route.abort());
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/api/**', route => {
      if (route.request().method() === 'GET') return route.fallback();
      unexpectedWrites.push(route.request().method() + ' ' + new URL(route.request().url()).pathname);
      return route.abort('blockedbyclient');
    });
    await page.route('**/api/models', route => route.fulfill({ json: { models: catalogModels, warnings: [] } }));
    await page.route('**/api/sources/*/understanding*', async route => {
      const requestUrl = new URL(route.request().url()), sourceId = requestUrl.pathname.split('/')[3] ?? '';
      const method = route.request().method();
      const payload = method === 'POST' ? route.request().postDataJSON() as { revisionId?: string } : null;
      const revisionId = requestUrl.searchParams.get('revisionId') ?? payload?.revisionId ?? '';
      requests.push({ sourceId, revisionId, method });
      const state = getState(sourceId, revisionId);
      if (method === 'POST') {
        state.posts.push(payload);
        const next = state.nextPost; state.nextPost = null;
        if (next?.hold) {
          const accepted = await new Promise<boolean>(resolve => state.heldPosts.push({ resolve }));
          if (!accepted) return route.fulfill({ status: 503, json: { error: { message: next.failure ?? 'Rejected before acceptance fixture.' } } });
          state.readActions.push(...(next.after ?? []));
          return route.fulfill({ status: 202, json: { revisionId } });
        }
        if (next?.failure) return route.fulfill({ status: 503, json: { error: { message: next.failure } } });
        state.readActions.push(...(next?.after ?? []));
        return route.fulfill({ status: 202, json: { revisionId } });
      }
      state.reads++;
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        const action = state.readActions.shift() as any;
        if (action?.hold) await new Promise<void>(resolve => state.heldReads.push({ resolve }));
        if (action?.error) return route.fulfill({ status: 503, json: { error: { message: action.error } } });
        const selected = action?.view ? action : { view: state.defaultView };
        if (action?.view) state.defaultView = action.view;
        return route.fulfill({ json: selected.view });
      } catch { return; }
      finally { state.inFlight--; }
    });
    const reader = page.getByRole('region', { name: 'Understanding', exact: true });
    const sourceCheckbox = page.locator('input[type="checkbox"][aria-label="Include Status source A in the current source selection"]');
    const routeTo = async (sourceId: string, revisionId: string) => {
      const path = '/p/' + projectId + '/source/' + sourceId + '?revisionId=' + revisionId;
      await page.evaluate(next => { history.pushState({}, '', next); dispatchEvent(new PopStateEvent('popstate')); }, path);
      await expect(page).toHaveURL(origin + path);
      await expect(page.locator('.er-lib__text')).not.toBeEmpty();
      await expect(reader).toBeVisible();
    };
    const openInitially = async (sourceId: string, revisionId: string, marker: string) => {
      await page.goto(origin + '/p/' + projectId + '/source/' + sourceId + '?revisionId=' + revisionId);
      await expect(page.locator('.er-lib__text')).toContainText(marker);
      await expect(reader).toBeVisible();
    };
    const releaseRead = async (state: ReturnType<typeof entry>) => {
      const held = state.heldReads.shift(); assert(held, 'Expected one held understanding GET.'); held.resolve();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const releasePost = async (state: ReturnType<typeof entry>, accepted = true) => {
      const held = state.heldPosts.shift(); assert(held, 'Expected one held understanding POST.'); held.resolve(accepted);
    };
    try {
      // Accepted Understand whose status GET fails; the only recovery is a manual storage read.
      await openInitially(a2.sourceId, a2.revisionId, a2.marker);
      await expect(sourceCheckbox).toBeChecked();
      const current = getState(a2.sourceId, a2.revisionId);
      current.nextPost = { after: [actions.error('Status unavailable fixture.'), actions.view(a2.sourceId, a2.revisionId, 'running'),
        actions.error('Running status poll unavailable fixture.'), actions.view(a2.sourceId, a2.revisionId, 'running'),
        actions.held(a2.sourceId, a2.revisionId, 'partial')] };
      const understand = reader.getByRole('button', { name: 'Understand source', exact: true });
      await expect(understand).toBeEnabled();
      await understand.click();
      await expect.poll(() => current.posts.length).toBe(1, { timeout: 5000 });
      await expect(reader).toContainText('Request accepted. Reload understanding to check its status.');
      const reloadAfterAccepted = reader.getByRole('button', { name: 'Reload understanding', exact: true });
      await expect(reloadAfterAccepted).toBeVisible();
      await expect(reloadAfterAccepted).toBeEnabled();
      if (viewport.width === 1440) await page.screenshot({ path: 'eval/out/k3/understanding-status-unavailable-1440.png' });
      await expect(reader).not.toContainText('Could not start understanding.');
      const afterAcceptedFailure = current.reads;
      await page.waitForTimeout(500);
      assert.equal(current.reads, afterAcceptedFailure, 'Failed status reads must not retry until the owner reloads.');
      const maybeUnderstand = reader.getByRole('button', { name: 'Understand source', exact: true });
      if (await maybeUnderstand.count()) await expect(maybeUnderstand).toBeDisabled();
      await expect(sourceCheckbox).toBeChecked();
      const readsBeforeManualReload = current.reads;
      await reader.getByRole('button', { name: 'Reload understanding', exact: true }).click();
      await expect.poll(() => current.reads).toBe(readsBeforeManualReload + 1);
      await expect(reader.getByRole('alert')).toContainText('Running status poll unavailable fixture.');
      const readsAfterPollFailure = current.reads;
      await page.waitForTimeout(3500);
      assert.equal(current.reads, readsAfterPollFailure, 'A failed running-state poll must not retry automatically.');
      const readsBeforeExplicitReload = current.reads;
      await reader.getByRole('button', { name: 'Reload understanding', exact: true }).click();
      await expect.poll(() => current.reads).toBe(readsBeforeExplicitReload + 1);
      await expect(reader).toContainText('Understanding now');
      await expect(reader).not.toContainText('Running status poll unavailable fixture.');
      await expect.poll(() => current.heldReads.length).toBe(1, { timeout: 6000 });
      const whilePolling = current.reads;
      await page.waitForTimeout(3500);
      assert.equal(current.reads, whilePolling, 'A running status request must not overlap while its prior GET is pending.');
      assert.equal(current.maxInFlight, 1, 'Understanding status GETs must have one in-flight owner.');
      await releaseRead(current);
      await expect(reader).toContainText('Partially understood');
      const terminalReads = current.reads;
      await page.waitForTimeout(3200);
      assert.equal(current.reads, terminalReads, 'Terminal status must stop polling.');
      assert.equal(current.posts.length, 1, 'Reload and status polling must never re-POST understanding.');
      await expect(sourceCheckbox).toBeChecked();

      // Save-existing output follows the same accepted/status-unavailable/reload path.
      catalogModels = [];
      await routeTo(b.sourceId, b.revisionId);
      const saved = getState(b.sourceId, b.revisionId);
      const save = reader.getByRole('button', { name: 'Save available output', exact: true });
      await expect(save).toBeVisible();
      saved.nextPost = { after: [actions.error('Saved output status unavailable fixture.'), actions.view(b.sourceId, b.revisionId, 'partial')] };
      await save.click();
      await expect(reader).toContainText('Request accepted. Reload understanding to check its status.');
      await expect(reader).not.toContainText('Could not save the available output.');
      assert.deepEqual(saved.posts, [{ revisionId: b.revisionId, saveAvailable: true }]);
      await reader.getByRole('button', { name: 'Reload understanding', exact: true }).click();
      await expect(reader).toContainText('Partially understood');
      assert.equal(saved.posts.length, 1, 'Reload after Save-existing must not repeat the storage write.');
      catalogModels = [model];

      // A held old-revision POST cannot affect a newly mounted current-revision Reader.
      await routeTo(a1.sourceId, a1.revisionId);
      const oldRevision = getState(a1.sourceId, a1.revisionId);
      oldRevision.nextPost = { hold: true };
      const startOld = reader.getByRole('button', { name: 'Understand source', exact: true });
      await expect(startOld).toBeEnabled();
      await startOld.click();
      await expect.poll(() => oldRevision.heldPosts.length).toBe(1);
      await routeTo(b.sourceId, b.revisionId);
      await expect(reader).toContainText('Partially understood');
      await routeTo(a2.sourceId, a2.revisionId);
      await expect(reader).toContainText('Partially understood');
      const oldReadsAfterReturn = oldRevision.reads, currentReadsAfterReturn = current.reads;
      await releasePost(oldRevision);
      await page.waitForTimeout(500);
      await expect(reader).toContainText('Partially understood');
      await expect(reader).not.toContainText('Request accepted. Reload understanding to check its status.');
      assert.equal(oldRevision.reads, oldReadsAfterReturn, 'An unmounted POST completion must not trigger its stale status GET.');
      assert.equal(current.reads, currentReadsAfterReturn, 'The old revision completion must not refresh the new revision view.');

      // A failed POST remains distinguishable and offers an explicit storage read, never a second POST.
      await routeTo(a1.sourceId, a1.revisionId);
      const postsBeforeFailure = oldRevision.posts.length;
      oldRevision.nextPost = { failure: 'Understand request rejected before acceptance fixture.' };
      await reader.getByRole('button', { name: 'Understand source', exact: true }).click();
      await expect(reader.getByRole('alert')).toContainText('Understand request rejected before acceptance fixture.');
      await expect(reader).not.toContainText('Request accepted. Reload understanding to check its status.');
      await expect(reader.getByRole('button', { name: 'Reload understanding', exact: true })).toBeVisible();
      assert.equal(oldRevision.posts.length, postsBeforeFailure + 1);
      await reader.getByRole('button', { name: 'Reload understanding', exact: true }).click();
      await expect(reader).toContainText('Not yet understood');
      assert.equal(oldRevision.posts.length, postsBeforeFailure + 1, 'Reload after a failed POST must remain storage-only.');
      await expect(sourceCheckbox).toBeChecked();

      assert.deepEqual(unexpectedWrites, [], 'Only intercepted understanding POSTs are permitted.');
      assert.deepEqual(pageErrors, []);
      await page.screenshot({ path: 'eval/out/k3/understanding-status-' + viewport.width + '.png' });
      console.log(JSON.stringify({ scope: 'K3_UNDERSTANDING_STATUS_BROWSER', viewport, nativeTextSources: 2,
        revisions: 3, conversionCalls: 0, acceptedUnderstandRecovery: true, saveExistingRecovery: true,
        failedPostDistinct: true, pollingNonOverlap: current.maxInFlight === 1, terminalPollingStopped: true,
        revisionUnmountIsolation: true, sourceSelectionPreserved: true, understandingPosts: requests.filter(x => x.method === 'POST').length,
        unexpectedWrites: unexpectedWrites.length, modelCalls: 0, pageErrors }));
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
