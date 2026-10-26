import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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
const BUDGET_DEFAULT = 5000000;
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
  const EXPECTED_EXTERNAL = [
    'gateway:openrouter/dots-studio/dots-3-note-preview:free',
    'gateway:openrouter/thinkingmachines/inkling:free',
    'gateway:openrouter/nvidia/nemotron-3.5-super-vl:free',
  ];
  const externals = models.body.models.filter((m) => m && typeof m.route === 'string' && m.route.startsWith('gateway:openrouter/'));
  assert.deepEqual(externals.map((m) => m.route).sort(), [...EXPECTED_EXTERNAL].sort(), 'Models-only expects exactly the three free OpenRouter chat routes.');
  for (const m of externals) assert(m && !m.enabled && m.unavailableReason, 'External model must be visibly disabled without owner credential opt-in (' + m.route + ').');
  const external = externals[0];
  assert(external, 'At least one external OpenRouter route is required.');
  const embedders = models.body.models.filter((m) => m && /embed|rerank/i.test(m.route + ' ' + (m.id || '') + ' ' + (m.label || '')));
  assert.deepEqual(embedders.map((m) => m.route), [], 'No embed/rerank model may be offered for selection.');
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
    await context.route('**/api/settings', async (route) => {
      if (route.request().method() === 'PUT') settingsPuts += 1;
      await route.continue();
    });
    const errors = [];
    const desktop = await context.newPage({ viewport: { width: 1440, height: 900 } });
    desktop.on('pageerror', (error) => errors.push(error.message));
    await desktop.goto(origin + '/settings');
    await expect(desktop.getByRole('region', { name: 'Models', exact: true })).toBeVisible();
    await desktop.screenshot({ path: outDir + '/external-models-desktop.png', fullPage: true });
    await desktop.close();
    const page = await context.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin + '/settings');
    const gateway = page.getByRole('region', { name: 'Connection', exact: true });
    await expect(gateway).toBeVisible();
    await expect(gateway.getByRole('checkbox')).not.toBeChecked();
    await gateway.getByRole('textbox', { name: 'Gateway ID' }).fill('unconfigured-eval-gateway');
    await expect(gateway.getByRole('button', { name: 'Save connection' })).toBeDisabled();
    await expect(page.getByRole('textbox', { name: 'Monthly budget (USD)', exact: true })).toHaveValue(String(before.body.settings.monthlyModelBudgetMicrousd / 1000000));
    await expect(page.getByRole('combobox', { name: 'Answer model', exact: true })).toHaveValue(before.body.settings.answerModel);
    await expect(page.getByRole('combobox', { name: 'Answer model', exact: true }).locator('option[value="' + external.route + '"]')).toHaveJSProperty('disabled', true);
    await expect(page.getByRole('combobox', { name: 'Understanding model', exact: true })).toHaveValue(before.body.settings.distillModel);
    await expect(page.getByRole('combobox', { name: 'Understanding model', exact: true }).locator('option[value="' + external.route + '"]')).toHaveJSProperty('disabled', true);
    assert((await page.locator('#workspace-main details').count()) >= 1, 'Compact Settings must expose collapsed technical details.');
    assert.strictEqual(await page.locator('#workspace-main details[open]').count(), 0, 'Compact default UI must not display expanded technical walls.');
    const summaries = page.locator('#workspace-main details > summary');
    for (let i = 0; i < await summaries.count(); i++) assert((await summaries.nth(i).innerText()).trim().length > 0, 'Every collapsed section must carry an accessible label.');
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
    await expect(modelsSection.getByRole('status')).toContainText('Use up to six decimal places for the monthly budget.');
    assert.strictEqual(settingsPuts, 0, 'Seven-decimal budget must be rejected before any PUT /api/settings.');
    await budget.fill(String(before.body.settings.monthlyModelBudgetMicrousd / 1000000));
    await expect(budget).toHaveValue(String(before.body.settings.monthlyModelBudgetMicrousd / 1000000));
    if (sourceId) {
      await page.goto(origin + '/p/' + projectId + '/source/' + sourceId);
      const understanding = page.getByRole('region', { name: 'Understanding', exact: true });
      await expect(understanding.getByRole('combobox', { name: 'Model', exact: true })).toBeVisible();
      await expect(understanding.getByRole('combobox', { name: 'Model', exact: true }).locator('option[value="' + external.route + '"]')).toHaveJSProperty('disabled', true);
    }
    assert.deepEqual(errors, [], 'Settings/understanding must not throw browser errors.');
  } finally { await browser.close(); }
  const after = await apiJson('/api/settings');
  assert.deepEqual(after.body.settings, before.body.settings, 'Native defaults, auto-distill, budget and settings timestamp must be unchanged.');
  assert.equal(after.body.monthlyUsedMicrousd, before.body.monthlyUsedMicrousd);
  assert.equal((await apiJson('/api/models/connection')).body.connection.gatewayId, null);
  const result = { scope: 'LOCAL_CONNECTION_AND_ADMISSION', projectId, chatId, consentRejected: true, disconnectedTurnCost: 0,
    monthlyUsedMicrousd: after.body.monthlyUsedMicrousd, provider: 'NOT_RUN', streaming: 'NOT_RUN', distill, browser390: 'LOCAL_PASS', credentialAccess: 'NOT_ENABLED' };
  await writeFile(outDir + '/external-models-native.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
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
async function getChat(what) {
  const h = await apiJson(chatPath);
  assert.equal(h.status, 200, 'GET chat must be 200 and storage-only (' + what + ').');
  assert(h.body && typeof h.body.chat === 'object', 'GET chat must return {chat, turns, monthlyUsedMicrousd, monthlyBudgetMicrousd}.');
  assert(Array.isArray(h.body.turns), 'GET chat must return turns array.');
  assert(typeof h.body.monthlyUsedMicrousd === 'number', 'GET chat must return monthlyUsedMicrousd.');
  assert(typeof h.body.monthlyBudgetMicrousd === 'number', 'GET chat must return monthlyBudgetMicrousd.');
  assert.equal(h.body.monthlyBudgetMicrousd, BUDGET_DEFAULT, 'Monthly budget must stay at the $5 default; this script never overrides it.');
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
  const doc = { chatId, qid, turnId: turn.turnId, reused: !!extra.reused, src: extra.src, question: extra.question || null, answer: turn.answer ?? null, state: turn.state, citations: turn.citations ?? null, invalidLabels: turn.invalidLabels ?? null, inputTokens: turn.inputTokens ?? null, cachedTokens: turn.cachedTokens ?? null, outputTokens: turn.outputTokens ?? null, estimatedCostMicrousd: turn.estimatedCostMicrousd ?? null, firstTokenMs: turn.firstTokenMs ?? null, totalMs: turn.totalMs ?? null, wallMs: extra.wall ?? null };
  await writeFile(outDir + '/k2-' + qid + '-' + String(turn.turnId).slice(0, 8) + '.json', JSON.stringify(doc, null, 2));
}
function reusableCandidate(qid, turns, used) {
  for (const t of turns) {
    if (!t || typeof t.turnId !== 'string' || used.has(t.turnId) || t.state !== 'completed') continue;
    if (!Array.isArray(t.citations) || t.citations.length < 1 || t.invalidLabels !== 0) continue;
    if (typeof t.answer !== 'string') continue;
    if (!t.citations.every((c) => c && revSet.has(c.revisionId))) continue;
    if (t.question !== Q.get(qid)) continue;
    if (!Array.isArray(t.sourceIds) || t.sourceIds.length !== sourceIds.length || !sourceIds.every((id) => t.sourceIds.includes(id))) continue;
    return t;
  }
  return null;
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
  for (const qid of order) {
    const turn = reusableCandidate(qid, h0.turns, sUsed);
    if (!turn) {
      sFailed++;
      sRows.push('| ' + qid + ' | NOT_REVALIDATED | - | - | - | - | - | - | - |');
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
    const doc = { chatId, qid, turnId: turn.turnId, reused: true, src: 'stored', question: Q.get(qid), answer: turn.answer ?? null, state: turn.state, citations: turn.citations ?? null, invalidLabels: turn.invalidLabels ?? null, inputTokens: turn.inputTokens ?? null, cachedTokens: turn.cachedTokens ?? null, outputTokens: turn.outputTokens ?? null, estimatedCostMicrousd: turn.estimatedCostMicrousd ?? null, firstTokenMs: turn.firstTokenMs ?? null, totalMs: turn.totalMs ?? null, wallMs: null };
    await writeFile(outDir + '/k2-stored-' + qid + '-' + String(turn.turnId).slice(0, 8) + '.json', JSON.stringify(doc, null, 2));
    checkAnswer(qid, turn.answer);
    sCompleted.add(qid);
    for (const k of ['inputTokens', 'cachedTokens', 'outputTokens', 'estimatedCostMicrousd', 'firstTokenMs', 'totalMs']) assert(typeof turn[k] === 'number', qid + ': stored turn.' + k + ' must be a number.');
    assert(turn.totalMs <= 90000, qid + ': catastrophic ceiling 90s exceeded.');
    sRows.push('| ' + qid + ' | stored-completed | ' + turn.citations.length + ' | 0 | ' + turn.inputTokens + '/' + turn.cachedTokens + '/' + turn.outputTokens + ' | ' + turn.estimatedCostMicrousd + ' | ' + turn.firstTokenMs + ' | ' + turn.totalMs + ' | stored |');
  }
  const hF = await getChat('stored-final');
  const ownerGate = 'O1/O2/O3/O8 owner-quality gate: NOT_ACCEPTED (OWNER_REQUIRED) — the script never auto-passes human gates; observed defects below, owner judgment required.';
  const defects = [
    'O2 stored answer: unsupported Chinese fragment "下游" (model-introduced; cited English ranges say "transferred"). Terminology defect.',
    'O2 stored answer: "растёт быстрее, чем модель" growth-rate phrasing has no same-range source basis. Inference defect.',
    'O2 stored answer: chain-of-thought scale-emergence result absent although the eval expects it (CoT/S4 uncited). Coverage defect.',
    'Recheck run recheck-O2.json (separate chat): LoRA "0,01% (4,7 млн вместо 175 млрд)" pairing is arithmetically inconsistent (0.01% of 175B = 17.5M); [S10:42] cites setup text, not the quoted demonstration sentence (sibling labels cover the claims).'
  ];
  const md = ['# K2 Ask eval — stored-only revalidation (zero model calls)', '', '- project: ' + title + ' (10 arxiv explicit scope, exact frozen scope enforced per turn)', '- chat: ' + chatId + ' (stored-only; ELIOT_EVAL_CHAT, never created or submitted)', '- mode: whole revalidation from storage only; new-turn delta must be 0 micro-USD', '- monthly before/after: ' + m0 + '/' + hF.monthlyUsedMicrousd + ' micro-USD (must be equal)', '- budget default $5, never overridden: ' + hF.monthlyBudgetMicrousd, '- ' + ownerGate, '- observed defects (mechanical PASS does not clear these):'].concat(defects.map((d) => '  - ' + d)).concat(['', '| q | state | cites | invalid | in/cached/out | cost_uUSD | first_ms | total_ms | wall_ms |', '|---|---|---|---|---|---|---|---|---|']).concat(sRows).concat(['']).join(EOL);
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
const completedQuestions = new Set();
const used = new Set();
for (const qid of order) {
  let turn = null, src = 'new', wall = null;
  if (resumeChat) {
    const cand = reusableCandidate(qid, h0.turns, used);
    if (cand) { turn = cand; src = 'reused'; used.add(cand.turnId); }
    else if (h0.turns.some((t) => t && t.question === Q.get(qid) && t.state !== 'completed')) { rows.push('| ' + qid + ' | PENDING_MANUAL | - | - | - | - | - | - | - |'); manual++; continue; }
  }
  if (!turn) {
    const turnId = randomUUID();
    const t0 = Date.now();
    const r = await apiJson(chatPath + '/turns?wait=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90000), body: JSON.stringify({ turnId, question: Q.get(qid), scopeMode: 'explicit', sourceIds }) });
    wall = Date.now() - t0;
    assert(r.status === 200 || r.status === 201, 'POST turns?wait=1 must be 200/201 for ' + qid + '.');
    assert(r.body && typeof r.body.turn === 'object', 'POST turns?wait=1 must return {turn} for ' + qid + '.');
    turn = r.body.turn;
    assert.equal(turn.turnId, turnId, qid + ': turn.turnId must echo the request turnId.');
    newCount++;
  } else {
    assert(typeof turn.turnId === 'string' && turn.turnId.length > 0, qid + ': reused turn.turnId required.');
  }
  assert(typeof turn.answer === 'string', qid + ': turn.answer must be a string.');
  if (turn.state !== 'completed') { await saveTurn(qid, turn, { src, wall, question: Q.get(qid) }); failed++; rows.push('| ' + qid + ' | ' + turn.state + ' | - | - | - | - | - | - | ' + (wall ===null ? '-' : wall) + ' |'); break; }
  assert(Array.isArray(turn.citations) && turn.citations.length >= 1, qid + ': completed answer needs >=1 citation.');
  assert(typeof turn.invalidLabels === 'number' && turn.invalidLabels === 0, qid + ': invalidLabels must be 0.');
  for (const c of turn.citations) {
    assert(c && typeof c.revisionId === 'string', qid + ': citation needs full revisionId.');
    assert(typeof c.sourceId === 'string', qid + ': citation needs sourceId.');
    assert(typeof c.block === 'number', qid + ': citation needs numeric block.');
    assert(typeof c.start === 'number' && typeof c.end === 'number', qid + ': citation needs numeric start/end.');
    await checkRange(c.revisionId, c.start, c.end);
  }
  await saveTurn(qid, turn, { src, wall, reused: src === 'reused', question: Q.get(qid) });
  checkAnswer(qid, turn.answer);
  completedQuestions.add(qid);
  for (const k of ['inputTokens', 'cachedTokens', 'outputTokens', 'estimatedCostMicrousd', 'firstTokenMs', 'totalMs']) assert(typeof turn[k] === 'number', qid + ': turn.' + k + ' must be a number.');
  assert(turn.totalMs <= 90000, qid + ': catastrophic ceiling 90s exceeded.');
  reportedMicro += turn.estimatedCostMicrousd;
  if (src === 'new') newCostMicro += turn.estimatedCostMicrousd;
  firstMs.push(turn.firstTokenMs); totalMs.push(turn.totalMs);
  rows.push('| ' + qid + ' | completed(' + src + ') | ' + turn.citations.length + ' | 0 | ' + turn.inputTokens + '/' + turn.cachedTokens + '/' + turn.outputTokens + ' | ' + turn.estimatedCostMicrousd + ' | ' + turn.firstTokenMs + ' | ' + turn.totalMs + ' | ' + (wall === null ? 'reused' : wall) + ' |');
}
const h1 = await getChat('after turns');
const h2 = await getChat('final re-read');
const usdNew = newCostMicro / 1e6;
const md = ['# K2 Ask eval', '', '- project: ' + title + ' (10 arxiv explicit scope)', '- chat: ' + chatId + (resumeChat ? ' (resumed, no paid retry)' : ''), '- mode: whole, one call/turn, no paid retry', '- reported cost all turns: ' + reportedMicro + ' micro-USD; new-turn delta: ' + newCostMicro + ' micro-USD ($' + usdNew.toFixed(4) + ', budget default $5, never overridden)', '- monthly: ' + h1.monthlyUsedMicrousd + '/' + h1.monthlyBudgetMicrousd + ' micro-USD', '- cold first/total: ' + firstMs[0] + '/' + totalMs[0] + ' ms', '- warm first p50/p95: ' + pct(firstMs.slice(1), 0.5) + '/' + pct(firstMs.slice(1), 0.95) + ' ms', '- warm total p50/p95: ' + pct(totalMs.slice(1), 0.5) + '/' + pct(totalMs.slice(1), 0.95) + ' ms', '- O1/O2/O3/O8 quality vs eval/arxiv-10/baseline.md: OWNER_JUDGMENT_REQUIRED (script never auto-passes human gates)', '- Stop/reconnect/Save: NOT_RUN here (root browser journey).', '', '| q | state | cites | invalid | in/cached/out | cost_uUSD | first_ms | total_ms | wall_ms |', '|---|---|---|---|---|---|---|---|---|'].concat(rows).concat(['']).join(EOL);
await writeFile(outDir + '/k2-' + Date.now() + '.md', md);
console.log(md);
assert.equal(failed, 0, failed + ' paid turn(s) did not complete; no retry by design. Operator must create any manual new turn separately.');
assert.equal(manual, 0, manual + ' question(s) PENDING_MANUAL: a same-question turn already failed; no auto re-request. Operator must create any manual new turn separately.');
assert(order.every((q) => completedQuestions.has(q)), 'All 12 questions must complete.');
assert.equal(h1.turns.length, h0.turns.length + newCount, 'History must hold exactly the pre-existing plus new turns.');
assert.equal(h1.monthlyUsedMicrousd - m0, newCostMicro, 'Monthly usage delta must equal new-turn cost only (reused turns cost nothing new).');
assert(h1.monthlyUsedMicrousd < h1.monthlyBudgetMicrousd, 'Monthly budget exceeded: ' + h1.monthlyUsedMicrousd + ' >= ' + h1.monthlyBudgetMicrousd);
assert.equal(h2.monthlyUsedMicrousd, h1.monthlyUsedMicrousd, 'Pure history re-read must not change usage.');
