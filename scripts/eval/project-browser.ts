import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { assertEvalBrowserOrigin, fetchEval } from './origin.mjs';

assert(process.env.ELIOT_K2_MODEL !== '1' && process.env.ELIOT_K3_MODEL !== '1', 'Project switching forbids model opt-in.');
const origin = assertEvalBrowserOrigin(process.env.ELIOT_URL || 'http://127.0.0.1:5173', process.env.ELIOT_ORIGIN);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname), 'Project picker fixture is local-only.');
const api = async (path, body?, method = 'POST') => {
  const response = await fetchEval(origin + path, { headers: { Origin: origin, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { method, body: JSON.stringify(body) }) }, origin, process.env.ELIOT_ORIGIN);
  assert(response.ok, `${path}: ${response.status}`);
  return response.json();
};
const prefix = 'Project picker ' + crypto.randomUUID() + ' ';
const projects = [];
for (let index = 0; index < 52; index++) projects.push((await api('/api/projects', { title: prefix + index })).project);
const first = projects[0], target = projects.at(-1);
assert(first && target);
const chats = await Promise.all(['First conversation: ' + 'saved project evidence '.repeat(4), 'Second conversation: ' + 'recent source comparison '.repeat(4)].map(async title =>
  (await api('/api/projects/' + first.id + '/chats', { title })).chat));
const chatPath = chat => '/p/' + first.id + '/chat/' + chat.id;
const chatBefore = await Promise.all(chats.map(chat => api('/api/projects/' + first.id + '/chats/' + chat.id)));
const recent = (await api('/api/projects/' + first.id + '/chats')).chats[0];
assert(chats.some(chat => chat.id === recent.id));
await api('/api/projects/' + projects[1].id, { archived: true }, 'PATCH');
// Include pre-existing native eval projects, not just this fixture's 51 active rows.
const expected = [];
let cursor;
do {
  const data = await api('/api/projects' + (cursor ? '?cursor=' + cursor : ''));
  expected.push(...data.projects);
  cursor = data.nextCursor;
} while (cursor);
assert(expected.length > 50);

const browser = await chromium.launch();
await mkdir('eval/out/k2', { recursive: true });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.fallback() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const confirmations = [];
    let confirmSwitch = false;
    page.on('dialog', async prompt => {
      assert.equal(prompt.type(), 'confirm');
      assert(['Discard your unsent question and switch project?', 'Discard your question draft and switch chats?',
        'Discard your question draft and start a new chat?'].includes(prompt.message()));
      confirmations.push(prompt.message());
      if (confirmSwitch) await prompt.accept();
      else await prompt.dismiss();
    });
    let writes = 0, fault = '', held;
    await context.route('**/api/**', route => {
      if (route.request().method() === 'GET') return route.fallback();
      writes++; return route.abort('blockedbyclient');
    });
    await page.route('**/api/projects?*', route => intercept(route));
    await page.route('**/api/projects', route => intercept(route));
    function intercept(route) {
      if (fault === 'hold') { held = route; return; }
      if (fault === 'empty') return route.fulfill({ json: { projects: [], nextCursor: null } });
      if (fault === 'fail' || fault === 'more' && new URL(route.request().url()).searchParams.has('cursor')) {
        return route.fulfill({ status: 503, json: { error: { message: 'Synthetic project list failure' } } });
      }
      return route.fallback();
    }
    const switcher = page.getByRole('button', { name: 'Switch project', exact: true });
    const dialog = page.getByRole('dialog', { name: 'Switch project', exact: true });
    const list = dialog.getByRole('navigation', { name: 'Project list', exact: true });
    const links = list.getByRole('link');
    const question = page.getByRole('textbox', { name: 'Question', exact: true });
    const more = () => dialog.getByRole('button', { name: 'Load more projects', exact: true });
    const allPages = async () => {
      await expect(list).toHaveAttribute('aria-busy', 'false');
      while (await more().count()) {
        const count = await links.count();
        await more().click();
        await expect.poll(() => links.count()).toBeGreaterThan(count);
        await expect(list).toHaveAttribute('aria-busy', 'false');
      }
    };
    // The blank workspace exposes real saved work without navigating or sending
    // when a late history read arrives. The composer remains usable throughout.
    let chatFault = 'hold', heldChats;
    await page.route(origin + '/api/projects/' + first.id + '/chats', route => {
      if (chatFault === 'hold') { heldChats = route; return; }
      if (chatFault === 'fail') return route.fulfill({ status: 503, json: { error: { message: 'Synthetic saved chats failure' } } });
      return route.fallback();
    });
    const start = page.locator('.er-chat__start'), resume = start.getByRole('link', { name: 'Continue: ' + recent.title, exact: true });
    const blankPath = origin + '/p/' + first.id + '/chat';
    await page.goto(blankPath, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: first.title, exact: true })).toBeVisible();
    await expect(start.getByRole('status')).toBeVisible();
    await question.fill('Draft entered before saved chats arrive.');
    await expect.poll(() => Boolean(heldChats)).toBe(true);
    chatFault = ''; await heldChats.fallback();
    await expect(resume).toBeVisible();
    await expect(resume).toHaveAttribute('href', chatPath(recent));
    await expect(page).toHaveURL(blankPath);
    await expect(question).toHaveValue('Draft entered before saved chats arrive.');
    assert.equal(confirmations.length, 0);
    const openingRecent = context.waitForEvent('page');
    await resume.click({ modifiers: ['Control'] });
    const recentTab = await openingRecent;
    await expect(recentTab).toHaveURL(origin + chatPath(recent));
    await recentTab.close();
    await expect(question).toHaveValue('Draft entered before saved chats arrive.');
    assert.equal(confirmations.length, 0);
    await resume.focus(); await page.keyboard.press('Enter');
    await expect.poll(() => confirmations.length).toBe(1);
    await expect(page).toHaveURL(blankPath);
    await expect(question).toHaveValue('Draft entered before saved chats arrive.');
    confirmSwitch = true;
    await resume.click();
    await expect(page).toHaveURL(origin + chatPath(recent));
    await expect(question).toHaveValue('');
    await expect(page.locator('.er-chat__resume')).toHaveCount(0);
    assert.equal(confirmations.length, 2);
    // A failed saved-chat read is visible on entry and retry performs only GETs.
    chatFault = 'fail';
    await page.goto(blankPath);
    await expect(start.getByRole('alert')).toContainText('Synthetic saved chats failure');
    await expect(page.locator('.er-chat__resume')).toHaveCount(0);
    await question.fill('Draft survives saved-history retry.');
    chatFault = '';
    await start.getByRole('button', { name: 'Retry chat history', exact: true }).click();
    await expect(resume).toBeVisible();
    await expect(question).toHaveValue('Draft survives saved-history retry.');
    await expect(page).toHaveURL(blankPath);
    await page.evaluate(() => document.fonts.ready);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: 'eval/out/k2/project-recent-' + viewport.width + '.png' });
    await question.fill('');
    confirmations.length = 0; confirmSwitch = false;

    if (viewport.width <= 600) {
      await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Sources', exact: true }).click();
    }
    const scope = page.getByRole('checkbox', { name: /^Project default/, includeHidden: true });
    await scope.uncheck();
    if (viewport.width <= 600) {
      await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Chat', exact: true }).click();
    }
    await question.fill('Unsent draft stays while browsing the picker.');

    fault = 'fail';
    await switcher.click();
    await expect(list.getByRole('alert')).toContainText('Synthetic project list failure');
    fault = '';
    await dialog.getByRole('button', { name: 'Retry projects', exact: true }).click();
    await expect(links).toHaveCount(50);
    fault = 'more';
    await more().click();
    await expect(list.getByRole('alert')).toContainText('Synthetic project list failure');
    await expect(links).toHaveCount(50);
    fault = '';
    await dialog.getByRole('button', { name: 'Retry projects', exact: true }).click();
    await expect.poll(() => links.count()).toBeGreaterThan(50);
    await allPages();
    await expect(links).toHaveCount(expected.length);
    const actual = await links.evaluateAll(items => items.map(item => item.getAttribute('href')));
    assert.deepEqual(actual, expected.map(project => '/p/' + project.id + '/chat'));
    assert.equal(new Set(actual).size, actual.length);
    await expect(list.getByRole('link', { name: first.title, exact: true })).toHaveAttribute('aria-current', 'true');
    await expect(list.getByRole('link', { name: projects[1].title, exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(switcher).toBeFocused();
    await expect(question).toHaveValue('Unsent draft stays while browsing the picker.');
    await expect(scope).not.toBeChecked();

    await switcher.click();
    await expect(links).toHaveCount(50);
    await allPages();
    await list.getByRole('link', { name: first.title, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(origin + '/p/' + first.id + '/chat');
    await expect(question).toHaveValue('Unsent draft stays while browsing the picker.');
    await expect(scope).not.toBeChecked();
    assert.equal(confirmations.length, 0, 'Choosing the current project must not ask to discard its draft.');

    fault = 'empty';
    await switcher.click();
    await expect(list.getByText('No active projects.', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');

    // Closing a delayed read must not resurrect the dialog or its old list on reopen.
    fault = 'hold';
    await switcher.click();
    await expect(list.getByRole('status')).toHaveText('Loading projects.');
    await expect.poll(() => Boolean(held)).toBe(true);
    await dialog.getByRole('button', { name: 'Close project list', exact: true }).click();
    fault = '';
    await held.fulfill({ json: { projects: [], nextCursor: null } }).catch(() => {});
    await expect(dialog).toHaveCount(0);
    await switcher.click();
    await expect(links).toHaveCount(50);
    await dialog.getByRole('button', { name: 'Close project list', exact: true }).evaluate(button => {
      button.click();
      [...document.querySelectorAll('button')].find(trigger => trigger.textContent === 'Switch project')?.click();
    });
    await expect(dialog).toBeVisible();
    await expect(links).toHaveCount(50);
    await page.screenshot({ path: 'eval/out/k2/project-picker-' + viewport.width + '.png' });
    await dialog.getByRole('button', { name: 'Refresh projects', exact: true }).click();
    await expect(links).toHaveCount(50);
    await list.getByRole('link', { name: target.title, exact: true }).click();
    assert.equal(confirmations.length, 1);
    await expect(page).toHaveURL(origin + '/p/' + first.id + '/chat');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(question).toHaveValue('Unsent draft stays while browsing the picker.');
    await expect(scope).not.toBeChecked();
    confirmSwitch = true;
    await switcher.click();
    await expect(links).toHaveCount(50);
    await list.getByRole('link', { name: target.title, exact: true }).click();
    assert.equal(confirmations.length, 2);
    await expect(page).toHaveURL(origin + '/p/' + target.id + '/chat');
    await expect(page.getByRole('heading', { name: target.title, exact: true })).toBeVisible();
    await expect(page.locator('.er-chat__resume')).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
    await expect(question).toHaveValue('');
    await expect(page.getByRole('checkbox', { name: /^Project default/, includeHidden: true })).toBeChecked();

    const third = projects.at(-2);
    await question.fill('  \n  ');
    await switcher.click();
    await expect(links).toHaveCount(50);
    await list.getByRole('link', { name: third.title, exact: true }).click();
    await expect(page).toHaveURL(origin + '/p/' + third.id + '/chat');
    await expect(page.getByRole('heading', { name: third.title, exact: true })).toBeVisible();
    assert.equal(confirmations.length, 2, 'A whitespace-only draft must not ask for confirmation.');
    await page.goBack();
    await expect(page.getByRole('heading', { name: target.title, exact: true })).toBeVisible();
    await expect(question).toHaveValue('');

    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(origin + '/settings');
    await expect(switcher).toHaveCount(0);
    await page.goBack();
    await expect(page.getByRole('heading', { name: target.title, exact: true })).toBeVisible();
    await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Sources', exact: true }).click();
    await expect(page).toHaveURL(origin + '/p/' + target.id + '/sources');
    await switcher.click();
    await expect(links).toHaveCount(50);
    await expect(list.getByRole('link', { name: target.title, exact: true })).toHaveAttribute('aria-current', 'true');
    // Same-project route changes also dismiss the picker without navigating on a late read.
    await page.goBack();
    await expect(page).toHaveURL(origin + '/p/' + target.id + '/chat');
    await expect(dialog).toHaveCount(0);
    await expect(question).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(origin + '/p/' + first.id + '/chat');
    await expect(dialog).toHaveCount(0);

    // Manual chat navigation must not silently discard the controlled composer.
    await page.goto(origin + chatPath(chats[0]));
    const history = page.getByRole('navigation', { name: 'Chat history', exact: true });
    const historyToggle = page.getByRole('region', { name: 'Chat', exact: true }).getByText('History', { exact: true });
    const openHistory = async () => { if (!await history.isVisible()) await historyToggle.click(); };
    const chatLink = chat => history.getByRole('link', { name: chat.title, exact: true });
    await expect(page.locator('.er-chat__history-link[aria-current="page"]')).toHaveAttribute('href', chatPath(chats[0]));
    if (viewport.width <= 600) await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Sources', exact: true }).click();
    await scope.uncheck();
    if (viewport.width <= 600) await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Chat', exact: true }).click();
    await expect(page).toHaveURL(origin + chatPath(chats[0]));
    await question.fill('Keep this draft while choosing another chat.');
    const projectPrompts = confirmations.length;
    await openHistory();
    await chatLink(chats[0]).click();
    assert.equal(confirmations.length, projectPrompts);
    await expect(question).toHaveValue('Keep this draft while choosing another chat.');

    await openHistory();
    const opening = context.waitForEvent('page');
    await chatLink(chats[1]).click({ modifiers: ['Control'] });
    const separateTab = await opening;
    await expect(separateTab).toHaveURL(origin + chatPath(chats[1]));
    await separateTab.close();
    await expect(page).toHaveURL(origin + chatPath(chats[0]));
    await expect(question).toHaveValue('Keep this draft while choosing another chat.');
    assert.equal(confirmations.length, projectPrompts, 'Opening a separate tab must not ask to discard this tab\'s draft.');

    confirmSwitch = false;
    await openHistory();
    await chatLink(chats[1]).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => confirmations.length).toBe(projectPrompts + 1);
    await expect(page).toHaveURL(origin + chatPath(chats[0]));
    await expect(history).toBeVisible();
    await expect(question).toHaveValue('Keep this draft while choosing another chat.');
    await expect(scope).not.toBeChecked();
    confirmSwitch = true;
    await chatLink(chats[1]).click();
    await expect(page).toHaveURL(origin + chatPath(chats[1]));
    await expect(page.locator('.er-chat__history-link[aria-current="page"]')).toHaveAttribute('href', chatPath(chats[1]));
    await expect(question).toHaveValue('');

    await question.fill('Keep this draft before New chat.');
    confirmSwitch = false;
    await openHistory();
    await historyToggle.locator('..').getByRole('button', { name: 'New chat', exact: true }).click();
    await expect.poll(() => confirmations.length).toBe(projectPrompts + 3);
    await expect(page).toHaveURL(origin + chatPath(chats[1]));
    await expect(history).toBeVisible();
    await expect(question).toHaveValue('Keep this draft before New chat.');
    await expect(scope).not.toBeChecked();
    confirmSwitch = true;
    await historyToggle.locator('..').getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(page).toHaveURL(origin + '/p/' + first.id + '/chat');
    await expect(question).toHaveValue('');
    await expect(history).toBeHidden();

    await question.fill('Already composing a new chat.');
    confirmSwitch = false;
    await openHistory();
    await historyToggle.locator('..').getByRole('button', { name: 'New chat', exact: true }).click();
    await expect.poll(() => confirmations.length).toBe(projectPrompts + 5);
    await expect(page).toHaveURL(origin + '/p/' + first.id + '/chat');
    await expect(history).toBeVisible();
    await expect(question).toHaveValue('Already composing a new chat.');
    await expect(scope).not.toBeChecked();
    confirmSwitch = true;
    await historyToggle.locator('..').getByRole('button', { name: 'New chat', exact: true }).click();
    await expect.poll(() => confirmations.length).toBe(projectPrompts + 6);
    await expect(page).toHaveURL(origin + '/p/' + first.id + '/chat');
    await expect(question).toHaveValue('');
    await expect(history).toBeHidden();
    await expect(scope).not.toBeChecked();
    await question.fill('  \n  ');
    await openHistory();
    await chatLink(chats[0]).click();
    await expect(page).toHaveURL(origin + chatPath(chats[0]));
    await expect(question).toHaveValue('');
    assert.equal(confirmations.length, projectPrompts + 6, 'Whitespace-only questions need no confirmation.');
    for (let index = 0; index < chats.length; index++) {
      const after = await api('/api/projects/' + first.id + '/chats/' + chats[index].id);
      assert.deepEqual(after.chat, chatBefore[index].chat);
      assert.deepEqual(after.turns, chatBefore[index].turns);
    }
    assert.equal(writes, 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ scope: 'K2_PROJECT_PICKER_BROWSER', viewport, projects: expected.length,
      recentChatEntry: { nativeLatestLink: true, delayedHistoryKeepsDraft: true, modifiedClickPreservesDraft: true, cancelAndConfirm: true, retryPreservesDraft: true, emptySavedChatHasNoResume: true },
      paging: true, initialAndPageRetry: true, escapePreservesDraft: true, delayedCloseAndReopen: true,
      projectAndSettingsNavigation: true, draftSwitch: { cancelPreservesDraftAndScope: true, confirmNavigates: true,
        currentAndBlankSkipConfirmation: true, prompts: projectPrompts },
      chatDraft: { historyCancelAndConfirm: true, newChatCancelAndConfirm: true, newBlankChatCancelAndConfirm: true, currentChatAndWhitespaceKeepBehavior: true,
        modifiedClickPreservesDraft: true, retainedStoredChats: true, prompts: confirmations.length - projectPrompts }, unexpectedWrites: writes, newModelCalls: 0 }));
    await context.close();
  }
} finally { await browser.close(); }
