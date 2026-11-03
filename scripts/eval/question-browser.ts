// Stored-question drafting in the real local workspace.
// intercepted in the browser before the Worker can admit any work.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { assertEvalBrowserOrigin, fetchEval } from './origin.mjs';

assert(process.env.ELIOT_K2_MODEL !== '1' && process.env.ELIOT_K3_MODEL !== '1', 'Question handoff checks forbid model opt-in.');
const origin = assertEvalBrowserOrigin(process.env.ELIOT_URL || 'http://127.0.0.1:5173', process.env.ELIOT_ORIGIN);
const api = async (pathname, body?) => {
  const response = await fetchEval(origin + pathname, { headers: { Origin: origin, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) }, origin, process.env.ELIOT_ORIGIN);
  const text = await response.text();
  assert(response.ok, JSON.stringify({ pathname, status: response.status, body: text.slice(0, 500) }));
  return text === '' ? null : JSON.parse(text);
};
async function createTextSource(projectId, title, text) {
  const created = await api('/api/projects/' + projectId + '/sources/text', { title, text });
  let source;
  await expect.poll(async () => { source = (await api('/api/sources/' + created.sourceId)).source; return source.readableState; }, { timeout: 30000 }).toBe('readable');
  assert.equal(source.conversionCalls, 0, 'Native text fixture creation must not start a model call.');
  return source;
}
async function sourceSnapshot(sourceId, revisionId) {
  return api('/api/sources/' + sourceId + '/understanding?revisionId=' + encodeURIComponent(revisionId));
}
function questionView(base, revisionId, questions) {
  return { ...base, revisionId, state: 'partial', error: null,
    guide: 'Synthetic stored guide for browser handoff.', digest: 'Synthetic stored digest.', glossary: [], claims: [], citations: [],
    report: { ...(base.report ?? {}), questions, dropped: [], clearedNumbers: 0, kept: 0 } };
}
function sourcePath(projectId, sourceId, revisionId) {
  return '/p/' + projectId + '/source/' + sourceId + '?revisionId=' + encodeURIComponent(revisionId);
}
function chatPath(projectId, chatId) { return '/p/' + projectId + '/chat' + (chatId ? '/' + chatId : ''); }

const project = (await api('/api/projects', { title: 'Question handoff ' + crypto.randomUUID() })).project.id;
const otherProject = (await api('/api/projects', { title: 'Other question handoff ' + crypto.randomUUID() })).project.id;
const fixtureId = crypto.randomUUID();
const sourceA = await createTextSource(project, 'Question source A', '# Source A\n\nNative fixture text A ' + fixtureId + '.');
const sourceBOriginal = await createTextSource(project, 'Question source B', '# Source B\n\nNative fixture text B, original revision ' + fixtureId + '.');
const oldRevisionId = sourceBOriginal.currentRevisionId ?? sourceBOriginal.revisionId;
await api('/api/projects/' + project + '/sources/text', { title: sourceBOriginal.title, sourceId: sourceBOriginal.id,
  text: '# Source B, current\n\nNative fixture text B, current revision ' + fixtureId + '.' });
let sourceB;
await expect.poll(async () => { sourceB = (await api('/api/sources/' + sourceBOriginal.id)).source; return sourceB.currentRevisionId; }, { timeout: 30000 }).not.toBe(oldRevisionId);
assert.equal(sourceB.conversionCalls, 0);
const currentRevisionId = sourceB.currentRevisionId;
const otherSource = await createTextSource(otherProject, 'Other project source', '# Other project\n\nNative fixture text C ' + fixtureId + '.');
const chats = await Promise.all(['Last chat A', 'Other existing chat'].map(async title =>
  (await api('/api/projects/' + project + '/chats', { title })).chat.id));
const otherChat = (await api('/api/projects/' + otherProject + '/chats', { title: 'Other project chat' })).chat.id;

const questionA = 'Which stored result belongs to source A?';
const questionB = 'Which condition limits the reported result?';
const oldQuestion = 'What did the previous source revision conclude?';
const otherQuestion = 'Which result belongs only to the other project?';
const views = new Map();
for (const [source, revisionId, questions] of [
  [sourceA, sourceA.currentRevisionId ?? sourceA.revisionId, [questionA]],
  [sourceB, currentRevisionId, [questionB]],
  [sourceB, oldRevisionId, [oldQuestion]],
  [otherSource, otherSource.currentRevisionId ?? otherSource.revisionId, [otherQuestion]],
]) {
  const base = await sourceSnapshot(source.id, revisionId);
  views.set(source.id + ':' + revisionId, questionView(base, revisionId, questions));
}
const overviewRows = [
  { sourceId: sourceA.id, revisionId: sourceA.currentRevisionId ?? sourceA.revisionId, title: sourceA.title, state: 'partial', summary: 'Synthetic overview guide A.', questions: [questionA] },
  { sourceId: sourceB.id, revisionId: currentRevisionId, title: sourceB.title, state: 'partial', summary: 'Synthetic overview guide B.', questions: [questionB] },
];
const otherOverviewRows = [{ sourceId: otherSource.id, revisionId: otherSource.currentRevisionId ?? otherSource.revisionId,
  title: otherSource.title, state: 'partial', summary: 'Synthetic other-project guide.', questions: [otherQuestion] }];

await mkdir('eval/out/k3', { recursive: true });
const browser = await chromium.launch();
let totalUnexpectedWrites = 0;
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.fallback() : route.abort());
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    let chatCreatePosts = 0, turnPosts = 0, unexpectedTurnPosts = 0, unexpectedWrites = 0;
    let armedTurn;
    await page.route('**/api/**', async route => {
      const request = route.request();
      if (request.method() === 'GET' || request.method() === 'HEAD') return route.fallback();
      const pathname = new URL(request.url()).pathname;
      if (request.method() === 'POST' && pathname.endsWith('/turns')) {
        turnPosts++;
        const held = armedTurn;
        armedTurn = undefined;
        if (!held) { unexpectedTurnPosts++; return route.abort('blockedbyclient'); }
        held.request = request;
        held.respond = async (status, data) => {
          await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) }).catch(() => {});
          held.finish();
        };
        held.arrived();
        await held.finished;
        return;
      }
      if (request.method() === 'POST' && /\/api\/projects\/[^/]+\/chats$/.test(pathname)) {
        chatCreatePosts++;
        return route.abort('blockedbyclient');
      }
      unexpectedWrites++;
      return route.abort('blockedbyclient');
    });
    await page.route('**/api/projects/*/overview*', route => {
      const pid = new URL(route.request().url()).pathname.split('/')[3];
      return route.fulfill({ json: { sources: pid === project ? overviewRows : pid === otherProject ? otherOverviewRows : [], nextCursor: null } });
    });
    await page.route('**/api/sources/*/understanding*', route => {
      const url = new URL(route.request().url());
      const sourceId = url.pathname.split('/').at(-2) ?? '';
      const revisionId = url.searchParams.get('revisionId') ?? '';
      const view = views.get(sourceId + ':' + revisionId);
      return view ? route.fulfill({ json: view }) : route.fallback();
    });

    const questionBox = page.getByRole('textbox', { name: 'Question', exact: true });
    const primary = page.getByRole('navigation', { name: 'Primary', exact: true });
    const primaryLink = name => primary.getByRole('link', { name, exact: true });
    const sourceCheck = source => page.getByRole('checkbox', { name: 'Include ' + source.title + ' in the current source selection', exact: true });
    const scopeDefault = page.getByRole('checkbox', { name: /^Project default/ });
    const settle = async () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const navigate = async pathname => {
      await page.evaluate(path => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); }, pathname);
      await expect(page).toHaveURL(origin + pathname);
      await settle();
    };
    const revealScope = async expectedSource => {
      if (viewport.width <= 600) await primaryLink('Sources').click();
      await expect(scopeDefault).not.toBeChecked();
      const expected = expectedSource.id === sourceA.id ? sourceCheck(sourceA) : sourceCheck(sourceB);
      const other = expectedSource.id === sourceA.id ? sourceCheck(sourceB) : sourceCheck(sourceA);
      await expect(expected).toBeChecked();
      await expect(other).not.toBeChecked();
      if (viewport.width <= 600) await primaryLink('Chat').click();
    };
    const chatQuestionButton = () => page.getByRole('button', { name: 'Use question in chat: ' + questionB, exact: true });
    const openCurrentQuestion = async () => {
      const button = chatQuestionButton();
      await expect(button).toBeVisible({ timeout: 10000 });
      await button.click();
    };
    const armTurn = () => {
      assert.equal(armedTurn, undefined, 'Only one synthetic turn may be held.');
      let arrived;
      let finish;
      let timer;
      const arrivedPromise = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Turn POST was not intercepted within 10 seconds.')), 10000);
        arrived = () => { clearTimeout(timer); resolve(); };
      });
      const finished = new Promise(resolve => { finish = resolve; });
      const held = { arrived, finished, finish, request: undefined, respond: undefined };
      armedTurn = held;
      return {
        waiting: arrivedPromise,
        body: () => held.request?.postDataJSON(),
        release: async (status = 200, data = { accepted: true }) => {
          assert(held.request, 'No held turn POST reached the route.');
          assert(held.respond, 'The intercepted turn route is not ready to release.');
          await held.respond(status, data);
        },
      };
    };

    await page.goto(origin + '/p/' + project + '/studio');
    await expect(page.getByRole('region', { name: 'Studio', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Project overview', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Project overview', exact: true }).getByText(questionB, { exact: true })).toBeVisible();
    const overviewUse = page.getByRole('button', { name: 'Use question in chat: ' + questionB, exact: true });
    await expect(overviewUse).toBeVisible();
    assert.equal(chatCreatePosts, 0); assert.equal(turnPosts, 0);
    await overviewUse.click();
    await expect(page).toHaveURL(origin + chatPath(project));
    await expect(questionBox).toHaveValue(questionB);
    assert.equal(chatCreatePosts, 0, 'Prefilling a new chat must not create it.');
    assert.equal(turnPosts, 0, 'Prefilling a question must not send it.');
    await revealScope(sourceB);
    await expect(questionBox).toHaveValue(questionB);
    const emptySend = page.getByRole('button', { name: 'Send', exact: true });
    await expect(emptySend).toBeEnabled();
    await emptySend.click();
    await expect.poll(() => chatCreatePosts).toBe(1);
    assert.equal(turnPosts, 0, 'A failed synthetic chat-create must not reach the turn endpoint.');

    // The first history read must not restore its old scope over an accepted suggestion.
    const chatUrl = origin + '/api/projects/' + project + '/chats/' + chats[0];
    const savedChat = await api('/api/projects/' + project + '/chats/' + chats[0]);
    let heldHistory;
    const historyHandler = async route => { heldHistory = route; };
    await page.route(chatUrl, historyHandler);
    await navigate(chatPath(project, chats[0]));
    await expect.poll(() => Boolean(heldHistory)).toBe(true);
    await questionBox.fill('Draft before the delayed history read.');
    await navigate(sourcePath(project, sourceB.id, currentRevisionId));
    await openCurrentQuestion();
    await page.getByRole('dialog', { name: 'Replace chat draft', exact: true })
      .getByRole('button', { name: 'Use suggested question', exact: true }).click();
    const oldTurn = { turnId: crypto.randomUUID(), question: 'Earlier source A question', answer: 'Earlier saved source A answer', state: 'completed',
      createdAt: 1, historyVersion: 1, model: 'fixture', scopeMode: 'explicit', sourceIds: [sourceA.id], revisionIds: [sourceA.currentRevisionId],
      citations: [], invalidLabels: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, tokenLimit: 0, firstTokenMs: null, totalMs: 0, error: null };
    await heldHistory.fulfill({ json: { ...savedChat, turns: [oldTurn] } });
    await expect(page.getByText(oldTurn.answer, { exact: true })).toBeVisible();
    await expect(questionBox).toHaveValue(questionB);
    await revealScope(sourceB);
    await page.unroute(chatUrl, historyHandler);

    // Start in a known existing chat and deliberately select only source A. The question
    // action must replace that visible workspace scope only after explicit confirmation.
    await navigate(chatPath(project, chats[0]));
    if (viewport.width <= 600) await primaryLink('Sources').click();
    if (await scopeDefault.isChecked()) await sourceCheck(sourceB).uncheck();
    else {
      if (await sourceCheck(sourceB).isChecked()) await sourceCheck(sourceB).uncheck();
      if (!await sourceCheck(sourceA).isChecked()) await sourceCheck(sourceA).check();
    }
    await expect(scopeDefault).not.toBeChecked();
    await expect(sourceCheck(sourceA)).toBeChecked(); await expect(sourceCheck(sourceB)).not.toBeChecked();
    if (viewport.width <= 600) await primaryLink('Chat').click();
    await questionBox.fill('Preserve this unsent draft.');
    await navigate(sourcePath(project, sourceB.id, currentRevisionId));
    await openCurrentQuestion();
    const replaceDialog = page.getByRole('dialog', { name: 'Replace chat draft', exact: true });
    await expect(replaceDialog).toBeVisible();
    await page.screenshot({ path: 'eval/out/k3/question-dialog-' + viewport.width + '.png' });
    await page.keyboard.press('Escape');
    await expect(replaceDialog).toHaveCount(0);
    await navigate(chatPath(project, chats[0]));
    await expect(questionBox).toHaveValue('Preserve this unsent draft.');
    await revealScope(sourceA);

    await navigate(sourcePath(project, sourceB.id, currentRevisionId));
    await openCurrentQuestion();
    await expect(replaceDialog).toBeVisible();
    await replaceDialog.getByRole('button', { name: 'Keep draft', exact: true }).click();
    await navigate(chatPath(project, chats[0]));
    await expect(questionBox).toHaveValue('Preserve this unsent draft.');
    await revealScope(sourceA);

    await navigate(sourcePath(project, sourceB.id, currentRevisionId));
    await openCurrentQuestion();
    await expect(replaceDialog).toBeVisible();
    await replaceDialog.getByRole('button', { name: 'Use suggested question', exact: true }).click();
    await expect(questionBox).toHaveValue(questionB);
    await revealScope(sourceB);

    // Reader questions are revision-owned; an old revision remains readable text but is not actionable.
    await page.screenshot({ path: 'eval/out/k3/question-draft-' + viewport.width + '.png' });
    await navigate(sourcePath(project, sourceB.id, oldRevisionId));
    await expect(page.getByText(oldQuestion, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use question in chat: ' + oldQuestion, exact: true })).toHaveCount(0);

    // A route change dismisses a pending replacement dialog and cannot leak its question into another project.
    await navigate(chatPath(project, chats[1]));
    await questionBox.fill('Draft before route change.');
    await navigate(sourcePath(project, sourceB.id, currentRevisionId));
    await openCurrentQuestion();
    await expect(replaceDialog).toBeVisible();
    await navigate(sourcePath(project, sourceB.id, oldRevisionId));
    await expect(replaceDialog).toHaveCount(0);
    await expect(page.getByText(oldQuestion, { exact: true })).toBeVisible();
    await navigate(chatPath(project, chats[1]));
    await expect(questionBox).toHaveValue('Draft before route change.');
    await navigate(chatPath(otherProject, otherChat));
    await expect(questionBox).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Use question in chat: ' + otherQuestion, exact: true })).toHaveCount(0);

    // A manually confirmed turn is intercepted before dispatch; edits made while awaiting
    // the response remain in the one existing composer owner.
    await navigate(chatPath(project, chats[1]));
    await navigate(sourcePath(project, sourceB.id, currentRevisionId));
    await openCurrentQuestion();
    await expect(questionBox).toHaveValue(questionB);
    await revealScope(sourceB);
    const send = page.getByRole('button', { name: 'Send', exact: true });
    const sent = armTurn();
    await send.click(); await sent.waiting;
    assert.deepEqual(sent.body(), { turnId: sent.body().turnId, question: questionB, scopeMode: 'explicit', sourceIds: [sourceB.id] });
    await questionBox.fill('Edited while the explicit Send is pending.');
    await sent.release();
    await expect(questionBox).toHaveValue('Edited while the explicit Send is pending.');

    // Late acknowledgements and errors from a departed view do not clear or annotate a
    // new suggestion accepted through Reader back into that same chat route.
    for (const status of [200, 503]) {
      const original = 'Question already submitted ' + status;
      await questionBox.fill(original);
      const sentLate = armTurn();
      await page.getByRole('button', { name: 'Send', exact: true }).click(); await sentLate.waiting;
      assert.equal(sentLate.body().question, original);
      await navigate(sourcePath(project, sourceB.id, currentRevisionId));
      await openCurrentQuestion();
      await expect(replaceDialog).toBeVisible();
      await replaceDialog.getByRole('button', { name: 'Use suggested question', exact: true }).click();
      await expect(page).toHaveURL(origin + chatPath(project, chats[1]));
      await expect(questionBox).toHaveValue(questionB);
      await sentLate.release(status, status === 200 ? { accepted: true } : { error: { message: 'Late departed failure ' + status } });
      await expect(questionBox).toHaveValue(questionB);
      await expect(page.getByText('Late departed failure ' + status, { exact: true })).toHaveCount(0);
      await revealScope(sourceB);
    }

    assert.equal(chatCreatePosts, 1, 'Only the explicit Send from the new-chat composer may attempt chat creation.');
    assert.equal(unexpectedTurnPosts, 0, 'Every turn POST must be intentionally held before Worker dispatch.');
    assert.equal(unexpectedWrites, 0, 'No other browser write is allowed in this fixture.');
    assert.deepEqual(pageErrors, []);
    totalUnexpectedWrites += unexpectedWrites + unexpectedTurnPosts;
    console.log(JSON.stringify({ scope: 'K3_QUESTION_DRAFT_BROWSER', viewport,
      questions: { overview: true, currentReader: true, historicalReaderTextOnly: true },
      prefillCreatesOrSends: 0, visibleSourceScope: true, replaceDialog: { escapeKeepsDraft: true, keepDraftKeepsScope: true, confirmReplacesAndSelectsSource: true },
      heldTurnPosts: turnPosts, lateSuccessAndErrorPreserveNewDraft: true,
      projectAndRevisionIsolation: true, delayedInitialHistoryPreservesSuggestedScope: true, unexpectedWrites, unexpectedTurnPosts, newModelCalls: 0 }));
    await context.close();
  }
  assert.equal(totalUnexpectedWrites, 0);
} finally { await browser.close(); }
