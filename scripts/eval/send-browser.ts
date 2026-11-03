// Explicit Send replay through the real workspace; no provider call is permitted.
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { assertEvalBrowserOrigin, fetchEval } from './origin.mjs';

assert(process.env.ELIOT_K2_MODEL !== '1' && process.env.ELIOT_K3_MODEL !== '1');
const origin = assertEvalBrowserOrigin(process.env.ELIOT_URL || 'http://127.0.0.1:5173', process.env.ELIOT_ORIGIN);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname), 'Send replay fixtures are local-only.');
const api = async (path, body?) => {
  const response = await fetchEval(origin + path, { headers: { Origin: origin, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) }, origin, process.env.ELIOT_ORIGIN);
  const data = await response.json(); assert(response.ok, JSON.stringify({ path, status: response.status, data })); return data;
};
const project = (await api('/api/projects', { title: 'Send replay ' + crypto.randomUUID() })).project.id;
const chat = (await api('/api/projects/' + project + '/chats', { title: 'Existing replay chat' })).chat.id;
const chatPath = id => '/p/' + project + '/chat' + (id ? '/' + id : '');
const missingModel = 'gateway:send-replay-synthetic/unavailable';
const alternateModel = 'gateway:send-replay-synthetic/other';
assert(!(await api('/api/models')).models.some(model => [missingModel, alternateModel].includes(model.route)));
const models = [missingModel, alternateModel].map(route => ({ route, id: route.split('/').at(-1), label: route.split('/').at(-1),
  provider: 'send-replay-synthetic', enabled: true, contextTokens: 32768, maxOutputTokens: 1024 }));
const browser = await chromium.launch();
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.fallback() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(origin + '/api/models', route => route.fulfill({ json: { models, warnings: [], defaultModel: missingModel } }));
    const requests = [];
    let outcome = '', createFault = '', held, heldCreate, holdCreate = false, creates = 0, nativePosts = 0, unexpectedWrites = 0;
    const creations = [];
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() === 'GET') return route.fallback();
      if (request.method() === 'POST' && path === '/api/projects/' + project + '/chats') {
        creates++;
        if (createFault === 'before') {
          creations.push({ input: request.postDataJSON(), chat: null, status: 0 });
          return route.abort('failed');
        }
        const response = await route.fetch();
        assert(response.ok());
        const data = await response.json();
        creations.push({ input: request.postDataJSON(), chat: data.chat, status: response.status() });
        if (holdCreate) { heldCreate = { route, response }; return; }
        if (createFault === 'lost') return route.abort('failed');
        if (createFault === 'json') return route.fulfill({ status: 201, contentType: 'application/json', body: '{' });
        if (createFault === 'missing-id') return route.fulfill({ status: 201, json: { chat: { title: 'Missing identity' } } });
        if (createFault === 'wrong-id') return route.fulfill({ status: 201, json: { chat: { ...data.chat, id: crypto.randomUUID() } } });
        return route.fulfill({ response });
      }
      if (request.method() !== 'POST' || !path.endsWith('/turns') || !outcome) {
        unexpectedWrites++; return route.abort('blockedbyclient');
      }
      const body = request.postDataJSON(), mode = outcome;
      outcome = '';
      requests.push({ path, body });
      if (mode === 'hold') { held = route; return; }
      if (mode === 'native-lost' || mode === 'native-ack') {
        // The real server catalogue excludes this model. It fails before provider
        // admission/transport; the browser-only catalogue above changes no settings.
        assert.equal(body.model, missingModel);
        nativePosts++;
        const response = await route.fetch();
        assert.equal(response.status(), 202);
        assert.equal((await response.json()).turnId, body.turnId);
        return mode === 'native-lost' ? route.abort('failed') : route.fulfill({ response });
      }
      if (mode === 'lost') return route.abort('failed');
      if (mode === 'failed') return route.fulfill({ status: 503, json: { error: { message: 'Synthetic uncertain Send' } } });
      if (mode === 'json') return route.fulfill({ status: 202, contentType: 'application/json', body: '{' });
      if (mode === 'missing-id') return route.fulfill({ status: 202, json: {} });
      if (mode === 'wrong-id') return route.fulfill({ status: 202, json: { turnId: crypto.randomUUID() } });
      assert.equal(mode, 'ack');
      return route.fulfill({ status: 202, json: { turnId: body.turnId } });
    });
    const question = page.getByRole('textbox', { name: 'Question', exact: true });
    const send = page.getByRole('button', { name: 'Send', exact: true });
    const currentLink = page.locator('.er-chat__history-link[aria-current="page"]');
    const primary = page.getByRole('navigation', { name: 'Primary', exact: true });
    const submit = async mode => {
      const count = requests.length;
      outcome = mode;
      await send.click();
      await expect.poll(() => requests.length).toBe(count + 1);
      if (mode === 'ack' || mode === 'native-ack') await expect(question).toHaveValue('');
      else if (mode !== 'hold') await expect(send).toBeEnabled();
      return requests.at(-1);
    };
    await page.goto(origin + chatPath(chat));
    await expect(currentLink).toHaveAttribute('href', chatPath(chat));
    for (const mode of ['lost', 'failed', 'json', 'missing-id', 'wrong-id']) {
      const text = 'Unconfirmed question: ' + mode;
      await question.fill(text);
      const first = await submit(mode);
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(question).toHaveValue(text);
      const second = await submit('ack');
      assert.deepEqual(second, first, 'An unchanged explicit retry must retain its original turn ID, input and chat.');
      await expect(question).toHaveValue('');
      await question.fill(text);
      const next = await submit('ack');
      assert.notEqual(next.body.turnId, first.body.turnId, 'A new Send after acknowledgement is a new turn.');
      await expect(question).toHaveValue('');
    }

    // Source navigation keeps this mounted composer's draft. A response owned by
    // the departed visible view must not discard its replay identity either.
    for (const status of [202, 503]) {
      await question.fill('Preserve Send identity while reading sources: ' + status);
      const original = await submit('hold');
      await primary.getByRole('link', { name: 'Sources', exact: true }).click();
      await expect(page).toHaveURL(origin + '/p/' + project + '/sources');
      await held.fulfill({ status, json: status === 202 ? { turnId: original.body.turnId } : { error: { message: 'Departed Send reply' } } });
      await primary.getByRole('link', { name: 'Chat', exact: true }).click();
      await expect(page).toHaveURL(origin + chatPath(chat));
      await expect(question).toHaveValue(original.body.question);
      assert.deepEqual(await submit('ack'), original);
      await expect(question).toHaveValue('');
    }

    await question.fill('Explicit source scope change.');
    const oldScope = await submit('lost');
    await primary.getByRole('link', { name: 'Sources', exact: true }).click();
    await page.getByRole('checkbox', { name: /^Project default/ }).uncheck();
    await primary.getByRole('link', { name: 'Chat', exact: true }).click();
    await expect(page).toHaveURL(origin + chatPath(chat));
    const newScope = await submit('ack');
    assert.notEqual(newScope.body.turnId, oldScope.body.turnId);
    assert.equal(newScope.body.scopeMode, 'empty');

    await question.fill('Original input');
    const beforeEdit = await submit('lost');
    await question.fill('Explicitly changed input');
    const afterEdit = await submit('ack');
    assert.notEqual(afterEdit.body.turnId, beforeEdit.body.turnId);
    assert.equal(afterEdit.body.question, 'Explicitly changed input');
    await expect(question).toHaveValue('');
    await question.fill('Model choice changes the request.');
    const inherited = await submit('lost');
    await page.getByRole('combobox', { name: 'Model: provider', exact: true }).selectOption('send-replay-synthetic');
    await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption(alternateModel);
    const changedModel = await submit('ack');
    assert.notEqual(changedModel.body.turnId, inherited.body.turnId);
    assert.equal(changedModel.body.model, alternateModel);
    assert.deepEqual((await api('/api/projects/' + project + '/chats/' + chat)).turns, []);

    // A create acknowledgement can arrive while Sources owns the visible view.
    // Keep its known row/target for the next explicit Send, including edited input.
    await page.goto(origin + chatPath());
    await expect(page.locator('.er-chat__history-link[href="' + chatPath(chat) + '"]')).toHaveCount(1);
    await question.fill('Creation acknowledged while reading sources.');
    holdCreate = true; outcome = 'ack';
    const beforeCreate = requests.length;
    await send.click();
    await expect.poll(() => Boolean(heldCreate)).toBe(true);
    const lateChat = (await heldCreate.response.json()).chat;
    await primary.getByRole('link', { name: 'Sources', exact: true }).click();
    await expect(page).toHaveURL(origin + '/p/' + project + '/sources');
    await heldCreate.route.fulfill({ response: heldCreate.response });
    holdCreate = false;
    await primary.getByRole('link', { name: 'Chat', exact: true }).click();
    await expect(page).toHaveURL(origin + chatPath());
    await expect(send).toBeEnabled();
    assert.equal(requests.length, beforeCreate, 'A departed create continuation must not send a turn.');
    const knownTarget = await submit('lost');
    assert.equal(knownTarget.path, '/api/projects/' + project + '/chats/' + lateChat.id + '/turns');
    await question.fill('Edited question in the already-created conversation.');
    const changedInNewChat = await submit('ack');
    assert.notEqual(changedInNewChat.body.turnId, knownTarget.body.turnId);
    assert.equal(changedInNewChat.path, knownTarget.path);
    await expect(currentLink).toHaveAttribute('href', chatPath(lateChat.id));
    assert.equal(creates, 1);

    // Real Workerd/Agents storage control: lose the response after the server has
    // stored a pre-model rejection, then replay through the same first-chat target.
    const createsBeforeNative = creates;
    await page.goto(origin + chatPath());
    await page.getByRole('combobox', { name: 'Model: provider', exact: true }).selectOption('send-replay-synthetic');
    await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption(missingModel);
    await question.fill('Native stored rejection with a lost acknowledgement.');
    const firstNative = await submit('native-lost');
    await expect(question).toHaveValue(firstNative.body.question);
    const nativeChat = firstNative.path.split('/').at(-2);
    let stored;
    await expect.poll(async () => {
      stored = (await api('/api/projects/' + project + '/chats/' + nativeChat)).turns;
      return stored[0]?.state;
    }).toBe('failed');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].turnId, firstNative.body.turnId);
    assert.match(stored[0].error, /absent from the current provider catalogue/);
    assert.equal(stored[0].inputTokens, 0); assert.equal(stored[0].outputTokens, 0);
    assert.deepEqual(await submit('native-ack'), firstNative);
    await expect(page).toHaveURL(origin + chatPath(nativeChat));
    await expect(question).toHaveValue('');
    assert.equal(creates, createsBeforeNative + 1, 'A known created chat is reused after a lost turn acknowledgement.');
    const count = requests.length;
    await page.reload();
    await expect(currentLink).toHaveAttribute('href', chatPath(nativeChat));
    await expect(page.locator('.er-chat__turn').getByText(firstNative.body.question, { exact: true })).toBeVisible();
    assert.deepEqual((await api('/api/projects/' + project + '/chats/' + nativeChat)).turns, stored);
    assert.equal(requests.length, count, 'Reload reads the stored turn without another Send.');

    for (const fault of ['before', 'lost', 'json', 'missing-id', 'wrong-id']) {
      await page.goto(origin + chatPath());
      const text = (fault === 'json' ? 'A' + '😀'.repeat(40) : '') + 'Unconfirmed creation ' + fault + ' ' + viewport.width;
      await question.fill(text);
      const before = creations.length, turnCount = requests.length;
      createFault = fault; outcome = 'ack';
      await send.click();
      await expect.poll(() => creations.length).toBe(before + 1);
      await expect(send).toBeEnabled();
      await expect(page.getByRole('alert')).toBeVisible();
      assert.equal(requests.length, turnCount, 'An unconfirmed create response must not dispatch a turn.');
      if (fault === 'json') await question.fill(text + ' edited before retry');
      createFault = '';
      await submit('ack');
      assert.deepEqual(creations[before + 1].input, creations[before].input, 'Retry keeps the creation ID and original title, even after draft edits.');
      assert.equal(creations[before + 1].chat.id, creations[before].input.id, 'Retry uses the original conversation identity whether or not its first INSERT committed.');
      if (fault !== 'before') assert.deepEqual(creations[before + 1].chat, creations[before].chat);
      assert.equal(creations[before + 1].chat.title, Array.from(text).slice(0, 80).join(''));
      assert.deepEqual([creations[before].status, creations[before + 1].status], fault === 'before' ? [0, 201] : [201, 200]);
      await expect(page).toHaveURL(origin + chatPath(creations[before + 1].chat.id));
    }

    // Reload recovers committed inventory/result by reading History; it does not
    // persist private draft text or repeat an unconfirmed operation automatically.
    await page.goto(origin + chatPath());
    const createRecoveryText = 'Read an empty committed chat after reload ' + viewport.width;
    await question.fill(createRecoveryText);
    createFault = 'lost'; outcome = 'ack';
    const beforeReloadCreate = creations.length;
    await send.click();
    await expect.poll(() => creations.length).toBe(beforeReloadCreate + 1);
    await expect(send).toBeEnabled();
    const recoveredEmpty = creations.at(-1).chat.id;
    createFault = ''; outcome = '';
    const writesBeforeReload = { creates, turns: requests.length };
    await page.reload();
    await expect(question).toHaveValue('');
    await page.getByRole('region', { name: 'Chat', exact: true }).getByText('History', { exact: true }).click();
    await page.locator('.er-chat__history-link[href="' + chatPath(recoveredEmpty) + '"]').click();
    await expect(currentLink).toHaveAttribute('href', chatPath(recoveredEmpty));
    assert.deepEqual((await api('/api/projects/' + project + '/chats/' + recoveredEmpty)).turns, []);
    assert.deepEqual({ creates, turns: requests.length }, writesBeforeReload);

    await page.goto(origin + chatPath());
    await page.getByRole('combobox', { name: 'Model: provider', exact: true }).selectOption('send-replay-synthetic');
    await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption(missingModel);
    await question.fill('Read a committed result after lost reply and reload ' + viewport.width);
    const reloadTurn = await submit('native-lost');
    const reloadChat = reloadTurn.path.split('/').at(-2);
    let resultBeforeReload;
    await expect.poll(async () => {
      resultBeforeReload = (await api('/api/projects/' + project + '/chats/' + reloadChat)).turns;
      return resultBeforeReload[0]?.state;
    }).toBe('failed');
    const resultWrites = { creates, turns: requests.length };
    await page.reload();
    await page.getByRole('region', { name: 'Chat', exact: true }).getByText('History', { exact: true }).click();
    await page.locator('.er-chat__history-link[href="' + chatPath(reloadChat) + '"]').click();
    await expect(currentLink).toHaveAttribute('href', chatPath(reloadChat));
    await expect(page.locator('.er-chat__turn').getByText(reloadTurn.body.question, { exact: true })).toBeVisible();
    assert.deepEqual((await api('/api/projects/' + project + '/chats/' + reloadChat)).turns, resultBeforeReload);
    assert.deepEqual({ creates, turns: requests.length }, resultWrites);
    assert.equal(nativePosts, 3); assert.equal(unexpectedWrites, 0); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ scope: 'K2_SEND_REPLAY_BROWSER', viewport, failedResponses: 5, sameInputSameRequest: true,
      newInputAndModelNewRequest: true, sourceNavigationPreservesRequest: true, acknowledgedNewSendHasNewId: true,
      lateCreateRetainsHistoryAndTarget: true,
      lostCreateReusesIdentity: true, reloadAfterUnconfirmedCreateAndTurnIsReadOnly: true,
      nativeStoredRejectionReplayed: true, nativePosts, chatCreates: creates, reloadPosts: 0, modelCalls: 0, fullK2Accepted: false }));
    await context.close();
  }
} finally { await browser.close(); }
