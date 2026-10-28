// Settings catalogue acceptance on the existing Playwright/browser stack. No inference.
// Storage-only contract: live checks use GET /api/models snapshot plus explicit POST
// /api/models/refresh from Settings. No GET /api/models?selected= is expected. Fixture
// settings/Gateway PUTs and refresh POSTs never reach the Worker. Live snapshots may
// carry ~133 rows plus an OpenRouter warning; synthetic fixtures below (500 rows,
// late-row 463 stress) are clearly labelled catalogue-fixture-* and never reported as live.
// ELIOT_CATALOG_STORAGE=1 additionally creates one local project, PATCHes its model,
// and reads it back. This never saves global defaults or enables a connection.
// Root caller: await runCommandCodeBrowser({ origin, outDir }); no work runs on import.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { assertEvalBrowserOrigin, fetchEval } from './origin.mjs';

const FLASH = 'workers-ai:@cf/zai-org/glm-5.3-flash';
const pause = () => { let release; const promise = new Promise((resolve) => { release = resolve; }); return { promise, release }; };
const providerOf = (model) => model.route.startsWith('gateway:') ? model.route.slice(8).split('/')[0] : model.route.split(':')[0];
const picker = (page, label = 'Answer model') => page.locator('.er-models__row').filter({ has: page.getByRole('combobox', { name: label, exact: true }) });
async function bounded(promise, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 30000); })]); }
  finally { clearTimeout(timer); }
}

export async function runCommandCodeBrowser({ origin: requestedOrigin = process.env.ELIOT_URL,
  outDir = fileURLToPath(new URL('../../eval/out/command-code-browser/', import.meta.url)) } = {}) {
  assert(requestedOrigin, 'Root must supply the ready local Worker origin.');
  const origin = assertEvalBrowserOrigin(requestedOrigin, process.env.ELIOT_ORIGIN);
  const storageOptIn = process.env.ELIOT_CATALOG_STORAGE === '1';
  await mkdir(outDir, { recursive: true });
  const report = { scope: 'CATALOGUE_SELECTION_BROWSER_ONLY', origin, at: new Date().toISOString(),
    live: [], metadataFixtures: {}, requests: { liveGets: 0, fixtureGets: 0, selectedMetadataGets: [],
      refreshPosts: [], interceptedConnectionPuts: 0, interceptedSettingsPuts: 0, actualStorage: [], blocked: [] },
    localProjectStorage: { status: 'NOT_RUN', optIn: storageOptIn },
    screenshots: [], inference: 'NOT_RUN', settingsWritten: false, credentialAccessChanged: false };
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const catalogueBody = (models) => ({ models, warnings: [], defaultModel: FLASH });
  async function get(endpoint) {
    const response = await fetchEval(origin + endpoint, { headers: { Origin: origin, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(30000) }, origin, process.env.ELIOT_ORIGIN);
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
    const context = await browser.newContext({ viewport });
    context.setDefaultTimeout(30000); context.setDefaultNavigationTimeout(30000);
    context.on('page', (page) => page.on('pageerror', (error) => browserErrors.push(error.message.slice(0, 500))));
    await context.route('**/api/**', async (route) => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      // Obsolete contract: no UI path may request ?selected=. Record any occurrence as a violation.
      if (method === 'GET' && url.pathname === '/api/models' && url.searchParams.has('selected'))
        report.requests.selectedMetadataGets.push({ fixture: !!fixture, selected: url.searchParams.get('selected') });
      // Match pathname, so /api/models?selected=<route> is intercepted too.
      // POST /api/models/refresh is manual-only and must be intercepted by its fixture.
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
    // Gateway ID lives inside Advanced provider settings (closed Details); open it first.
    const gwCard = page.locator('section[aria-label="AI Gateway connection"]');
    const adv = gwCard.locator('details.er-models__details');
    if (!(await adv.evaluate((el) => el.open).catch(() => true))) await adv.locator('summary').click();
    const gateway = gwCard.getByRole('textbox', { name: /^Gateway ID/ });
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
        // Live snapshot is the real stored catalogue (may be ~133 rows plus an OpenRouter warning),
        // never the 500-row synthetic fixture below.
        const { models, warnings: liveWarnings } = await response.json();
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
        report.live.push({ viewport, catalogueRows: models.length, liveWarnings: liveWarnings ?? [], selectedIndex: index + 1, selectedRoute: target.route,
          selectedId: target.id, providerFilterPreservedSelection: true, unsavedGatewayDraftPreservedSelection: true,
          reloadRestoredFlash: true, fixtureRowsNotLive: true });
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
        assert.deepEqual(body, { answerModel: target463.route, distillModel: FLASH,
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


    // Manual Refresh only: storage GET snapshot, then explicit POST /api/models/refresh.
    // No GET ?selected= is expected. Fixture snapshot carries unknown prices first,
    // refreshed snapshot carries known prices for the same row-463 identity.
    const refreshBase = fixtureModels;
    const refreshedRow = { ...target463, inputMicrousdPerMillion: 125000, cachedMicrousdPerMillion: 2500,
      outputMicrousdPerMillion: 375000, checkedOn: '2026-10-27' };
    const refreshedModels = fixtureModels.map((model) => model.route === target463.route ? refreshedRow : model);
    let refreshSeen = false;
    const savedRequestMark = { blocked: report.requests.blocked.length,
      settings: report.requests.interceptedSettingsPuts, connection: report.requests.interceptedConnectionPuts,
      refresh: report.requests.refreshPosts.length };
    const savedEvidence = report.metadataFixtures.manualRefresh = {
      status: 'PENDING', selectedRoute: target463.route,
    };
    const savedContext = await contextFor({ width: 1440, height: 900 }, async (route, endpoint, method) => {
      if (endpoint === '/api/models' && method === 'GET') {
        report.requests.fixtureGets++;
        assert.equal(new URL(route.request().url()).searchParams.get('selected'), null,
          'Storage-only: no selected-metadata GET in manual-refresh fixture.');
        await json(route, catalogueBody(refreshSeen ? refreshedModels : refreshBase));
        return true;
      }
      if (endpoint === '/api/models/refresh' && method === 'POST') {
        report.requests.fixtureGets++;
        const body = route.request().postDataJSON();
        // Explicit manual Refresh carries the controlled selection (plus the untouched Flash default).
        assert.deepEqual(body, { selectedRoutes: [target463.route, FLASH] });
        report.requests.refreshPosts.push({ selected: target463.route });
        refreshSeen = true;
        await json(route, catalogueBody(refreshedModels));
        return true;
      }
      if (endpoint === '/api/settings') {
        report.requests.fixtureGets++;
        await json(route, { ...before, settings: { ...before.settings,
          answerModel: '', distillModel: FLASH } });
        return true;
      }
      if (endpoint === '/api/models/connection') {
        report.requests.fixtureGets++;
        await json(route, { connection: { gatewayId: 'browser-fixture-existing', provider: 'ai-gateway', alias: 'default' } });
        return true;
      }
      return false;
    });
    try {
      const page = activePage = await savedContext.newPage(); await page.goto(origin + '/settings');
      const ui = await findControls(page); await expect(ui.model).toBeEnabled();
      await expect(ui.model).toHaveValue('');
      // Storage-only: select the synthetic row-463 identity with unknown prices (selectable).
      await ui.provider.selectOption(providerOf(target463));
      await ui.search.fill(target463.id);
      await expect(ui.row).toContainText('1 matching models.');
      await ui.model.selectOption(target463.route);
      await expect(ui.model).toHaveValue(target463.route);
      assert.equal(report.requests.selectedMetadataGets.length, 0, 'No automatic selected-metadata fetch.');
      // Explicit manual Refresh only: POST carries the selected route, then storage GET reloads.
      await page.getByRole('button', { name: 'Refresh models', exact: true }).click();
      await expect(page.getByText('Models refreshed.', { exact: true })).toBeVisible();
      await expect(ui.model).toHaveValue(target463.route);
      assert.equal(report.requests.refreshPosts.length, savedRequestMark.refresh + 1);
      assert.equal(report.requests.selectedMetadataGets.length, 0, 'Manual refresh must not use selected GET.');
      assert.equal(report.requests.blocked.length, savedRequestMark.blocked, 'No mutations attempted in manual-refresh fixture.');
      assert.equal(report.requests.interceptedSettingsPuts, savedRequestMark.settings);
      assert.equal(report.requests.interceptedConnectionPuts, savedRequestMark.connection);
      await fitted(page); await shot(page, 'metadata-manual-refresh-1440.png');
      savedEvidence.status = 'PASS';
      savedEvidence.manualRefreshOnly = true;
      savedEvidence.selectionPreserved = true;
      savedEvidence.mutations = 0;
    } finally {
      await savedContext.close();
    }

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
      // Gateway connection lives inside Advanced provider settings (closed Details); open it first.
      const gwCard = page.locator('section[aria-label="AI Gateway connection"]');
      const gwAdv = gwCard.locator('details.er-models__details');
      if (!(await gwAdv.evaluate((el) => el.open).catch(() => true))) await gwAdv.locator('summary').click();
      await gwCard.getByRole('textbox', { name: /^Gateway ID/ }).fill('browser-fixture-new');
      await gwCard.getByRole('checkbox', { name: 'Allow external model requests from this workspace.', exact: true }).check();
      await gwCard.getByRole('button', { name: 'Save connection', exact: true }).click();
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

    report.metadataFixtures.lateSelectedMetadata = { status: 'NOT_RUN_OBSOLETE_SELECTED_GET_REMOVED' };

    if (storageOptIn) {
      const me = await get('/api/me');
      assert(me.actor?.type === 'owner' && me.actor.authentication === 'local', 'Storage opt-in requires the local owner.');
      const selected = report.live[0];
      assert(selected && selected.selectedRoute === 'gateway:command-code/' + selected.selectedId,
        'Persist the canonical Command Code route actually selected in the live browser.');
      // Storage-only: plain snapshot GET, no selected-metadata request.
      const catalogue = await get('/api/models');
      const matches = catalogue.models.filter((model) => model.route === selected.selectedRoute && model.id === selected.selectedId);
      assert(matches.length === 1 && matches[0].enabled, 'Selected canonical model must still be selectable before storage.');
      report.localProjectStorage = { status: 'DISPATCHING_PROJECT', optIn: true, route: selected.selectedRoute, id: selected.selectedId };
      // Two explicit storage dispatches, each attempted once. Preserve the project on any error.
      const createRecord = { method: 'POST', path: '/api/projects', status: null };
      report.requests.actualStorage.push(createRecord);
      const created = await fetchEval(origin + '/api/projects', { method: 'POST', redirect: 'error',
        headers: { Origin: origin, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Catalogue browser storage ' + Date.now() }), signal: AbortSignal.timeout(30000) }, origin, process.env.ELIOT_ORIGIN);
      createRecord.status = created.status;
      assert.equal(created.status, 201, 'Create one fixture project, no retry.');
      const { project } = await created.json();
      assert(typeof project?.id === 'string' && project.id.length > 0, 'Created project ID required.');
      report.localProjectStorage.projectId = project.id;
      report.localProjectStorage.status = 'DISPATCHING_PROJECT_MODEL';
      const settingsPath = '/api/projects/' + encodeURIComponent(project.id) + '/settings';
      const patchRecord = { method: 'PATCH', path: settingsPath, status: null };
      report.requests.actualStorage.push(patchRecord);
      const patched = await fetchEval(origin + settingsPath, { method: 'PATCH', redirect: 'error',
        headers: { Origin: origin, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ answerModel: selected.selectedRoute }), signal: AbortSignal.timeout(30000) }, origin, process.env.ELIOT_ORIGIN);
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

    // Chat uses live catalogue identity plus intercepted metadata/mutations. No inference.
    const chatProjectId = process.env.ELIOT_EVAL_PROJECT?.trim() || (await get('/api/projects')).projects[0]?.id;
    assert(typeof chatProjectId === 'string' && chatProjectId.length > 0, 'An existing project is required for the CHAT scenario.');
    const chatView = '/p/' + encodeURIComponent(chatProjectId) + '/chat';
    const chatTail = (await get('/api/models')).models.find((model) => model.route === report.live[0].selectedRoute);
    assert(chatTail?.enabled, 'Use the dynamic catalogue row selected in the live browser.');
    const nestedId = 'nested/provider/' + 'long-native-id-'.repeat(12) + 'variant';
    const nested = { ...fixtureModels[0], id: nestedId, route: 'gateway:catalogue-fixture-a/' + nestedId,
      label: 'Nested model with unknown pricing' };
    report.chat = { projectId: chatProjectId, metadata: 'LIVE_ID_AND_INTERCEPTED_FIXTURES', viewports: [] };
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const context = await contextFor(viewport);
      const sentBodies = [], chatId = crypto.randomUUID(); let chatPosts = 0;
      const chatsPath = '/api/projects/' + chatProjectId + '/chats';
      await context.route('**/api/**', async (route) => {
        const request = route.request(), endpoint = new URL(request.url()).pathname;
        if (request.method() === 'GET' && endpoint === '/api/models') {
          report.requests.fixtureGets++;
          await json(route, catalogueBody([...fixtureModels, chatTail, nested])); return;
        }
        if (request.method() === 'GET' && endpoint === '/api/projects/' + chatProjectId + '/sources') {
          report.requests.fixtureGets++;
          await json(route, { sources: [{ id: crypto.randomUUID(), title: 'Browser scope fixture', enabled: true }], nextCursor: null }); return;
        }
        if (request.method() === 'POST' && endpoint === chatsPath) {
          chatPosts++;
          await json(route, { chat: { id: chatId, title: 'Intercepted browser chat', updatedAt: 0 } }, 201); return;
        }
        if (request.method() === 'POST' && endpoint === chatsPath + '/' + chatId + '/turns') {
          sentBodies.push(request.postDataJSON());
          await json(route, { error: { code: 'unavailable', message: 'Intercepted browser request; no inference.' } }, 409); return;
        }
        await route.fallback();
      });
      try {
        const chatPage = activePage = await context.newPage();
        await chatPage.goto(origin + chatView);
        const row = chatPage.locator('.er-chat__model');
        const model = row.getByRole('combobox', { name: 'Model', exact: true });
        const provider = row.getByRole('combobox', { name: 'Model: provider', exact: true });
        await expect(provider).toBeEnabled();
        // Compact picker: model stays disabled until a provider is chosen.
        await expect(model).toBeDisabled();
        // Compact provider -> model (no search): choose provider first, then the exact route.
        // Prefer the live tail when selectable; fall back to a synthetic fixture row for compact selection.
        // Live identity is still recorded separately; fixtures stay clearly synthetic.
        const chatFirst = fixtureModels[1];
        await provider.selectOption(providerOf(chatFirst));
        await expect(model).toBeEnabled(); await expect(model).toHaveValue('');
        await expect(model.locator('option[value="' + chatFirst.route + '"]')).toBeAttached();
        await model.selectOption(chatFirst.route);
        await expect(model).toHaveValue(chatFirst.route);
        await provider.selectOption(providerOf(nested));
        await expect(model).toHaveValue('');
        await expect(chatPage.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
        await provider.selectOption(providerOf(chatFirst));
        await expect(model).toHaveValue(chatFirst.route);
        // Unknown-priced nested identity stays selectable in compact picker.
        await provider.selectOption(providerOf(nested));
        await expect(model.locator('option[value="' + nested.route + '"]')).toBeAttached();
        await model.selectOption(nested.route);
        await expect(model).toHaveValue(nested.route);
        await chatPage.getByLabel('Question').fill('Browser-only check; provider change must not send.');
        await chatPage.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(chatPosts, 0, 'Provider/model change must not create a chat.'); assert.equal(sentBodies.length, 0);
        // Chat has no catalogue reload: selection persists storage-only without extra fetch.
        await expect(model).toBeEnabled(); await expect(model).toHaveValue(nested.route);
        const submitted = chatPage.waitForResponse((r) => new URL(r.url()).pathname.endsWith('/turns') && r.request().method() === 'POST');
        await chatPage.getByRole('button', { name: 'Send', exact: true }).click();
        assert.equal((await submitted).status(), 409);
        assert.equal(chatPosts, 1); assert.equal(sentBodies.length, 1);
        assert.equal(sentBodies[0].model, nested.route, 'Send preserves the complete native ID.');
        assert.equal(typeof sentBodies[0].turnId, 'string'); assert(sentBodies[0].turnId.length > 0);
        await expect(model).toHaveValue(nested.route);
        await fitted(chatPage); await model.scrollIntoViewIfNeeded(); await shot(chatPage, 'chat-picker-' + viewport.width + '.png');
        report.chat.viewports.push({ viewport, liveRoute: chatTail.route, sentRoute: nested.route,
          compactProviderModel: true, providerChangePreserved: true, storageOnlyNoReload: true, unknownPriceSelectable: true,
          sendPayloadExact: true, interceptedChatPosts: chatPosts, interceptedTurnPosts: sentBodies.length });
      } finally { await context.close(); }
    }
    const after = await get('/api/settings');
    assert.deepEqual(await get('/api/models/connection'), connectionBefore, 'Actual Gateway connection must be unchanged.');
    assert.deepEqual(after, before, 'Actual defaults, monthly usage, budget and settings timestamp must be unchanged.');
    assert.deepEqual(report.requests.blocked, [], 'The browser must never attempt a real mutation/model request.');
    assert.equal(report.requests.interceptedConnectionPuts, 1);
    assert.equal(report.requests.interceptedSettingsPuts, 1);
    assert.equal(report.requests.actualStorage.length, storageOptIn ? 2 : 0, 'Actual project writes require ELIOT_CATALOG_STORAGE=1.');
    assert.equal(report.requests.selectedMetadataGets.length, 0, 'Storage-only: no selected-metadata GET in any scenario.');
    assert.equal(report.requests.refreshPosts.length, 1, 'Manual Refresh POST only, no automatic metadata fetch.');
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
