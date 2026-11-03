// Actual desktop/phone workspace; overview responses are held fixtures for view races.
// Project creation, native text replacement and revision reading use the real local Worker.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { assertEvalBrowserOrigin, fetchEval } from './origin.mjs';

assert(process.env.ELIOT_K2_MODEL !== '1' && process.env.ELIOT_K3_MODEL !== '1', 'Overview browser checks forbid model opt-in.');
const origin = assertEvalBrowserOrigin(process.env.ELIOT_URL || 'http://127.0.0.1:5173', process.env.ELIOT_ORIGIN);
const api = async (path, body?) => {
  const response = await fetchEval(origin + path, { headers: { Origin: origin, 'Content-Type': 'application/json' },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) }, origin, process.env.ELIOT_ORIGIN);
  const data = await response.json(); assert(response.ok, JSON.stringify({ path, status: response.status, data })); return data;
};
await mkdir('eval/out/k3', { recursive: true });
const browser = await chromium.launch();
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const project = (await api('/api/projects', { title: 'Overview browser ' + crypto.randomUUID() })).project.id;
    const other = (await api('/api/projects', { title: 'Other overview ' + crypto.randomUUID() })).project.id;
    const marker = 'Original canonical text ' + crypto.randomUUID();
    const created = await api('/api/projects/' + project + '/sources/text', { title: 'Pinned overview source', text: '# Original\n\n' + marker });
    let source;
    await expect.poll(async () => { source = (await api('/api/sources/' + created.sourceId)).source; return source.readableState; }, { timeout: 30000 }).toBe('readable');
    assert.equal(source.conversionCalls, 0);
    const originalRevision = source.revisionId;
    let rows = Array.from({ length: 103 }, (_, index) => ({ sourceId: index ? crypto.randomUUID() : source.id,
      revisionId: index ? crypto.randomUUID() : originalRevision, title: index ? 'Overview source ' + index : 'Pinned overview source',
      state: index % 2 ? 'partial' : 'done', summary: 'Guide summary ' + index,
      questions: ['Что следует прочитать дальше?', 'Which condition applies?'] }));
    let otherRows = [{ ...rows[0], sourceId: crypto.randomUUID(), title: 'Other project only' }];
    let failFirst = false, failMore = false, holdNext = false, held = null;
    const reads = [], pageErrors = [];
    const context = await browser.newContext({ viewport });
    await context.route('https://**', route => route.abort());
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    let unexpectedWrites = 0;
    await page.route('**/api/**', route => {
      if (route.request().method() === 'GET') return route.fallback();
      unexpectedWrites++; return route.abort('blockedbyclient');
    });
    await page.route('**/api/projects/*/overview*', async route => {
      const url = new URL(route.request().url()), pid = url.pathname.split('/')[3], cursor = url.searchParams.get('cursor');
      reads.push({ projectId: pid, cursor });
      const list = pid === project ? rows : otherRows;
      const offset = cursor ? list.findIndex(row => row.sourceId === JSON.parse(cursor)[2]) + 1 : 0;
      const batch = list.slice(offset, offset + 50), last = batch.at(-1);
      const body = { sources: batch, nextCursor: list.length > offset + 50 ? JSON.stringify([pid, 1, last.sourceId]) : null };
      if (pid === project && cursor && holdNext) {
        holdNext = false;
        await new Promise<void>(resolve => { held = { route, body, resolve }; });
        return;
      }
      if (pid === project && ((!cursor && failFirst) || (cursor && failMore))) {
        failFirst = false; failMore = false;
        return route.fulfill({ status: 503, json: { error: { message: 'Overview fixture outage.' } } });
      }
      return route.fulfill({ json: body });
    });
    const view = page.getByRole('region', { name: 'Project overview', exact: true });
    const cards = () => view.locator('.er-und__rows > li');
    const navigate = async path => {
      await page.evaluate(path => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); }, path);
      await expect(page).toHaveURL(origin + path);
    };
    const release = async (status = 200) => {
      assert(held, 'No held overview response.'); const current = held; held = null;
      await current.route.fulfill({ status, json: status === 200 ? current.body : { error: { message: 'Late obsolete outage.' } } }).catch(() => {});
      current.resolve();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    try {
      await page.goto(origin + '/p/' + project + '/studio');
      const studio = page.getByRole('region', { name: 'Studio', exact: true });
      await expect(studio.getByRole('heading', { name: 'Studio', exact: true })).toBeVisible();
      assert.equal(await studio.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'Studio entry actions must fit their pane.');
      await page.getByRole('link', { name: 'Project overview', exact: true }).click();
      await expect(cards()).toHaveCount(50);
      failFirst = true;
      await view.getByRole('button', { name: 'Refresh overview', exact: true }).click();
      await expect(view.getByRole('alert')).toContainText('Overview fixture outage.');
      await view.getByRole('button', { name: 'Retry overview', exact: true }).click();
      await expect(cards()).toHaveCount(50);
      failMore = true;
      await view.getByRole('button', { name: 'Load more sources', exact: true }).click();
      await expect(view.getByRole('alert')).toContainText('Overview fixture outage.');
      await expect(cards()).toHaveCount(50);
      await view.getByRole('button', { name: 'Retry overview', exact: true }).click();
      await expect(cards()).toHaveCount(100);
      holdNext = true;
      await view.getByRole('button', { name: 'Load more sources', exact: true }).click();
      await expect.poll(() => held !== null).toBe(true);
      rows = [{ ...rows[1], sourceId: crypto.randomUUID(), title: 'Newly attached older source' }, ...rows];
      const beforeRefresh = reads.length;
      await view.getByRole('button', { name: 'Refresh overview', exact: true }).click();
      await expect(cards()).toHaveCount(50);
      await expect(view.getByRole('link', { name: 'Newly attached older source', exact: true })).toBeVisible();
      await release();
      await expect(cards()).toHaveCount(50);
      assert(reads.slice(beforeRefresh).filter(read => read.projectId === project).every(read => read.cursor === null), 'Refresh must restart one first-page request.');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: 'eval/out/k3/overview-' + viewport.width + '.png' });
      const pinned = view.getByRole('link', { name: 'Pinned overview source', exact: true });
      await expect(pinned).toHaveAttribute('href', '/p/' + project + '/source/' + source.id + '?revisionId=' + originalRevision);
      await api('/api/projects/' + project + '/sources/text', { title: 'Pinned overview source', sourceId: source.id, text: '# Replacement\n\nNew canonical text ' + crypto.randomUUID() });
      await expect.poll(async () => (await api('/api/sources/' + source.id)).source.currentRevisionId, { timeout: 30000 }).not.toBe(originalRevision);
      await pinned.click();
      await expect(page.locator('.er-lib__text')).toContainText(marker);
      await expect(page).toHaveURL(origin + '/p/' + project + '/source/' + source.id + '?revisionId=' + originalRevision);
      for (const status of [200, 503]) {
        await navigate('/p/' + project + '/overview'); await expect(cards()).toHaveCount(50);
        holdNext = true; await view.getByRole('button', { name: 'Load more sources', exact: true }).click();
        await expect.poll(() => held !== null).toBe(true);
        await navigate('/p/' + other + '/overview');
        await expect(view.getByRole('link', { name: 'Other project only', exact: true })).toBeVisible();
        await release(status);
        await expect(cards()).toHaveCount(1); await expect(view.getByRole('alert')).toHaveCount(0);
      }
      await navigate('/p/' + project + '/overview'); await expect(cards()).toHaveCount(50);
      holdNext = true; await view.getByRole('button', { name: 'Load more sources', exact: true }).click();
      await expect.poll(() => held !== null).toBe(true);
      await navigate('/settings'); await navigate('/p/' + project + '/overview');
      await expect(cards()).toHaveCount(50); await release(); await expect(cards()).toHaveCount(50);
      await navigate('/p/' + other + '/overview'); otherRows = [];
      await view.getByRole('button', { name: 'Refresh overview', exact: true }).click();
      await expect(view).toContainText('No readable sources yet.');
      await view.getByRole('link', { name: 'Open Sources', exact: true }).click();
      await expect(page).toHaveURL(origin + '/p/' + other + '/sources');
      assert.equal(unexpectedWrites, 0); assert.deepEqual(pageErrors, []);
      console.log(JSON.stringify({ scope: 'K3_OVERVIEW_BROWSER', viewport, overviewResponses: 'CONTROLLED_FIXTURES', nativeReplacementAndPinnedReader: true,
        initialAndPageRetry: true, refreshCancelsOldPage: true, routeIsolation: true, unexpectedWrites, newModelCalls: 0 }));
    } finally { if (held) await release(); await context.close(); }
  }
} finally { await browser.close(); }
