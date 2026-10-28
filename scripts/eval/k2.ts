import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { uncitedStatements } from '../../src/citations.ts';
const EOL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const BACKSLASH = String.fromCharCode(92);
const BT = String.fromCharCode(96);
const SQ = String.fromCharCode(39);
const DQ = String.fromCharCode(34);
const SUPMINUS = String.fromCodePoint(0x207B);
const SUP8 = String.fromCodePoint(0x2078);
const UNIMINUS = String.fromCodePoint(0x2212);
const MIDDOT = String.fromCodePoint(0x00B7);
const origin = new URL(process.env.ELIOT_URL || 'http://127.0.0.1:5173').origin;
const H = { Origin: origin };
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  H['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
  H['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
}
if (process.env.ELIOT_OWNER_JWT) H['cf-access-jwt-assertion'] = String(process.env.ELIOT_OWNER_JWT).trim();
const nativeOnly = process.argv.includes('--native-only');
const runModel = !nativeOnly && process.env.ELIOT_K2_MODEL === '1';
const storedOnly = process.argv.includes('--stored-only');
const resumeChat = process.env.ELIOT_EVAL_CHAT || null;
const evalModel = (process.env.ELIOT_EVAL_MODEL ?? '').trim() || null;
const evalDir = fileURLToPath(new URL('../../eval/', import.meta.url));
const outDir = fileURLToPath(new URL('../../eval/out/k2/', import.meta.url));
await mkdir(outDir, { recursive: true });
async function apiJson(path, init) {
  const r = await fetch(origin + path, { ...init, headers: { Accept: 'application/json', ...H, ...((init && init.headers) || {}) } });
  const t = await r.text();
  let b = null;
  try { b = t ? JSON.parse(t) : null; } catch { b = { raw: t.slice(0, 300) }; }
  return { status: r.status, body: b };
}
async function apiBytes(path) {
  const r = await fetch(origin + path, { headers: { ...H } });
  return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) };
}
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
function normMath(s) {
  let n = String(s).replace(/\[(?:S\d+|R[0-9a-f-]{36}):\d+\]/gi, ' ').toLowerCase().split(',').join('.');
  n = n.split(SUPMINUS).join('-').split(SUP8).join('8').split(UNIMINUS).join('-');
  n = n.split('=').join(' = ');
  const strip = ['$', '*', '_', BT, BACKSLASH, '{', '}', '^', '(', ')', '[', ']', ':', ';', SQ, DQ, MIDDOT];
  for (const ch of strip) n = n.split(ch).join(' ');
  n = n.split(EOL).join(' ').split(TAB).join(' ');
  while (n.includes('  ')) n = n.split('  ').join(' ');
  return ' ' + n + ' ';
}
function checkAnswer(qid, ans) {
  const m = normMath(ans);
  const has = (...ss) => ss.every((s) => m.includes(s));
  if (qid === 'C1') {
    assert(m.includes('512'), 'C1 must contain 512.');
    const w = m.split(' ');
    let heads8 = /\bh\s*=\s*8(?!\d)/u.test(m) || /(?:голов[а-яё]*|heads?)[^.!?\n]{0,70}\b8\b|\b8\b[^.!?\n]{0,70}(?:голов[а-яё]*|heads?)/iu.test(m);
    for (let i = 0; i < w.length && !heads8; i++) {
      if (w[i] === '8' && i > 0 && (String(w[i - 1]).includes('head') || String(w[i - 1]).includes('голов'))) heads8 = true;
      if (w[i] === '8' && i + 1 < w.length && (String(w[i + 1]).includes('head') || String(w[i + 1]).includes('голов'))) heads8 = true;
    }
    assert(heads8 || m.includes(' восемь ') || m.includes(' eight '), 'C1 must contain h=8 or 8 heads in either order.');
  }
  if (qid === 'C2') {
    const warm = m.includes('warmup') || m.includes('warm-up') || m.includes('warm up') || m.includes('разогрев') || m.includes('прогрев') || m.includes('размин');
    const strictFormula = has('4000') && warm && (m.includes('d model') || m.includes('step')) && m.includes('min') && m.includes('-0.5') && m.includes('-1.5');
    const sqrtFormula = m.includes('sqrt') && has('4000') && warm;
    assert(strictFormula || sqrtFormula, 'C2 must contain the schedule formula d_model^-0.5 min(step^-0.5, step warmup^-1.5) with warmup 4000, or its sqrt equivalent.');
  }
  if (qid === 'C3') assert(has('0.001') && has('0.9') && has('0.999') && (has('1e-8') || m.includes('10 -8') || m.includes('10 - 8') || m.includes('10-8') || has('0.00000001')), 'C3 must contain Adam defaults with the numeric epsilon 1e-8 (the word alone does not pass).');
  if (qid === 'C4') assert((m.includes('синус') || m.includes('sinus')) && (m.includes('обуч') || m.includes('learn')), 'C4: sinusoidal vs learned.');
  if (qid === 'O8') assert(/нет в корпусе|в корпусе нет|не решают|не содержат|ни одн(?:а|ой|ого|у)|abstain|not in (the )?corpus|no paper/i.test(ans), 'O8 must abstain: the corpus does not solve hallucinations.');
}
const me = await apiJson('/api/me');
assert.equal(me.status, 200, 'GET /api/me must be 200; start pnpm dev first.');
assert.equal(me.body.actor.type, 'owner', 'Eval must run as owner.');
if (process.argv.includes('--models-only')) {
  // Connection/admission checks only. Never enables a Gateway, submits a provider call or changes defaults/budget.
  const before = await apiJson('/api/settings');
  const connection = await apiJson('/api/models/connection');
  assert.equal(before.status, 200);
  assert.equal(connection.status, 200);
  assert.equal(connection.body.connection.gatewayId, null, 'Use a disconnected local namespace; this check never disables an existing connection.');
  const models = await apiJson('/api/models');
  assert.equal(models.status, 200);
  assert(Array.isArray(models.body.models), 'GET /api/models must return a catalogue array.');
  const warnings = models.body.warnings;
  assert(Array.isArray(warnings) && warnings.every((w) => typeof w === 'string' && w.trim().length > 0), 'Catalogue discovery warnings must remain visible, including partial provider failures.');
  const externals = models.body.models.filter((m) => m && typeof m.route === 'string' && m.route.startsWith('gateway:'));
  assert(externals.length > 0, 'At least one discovered Gateway provider route is required.');
  assert.equal(new Set(externals.map((m) => m.route)).size, externals.length, 'Discovered Gateway routes must be unique.');
  const nativePairs = externals.map((m) => {
    const parts = /^gateway:([^/]+)\/.+/.exec(m.route);
    assert(parts && typeof m.id === 'string' && m.id.trim().length > 0, 'Gateway entries require a provider and native ID.');
    return [parts[1], m.id];
  });
  assert.equal(new Set(nativePairs.map((pair) => JSON.stringify(pair))).size, externals.length, 'Provider/native ID pairs must be unique.');
  for (const m of externals) assert(m && !m.enabled && m.unavailableReason, 'External model must be visibly disabled without owner credential opt-in (' + m.route + ').');
  const external = externals[0];
  assert(external, 'At least one external Gateway route is required.');
  const embedders = models.body.models.filter((m) => m && /embed|rerank/i.test(m.route + ' ' + (m.id || '') + ' ' + (m.label || '')));
  for (const m of embedders) assert(!m.enabled && m.unavailableReason, 'Embed/rerank inventory entries must not be selectable (' + m.route + ').');
  const flash = models.body.models.find((m) => m.route === 'workers-ai:@cf/zai-org/glm-5.3-flash');
  assert(flash && flash.enabled, 'Native Flash default must stay enabled.');
  assert.equal(before.body.settings.answerModel, flash.route, 'Default answer model stays Flash.');
  const denied = await apiJson('/api/models/connection', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gatewayId: 'unconfigured-eval-gateway' }) });
  assert.equal(denied.status, 400, 'Saving a Gateway without explicit credential consent must fail before mutation.');
  const invalid = await apiJson('/api/models/connection', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gatewayId: 'default' }) });
  assert.equal(invalid.status, 400, 'The auto-created default Gateway is not an allowed connection.');
  const changed = await apiJson('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answerModel: external.route, monthlyModelBudgetMicrousd: before.body.settings.monthlyModelBudgetMicrousd }) });
  assert.equal(changed.status, 503, 'A disconnected external route cannot become the default.');
  const emptyDistill = await apiJson('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answerModel: before.body.settings.answerModel, monthlyModelBudgetMicrousd: before.body.settings.monthlyModelBudgetMicrousd, distillModel: '' }) });
  assert.equal(emptyDistill.status, 400, 'An empty distillModel must fail before mutation (no truthiness bypass).');
  const afterEmpty = await apiJson('/api/settings');
  assert.deepEqual(afterEmpty.body.settings, before.body.settings, 'Rejected empty distillModel must leave global settings unchanged.');
  const project = await apiJson('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'External model admission ' + Date.now() }) });
  assert.equal(project.status, 201);
  const projectId = project.body.project.id;
  const emptyProjectModel = await apiJson('/api/projects/' + projectId + '/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answerModel: '' }) });
  assert.equal(emptyProjectModel.status, 400, 'An empty project answerModel must fail before mutation (no truthiness bypass).');
  const projectAfterEmpty = await apiJson('/api/projects/' + projectId);
  assert.equal(projectAfterEmpty.body.project.answerModel, null, 'Rejected empty project answerModel must leave the project override null.');
  const created = await apiJson('/api/projects/' + projectId + '/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(created.status, 201);
  const chatId = created.body.chat.id;
  const turn = await apiJson('/api/projects/' + projectId + '/chats/' + chatId + '/turns?wait=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turnId: randomUUID(), question: 'Disconnected model check', scopeMode: 'empty', model: external.route }) });
  assert.equal(turn.status, 200);
  assert.equal(turn.body.turn.state, 'failed');
  assert.equal(turn.body.turn.estimatedCostMicrousd, 0);
  assert.equal(turn.body.turn.inputTokens, 0);
  assert.equal(turn.body.turn.outputTokens, 0);
  assert.match(turn.body.turn.error, /disconnected|Gateway|credential/i);
  let distill = 'NOT_RUN: auto-distill must already be disabled';
  let sourceId = null;
  if (before.body.settings.autoDistill === 0) {
    const added = await apiJson('/api/projects/' + projectId + '/sources/text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'External connection gate', text: 'Storage-only connection fixture ' + randomUUID() + '. This source has no model-derived knowledge.' }) });
    assert.equal(added.status, 202);
    sourceId = added.body.sourceId;
    const revisionId = added.body.revisionId;
    let view;
    for (let i = 0; i < 40; i++) {
      view = await apiJson('/api/sources/' + sourceId);
      if (['readable', 'readable_with_warnings'].includes(view.body.source?.readableState)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert(['readable', 'readable_with_warnings'].includes(view.body.source?.readableState), 'Text fixture must finish its native ingest.');
    const path = '/api/sources/' + sourceId + '/understanding';
    const prior = await apiJson(path + '?revisionId=' + revisionId);
    assert.equal(prior.body.state, 'none');
    assert.equal(prior.body.progress.attempts, 0);
    const deniedDistill = await apiJson(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revisionId, model: external.route }) });
    assert.equal(deniedDistill.status, 503, 'Disconnected external distillation must fail before queueing/admission/dispatch.');
    const next = await apiJson(path + '?revisionId=' + revisionId);
    assert.equal(next.body.state, 'none');
    assert.equal(next.body.progress.attempts, 0);
    distill = 'LOCAL_DISCONNECTED_BEFORE_ADMISSION_PASS';
  }
  const { chromium, expect } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ extraHTTPHeaders: H });
    let settingsPuts = 0;
    const mutations = [];
    await context.route('**/api/**', async (route) => {
      const request = route.request();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        if (new URL(request.url()).pathname === '/api/settings' && request.method() === 'PUT') settingsPuts += 1;
        mutations.push({ method: request.method(), url: request.url() });
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    const errors = [];
    async function openSettings(page) {
      const reads = ['/api/settings', '/api/models/connection', '/api/models'].map(async (path) => {
        const response = await page.waitForResponse((r) => r.url() === origin + path && r.request().method() === 'GET', { timeout: 30000 });
        assert.equal(response.status(), 200, 'Settings reader must load ' + path + '.');
        await response.finished();
      });
      await Promise.all([page.goto(origin + '/settings'), ...reads]);
      await expect(page.getByRole('region', { name: 'Models', exact: true })).toBeVisible();
      for (const [label, value] of [['Answer model', before.body.settings.answerModel], ['Understanding model', before.body.settings.distillModel]]) {
        const select = page.getByRole('combobox', { name: label, exact: true });
        await expect(select).toBeEnabled({ timeout: 30000 });
        await expect(select).toHaveValue(value);
      }
      await expect(page.getByRole('textbox', { name: 'Monthly budget (USD)', exact: true })).toHaveValue(String(before.body.settings.monthlyModelBudgetMicrousd / 1000000));
      const gateway = page.getByRole('region', { name: 'AI Gateway connection', exact: true });
      await expect(gateway).toBeVisible();
      await expect(gateway.getByRole('textbox', { name: 'Gateway ID Blank disables.', exact: true })).toHaveValue('');
      await expect(gateway.getByRole('checkbox', { name: 'Allow external model requests from this workspace.', exact: true })).not.toBeChecked();
    }
    async function assertDisabledChoice(page, label) {
      const select = page.getByRole('combobox', { name: label, exact: true });
      const row = page.locator('.er-models__row').filter({ has: select });
      const find = row.locator('details.er-model-picker__find > summary');
      await find.click();
      const provider = row.getByRole('combobox', { name: label + ': provider', exact: true });
      const search = row.getByRole('searchbox', { name: label + ': search models', exact: true });
      await provider.selectOption(external.route.slice('gateway:'.length).split('/')[0]);
      await search.fill(external.route);
      await expect.poll(() => select.locator('option').evaluateAll((options, chosen) => options
        .filter((option) => option.getAttribute('value') === chosen).map((option) => option.hasAttribute('disabled')), external.route), { timeout: 30000 }).toEqual([true]);
      await search.fill('');
      await provider.selectOption('');
      await find.click();
    }
    const desktop = await context.newPage();
    await desktop.setViewportSize({ width: 1440, height: 900 });
    desktop.on('pageerror', (error) => errors.push(error.message));
    await openSettings(desktop);
    await desktop.screenshot({ path: outDir + '/external-models-desktop.png', fullPage: true });
    await desktop.close();
    const page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    page.on('pageerror', (error) => errors.push(error.message));
    await openSettings(page);
    const gateway = page.getByRole('region', { name: 'AI Gateway connection', exact: true });
    const consent = gateway.getByRole('checkbox', { name: 'Allow external model requests from this workspace.', exact: true });
    const gatewayId = gateway.getByRole('textbox', { name: 'Gateway ID Blank disables.', exact: true });
    await gatewayId.fill('unconfigured-eval-gateway');
    await expect(gateway.getByRole('button', { name: 'Save connection', exact: true })).toBeDisabled();
    assert((await page.locator('#workspace-main details').count()) >= 1, 'Compact Settings must expose collapsed technical details.');
    assert.strictEqual(await page.locator('#workspace-main details[open]').count(), 0, 'Compact default UI must not display expanded technical walls.');
    const summaries = page.locator('#workspace-main details > summary');
    for (let i = 0; i < await summaries.count(); i++) assert((await summaries.nth(i).innerText()).trim().length > 0, 'Every collapsed section must carry an accessible label.');
    await assertDisabledChoice(page, 'Answer model');
    await assertDisabledChoice(page, 'Understanding model');
    await expect(page.getByRole('combobox', { name: 'Answer model', exact: true })).toHaveValue(before.body.settings.answerModel);
    await expect(page.getByRole('combobox', { name: 'Understanding model', exact: true })).toHaveValue(before.body.settings.distillModel);
    assert.strictEqual(await page.locator('#workspace-main details[open]').count(), 0, 'Search filters must close without changing the default compact layout.');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Settings must fit the 390px Material layout.');
    await gateway.getByRole('button', { name: 'Save connection' }).scrollIntoViewIfNeeded();
    await expect(gateway.getByRole('button', { name: 'Save connection' })).toBeVisible();
    await page.screenshot({ path: outDir + '/external-models-390.png', fullPage: true });
    await page.setViewportSize({ width: 389, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Settings must fit the 389px Material layout.');
    await page.setViewportSize({ width: 390, height: 844 });
    const budget = page.getByRole('textbox', { name: 'Monthly budget (USD)', exact: true });
    const modelsSection = page.getByRole('region', { name: 'Models', exact: true });
    await budget.fill('1.0000001');
    await modelsSection.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(modelsSection.getByRole('status').filter({ hasText: 'Use up to six decimal places for the monthly budget.' })).toHaveText('Use up to six decimal places for the monthly budget.');
    assert.strictEqual(settingsPuts, 0, 'Seven-decimal budget must be rejected before any PUT /api/settings.');
    await budget.fill(String(before.body.settings.monthlyModelBudgetMicrousd / 1000000));
    await expect(budget).toHaveValue(String(before.body.settings.monthlyModelBudgetMicrousd / 1000000));
    await expect(consent).not.toBeChecked();
    await expect(gateway.getByRole('button', { name: 'Save connection', exact: true })).toBeDisabled();
    await gatewayId.fill('');
    if (sourceId) {
      const modelsRead = page.waitForResponse((r) => r.url() === origin + '/api/models' && r.request().method() === 'GET', { timeout: 30000 });
      await page.goto(origin + '/p/' + projectId + '/source/' + sourceId);
      assert.equal((await modelsRead).status(), 200, 'Understanding model catalogue must load.');
      const understanding = page.getByRole('region', { name: 'Understanding', exact: true });
      const select = understanding.getByRole('combobox', { name: 'Understanding model', exact: true });
      await expect(select).toBeVisible();
      await expect.poll(() => select.locator('option').evaluateAll((options, chosen) => options
        .filter((option) => option.getAttribute('value') === chosen).map((option) => option.hasAttribute('disabled')), external.route), { timeout: 30000 }).toEqual([true]);
    }
    assert.strictEqual(settingsPuts, 0, 'The entire browser journey must attempt zero settings PUTs.');
    assert.deepEqual(mutations, [], 'The browser journey must attempt no API mutation, including Gateway/model requests.');
    assert.deepEqual(errors, [], 'Settings/understanding must not throw browser errors.');
  } finally { await browser.close(); }
  const after = await apiJson('/api/settings');
  assert.deepEqual(after.body.settings, before.body.settings, 'Native defaults, auto-distill, budget and settings timestamp must be unchanged.');
  assert.equal(after.body.monthlyUsedMicrousd, before.body.monthlyUsedMicrousd);
  assert.equal((await apiJson('/api/models/connection')).body.connection.gatewayId, null);
  const result = { scope: 'LOCAL_CONNECTION_AND_ADMISSION', projectId, chatId, consentRejected: true, disconnectedTurnCost: 0,
    catalogue: { externalModels: externals.length, providers: [...new Set(nativePairs.map((pair) => pair[0]))], discovery: warnings.length ? 'PARTIAL' : 'NO_WARNINGS', warnings },
    monthlyUsedMicrousd: after.body.monthlyUsedMicrousd, provider: 'NOT_RUN', streaming: 'NOT_RUN', distill, browser390: 'LOCAL_PASS', credentialAccess: 'NOT_ENABLED' };
  await writeFile(outDir + '/external-models-native.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
if (process.argv.includes('--openrouter-stored')) {
  const smokeDir = fileURLToPath(new URL('../../eval/out/openrouter-smoke/', import.meta.url));
  await mkdir(smokeDir, { recursive: true });
  let ids = null;
  try {
    ids = JSON.parse(await readFile(smokeDir + '/ids.json', 'utf8'));
  } catch {
    console.log('OPENROUTER_STORED_NOT_RUN: eval/out/openrouter-smoke/ids.json is missing (root records job handles after the three provider jobs are final).');
    process.exit(2);
  }
  const violations = [];
  const rows = [];
  const perModel = [];
  const entries = Array.isArray(ids.models) ? ids.models : [];
  if (typeof ids.projectId !== 'string' || entries.length === 0) violations.push('ids.json must carry projectId and a non-empty models array.');
  const smokeWhole = new Map();
  async function smokeRange(rev, st, en, tag) {
    let w = smokeWhole.get(rev);
    if (!w) {
      const t = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/text');
      assert.equal(t.status, 200, 'GET revision text must be 200, got ' + t.status + ' (' + tag + ').');
      w = t.bytes;
      smokeWhole.set(rev, w);
    }
    const r = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/range?start=' + st + '&end=' + en);
      assert.equal(r.status, 200, 'Each cited range must open, got ' + r.status + ' (GET range 200) (' + tag + ').');
    assert(r.bytes.equals(w.subarray(st, en)), 'Cited range must equal the whole-text slice (' + tag + ').');
    assert(Buffer.from(r.bytes.toString('utf8'), 'utf8').equals(r.bytes), 'Cited range must be clean native UTF-8 (' + tag + ').');
    return r.bytes;
  }
  for (const m of entries) {
    const tag = (m && m.route) || 'unknown-route';
    let chatStatus = 'NOT_RUN', distillStatus = 'NOT_RUN';
    let usage = { inputTokens: null, cachedTokens: null, outputTokens: null, estimatedCostMicrousd: null, firstTokenMs: null, totalMs: null };
    let providerUsageRaw = null;
    let distillUsage = null;
    const providerCosts = { chatUsd: null, distillUsd: null };
    let usageCompleteness = 'partial', nullFields = ['inputTokens', 'cachedTokens', 'outputTokens', 'estimatedCostMicrousd', 'firstTokenMs', 'totalMs'];
    let aInfo = '---', dInfo = '---';
    if (!(m && typeof m.chatId === 'string' && typeof m.turnId === 'string' && typeof m.sourceId === 'string' && typeof m.revisionId === 'string')) {
      violations.push(tag + ': ids.json entry must carry chatId, turnId, sourceId and revisionId.');
      perModel.push({ route: tag, status: 'FAIL', chatStatus, distillStatus, usage, usageCompleteness, providerUsage: null, providerCosts, distillUsage, answer: aInfo, distill: dInfo });
      rows.push('| ' + tag + ' | FAIL | partial | ' + aInfo + ' | ' + dInfo + ' |');
      continue;
    }
    try {
      const h = await apiJson('/api/projects/' + encodeURIComponent(ids.projectId) + '/chats/' + encodeURIComponent(m.chatId));
      if (h.status !== 200) throw new Error('NOT_RUN: GET chat snapshot must be 200, got ' + h.status + ' (' + tag + ').');
      const turns = Array.isArray(h.body.turns) ? h.body.turns : [];
      const t = turns.find((x) => x && x.turnId === m.turnId) || null;
      if (!t) throw new Error('NOT_RUN: recorded turn missing (' + tag + ').');
      for (const kk of ['inputTokens', 'cachedTokens', 'outputTokens', 'estimatedCostMicrousd', 'firstTokenMs', 'totalMs']) assert(t[kk] === null || typeof t[kk] === 'number', 'Turn usage must be known or honestly null (' + tag + ' ' + kk + ').');
      usage = { inputTokens: t.inputTokens ?? null, cachedTokens: t.cachedTokens ?? null, outputTokens: t.outputTokens ?? null, estimatedCostMicrousd: t.estimatedCostMicrousd ?? null, firstTokenMs: t.firstTokenMs ?? null, totalMs: t.totalMs ?? null };
      if (t.providerUsage && typeof t.providerUsage === 'object' && !Array.isArray(t.providerUsage)) {
        providerUsageRaw = Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'reasoningTokens', 'costUsd'].map((key) =>
          [key, typeof t.providerUsage[key] === 'number' && Number.isFinite(t.providerUsage[key]) && t.providerUsage[key] >= 0 ? t.providerUsage[key] : null]));
        providerCosts.chatUsd = providerUsageRaw.costUsd;
      }
      nullFields = Object.keys(usage).filter((k) => usage[k] === null || typeof usage[k] !== 'number');
      usageCompleteness = nullFields.length === 0 ? 'known' : 'partial';
      if (t.state === 'failed') throw new Error(tag + ': provider turn failed: ' + (t.error || 'unknown error'));
      if (t.state !== 'completed') throw new Error('NOT_RUN: recorded turn state=' + t.state + ' (' + tag + ').');
      assert(Array.isArray(t.citations) && t.citations.length >= 1, 'Completed answer needs >=1 citation (' + tag + ').');
      assert.equal(t.invalidLabels, 0, 'Completed answer must resolve every label (' + tag + ').');
      for (const c of t.citations) {
        assert(c && c.revisionId === m.revisionId && c.sourceId === m.sourceId, 'Citation must reference the recorded revision (' + tag + ').');
        assert(Number.isSafeInteger(c.block) && Number.isSafeInteger(c.start) && Number.isSafeInteger(c.end) && c.end > c.start, 'Citation needs block and exact byte range (' + tag + ').');
        await smokeRange(m.revisionId, c.start, c.end, tag);
      }
      aInfo = t.citations.length + ' cites, 0 invalid';
      chatStatus = 'completed';
    } catch (e) {
      const cmsg = String((e && e.message) || e).split('\n')[0];
      if (cmsg.indexOf('NOT_RUN: ') >= 0) violations.push(tag + ': chat NOT_RUN (' + cmsg.slice(9) + ').');
      else { chatStatus = 'failed'; violations.push(tag + ': chat FAIL (' + cmsg + ').'); }
    }
    try {
      const u = await apiJson('/api/sources/' + encodeURIComponent(m.sourceId) + '/understanding?revisionId=' + encodeURIComponent(m.revisionId));
      if (u.status !== 200) throw new Error('NOT_RUN: GET understanding must be 200, got ' + u.status + ' (' + tag + ').');
      distillUsage = u.body.report?.usage ?? null;
      const reported = distillUsage?.providerUsage;
      if (Array.isArray(reported) && reported.length > 0 && reported.length === distillUsage.calls && reported.every((item) => item && typeof item.cost === 'number' && Number.isFinite(item.cost) && item.cost >= 0))
        providerCosts.distillUsd = reported.reduce((sum, item) => sum + item.cost, 0);
      if (u.body.state === 'failed') throw new Error(tag + ': provider distillation failed: ' + (u.body.error || 'unknown error'));
      if (u.body.state !== 'done' && u.body.state !== 'partial') throw new Error('NOT_RUN: distill state=' + u.body.state + ' (' + tag + ').');
      assert(u.body.report && typeof u.body.report === 'object', 'Distilled revision must carry its report (' + tag + ').');
      assert(u.body.report.usage && typeof u.body.report.usage.calls === 'number' && u.body.report.usage.calls <= 2, 'Distill usage.calls must be numeric and bounded at most 2 (' + tag + ').');
      const uclaims = Array.isArray(u.body.claims) ? u.body.claims : [];
      assert(uclaims.length <= 32, 'Distill claims capped at 32 (' + tag + ').');
      for (const c of uclaims) {
        assert(c && typeof c.quote === 'string' && c.quote.length > 0, 'Distilled claim needs a non-empty quote (' + tag + ').');
        assert(Number.isSafeInteger(c.start) && Number.isSafeInteger(c.end) && c.end > c.start, 'Distilled claim needs an exact byte range (' + tag + ').');
        const qb = await smokeRange(m.revisionId, c.start, c.end, tag + ' claim');
        assert.equal(qb.toString('utf8'), c.quote, 'Distilled quote must equal the range bytes exactly (' + tag + ').');
      }
      assert(typeof u.body.guide === 'string' && u.body.guide.length > 0, 'Distilled guide must be readable (' + tag + ').');
      assert(u.body.digest === null || (typeof u.body.digest === 'string' && u.body.digest.length > 0), 'Distilled digest must be null or readable (' + tag + ').');
      assert(Array.isArray(u.body.glossary), 'Distilled glossary must be an array (' + tag + ').');
      if (uclaims.length === 0) {
        distillStatus = 'PARTIAL_NO_CLAIMS';
        dInfo = '0 claims, ' + u.body.report.usage.calls + ' calls';
        violations.push(tag + ': PARTIAL_NO_CLAIMS (partial, 0 claims; limited, never full PASS).');
      } else {
        distillStatus = u.body.state;
        dInfo = uclaims.length + ' claims, ' + u.body.report.usage.calls + ' calls';
      }
    } catch (e) {
      const dmsg = String((e && e.message) || e).split('\n')[0];
      if (dmsg.indexOf('NOT_RUN: ') >= 0) { distillStatus = 'NOT_RUN'; violations.push(tag + ': distill NOT_RUN (' + dmsg.slice(9) + ').'); }
      else { distillStatus = 'failed'; violations.push(tag + ': distill FAIL (' + dmsg + ').'); }
    }
    let modelStatus = 'PASS';
    if (chatStatus === 'failed' || distillStatus === 'failed') modelStatus = 'FAIL';
    else if (chatStatus === 'NOT_RUN' || distillStatus === 'NOT_RUN') modelStatus = 'NOT_RUN';
    else if (distillStatus === 'PARTIAL_NO_CLAIMS') modelStatus = 'PARTIAL_NO_CLAIMS';
    const usageCell = usageCompleteness + (usageCompleteness === 'known' ? '' : ' (' + nullFields.map((k) => k + ': null').join(', ') + ')');
    perModel.push({ route: tag, status: modelStatus, chatStatus, distillStatus, usage, usageCompleteness, providerUsage: providerUsageRaw, providerCosts, distillUsage, answer: aInfo, distill: dInfo });
    rows.push('| ' + tag + ' | ' + modelStatus + ' | ' + usageCell + ' | ' + aInfo + ' | ' + dInfo + ' |');
  }
  const costs = perModel.flatMap((p) => [p.providerCosts.chatUsd, p.providerCosts.distillUsd]);
  const providerReportedCost = (costs.length > 0 && costs.every((c) => typeof c === 'number')) ? costs.reduce((n, c) => n + c, 0) : 'UNKNOWN';
  const overall = violations.length > 0 ? 'FAIL' : 'LIMITED';
  const stamp = Date.now();
  const md = ['# OpenRouter stored revalidation (real provider jobs, zero new model calls)', '', '- project: ' + ids.projectId, '- handles: eval/out/openrouter-smoke/ids.json' + (ids.publicUrl ? ' / ' + ids.publicUrl : ''), '- probe: ' + (ids.text || '(recorded)'), '- overall: ' + overall, '- provider reported cost: ' + providerReportedCost].concat(['', '| model | status | usageCompleteness | answer | distill |', '|---|---|---|---|---|']).concat(rows).concat(['', '## Open gates / failures']).concat(violations.length > 0 ? violations.map((v) => '- ' + v) : ['- none']).concat(['']).join(EOL);
  console.log(md);
  await writeFile(smokeDir + '/openrouter-stored-' + stamp + '.md', md);
  await writeFile(smokeDir + '/openrouter-stored-' + stamp + '.json', JSON.stringify({ projectId: ids.projectId, overall, providerReportedCost, models: perModel, violations }, null, 2));
  assert.equal(violations.length, 0, 'OpenRouter stored gates OPEN (' + violations.length + '): ' + violations.join('; '));
  process.exit(0);
}
const title = process.env.ELIOT_EVAL_PROJECT || (nativeOnly ? 'k1-eval' : 'Библиотека — PDF и точные ссылки');
let projects = [], cursor = undefined;
for (let i = 0; i < 5; i++) {
  const p = await apiJson('/api/projects' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
  assert.equal(p.status, 200, 'GET /api/projects must be 200.');
  projects = projects.concat(p.body.projects || []);
  cursor = p.body.nextCursor || undefined;
  if (!cursor) break;
}
const proj = projects.find((p) => p.title === title);
if (!proj) { console.log('PREP_K1_NOT_READY: project ' + JSON.stringify(title) + ' not found; prep K1 corpus first, do not upload/convert again.'); process.exit(2); }
let sources = [], scur = undefined;
for (let i = 0; i < 10; i++) {
  const s = await apiJson('/api/projects/' + encodeURIComponent(proj.id) + '/sources' + (scur ? '?cursor=' + encodeURIComponent(scur) : ''));
  assert.equal(s.status, 200, 'GET sources must be 200.');
  sources = sources.concat(s.body.sources || []);
  scur = s.body.nextCursor || undefined;
  if (!scur) break;
}
const want = new Set(Array.from({ length: 10 }, (_, i) => 'arxiv-' + String(i + 1).padStart(2, '0') + '.pdf'));
const scoped = sources.filter((s) => want.has(s.originalFilename) && s.currentRevisionId && (s.readableState === 'readable' || s.readableState === 'readable_with_warnings'));
if (!nativeOnly && scoped.length < 10) { console.log('PREP_K1_NOT_READY: found ' + scoped.length + '/10 arxiv readable; prep K1 first, do not upload/convert again.'); process.exit(2); }
const sourceIds = scoped.map((s) => s.id);
const revSet = new Set(scoped.map((s) => s.currentRevisionId));
const qmd = await readFile(evalDir + '/arxiv-10/questions.md', 'utf8');
const order = ['C1', 'C2', 'C3', 'C4', 'O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7', 'O8'];
const Q = new Map();
for (const line of qmd.split(EOL)) {
  const parts = line.split('|').map((p) => p.trim());
  if (parts.length >= 3 && order.includes(parts[1]) && parts[2]) Q.set(parts[1], parts[2]);
}
assert.equal(Q.size, 12, 'questions.md must define C1-4 and O1-8.');
let chatId = resumeChat;
if (!chatId) {
  const cj = await apiJson('/api/projects/' + encodeURIComponent(proj.id) + '/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'k2-eval ' + Date.now() }) });
  assert(cj.status === 201 || cj.status === 200, 'POST chats must be 201/200; got ' + cj.status + ' (K2 product API not wired yet).');
  assert(cj.body && typeof cj.body.chat === 'object', 'POST chats must return {chat}.');
  assert(typeof cj.body.chat.id === 'string' && cj.body.chat.id.length > 0, 'chat.id required.');
  chatId = cj.body.chat.id;
}
const chatPath = '/api/projects/' + encodeURIComponent(proj.id) + '/chats/' + encodeURIComponent(chatId);
let configuredBudgetMicrousd = null;
async function getChat(what) {
  const h = await apiJson(chatPath);
  assert.equal(h.status, 200, 'GET chat must be 200 and storage-only (' + what + ').');
  assert(h.body && typeof h.body.chat === 'object', 'GET chat must return {chat, turns, monthlyUsedMicrousd, monthlyBudgetMicrousd}.');
  assert(Array.isArray(h.body.turns), 'GET chat must return turns array.');
  assert(typeof h.body.monthlyUsedMicrousd === 'number', 'GET chat must return monthlyUsedMicrousd.');
  assert(Number.isSafeInteger(h.body.monthlyBudgetMicrousd) && h.body.monthlyBudgetMicrousd >= 0, 'GET chat must return a valid configured monthly budget.');
  if (configuredBudgetMicrousd === null) configuredBudgetMicrousd = h.body.monthlyBudgetMicrousd;
  assert.equal(h.body.monthlyBudgetMicrousd, configuredBudgetMicrousd, 'Monthly budget must stay at the first-observed configured snapshot; this script never writes or raises it.');
  return h.body;
}
const h0 = await getChat(resumeChat ? 'resume' : 'before');
if (resumeChat) assert.equal(h0.chat.id, resumeChat, 'Resumed chat id must match ELIOT_EVAL_CHAT.');
const m0 = h0.monthlyUsedMicrousd;
const whole = new Map();
async function checkRange(rev, st, en) {
  let w = whole.get(rev);
  if (!w) { const t = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/text'); assert.equal(t.status, 200, 'GET revision text 200.'); w = t.bytes; whole.set(rev, w); }
  const r = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/range?start=' + st + '&end=' + en);
  assert.equal(r.status, 200, 'Each cited range must open (GET range 200).');
  assert(r.bytes.equals(w.subarray(st, en)), 'Cited range must equal the whole-text slice.');
}
{
  const s0 = scoped[0] || sources.find((source) => source.currentRevisionId && ['readable', 'readable_with_warnings'].includes(source.readableState));
  assert(s0, 'A readable K1 source is required for the native reader check.');
  const t = await apiBytes('/api/revisions/' + encodeURIComponent(s0.currentRevisionId) + '/text');
  assert.equal(t.status, 200, 'Native reader check needs GET text 200.');
  let end = Math.min(512, t.bytes.length);
  while (end > 0 && (t.bytes[end] & 192) === 128) end--;
  await checkRange(s0.currentRevisionId, 0, end);
}
async function saveTurn(qid, turn, extra) {
  const doc = { chatId, qid, turnId: turn.turnId, reused: !!extra.reused, src: extra.src, question: extra.question || null, model: turn.model ?? null, answer: turn.answer ?? null, state: turn.state, error: turn.error ?? null, citations: turn.citations ?? null, invalidLabels: turn.invalidLabels ?? null, inputTokens: turn.inputTokens ?? null, cachedTokens: turn.cachedTokens ?? null, outputTokens: turn.outputTokens ?? null, estimatedCostMicrousd: turn.estimatedCostMicrousd ?? null, actualProviderCostUsd: actualProviderCostUsd(turn), firstTokenMs: turn.firstTokenMs ?? null, totalMs: turn.totalMs ?? null, wallMs: extra.wall ?? null };
  await writeFile(outDir + '/k2-' + qid + '-' + String(turn.turnId).slice(0, 8) + '.json', JSON.stringify(doc, null, 2));
}
function actualProviderCostUsd(turn) {
  const v = turn && turn.providerUsage ? turn.providerUsage.costUsd : null;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}
function reusableCandidate(qid, turns, used) {
  for (const t of turns) {
    if (!t || typeof t.turnId !== 'string' || used.has(t.turnId) || t.state !== 'completed') continue;
    if (evalModel !== null && t.model !== evalModel) continue;
    if (!Array.isArray(t.citations) || t.citations.length < 1 || t.invalidLabels !== 0) continue;
    if (typeof t.answer !== 'string') continue;
    if (t.question !== Q.get(qid)) continue;
    if (t.scopeMode !== 'explicit') continue;
    if (t.contextMode !== 'whole') continue;
    if (!Array.isArray(t.sourceIds) || t.sourceIds.length !== sourceIds.length || !sourceIds.every((id) => t.sourceIds.includes(id))) continue;
    if (!Array.isArray(t.revisionIds) || t.revisionIds.length !== scoped.length || !scoped.every((s) => t.revisionIds.includes(s.currentRevisionId))) continue;
    if (!t.citations.every((c) => c && revSet.has(c.revisionId))) continue;
    if (uncitedStatements(t.answer, t.citations) > 0) continue;
    return t;
  }
  return null;
}
if (evalModel !== null && runModel && !storedOnly) {
  const selected = await apiJson('/api/models?selected=' + encodeURIComponent(evalModel));
  assert.equal(selected.status, 200, 'GET /api/models?selected must be 200 for ELIOT_EVAL_MODEL.');
  const entry = (selected.body.models || []).find((m) => m && m.route === evalModel);
  assert(entry, 'ELIOT_EVAL_MODEL must match one live catalogue route; no alias fallback.');
  assert(typeof entry.id === 'string' && entry.id.trim().length > 0, 'Selected catalogue entry must carry a native ID.');
  assert(entry.enabled === true, 'Selected model must be enabled for ELIOT_EVAL_MODEL; no fallback or connection write.');
  assert(Number.isSafeInteger(entry.contextTokens) && entry.contextTokens > 0, 'Selected model context must be usable (unknown context is not admitted).');
  for (const field of ['inputMicrousdPerMillion', 'outputMicrousdPerMillion']) {
    const price = entry[field];
    assert(typeof price === 'number' && Number.isFinite(price) && price >= 0, 'Selected model ' + field + ' must be known (unknown cached pricing is allowed).');
  }
}
if (!runModel && !storedOnly) {
  const h1 = await getChat('re-read');
  assert.equal(h1.turns.length, h0.turns.length, 'History re-read must not add turns.');
  assert.equal(h1.monthlyUsedMicrousd, m0, 'Pure history re-read must not change usage.');
  const md = ['# K2 native-only (storage, zero model calls)', '', '- project: ' + title, '- chat: ' + chatId + (resumeChat ? ' (resumed)' : ''), '- history: ' + h0.turns.length + ' turns, monthlyUsedMicrousd stable across re-reads', '- reader range self-check: 1 exact range', '- MODEL_NOT_RUN: set ELIOT_K2_MODEL=1 (root signal) for C1-4/O1-8 paid turns.', '- Stop/reconnect/Save: NOT_RUN here (root browser journey).', ''].join(EOL);
  await writeFile(outDir + '/k2-native-' + Date.now() + '.md', md);
  console.log(md);
  process.exit(0);
}
if (storedOnly) {
  assert(resumeChat, '--stored-only requires ELIOT_EVAL_CHAT set to an existing completed chat id; this mode never creates chats or submits turns (zero model calls by construction).');
  const sRows = [];
  let sFailed = 0;
  const sUsed = new Set();
  const sCompleted = new Set();
  const revOwner = new Map(scoped.filter((s) => s && typeof s.currentRevisionId === 'string').map((s) => [s.currentRevisionId, s.id]));
  let sActualKnownUsd = 0, sActualKnownCount = 0, sActualUnknown = 0;
  for (const qid of order) {
    const turn = reusableCandidate(qid, h0.turns, sUsed);
    if (!turn) {
      sFailed++;
      sRows.push('| ' + qid + ' | NOT_REVALIDATED | - | - | - | - | - | - | - | - |');
      continue;
    }
    sUsed.add(turn.turnId);
    assert(typeof turn.answer === 'string', qid + ': stored turn.answer must be a string.');
    assert(Array.isArray(turn.citations) && turn.citations.length >= 1, qid + ': stored completed answer needs >=1 citation.');
    assert(typeof turn.invalidLabels === 'number' && turn.invalidLabels === 0, qid + ': stored invalidLabels must be 0.');
    for (const c of turn.citations) {
      assert(c && typeof c.revisionId === 'string', qid + ': citation needs full revisionId.');
      assert(typeof c.sourceId === 'string', qid + ': citation needs sourceId.');
      assert(typeof c.block === 'number', qid + ': citation needs numeric block.');
      assert(typeof c.start === 'number' && typeof c.end === 'number', qid + ': citation needs numeric start/end.');
      assert(Array.isArray(turn.revisionIds) && turn.revisionIds.includes(c.revisionId), qid + ': citation revisionId must belong to the turn frozen scope.');
      assert(revOwner.get(c.revisionId) === c.sourceId, qid + ': citation sourceId must be the scoped source owning the cited revision.');
      if (Array.isArray(turn.sourceIds)) assert(turn.sourceIds.includes(c.sourceId), qid + ': citation sourceId must belong to the turn frozen source scope.');
      await checkRange(c.revisionId, c.start, c.end);
    }
    const sActual = actualProviderCostUsd(turn);
    const doc = { chatId, qid, turnId: turn.turnId, reused: true, src: 'stored', question: Q.get(qid), answer: turn.answer ?? null, state: turn.state, citations: turn.citations ?? null, invalidLabels: turn.invalidLabels ?? null, inputTokens: turn.inputTokens ?? null, cachedTokens: turn.cachedTokens ?? null, outputTokens: turn.outputTokens ?? null, estimatedCostMicrousd: turn.estimatedCostMicrousd ?? null, actualProviderCostUsd: sActual, firstTokenMs: turn.firstTokenMs ?? null, totalMs: turn.totalMs ?? null, wallMs: null };
    await writeFile(outDir + '/k2-stored-' + qid + '-' + String(turn.turnId).slice(0, 8) + '.json', JSON.stringify(doc, null, 2));
    checkAnswer(qid, turn.answer);
    sCompleted.add(qid);
    if (sActual === null) sActualUnknown++; else { sActualKnownUsd += sActual; sActualKnownCount++; }
    for (const k of ['inputTokens', 'cachedTokens', 'outputTokens', 'estimatedCostMicrousd', 'firstTokenMs', 'totalMs']) assert(typeof turn[k] === 'number', qid + ': stored turn.' + k + ' must be a number.');
    assert(turn.totalMs <= 90000, qid + ': catastrophic ceiling 90s exceeded.');
    sRows.push('| ' + qid + ' | stored-completed | ' + turn.citations.length + ' | 0 | ' + turn.inputTokens + '/' + turn.cachedTokens + '/' + turn.outputTokens + ' | ' + turn.estimatedCostMicrousd + ' | ' + (sActual === null ? 'UNKNOWN' : sActual) + ' | ' + turn.firstTokenMs + ' | ' + turn.totalMs + ' | stored |');
  }
  const hF = await getChat('stored-final');
  const ownerGate = 'O1/O2/O3/O8 owner-quality gate: NOT_ACCEPTED (OWNER_REQUIRED) — the script never auto-passes human gates; retained historical references below, owner judgment required.';
  const defects = [
    'Retained historical reference (older Flash run, not observed here): O2 stored answer unsupported Chinese fragment "下游" (model-introduced; cited English ranges say "transferred"). Terminology defect.',
    'Retained historical reference (older Flash run, not observed here): O2 stored answer "растёт быстрее, чем модель" growth-rate phrasing has no same-range source basis. Inference defect.',
    'Retained historical reference (older Flash run, not observed here): O2 stored answer chain-of-thought scale-emergence result absent although the eval expects it (CoT/S4 uncited). Coverage defect.',
    'Retained historical reference (separate chat recheck-O2.json, not observed here): LoRA "0,01% (4,7 млн вместо 175 млрд)" pairing is arithmetically inconsistent (0.01% of 175B = 17.5M); [S10:42] cites setup text, not the quoted demonstration sentence (sibling labels cover the claims).'
  ];
  const sKnownActualText = sActualKnownCount > 0 ? String(sActualKnownUsd) : 'UNKNOWN';
  const md = ['# K2 Ask eval — stored-only revalidation (zero model calls)', '', '- project: ' + title + ' (10 arxiv explicit scope, exact frozen scope enforced per turn)', '- chat: ' + chatId + ' (stored-only; ELIOT_EVAL_CHAT, never created or submitted)', '- mode: whole revalidation from storage only; estimated/reserved new-turn delta is 0 micro-USD (NOT actual provider spend)', '- monthly before/after: ' + m0 + '/' + hF.monthlyUsedMicrousd + ' micro-USD (must be equal)', '- configured budget, never written or raised: ' + hF.monthlyBudgetMicrousd, '- actual known provider cost (providerUsage.costUsd only; token-rate math is never actual): ' + sKnownActualText + ' USD across ' + sActualKnownCount + ' turn(s); unknown actual ' + sActualUnknown + ' (unknown is never zero)', '- ' + ownerGate, '- retained historical reference, not observed here (mechanical PASS does not clear these):'].concat(defects.map((d) => '  - ' + d)).concat(['', '| q | state | cites | invalid | in/cached/out | est_uUSD | actual_usd | first_ms | total_ms | wall_ms |', '|---|---|---|---|---|---|---|---|---|---|']).concat(sRows).concat(['']).join(EOL);
  await writeFile(outDir + '/k2-stored-only-' + Date.now() + '.md', md);
  console.log(md);
  assert.equal(hF.turns.length, h0.turns.length, 'Stored-only run must not add turns (zero submissions).');
  assert.equal(hF.monthlyUsedMicrousd, m0, 'Stored-only run must not change monthly usage (zero new model calls).');
  assert.equal(sFailed, 0, sFailed + ' question(s) have no exact-question/exact-frozen-scope completed stored turn; this mode never submits missing/failed turns.');
  assert(order.every((q) => sCompleted.has(q)), 'All 12 questions must revalidate from storage.');
  process.exit(0);
}
const rows = [];
const firstMs = [], totalMs = [];
let newCostMicro = 0, reportedMicro = 0, failed = 0, manual = 0, newCount = 0;
let unknownCosts = 0, unknownNewCosts = 0;
let actualKnownUsd = 0, actualKnownCount = 0, actualUnknown = 0, actualUnknownNew = 0;
const completedQuestions = new Set();
const used = new Set();
for (const qid of order) {
  let turn = null, src = 'new', wall = null;
  if (resumeChat) {
    const cand = reusableCandidate(qid, h0.turns, used);
    if (cand) { turn = cand; src = 'reused'; used.add(cand.turnId); }
    else if (h0.turns.some((t) => t && t.question === Q.get(qid))) { rows.push('| ' + qid + ' | PENDING_MANUAL | - | - | - | - | - | - | - | - |'); manual++; continue; }
  }
  if (!turn) {
    const turnId = randomUUID();
    const t0 = Date.now();
    const r = await apiJson(chatPath + '/turns?wait=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90000), body: JSON.stringify({ turnId, question: Q.get(qid), scopeMode: 'explicit', sourceIds, ...(evalModel !== null ? { model: evalModel } : {}) }) });
    wall = Date.now() - t0;
    assert(r.status === 200 || r.status === 201, 'POST turns?wait=1 must be 200/201 for ' + qid + '.');
    assert(r.body && typeof r.body.turn === 'object', 'POST turns?wait=1 must return {turn} for ' + qid + '.');
    turn = r.body.turn;
    assert.equal(turn.turnId, turnId, qid + ': turn.turnId must echo the request turnId.');
    if (evalModel !== null) assert.equal(turn.model, evalModel, qid + ': stored turn.model must equal ELIOT_EVAL_MODEL; no cross-model mixing.');
    newCount++;
  } else {
    assert(typeof turn.turnId === 'string' && turn.turnId.length > 0, qid + ': reused turn.turnId required.');
    if (evalModel !== null) assert.equal(turn.model, evalModel, qid + ': reused turn.model must equal ELIOT_EVAL_MODEL; no cross-model mixing.');
  }
  assert(typeof turn.answer === 'string', qid + ': turn.answer must be a string.');
  const cost = turn.estimatedCostMicrousd;
  if (cost === null || cost === undefined) {
    unknownCosts++;
    if (src === 'new') unknownNewCosts++;
  } else {
    assert(Number.isSafeInteger(cost) && cost >= 0, qid + ': invalid estimated cost.');
    reportedMicro += cost;
    if (src === 'new') newCostMicro += cost;
  }
  const actual = actualProviderCostUsd(turn);
  if (actual === null) {
    actualUnknown++;
    if (src === 'new') actualUnknownNew++;
  } else {
    actualKnownUsd += actual;
    actualKnownCount++;
  }
  if (turn.state !== 'completed') {
    await saveTurn(qid, turn, { src, wall, question: Q.get(qid) }); failed++;
    const metric = (value) => typeof value === 'number' ? value : 'UNKNOWN';
    rows.push('| ' + qid + ' | ' + turn.state + ' | ' + (Array.isArray(turn.citations) ? turn.citations.length : 'UNKNOWN')
      + ' | ' + metric(turn.invalidLabels) + ' | ' + metric(turn.inputTokens) + '/' + metric(turn.cachedTokens) + '/' + metric(turn.outputTokens)
      + ' | ' + metric(cost) + ' | ' + metric(actual) + ' | ' + metric(turn.firstTokenMs) + ' | ' + metric(turn.totalMs) + ' | ' + (wall === null ? '-' : wall) + ' |');
    break;
  }
  assert(Array.isArray(turn.citations) && turn.citations.length >= 1, qid + ': completed answer needs >=1 citation.');
  assert(typeof turn.invalidLabels === 'number' && turn.invalidLabels === 0, qid + ': invalidLabels must be 0.');
  for (const c of turn.citations) {
    assert(c && typeof c.revisionId === 'string', qid + ': citation needs full revisionId.');
    assert(typeof c.sourceId === 'string', qid + ': citation needs sourceId.');
    assert(typeof c.block === 'number', qid + ': citation needs numeric block.');
    assert(typeof c.start === 'number' && typeof c.end === 'number', qid + ': citation needs numeric start/end.');
    assert(Array.isArray(turn.revisionIds) && turn.revisionIds.includes(c.revisionId), qid + ': citation revisionId must belong to the turn frozen scope.');
    assert(Array.isArray(turn.sourceIds) && turn.sourceIds.includes(c.sourceId), qid + ': citation sourceId must belong to the turn frozen source scope.');
    await checkRange(c.revisionId, c.start, c.end);
  }
  assert.equal(turn.scopeMode, 'explicit', qid + ': live turn must keep explicit scope (no project-default fallback).');
  assert.equal(turn.contextMode, 'whole', qid + ': live turn must be whole-reading (no claims/none fallback).');
  assert(Array.isArray(turn.sourceIds) && turn.sourceIds.length === sourceIds.length && sourceIds.every((id) => turn.sourceIds.includes(id)), qid + ': live turn sourceIds must equal the exact frozen 10-arxiv scope.');
  assert(Array.isArray(turn.revisionIds) && turn.revisionIds.length === scoped.length && scoped.every((s) => turn.revisionIds.includes(s.currentRevisionId)), qid + ': live turn revisionIds must equal the exact frozen current revisions.');
  assert(uncitedStatements(turn.answer, turn.citations) === 0, qid + ': completed answer must have no uncited factual statements.');
  await saveTurn(qid, turn, { src, wall, reused: src === 'reused', question: Q.get(qid) });
  checkAnswer(qid, turn.answer);
  completedQuestions.add(qid);
  for (const k of ['inputTokens', 'cachedTokens', 'outputTokens', 'estimatedCostMicrousd', 'firstTokenMs', 'totalMs']) assert(typeof turn[k] === 'number', qid + ': turn.' + k + ' must be a number.');
  assert(turn.totalMs <= 90000, qid + ': catastrophic ceiling 90s exceeded.');
  firstMs.push(turn.firstTokenMs); totalMs.push(turn.totalMs);
  rows.push('| ' + qid + ' | completed(' + src + ') | ' + turn.citations.length + ' | 0 | ' + turn.inputTokens + '/' + turn.cachedTokens + '/' + turn.outputTokens + ' | ' + turn.estimatedCostMicrousd + ' | ' + (actual === null ? 'UNKNOWN' : actual) + ' | ' + turn.firstTokenMs + ' | ' + turn.totalMs + ' | ' + (wall === null ? 'reused' : wall) + ' |');
}
const h1 = await getChat('after turns');
const h2 = await getChat('final re-read');
const usdNew = newCostMicro / 1e6;
const knownActualText = actualKnownCount > 0 ? String(actualKnownUsd) : 'UNKNOWN';
const md = ['# K2 Ask eval', '', '- project: ' + title + ' (10 arxiv explicit scope)', '- chat: ' + chatId + (resumeChat ? ' (resumed, no paid retry)' : ''), '- model override: ' + (evalModel ?? '(none; product default)'), '- mode: whole, one call/turn, no paid retry', '- estimated/reserved cost (NOT actual provider spend): evaluated turns ' + reportedMicro + ' micro-USD; new-turn subtotal ' + newCostMicro + ' micro-USD ($' + usdNew.toFixed(4) + ', configured budget, never written or raised)', '- actual known provider cost (providerUsage.costUsd only; token-rate math is never actual): ' + knownActualText + ' USD across ' + actualKnownCount + ' turn(s); unknown actual ' + actualUnknown + '/' + actualUnknownNew + ' all/new (unknown is never zero)', '- monthly: ' + h1.monthlyUsedMicrousd + '/' + h1.monthlyBudgetMicrousd + ' micro-USD', '- cold first/total: ' + firstMs[0] + '/' + totalMs[0] + ' ms', '- warm first p50/p95: ' + pct(firstMs.slice(1), 0.5) + '/' + pct(firstMs.slice(1), 0.95) + ' ms', '- warm total p50/p95: ' + pct(totalMs.slice(1), 0.5) + '/' + pct(totalMs.slice(1), 0.95) + ' ms', '- O1/O2/O3/O8 quality vs eval/arxiv-10/baseline.md: OWNER_JUDGMENT_REQUIRED (script never auto-passes human gates)', '- Stop/reconnect/Save: NOT_RUN here (root browser journey).', '', '| q | state | cites | invalid | in/cached/out | est_uUSD | actual_usd | first_ms | total_ms | wall_ms |', '|---|---|---|---|---|---|---|---|---|---|'].concat(rows).concat(['']).join(EOL);
const accounting = EOL + '- observed monthly delta: ' + (h1.monthlyUsedMicrousd - m0)
  + ' micro-USD (reservation delta, NOT actual provider spend); estimated unknown turns all/new: ' + unknownCosts + '/' + unknownNewCosts
  + ' (known estimate subtotals are incomplete if an unknown count is nonzero)' + EOL;
await writeFile(outDir + '/k2-' + Date.now() + '.md', md + accounting);
console.log(md + accounting);
assert.equal(failed, 0, failed + ' paid turn(s) did not complete; no retry by design. Operator must create any manual new turn separately.');
assert.equal(manual, 0, manual + ' question(s) PENDING_MANUAL: a same-question turn exists without an exact reusable completion; no auto re-request. Operator must create any manual new turn separately.');
assert(order.every((q) => completedQuestions.has(q)), 'All 12 questions must complete.');
assert.equal(h1.turns.length, h0.turns.length + newCount, 'History must hold exactly the pre-existing plus new turns.');
assert.equal(unknownNewCosts, 0, 'New-turn cost is incomplete; UNKNOWN must not count as free.');
assert.equal(h1.monthlyUsedMicrousd - m0, newCostMicro, 'Monthly usage delta must equal new-turn cost only (reused turns cost nothing new).');
assert(h1.monthlyUsedMicrousd <= h1.monthlyBudgetMicrousd, 'Monthly budget exceeded: ' + h1.monthlyUsedMicrousd + ' > ' + h1.monthlyBudgetMicrousd);
assert.equal(h2.monthlyUsedMicrousd, h1.monthlyUsedMicrousd, 'Pure history re-read must not change usage.');
