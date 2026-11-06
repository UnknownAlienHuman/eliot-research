// Desktop/phone Add sources -> shared Library journey against the local Worker.
// The shared-source GET is controlled for pagination races; POST attach and Reader GETs are real.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { assertEvalBrowserOrigin, fetchEval } from './origin.mjs';

assert(process.env.ELIOT_K1_MODEL !== '1' && process.env.ELIOT_K2_MODEL !== '1' && process.env.ELIOT_K3_MODEL !== '1',
  'K1 Library browser proof forbids model opt-in.');
const origin = assertEvalBrowserOrigin(process.env.ELIOT_URL || 'http://127.0.0.1:5173', process.env.ELIOT_ORIGIN);
const api = async (pathname, body?) => {
  const response = await fetchEval(origin + pathname, {
    headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  }, origin, process.env.ELIOT_ORIGIN);
  const text = await response.text();
  assert(response.ok, JSON.stringify({ pathname, status: response.status, body: text.slice(0, 500) }));
  return JSON.parse(text);
};
const sleepFrame = async (page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
await mkdir('eval/out/k1', { recursive: true });
const browser = await chromium.launch();
try {
  const creatorProject = (await api('/api/projects', { title: 'K1 shared source origin ' + crypto.randomUUID() })).project.id;
  const sharedTitle = 'Reusable Library text ' + crypto.randomUUID().slice(0, 8);
  const sharedMarker = 'Canonical shared Library bytes ' + crypto.randomUUID();
  const created = await api(`/api/projects/${creatorProject}/sources/text`, { title: sharedTitle, text: '# Shared source\n\n' + sharedMarker });
  let sharedSource;
  await expect.poll(async () => {
    sharedSource = (await api('/api/sources/' + created.sourceId)).source;
    return sharedSource.readableState;
  }, { timeout: 30000 }).toBe('readable');
  assert.equal(sharedSource.conversionCalls, 0, 'Native text fixture must not call a converter.');
  const setupUnderstanding = await api(`/api/sources/${created.sourceId}/understanding?revisionId=${sharedSource.currentRevisionId}`);
  assert.equal(setupUnderstanding.state, 'none', 'Do not start understanding in browser fixture setup.');

  // Regression: Original used to squeeze the title to 77px in a 235px Sources pane.
  // Native fixtures retain real immutable Reader/original bytes; only list availability is controlled.
  const scanProject = (await api('/api/projects', { title: 'Source title scanning' })).project.id;
  const scanSources = [];
  for (const title of [
    'Atlas approved launch plan and operational handover for the November release',
    'Atlas baseline review: исходные требования и результаты исследования за ноябрь',
    'AtlasBaselineReleaseIdentifierWithoutWordBreaks0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ]) {
    const created = await api(`/api/projects/${scanProject}/sources/text`, { title, text: '# Source identity\n\n' + title + '\n' + crypto.randomUUID() });
    let source;
    await expect.poll(async () => {
      source = (await api('/api/sources/' + created.sourceId)).source;
      return source.readableState;
    }).toBe('readable');
    assert.equal(source.conversionCalls, 0);
    scanSources.push(source);
  }
  const originalText = 'Latest original bytes ' + crypto.randomUUID();
  const replacement = await api(`/api/projects/${scanProject}/sources/text`, {
    sourceId: scanSources[0].id, title: scanSources[0].title, text: originalText,
  });
  await expect.poll(async () => (await api('/api/sources/' + scanSources[0].id)).source.currentRevisionId).toBe(replacement.revisionId);
  const secondReplacement = await api(`/api/projects/${scanProject}/sources/text`, {
    sourceId: scanSources[1].id, title: scanSources[1].title, text: 'Second latest original ' + crypto.randomUUID(),
  });
  await expect.poll(async () => (await api('/api/sources/' + scanSources[1].id)).source.currentRevisionId).toBe(secondReplacement.revisionId);
  // A readable older head remains selectable while its latest replacement is pending/failed.
  const scanRows = [
    { ...scanSources[0], revisionId: replacement.revisionId, readableState: 'pending' },
    { ...scanSources[1], revisionId: secondReplacement.revisionId, readableState: 'failed' },
    scanSources[2],
    { ...scanSources[2], id: crypto.randomUUID(), title: 'Pending source conversion', currentRevisionId: null, readableState: 'pending' },
    { ...scanSources[2], id: crypto.randomUUID(), title: 'Failed source conversion', currentRevisionId: null, readableState: 'failed' },
  ];
  await writeFile('eval/out/k1/source-title-fixture.json', JSON.stringify({ scanProject, scanRows }));
  const scanMeasurements = [];
  for (const viewport of [{ width: 1212, height: 799 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    await context.route('https://**', route => route.abort());
    const page = await context.newPage();
    const writes = [];
    await page.route('**/api/**', route => {
      if (!['GET', 'HEAD'].includes(route.request().method())) {
        writes.push(route.request().url());
        return route.abort('blockedbyclient');
      }
      if (new URL(route.request().url()).pathname === `/api/projects/${scanProject}/sources`) {
        return route.fulfill({ json: { sources: scanRows, nextCursor: null } });
      }
      return route.fallback();
    });
    try {
      const sourcesPath = `/p/${scanProject}/sources`;
      await page.goto(origin + sourcesPath);
      const rows = page.locator('.er-sources-pane__row');
      await expect(rows).toHaveCount(5);
      await page.evaluate(() => document.fonts.ready);
      const title = index => rows.nth(index).locator('.er-sources-pane__row-title');
      const checkbox = index => rows.nth(index).getByRole('checkbox', { includeHidden: true });
      const original = rows.nth(0).getByRole('link', { name: 'Download original: ' + scanRows[0].title, exact: true });
      await expect(title(0)).toHaveAccessibleName(scanRows[0].title);
      await expect(checkbox(0)).toHaveAccessibleName('Include ' + scanRows[0].title + ' in the current source selection');
      await expect(title(0)).toHaveAttribute('href', `/p/${scanProject}/source/${scanRows[0].id}?revisionId=${scanRows[0].currentRevisionId}`);
      await expect(original).toHaveAttribute('href', `/api/revisions/${replacement.revisionId}/original`);
      await expect(original).toHaveAttribute('download', '');
      await expect(rows.nth(0)).toContainText('Latest version: Converting');
      await expect(rows.nth(1)).toContainText('Latest version: Conversion failed');
      await expect(checkbox(3)).toBeDisabled();
      await expect(checkbox(4)).toBeDisabled();
      await expect(rows.nth(3)).toContainText('Converting');
      await expect(rows.nth(4)).toContainText('Conversion failed');
      const geometry = await rows.nth(0).evaluate(row => {
        const box = selector => { const r = row.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom }; };
        return { pane: row.closest('.er-sources-pane').getBoundingClientRect().width,
          title: box('.er-sources-pane__row-title'), checkbox: box('.er-sources-pane__checkbox'), original: box('.er-sources-pane__original') };
      });
      assert(geometry.title.width > geometry.pane * 0.65, 'Title must own most of the pane width.');
      assert(geometry.original.y >= geometry.title.bottom, 'Original must not compete with the title.');
      assert(geometry.checkbox.width >= 44 && geometry.checkbox.height >= 44 && geometry.original.height >= 44);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `eval/out/k1/source-titles-${viewport.width}.png` });
      scanMeasurements.push({ viewport, ...geometry });
      const pointerDownloadPromise = page.waitForEvent('download');
      await original.click();
      const pointerDownload = await pointerDownloadPromise;
      assert.equal(await readFile(await pointerDownload.path(), 'utf8'), originalText);
      await expect(page).toHaveURL(origin + sourcesPath);
      await expect(checkbox(0)).toBeChecked();
      // The label's entire target selects only, without opening Reader or starting a write.
      await rows.nth(0).locator('.er-sources-pane__checkbox').click({ position: { x: 3, y: 3 } });
      await expect(checkbox(0)).not.toBeChecked();
      await expect(page).toHaveURL(origin + sourcesPath);
      await checkbox(0).focus();
      await page.keyboard.press('Tab');
      await expect(title(0)).toBeFocused();
      assert(await title(0).evaluate(el => el.scrollHeight <= el.clientHeight + 1), 'Focused title must be fully visible.');
      assert.notEqual(await title(0).evaluate(el => getComputedStyle(el).outlineStyle), 'none');
      await page.screenshot({ path: `eval/out/k1/source-titles-focused-${viewport.width}.png` });
      const expandedHeight = (await title(0).boundingBox()).height;
      await page.keyboard.press('Tab');
      await expect(original).toBeFocused();
      assert.equal((await title(0).boundingBox()).height, expandedHeight, 'Tab to Original must retain full-title geometry.');
      await page.keyboard.press('Shift+Tab');
      await expect(title(0)).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(origin + `/p/${scanProject}/source/${scanRows[0].id}?revisionId=${scanRows[0].currentRevisionId}`);
      await expect(page.locator('.er-lib__text')).toContainText(scanRows[0].title);
      await expect(title(0)).toHaveAttribute('aria-current', 'page');
      await expect(checkbox(0)).not.toBeChecked();
      if (viewport.width > 768) {
        assert(await title(0).evaluate(el => el.scrollHeight <= el.clientHeight + 1), 'Open source remains expanded after Reader takes focus.');
        await title(1).click();
        await expect(title(1)).toHaveAttribute('aria-current', 'page');
        await expect(title(0)).not.toHaveAttribute('aria-current', 'page');
        await expect(page.locator('.er-lib__text')).toContainText(scanRows[1].title);
        assert(await title(1).evaluate(el => el.scrollHeight <= el.clientHeight + 1), 'Active Cyrillic title must be fully visible.');
        await page.screenshot({ path: `eval/out/k1/source-titles-reader-${viewport.width}.png` });
        await page.goBack();
        await expect(title(0)).toHaveAttribute('aria-current', 'page');
        await expect(page.locator('.er-lib__text')).toContainText(scanRows[0].title);
      }
      await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'Sources', exact: true }).click();
      await original.focus();
      const downloadPromise = page.waitForEvent('download');
      await page.keyboard.press('Enter');
      const download = await downloadPromise;
      assert.equal(download.url(), origin + `/api/revisions/${replacement.revisionId}/original`);
      assert.equal(await readFile(await download.path(), 'utf8'), originalText);
      await expect(page).toHaveURL(origin + sourcesPath);
      await expect(checkbox(0)).not.toBeChecked();
      // Container-width stress: no viewport breakpoint is needed for the secondary action to wrap.
      if (viewport.width === 1212) {
        await page.locator('.er-sources-pane').evaluate(el => { el.style.width = '192px'; });
        await title(2).focus();
        assert(await title(2).evaluate(el => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1));
        assert(await page.locator('.er-sources-pane__scroll').evaluate(el => el.scrollWidth <= el.clientWidth));
        scanMeasurements.push({ viewport, narrowPane: 192, title: await title(2).boundingBox() });
        await page.screenshot({ path: 'eval/out/k1/source-titles-narrow-focused.png' });
      }
      assert.deepEqual(writes, [], 'Selection, Reader and original download must remain storage-only.');
    } finally { await context.close(); }
  }
  await writeFile('eval/out/k1/source-title-geometry.json', JSON.stringify(scanMeasurements, null, 2));
  console.log(JSON.stringify({ scope: 'K1_SOURCE_TITLE_SCANNING', measurements: scanMeasurements, newModelCalls: 0 }));

  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const targetTitle = 'Library target ' + viewport.width + ' ' + crypto.randomUUID();
    const targetProject = (await api('/api/projects', { title: targetTitle })).project.id;
    const otherProject = (await api('/api/projects', { title: 'Library other ' + viewport.width + ' ' + crypto.randomUUID() })).project.id;
    const newlyUploadedTitle = 'Refresh-only source ' + crypto.randomUUID().slice(0, 8);
    const targetFakes = Array.from({ length: 52 }, (_, index) => ({
      ...sharedSource,
      id: crypto.randomUUID(),
      title: `Synthetic library row ${viewport.width}-${index}`,
      currentRevisionId: crypto.randomUUID(), revisionId: crypto.randomUUID(),
      createdAt: Date.now() - 10_000 - index,
    }));
    let targetRows = [sharedSource, ...targetFakes];
    let otherRows = [{ ...targetFakes[0], id: crypto.randomUUID(), title: `Other project only ${viewport.width}` }];
    const availableReads = [];
    const attachPosts = [];
    const unexpectedWrites = [];
    const pageErrors = [];
    let failInitial = true;
    let failMore = false;
    let holdGetProject = null;
    let heldGet = null;
    let holdAttach = false;
    let holdAttachSourceId = '';
    let heldPost = null;
    let attachResolved = false;
    const context = await browser.newContext({ viewport });
    await context.route('https://**', route => route.abort());
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const availableMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sources\/available$/u);
      if (request.method() === 'GET' && availableMatch) {
        const projectId = decodeURIComponent(availableMatch[1]);
        const cursor = url.searchParams.get('cursor');
        availableReads.push({ projectId, cursor });
        const rows = projectId === targetProject ? targetRows : projectId === otherProject ? otherRows : [];
        let offset = 0;
        if (cursor !== null) {
          const anchorId = JSON.parse(cursor)[2];
          offset = rows.findIndex(row => row.id === anchorId) + 1;
          assert(offset > 0, 'Controlled page cursor must anchor an existing row.');
        }
        const batch = rows.slice(offset, offset + 50);
        const last = batch.at(-1);
        const payload = { sources: batch, nextCursor: rows.length > offset + 50 && last
          ? JSON.stringify([projectId, last.createdAt, last.id]) : null };
        if (projectId === holdGetProject) {
          holdGetProject = null;
          await new Promise(resolve => { heldGet = { route, payload, resolve }; });
          return;
        }
        if (projectId === targetProject && cursor === null && failInitial) {
          return route.fulfill({ status: 503, json: { error: { message: 'Library fixture is temporarily unavailable.' } } });
        }
        if (projectId === targetProject && cursor !== null && failMore) {
          return route.fulfill({ status: 503, json: { error: { message: 'The next Library page is temporarily unavailable.' } } });
        }
        return route.fulfill({ json: payload });
      }
      const attachMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/sources\/attach$/u);
      if (request.method() === 'POST' && attachMatch) {
        const projectId = decodeURIComponent(attachMatch[1]);
        const body = request.postDataJSON() as { sourceId?: string };
        attachPosts.push({ projectId, sourceId: body.sourceId });
        if (holdAttach && projectId === targetProject && body.sourceId === holdAttachSourceId) {
          holdAttach = false;
          await new Promise(resolve => { heldPost = { route, resolve }; });
        }
        const response = await route.fetch();
        assert(response.ok(), 'The real native Attach must succeed before it is reported as settled.');
        attachResolved = true;
        if (projectId === targetProject && body.sourceId) {
          targetRows = targetRows.filter(row => row.id !== body.sourceId);
        }
        return route.fulfill({ response });
      }
      if (request.method() === 'GET' || request.method() === 'HEAD') return route.fallback();
      unexpectedWrites.push({ method: request.method(), path: url.pathname });
      return route.abort('blockedbyclient');
    });

    const dialog = page.getByRole('dialog');
    const library = dialog.getByRole('region', { name: 'From Library', exact: true });
    const libraryRows = () => library.locator('ul.er-lib__list > li');
    const navigate = async pathname => {
      await page.evaluate(path => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); }, pathname);
      await expect(page).toHaveURL(origin + pathname);
      await sleepFrame(page);
    };
    const openLibrary = async () => {
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await expect(dialog.getByRole('heading', { name: 'Add sources', exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: 'Browse Library', exact: true }).click();
      await expect(library.getByRole('heading', { name: 'From Library', exact: true })).toBeVisible();
    };
    const releaseGet = async status => {
      assert(heldGet, 'No held Library GET is pending.');
      const held = heldGet; heldGet = null;
      await held.route.fulfill({ status, json: status === 200 ? held.payload : { error: { message: 'Obsolete Library page failure.' } } }).catch(() => {});
      held.resolve();
      await sleepFrame(page);
    };
    const releasePost = () => {
      assert(heldPost, 'No held attach POST is pending.');
      const held = heldPost; heldPost = null; held.resolve();
    };
    try {
      await page.goto(origin + '/p/' + targetProject + '/sources');
      await expect(page.getByRole('heading', { name: targetTitle, exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Sources', exact: true })).toBeVisible();
      const projectDefault = page.getByRole('checkbox', { name: /^Project default/, includeHidden: true });
      await expect(projectDefault).toBeEnabled();
      await projectDefault.uncheck();
      const chatScope = page.locator('.er-chat__composer .er-chat__hint').filter({ hasText: 'Sources:' });
      await expect(chatScope).toContainText('Sources: none');
      await openLibrary();
      await expect(library.getByRole('alert')).toContainText('temporarily unavailable', { timeout: 15000 });
      failInitial = false;
      await library.getByRole('button', { name: 'Retry Library', exact: true }).click();
      await expect(libraryRows()).toHaveCount(50);
      await expect(library.getByRole('button', { name: 'Attach ' + sharedTitle, exact: true })).toBeVisible();
      await page.screenshot({ path: `eval/out/k1/library-dialog-${viewport.width}.png`, fullPage: true });
      failMore = true;
      await library.getByRole('button', { name: 'Load more Library sources', exact: true }).click();
      await expect(library.getByRole('alert')).toContainText('next Library page', { timeout: 15000 });
      failMore = false;
      await expect(libraryRows()).toHaveCount(50);
      await library.getByRole('button', { name: 'Retry Library', exact: true }).click();
      await expect(libraryRows()).toHaveCount(53);

      const createdNew = await api(`/api/projects/${creatorProject}/sources/text`, {
        title: newlyUploadedTitle, text: 'Newly uploaded canonical text ' + crypto.randomUUID(),
      });
      let newSource;
      await expect.poll(async () => {
        newSource = (await api('/api/sources/' + createdNew.sourceId)).source;
        return newSource.readableState;
      }, { timeout: 30000 }).toBe('readable');
      assert.equal(newSource.conversionCalls, 0);
      assert.equal(await library.getByText(newlyUploadedTitle, { exact: true }).count(), 0, 'The open list does not poll in new uploads.');
      targetRows = [newSource, ...targetRows.filter(row => row.id !== newSource.id)];
      await library.getByRole('button', { name: 'Refresh Library', exact: true }).click();
      await expect(library.getByText(newlyUploadedTitle, { exact: true })).toBeVisible();
      await expect(libraryRows()).toHaveCount(50);
      const refreshReads = availableReads.slice();
      assert(refreshReads.slice(-1)[0]?.cursor === null, 'Refresh must restart from the first value-cursor page.');

      holdGetProject = targetProject;
      await library.getByRole('button', { name: 'Refresh Library', exact: true }).click();
      await expect.poll(() => heldGet !== null).toBe(true);
      await navigate('/p/' + otherProject + '/sources');
      await openLibrary();
      await expect(library.getByText(`Other project only ${viewport.width}`, { exact: true })).toBeVisible();
      await releaseGet(200);
      await expect(library.getByText(`Other project only ${viewport.width}`, { exact: true })).toBeVisible();
      assert.equal(await library.getByText(sharedTitle, { exact: true }).count(), 0, 'A delayed target response cannot leak into another project.');

      await navigate('/p/' + targetProject + '/sources');
      await expect(projectDefault).toBeEnabled();
      await projectDefault.uncheck();
      await openLibrary();
      await expect(library.getByRole('button', { name: 'Attach ' + sharedTitle, exact: true })).toBeVisible();
      await library.getByRole('button', { name: 'Attach ' + sharedTitle, exact: true }).click();
      await expect(library.getByRole('status').filter({ hasText: 'Added to this project' })).toBeVisible();
      await expect(chatScope).toContainText('Sources: none');
      const openAttachedSource = library.getByRole('link', { name: 'Open ' + sharedTitle, exact: true });
      await expect(openAttachedSource).toBeVisible();
      await page.screenshot({ path: `eval/out/k1/library-picker-${viewport.width}.png`, fullPage: true });
      targetRows = targetRows.filter(row => row.id !== sharedSource.id);
      await openAttachedSource.click();
      await expect(dialog).not.toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/p/${targetProject}/source/${sharedSource.id}\\?revisionId=${sharedSource.currentRevisionId}$`, 'u'));
      await expect(page.locator('.er-lib__text')).toContainText(sharedMarker);
      await expect(projectDefault).not.toBeChecked();
      await expect(page.getByRole('checkbox', { name: 'Include ' + sharedTitle + ' in the current source selection', exact: true, includeHidden: true })).not.toBeChecked();
      await expect(page.getByRole('region', { name: 'Understanding', exact: true })).toContainText('Not yet understood');
      await expect(chatScope).toContainText('Sources: none');
      await page.screenshot({ path: `eval/out/k1/library-reader-${viewport.width}.png`, fullPage: true });

      await navigate('/p/' + targetProject + '/sources');
      await openLibrary();
      await expect(library.getByRole('button', { name: 'Attach ' + newlyUploadedTitle, exact: true })).toBeVisible();
      holdAttach = true;
      holdAttachSourceId = newSource.id;
      attachResolved = false;
      await library.getByRole('button', { name: 'Attach ' + newlyUploadedTitle, exact: true }).click();
      await expect.poll(() => heldPost !== null).toBe(true);
      await navigate('/p/' + otherProject + '/sources');
      await expect(page.getByRole('link', { name: sharedTitle, exact: true })).toHaveCount(0);
      await expect(page.getByRole('link', { name: newlyUploadedTitle, exact: true })).toHaveCount(0);
      releasePost();
      await expect.poll(() => attachResolved).toBe(true);
      const attachedRows = (await api('/api/projects/' + targetProject + '/sources')).sources;
      assert(attachedRows.some(row => row.id === sharedSource.id));
      assert(attachedRows.some(row => row.id === newSource.id));
      assert.deepEqual(attachPosts.filter(post => post.sourceId === sharedSource.id || post.sourceId === newSource.id)
        .map(post => [post.projectId, post.sourceId]), [[targetProject, sharedSource.id], [targetProject, newSource.id]]);

      await navigate('/p/' + targetProject + '/sources');
      await expect(page.getByRole('link', { name: newlyUploadedTitle, exact: true })).toBeVisible();
      assert.equal(attachPosts.filter(post => post.sourceId === sharedSource.id).length, 1);
      assert.equal(unexpectedWrites.length, 0, JSON.stringify(unexpectedWrites));
      assert.deepEqual(pageErrors, []);
      assert(availableReads.some(read => read.projectId === targetProject && read.cursor === null));
      assert(availableReads.some(read => read.projectId === targetProject && read.cursor !== null));
      assert(availableReads.some(read => read.projectId === otherProject && read.cursor === null));
      await page.screenshot({ path: `eval/out/k1/library-${viewport.width}.png`, fullPage: true });
      console.log(JSON.stringify({
        scope: 'K1_LIBRARY_BROWSER', viewport, sourceSetup: 'local native text; conversionCalls=0',
        libraryInitialAndNextPageRetry: true, pagesBeforeRefresh: [50, 3],
        newUploadWaitsForRefresh: true, refreshRestartsAtFirstPage: true,
        heldGetProjectIsolation: true, heldRealAttachPostProjectIsolation: true,
        immediateOpenClosesDialog: true, readerCanonicalBytesOpened: true, currentUnderstandingReadOnly: true, emptyChatSelectionPreserved: true,
        attachPosts: attachPosts.length, unexpectedWrites: unexpectedWrites.length, newModelCalls: 0,
      }));
    } finally {
      if (heldGet) await releaseGet(200);
      if (heldPost) releasePost();
      await context.close();
    }
  }
} finally {
  await browser.close();
}
