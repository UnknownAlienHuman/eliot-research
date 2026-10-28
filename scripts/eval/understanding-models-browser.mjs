import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { assertEvalBrowserOrigin, fetchEval } from './origin.mjs';

const sourceUrl = process.env.ELIOT_SOURCE_URL ?? '';
const origin = assertEvalBrowserOrigin(sourceUrl, process.env.ELIOT_ORIGIN);
const target = new URL(sourceUrl);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'Use an existing local readable source.');
const sourceId = /^\/p\/[^/]+\/source\/([^/]+)$/.exec(target.pathname)?.[1];
const revisionId = target.searchParams.get('revisionId');
assert(sourceId && revisionId, 'Provide the exact source and revision URL.');
const endpoint = '/api/sources/' + sourceId + '/understanding';
const out = fileURLToPath(new URL('../../eval/out/understanding-models/', import.meta.url));
await mkdir(out, { recursive: true });
async function get(path) {
  const r = await fetchEval(origin + path, { headers: { Origin: origin }, signal: AbortSignal.timeout(20000) }, origin, process.env.ELIOT_ORIGIN);
  assert.equal(r.status, 200, path); return r.json();
}
const before = await get('/api/settings');
const stored = await get(endpoint + '?revisionId=' + revisionId);
const a = { route: 'gateway:command-code/fixture/source-a', id: 'fixture/source-a', label: 'Source model A', enabled: true,
  contextTokens: 262144, maxOutputTokens: null, outputReserveTokens: 8192, inputMicrousdPerMillion: null,
  cachedMicrousdPerMillion: null, outputMicrousdPerMillion: null, checkedOn: '2026-10-27' };
const b = { ...a, route: 'gateway:command-code/fixture/source-b', id: 'fixture/source-b', label: 'Source model B',
  inputMicrousdPerMillion: 250000, cachedMicrousdPerMillion: 10000, outputMicrousdPerMillion: 500000 };
const historic = 'gateway:retired-provider/historical-model';
const nested = { route: 'gateway:command-code/nested/deep/model-variant', id: 'nested/deep/model-variant', label: 'Nested deep model variant', enabled: true,
  contextTokens: 131072, maxOutputTokens: 65536, outputReserveTokens: 8192, inputMicrousdPerMillion: 0,
  cachedMicrousdPerMillion: 0, outputMicrousdPerMillion: 0, checkedOn: '2026-10-27' };
// Synthetic browser fixtures only; never present this 3-row fixture snapshot as live catalogue evidence.
// Live snapshots may carry ~133 rows plus an OpenRouter warning; fixtures stay isolated here.
const counts = { snapshot: 0, selected: 0 }, mutations = [];
const late = { reads: 0, holdReload: false, released: false };
let lateRelease;
const lateGate = new Promise(resolve => { lateRelease = resolve; });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const json = (route, body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
await context.route('**/api/**', async route => {
  const request = route.request(), url = new URL(request.url());
  if (request.method() !== 'GET') {
    mutations.push({ path: url.pathname, method: request.method() }); await route.abort(); return;
  }
  if (url.pathname === endpoint) {
    await json(route, { ...stored, state: 'paused', error: null, canRecover: false, report: null,
      guide: null, digest: null, glossary: [], claims: [], citations: [],
      progress: { attempts: 0, limit: 2, model: historic, configuredModel: a.route, maximumCostMicrousd: null } });
    return;
  }
  if (url.pathname !== '/api/models') { await route.continue(); return; }
  // Storage-only contract: plain GET reads the snapshot. Any ?selected= request is obsolete
  // and must not happen; count it as a violation without leaking fixture internals.
  const selected = url.searchParams.get('selected');
  if (selected !== null) {
    counts.selected++;
    await json(route, { models: [a, b, nested], warnings: ['Unexpected selected-metadata request intercepted.'] });
    return;
  }
  counts.snapshot++;
  late.reads++;
  if (late.holdReload && !late.released) {
    try { await lateGate; } catch { /* manual reload releases the gate */ }
  }
  // Manual Reload snapshot re-reads storage; the held reload response arrives late without losing the selection.
  const sentinel = { ...a, route: 'gateway:command-code/fixture/source-sentinel', id: 'fixture/source-sentinel', label: 'Source sentinel' };
  await json(route, { models: late.released ? [a, b, nested, sentinel] : [a, b, nested], warnings: [] });
});
const report = { origin, sourceId, revisionId, counts, mutations, inference: 'NOT_RUN', modelCalls: 0 };
try {
  const page = await context.newPage();
  await page.goto(target.href);
  const section = page.getByRole('region', { name: 'Understanding', exact: true });
  await expect(section).toBeVisible(); await expect(section).toContainText(historic);
  // Source Understanding Details hosts the compact provider -> model picker (no search).
  const details = section.locator('.er-und__details');
  await details.locator('summary').click();
  const select = section.getByRole('combobox', { name: 'Understanding model', exact: true });
  const provider = section.getByRole('combobox', { name: 'Understanding model: provider', exact: true });
  const start = section.getByRole('button', { name: 'Understand source', exact: true });
  const reload = section.getByRole('button', { name: 'Reload snapshot', exact: true });
  // Storage-only: initial snapshot read(s) — dev StrictMode may fetch twice — no selected-metadata GET.
  await expect.poll(() => counts.snapshot).toBeGreaterThanOrEqual(1);
  assert.equal(counts.selected, 0, 'No automatic selected-metadata fetch.');
  // Compact model stays disabled until a provider is chosen.
  await expect(select).toBeDisabled();
  // Configured default is Source model A with unknown prices: Understand stays unavailable.
  await expect(start).toBeDisabled();
  await expect(section).toContainText('Price is unknown; Understand is unavailable until a bounded price is available.');
  // Compact provider -> model: choose provider first, then the exact synthetic route.
  await provider.selectOption('command-code');
  await expect(select).toHaveValue('');
  await select.selectOption(b.route);
  await expect(select).toHaveValue(b.route);
  await expect(start).toBeEnabled();
  await expect(section).toContainText('At most $0.1393');
  // Verified zero stays selectable and is not treated as unknown.
  await select.selectOption(nested.route);
  await expect(select).toHaveValue(nested.route);
  await expect(start).toBeEnabled();
  await expect(section).toContainText('At most $0.0000');
  // Provider filter preserves the exact nested identity (compact, no search).
  await provider.selectOption('command-code');
  await expect(select).toHaveValue(nested.route);
  // Manual Reload snapshot re-reads storage; arm the gate so only the reload response arrives late.
  const beforeReload = counts.snapshot;
  late.holdReload = true;
  await reload.click();
  await expect.poll(() => counts.snapshot).toBeGreaterThanOrEqual(beforeReload + 1);
  // While the reload response is held, the previous selection stays visible.
  await expect(select).toHaveValue(nested.route);
  late.released = true;
  lateRelease();
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue(nested.route);
  await expect(section).toContainText('At most $0.0000');
  assert.equal(counts.selected, 0, 'Manual reload must not use selected-metadata GET.');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Source reader must fit 390px.');
  await page.screenshot({ path: out + 'source-model-default-390.png', fullPage: true });
  await select.scrollIntoViewIfNeeded();
  await section.screenshot({ path: out + 'source-model-control-390.png' });
  assert.deepEqual(mutations, []);
  assert.deepEqual(await get('/api/settings'), before, 'Reader/metadata work must preserve settings and usage.');
  assert.equal(counts.selected, 0, 'Storage-only: no selected-metadata GET in this verifier.');
  Object.assign(report, { status: 'PASS', historicRouteVisible: true, settingsUnchanged: true,
    compactProviderModel: true, detailsHosted: true, unknownDisables: true, verifiedZeroEnabled: true,
    selectionPreserved: true, reloadRetainsSelection: true, lateFirstHeld: true,
    noSelectedFetch: true, manualReloadOnly: true, genericNestedRouteSelected: nested.route,
    knownRouteSelected: b.route, viewport390: true });
} catch (error) { report.status = 'FAIL'; report.error = String(error); throw error; }
finally {
  try { lateRelease(); } catch { /* already released */ }
  await writeFile(out + 'source-model-' + Date.now() + '.json', JSON.stringify(report, null, 2));
  await context.close(); await browser.close();
}
console.log(JSON.stringify(report, null, 2));
