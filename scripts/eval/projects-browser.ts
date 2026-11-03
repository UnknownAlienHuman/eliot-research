import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { assertEvalBrowserOrigin, fetchEval } from './origin.mjs';

assert(process.env.ELIOT_K1_MODEL !== '1' && process.env.ELIOT_K2_MODEL !== '1' && process.env.ELIOT_K3_MODEL !== '1');
const origin = assertEvalBrowserOrigin(process.env.ELIOT_URL || 'http://127.0.0.1:5173', process.env.ELIOT_ORIGIN);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname), 'Projects fixture is local-only.');
const api = async (path, body?, method = 'POST') => {
  const response = await fetchEval(origin + path, { headers: { Origin: origin, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { method, body: JSON.stringify(body) }) }, origin, process.env.ELIOT_ORIGIN);
  assert(response.ok, `${path}: ${response.status}`);
  return response.json();
};
async function allProjects(archived) {
  const rows = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const result = await api('/api/projects?archived=' + archived + (cursor ? '&cursor=' + cursor : ''));
    rows.push(...result.projects); cursor = result.nextCursor;
    if (!cursor) return rows;
  }
  throw new Error('Projects fixture exceeds its 500-row scan bound.');
}
const prefix = 'Archive ' + crypto.randomUUID() + ' ';
const active = [];
for (let index = 0; index < 52; index++) {
  const pair = await Promise.all(['active', 'archived'].map(async state => {
    const project = (await api('/api/projects', { title: prefix + state + ' ' + index })).project;
    if (state === 'archived') await api('/api/projects/' + project.id, { archived: true }, 'PATCH');
    return project;
  }));
  active.push(pair[0]);
}
const target = active.at(-1);
const text = '# Archive evidence\n\nRetained source — текст 🌐 ' + prefix;
const added = await api('/api/projects/' + target.id + '/sources/text', { title: 'Recovery evidence', text });
let source;
await expect.poll(async () => { source = (await api('/api/sources/' + added.sourceId)).source; return source.readableState; }, { timeout: 30000 }).toBe('readable');
assert.equal(source.conversionCalls, 0);
const revisionId = source.currentRevisionId;
const sourceBefore = await api('/api/sources/' + source.id);
const canonicalBefore = await fetchEval(origin + '/api/revisions/' + revisionId + '/text', {}, origin, process.env.ELIOT_ORIGIN).then(r => r.text());
const chat = (await api('/api/projects/' + target.id + '/chats', { title: 'Retained history ' + prefix })).chat;
await mkdir('eval/out/k1', { recursive: true });
const browser = await chromium.launch();
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await api('/api/projects/' + target.id, { title: target.title, archived: false }, 'PATCH');
    const expectedArchived = await allProjects(true);
    const expectedActive = await allProjects(false);
    const context = await browser.newContext({ viewport });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.fallback() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let mode = '', writeMode = '', heldPatch, unexpectedWrites = 0;
    const heldReads = [], patches = [];
    await page.route('**/api/**', route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() === 'PATCH' && url.pathname === '/api/projects/' + target.id) {
        patches.push(request.postDataJSON());
        if (writeMode === 'hold') { heldPatch = route; return; }
        if (writeMode === 'fail') return route.fulfill({ status: 503, json: { error: { message: 'Synthetic restore failure' } } });
        return route.fallback();
      }
      if (request.method() !== 'GET') { unexpectedWrites++; return route.abort('blockedbyclient'); }
      if (url.pathname === '/api/projects' && url.searchParams.get('archived') === 'true') {
        if (mode === 'hold') { heldReads.push(route); return; }
        if (mode === 'fail' || mode === 'page' && url.searchParams.has('cursor'))
          return route.fulfill({ status: 503, json: { error: { message: 'Synthetic archived read failure' } } });
      }
      return route.fallback();
    });
    const projects = page.getByRole('region', { name: 'Projects', exact: true });
    const filter = projects.getByRole('checkbox', { name: 'Show archived projects', exact: true });
    const rows = projects.locator('li.er-lib__row');
    const row = title => rows.filter({ has: page.getByRole('link', { name: title, exact: true }) });
    const more = () => projects.getByRole('button', { name: 'Load more', exact: true });
    const loadAll = async () => {
      while (await more().count()) {
        const count = await rows.count();
        await more().click();
        await expect.poll(() => rows.count()).toBeGreaterThan(count);
        await expect(projects.getByRole('button', { name: 'Loading projects.', exact: true })).toHaveCount(0);
      }
    };
    await page.goto(origin);
    await expect(rows).toHaveCount(50);
    await projects.getByRole('textbox', { name: 'New project', exact: true }).fill('Unsubmitted project name');
    await loadAll();
    assert.deepEqual(await rows.locator('a').evaluateAll(links => links.map(link => link.getAttribute('href'))),
      expectedActive.map(project => '/p/' + project.id + '/sources'));
    mode = 'hold';
    await filter.check();
    await expect.poll(() => heldReads.length).toBeGreaterThan(0);
    await filter.uncheck();
    mode = '';
    for (const request of heldReads) await request.fulfill({ json: { projects: [], nextCursor: null } }).catch(() => {});
    await expect(rows).toHaveCount(50);
    await expect(row(target.title)).toHaveCount(1);
    await expect(filter).not.toBeChecked();
    await expect(projects.getByRole('textbox', { name: 'New project', exact: true })).toHaveValue('Unsubmitted project name');
    mode = 'fail';
    await filter.check();
    await expect(projects.getByRole('alert')).toContainText('Synthetic archived read failure');
    await expect(filter).toBeEnabled();
    mode = '';
    await projects.getByRole('button', { name: 'Retry projects', exact: true }).click();
    await expect(rows).toHaveCount(50);
    mode = 'page';
    await more().click();
    await expect(projects.getByRole('alert')).toContainText('Synthetic archived read failure');
    await expect(rows).toHaveCount(50);
    mode = '';
    await projects.getByRole('button', { name: 'Retry projects', exact: true }).click();
    await expect.poll(() => rows.count()).toBeGreaterThan(50);
    await loadAll();
    assert.deepEqual(await rows.locator('a').evaluateAll(links => links.map(link => link.getAttribute('href'))),
      expectedArchived.map(project => '/p/' + project.id + '/sources'));
    await filter.uncheck();
    await expect(row(target.title)).toHaveCount(1);
    writeMode = 'hold';
    await row(target.title).getByRole('button', { name: 'Archive', exact: true }).click();
    await expect.poll(() => Boolean(heldPatch)).toBe(true);
    await expect(filter).toBeDisabled();
    await expect(row(target.title).getByRole('button', { name: 'Archive', exact: true })).toBeDisabled();
    writeMode = '';
    await heldPatch.continue();
    await expect(row(target.title)).toHaveCount(0);
    await filter.check();
    await expect(row(target.title)).toHaveCount(1);
    writeMode = 'fail';
    await row(target.title).getByRole('button', { name: 'Unarchive', exact: true }).click();
    await expect(projects.getByRole('alert')).toContainText('Synthetic restore failure');
    await expect(row(target.title)).toHaveCount(1);
    writeMode = '';
    await row(target.title).getByRole('button', { name: 'Rename', exact: true }).click();
    const restoredTitle = 'Recovered ' + prefix + viewport.width;
    await projects.getByRole('textbox', { name: 'Project title', exact: true }).fill(restoredTitle);
    await expect(filter).toBeDisabled();
    await row(target.title).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(row(restoredTitle)).toHaveCount(1);
    assert.notEqual((await api('/api/projects/' + target.id)).project.archivedAt, null);
    await page.screenshot({ path: 'eval/out/k1/projects-archived-' + viewport.width + '.png' });
    await row(restoredTitle).getByRole('button', { name: 'Unarchive', exact: true }).click();
    await expect(row(restoredTitle)).toHaveCount(0);
    await filter.uncheck();
    await expect(row(restoredTitle)).toHaveCount(1);
    await row(restoredTitle).getByRole('link', { name: restoredTitle, exact: true }).click();
    await expect(page).toHaveURL(origin + '/p/' + target.id + '/sources');
    await page.getByRole('link', { name: source.title, exact: true }).click();
    await expect(page).toHaveURL(origin + '/p/' + target.id + '/source/' + source.id + '?revisionId=' + revisionId);
    await expect(page.locator('pre.er-lib__text')).toHaveText(canonicalBefore);
    await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Chat', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Question', exact: true })).toBeVisible();
    await page.getByRole('region', { name: 'Chat', exact: true }).getByText('History', { exact: true }).click();
    await expect(page.getByRole('link', { name: chat.title, exact: true })).toBeVisible();
    assert.deepEqual(await api('/api/sources/' + source.id), sourceBefore);
    assert.equal(await fetchEval(origin + '/api/revisions/' + revisionId + '/text', {}, origin, process.env.ELIOT_ORIGIN).then(r => r.text()), canonicalBefore);
    assert.deepEqual(patches, [{ archived: true }, { archived: false }, { title: restoredTitle }, { archived: false }]);
    assert.equal(unexpectedWrites, 0); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ scope: 'K1_PROJECTS_BROWSER', viewport, active: expectedActive.length, archived: expectedArchived.length,
      pagedBothViews: true, staleReadIgnored: true, readAndRestoreRetry: true, archiveRenameRestore: true,
      retainedSourceAndHistory: true, projectPatches: patches.length, unexpectedWrites, modelCalls: 0 }));
    await context.close();
  }
} finally { await browser.close(); }
