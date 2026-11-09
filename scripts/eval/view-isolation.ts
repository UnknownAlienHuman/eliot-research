// Actual reused workspace against the local Worker. Model POSTs are intercepted before dispatch.
import assert from 'node:assert/strict';
import { chromium, expect, type Route, type WebSocketRoute } from '@playwright/test';
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
const scopeChat = (await api('/api/projects/' + project + '/chats', { title: 'Socket scope recovery' })).chat.id;
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
  for (const viewport of [{ width: 1180, height: 757 }, { width: 390, height: 844 }]) {
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
    const observe = async (scenario, arrival, trigger, diagnose?: (scenario: string) => Promise<void>) => {
      const [arrived, action] = await Promise.allSettled([arrival, Promise.resolve().then(trigger)]);
      if (action.status === 'rejected' || arrived.status === 'rejected') {
        const errors = [];
        if (action.status === 'rejected') errors.push(action.reason);
        if (arrived.status === 'rejected') errors.push(arrived.reason);
        try { await diagnose?.(scenario); } catch (error) { errors.push(error); }
        throw new AggregateError(errors, scenario + ' [' + viewport.width + 'x' + viewport.height + ']');
      }
      return arrived.value;
    };
    // Hold a single response; the request has happened, but its continuation has not.
    const hold = async (scenario, url, method = 'POST') => {
      let resolve, route;
      const waiting = new Promise<void>((done, reject) => {
        const timer = setTimeout(() => reject(new Error('Request did not arrive [' + viewport.width + 'x' + viewport.height + ' ' + scenario + ']: ' + method + ' ' + url)), 10000);
        resolve = () => { clearTimeout(timer); done(); };
      });
      // Handle setup gaps without replacing the rejected waiter consumed by observe.
      void waiting.catch(() => {});
      const handler = async incoming => { if (incoming.request().method() !== method) return incoming.continue(); if (route) return incoming.fallback(); route = incoming; resolve(); };
      await page.route(url, handler);
      return { during: (trigger, diagnose?: (scenario: string) => Promise<void>) => observe(scenario, waiting, trigger, diagnose), body: () => route.request().postDataJSON(), request: () => route.request(),
        release: async (body?, status = 200) => {
          const reply = body ?? (method === 'POST' && url.endsWith('/turns') ? { turnId: route.request().postDataJSON().turnId }
            : method === 'POST' && url.endsWith('/sources/file') ? await replacementReceipt(route.request()) : {});
          await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(reply) }).catch(() => {});
          await page.unroute(url, handler); await settle();
        } };
    };
    // A socket may restore readable history while the parallel HTTP head is still pending.
    // Send must already use the saved source scope, including an intentionally empty scope.
    const scopeSockets = new Set<WebSocketRoute>();
    let scopeSnapshot: string | undefined;
    await page.routeWebSocket(url => url.pathname === '/agents/chat-agent/' + scopeChat, socket => {
      scopeSockets.add(socket);
      socket.onClose(() => { scopeSockets.delete(socket); });
      // Like the actual ChatAgent, replay its current snapshot to each connection.
      // StrictMode may retire the first socket before the fixture is released.
      if (scopeSnapshot !== undefined) socket.send(scopeSnapshot);
    });
    const scopeHistoryUrl = origin + '/api/projects/' + project + '/chats/' + scopeChat;
    let scopeHeads: Route[] = [], scopeHistoryFailure: string | undefined;
    const failScopeHistory = async (message: string) => {
      scopeHistoryFailure = message;
      await Promise.all(scopeHeads.splice(0).map(route => route.fulfill({ status: 503,
        json: { error: { message } } }).catch(() => {})));
      await settle();
    };
    // StrictMode can abort the first GET and issue another. Hold every head read;
    // a fallback 200 would hide the deliberate failure and leave no Retry action.
    await page.route(scopeHistoryUrl, route => {
      if (route.request().method() !== 'GET') return route.continue();
      if (scopeHistoryFailure) return route.fulfill({ status: 503,
        json: { error: { message: scopeHistoryFailure } } }).catch(() => {});
      scopeHeads.push(route);
    });
    for (const journey of ['explicit', 'empty', 'retry empty']) {
      const scopeMode = journey === 'explicit' ? 'explicit' : 'empty';
      const storedScopeMode = journey === 'retry empty' ? 'explicit' : scopeMode;
      scopeSockets.clear(); scopeSnapshot = undefined;
      scopeHeads = []; scopeHistoryFailure = undefined;
      await page.goto(origin + chatPath(scopeChat));
      await expect.poll(() => scopeHeads.length, { message: journey + ': initial history requested' }).toBeGreaterThan(0);
      await expect.poll(() => scopeSockets.size).toBeGreaterThan(0);
      if (journey === 'retry empty') {
        await failScopeHistory('Initial history unavailable');
        const retry = page.getByRole('button', { name: 'Retry', exact: true });
        await expect(retry).toBeVisible();
        await navigate('/p/' + project + '/sources');
        for (const title of ['Source A', 'Source B'])
          await page.getByRole('checkbox', { name: 'Include ' + title + ' in the current source selection', exact: true }).uncheck();
        await navigate(chatPath(scopeChat));
        await expect(retry).toBeVisible();
        scopeHeads = []; scopeHistoryFailure = undefined;
        await retry.click();
        await expect.poll(() => scopeHeads.length, { message: 'Explicit Retry requested history' }).toBeGreaterThan(0);
      }
      const sourceIds = storedScopeMode === 'explicit' ? [sources[0].source.id] : [];
      // Deterministically exercise the gap between a retired socket and its
      // replacement, rather than relying on StrictMode scheduling to expose it.
      if (journey === 'explicit') {
        for (const socket of [...scopeSockets]) { await socket.close(); scopeSockets.delete(socket); }
      }
      scopeSnapshot = JSON.stringify({ type: 'snapshot', nextCursor: null, queued: null, stateVersion: 1,
        turns: [{ turnId: 'scope-fixture', question: 'Scoped saved question', answer: 'Scoped saved answer', state: 'completed',
          createdAt: 1, historyVersion: 1, model: 'fixture', scopeMode: storedScopeMode, sourceIds, revisionIds: [], citations: [], invalidLabels: 0,
          inputTokens: 0, cachedTokens: 0, outputTokens: 0, tokenLimit: 0, firstTokenMs: null, totalMs: 0, error: null }] });
      for (const socket of scopeSockets) socket.send(scopeSnapshot);
      await expect(page.getByText('Scoped saved answer', { exact: true })).toBeVisible();
      await question.fill('Follow up before HTTP');
      const scopedSend = await hold('socket scope Send: ' + journey, turnsUrl(scopeChat)); await scopedSend.during(() => send.click()); interceptedTurns++;
      assert.equal(scopedSend.body().scopeMode, scopeMode);
      assert.deepEqual(scopedSend.body().sourceIds, scopeMode === 'explicit' ? sourceIds : undefined);
      await scopedSend.release();
      await failScopeHistory('Parallel history unavailable');
      await expect(page.getByText('Parallel history unavailable', { exact: true })).toHaveCount(0);
    }
    await page.unroute(scopeHistoryUrl);
    // New chat is an explicit new identity even before the first Send has
    // navigated away from the blank route. Native creation stays storage-only.
    const createUrl = origin + '/api/projects/' + project + '/chats';
    await page.goto(origin + chatPath()); await question.fill('Unconfirmed first question');
    const failedCreation = await hold('first Send creation', createUrl);
    await failedCreation.during(() => send.click());
    const failedTurn = await hold('first Send turn after creation', turnsUrl(failedCreation.body().id));
    await failedTurn.during(async () => failedCreation.release(await api('/api/projects/' + project + '/chats', failedCreation.body()))); interceptedTurns++;
    await failedTurn.release({ error: { message: 'First question reply unavailable' } }, 503);
    await expect(page.getByRole('alert')).toContainText('First question reply unavailable');
    await page.getByText('History', { exact: true }).click();
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(question).toHaveValue('Unconfirmed first question');
    // Cancel keeps History open. Close its overlay before reaching the composer,
    // especially on phone after the desktop journey has added more saved chats.
    await expect(page.locator('.er-chat__history')).toHaveJSProperty('open', true);
    await page.getByText('History', { exact: true }).click();
    await expect(page.locator('.er-chat__history')).toHaveJSProperty('open', false);
    await expect(send).toBeEnabled();
    const safeReplay = await hold('first Send explicit replay', turnsUrl(failedCreation.body().id));
    await safeReplay.during(() => send.click()); interceptedTurns++;
    assert.deepEqual(safeReplay.body(), failedTurn.body());
    await safeReplay.release({ error: { message: 'First question reply unavailable' } }, 503);
    await expect(page.getByRole('alert')).toContainText('First question reply unavailable');
    await page.getByText('History', { exact: true }).click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(question).toHaveValue('');
    await expect(page.getByText('First question reply unavailable', { exact: true })).toHaveCount(0);
    await question.fill('Fresh conversation');
    const freshCreation = await hold('fresh conversation creation', createUrl);
    await freshCreation.during(() => send.click());
    assert.notEqual(freshCreation.body().id, failedCreation.body().id);
    const freshTurn = await hold('fresh conversation turn after creation', turnsUrl(freshCreation.body().id));
    await freshTurn.during(async () => freshCreation.release(await api('/api/projects/' + project + '/chats', freshCreation.body()))); interceptedTurns++;
    assert.notEqual(freshTurn.body().turnId, failedTurn.body().turnId);
    await freshTurn.release(); await expect(page).toHaveURL(origin + chatPath(freshCreation.body().id));
    // A late creation response cannot dispatch its abandoned question or release
    // a newer Send that is still waiting for its own receipt.
    await page.goto(origin + chatPath()); await question.fill('Pending abandoned creation');
    const abandonedCreation = await hold('abandoned creation', createUrl);
    await abandonedCreation.during(() => send.click());
    await page.getByText('History', { exact: true }).click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(question).toHaveValue(''); await question.fill('New pending conversation');
    const nextCreation = await hold('new creation while old pending', createUrl);
    await nextCreation.during(() => send.click());
    assert.notEqual(nextCreation.body().id, abandonedCreation.body().id);
    await abandonedCreation.release(await api('/api/projects/' + project + '/chats', abandonedCreation.body()));
    await expect(page).toHaveURL(origin + chatPath()); await expect(question).toHaveValue('New pending conversation');
    await expect(page.getByRole('button', { name: 'Sending…', exact: true })).toBeDisabled();
    const nextTurn = await hold('new turn after pending creation', turnsUrl(nextCreation.body().id));
    await nextTurn.during(async () => nextCreation.release(await api('/api/projects/' + project + '/chats', nextCreation.body()))); interceptedTurns++; await nextTurn.release();
    await expect(page).toHaveURL(origin + chatPath(nextCreation.body().id));
    // A first-page read started before chat creation must not erase the new row.
    const oldHead = await api('/api/projects/' + historyProject + '/chats');
    let heads = [];
    const captureHead = route => { if (route.request().method() === 'GET') heads.push(route); else return route.continue(); };
    await page.route(historyUrl, captureHead);
    await page.goto(origin + '/p/' + historyProject + '/chat'); await expect.poll(() => heads.length).toBeGreaterThan(0);
    const createdTurn = await hold('new turn during initial history', historyUrl + '/*/turns');
    await createdTurn.during(async () => { await question.fill('New chat during initial history'); await send.click(); }); interceptedTurns++;
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
    let olderRead = await hold('history older-page failure', olderUrl, 'GET');
    await olderRead.during(() => page.getByRole('button', { name: 'Load more chats', exact: true }).click());
    await olderRead.release({ error: { message: 'History page unavailable' } }, 503);
    await expect(historyLinks).toHaveCount(51);
    await expect(page.getByRole('alert')).toContainText('History page unavailable');
    olderRead = await hold('history older-page retry', olderUrl, 'GET');
    await olderRead.during(() => page.getByRole('button', { name: 'Load more chats', exact: true }).click()); await olderRead.release(older);
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
    olderRead = await hold('history older-page abandoned workspace', historyUrl + '?cursor=' + encodeURIComponent(freshHead.nextCursor), 'GET');
    await olderRead.during(() => page.getByRole('button', { name: 'Load more chats', exact: true }).click());
    await navigate('/settings'); await navigate('/p/' + historyProject + '/chat/' + createdId);
    await olderRead.release({ error: { message: 'Abandoned history page' } }, 503);
    await expect(historyLinks).toHaveCount(50); await expect(page.getByText('Abandoned history page')).toHaveCount(0);
    await page.goto(origin + chatPath(chats[0]));
    const controls = page.getByRole('button', { name: /^Sources and model:/ });
    await expect(controls).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('combobox', { name: 'Model: provider', exact: true })).toBeHidden();
    await controls.focus(); await page.keyboard.press('Enter');
    await expect(controls).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('combobox', { name: 'Model: provider', exact: true })).toBeVisible();
    await question.fill('Draft before collapsing controls'); await controls.click();
    await expect(controls).toHaveAttribute('aria-expanded', 'false');
    await expect(controls).toBeFocused();
    await expect(question).toHaveValue('Draft before collapsing controls');
    await question.fill('A original'); await expect(send).toBeEnabled();
    let pending = await hold('A Send before B', turnsUrl(chats[0])); await pending.during(() => send.click()); interceptedTurns++;
    assert.equal(pending.body().question, 'A original');
    await navigate(chatPath(chats[1])); await question.fill('B new draft'); await expect(send).toBeEnabled();
    const b = await hold('B Send while A pending', turnsUrl(chats[1])); await b.during(() => send.click()); interceptedTurns++;
    await pending.release(); await expect(question).toHaveValue('B new draft'); await expect(page.getByRole('button', { name: /Sending/ })).toBeDisabled();
    await b.release({ error: { message: 'B own failure' } }, 503); await expect(page.getByRole('alert')).toContainText('B own failure'); await expect(send).toBeEnabled();
    // A -> B -> A must not grant the old A response ownership again, including errors.
    await navigate(chatPath(chats[0])); await question.fill('A departure');
    pending = await hold('A Send before A-B-A', turnsUrl(chats[0])); await pending.during(() => send.click()); interceptedTurns++;
    await navigate(chatPath(chats[1])); await navigate(chatPath(chats[0])); await question.fill('A returned draft');
    await pending.release({ error: { message: 'Old A failure' } }, 503); await expect(question).toHaveValue('A returned draft'); await expect(page.getByText('Old A failure')).toHaveCount(0);
    // Same-view editing survives acknowledgement. A hidden mounted chat cannot redirect from Sources.
    pending = await hold('A Send with same-view draft edit', turnsUrl(chats[0])); await pending.during(() => send.click()); interceptedTurns++;
    await question.fill('Edited during Send'); await pending.release(); await expect(question).toHaveValue('Edited during Send');
    pending = await hold('A Send before Source B navigation', turnsUrl(chats[0])); await pending.during(() => send.click()); interceptedTurns++;
    await navigate(sourcePath(1)); await expect(page.getByRole('heading', { name: 'Source B', exact: true })).toBeVisible();
    await pending.release(); await expect(page).toHaveURL(origin + sourcePath(1)); await navigate(chatPath(chats[0])); await expect(question).toHaveValue('Edited during Send');
    // Creation response after departure cannot admit a new question. Successful first Send may navigate,
    // but retains draft and source selection edited while its turn acknowledgement was pending.
    await page.goto(origin + chatPath()); await question.fill('Create then leave');
    const creates = origin + '/api/projects/' + project + '/chats';
    pending = await hold('creation before departure', creates); await pending.during(() => send.click());
    await navigate(sourcePath(1)); await pending.release(await api('/api/projects/' + project + '/chats', pending.body())); await expect(page).toHaveURL(origin + sourcePath(1));
    await page.goto(origin + chatPath()); await question.fill('Created Send then leave');
    const departedCreate = await hold('creation before submitted departure', creates); await departedCreate.during(() => send.click());
    pending = await hold('turn before submitted departure', turnsUrl(departedCreate.body().id)); await pending.during(async () => departedCreate.release(await api('/api/projects/' + project + '/chats', departedCreate.body()))); interceptedTurns++;
    await navigate(sourcePath(1)); await pending.release(); await expect(page).toHaveURL(origin + sourcePath(1));
    await page.goto(origin + chatPath()); await question.fill('First question');
    const create = await hold('first Send preserving next draft creation', creates); await create.during(() => send.click());
    const acknowledgedChatId = create.body().id;
    pending = await hold('first Send preserving next draft turn', turnsUrl(acknowledgedChatId)); await pending.during(async () => create.release(await api('/api/projects/' + project + '/chats', create.body()))); interceptedTurns++;
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
    const lostSave = await hold('Save reply lost', saveUrl);
    await lostSave.during(() => page.getByRole('button', { name: 'Save as page', exact: true }).click());
    await lostSave.release({ error: { message: 'Save reply lost' } }, 503);
    await expect(page.getByText('Save reply lost', { exact: true })).toBeVisible();
    const retriedSave = await hold('Save explicit replay', saveUrl);
    await retriedSave.during(() => page.getByRole('button', { name: 'Save as page', exact: true }).click());
    assert.deepEqual(retriedSave.body(), lostSave.body()); await retriedSave.release();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    // Save has a project-wide inventory effect, but its local notice belongs only to its original view.
    let pageReads = 0;
    const pagesUrl = origin + '/api/projects/' + project + '/pages';
    await page.route(pagesUrl, route => { pageReads++; return route.continue(); });
    const saved = await hold('Save before chat switch', saveUrl);
    await saved.during(() => page.getByRole('button', { name: 'Save as page', exact: true }).click());
    assert.notEqual(saved.body().mutationId, lostSave.body().mutationId, 'A Save after confirmation remains a new copy.');
    await navigate(chatPath(chats[1])); const readsBefore = pageReads; await saved.release();
    await expect.poll(() => pageReads).toBeGreaterThan(readsBefore); await expect(page.getByText('Saved.', { exact: true })).toHaveCount(0); await page.unroute(pagesUrl);
    await navigate(chatPath(chats[0])); await question.fill('Before unmount');
    // Project change/unmount: no navigation or error may reach the new workspace.
    pending = await hold('Send before project unmount', turnsUrl(chats[0])); await pending.during(() => send.click()); interceptedTurns++;
    await navigate('/p/' + other + '/chat'); await question.fill('Other project draft');
    await pending.release({ error: { message: 'Unmounted failure' } }, 503); await expect(question).toHaveValue('Other project draft'); await expect(page.getByText('Unmounted failure')).toHaveCount(0);

    const metaUrl = origin + '/api/sources/' + sources[0].source.id;
    // Metadata from A cannot overwrite B, nor A after A -> B -> A.
    pending = await hold('Source A metadata before A-B-A', metaUrl, 'GET'); await pending.during(() => navigate(sourcePath(0)));
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
    pending = await hold('Source A text before source switch', textUrl, 'GET'); await pending.during(async () => { await navigate(sourcePath(1)); await navigate(sourcePath(0)); });
    await navigate(sourcePath(1)); await expect(page.locator('.er-lib__text')).toContainText('Source B'); await pending.release(); await expect(page.locator('.er-lib__text')).toContainText('Source B');
    // Replacement remains bound to A. Switching source clears the React File and native file input.
    const uploadUrl = origin + '/api/projects/' + project + '/sources/file';
    const input = page.getByLabel('Replace source file', { exact: true });
    const upload = page.getByRole('button', { name: 'Upload new revision', exact: true });
    const selectReplacement = async (file, expectedPath, sourceIndex) => {
      const selectedInput = await input.elementHandle();
      await input.setInputFiles(file);
      const snapshot = () => page.evaluate(({ selectedInput }) => {
        const currentInput = document.querySelector<HTMLInputElement>('#er-lib-replace');
        const inspect = (node: HTMLInputElement | null) => {
          if (!node) return null;
          const reader = node.closest('.er-lib'), button = node.form?.querySelector<HTMLButtonElement>('button[type="submit"]');
          return { isConnected: node.isConnected, disabled: node.disabled, fileCount: node.files?.length ?? 0,
            fileNames: Array.from(node.files ?? [], file => file.name), readerTitle: reader?.querySelector('.er-lib__title')?.textContent ?? null,
            originalHref: reader?.querySelector('a[href$="/original"]')?.getAttribute('href') ?? null,
            button: button ? { text: button.textContent, disabled: button.disabled } : null };
        };
        return { path: location.pathname + location.search, routeProjectId: location.pathname.split('/')[2], routeSourceId: location.pathname.split('/')[4],
          currentIsSameNode: selectedInput?.isSameNode(currentInput) ?? false,
          selectedInput: inspect(selectedInput as HTMLInputElement | null), currentInput: inspect(currentInput) };
      }, { selectedInput }).catch(error => ({ snapshotError: String(error) }));
      const afterSetInputFiles = await snapshot();
      const expected = { path: expectedPath, projectId: expectedPath.split('/')[2], sourceId: sources[sourceIndex].source.id,
        title: sources[sourceIndex].source.title, revisionId: sources[sourceIndex].source.currentRevisionId };
      return async scenario => { console.error(JSON.stringify({ scope: 'K1_K2_REPLACEMENT_STATE', scenario, viewport, expected,
        afterSetInputFiles, observeFailure: await snapshot() })); };
    };
    let replacementDiagnostic;
    await navigate(sourcePath(0)); replacementDiagnostic = await selectReplacement({ name: 'a.md', mimeType: 'text/markdown', buffer: Buffer.from('A replacement') }, sourcePath(0), 0);
    pending = await hold('replace A initial', uploadUrl); await pending.during(() => upload.click(), replacementDiagnostic); interceptedUploads++;
    assert(pending.request().postData().includes(sources[0].source.id));
    await navigate(sourcePath(1)); await expect(input).toBeEnabled(); assert.equal(await input.evaluate(input => input.files.length), 0); await expect(upload).toBeDisabled();
    replacementDiagnostic = await selectReplacement({ name: 'b.md', mimeType: 'text/markdown', buffer: Buffer.from('# Source B\n\nImmutable native text B replacement ' + viewport.width + ' ' + project) }, sourcePath(1), 1);
    const independentB = await hold('replace B while A pending', uploadUrl); await independentB.during(() => upload.click(), replacementDiagnostic); interceptedUploads++;
    assert(independentB.request().postData().includes(sources[1].source.id));
    await navigate(sourcePath(0)); await expect(input).toBeDisabled();
    // Force a file/change and form submission even through disabled controls: the synchronous source
    // lock must reject the second POST as well as making it unavailable through ordinary UI actions.
    replacementDiagnostic = await selectReplacement({ name: 'returned-a.md', mimeType: 'text/markdown', buffer: Buffer.from('Returned A') }, sourcePath(0), 0);
    let beforeAttempt = uploadRequests;
    await input.locator('..').evaluate(form => form.requestSubmit()); await settle(); assert.equal(uploadRequests, beforeAttempt);
    await pending.release(await replacementReceipt(pending.request())); await expect(input).toBeEnabled();
    await expect(page).toHaveURL(origin + sourcePath(0)); assert.equal(await input.evaluate(input => input.files[0].name), 'returned-a.md');
    const afterSuccess = await hold('replace A after success', uploadUrl); await afterSuccess.during(() => upload.click(), replacementDiagnostic); interceptedUploads++;
    assert.equal(uploadRequests, beforeAttempt + 1); await afterSuccess.release();
    await navigate(sourcePath(1)); await expect(input).toBeDisabled(); // A's settlement cannot release B.
    await independentB.release({ error: { message: 'Departed B failure' } }, 503); await expect(input).toBeEnabled();
    await expect(page.getByText('Departed B failure')).toHaveCount(0);
    await navigate(sourcePath(0)); replacementDiagnostic = await selectReplacement({ name: 'old-a.md', mimeType: 'text/markdown', buffer: Buffer.from('Old A') }, sourcePath(0), 0);
    pending = await hold('replace A before remount', uploadUrl); await pending.during(() => upload.click(), replacementDiagnostic); interceptedUploads++;
    await navigate(sourcePath(1)); await navigate(sourcePath(0)); await expect(input).toBeDisabled();
    await navigate(chatPath(chats[0])); await navigate(sourcePath(0)); await expect(input).toBeDisabled();
    replacementDiagnostic = await selectReplacement({ name: 'new-a.md', mimeType: 'text/markdown', buffer: Buffer.from('New A') }, sourcePath(0), 0);
    beforeAttempt = uploadRequests;
    await input.locator('..').evaluate(form => form.requestSubmit()); await settle(); assert.equal(uploadRequests, beforeAttempt);
    await pending.release({ error: { message: 'Departed replacement failure' } }, 503);
    await expect(input).toBeEnabled(); await expect(page.getByText('Departed replacement failure')).toHaveCount(0); assert.equal(await input.evaluate(input => input.files[0].name), 'new-a.md');
    const afterError = await hold('replace A after error', uploadUrl); await afterError.during(() => upload.click(), replacementDiagnostic); interceptedUploads++;
    assert.equal(uploadRequests, beforeAttempt + 1); await afterError.release();
    // ProjectWorkspace itself is keyed/unmounted on project and Settings navigation. App must retain
    // only the pending project/source key, permit another project/source, and clean up while away.
    const otherSourcePath = '/p/' + other + '/source/' + sources[0].source.id;
    const otherUploadUrl = origin + '/api/projects/' + other + '/sources/file';
    for (const status of [200, 503]) {
      await navigate(sourcePath(0)); replacementDiagnostic = await selectReplacement({ name: 'away-a.md', mimeType: 'text/markdown', buffer: Buffer.from('Away A') }, sourcePath(0), 0);
      const awayA = await hold('replace A across Settings/project: ' + status, uploadUrl); await awayA.during(() => upload.click(), replacementDiagnostic); interceptedUploads++;
      await navigate('/settings'); await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
      await navigate(sourcePath(0)); await expect(input).toBeDisabled();
      replacementDiagnostic = await selectReplacement({ name: 'duplicate-a.md', mimeType: 'text/markdown', buffer: Buffer.from('Duplicate A') }, sourcePath(0), 0);
      beforeAttempt = uploadRequests; await input.locator('..').evaluate(form => form.requestSubmit()); await settle(); assert.equal(uploadRequests, beforeAttempt);
      await navigate(otherSourcePath); await expect(input).toBeEnabled();
      replacementDiagnostic = await selectReplacement({ name: 'other-a.md', mimeType: 'text/markdown', buffer: Buffer.from('Other project A') }, otherSourcePath, 0);
      const otherA = await hold('replace other-project A while original pending: ' + status, otherUploadUrl); await otherA.during(() => upload.click(), replacementDiagnostic); interceptedUploads++;
      assert(otherA.request().postData().includes(sources[0].source.id));
      await navigate(sourcePath(1)); await expect(input).toBeEnabled(); // Independent source in original project.
      await navigate(sourcePath(0)); await expect(input).toBeDisabled(); // Project switch did not release original A.
      replacementDiagnostic = await selectReplacement({ name: 'duplicate-again.md', mimeType: 'text/markdown', buffer: Buffer.from('Duplicate again') }, sourcePath(0), 0);
      beforeAttempt = uploadRequests; await input.locator('..').evaluate(form => form.requestSubmit()); await settle(); assert.equal(uploadRequests, beforeAttempt);
      await navigate('/settings');
      await awayA.release(status === 200 ? await replacementReceipt(awayA.request()) : { error: { message: 'Away replacement error' } }, status);
      await navigate(sourcePath(0)); await expect(input).toBeEnabled(); await expect(page.getByText('Away replacement error')).toHaveCount(0);
      replacementDiagnostic = await selectReplacement({ name: 'after-away.md', mimeType: 'text/markdown', buffer: Buffer.from('After away') }, sourcePath(0), 0);
      const retryA = await hold('replace A after away settlement: ' + status, uploadUrl); await retryA.during(() => upload.click(), replacementDiagnostic); interceptedUploads++;
      assert.equal(uploadRequests, beforeAttempt + 1); await retryA.release();
      await navigate(otherSourcePath); await expect(input).toBeDisabled(); // Original project's cleanup cannot release this pair.
      await navigate('/settings'); await otherA.release({ error: { message: 'Other project upload error' } }, 503);
      await navigate(otherSourcePath); await expect(input).toBeEnabled(); await expect(page.getByText('Other project upload error')).toHaveCount(0);
      replacementDiagnostic = await selectReplacement({ name: 'other-after.md', mimeType: 'text/markdown', buffer: Buffer.from('Other after') }, otherSourcePath, 0);
      const retryOther = await hold('replace other-project A after away error: ' + status, otherUploadUrl); await retryOther.during(() => upload.click(), replacementDiagnostic); interceptedUploads++; await retryOther.release();
      await navigate('/'); await navigate(otherSourcePath); await expect(input).toBeEnabled();
      await navigate(sourcePath(0)); await expect(input).toBeEnabled();
    }
    await navigate(sourcePath(1)); replacementDiagnostic = await selectReplacement({ name: 'b.md', mimeType: 'text/markdown', buffer: Buffer.from('# Source B\n\nImmutable native text B replacement ' + viewport.width + ' ' + project) }, sourcePath(1), 1);
    // Changing only the revision URL must not release the source's pending write lock.
    pending = await hold('replace B before revision navigation', uploadUrl); await pending.during(() => upload.click(), replacementDiagnostic); interceptedUploads++;
    await navigate(sourcePath(1) + '?revisionId=' + sources[1].source.currentRevisionId); await expect(input).toBeDisabled(); await expect(page.getByRole('button', { name: /Uploading new revision/ })).toBeDisabled();
    await pending.release({ error: { message: 'Old replacement failure' } }, 503); await expect(input).toBeEnabled(); await expect(page.getByText('Old replacement failure')).toHaveCount(0); assert.equal(await input.evaluate(input => input.files[0].name), 'b.md');
    // In-view native Markdown replacement keeps intentional navigation and renders its real stored revision.
    allowNativeUpload = true;
    const response = await observe('native replacement B', page.waitForResponse(response => response.url() === uploadUrl && response.request().method() === 'POST'), () => upload.click(), replacementDiagnostic);
    assert.equal(response.status(), 202); const body = await response.json(); nativeUploads++;
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
        const next = await observe('confirmed replacement after replay: ' + outcome, page.waitForResponse(response => response.url() === uploadUrl && response.request().method() === 'POST'), () => upload.click());
        const receipt = await next.json(); nativeUploads++;
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
