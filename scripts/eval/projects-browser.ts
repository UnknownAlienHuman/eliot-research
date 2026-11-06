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
    const pageTwo = active[0];
    assert(expectedActive.findIndex(project => project.id === pageTwo.id) >= 50, 'Rename fixture must be beyond page one.');
    const createdTitle = 'After rename cancel ' + prefix + viewport.width;
    const context = await browser.newContext({ viewport });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.fallback() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let mode = '', writeMode = '', heldPatch, unexpectedWrites = 0, createPosts = 0, listReads = 0;
    const heldReads = [], patches = [];
    await page.route('**/api/**', route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() === 'POST' && url.pathname === '/api/projects' && request.postDataJSON().title === createdTitle) {
        createPosts++; return route.fallback();
      }
      if (request.method() === 'PATCH' && url.pathname === '/api/projects/' + target.id) {
        patches.push(request.postDataJSON());
        if (writeMode === 'hold') { heldPatch = route; return; }
        if (writeMode === 'fail') return route.fulfill({ status: 503, json: { error: { message: 'Synthetic restore failure' } } });
        return route.fallback();
      }
      if (request.method() !== 'GET') { unexpectedWrites++; return route.abort('blockedbyclient'); }
      if (url.pathname === '/api/projects') listReads++;
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
    // Create must not reset pagination underneath a second-page rename.
    const create = projects.getByRole('button', { name: 'Create', exact: true });
    const newName = projects.getByRole('textbox', { name: 'New project', exact: true });
    await newName.fill(createdTitle);
    await row(pageTwo.title).getByRole('button', { name: 'Rename', exact: true }).click();
    const rename = projects.getByRole('textbox', { name: 'Project title', exact: true });
    const renameDraft = 'Unsaved second-page name ' + viewport.width;
    await rename.fill(renameDraft);
    await expect(create).toBeDisabled();
    await create.locator('..').evaluate(form => form.requestSubmit());
    await expect(rename).toHaveValue(renameDraft);
    await expect(rows).toHaveCount(expectedActive.length);
    assert.equal(createPosts, 0);
    await projects.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(filter).toBeEnabled();
    await create.click();
    await expect(row(createdTitle)).toHaveCount(1);
    await expect(rename).toHaveCount(0);
    await expect(filter).toBeEnabled();
    assert.equal(createPosts, 1);
    // An external archive followed by real reconnect refetch removes the row,
    // while its single controlled editor must retain its draft and Cancel.
    await loadAll();
    await row(pageTwo.title).getByRole('button', { name: 'Rename', exact: true }).click();
    await rename.fill(renameDraft);
    await context.setOffline(true);
    await api('/api/projects/' + pageTwo.id, { archived: true }, 'PATCH');
    const readsBeforeReconnect = listReads;
    await context.setOffline(false);
    await expect.poll(() => listReads).toBeGreaterThan(readsBeforeReconnect);
    await expect(row(pageTwo.title)).toHaveCount(0);
    const outsideEditor = projects.getByRole('group', { name: 'Rename project', exact: true });
    await expect(outsideEditor).toBeVisible();
    await expect(rename).toHaveValue(renameDraft);
    await expect(rename).toBeFocused();
    const editorBounds = await rename.boundingBox();
    assert(editorBounds && editorBounds.y >= 0 && editorBounds.y + editorBounds.height <= viewport.height,
      'The recovered editor must be in the viewport, not merely attached above the list.');
    await expect(outsideEditor.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await outsideEditor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(outsideEditor).toHaveCount(0);
    await expect(filter).toBeEnabled();
    await expect(row(createdTitle).getByRole('button', { name: 'Rename', exact: true })).toBeEnabled();
    await expect(row(createdTitle).getByRole('button', { name: 'Archive', exact: true })).toBeEnabled();
    assert.equal((await api('/api/projects/' + pageTwo.id)).project.title, pageTwo.title, 'Cancel must not save the draft.');
    await api('/api/projects/' + pageTwo.id, { archived: false }, 'PATCH');
    mode = 'hold';
    await filter.check();
    await expect.poll(() => heldReads.length).toBeGreaterThan(0);
    await filter.uncheck();
    mode = '';
    for (const request of heldReads) await request.fulfill({ json: { projects: [], nextCursor: null } }).catch(() => {});
    await expect(rows).toHaveCount(50);
    await expect(row(target.title)).toHaveCount(1);
    await expect(filter).not.toBeChecked();
    await expect(projects.getByRole('textbox', { name: 'New project', exact: true })).toHaveValue('');
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
    const failedName = 'Submitted before failure ' + prefix + viewport.width;
    const firstSavedName = 'Typed during failed Save ' + prefix + viewport.width;
    await rename.fill(failedName);
    await expect(filter).toBeDisabled();
    writeMode = 'hold'; heldPatch = undefined;
    await projects.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => Boolean(heldPatch)).toBe(true);
    await rename.fill(firstSavedName);
    await expect(projects.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    writeMode = '';
    await heldPatch.fulfill({ status: 503, json: { error: { message: 'Synthetic rename failure' } } });
    await expect(projects.getByRole('alert')).toContainText('Synthetic rename failure');
    await expect(rename).toHaveValue(firstSavedName);
    assert.equal((await api('/api/projects/' + target.id)).project.title, target.title);
    writeMode = 'hold'; heldPatch = undefined;
    await projects.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => Boolean(heldPatch)).toBe(true);
    assert.deepEqual(heldPatch.request().postDataJSON(), { title: firstSavedName });
    await rename.fill(restoredTitle);
    writeMode = '';
    await heldPatch.continue();
    await expect(rename).toHaveValue(restoredTitle);
    await expect(projects.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    assert.equal((await api('/api/projects/' + target.id)).project.title, firstSavedName,
      'The acknowledged Save must commit only its submitted name, not newer unsaved text.');
    await projects.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(row(restoredTitle)).toHaveCount(1);
    await expect(rename).toHaveCount(0);
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
    assert.deepEqual(patches, [{ archived: true }, { archived: false }, { title: failedName }, { title: firstSavedName }, { title: restoredTitle }, { archived: false }]);
    assert.equal(createPosts, 1);
    await page.goto(origin); await expect(newName).toBeVisible();
    const matching = async title => (await allProjects(false)).filter(project => project.title === title.trim());
    let nativeCreatePosts = 0;
    for (const outcome of ['before', 'lost', 'malformed', 'wrong-id']) {
      const rawTitle = '  Create replay ' + outcome + ' ' + prefix + viewport.width + '  ', submitted = [];
      const handler = async route => {
        if (route.request().method() !== 'POST') return route.fallback();
        submitted.push(route.request().postDataJSON());
        if (submitted.length === 1 && outcome === 'before') return route.fulfill({ status: 503, json: { error: { message: 'Rejected before creation' } } });
        const response = await route.fetch(); assert.equal(response.status(), 201); nativeCreatePosts++;
        const accepted = await response.json();
        if (submitted.length === 1) {
          if (outcome === 'lost') return route.abort('failed');
          if (outcome === 'malformed') return route.fulfill({ status: 201, contentType: 'application/json', body: '{malformed accepted project' });
          return route.fulfill({ status: 201, json: { project: { ...accepted.project, id: crypto.randomUUID() } } });
        }
        return route.fulfill({ response });
      };
      await page.route(origin + '/api/projects', handler); await newName.fill(rawTitle); await create.click();
      await expect(projects.getByRole('alert')).toBeVisible(); await expect(create).toBeEnabled(); await expect(newName).toHaveValue(rawTitle);
      assert.equal(submitted.length, 1); assert.equal((await matching(rawTitle)).length, outcome === 'before' ? 0 : 1);
      await create.click(); await expect(newName).toHaveValue(''); await expect(create).toBeDisabled();
      assert.equal(submitted.length, 2); assert.deepEqual(submitted[1], submitted[0]);
      assert.equal(submitted[0].title, rawTitle.trim());
      assert.deepEqual((await matching(rawTitle)).map(project => project.id), [submitted[0].id]);
      if (outcome === 'malformed') {
        await newName.fill(rawTitle); await create.click(); await expect(newName).toHaveValue('');
        assert.notEqual(submitted[2].id, submitted[0].id); assert.equal((await matching(rawTitle)).length, 2);
      }
      await page.unroute(origin + '/api/projects', handler);
    }
    const changedInputs = [], firstTitle = 'Accepted before changed draft ' + prefix + viewport.width, changedTitle = 'Changed creation ' + prefix + viewport.width;
    const changedHandler = async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      changedInputs.push(route.request().postDataJSON()); const response = await route.fetch();
      assert.equal(response.status(), 201); nativeCreatePosts++;
      return changedInputs.length === 1 ? route.abort('failed') : route.fulfill({ response });
    };
    await page.route(origin + '/api/projects', changedHandler); await newName.fill(firstTitle); await create.click();
    await expect(projects.getByRole('alert')).toBeVisible(); await expect(create).toBeEnabled();
    const retained = (await matching(firstTitle))[0];
    await newName.fill(changedTitle); await create.click(); await expect(newName).toHaveValue('');
    assert.notEqual(changedInputs[0].id, changedInputs[1].id); assert.deepEqual((await matching(firstTitle))[0], retained);
    assert.equal((await matching(changedTitle)).length, 1); await page.unroute(origin + '/api/projects', changedHandler);
    for (const edit of ['changed', 'whitespace', 'aba']) {
      const submittedTitle = 'Held creation ' + edit + ' ' + prefix + viewport.width, inputs = [];
      let release, accepted = false; const gate = new Promise(resolve => { release = resolve; });
      const handler = async route => {
        if (route.request().method() !== 'POST') return route.fallback();
        inputs.push(route.request().postDataJSON()); const response = await route.fetch(); assert.equal(response.status(), 201); nativeCreatePosts++;
        if (inputs.length === 1) { accepted = true; await gate; }
        return route.fulfill({ response });
      };
      await page.route(origin + '/api/projects', handler); await newName.fill(submittedTitle); await create.click();
      await expect.poll(() => accepted).toBe(true); await expect(create).toBeDisabled(); await expect(newName).toBeEnabled(); await expect(filter).toBeDisabled();
      const newerDraft = edit === 'changed' ? 'Next unsaved ' + submittedTitle : edit === 'whitespace' ? submittedTitle + ' ' : submittedTitle;
      if (edit === 'aba') await newName.fill('Intervening unsaved title');
      await newName.fill(newerDraft); release(); await expect(filter).toBeEnabled(); await expect(newName).toHaveValue(newerDraft);
      assert.equal(inputs.length, 1); assert.equal((await matching(submittedTitle)).length, 1);
      if (edit === 'changed') assert.equal((await matching(newerDraft)).length, 0);
      await page.screenshot({ path: 'eval/out/k1/projects-create-draft-' + edit + '-' + viewport.width + '.png' });
      await create.click(); await expect(newName).toHaveValue(''); assert.notEqual(inputs[0].id, inputs[1].id);
      assert.equal((await matching(newerDraft)).length, edit === 'changed' ? 1 : 2);
      await page.unroute(origin + '/api/projects', handler);
    }
    assert.equal(unexpectedWrites, 0); assert.deepEqual(errors, []);
    console.log(JSON.stringify({ scope: 'K1_PROJECTS_BROWSER', viewport, active: expectedActive.length, archived: expectedArchived.length,
      pagedBothViews: true, staleReadIgnored: true, readAndRestoreRetry: true, archiveRenameRestore: true,
      retainedSourceAndHistory: true, pageTwoRename: { createBlockedUntilCancel: true, externalRefetchKeepsDraftAndCancel: true },
      renameAckPreservesNewerInput: { success: true, error: true, onlyExplicitSaveCommitsNewName: true },
      createExplicitReplay: { beforeDispatch: true, actualAcceptedLostMalformedAndWrongId: true, oneStoredProject: true,
        samePayloadSameId: true, confirmedAndChangedPayloadNewId: true, held201PreservesChangedWhitespaceAndAbaDrafts: true, nativeCreatePosts },
      createPosts, projectPatches: patches.length, unexpectedWrites, modelCalls: 0 }));
    await context.close();
  }
} finally { await browser.close(); }
