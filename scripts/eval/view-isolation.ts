// Actual reused workspace against the local Worker. Model POSTs are intercepted before dispatch.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { assertEvalBrowserOrigin, fetchEval } from './origin.mjs';

assert(process.env.ELIOT_K2_MODEL !== '1', 'View isolation forbids model opt-in.');
const origin = assertEvalBrowserOrigin(process.env.ELIOT_URL || 'http://127.0.0.1:5173', process.env.ELIOT_ORIGIN);
const api = async (path, body?) => {
  const response = await fetchEval(origin + path, { headers: { Origin: origin, 'Content-Type': 'application/json' },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) }, origin, process.env.ELIOT_ORIGIN);
  const data = await response.json(); assert(response.ok, JSON.stringify({ path, status: response.status, data })); return data;
};
const project = (await api('/api/projects', { title: 'View isolation ' + crypto.randomUUID() })).project.id;
const other = (await api('/api/projects', { title: 'Other view isolation ' + crypto.randomUUID() })).project.id;
const chats = await Promise.all(['A', 'B'].map(async title => (await api('/api/projects/' + project + '/chats', { title })).chat.id));
const sources = [];
for (const title of ['Source A', 'Source B']) {
  const created = await api('/api/projects/' + project + '/sources/text', { title, text: '# ' + title + '\n\nImmutable native text ' + crypto.randomUUID() });
  let snapshot;
  await expect.poll(async () => { snapshot = await api('/api/sources/' + created.sourceId); return snapshot.source.readableState; }, { timeout: 30000 }).toBe('readable');
  assert.equal(snapshot.source.conversionCalls, 0); sources.push(snapshot);
}
const chatPath = id => '/p/' + project + '/chat' + (id ? '/' + id : '');
const sourcePath = i => '/p/' + project + '/source/' + sources[i].source.id;
const turnsUrl = id => origin + '/api/projects/' + project + '/chats/' + id + '/turns';
const browser = await chromium.launch();
let interceptedTurns = 0, interceptedUploads = 0, nativeUploads = 0, unexpectedTurns = 0, unexpectedUploads = 0;
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    await context.route('https://**', route => route.abort());
    const page = await context.newPage();
    let allowNativeUpload = false, uploadRequests = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/sources/file')) uploadRequests++; });
    await page.route('**/sources/file', route => {
      if (route.request().method() !== 'POST' || allowNativeUpload) return route.continue();
      unexpectedUploads++; return route.abort('blockedbyclient');
    });
    await page.route('**/turns', route => {
      if (route.request().method() !== 'POST') return route.continue();
      unexpectedTurns++; return route.abort('blockedbyclient');
    });
    const question = page.getByRole('textbox', { name: 'Question', exact: true });
    const send = page.getByRole('button', { name: 'Send', exact: true });
    const settle = async () => { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); };
    const navigate = async path => {
      await page.evaluate(path => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); }, path);
      await expect(page).toHaveURL(origin + path); await settle();
      if (chats.some(id => path === chatPath(id))) await expect(page.locator('.er-chat__history-link[href="' + path + '"]')).toHaveAttribute('aria-current', 'page');
    };
    // Hold a single response; the request has happened, but its continuation has not.
    const hold = async (url, method = 'POST') => {
      let resolve, route;
      const waiting = new Promise<void>((done, reject) => {
        const timer = setTimeout(() => reject(new Error('Request did not arrive: ' + method + ' ' + url)), 10000);
        resolve = () => { clearTimeout(timer); done(); };
      });
      const handler = async incoming => { if (incoming.request().method() !== method) return incoming.continue(); if (route) return incoming.fallback(); route = incoming; resolve(); };
      await page.route(url, handler);
      return { waiting, body: () => route.request().postDataJSON(), request: () => route.request(),
        release: async (body = {}, status = 200) => { await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {}); await page.unroute(url, handler); await settle(); } };
    };
    await page.goto(origin + chatPath(chats[0]));
    await question.fill('A original'); await expect(send).toBeEnabled();
    let pending = await hold(turnsUrl(chats[0])); await send.click(); await pending.waiting; interceptedTurns++;
    assert.equal(pending.body().question, 'A original');
    await navigate(chatPath(chats[1])); await question.fill('B new draft'); await expect(send).toBeEnabled();
    const b = await hold(turnsUrl(chats[1])); await send.click(); await b.waiting; interceptedTurns++;
    await pending.release(); await expect(question).toHaveValue('B new draft'); await expect(page.getByRole('button', { name: /Sending/ })).toBeDisabled();
    await b.release({ error: { message: 'B own failure' } }, 503); await expect(page.getByRole('alert')).toContainText('B own failure'); await expect(send).toBeEnabled();
    // A -> B -> A must not grant the old A response ownership again, including errors.
    await navigate(chatPath(chats[0])); await question.fill('A departure');
    pending = await hold(turnsUrl(chats[0])); await send.click(); await pending.waiting; interceptedTurns++;
    await navigate(chatPath(chats[1])); await navigate(chatPath(chats[0])); await question.fill('A returned draft');
    await pending.release({ error: { message: 'Old A failure' } }, 503); await expect(question).toHaveValue('A returned draft'); await expect(page.getByText('Old A failure')).toHaveCount(0);
    // Same-view editing survives acknowledgement. A hidden mounted chat cannot redirect from Sources.
    pending = await hold(turnsUrl(chats[0])); await send.click(); await pending.waiting; interceptedTurns++;
    await question.fill('Edited during Send'); await pending.release(); await expect(question).toHaveValue('Edited during Send');
    pending = await hold(turnsUrl(chats[0])); await send.click(); await pending.waiting; interceptedTurns++;
    await navigate(sourcePath(1)); await expect(page.getByRole('heading', { name: 'Source B', exact: true })).toBeVisible();
    await pending.release(); await expect(page).toHaveURL(origin + sourcePath(1)); await navigate(chatPath(chats[0])); await expect(question).toHaveValue('Edited during Send');
    // Creation response after departure cannot admit a new question. Successful first Send may navigate,
    // but retains draft and source selection edited while its turn acknowledgement was pending.
    await page.goto(origin + chatPath()); await question.fill('Create then leave');
    const creates = origin + '/api/projects/' + project + '/chats';
    pending = await hold(creates); await send.click(); await pending.waiting;
    await navigate(sourcePath(1)); await pending.release({ chat: { id: chats[0], title: 'Late created' } }); await expect(page).toHaveURL(origin + sourcePath(1));
    await page.goto(origin + chatPath()); await question.fill('Created Send then leave');
    const departedCreate = await hold(creates); await send.click(); await departedCreate.waiting;
    pending = await hold(turnsUrl(chats[0])); await departedCreate.release({ chat: { id: chats[0], title: 'Created before departure' } }); await pending.waiting; interceptedTurns++;
    await navigate(sourcePath(1)); await pending.release(); await expect(page).toHaveURL(origin + sourcePath(1));
    await page.goto(origin + chatPath()); await question.fill('First question');
    const create = await hold(creates); await send.click(); await create.waiting;
    pending = await hold(turnsUrl(chats[0])); await create.release({ chat: { id: chats[0], title: 'Created fixture' } }); await pending.waiting; interceptedTurns++;
    await question.fill('Next draft');
    const includeA = page.getByRole('checkbox', { name: 'Include Source A in the current source selection', exact: true });
    if (viewport.width > 1000) await includeA.uncheck();
    // A persisted last-turn scope would ordinarily be restored by history hydration.
    const chatUrl = origin + '/api/projects/' + project + '/chats/' + chats[0];
    const turn = { turnId: crypto.randomUUID(), question: 'Synthetic saved answer', answer: 'Synthetic answer', state: 'completed',
      createdAt: 1, historyVersion: 1, model: 'fixture', scopeMode: 'project_default', revisionIds: [], sourceIds: [], citations: [], invalidLabels: 0,
      inputTokens: 0, cachedTokens: 0, outputTokens: 0, tokenLimit: 0, firstTokenMs: null, totalMs: 0, error: null };
    const storedChat = await api('/api/projects/' + project + '/chats/' + chats[0]);
    await page.route(chatUrl, route => route.fulfill({ json: { ...storedChat, turns: [turn] } }));
    await pending.release(); await expect(page).toHaveURL(origin + chatPath(chats[0])); await expect(question).toHaveValue('Next draft');
    await expect(page.getByRole('button', { name: 'Save as page', exact: true })).toBeVisible();
    if (viewport.width > 1000) await expect(includeA).not.toBeChecked();
    await page.unroute(chatUrl);
    // Save has a project-wide inventory effect, but its local notice belongs only to its original view.
    let pageReads = 0;
    const pagesUrl = origin + '/api/projects/' + project + '/pages';
    await page.route(pagesUrl, route => { pageReads++; return route.continue(); });
    const saved = await hold(origin + '/api/projects/' + project + '/pages/from-turn');
    await page.getByRole('button', { name: 'Save as page', exact: true }).click(); await saved.waiting;
    await navigate(chatPath(chats[1])); const readsBefore = pageReads; await saved.release();
    await expect.poll(() => pageReads).toBeGreaterThan(readsBefore); await expect(page.getByText('Saved.', { exact: true })).toHaveCount(0); await page.unroute(pagesUrl);
    await navigate(chatPath(chats[0])); await question.fill('Before unmount');
    // Project change/unmount: no navigation or error may reach the new workspace.
    pending = await hold(turnsUrl(chats[0])); await send.click(); await pending.waiting; interceptedTurns++;
    await navigate('/p/' + other + '/chat'); await question.fill('Other project draft');
    await pending.release({ error: { message: 'Unmounted failure' } }, 503); await expect(question).toHaveValue('Other project draft'); await expect(page.getByText('Unmounted failure')).toHaveCount(0);

    const metaUrl = origin + '/api/sources/' + sources[0].source.id;
    // Metadata from A cannot overwrite B, nor A after A -> B -> A.
    pending = await hold(metaUrl, 'GET'); await navigate(sourcePath(0)); await pending.waiting;
    await navigate(sourcePath(1)); await expect(page.locator('.er-lib__text')).toContainText('Immutable native text');
    await navigate(sourcePath(0));
    await expect(page.getByRole('heading', { name: 'Source A', exact: true })).toBeVisible();
    await pending.release({ ...sources[0], source: { ...sources[0].source, title: 'Old metadata' } }); await expect(page.getByRole('heading', { name: 'Source A', exact: true })).toBeVisible();
    // A pending poll is serialized: extra interval ticks cannot start another read. Revision navigation
    // starts a new read, which wins even when the old poll is delivered last.
    let reads = 0, releasePoll;
    await page.route(metaUrl, async route => {
      reads++;
      const data = { ...sources[0], source: { ...sources[0].source, readableState: 'pending' }, revisions: sources[0].revisions.map(r => ({ ...r, readableState: 'pending' })) };
      if (reads === 1) return route.fulfill({ json: data });
      releasePoll = () => route.fulfill({ json: { ...data, source: { ...data.source, title: 'Late poll metadata' } } }).catch(() => {});
    });
    await navigate(sourcePath(1)); await navigate(sourcePath(0)); await expect.poll(() => !!releasePoll, { timeout: 10000 }).toBe(true);
    await page.waitForTimeout(3300); assert.equal(reads, 2, 'Pending polls must not overlap.');
    await navigate(sourcePath(0) + '?revisionId=' + sources[0].source.currentRevisionId);
    await expect(page.locator('.er-lib__text')).toContainText('Immutable native text'); await releasePoll(); await page.unroute(metaUrl);
    await expect(page.getByText('Late poll metadata', { exact: true })).toHaveCount(0);
    // Text and outline reads also belong to their immutable revision, not the new source.
    const textUrl = origin + '/api/revisions/' + sources[0].source.currentRevisionId + '/text';
    pending = await hold(textUrl, 'GET'); await navigate(sourcePath(1)); await navigate(sourcePath(0)); await pending.waiting;
    await navigate(sourcePath(1)); await expect(page.locator('.er-lib__text')).toContainText('Source B'); await pending.release(); await expect(page.locator('.er-lib__text')).toContainText('Source B');
    // Replacement remains bound to A. Switching source clears the React File and native file input.
    const uploadUrl = origin + '/api/projects/' + project + '/sources/file';
    const input = page.getByLabel('Replace source file', { exact: true });
    const upload = page.getByRole('button', { name: 'Upload new revision', exact: true });
    await navigate(sourcePath(0)); await input.setInputFiles({ name: 'a.md', mimeType: 'text/markdown', buffer: Buffer.from('A replacement') });
    pending = await hold(uploadUrl); await upload.click(); await pending.waiting; interceptedUploads++;
    assert(pending.request().postData().includes(sources[0].source.id));
    await navigate(sourcePath(1)); await expect(input).toBeEnabled(); assert.equal(await input.evaluate(input => input.files.length), 0); await expect(upload).toBeDisabled();
    await input.setInputFiles({ name: 'b.md', mimeType: 'text/markdown', buffer: Buffer.from('# Source B\n\nImmutable native text B replacement ' + viewport.width + ' ' + project) });
    const independentB = await hold(uploadUrl); await upload.click(); await independentB.waiting; interceptedUploads++;
    assert(independentB.request().postData().includes(sources[1].source.id));
    await navigate(sourcePath(0)); await expect(input).toBeDisabled();
    // Force a file/change and form submission even through disabled controls: the synchronous source
    // lock must reject the second POST as well as making it unavailable through ordinary UI actions.
    await input.setInputFiles({ name: 'returned-a.md', mimeType: 'text/markdown', buffer: Buffer.from('Returned A') });
    let beforeAttempt = uploadRequests;
    await input.locator('..').evaluate(form => form.requestSubmit()); await settle(); assert.equal(uploadRequests, beforeAttempt);
    await pending.release({ revisionId: sources[0].source.currentRevisionId }); await expect(input).toBeEnabled();
    await expect(page).toHaveURL(origin + sourcePath(0)); assert.equal(await input.evaluate(input => input.files[0].name), 'returned-a.md');
    const afterSuccess = await hold(uploadUrl); await upload.click(); await afterSuccess.waiting; interceptedUploads++;
    assert.equal(uploadRequests, beforeAttempt + 1); await afterSuccess.release();
    await navigate(sourcePath(1)); await expect(input).toBeDisabled(); // A's settlement cannot release B.
    await independentB.release({ error: { message: 'Departed B failure' } }, 503); await expect(input).toBeEnabled();
    await expect(page.getByText('Departed B failure')).toHaveCount(0);
    await navigate(sourcePath(0)); await input.setInputFiles({ name: 'old-a.md', mimeType: 'text/markdown', buffer: Buffer.from('Old A') });
    pending = await hold(uploadUrl); await upload.click(); await pending.waiting; interceptedUploads++;
    await navigate(sourcePath(1)); await navigate(sourcePath(0)); await expect(input).toBeDisabled();
    await navigate(chatPath(chats[0])); await navigate(sourcePath(0)); await expect(input).toBeDisabled();
    await input.setInputFiles({ name: 'new-a.md', mimeType: 'text/markdown', buffer: Buffer.from('New A') });
    beforeAttempt = uploadRequests;
    await input.locator('..').evaluate(form => form.requestSubmit()); await settle(); assert.equal(uploadRequests, beforeAttempt);
    await pending.release({ error: { message: 'Departed replacement failure' } }, 503);
    await expect(input).toBeEnabled(); await expect(page.getByText('Departed replacement failure')).toHaveCount(0); assert.equal(await input.evaluate(input => input.files[0].name), 'new-a.md');
    const afterError = await hold(uploadUrl); await upload.click(); await afterError.waiting; interceptedUploads++;
    assert.equal(uploadRequests, beforeAttempt + 1); await afterError.release();
    await navigate(sourcePath(1)); await input.setInputFiles({ name: 'b.md', mimeType: 'text/markdown', buffer: Buffer.from('# Source B\n\nImmutable native text B replacement ' + viewport.width + ' ' + project) });
    // Changing only the revision URL must not release the source's pending write lock.
    pending = await hold(uploadUrl); await upload.click(); await pending.waiting; interceptedUploads++;
    await navigate(sourcePath(1) + '?revisionId=' + sources[1].source.currentRevisionId); await expect(input).toBeDisabled(); await expect(page.getByRole('button', { name: /Uploading new revision/ })).toBeDisabled();
    await pending.release({ error: { message: 'Old replacement failure' } }, 503); await expect(input).toBeEnabled(); await expect(page.getByText('Old replacement failure')).toHaveCount(0); assert.equal(await input.evaluate(input => input.files[0].name), 'b.md');
    // In-view native Markdown replacement keeps intentional navigation and renders its real stored revision.
    allowNativeUpload = true;
    const uploaded = page.waitForResponse(response => response.url() === uploadUrl && response.request().method() === 'POST');
    await upload.click(); const response = await uploaded; assert.equal(response.status(), 202); const body = await response.json(); nativeUploads++;
    await expect(page).toHaveURL(origin + sourcePath(1) + '?revisionId=' + body.revisionId);
    await expect(page.locator('.er-lib__text')).toContainText('B replacement'); await expect(upload).toBeDisabled();
    const stored = await api('/api/sources/' + sources[1].source.id); assert.equal(stored.source.conversionCalls, 0);
    assert.equal(stored.revisions.length, sources[1].revisions.length + 1); sources[1] = stored;
    await context.close();
  }
} finally { await browser.close(); }
assert.equal(unexpectedTurns, 0, 'Departed chat creation must never dispatch a turn; unmatched POSTs are blocked.');
assert.equal(unexpectedUploads, 0, 'A pending source replacement must not dispatch a duplicate POST after remount.');
for (const id of chats) assert.deepEqual((await api('/api/projects/' + project + '/chats/' + id + '/turns')).turns, [], 'Intercepted Send must not create a stored execution.');
for (const original of sources) {
  const current = await api('/api/sources/' + original.source.id);
  assert.deepEqual(current.revisions, original.revisions, 'Intercepted uploads/read navigation must not change stored revisions.');
}
console.log(JSON.stringify({ scope: 'K1_K2_VIEW_ISOLATION', viewports: ['desktop', 'phone'], interceptedTurns, interceptedUploads, nativeUploads, modelCalls: 0, fullK2Accepted: false }));
