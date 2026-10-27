import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const target = new URL(process.env.ELIOT_SOURCE_URL ?? '');
assert(['127.0.0.1', 'localhost'].includes(target.hostname), 'Use an existing local readable source.');
const sourceId = /^\/p\/[^/]+\/source\/([^/]+)$/.exec(target.pathname)?.[1];
const revisionId = target.searchParams.get('revisionId');
assert(sourceId && revisionId, 'Provide the exact source and revision URL.');
const origin = target.origin, endpoint = '/api/sources/' + sourceId + '/understanding';
const out = fileURLToPath(new URL('../../eval/out/understanding-models/', import.meta.url));
await mkdir(out, { recursive: true });
async function get(path) {
  const r = await fetch(origin + path, { headers: { Origin: origin }, signal: AbortSignal.timeout(20000) });
  assert.equal(r.status, 200, path); return r.json();
}
const before = await get('/api/settings');
const stored = await get(endpoint + '?revisionId=' + revisionId);
const a = { route: 'gateway:command-code/fixture/source-a', id: 'fixture/source-a', label: 'Source model A', enabled: true,
  contextTokens: 262144, maxOutputTokens: null, outputReserveTokens: 8192, inputMicrousdPerMillion: null,
  cachedMicrousdPerMillion: null, outputMicrousdPerMillion: null, checkedOn: '2026-10-27' };
const b = { ...a, route: 'gateway:command-code/fixture/source-b', id: 'fixture/source-b', label: 'Source model B' };
const historic = 'gateway:retired-provider/historical-model';
const nested = { route: 'gateway:command-code/nested/deep/model-variant', id: 'nested/deep/model-variant', label: 'Nested deep model variant', enabled: true,
  contextTokens: 131072, maxOutputTokens: 65536, outputReserveTokens: 8192, inputMicrousdPerMillion: null,
  cachedMicrousdPerMillion: null, outputMicrousdPerMillion: null, checkedOn: '2026-10-27' };
const counts = { a: 0, b: 0, nested: 0 }, mutations = [];
let releaseOld;
const oldGate = new Promise(resolve => { releaseOld = resolve; });
let oldOutcome = 'PENDING';
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: { Origin: origin } });
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
  const selected = url.searchParams.get('selected');
  if (selected === null) { await json(route, { models: [a, b, nested], warnings: [] }); return; }
  assert([a.route, b.route, nested.route].includes(selected), 'Request only the selected metadata, no whitelist.');
  const isA = selected === a.route;
  const isNested = selected === nested.route;
  if (isA) counts.a++; else if (isNested) counts.nested++; else counts.b++;
  if (isA && counts.a === 1) {
    await oldGate;
    try {
      await json(route, { models: [{ ...a, inputMicrousdPerMillion: 999999, outputMicrousdPerMillion: 999999 }, b], warnings: [] });
      oldOutcome = 'DELIVERED';
    } catch { oldOutcome = 'CANCELLED'; }
    return;
  }
  if (isNested && counts.nested === 1) {
    await route.abort('failed');
    return;
  }
  const base = isA ? a : isNested ? nested : b;
  const known = isNested ? { ...base } : { ...base, inputMicrousdPerMillion: isA ? 0 : 250000,
    cachedMicrousdPerMillion: isA ? 0 : 10000, outputMicrousdPerMillion: isA ? 0 : 500000 };
  await json(route, { models: [known, a, b, nested].filter((m, i, arr) => arr.findIndex((x) => x.route === m.route) === i), warnings: [] });
});
const report = { origin, sourceId, revisionId, counts, mutations, inference: 'NOT_RUN', modelCalls: 0 };
try {
  const page = await context.newPage();
  await page.goto(target.href);
  const section = page.getByRole('region', { name: 'Understanding', exact: true });
  const select = section.getByRole('combobox', { name: 'Understanding model', exact: true });
  const provider = section.getByRole('combobox', { name: 'Understanding model: provider', exact: true });
  const search = section.getByRole('searchbox', { name: 'Understanding model: search models', exact: true });
  const find = section.locator('.er-model-picker__find');
  const start = section.getByRole('button', { name: 'Understand source', exact: true });
  await expect(find).toBeVisible();
  if (!await find.evaluate((el) => el.open)) await find.locator('summary').click();
  await expect(section).toBeVisible(); await expect(section).toContainText(historic);
  await expect.poll(() => counts.a).toBe(1);
  await expect(start).toBeDisabled();
  await expect(section).toContainText('Model pricing is unavailable.');
  await expect(section).not.toContainText('At most $0.0000');
  await select.selectOption(b.route);
  await expect.poll(() => counts.b).toBe(1); await expect(start).toBeEnabled();
  await expect(section).toContainText('At most $0.1393');
  await select.selectOption('');
  await expect.poll(() => counts.a).toBe(2); await expect(start).toBeEnabled();
  await expect(section).toContainText('At most $0.0000');
  releaseOld();
  await expect.poll(() => oldOutcome).not.toBe('PENDING');
  await expect(section).toContainText('At most $0.0000');
  await provider.selectOption('command-code');
  await expect(select).toHaveValue('');
  await search.fill(nested.id);
  await expect(section).toContainText('1 matching models.');
  await select.selectOption(nested.route);
  await expect.poll(() => counts.nested).toBe(1);
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue(nested.route);
  await expect(section).toContainText('Selected-model metadata refresh failed:');
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue(nested.route);
  await expect(start).toBeDisabled();
  await expect(section).toContainText('Model pricing is unavailable.');
  await expect(section).not.toContainText('At most $');
  await search.fill('');
  await select.selectOption(b.route);
  await expect.poll(() => counts.b).toBe(2); await expect(start).toBeEnabled();
  await expect(section).toContainText('At most $0.1393');
  await provider.selectOption('');
  await expect(select).toHaveValue(b.route);
  await expect(section).toContainText('At most $0.1393');
  await find.locator('button', { hasText: 'Reload catalog' }).click();
  await expect.poll(() => counts.b).toBe(3);
  await expect(select).toHaveValue(b.route);
  await expect(section).toContainText('At most $0.1393');
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Source reader must fit 390px.');
  await page.screenshot({ path: out + 'source-model-default-390.png', fullPage: true });
  await select.scrollIntoViewIfNeeded();
  await section.screenshot({ path: out + 'source-model-control-390.png' });
  assert.deepEqual(mutations, []);
  assert.deepEqual(await get('/api/settings'), before, 'Reader/metadata work must preserve settings and usage.');
  Object.assign(report, { status: 'PASS', oldOutcome, unknownIsNotZero: true, verifiedZeroEnabled: true,
    reselectedAfterAbort: true, historicRouteVisible: true, settingsUnchanged: true,
    sharedPickerLabel: 'Understanding model', scopedSelect: true, providerInsideDetails: true,
    genericNestedRouteSelected: nested.route, noWhitelist: true, viewport390: true,
    metadataFailureWarnsNotDisables: true, switchedAfterFailure: b.route, reloadRetainsSelection: true });
} catch (error) { report.status = 'FAIL'; report.error = String(error); throw error; }
finally {
  releaseOld();
  await writeFile(out + 'source-model-' + Date.now() + '.json', JSON.stringify(report, null, 2));
  await context.close(); await browser.close();
}
console.log(JSON.stringify(report, null, 2));
