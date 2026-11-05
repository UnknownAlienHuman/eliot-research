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
const replacementReceipt = async request => {
  const form = await new Request(request.url(), { method: 'POST', headers: request.headers(), body: request.postDataBuffer() }).formData();
  return { sourceId: String(form.get('sourceId')), revisionId: String(form.get('revisionId')) };
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
await api('/api/projects/' + other + '/sources/attach', { sourceId: sources[0].source.id });
const chatPath = id => '/p/' + project + '/chat' + (id ? '/' + id : '');
const sourcePath = i => '/p/' + project + '/source/' + sources[i].source.id;
const turnsUrl = id => origin + '/api/projects/' + project + '/chats/' + id + '/turns';
const historyProject = (await api('/api/projects', { title: 'History race ' + crypto.randomUUID() })).project.id;
const historyUrl = origin + '/api/projects/' + historyProject + '/chats';
for (let index = 0; index < 54; index++) await api('/api/projects/' + historyProject + '/chats', { title: 'History ' + index });
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
        release: async (body?, status = 200) => {
          const reply = body ?? (method === 'POST' && url.endsWith('/turns') ? { turnId: route.request().postDataJSON().turnId }
            : method === 'POST' && url.endsWith('/sources/file') ? await replacementReceipt(route.request()) : {});
          await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(reply) }).catch(() => {});
          await page.unroute(url, handler); await settle();
        } };
    };
    // A first-page read started before chat creation must not erase the new row.
    const oldHead = await api('/api/projects/' + historyProject + '/chats');
    let heads = [];
    const captureHead = route => { if (route.request().method() === 'GET') heads.push(route); else return route.continue(); };
    await page.route(historyUrl, captureHead);
    await page.goto(origin + '/p/' + historyProject + '/chat'); await expect.poll(() => heads.length).toBeGreaterThan(0);
    const createdTurn = await hold(historyUrl + '/*/turns');
    await question.fill('New chat during initial history'); await send.click(); await createdTurn.waiting; interceptedTurns++;
    const createdId = new URL(createdTurn.request().url()).pathname.split('/').at(-2);
    await Promise.all(heads.map(route => route.fulfill({ json: oldHead }).catch(() => {})));
    await page.unroute(historyUrl, captureHead); await settle();
    await page.getByText('History', { exact: true }).click();
    const historyLinks = page.locator('.er-chat__history-link');
    await expect(page.locator('.er-chat__history-link[href="/p/' + historyProject + '/chat/' + createdId + '"]')).toHaveCount(1);
    await createdTurn.release();
    await expect(page).toHaveURL(origin + '/p/' + historyProject + '/chat/' + createdId);
    const olderUrl = historyUrl + '?cursor=' + encodeURIComponent(oldHead.nextCursor);
    const older = await api('/api/projects/' + historyProject + '/chats?cursor=' + encodeURIComponent(oldHead.nextCursor));
    let olderRead = await hold(olderUrl, 'GET');
    await page.getByRole('button', { name: 'Load more chats', exact: true }).click(); await olderRead.waiting;
    await olderRead.release({ error: { message: 'History page unavailable' } }, 503);
    await expect(historyLinks).toHaveCount(51);
    await expect(page.getByRole('alert')).toContainText('History page unavailable');
    olderRead = await hold(olderUrl, 'GET');
    await page.getByRole('button', { name: 'Load more chats', exact: true }).click(); await olderRead.waiting; await olderRead.release(older);
    const allIds = await historyLinks.evaluateAll(links => links.map(link => link.getAttribute('href')));
    assert.deepEqual(allIds, [createdId, ...oldHead.chats.map(chat => chat.id), ...older.chats.map(chat => chat.id)]
      .map(id => '/p/' + historyProject + '/chat/' + id));
    // A failed initial read has an explicit storage-only retry.
    heads = []; await page.route(historyUrl, captureHead); await page.reload(); await expect.poll(() => heads.length).toBeGreaterThan(0);
    await Promise.all(heads.map(route => route.fulfill({ status: 503, json: { error: { message: 'Initial history unavailable' } } }).catch(() => {})));
    await page.unroute(historyUrl, captureHead); await settle();
    await page.getByText('History', { exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Initial history unavailable');
    await page.getByRole('button', { name: 'Retry chat history', exact: true }).click();
    await expect(historyLinks).toHaveCount(50);
    // An abandoned older read cannot affect a remounted project workspace.
    const freshHead = await api('/api/projects/' + historyProject + '/chats');
    olderRead = await hold(historyUrl + '?cursor=' + encodeURIComponent(freshHead.nextCursor), 'GET');
    await page.getByRole('button', { name: 'Load more chats', exact: true }).click(); await olderRead.waiting;
    await navigate('/settings'); await navigate('/p/' + historyProject + '/chat/' + createdId);
    await olderRead.release({ error: { message: 'Abandoned history page' } }, 503);
    await expect(historyLinks).toHaveCount(50); await expect(page.getByText('Abandoned history page')).toHaveCount(0);
    await page.goto(origin + chatPath(chats[0]));
    const controls = page.getByRole('button', { name: /^Sources and model:/ });
    if (viewport.width < 768) {
      await expect(controls).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByRole('combobox', { name: 'Model: provider', exact: true })).toBeHidden();
      await controls.focus(); await page.keyboard.press('Enter');
      await expect(controls).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByRole('combobox', { name: 'Model: provider', exact: true })).toBeVisible();
      await question.fill('Draft before collapsing controls'); await controls.click();
      await expect(controls).toHaveAttribute('aria-expanded', 'false');
      await expect(question).toHaveValue('Draft before collapsing controls');
    } else await expect(controls).toBeHidden();
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
    await navigate(sourcePath(1)); await pending.release(await api('/api/projects/' + project + '/chats', pending.body())); await expect(page).toHaveURL(origin + sourcePath(1));
    await page.goto(origin + chatPath()); await question.fill('Created Send then leave');
    const departedCreate = await hold(creates); await send.click(); await departedCreate.waiting;
    pending = await hold(turnsUrl(departedCreate.body().id)); await departedCreate.release(await api('/api/projects/' + project + '/chats', departedCreate.body())); await pending.waiting; interceptedTurns++;
    await navigate(sourcePath(1)); await pending.release(); await expect(page).toHaveURL(origin + sourcePath(1));
    await page.goto(origin + chatPath()); await question.fill('First question');
    const create = await hold(creates); await send.click(); await create.waiting;
    const acknowledgedChatId = create.body().id;
    pending = await hold(turnsUrl(acknowledgedChatId)); await create.release(await api('/api/projects/' + project + '/chats', create.body())); await pending.waiting; interceptedTurns++;
    await question.fill('Next draft');
    const includeA = page.getByRole('checkbox', { name: 'Include Source A in the current source selection', exact: true });
    if (viewport.width > 1000) await includeA.uncheck();
    // A persisted last-turn scope would ordinarily be restored by history hydration.
    const chatUrl = origin + '/api/projects/' + project + '/chats/' + acknowledgedChatId;
    const turn = { turnId: crypto.randomUUID(), question: 'Synthetic saved answer', answer: 'Synthetic answer', state: 'completed',
      createdAt: 1, historyVersion: 1, model: 'fixture', scopeMode: 'project_default', revisionIds: [], sourceIds: [], citations: [], invalidLabels: 0,
      inputTokens: 0, cachedTokens: 0, outputTokens: 0, tokenLimit: 0, firstTokenMs: null, totalMs: 0, error: null };
    const storedChat = await api('/api/projects/' + project + '/chats/' + acknowledgedChatId);
    await page.route(chatUrl, route => route.fulfill({ json: { ...storedChat, turns: [turn] } }));
    await pending.release(); await expect(page).toHaveURL(origin + chatPath(acknowledgedChatId)); await expect(question).toHaveValue('Next draft');
    await expect(page.getByRole('button', { name: 'Save as page', exact: true })).toBeVisible();
    if (viewport.width > 1000) await expect(includeA).not.toBeChecked();
    await page.unroute(chatUrl);
    // Explicit retry after an unreadable/lost response keeps the existing page mutation identity.
    const saveUrl = origin + '/api/projects/' + project + '/pages/from-turn';
    const lostSave = await hold(saveUrl);
    await page.getByRole('button', { name: 'Save as page', exact: true }).click(); await lostSave.waiting;
    await lostSave.release({ error: { message: 'Save reply lost' } }, 503);
    await expect(page.getByText('Save reply lost', { exact: true })).toBeVisible();
    const retriedSave = await hold(saveUrl);
    await page.getByRole('button', { name: 'Save as page', exact: true }).click(); await retriedSave.waiting;
    assert.deepEqual(retriedSave.body(), lostSave.body()); await retriedSave.release();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    // Save has a project-wide inventory effect, but its local notice belongs only to its original view.
    let pageReads = 0;
    const pagesUrl = origin + '/api/projects/' + project + '/pages';
    await page.route(pagesUrl, route => { pageReads++; return route.continue(); });
    const saved = await hold(saveUrl);
    await page.getByRole('button', { name: 'Save as page', exact: true }).click(); await saved.waiting;
    assert.notEqual(saved.body().mutationId, lostSave.body().mutationId, 'A Save after confirmation remains a new copy.');
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
    // A failed pending metadata read is actionable and stops automatic GETs.
    // Explicit Retry resumes a pending read, then normal polling discovers its text.
    let statusReads = 0, statusMode = 'pending';
    await page.route(metaUrl, route => {
      statusReads++;
      if (statusMode === 'error') return route.fulfill({ status: 503, json: { error: { message: 'Source status unavailable' } } });
      const data = statusMode === 'readable' ? sources[0] : { ...sources[0],
        source: { ...sources[0].source, readableState: 'pending' },
        revisions: sources[0].revisions.map(r => ({ ...r, readableState: 'pending' })) };
      if (statusMode === 'retry') statusMode = 'readable';
      return route.fulfill({ json: data });
    });
    await navigate(sourcePath(1)); await navigate(sourcePath(0));
    await expect(page.locator('.er-lib__text')).toBeVisible(); statusMode = 'error';
    await expect(page.getByRole('alert')).toContainText('Source status unavailable', { timeout: 10000 });
    const failedStatusReads = statusReads;
    await page.waitForTimeout(6600); assert.equal(statusReads, failedStatusReads, 'A metadata error must stop automatic polling.');
    statusMode = 'retry';
    await page.getByRole('button', { name: 'Retry source status', exact: true }).click();
    await expect(page.getByText('Source status unavailable', { exact: false })).toHaveCount(0);
    await expect(page.locator('.er-lib__text')).toContainText('Immutable native text', { timeout: 10000 });
    assert.equal(statusReads, failedStatusReads + 2, 'Retry must restore pending polling until readable.');
    await page.unroute(metaUrl);
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
    await pending.release(await replacementReceipt(pending.request())); await expect(input).toBeEnabled();
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
    // ProjectWorkspace itself is keyed/unmounted on project and Settings navigation. App must retain
    // only the pending project/source key, permit another project/source, and clean up while away.
    const otherSourcePath = '/p/' + other + '/source/' + sources[0].source.id;
    const otherUploadUrl = origin + '/api/projects/' + other + '/sources/file';
    for (const status of [200, 503]) {
      await navigate(sourcePath(0)); await input.setInputFiles({ name: 'away-a.md', mimeType: 'text/markdown', buffer: Buffer.from('Away A') });
      const awayA = await hold(uploadUrl); await upload.click(); await awayA.waiting; interceptedUploads++;
      await navigate('/settings'); await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
      await navigate(sourcePath(0)); await expect(input).toBeDisabled();
      await input.setInputFiles({ name: 'duplicate-a.md', mimeType: 'text/markdown', buffer: Buffer.from('Duplicate A') });
      beforeAttempt = uploadRequests; await input.locator('..').evaluate(form => form.requestSubmit()); await settle(); assert.equal(uploadRequests, beforeAttempt);
      await navigate(otherSourcePath); await expect(input).toBeEnabled();
      await input.setInputFiles({ name: 'other-a.md', mimeType: 'text/markdown', buffer: Buffer.from('Other project A') });
      const otherA = await hold(otherUploadUrl); await upload.click(); await otherA.waiting; interceptedUploads++;
      assert(otherA.request().postData().includes(sources[0].source.id));
      await navigate(sourcePath(1)); await expect(input).toBeEnabled(); // Independent source in original project.
      await navigate(sourcePath(0)); await expect(input).toBeDisabled(); // Project switch did not release original A.
      await input.setInputFiles({ name: 'duplicate-again.md', mimeType: 'text/markdown', buffer: Buffer.from('Duplicate again') });
      beforeAttempt = uploadRequests; await input.locator('..').evaluate(form => form.requestSubmit()); await settle(); assert.equal(uploadRequests, beforeAttempt);
      await navigate('/settings');
      await awayA.release(status === 200 ? await replacementReceipt(awayA.request()) : { error: { message: 'Away replacement error' } }, status);
      await navigate(sourcePath(0)); await expect(input).toBeEnabled(); await expect(page.getByText('Away replacement error')).toHaveCount(0);
      await input.setInputFiles({ name: 'after-away.md', mimeType: 'text/markdown', buffer: Buffer.from('After away') });
      const retryA = await hold(uploadUrl); await upload.click(); await retryA.waiting; interceptedUploads++;
      assert.equal(uploadRequests, beforeAttempt + 1); await retryA.release();
      await navigate(otherSourcePath); await expect(input).toBeDisabled(); // Original project's cleanup cannot release this pair.
      await navigate('/settings'); await otherA.release({ error: { message: 'Other project upload error' } }, 503);
      await navigate(otherSourcePath); await expect(input).toBeEnabled(); await expect(page.getByText('Other project upload error')).toHaveCount(0);
      await input.setInputFiles({ name: 'other-after.md', mimeType: 'text/markdown', buffer: Buffer.from('Other after') });
      const retryOther = await hold(otherUploadUrl); await upload.click(); await retryOther.waiting; interceptedUploads++; await retryOther.release();
      await navigate('/'); await navigate(otherSourcePath); await expect(input).toBeEnabled();
      await navigate(sourcePath(0)); await expect(input).toBeEnabled();
    }
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
    // Corrupt only an already accepted response. Explicit retries keep the same
    // File/ID; the server returns its stored revision without another conversion.
    for (const outcome of ['before', 'lost', 'malformed', 'wrong-identity']) {
      const initial = await api('/api/sources/' + sources[1].source.id), receipts = [];
      const text = `# Source B Replay\n\nImmutable native text ${outcome} replacement ${viewport.width} ${project}`;
      const handler = async route => {
        receipts.push(await replacementReceipt(route.request()));
        if (receipts.length === 1 && outcome === 'before') return route.fulfill({ status: 503, json: { error: { message: 'Rejected before dispatch' } } });
        const actual = await route.fetch(); assert.equal(actual.status(), 202); const accepted = await actual.json(); nativeUploads++;
        if (receipts.length === 1) {
          if (outcome === 'lost') return route.abort('failed');
          if (outcome === 'malformed') return route.fulfill({ status: 202, contentType: 'application/json', body: '{broken accepted response' });
          return route.fulfill({ status: 202, json: { ...accepted, revisionId: crypto.randomUUID() } });
        }
        return route.fulfill({ response: actual });
      };
      await page.route(uploadUrl, handler);
      await input.setInputFiles({ name: 'replay.md', mimeType: 'text/markdown', buffer: Buffer.from(text) });
      await upload.click(); await expect(page.locator('.er-lib__error[role="alert"]')).toBeVisible(); await expect(upload).toBeEnabled();
      assert.equal(await input.evaluate(node => node.files[0].name), 'replay.md'); await settle(); assert.equal(receipts.length, 1);
      const afterFailure = await api('/api/sources/' + sources[1].source.id);
      assert.equal(afterFailure.revisions.length, initial.revisions.length + (outcome === 'before' ? 0 : 1));
      await upload.click(); await expect(page).toHaveURL(origin + sourcePath(1) + '?revisionId=' + receipts[0].revisionId);
      await expect(page.locator('.er-lib__text')).toContainText(text.split('\n\n')[1]); await expect(upload).toBeDisabled();
      assert.equal(await input.evaluate(node => node.files.length), 0); assert.deepEqual(receipts[1], receipts[0]);
      await page.unroute(uploadUrl, handler);
      const afterRetry = await api('/api/sources/' + sources[1].source.id);
      assert.equal(afterRetry.revisions.length, initial.revisions.length + 1); assert.equal(afterRetry.source.conversionCalls, 0);
      // Confirmed completion consumes the attempt; selecting that same file anew
      // deliberately creates another revision with a new ID.
      if (outcome === 'malformed') {
        await input.setInputFiles({ name: 'replay.md', mimeType: 'text/markdown', buffer: Buffer.from(text) });
        const accepted = page.waitForResponse(response => response.url() === uploadUrl && response.request().method() === 'POST');
        await upload.click(); const next = await accepted, receipt = await next.json(); nativeUploads++;
        assert.notEqual(receipt.revisionId, receipts[0].revisionId);
        await expect(page.locator('.er-lib__text')).toContainText(text.split('\n\n')[1]); await expect(upload).toBeDisabled();
      }
      sources[1] = await api('/api/sources/' + sources[1].source.id);
    }
    const beforeChangedFile = sources[1].revisions.length, changedReceipts = [];
    const changedHandler = async route => {
      changedReceipts.push(await replacementReceipt(route.request()));
      const response = await route.fetch(); assert.equal(response.status(), 202); nativeUploads++;
      return changedReceipts.length === 1 ? route.fulfill({ status: 202, contentType: 'application/json', body: '{lost accepted identity' }) : route.fulfill({ response });
    };
    await page.route(uploadUrl, changedHandler);
    const oldChangedText = '# Source B\n\nImmutable native text before changed file ' + viewport.width + project;
    await input.setInputFiles({ name: 'change.md', mimeType: 'text/markdown', buffer: Buffer.from(oldChangedText) });
    await upload.click(); await expect(page.locator('.er-lib__error[role="alert"]')).toBeVisible(); await expect(upload).toBeEnabled();
    await expect.poll(async () => (await api('/api/sources/' + sources[1].source.id)).revisions.find(r => r.id === changedReceipts[0].revisionId)?.readableState).toBe('readable');
    const acceptedBeforeChange = (await api('/api/sources/' + sources[1].source.id)).revisions.find(r => r.id === changedReceipts[0].revisionId);
    await input.setInputFiles({ name: 'change.md', mimeType: 'text/markdown', buffer: Buffer.from('# Source B\n\nImmutable native text after changed file ' + viewport.width + project) });
    await upload.click(); await expect(upload).toBeDisabled(); await expect(page.locator('.er-lib__text')).toContainText('after changed file');
    assert.notEqual(changedReceipts[0].revisionId, changedReceipts[1].revisionId);
    await page.unroute(uploadUrl, changedHandler);
    sources[1] = await api('/api/sources/' + sources[1].source.id); assert.equal(sources[1].revisions.length, beforeChangedFile + 2);
    assert.deepEqual(sources[1].revisions.find(r => r.id === changedReceipts[0].revisionId), acceptedBeforeChange);
    for (const suffix of ['original', 'text']) assert.equal(await (await fetchEval(origin + '/api/revisions/' + changedReceipts[0].revisionId + '/' + suffix,
      { headers: { Origin: origin } }, origin, process.env.ELIOT_ORIGIN)).text(), oldChangedText);
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
