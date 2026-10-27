// Settings catalogue acceptance on the existing Playwright/browser stack. No inference.
// Live checks only GET and edit unsaved form values. Negative cases intercept metadata
// responses in isolated contexts; fixture settings/Gateway PUTs never reach the Worker.
// ELIOT_CATALOG_STORAGE=1 additionally creates one local project, PATCHes its model,
// and reads it back. This never saves global defaults or enables a connection.
// Root caller: await runCommandCodeBrowser({ origin, outDir }); no work runs on import.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const FLASH = 'workers-ai:@cf/zai-org/glm-5.3-flash';
const pause = () => { let release; const promise = new Promise((resolve) => { release = resolve; }); return { promise, release }; };
const providerOf = (model) => model.route.startsWith('gateway:') ? model.route.slice(8).split('/')[0] : model.route.split(':')[0];
const picker = (page, label = 'Answer model') => page.locator('.er-models__row').filter({ has: page.getByRole('combobox', { name: label, exact: true }) });
async function bounded(promise, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 30000); })]); }
  finally { clearTimeout(timer); }
}

export async function runCommandCodeBrowser({ origin = process.env.ELIOT_URL,
  outDir = fileURLToPath(new URL('../../eval/out/command-code-browser/', import.meta.url)) } = {}) {
  assert(origin, 'Root must supply the ready local Worker origin.');
  origin = new URL(origin).origin;
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname), 'Use the local Worker only.');
  const storageOptIn = process.env.ELIOT_CATALOG_STORAGE === '1';
  await mkdir(outDir, { recursive: true });
  const report = { scope: 'CATALOGUE_SELECTION_BROWSER_ONLY', origin, at: new Date().toISOString(),
    live: [], metadataFixtures: {}, requests: { liveGets: 0, fixtureGets: 0, selectedMetadataGets: [],
      interceptedConnectionPuts: 0, interceptedSettingsPuts: 0, actualStorage: [], blocked: [] },
    localProjectStorage: { status: 'NOT_RUN', optIn: storageOptIn },
    screenshots: [], inference: 'NOT_RUN', settingsWritten: false, credentialAccessChanged: false };
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const catalogueBody = (models) => ({ models, warnings: [], defaultModel: FLASH });
  async function get(endpoint) {
    const response = await fetch(origin + endpoint, { headers: { Origin: origin, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(30000) });
    report.requests.liveGets++;
    assert.equal(response.status, 200, 'GET ' + endpoint);
    return response.json();
  }
  const before = await get('/api/settings');
  const connectionBefore = await get('/api/models/connection');
  assert.equal(before.settings.answerModel, FLASH, 'Keep the existing native answer default.');
  assert.equal(before.settings.distillModel, FLASH, 'Keep the existing native understanding default.');
  const browser = await chromium.launch();
  const browserErrors = [];
  let activePage;
  async function contextFor(viewport, fixture) {
    const context = await browser.newContext({ viewport, extraHTTPHeaders: { Origin: origin } });
    context.setDefaultTimeout(30000); context.setDefaultNavigationTimeout(30000);
    context.on('page', (page) => page.on('pageerror', (error) => browserErrors.push(error.message.slice(0, 500))));
    await context.route('**/api/**', async (route) => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (method === 'GET' && url.pathname === '/api/models' && url.searchParams.has('selected'))
        report.requests.selectedMetadataGets.push({ fixture: !!fixture, selected: url.searchParams.get('selected') });
      // Match pathname, so /api/models?selected=<route> is intercepted too.
      if (fixture && await fixture(route, url.pathname, method)) return;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        report.requests.blocked.push({ method, path: url.pathname });
        await route.abort('blockedbyclient'); return;
      }
      report.requests.liveGets++;
      await route.continue();
    });
    return context;
  }
  async function fitted(page) {
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Material layout must not overflow horizontally.');
  }
  async function shot(page, name) {
    await page.screenshot({ path: path.join(outDir, name), fullPage: true });
    report.screenshots.push(name);
  }
  async function findControls(page) {
    const row = picker(page), find = row.locator('.er-model-picker__find');
    await expect(find).toBeVisible();
    if (!await find.evaluate((element) => element.open)) await find.locator('summary').click();
    return { row, model: page.getByRole('combobox', { name: 'Answer model', exact: true }),
      provider: page.getByRole('combobox', { name: 'Answer model: provider', exact: true }),
      search: page.getByRole('searchbox', { name: 'Answer model: search models', exact: true }) };
  }
  async function gatewayDraftPreserves(page, selectedRoute) {
    const gateway = page.getByRole('textbox', { name: /^Gateway ID/ });
    const saved = await gateway.inputValue();
    await gateway.fill(saved === 'unsaved-browser-draft' ? 'another-unsaved-draft' : 'unsaved-browser-draft');
    await expect(page.getByRole('combobox', { name: 'Answer model', exact: true })).toHaveValue(selectedRoute);
    await gateway.fill(saved);
  }

  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const context = await contextFor(viewport);
      try {
        const page = activePage = await context.newPage();
        const catalogueResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/models' && response.request().method() === 'GET');
        await page.goto(origin + '/settings');
        const response = await catalogueResponse;
        assert.equal(response.status(), 200, 'Live catalogue must load through the Worker.');
        const { models } = await response.json();
        const ui = await findControls(page);
        await expect(ui.model).toBeEnabled({ timeout: 30000 });
        await expect(ui.model).toHaveValue(FLASH);
        await expect(page.getByRole('combobox', { name: 'Understanding model', exact: true })).toHaveValue(FLASH);
        const unique = (model) => models.filter((entry) => entry.route === model.route).length === 1
          && models.filter((entry) => providerOf(entry) === providerOf(model) && entry.id === model.id).length === 1;
        // Choose from the actual catalogue tail, never a four-route runtime allowlist.
        const candidates = models.map((model, index) => ({ model, index })).filter(({ model }) => model.enabled
          && providerOf(model) === 'command-code' && typeof model.id === 'string' && model.id.length <= 512 && unique(model));
        assert(candidates.length > 4, 'Live Command Code catalogue must expose choices beyond the four former seed models.');
        const selected = candidates.find(({ index }) => index === 462) ?? candidates.at(-1);
        assert(selected);
        const { model: target, index } = selected;
        assert(index >= 50, 'Live choice must be outside the first display page.');
        await ui.provider.selectOption(providerOf(target));
        await expect(ui.model).toHaveValue(FLASH);
        await ui.search.fill(target.id);
        assert.equal(await ui.model.locator('option').evaluateAll((options, route) => options.filter((option) => option.value === route).length, target.route), 1,
          'Search must reach the exact catalogue route outside the initial display page.');
        await ui.model.selectOption(target.route);
        await expect(ui.model).toHaveValue(target.route);
        const other = models.find((model) => providerOf(model) !== providerOf(target));
        assert(other, 'Provider-change regression needs another provider.');
        await ui.provider.selectOption(providerOf(other));
        await expect(ui.model).toHaveValue(target.route);
        await gatewayDraftPreserves(page, target.route);
        await ui.provider.selectOption(providerOf(target));
        await fitted(page);
        await shot(page, 'catalogue-live-' + viewport.width + '.png');
        await page.reload();
        await expect(page.getByRole('combobox', { name: 'Answer model', exact: true })).toHaveValue(FLASH);
        report.live.push({ viewport, catalogueRows: models.length, selectedIndex: index + 1, selectedRoute: target.route,
          selectedId: target.id, providerFilterPreservedSelection: true, unsavedGatewayDraftPreservedSelection: true,
          reloadRestoredFlash: true });
      } finally { await context.close(); }
    }

    const fixtureModels = Array.from({ length: 500 }, (_, index) => {
      const provider = index % 2 ? 'catalogue-fixture-b' : 'catalogue-fixture-a';
      const id = 'browser-row-' + String(index + 1).padStart(4, '0');
      return { route: 'gateway:' + provider + '/' + id, id, label: 'Catalogue fixture ' + String(index + 1).padStart(4, '0'),
        enabled: true, contextTokens: null, maxOutputTokens: null, outputReserveTokens: 8192,
        inputMicrousdPerMillion: null, cachedMicrousdPerMillion: null, outputMicrousdPerMillion: null, checkedOn: null };
    });
    const target463 = fixtureModels[462];
    const fixtureSettings = (answerModel) => ({ ...before, settings: { ...before.settings, answerModel } });
    const basicFixture = (models, answerModel) => async (route, endpoint, method) => {
      if (method !== 'GET') return false;
      if (endpoint === '/api/models') { report.requests.fixtureGets++; await json(route, catalogueBody(models)); return true; }
      if (endpoint === '/api/settings') { report.requests.fixtureGets++; await json(route, fixtureSettings(answerModel)); return true; }
      if (endpoint === '/api/models/connection') { report.requests.fixtureGets++; await json(route, { connection: { gatewayId: null, provider: 'ai-gateway', alias: 'default' } }); return true; }
      return false;
    };
    let savedAnswer = '';
    const emptyContext = await contextFor({ width: 390, height: 844 }, async (route, endpoint, method) => {
      if (endpoint === '/api/settings' && method === 'PUT') {
        const body = route.request().postDataJSON();
        assert.deepEqual(body, { answerModel: target463.route, distillModel: FLASH, autoDistill: !!before.settings.autoDistill,
          monthlyModelBudgetMicrousd: before.settings.monthlyModelBudgetMicrousd });
        report.requests.interceptedSettingsPuts++; savedAnswer = body.answerModel;
        await json(route, fixtureSettings(savedAnswer)); return true;
      }
      return basicFixture(fixtureModels, savedAnswer)(route, endpoint, method);
    });
    try {
      const page = activePage = await emptyContext.newPage(); await page.goto(origin + '/settings');
      const ui = await findControls(page); await expect(ui.model).toBeEnabled();
      await expect(ui.model).toHaveValue('');
      assert(await ui.model.locator('optgroup option').count() <= 50, 'Display page remains bounded to 50 choices.');
      assert.equal(await ui.model.locator('option').evaluateAll((options, route) => options.filter((option) => option.value === route).length, target463.route), 0);
      await ui.provider.selectOption(providerOf(target463)); await expect(ui.model).toHaveValue('');
      await ui.search.fill(target463.id);
      await expect(ui.row).toContainText('1 matching models.');
      await ui.model.selectOption(target463.route); await expect(ui.model).toHaveValue(target463.route);
      await ui.provider.selectOption('catalogue-fixture-b'); await expect(ui.model).toHaveValue(target463.route);
      await gatewayDraftPreserves(page, target463.route);
      await ui.provider.selectOption(providerOf(target463));
      await fitted(page); await shot(page, 'metadata-row463-empty-390.png');
      await page.getByRole('region', { name: 'Models', exact: true }).getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
      await page.reload();
      const restored = await findControls(page);
      await expect(restored.model).toBeEnabled(); await expect(restored.model).toHaveValue(target463.route);
      await restored.provider.selectOption('catalogue-fixture-b'); await expect(restored.model).toHaveValue(target463.route);
      await shot(page, 'metadata-saved-row463-reopened-390.png');
      report.metadataFixtures.row463 = { rows: 500, initialSelection: '', selectedIndex: 463, route: target463.route,
        searchBeforeDisplayCap: true, unknownPricesSelectableWithoutInference: true, selectionPreserved: true,
        savedAndReopened: true, save: 'INTERCEPTED_STORAGE_METADATA_ONLY_NOT_SENT_TO_WORKER' };
    } finally { await emptyContext.close(); }

    const unavailable = fixtureModels.map((model) => model.route === target463.route
      ? { ...model, enabled: false, unavailableReason: 'Fixture provider unavailable.' } : model);
    const unavailableContext = await contextFor({ width: 390, height: 844 }, basicFixture(unavailable, target463.route));
    try {
      const page = activePage = await unavailableContext.newPage(); await page.goto(origin + '/settings');
      const ui = await findControls(page); await expect(ui.model).toBeEnabled();
      await expect(ui.model).toHaveValue(target463.route);
      await expect(ui.row.getByRole('alert')).toContainText('Fixture provider unavailable.');
      assert(await ui.model.locator('option:checked').evaluate((option) => option.disabled));
      await ui.provider.selectOption('catalogue-fixture-b'); await expect(ui.model).toHaveValue(target463.route);
      await gatewayDraftPreserves(page, target463.route);
      await shot(page, 'metadata-unavailable-preserved-390.png');
      report.metadataFixtures.unavailableSelection = 'PRESERVED_NO_FALLBACK';
    } finally { await unavailableContext.close(); }

    const oldSeen = pause(), releaseOld = pause();
    const newModel = { ...target463, id: 'new-catalogue-sentinel', route: 'gateway:catalogue-fixture-a/new-catalogue-sentinel', label: 'New catalogue sentinel' };
    const oldDeliveries = [];
    let catalogueReads = 0, fixtureGatewaySaved = false, oldDelivered = 0, oldCancelled = 0;
    const raceContext = await contextFor({ width: 1440, height: 900 }, async (route, endpoint, method) => {
      if (endpoint === '/api/models' && method === 'GET') {
        report.requests.fixtureGets++; catalogueReads++;
        // Hold every initial GET, including StrictMode's second live request.
        // Delaying only the first would test an already-cleaned-up effect.
        if (!fixtureGatewaySaved) {
          const delivered = pause(); oldDeliveries.push(delivered.promise); oldSeen.release();
          try { await releaseOld.promise; await json(route, catalogueBody(unavailable)); oldDelivered++; }
          catch (error) {
            if (!/abort|cancel|closed/i.test(route.request().failure()?.errorText ?? '')) throw error;
            oldCancelled++;
          }
          finally { delivered.release(); }
        }
        else await json(route, catalogueBody([...fixtureModels, newModel]));
        return true;
      }
      if (endpoint === '/api/models/connection' && method === 'PUT') {
        const body = route.request().postDataJSON();
        assert.deepEqual(body, { gatewayId: 'browser-fixture-new', confirmCredentialAccess: true });
        report.requests.interceptedConnectionPuts++;
        fixtureGatewaySaved = true;
        await json(route, { connection: { gatewayId: 'browser-fixture-new', provider: 'ai-gateway', alias: 'default' } });
        return true;
      }
      return basicFixture(fixtureModels, target463.route)(route, endpoint, method);
    });
    try {
      const page = activePage = await raceContext.newPage(); await page.goto(origin + '/settings');
      await bounded(oldSeen.promise, 'Initial catalogue GET was not observed within 30 seconds.');
      await page.getByRole('textbox', { name: /^Gateway ID/ }).fill('browser-fixture-new');
      await page.getByRole('checkbox', { name: 'Allow external model requests from this workspace.', exact: true }).check();
      await page.getByRole('button', { name: 'Save connection', exact: true }).click();
      const ui = await findControls(page); await expect(ui.model).toBeEnabled(); await expect(ui.model).toHaveValue(target463.route);
      await ui.provider.selectOption(providerOf(target463)); await ui.search.fill(newModel.id);
      await expect(ui.row).toContainText('1 matching models.');
      releaseOld.release(); await bounded(Promise.all(oldDeliveries), 'Old catalogue deliveries did not settle within 30 seconds.');
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(ui.row).toContainText('1 matching models.');
      await expect(ui.model).toHaveValue(target463.route);
      assert.equal(await ui.model.locator('option').evaluateAll((options, route) => options.filter((option) => option.value === route).length, newModel.route), 1);
      await shot(page, 'metadata-late-catalogue-1440.png');
      report.metadataFixtures.lateCatalogue = { status: 'OLD_DISCOVERY_CANNOT_REPLACE_NEW_CATALOGUE', catalogueReads, oldDelivered, oldCancelled,
        gatewayPut: 'INTERCEPTED_METADATA_ONLY_NOT_SENT_TO_WORKER', currentSelectionPreserved: true };
    } finally { releaseOld.release(); await raceContext.close(); }

    // Enrichment has its own GET ?selected=route. A response from before a
    // Gateway save must not replace the refreshed row or the controlled selection.
    const selectedSeen = pause(), releaseSelected = pause(), selectedDeliveries = [];
    const freshRow = { ...target463, contextTokens: 320000, inputMicrousdPerMillion: 250000,
      cachedMicrousdPerMillion: 1000, outputMicrousdPerMillion: 750000 };
    const freshModels = fixtureModels.map((model) => model.route === target463.route ? freshRow : model);
    const staleRow = { ...target463, enabled: false, unavailableReason: 'Stale selected metadata.', inputMicrousdPerMillion: 9990000 };
    let selectedGatewaySaved = false, selectedDelivered = 0, selectedCancelled = 0;
    const selectedContext = await contextFor({ width: 390, height: 844 }, async (route, endpoint, method) => {
      if (endpoint === '/api/models' && method === 'GET') {
        report.requests.fixtureGets++;
        const selected = new URL(route.request().url()).searchParams.get('selected');
        if (selected === target463.route && !selectedGatewaySaved) {
          const settled = pause(); selectedDeliveries.push(settled.promise); selectedSeen.release();
          try { await releaseSelected.promise; await json(route, catalogueBody([staleRow])); selectedDelivered++; }
          catch (error) {
            if (!/abort|cancel|closed/i.test(route.request().failure()?.errorText ?? '')) throw error;
            selectedCancelled++;
          } finally { settled.release(); }
        } else await json(route, catalogueBody(selectedGatewaySaved ? freshModels : fixtureModels));
        return true;
      }
      if (endpoint === '/api/models/connection' && method === 'PUT') {
        assert.deepEqual(route.request().postDataJSON(), { gatewayId: 'browser-fixture-selected', confirmCredentialAccess: true });
        report.requests.interceptedConnectionPuts++; selectedGatewaySaved = true;
        await json(route, { connection: { gatewayId: 'browser-fixture-selected', provider: 'ai-gateway', alias: 'default' } });
        return true;
      }
      return basicFixture(fixtureModels, '')(route, endpoint, method);
    });
    try {
      const page = activePage = await selectedContext.newPage(); await page.goto(origin + '/settings');
      const ui = await findControls(page); await expect(ui.model).toBeEnabled(); await expect(ui.model).toHaveValue('');
      await ui.provider.selectOption(providerOf(target463)); await ui.search.fill(target463.id);
      await ui.model.selectOption(target463.route);
      await bounded(selectedSeen.promise, 'Selected-model metadata GET was not observed within 30 seconds.');
      await expect(ui.model).toHaveValue(target463.route);
      await page.getByRole('textbox', { name: /^Gateway ID/ }).fill('browser-fixture-selected');
      await page.getByRole('checkbox', { name: 'Allow external model requests from this workspace.', exact: true }).check();
      await page.getByRole('button', { name: 'Save connection', exact: true }).click();
      await expect(ui.model).toBeEnabled(); await expect(ui.model).toHaveValue(target463.route);
      const details = ui.row.locator('.er-models__details'); await details.locator('summary').click();
      await expect(details).toContainText('$0.25');
      releaseSelected.release(); await bounded(Promise.all(selectedDeliveries), 'Old selected metadata did not settle within 30 seconds.');
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await expect(ui.model).toHaveValue(target463.route);
      await expect(details).toContainText('$0.25'); await expect(details).not.toContainText('$9.99');
      assert.equal(await ui.model.locator('option:checked').evaluate((option) => option.disabled), false);
      await expect(ui.row.getByRole('alert')).toHaveCount(0);
      await fitted(page); await shot(page, 'metadata-late-selected-390.png');
      report.metadataFixtures.lateSelectedMetadata = { status: 'OLD_SELECTED_METADATA_CANNOT_REPLACE_GATEWAY_REFRESH',
        selectedRoute: target463.route, selectedDelivered, selectedCancelled, currentSelectionPreserved: true,
        fixturePricesPreserved: true, gatewayPut: 'INTERCEPTED_METADATA_ONLY_NOT_SENT_TO_WORKER' };
    } finally { releaseSelected.release(); await selectedContext.close(); }

    if (storageOptIn) {
      const me = await get('/api/me');
      assert(me.actor?.type === 'owner' && me.actor.authentication === 'local', 'Storage opt-in requires the local owner.');
      const selected = report.live[0];
      assert(selected && selected.selectedRoute === 'gateway:command-code/' + selected.selectedId,
        'Persist the canonical Command Code route actually selected in the live browser.');
      const catalogue = await get('/api/models?selected=' + encodeURIComponent(selected.selectedRoute));
      const matches = catalogue.models.filter((model) => model.route === selected.selectedRoute && model.id === selected.selectedId);
      assert(matches.length === 1 && matches[0].enabled, 'Selected canonical model must still be selectable before storage.');
      report.localProjectStorage = { status: 'DISPATCHING_PROJECT', optIn: true, route: selected.selectedRoute, id: selected.selectedId };
      // Two explicit storage dispatches, each attempted once. Preserve the project on any error.
      const createRecord = { method: 'POST', path: '/api/projects', status: null };
      report.requests.actualStorage.push(createRecord);
      const created = await fetch(origin + '/api/projects', { method: 'POST', redirect: 'error',
        headers: { Origin: origin, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Catalogue browser storage ' + Date.now() }), signal: AbortSignal.timeout(30000) });
      createRecord.status = created.status;
      assert.equal(created.status, 201, 'Create one fixture project, no retry.');
      const { project } = await created.json();
      assert(typeof project?.id === 'string' && project.id.length > 0, 'Created project ID required.');
      report.localProjectStorage.projectId = project.id;
      report.localProjectStorage.status = 'DISPATCHING_PROJECT_MODEL';
      const settingsPath = '/api/projects/' + encodeURIComponent(project.id) + '/settings';
      const patchRecord = { method: 'PATCH', path: settingsPath, status: null };
      report.requests.actualStorage.push(patchRecord);
      const patched = await fetch(origin + settingsPath, { method: 'PATCH', redirect: 'error',
        headers: { Origin: origin, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ answerModel: selected.selectedRoute }), signal: AbortSignal.timeout(30000) });
      patchRecord.status = patched.status;
      assert.equal(patched.status, 200, 'Save exactly one project model override, no retry.');
      assert.equal((await patched.json()).project.answerModel, selected.selectedRoute, 'PATCH response preserves the canonical route.');
      const readBack = await get('/api/projects/' + encodeURIComponent(project.id));
      assert.equal(readBack.project.id, project.id);
      assert.equal(readBack.project.answerModel, selected.selectedRoute, 'Stored project GET must return the exact selected route.');
      assert.equal(readBack.project.instructions, project.instructions, 'Project instructions must not be changed by model selection.');
      report.localProjectStorage = { ...report.localProjectStorage, status: 'PASS', exactRouteReadBack: readBack.project.answerModel,
        globalDefaultsChanged: false, modelCalls: 0, fixtureRetained: true };
    }

    const after = await get('/api/settings');
    assert.deepEqual(await get('/api/models/connection'), connectionBefore, 'Actual Gateway connection must be unchanged.');
    assert.deepEqual(after, before, 'Actual defaults, monthly usage, budget and settings timestamp must be unchanged.');
    assert.deepEqual(report.requests.blocked, [], 'The browser must never attempt a real mutation/model request.');
    assert.equal(report.requests.interceptedConnectionPuts, 2);
    assert.equal(report.requests.interceptedSettingsPuts, 1);
    assert.equal(report.requests.actualStorage.length, storageOptIn ? 2 : 0, 'Actual project writes require ELIOT_CATALOG_STORAGE=1.');
    assert(report.requests.selectedMetadataGets.some((entry) => entry.fixture && entry.selected === target463.route),
      'The row-463 selection must actually request selected metadata, fully intercepted by pathname.');
    assert.deepEqual(browserErrors, [], 'Browser scenarios must not throw page errors.');
    report.settingsUnchanged = true; report.monthlyUsedMicrousd = after.monthlyUsedMicrousd;
    report.status = 'PASS';
  } catch (error) {
    report.status = 'FAIL'; report.error = String(error instanceof Error ? error.message : error).slice(0, 1200);
    if (storageOptIn && report.localProjectStorage.status.startsWith('DISPATCHING')) report.localProjectStorage.status = 'FAILED_OR_OUTCOME_UNKNOWN_NO_RETRY';
    if (activePage && !activePage.isClosed()) await shot(activePage, 'failure.png').catch(() => undefined);
    throw error;
  } finally {
    await writeFile(path.join(outDir, 'browser-' + Date.now() + '.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runCommandCodeBrowser();
