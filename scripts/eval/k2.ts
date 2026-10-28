import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertEvalOrigin, assertEvalBrowserOrigin, fetchEval } from './origin.mjs';
import { uncitedStatements, unsupportedNumericStatements } from '../../src/citations.ts';
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
const requestedOrigin = process.env.ELIOT_URL || 'http://127.0.0.1:5173';
const configuredOrigin = process.env.ELIOT_ORIGIN;
const origin = assertEvalOrigin(requestedOrigin, configuredOrigin);
const H = { Origin: origin };
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  H['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
  H['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
}
if (process.env.ELIOT_OWNER_JWT) H['cf-access-jwt-assertion'] = String(process.env.ELIOT_OWNER_JWT).trim();
const nativeOnly = process.argv.includes('--native-only');
const runModel = !nativeOnly && process.env.ELIOT_K2_MODEL === '1';
const storedOnly = process.argv.includes('--stored-only');
const modelsOnly = process.argv.includes('--models-only');
const resumeChat = process.env.ELIOT_EVAL_CHAT || null;
const evalModelOverride = (process.env.ELIOT_EVAL_MODEL ?? '').trim() || null;
assert(!storedOnly || (!!resumeChat && !runModel && !modelsOnly), '--stored-only requires an existing chat and forbids model dispatch/catalogue tests.');
assert(!runModel || evalModelOverride === null, 'K2 benchmark uses the frozen global configured default; ELIOT_EVAL_MODEL overrides are disabled.');
const evalDir = fileURLToPath(new URL('../../eval/', import.meta.url));
const outDir = fileURLToPath(new URL('../../eval/out/k2/', import.meta.url));
const notebookAnswersPath = (process.env.ELIOT_K2_NOTEBOOKLM_ANSWERS ?? '').trim()
  || fileURLToPath(new URL('../../eval/out/notebooklm-20261026/answers.md', import.meta.url));
const order = ['C1', 'C2', 'C3', 'C4', 'O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'O7', 'O8'];
await mkdir(outDir, { recursive: true });
async function apiJson(path, init) {
  // Finite READ default (30s observer bound); explicit caller signal (e.g. 90s POST) is preserved verbatim.
  const readSignal = init && init.signal ? init.signal : AbortSignal.timeout(30000);
  const r = await fetchEval(origin + path, { ...init, signal: readSignal, headers: { Accept: 'application/json', ...H, ...((init && init.headers) || {}) } }, origin, configuredOrigin);
  const t = await r.text();
  let b = null;
  try { b = t ? JSON.parse(t) : null; } catch { b = { raw: t.slice(0, 300) }; }
  return { status: r.status, body: b };
}
async function apiBytes(path, init) {
  // Same finite READ default for range/text GETs; explicit caller signal preserved verbatim.
  const readSignal = init && init.signal ? init.signal : AbortSignal.timeout(30000);
  const r = await fetchEval(origin + path, { ...init, signal: readSignal, headers: { ...H, ...((init && init.headers) || {}) } }, origin, configuredOrigin);
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
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, status: passed ? 'PASS' : 'FAIL', detail });
  if (typeof ans !== 'string' || !ans.trim()) return [{ name: 'answer present', status: 'FAIL', detail: 'No answer text was stored.' }];
  if (qid === 'C1') {
    add('d_model=512', m.includes('512'), 'Expected Transformer base model d_model 512.');
    const w = m.split(' ');
    let heads8 = /\bh\s*=\s*8(?!\d)/u.test(m) || /(?:голов[а-яё]*|heads?)[^.!?\n]{0,70}\b8\b|\b8\b[^.!?\n]{0,70}(?:голов[а-яё]*|heads?)/iu.test(m);
    for (let i = 0; i < w.length && !heads8; i++) {
      if (w[i] === '8' && i > 0 && (String(w[i - 1]).includes('head') || String(w[i - 1]).includes('голов'))) heads8 = true;
      if (w[i] === '8' && i + 1 < w.length && (String(w[i + 1]).includes('head') || String(w[i + 1]).includes('голов'))) heads8 = true;
    }
    add('attention heads=8', heads8 || m.includes(' восемь ') || m.includes(' eight '), 'Expected eight attention heads.');
  }
  if (qid === 'C2') {
    const warm = m.includes('warmup') || m.includes('warm-up') || m.includes('warm up') || m.includes('разогрев') || m.includes('прогрев') || m.includes('размин');
    const strictFormula = has('4000') && warm && (m.includes('d model') || m.includes('step')) && m.includes('min') && m.includes('-0.5') && m.includes('-1.5');
    const sqrtFormula = m.includes('sqrt') && has('4000') && warm;
    add('learning-rate formula and warmup=4000', strictFormula || sqrtFormula, 'Expected d_model^-0.5 min(step^-0.5, step·warmup^-1.5), warmup 4000, or an equivalent square-root expression.');
  }
  if (qid === 'C3') add('Adam defaults', has('0.001') && has('0.9') && has('0.999') && (has('1e-8') || m.includes('10 -8') || m.includes('10 - 8') || m.includes('10-8') || has('0.00000001')), 'Expected alpha=0.001, beta1=0.9, beta2=0.999 and epsilon=1e-8.');
  if (qid === 'C4') add('positional encoding contrast', (m.includes('синус') || m.includes('sinus')) && (m.includes('обуч') || m.includes('learn')), 'Expected sinusoidal versus learned positional encodings.');
  if (qid === 'O8') add('honest abstention', /нет в корпусе|в корпусе нет|не решают|не содержат|ни одн(?:а|ой|ого|у)|abstain|not in (the )?corpus|no paper/i.test(ans), 'Expected an answer that the corpus does not solve hallucinations.');
  if (['O1', 'O2', 'O3', 'O8'].includes(qid))
    checks.push({ name: 'semantic quality', status: 'OWNER_REVIEW_REQUIRED', detail: 'Gold facts are shown for owner review; the evaluator does not judge entailment or usefulness.' });
  else if (['O4', 'O5', 'O6', 'O7'].includes(qid))
    checks.push({ name: 'semantic coverage', status: 'NOT_AUTOMATED', detail: 'Gold facts are shown; no automatic semantic pass is claimed.' });
  return checks;
}
const qmd = await readFile(evalDir + '/arxiv-10/questions.md', 'utf8');
const Q = new Map();
const goldFacts = new Map();
for (const line of qmd.split(EOL)) {
  const parts = line.split('|').map((part) => part.trim());
  if (parts.length >= 4 && order.includes(parts[1]) && parts[2]) {
    Q.set(parts[1], parts[2]);
    goldFacts.set(parts[1], parts[3]);
  }
}
assert.equal(Q.size, 12, 'questions.md must define C1-4 and O1-8.');
async function baselineNotebookSummaries() {
  const raw = await readFile(evalDir + '/arxiv-10/baseline.md', 'utf8');
  const answers = new Map();
  let inNotebookTable = false;
  for (const line of raw.split(EOL)) {
    if (/^##\s+Ответы Gemini Notebook/.test(line)) { inNotebookTable = true; continue; }
    if (inNotebookTable && /^##\s+/.test(line)) break;
    if (!inNotebookTable || !line.startsWith('|')) continue;
    const parts = line.split('|').map((part) => part.trim());
    if (order.includes(parts[1]) && parts[4]) answers.set(parts[1], parts[4]);
  }
  return answers;
}
function parseNotebookAnswers(raw) {
  const answers = new Map();
  let qid = null;
  let body = [];
  const save = () => { if (qid && body.join(EOL).trim()) answers.set(qid, body.join(EOL).trim()); };
  for (const line of raw.split(EOL)) {
    const heading = /^##\s+(C[1-4]|O[1-8])(?:\s|[-—])/.exec(line);
    if (heading) { save(); qid = heading[1]; body = []; continue; }
    if (qid) body.push(line);
  }
  save();
  return answers;
}
const baselineAnswers = await baselineNotebookSummaries();
let notebookAnswers = new Map();
let notebookAnswerSource = 'eval/arxiv-10/baseline.md (recorded summary)';
try {
  notebookAnswers = parseNotebookAnswers(await readFile(notebookAnswersPath, 'utf8'));
  if (notebookAnswers.size > 0) notebookAnswerSource = notebookAnswersPath;
} catch { /* use the tracked baseline summary below */ }
for (const qid of order) {
  if (!notebookAnswers.has(qid)) {
    notebookAnswers.set(qid, baselineAnswers.get(qid)
      || 'Baseline records this response as received and saved; no individual answer text is present in baseline.md.');
  }
}
const compareRows = new Map(order.map((qid) => [qid, {
  qid,
  answer: null,
  model: null,
  turnState: 'NOT_RUN',
  status: 'NOT_RUN',
  factChecks: [],
  citationRanges: [],
  citationSummary: 'NOT_RUN',
  timing: null,
  usage: null,
  reason: null,
} ]));
function markQuestionNotRun(qid, reason, status = 'NOT_RUN') {
  compareRows.set(qid, { ...compareRows.get(qid), status, reason, turnState: status });
}
function mdCell(value) {
  return String(value ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\|/g, '&#124;').replace(/\r?\n/g, '<br>');
}
async function writeCompare(rows, metadata) {
  const turnRows = order.map((qid) => rows.get(qid)).filter((row) => row && row.turnState !== 'NOT_RUN'
    && row.turnState !== 'NOT_REVALIDATED' && row.turnState !== 'DISPATCH_FAILED' && row.turnState !== 'DISPATCH_UNKNOWN');
  const sumKnown = (field) => {
    const values = turnRows.map((row) => row.usage?.[field]).filter((value) => typeof value === 'number' && Number.isFinite(value));
    return { sum: values.reduce((total, value) => total + value, 0), unknown: turnRows.length - values.length, count: values.length };
  };
  const percentile = (values, p) => {
    const sorted = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
    if (!sorted.length) return 'NOT_RUN';
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
  };
  const firstTimes = turnRows.map((row) => row.timing?.firstTokenMs);
  const totalTimes = turnRows.map((row) => row.timing?.totalMs);
  const ranges = turnRows.flatMap((row) => Array.isArray(row.citationRanges) ? row.citationRanges : []);
  const numericCheckDetails = turnRows.flatMap((row) => Array.isArray(row.factChecks) ? row.factChecks : [])
    .filter((check) => check.name === 'numeric citation support').map((check) => check.detail || '');
  const unsupportedNumericCount = numericCheckDetails.reduce((total, detail) => total + (Number(/([0-9]+) unsupported/.exec(detail)?.[1]) || 0), 0);
  const inputs = sumKnown('inputTokens'), cached = sumKnown('cachedTokens'), outputs = sumKnown('outputTokens');
  const limits = sumKnown('tokenLimit'), actualCosts = sumKnown('actualProviderCostUsd');
  const lines = [
    '# K2 — Eliot / NotebookLM comparison',
    '',
    '- Questions and gold facts: `eval/arxiv-10/questions.md` (read-only).',
    '- NotebookLM answer source: ' + mdCell(notebookAnswerSource) + '.',
    '- Eliot mode: ' + mdCell(metadata.mode) + '.',
    '- Configured global answer model: ' + mdCell(metadata.defaultModel ?? 'UNKNOWN') + '.',
    '- Project answer-model override: ' + mdCell(metadata.projectModelOverride ?? 'none') + '.',
    '- Chat: ' + mdCell(metadata.chatId ?? 'UNKNOWN') + '.',
    '- Daily token usage before/after: ' + mdCell(JSON.stringify(metadata.usageBefore ?? 'NOT_RECORDED')) + ' / ' + mdCell(JSON.stringify(metadata.usageAfter ?? 'NOT_RECORDED')) + ' (dayStart/dayEnd/inputTokens/outputTokens/cachedTokens/unknownUsages).',
    '- Turn count before/after: ' + mdCell(metadata.turnCountBefore ?? 'NOT_RECORDED') + '/' + mdCell(metadata.turnCountAfter ?? 'NOT_RECORDED') + '.',
    '- Diagnostic turn rows with stored usage: ' + turnRows.length + ' / 12.',
    '- Usage totals (known values only): input ' + inputs.sum + ' (' + inputs.unknown + ' unknown), cached ' + cached.sum + ' (' + cached.unknown + ' unknown), output ' + outputs.sum + ' (' + outputs.unknown + ' unknown), tokenLimit ' + limits.sum + ' (' + limits.unknown + ' unknown; no currency, no neuron conversion).',
    '- Provider-reported actual cost (legacy historical only, never gated): ' + (actualCosts.unknown > 0 ? 'UNKNOWN (known subtotal ' + actualCosts.sum + ' USD; ' + actualCosts.unknown + ' turn(s) unknown, not zero).' : actualCosts.sum + ' USD across ' + actualCosts.count + ' turn(s).'),
    '- Latency sample n=' + turnRows.filter((row) => typeof row.timing?.firstTokenMs === 'number' && typeof row.timing?.totalMs === 'number').length + ' ms: first p50/p95 ' + percentile(firstTimes, 0.50) + '/' + percentile(firstTimes, 0.95) + '; total p50/p95 ' + percentile(totalTimes, 0.50) + '/' + percentile(totalTimes, 0.95) + '.',
    '- Exact citation ranges: ' + ranges.filter((range) => range.status === 'PASS').length + '/' + ranges.length + ' opened and matched; failed ' + ranges.filter((range) => range.status !== 'PASS').length + '.',
    '- Unsupported numeric statements: ' + unsupportedNumericCount + '.',
    '- Actual Eliot turn model is shown per row; non-default stored answers are diagnostic only.',
    '- Owner semantic gate: O1/O2/O3/O8 remain `OWNER_REQUIRED`; this report does not judge meaning.',
    '- Result: ' + mdCell(metadata.status) + (metadata.stopReason ? ' — ' + mdCell(metadata.stopReason) : ''),
    '',
    '| # | Turn ID | Question | Gold facts | NotebookLM answer | Eliot answer | Model / state | Status | Fact checks | Citation ranges / quotes | Time / usage |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const qid of order) {
    const row = rows.get(qid) || {};
    const checkParts = Array.isArray(row.factChecks) ? row.factChecks.map((check) => check.name + ': ' + check.status + (check.detail ? ' (' + check.detail + ')' : '')) : [];
    if (Array.isArray(row.hardFailures)) checkParts.push(...row.hardFailures);
    if (row.reason) checkParts.push(row.reason);
    const factText = checkParts.length ? checkParts.join('; ') : 'NOT_RUN';
    const rangeText = Array.isArray(row.citationRanges) && row.citationRanges.length
      ? row.citationRanges.map((r) => r.label + ' ' + r.revisionId + ':' + r.block + '[' + r.start + ',' + r.end + ') ' + r.status + (r.reason ? ' (' + r.reason + ')' : '') + (r.quote ? ' quote=' + r.quote : '')).join('<br>')
      : row.citationSummary ?? 'NOT_RUN';
    const usage = row.usage ? [row.usage.inputTokens, row.usage.cachedTokens, row.usage.outputTokens].map((v) => v ?? 'UNKNOWN').join('/')
      + ' tok; limit ' + (row.usage.tokenLimit ?? 'UNKNOWN') + '; actual(legacy) ' + (row.usage.actualProviderCostUsd ?? 'UNKNOWN') + ' USD'
      : 'NOT_RUN';
    const time = row.timing ? 'first ' + (row.timing.firstTokenMs ?? 'UNKNOWN') + ' ms / total ' + (row.timing.totalMs ?? 'UNKNOWN') + ' ms'
      + (row.timing.wallMs === null || row.timing.wallMs === undefined ? '' : ' / wall ' + row.timing.wallMs + ' ms') : 'NOT_RUN';
    lines.push('| ' + [qid, row.turnId ?? 'NOT_RUN', Q.get(qid), goldFacts.get(qid), notebookAnswers.get(qid), row.answer ?? 'NOT_RUN',
      (row.model ?? 'UNKNOWN') + ' [' + (row.routeStatus ?? 'UNKNOWN_ROUTE') + '] / ' + (row.turnState ?? 'NOT_RUN'), row.status ?? 'NOT_RUN', factText, rangeText, time + '; ' + usage]
      .map(mdCell).join(' | ') + ' |');
  }
  lines.push('');
  await writeFile(outDir + '/compare.md', lines.join(EOL) + EOL);
  console.log('K2 compare written: ' + outDir + '/compare.md (' + order.length + ' rows, ' + metadata.status + ').');
}
const me = await apiJson('/api/me');
assert.equal(me.status, 200, 'GET /api/me must be 200; start pnpm dev first.');
assert.equal(me.body.actor.type, 'owner', 'Eval must run as owner.');
if (process.argv.includes('--models-only')) {
  // Connection/admission checks only. Never enables a Gateway, submits a provider call or changes defaults/budget.
  const before = await apiJson('/api/settings');
  const providersBefore = await apiJson('/api/models/providers');
  assert.equal(providersBefore.status, 200, 'GET /api/models/providers must be 200.');
  assert.equal(providersBefore.body.providers.length, 3, 'Local scratch namespace must start with 3 seeded providers.');
  let providerCrud = { status: 'NOT_RUN' };
  const connection = await apiJson('/api/models/connection');
  assert.equal(before.status, 200);
  assert.equal(connection.status, 200);
  assert.equal(connection.body.connection.gatewayId, null, 'Use a disconnected local namespace; this check never disables an existing connection.');
  const firstRead = await apiJson('/api/models');
  assert.equal(firstRead.status, 200);
  assert(Array.isArray(firstRead.body.models), 'GET /api/models must return a catalogue array.');
  assert(firstRead.body.snapshot && typeof firstRead.body.snapshot.refreshNeeded === 'boolean', 'GET /api/models must report snapshot metadata.');
  const refreshed = await apiJson('/api/models/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(refreshed.status, 200, 'Explicit catalogue refresh must succeed as the owner action, got ' + refreshed.status);
  assert(Array.isArray(refreshed.body.models), 'Refresh must return a catalogue array.');
  assert(refreshed.body.snapshot && typeof refreshed.body.snapshot.updatedAt === 'string', 'Refresh must stamp the stored snapshot.');
  const rereadA = await apiJson('/api/models');
  const rereadB = await apiJson('/api/models');
  assert.equal(rereadA.status, 200);
  assert.equal(rereadB.status, 200);
  assert.deepEqual(rereadA.body.models, refreshed.body.models, 'First GET after refresh must equal the refreshed snapshot (no discovery on GET).');
  assert.deepEqual(rereadB.body.models, refreshed.body.models, 'Second GET after refresh must equal the refreshed snapshot (no discovery on GET).');
  assert.deepEqual(rereadA.body.snapshot, refreshed.body.snapshot, 'Snapshot metadata must be identical between refresh and GET.');
  assert.deepEqual(rereadB.body.snapshot, refreshed.body.snapshot, 'Snapshot metadata must stay stable across GETs.');
  assert.deepEqual(rereadA.body.warnings, refreshed.body.warnings, 'Warnings must be identical between refresh and GET.');
  assert.deepEqual(rereadB.body.warnings, refreshed.body.warnings, 'Warnings must stay stable across GETs.');
  const models = rereadB;
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
  const changed = await apiJson('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answerModel: external.route }) });
  assert.equal(changed.status, 503, 'A disconnected external route cannot become the default.');
  const emptyDistill = await apiJson('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answerModel: before.body.settings.answerModel, distillModel: '' }) });
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
  assert.strictEqual(turn.body.turn.tokenLimit, 0, 'Undispatched disconnected failure must carry tokenLimit 0 (no reservation, no paid call).');
  if (turn.body.turn.estimatedCostMicrousd !== undefined) assert(turn.body.turn.estimatedCostMicrousd === null || typeof turn.body.turn.estimatedCostMicrousd === 'number', 'Historical estimatedCost must be honestly recorded, never gated.');
  assert.equal(turn.body.turn.inputTokens, 0);
  assert.equal(turn.body.turn.outputTokens, 0);
  assert.match(turn.body.turn.error, /disconnected|Gateway|credential/i);
  let distill = 'NOT_RUN: storage fixture not attempted';
  let sourceId = null;
  {
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
  const accessHeaderNames = ['CF-Access-Client-Id', 'CF-Access-Client-Secret', 'cf-access-jwt-assertion'];
  assert(!accessHeaderNames.some((name) => typeof H[name] === 'string' && H[name].length > 0),
    'Browser eval refuses Access credential headers; use the bare loopback development path.');
  const browserOrigin = assertEvalBrowserOrigin(origin, configuredOrigin);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
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
    async function setAdvancedGateway(page, open) {
      const region = page.getByRole('region', { name: 'AI Gateway connection', exact: true });
      const details = region.locator('details.er-models__details');
      const isOpen = (await details.getAttribute('open')) !== null;
      if (open && !isOpen) await region.locator('details.er-models__details > summary').click();
      if (!open && isOpen) await region.locator('details.er-models__details > summary').click();
    }
    async function openSettings(page) {
      const reads = ['/api/settings', '/api/models/connection', '/api/models'].map(async (path) => {
        const response = await page.waitForResponse((r) => r.url() === browserOrigin + path && r.request().method() === 'GET', { timeout: 30000 });
        assert.equal(response.status(), 200, 'Settings reader must load ' + path + '.');
        await response.finished();
      });
      await Promise.all([page.goto(browserOrigin + '/settings'), ...reads]);
      await expect(page.getByRole('region', { name: 'Models', exact: true })).toBeVisible();
      const answersRadio = page.locator('input[type="radio"][value="answer"]');
      const understandingRadio = page.locator('input[type="radio"][value="distill"]');
      await expect(answersRadio).toBeVisible();
      await expect(understandingRadio).toBeVisible();
      await expect(page.getByRole('group', { name: 'Use model for' })).toBeVisible();
      assert.strictEqual(await page.locator('.er-model-picker__find').count(), 0, 'Expanded picker must not use a Find disclosure.');
      assert.strictEqual(await page.locator('nav.er-model-picker__pages').count(), 0, 'Expanded picker must not paginate.');
      assert.strictEqual(await page.locator('section.er-model-picker__advanced').count(), 0, 'Expanded picker must not hide Model details.');
      await answersRadio.check();
      await expect(page.getByRole('combobox', { name: 'Answer model', exact: true })).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Answer model', exact: true })).toBeEnabled({ timeout: 30000 });
      await expect(page.getByRole('combobox', { name: 'Answer model', exact: true })).toHaveValue(before.body.settings.answerModel);
      await expect(page.getByRole('combobox', { name: 'Answer model: provider', exact: true })).toBeVisible();
      await expect(page.getByRole('searchbox', { name: 'Answer model: search models', exact: true })).toBeVisible();
      await expect(page.getByRole('checkbox', { name: /free/i })).toBeVisible();
      await understandingRadio.check();
      await expect(page.getByRole('combobox', { name: 'Understanding model', exact: true })).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Understanding model', exact: true })).toBeEnabled({ timeout: 30000 });
      await expect(page.getByRole('combobox', { name: 'Understanding model', exact: true })).toHaveValue(before.body.settings.distillModel);
      await expect(page.getByRole('combobox', { name: 'Understanding model: provider', exact: true })).toBeVisible();
      await expect(page.getByRole('searchbox', { name: 'Understanding model: search models', exact: true })).toBeVisible();
      await answersRadio.check();
      // No monthly USD budget input: Settings Save carries only answer/distill models. No price gate here.
      const gateway = page.getByRole('region', { name: 'AI Gateway connection', exact: true });
      await expect(gateway).toBeVisible();
      await setAdvancedGateway(page, true);
      await expect(gateway.getByRole('textbox', { name: 'Gateway ID Blank disables external routing.', exact: true })).toHaveValue('');
      await expect(gateway.getByRole('checkbox', { name: 'Allow external model requests from this workspace.', exact: true })).not.toBeChecked();
      await setAdvancedGateway(page, false);
    }
    async function activePicker(page, mode) {
      const label = mode === 'answers' ? 'Answer model' : 'Understanding model';
      await page.locator(mode === 'answers' ? 'input[type="radio"][value="answer"]' : 'input[type="radio"][value="distill"]').check();
      const select = page.getByRole('combobox', { name: label, exact: true });
      await expect(select).toBeVisible();
      await expect(select).toBeEnabled({ timeout: 30000 });
      return {
        select,
        provider: page.getByRole('combobox', { name: label + ': provider', exact: true }),
        search: page.getByRole('searchbox', { name: label + ': search models', exact: true }),
        free: page.getByRole('checkbox', { name: /free/i }),
      };
    }
    async function assertDisabledChoice(page, mode) {
      const label = mode === 'answers' ? 'Answer model' : 'Understanding model';
      const expected = mode === 'answers' ? before.body.settings.answerModel : before.body.settings.distillModel;
      const picked = await activePicker(page, mode);
      const select = picked.select;
      const provider = picked.provider;
      const search = picked.search;
      const free = picked.free;
      await expect(select).toHaveValue(expected);
      assert.equal(await select.locator('option').evaluateAll((options, route) => options.filter((option) => option.value === route).length, external.route), 1, 'Expanded catalogue must attach the exact provider/native route without paging (' + label + ').');
      await provider.selectOption(external.route.slice('gateway:'.length).split('/')[0]);
      await expect(select).toHaveValue(expected);
      await search.fill(external.route);
      await expect(select).toHaveValue(expected);
      await expect.poll(() => select.locator('option').evaluateAll((options, chosen) => options
        .filter((option) => option.getAttribute('value') === chosen).map((option) => option.hasAttribute('disabled')), external.route), { timeout: 30000 }).toEqual([true]);
      await free.check();
      await expect(select).toHaveValue(expected);
      await free.uncheck();
      await expect(select).toHaveValue(expected);
      await search.fill('');
      await expect(select).toHaveValue(expected);
      await provider.selectOption('');
      await expect(select).toHaveValue(expected);
      assert.strictEqual(await page.locator('.er-model-picker__find').count(), 0, 'Filters must not introduce a Find disclosure (' + label + ').');
      assert.strictEqual(await page.locator('nav.er-model-picker__pages').count(), 0, 'Filters must not introduce pagination (' + label + ').');
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
    const gatewayId = gateway.getByRole('textbox', { name: 'Gateway ID Blank disables external routing.', exact: true });
    await setAdvancedGateway(page, true);
    await gatewayId.fill('unconfigured-eval-gateway');
    await expect(gateway.getByRole('button', { name: 'Save connection', exact: true })).toBeDisabled();
    await setAdvancedGateway(page, false);
    assert((await page.locator('#workspace-main details.er-models__details').count()) >= 1, 'Gateway technical details stay collapsed separately from the expanded picker.');
    assert.strictEqual(await page.locator('#workspace-main details.er-models__details[open]').count(), 0, 'Gateway technical details must start collapsed.');
    assert.strictEqual(await page.locator('.er-model-picker__find').count(), 0, 'Expanded picker must not introduce a Find disclosure.');
    assert.strictEqual(await page.locator('nav.er-model-picker__pages').count(), 0, 'Expanded picker must not introduce pagination.');
    assert.strictEqual(await page.locator('section.er-model-picker__advanced').count(), 0, 'Expanded picker must not hide Model details.');
    const summaries = page.locator('#workspace-main details.er-models__details > summary');
    for (let i = 0; i < await summaries.count(); i++) assert((await summaries.nth(i).innerText()).trim().length > 0, 'Every collapsed gateway section must carry an accessible label.');
    await assertDisabledChoice(page, 'answers');
    await assertDisabledChoice(page, 'understanding');
    await activePicker(page, 'answers');
    await expect(page.getByRole('combobox', { name: 'Answer model', exact: true })).toHaveValue(before.body.settings.answerModel);
    await activePicker(page, 'understanding');
    await expect(page.getByRole('combobox', { name: 'Understanding model', exact: true })).toHaveValue(before.body.settings.distillModel);
    await activePicker(page, 'answers');
    assert.strictEqual(await page.locator('.er-model-picker__find').count(), 0, 'Display-only filters must not introduce a Find disclosure.');
    assert.strictEqual(await page.locator('nav.er-model-picker__pages').count(), 0, 'Display-only filters must not introduce pagination.');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Settings must fit the 390px Material layout.');
    await setAdvancedGateway(page, true);
    await gateway.getByRole('button', { name: 'Save connection' }).scrollIntoViewIfNeeded();
    await expect(gateway.getByRole('button', { name: 'Save connection' })).toBeVisible();
    await page.screenshot({ path: outDir + '/external-models-390.png', fullPage: true });
    await page.setViewportSize({ width: 389, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Settings must fit the 389px Material layout.');
    await page.setViewportSize({ width: 390, height: 844 });
    const modelsSection = page.getByRole('region', { name: 'Models', exact: true });
    // No USD budget input or decimal-place gate: Settings Save carries only answer/distill models. Storage-only browser must not PUT.
    assert.strictEqual(settingsPuts, 0, 'Storage-only browser must not PUT /api/settings.');
    await expect(consent).not.toBeChecked();
    await expect(gateway.getByRole('button', { name: 'Save connection', exact: true })).toBeDisabled();
    await gatewayId.fill('');
    await setAdvancedGateway(page, false);
    if (sourceId) {
      const modelsRead = page.waitForResponse((r) => r.url() === browserOrigin + '/api/models' && r.request().method() === 'GET', { timeout: 30000 });
      await page.goto(browserOrigin + '/p/' + projectId + '/source/' + sourceId);
      assert.equal((await modelsRead).status(), 200, 'Understanding model catalogue must load.');
      const understanding = page.getByRole('region', { name: 'Understanding', exact: true });
      const details = understanding.locator('details.er-und__details');
      if (await details.getAttribute('open') === null) await understanding.locator('details.er-und__details > summary').click();
      const sourceProvider = understanding.getByRole('combobox', { name: 'Understanding model: provider', exact: true });
      await sourceProvider.selectOption(external.route.slice('gateway:'.length).split('/')[0]);
      const select = understanding.getByRole('combobox', { name: 'Understanding model', exact: true });
      await expect(select).toBeEnabled({ timeout: 30000 });
      await expect.poll(() => select.locator('option').evaluateAll((options, chosen) => options
        .filter((option) => option.getAttribute('value') === chosen).map((option) => option.hasAttribute('disabled')), external.route), { timeout: 30000 }).toEqual([true]);
    }
    assert.strictEqual(settingsPuts, 0, 'The entire browser journey must attempt zero settings PUTs.');
    assert.deepEqual(mutations, [], 'The browser journey must attempt no API mutation, including Gateway/model requests.');
    assert.deepEqual(errors, [], 'Settings/understanding must not throw browser errors.');
    const evalProviderId = 'eval-provider-' + Date.now().toString(36);
    let providerPuts = 0;
    let providerGets = 0;
    let providerSettingsPuts = 0;
    let providerRefreshPosts = 0;
    let providerTurnPosts = 0;
    const providerBlocked = [];
    const providerErrors = [];
    const providerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    providerContext.setDefaultTimeout(30000);
    providerContext.setDefaultNavigationTimeout(30000);
    await providerContext.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const path = url.pathname;
      if (method === 'GET' && (path === '/api/models/providers' || path === '/api/settings' || path === '/api/models' || path === '/api/models/connection')) {
        if (path === '/api/models/providers') providerGets += 1;
        await route.continue();
        return;
      }
      if (method === 'PUT' && path === '/api/models/providers') {
        providerPuts += 1;
        await route.continue();
        return;
      }
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        if (path === '/api/settings' && method === 'PUT') providerSettingsPuts += 1;
        if (path === '/api/models/refresh' && method === 'POST') providerRefreshPosts += 1;
        providerBlocked.push({ method, path });
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    let providerCrudInner = null;
    try {
      const ppage = await providerContext.newPage();
      ppage.on('pageerror', (error) => providerErrors.push(String(error && error.message ? error.message : error).slice(0, 500)));
      const providerReads = ['/api/settings', '/api/models/connection', '/api/models', '/api/models/providers'].map((path) => ppage.waitForResponse((r) => r.url() === browserOrigin + path && r.request().method() === 'GET', { timeout: 30000 }));
      await ppage.goto(browserOrigin + '/settings');
      for (const pending of providerReads) {
        const response = await pending;
        assert.equal(response.status(), 200, 'Provider Settings reader must load ' + response.url() + '.');
        await response.finished();
      }
      await expect(ppage.getByRole('heading', { name: 'Providers', exact: true })).toBeVisible();
      assert.equal(await ppage.locator('.er-providers__item').count(), 3, 'Provider editor must start from the 3 seeded providers.');
      await ppage.getByRole('button', { name: 'Add provider', exact: true }).click();
      assert.equal(await ppage.locator('.er-providers__item').count(), 4, 'Add provider must append one draft row.');
      const draft = ppage.locator('.er-providers__item').last();
      assert.equal(await draft.locator('details.er-providers__details').evaluate((el) => el.open), true, 'New provider draft must open Connection details (isNew stable).');
      await expect(draft.locator('select')).toHaveValue('openai-compatible');
      await draft.locator('.er-providers__fields input').first().fill(evalProviderId);
      assert.equal(await draft.locator('details.er-providers__details').evaluate((el) => el.open), true, 'Editing the provider ID must keep Connection details open.');
      await draft.locator('input[placeholder="https://"]').fill('https://example.invalid/v1/');
      await draft.locator('input[placeholder="custom-command-code"]').fill('custom-eval-provider');
      await draft.locator('input[placeholder="v1"]').fill('v1');
      await draft.getByRole('checkbox', { name: 'Enabled' }).uncheck();
      await expect(draft.getByRole('checkbox', { name: 'Enabled' })).not.toBeChecked();
      const saveProviders = ppage.getByRole('button', { name: 'Save providers', exact: true });
      await saveProviders.scrollIntoViewIfNeeded();
      const putResponse = ppage.waitForResponse((r) => r.url() === browserOrigin + '/api/models/providers' && r.request().method() === 'PUT', { timeout: 30000 });
      await saveProviders.click();
      assert.equal((await putResponse).status(), 200, 'Explicit Save providers must PUT 200.');
      await expect(ppage.getByText('Saved.', { exact: true })).toBeVisible();
      const saved = await apiJson('/api/models/providers');
      assert.equal(saved.status, 200);
      assert.equal(saved.body.providers.length, 4, 'Saved providers must append the eval row.');
      const evalRow = saved.body.providers.find((p) => p && p.id === evalProviderId);
      assert(evalRow, 'Saved providers must contain the eval provider ID.');
      assert.equal(evalRow.type, 'openai-compatible');
      assert.equal(evalRow.baseUrl, 'https://example.invalid/v1', 'Base URL must normalize without a trailing slash.');
      assert.equal(evalRow.gatewaySlug, 'custom-eval-provider');
      assert.equal(evalRow.gatewayPath, 'v1');
      assert.equal(evalRow.enabled, false, 'Eval provider must stay disabled so no discovery or inference runs.');
      await ppage.reload();
      await expect(ppage.getByRole('heading', { name: 'Providers', exact: true })).toBeVisible();
      await expect(ppage.locator('.er-providers__item', { hasText: evalProviderId })).toBeVisible();
      assert.equal(providerRefreshPosts, 0, 'Save/load/edit must not trigger an automatic catalogue refresh.');
      assert.equal(providerTurnPosts, 0, 'Provider editing must not start a model turn.');
      assert.equal(providerSettingsPuts, 0, 'Provider editing must not PUT global model settings.');
      assert.deepEqual(providerBlocked, [], 'Provider phase must attempt no blocked mutation besides the explicit provider PUT.');
      assert.deepEqual(providerErrors, [], 'Provider editing must not throw page errors.');
      providerCrudInner = { evalProviderId, puts: providerPuts, gets: providerGets, settingsPuts: providerSettingsPuts, refreshPosts: providerRefreshPosts, turnPosts: providerTurnPosts, blocked: providerBlocked, restored: false };
      providerCrud = providerCrudInner;
    } finally {
      const restore = await apiJson('/api/models/providers', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providers: providersBefore.body.providers }) });
      assert.equal(restore.status, 200, 'Restore of the 3 seeded providers must PUT 200.');
      const reread = await apiJson('/api/models/providers');
      assert.equal(reread.status, 200);
      assert.equal(reread.body.providers.length, 3, 'Restored providers must return to 3 rows.');
      assert.deepEqual(reread.body.providers, providersBefore.body.providers, 'Restored providers must equal the pre-eval snapshot.');
      providerCrud.restored = true;
      await providerContext.close().catch(() => undefined);
    }
    const providerReloadContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const reloadPage = await providerReloadContext.newPage();
      await reloadPage.goto(browserOrigin + '/settings');
      await expect(reloadPage.getByRole('heading', { name: 'Providers', exact: true })).toBeVisible();
      assert.equal(await reloadPage.locator('.er-providers__item').count(), 3, 'Reload after restore must show 3 providers.');
      await expect(reloadPage.locator('.er-providers__item', { hasText: evalProviderId })).toHaveCount(0);
    } finally {
      await providerReloadContext.close().catch(() => undefined);
    }
  } finally { await browser.close(); }
  const after = await apiJson('/api/settings');
  assert.equal(after.body.settings.answerModel, before.body.settings.answerModel, 'Answer default must be unchanged.');
  assert.equal(after.body.settings.distillModel, before.body.settings.distillModel, 'Understanding default must be unchanged.');
  assert.deepEqual(after.body.settings, before.body.settings, 'Answer/distill settings must be unchanged (Save carries only models).');
  assert.deepEqual(after.body.usage, before.body.usage, 'Daily token usage must be unchanged by storage-only checks.');
  assert.equal((await apiJson('/api/models/connection')).body.connection.gatewayId, null);
  const result = { scope: 'LOCAL_CONNECTION_AND_ADMISSION', projectId, chatId, consentRejected: true, disconnectedTurnTokenLimit: turn.body.turn.tokenLimit ?? null,
    catalogue: { externalModels: externals.length, providers: [...new Set(nativePairs.map((pair) => pair[0]))], discovery: warnings.length ? 'PARTIAL' : 'NO_WARNINGS', warnings },
    dailyUsage: after.body.usage, provider: 'NOT_RUN', streaming: 'NOT_RUN', distill, browser390: 'LOCAL_PASS', credentialAccess: 'NOT_ENABLED' };
  result.providerCrud = providerCrud;
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
    let usage = { inputTokens: null, cachedTokens: null, outputTokens: null, tokenLimit: null, firstTokenMs: null, totalMs: null };
    let providerUsageRaw = null;
    let distillUsage = null;
    const providerCosts = { chatUsd: null, distillUsd: null };
    let usageCompleteness = 'partial', nullFields = ['inputTokens', 'cachedTokens', 'outputTokens', 'tokenLimit', 'firstTokenMs', 'totalMs'];
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
      for (const kk of ['inputTokens', 'cachedTokens', 'outputTokens', 'tokenLimit', 'firstTokenMs', 'totalMs']) assert(t[kk] === null || typeof t[kk] === 'number', 'Turn usage must be known or honestly null (' + tag + ' ' + kk + ').');
      if (t.estimatedCostMicrousd !== undefined) assert(t.estimatedCostMicrousd === null || typeof t.estimatedCostMicrousd === 'number', 'Historical estimatedCost must be honestly recorded, never gated (' + tag + ').');
      usage = { inputTokens: t.inputTokens ?? null, cachedTokens: t.cachedTokens ?? null, outputTokens: t.outputTokens ?? null, tokenLimit: t.tokenLimit ?? null, firstTokenMs: t.firstTokenMs ?? null, totalMs: t.totalMs ?? null };
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
  const costsLegacy = perModel.flatMap((p) => [p.providerCosts.chatUsd, p.providerCosts.distillUsd]);
  const providerReportedCost = (costsLegacy.length > 0 && costsLegacy.every((c) => typeof c === 'number')) ? costsLegacy.reduce((n, c) => n + c, 0) : 'UNKNOWN (legacy historical USD only, never gated)';
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
const settingsSnapshot = await apiJson('/api/settings');
assert.equal(settingsSnapshot.status, 200, 'GET /api/settings must be 200; benchmark model comes from the stored global default.');
const benchmarkModel = settingsSnapshot.body?.settings?.answerModel;
const projectModelOverride = typeof proj.answerModel === 'string' && proj.answerModel ? proj.answerModel : null;
if (runModel) assert(typeof benchmarkModel === 'string' && benchmarkModel.length > 0, 'The stored global answerModel is required; no catalogue refresh or model override is allowed.');
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
let chatId = resumeChat;
if (!chatId) {
  const cj = await apiJson('/api/projects/' + encodeURIComponent(proj.id) + '/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'k2-eval ' + Date.now() }) });
  assert(cj.status === 201 || cj.status === 200, 'POST chats must be 201/200; got ' + cj.status + ' (K2 product API not wired yet).');
  assert(cj.body && typeof cj.body.chat === 'object', 'POST chats must return {chat}.');
  assert(typeof cj.body.chat.id === 'string' && cj.body.chat.id.length > 0, 'chat.id required.');
  chatId = cj.body.chat.id;
}
const chatPath = '/api/projects/' + encodeURIComponent(proj.id) + '/chats/' + encodeURIComponent(chatId);
let configuredUsageDayStart = null;
async function getChat(what, signal) {
  const h = await apiJson(chatPath, signal ? { signal } : undefined);
  assert.equal(h.status, 200, 'GET chat must be 200 and storage-only (' + what + ').');
  assert(h.body && typeof h.body.chat === 'object', 'GET chat must return {chat, turns, usage}.');
  assert(Array.isArray(h.body.turns), 'GET chat must return turns array.');
  assert(h.body.usage && typeof h.body.usage.dayStart === 'number' && typeof h.body.usage.dayEnd === 'number', 'GET chat must return usage {dayStart,dayEnd,inputTokens,outputTokens,cachedTokens,unknownUsages}.');
  for (const k of ['inputTokens', 'outputTokens', 'cachedTokens', 'unknownUsages']) assert(Number.isSafeInteger(h.body.usage[k]) && h.body.usage[k] >= 0, 'GET chat must return valid daily usage: ' + k);
  if (configuredUsageDayStart === null) configuredUsageDayStart = h.body.usage.dayStart;
  assert.equal(h.body.usage.dayStart, configuredUsageDayStart, 'Usage day window must stay stable; this script never writes it.');
  return h.body;
}
const h0 = await getChat(resumeChat ? 'resume' : 'before');
if (resumeChat) assert.equal(h0.chat.id, resumeChat, 'Resumed chat id must match ELIOT_EVAL_CHAT.');
const m0 = h0.usage;
const whole = new Map();
async function checkRange(rev, st, en) {
  let w = whole.get(rev);
  if (!w) { const t = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/text'); assert.equal(t.status, 200, 'GET revision text 200.'); w = t.bytes; whole.set(rev, w); }
  const r = await apiBytes('/api/revisions/' + encodeURIComponent(rev) + '/range?start=' + st + '&end=' + en);
  assert.equal(r.status, 200, 'Each cited range must open (GET range 200).');
  assert(r.bytes.equals(w.subarray(st, en)), 'Cited range must equal the whole-text slice.');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(r.bytes);
}
function sameSet(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && expected.every((id) => actual.includes(id));
}
function exactStoredTurn(qid, turns, used) {
  const matches = turns.filter((turn) => turn && typeof turn.turnId === 'string' && !used.has(turn.turnId)
    && turn.question === Q.get(qid) && turn.scopeMode === 'explicit' && turn.contextMode === 'whole'
    && sameSet(turn.sourceIds, sourceIds) && sameSet(turn.revisionIds, scoped.map((source) => source.currentRevisionId)));
  return matches.length ? matches[matches.length - 1] : null;
}
async function inspectTurn(qid, turn, source, wall, defaultModel, storedDiagnostic = false) {
  const row = {
    qid,
    turnId: typeof turn?.turnId === 'string' ? turn.turnId : null,
    answer: typeof turn?.answer === 'string' ? turn.answer : null,
    model: typeof turn?.model === 'string' ? turn.model : null,
    turnState: typeof turn?.state === 'string' ? turn.state : 'UNKNOWN',
    routeStatus: turn?.model === defaultModel ? 'GLOBAL_DEFAULT' : 'NON_DEFAULT_DIAGNOSTIC',
    factChecks: [],
    citationRanges: [],
    citationSummary: 'NOT_RUN',
    timing: { firstTokenMs: turn?.firstTokenMs ?? null, totalMs: turn?.totalMs ?? null, wallMs: wall ?? null },
    usage: {
      inputTokens: turn?.inputTokens ?? null,
      cachedTokens: turn?.cachedTokens ?? null,
      outputTokens: turn?.outputTokens ?? null,
      tokenLimit: turn?.tokenLimit ?? null,
      actualProviderCostUsd: actualProviderCostUsd(turn),
    },
    failures: [],
  };
  const failures = row.failures;
  const answer = row.answer ?? '';
  if (!turn || typeof turn !== 'object') failures.push('stored turn payload is missing');
  if (typeof turn?.answer !== 'string') failures.push('turn has no answer text');
  if (turn?.state !== 'completed') failures.push('turn state is ' + String(turn?.state ?? 'UNKNOWN'));
  if (turn?.model !== defaultModel) failures.push('turn model differs from the frozen global default');
  if (!sameSet(turn?.sourceIds, sourceIds) || !sameSet(turn?.revisionIds, scoped.map((source) => source.currentRevisionId))) {
    failures.push('turn scope does not match the exact current arxiv-10 source/revision set');
  }
  if (!Array.isArray(turn?.citations) || turn.citations.length === 0) failures.push('turn has no citations');
  if (typeof turn?.invalidLabels !== 'number' || turn.invalidLabels !== 0) failures.push('invalidLabels is not zero');
  for (const field of ['inputTokens', 'cachedTokens', 'outputTokens', 'tokenLimit', 'firstTokenMs', 'totalMs']) {
    if (typeof turn?.[field] !== 'number' || !Number.isFinite(turn[field])) failures.push('turn.' + field + ' is unknown');
  }
  if (turn?.estimatedCostMicrousd !== undefined && turn?.estimatedCostMicrousd !== null && typeof turn?.estimatedCostMicrousd !== 'number') failures.push('historical estimatedCost must be numeric when present');
  if (typeof turn?.totalMs === 'number' && turn.totalMs > 90000) failures.push('completed turn exceeded the 90 second K2 ceiling');

  const citationQuotes = new Map();
  const citations = Array.isArray(turn?.citations) ? turn.citations : [];
  const revOwner = new Map(scoped.filter((source) => source && typeof source.currentRevisionId === 'string')
    .map((source) => [source.currentRevisionId, source.id]));
  for (const [index, citation] of citations.entries()) {
    const check = {
      label: typeof citation?.label === 'string' ? citation.label : 'citation-' + String(index + 1),
      revisionId: citation?.revisionId ?? 'UNKNOWN',
      sourceId: citation?.sourceId ?? 'UNKNOWN',
      block: citation?.block ?? 'UNKNOWN',
      start: citation?.start ?? 'UNKNOWN',
      end: citation?.end ?? 'UNKNOWN',
      status: 'FAIL',
      reason: null,
    };
    const validRange = citation && typeof citation.revisionId === 'string' && typeof citation.sourceId === 'string'
      && Number.isSafeInteger(citation.block) && Number.isSafeInteger(citation.start) && Number.isSafeInteger(citation.end)
      && citation.start >= 0 && citation.end > citation.start;
    if (!validRange) check.reason = 'citation identity/block/byte range is malformed';
    else if (!Array.isArray(turn.revisionIds) || !turn.revisionIds.includes(citation.revisionId)) check.reason = 'revision is outside the turn frozen scope';
    else if (revOwner.get(citation.revisionId) !== citation.sourceId) check.reason = 'sourceId does not own the cited revision';
    else {
      try {
        const quote = await checkRange(citation.revisionId, citation.start, citation.end);
        citationQuotes.set(citation.label, quote);
        check.quote = quote;
        check.status = 'PASS';
      } catch (error) {
        check.reason = error instanceof Error ? error.message : String(error);
      }
    }
    if (check.status !== 'PASS') failures.push(check.label + ': ' + check.reason);
    row.citationRanges.push(check);
  }
  let uncited = null;
  let unsupportedNumeric = null;
  try {
    if (typeof turn?.answer === 'string' && Array.isArray(turn?.citations)) {
      uncited = uncitedStatements(answer, turn.citations);
      unsupportedNumeric = unsupportedNumericStatements(answer, turn.citations, citationQuotes);
    }
  } catch (error) {
    failures.push('citation/fact verifier threw: ' + (error instanceof Error ? error.message : String(error)));
  }
  if (uncited === null) failures.push('uncited-statement check NOT_RUN (answer/citations unavailable)');
  else if (uncited > 0) failures.push(uncited + ' factual statement(s) lack adjacent citations');
  if (unsupportedNumeric === null) failures.push('numeric grounding check NOT_RUN (answer/citations unavailable)');
  else if (unsupportedNumeric > 0) failures.push(unsupportedNumeric + ' numeric statement(s) are unsupported by their exact citation ranges');
  if (citations.length) row.citationSummary = citations.length + ' citation(s); ' + row.citationRanges.filter((range) => range.status === 'PASS').length + '/' + citations.length + ' ranges open';
  else row.citationSummary = '0 citations';
  const factChecks = checkAnswer(qid, answer);
  factChecks.push({ name: 'citation byte ranges', status: row.citationRanges.length > 0 && row.citationRanges.every((range) => range.status === 'PASS') ? 'PASS' : 'FAIL', detail: row.citationSummary });
  factChecks.push({ name: 'uncited factual statements', status: uncited === 0 ? 'PASS' : uncited === null ? 'NOT_RUN' : 'FAIL', detail: uncited === null ? 'Unavailable.' : String(uncited) + ' found.' });
  factChecks.push({ name: 'numeric citation support', status: unsupportedNumeric === 0 ? 'PASS' : unsupportedNumeric === null ? 'NOT_RUN' : 'FAIL', detail: unsupportedNumeric === null ? 'Unavailable.' : String(unsupportedNumeric) + ' unsupported.' });
  for (const field of ['inputTokens', 'cachedTokens', 'outputTokens', 'tokenLimit', 'firstTokenMs', 'totalMs']) {
    factChecks.push({ name: field, status: typeof turn?.[field] === 'number' && Number.isFinite(turn[field]) ? 'PASS' : 'FAIL', detail: String(turn?.[field] ?? 'UNKNOWN') });
  }
  row.factChecks = factChecks;
  for (const check of factChecks) if (check.status === 'FAIL') failures.push(check.name + ' failed');
  row.hardFailures = [...failures];
  row.ownerReview = ['O1', 'O2', 'O3', 'O8'].includes(qid) ? 'OWNER_REQUIRED' : 'NOT_A_SEMANTIC_AUTO_GATE';
  row.source = source;
  if (!failures.length && row.ownerReview === 'OWNER_REQUIRED') row.status = 'OWNER_REVIEW_REQUIRED';
  else if (!failures.length) row.status = 'MECHANICAL_PASS';
  else if (turn?.state === 'partial') row.status = 'PARTIAL';
  else if (turn?.state === 'failed') row.status = 'FAILED';
  else row.status = 'QUALITY_FAIL';
  if (storedDiagnostic && row.routeStatus !== 'GLOBAL_DEFAULT') row.status = 'NON_DEFAULT_DIAGNOSTIC_' + row.status;
  return row;
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
  const doc = { chatId, qid, turnId: turn.turnId, reused: !!extra.reused, src: extra.src, question: extra.question || null, model: turn.model ?? null, answer: turn.answer ?? null, state: turn.state, error: turn.error ?? null, citations: turn.citations ?? null, invalidLabels: turn.invalidLabels ?? null, inputTokens: turn.inputTokens ?? null, cachedTokens: turn.cachedTokens ?? null, outputTokens: turn.outputTokens ?? null, tokenLimit: turn.tokenLimit ?? null, actualProviderCostUsd: actualProviderCostUsd(turn), firstTokenMs: turn.firstTokenMs ?? null, totalMs: turn.totalMs ?? null, wallMs: extra.wall ?? null };
  await writeFile(outDir + '/k2-' + qid + '-' + String(turn.turnId).slice(0, 8) + '.json', JSON.stringify(doc, null, 2));
}
function actualProviderCostUsd(turn) {
  const v = turn && turn.providerUsage ? turn.providerUsage.costUsd : null;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}
function dispatchUnavailable(status, body, turn) {
  const error = body?.error ?? body?.turn?.error ?? turn?.error ?? null;
  const code = String(error?.code ?? body?.code ?? '').toLowerCase();
  const message = String(error?.message ?? error ?? body?.message ?? '');
  if ([401, 402, 403, 408, 429, 500, 502, 503, 504].includes(status)) return true;
  if (['auth', 'unauthorized', 'forbidden', 'budget', 'unavailable', 'busy', 'rate_limited'].includes(code)) return true;
  if (/credential|unauthori[sz]ed|forbidden|budget|quota|rate.?limit|disconnected|\bprovider.{0,24}(?:unavailable|error|failed)|temporarily unavailable|\bgateway.{0,24}(?:unavailable|error|failed)/i.test(message)) return true;
  // Own 90 s deadline stays continuable: the next distinct question may dispatch.
  if (/exceeded the 90 s time bound|Time bound exceeded before dispatch/i.test(message)) return false;
  // Exact-turn timeout reconciliation stores provider failures as HTTP 200 with
  // the failure embedded in turn.error (model-transport.ts modelFailure shapes).
  // Stop on the same codes when embedded as HTTP; an explicit non-stop HTTP
  // code (e.g. 400 validation) keeps the prior continue behavior.
  if (/\bHTTP\s+(401|402|403|408|429|500|502|503|504)\b/i.test(message)) return true;
  if (/\bHTTP\s+\d{3}\b/i.test(message)) return false;
  // Per-question validation stays continuable in either existing failure
  // format: predispatch AI_Invalid* and in-band invalid_request_error.
  // Still stops 5xx/auth/rate/budget above and continues the own 90s deadline.
  if (/AI_InvalidPromptError|AI_InvalidArgumentError/i.test(message)) return false;
  if (/AI_StreamProviderError:invalid_request_error/i.test(message)) return false;
  // Validation-shaped stream failures stay per-question and do not stop the batch.
  if (/Model stream failed\s*\((?:AI_Invalid|Zod)/i.test(message)) return false;
  if (/External model request failed|Model stream failed/i.test(message)) return true;
  if (/authentication_error|permission_error|rate_limit_error|server_error|overloaded_error/i.test(message)) return true;
  return false;
}
if (!runModel && !storedOnly) {
  const h1 = await getChat('re-read');
  assert.equal(h1.turns.length, h0.turns.length, 'History re-read must not add turns.');
  assert.deepEqual(h1.usage, m0, 'Pure history re-read must not change usage.');
  const md = ['# K2 native-only (storage, zero model calls)', '', '- project: ' + title, '- chat: ' + chatId + (resumeChat ? ' (resumed)' : ''), '- history: ' + h0.turns.length + ' turns, daily usage stable across re-reads', '- reader range self-check: 1 exact range', '- MODEL_NOT_RUN: set ELIOT_K2_MODEL=1 (root signal) for C1-4/O1-8 paid turns.', '- Stop/reconnect/Save: NOT_RUN here (root browser journey).', ''].join(EOL);
  await writeFile(outDir + '/k2-native-' + Date.now() + '.md', md);
  console.log(md);
  process.exit(0);
}
if (storedOnly) {
  const sUsed = new Set();
  let storedFailures = 0;
  let ownerRequired = false;
  let stopReason = null;
  for (const qid of order) {
    const turn = exactStoredTurn(qid, h0.turns, sUsed);
    if (!turn) {
      storedFailures++;
      markQuestionNotRun(qid, 'No stored turn has this exact question and exact frozen ten-source revision set.', 'NOT_REVALIDATED');
      continue;
    }
    sUsed.add(turn.turnId);
    let row;
    try { row = await inspectTurn(qid, turn, 'stored-only', null, benchmarkModel, true); }
    catch (error) {
      row = { qid, answer: typeof turn.answer === 'string' ? turn.answer : null, model: turn.model ?? null,
        turnState: turn.state ?? 'UNKNOWN', routeStatus: turn.model === benchmarkModel ? 'GLOBAL_DEFAULT' : 'NON_DEFAULT_DIAGNOSTIC',
        status: 'QUALITY_FAIL', reason: error instanceof Error ? error.message : String(error), factChecks: [], hardFailures: [], citationRanges: [],
        citationSummary: 'CHECK_FAILED', timing: { firstTokenMs: turn.firstTokenMs ?? null, totalMs: turn.totalMs ?? null, wallMs: null },
        usage: { inputTokens: turn.inputTokens ?? null, cachedTokens: turn.cachedTokens ?? null, outputTokens: turn.outputTokens ?? null,
          tokenLimit: turn.tokenLimit ?? null, actualProviderCostUsd: actualProviderCostUsd(turn) } };
    }
    compareRows.set(qid, row);
    if (row.status === 'OWNER_REVIEW_REQUIRED') ownerRequired = true;
    else if (row.status !== 'MECHANICAL_PASS') storedFailures++;
  }
  let finalChat = null;
  try { finalChat = await getChat('stored-final'); }
  catch (error) { stopReason = 'Final storage-only chat/usage read failed: ' + (error instanceof Error ? error.message : String(error)); }
  if (!finalChat) storedFailures++;
  else {
    if (finalChat.turns.length !== h0.turns.length) { storedFailures++; stopReason = 'Stored-only revalidation changed the chat turn count.'; }
    if (JSON.stringify(finalChat.usage) !== JSON.stringify(m0)) { storedFailures++; stopReason = 'Stored-only revalidation changed daily token usage.'; }
  }
  const status = storedFailures > 0 ? 'FAIL' : ownerRequired ? 'OWNER_REQUIRED' : 'MECHANICAL_PASS';
  await writeCompare(compareRows, { mode: 'stored-only diagnostic; zero model calls/POSTs; recorded turn route shown per row',
    defaultModel: benchmarkModel, projectModelOverride: projectModelOverride ?? 'none', chatId, status, stopReason,
    usageBefore: m0, usageAfter: finalChat?.usage ?? 'UNKNOWN',
    turnCountBefore: h0.turns.length, turnCountAfter: finalChat?.turns.length ?? 'UNKNOWN' });
  if (storedFailures > 0) process.exit(1);
  if (ownerRequired) process.exit(2);
  process.exit(0);
}
const firstMs = [], totalMs = [];
let newTokenLimit = 0, reportedTokenLimit = 0, unknownTokenLimits = 0, unknownNewTokenLimits = 0;
let actualKnownUsd = 0, actualKnownCount = 0, actualUnknown = 0, actualUnknownNew = 0;
let newCount = 0, hardFailures = 0, ownerRequired = false, manual = 0;
let dispatchStopped = false, stopReason = null;
const used = new Set();
const unknownDispatchIds = new Map();
function isTerminalReconciledTurn(stored) {
  const s = stored && typeof stored.state === 'string' ? stored.state : null;
  return s === 'completed' || s === 'partial' || s === 'failed' || s === 'cancelled';
}
async function observeDispatchedTurn(requestTurnId, qid) {
  // READ-ONLY reconciliation of an already-dispatched turn id after a POST
  // wait timed out. Bounded storage-only GET observation (at most two chat
  // snapshots, each GET with a finite AbortSignal deadline): never another
  // POST, never the same question again. Returns the stored turn only when
  // the submitted id is visible AND terminal (completed/partial/failed/
  // cancelled); a visible pending turn (started/streaming/running/unknown)
  // stays tracked as DISPATCH_UNKNOWN with reservation UNKNOWN, never
  // adopted and never zeroed. Only the matching submitted turnId is adopted.
  for (let attempt = 1; attempt <= 2; attempt++) {
    let snap = null;
    try { snap = await getChat('reconcile-' + qid + '-attempt-' + attempt, AbortSignal.timeout(30000)); }
    catch (readError) { snap = null; }
    const found = snap && Array.isArray(snap.turns)
      ? snap.turns.find((t) => t && t.turnId === requestTurnId) : null;
    if (found && isTerminalReconciledTurn(found)) return found;
    if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return null;
}
async function adoptReconciledTurn(qid, stored, wall, via) {
  // Inspect an already-accepted stored turn found by read reconciliation and
  // fold its actual state/body/citations/reserved tokenLimit into the aggregates.
  // Unknown input/output stays UNKNOWN; nothing is re-dispatched.
  let persistenceError = null;
  try { await saveTurn(qid, stored, { src: via, wall, question: Q.get(qid) }); }
  catch (error) { persistenceError = error instanceof Error ? error.message : String(error); }
  let row;
  try { row = await inspectTurn(qid, stored, via, wall, benchmarkModel, false); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    row = { qid, answer: typeof stored?.answer === 'string' ? stored.answer : null, model: stored?.model ?? null,
      turnState: stored?.state ?? 'UNKNOWN', routeStatus: stored?.model === benchmarkModel ? 'GLOBAL_DEFAULT' : 'NON_DEFAULT_DIAGNOSTIC',
      status: 'QUALITY_FAIL', reason, factChecks: [], hardFailures: [reason], citationRanges: [], citationSummary: 'CHECK_FAILED',
      timing: { firstTokenMs: stored?.firstTokenMs ?? null, totalMs: stored?.totalMs ?? null, wallMs: wall },
      usage: { inputTokens: stored?.inputTokens ?? null, cachedTokens: stored?.cachedTokens ?? null, outputTokens: stored?.outputTokens ?? null,
        tokenLimit: stored?.tokenLimit ?? null, actualProviderCostUsd: actualProviderCostUsd(stored) } };
  }
  row.hardFailures = [...(row.hardFailures ?? []), 'Dispatch wait timed out; this accepted turn was reconciled by bounded storage-only read of the submitted turn id (' + via + '). No retry was sent and the question was not repeated.'];
  if (persistenceError) row.hardFailures = [...row.hardFailures, 'Could not preserve the new raw turn artifact: ' + persistenceError];
  compareRows.set(qid, row);
  unknownDispatchIds.delete(qid);
  newCount++;
  if (row.status === 'OWNER_REVIEW_REQUIRED') ownerRequired = true;
  else if (row.status !== 'MECHANICAL_PASS') hardFailures++;
  const reconciledLimit = stored.tokenLimit;
  if (typeof reconciledLimit === 'number' && Number.isSafeInteger(reconciledLimit) && reconciledLimit >= 0) {
    reportedTokenLimit += reconciledLimit;
    newTokenLimit += reconciledLimit;
  } else {
    unknownNewTokenLimits++;
  }
  const reconciledActual = actualProviderCostUsd(stored);
  if (reconciledActual === null) { actualUnknown++; }
  else { actualKnownUsd += reconciledActual; actualKnownCount++; }
  if (typeof stored.firstTokenMs === 'number') firstMs.push(stored.firstTokenMs);
  if (typeof stored.totalMs === 'number') totalMs.push(stored.totalMs);
  return row;
}
for (const qid of order) {
  if (dispatchStopped) {
    hardFailures++;
    markQuestionNotRun(qid, 'Dispatch stopped after provider/auth/budget unavailability: ' + (stopReason || 'unknown cause'), 'NOT_RUN');
    continue;
  }
  let turn = null, src = 'new', wall = null, requestTurnId = null;
  if (resumeChat) {
    const candidate = exactStoredTurn(qid, h0.turns, used);
    if (candidate) { turn = candidate; src = 'reused'; used.add(candidate.turnId); }
    else if (h0.turns.some((existing) => existing && existing.question === Q.get(qid))) {
      hardFailures++; manual++;
      markQuestionNotRun(qid, 'A same-question turn already exists but does not match the exact source scope; no repeat was sent.', 'PENDING_MANUAL');
      continue;
    }
  }
  if (!turn) {
    requestTurnId = randomUUID();
    const started = Date.now();
    let response = null, requestError = null;
    try {
      response = await apiJson(chatPath + '/turns?wait=1', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(90000), body: JSON.stringify({ turnId: requestTurnId, question: Q.get(qid),
          scopeMode: 'explicit', sourceIds, model: benchmarkModel }) });
    } catch (error) { requestError = error instanceof Error ? error.message : String(error); }
    wall = Date.now() - started;
    if (requestError) {
      // The POST wait timed out, but the turn may already be stored server-side
      // under requestTurnId. Reconcile that exact id with bounded storage-only
      // GET observation (each GET has a finite AbortSignal deadline): never
      // another POST, never the same question again. A matching terminal turn
      // (completed/partial/failed/cancelled, including its own 90s deadline or
      // cancel) is recorded and the explicit 12-question batch continues with
      // the next distinct question. Only an unknown outcome or provider/auth/
      // budget unavailability stops the rest. Partial/quality warnings never
      // stop the batch.
      let reconciled = null;
      try { reconciled = await observeDispatchedTurn(requestTurnId, qid); }
      catch (observeError) { reconciled = null; }
      if (reconciled) {
        turn = reconciled;
        await adoptReconciledTurn(qid, turn, wall, 'reconciled-timeout-read');
        if (dispatchUnavailable(200, null, turn)) {
          dispatchStopped = true;
          stopReason = 'Reconciled turn ' + qid + ' reports provider/auth/budget unavailability; no further questions were dispatched: ' + requestError;
        }
        continue;
      }
      const reason = 'Turn dispatch outcome unknown after bounded read reconciliation; no retry: ' + requestError;
      compareRows.set(qid, { qid, answer: null, model: benchmarkModel, turnState: 'DISPATCH_UNKNOWN', routeStatus: 'GLOBAL_DEFAULT',
        status: 'DISPATCH_UNAVAILABLE', reason, factChecks: [{ name: 'dispatch', status: 'FAIL', detail: reason }], hardFailures: [reason],
        citationRanges: [], citationSummary: 'NOT_RUN', timing: { firstTokenMs: null, totalMs: null, wallMs: wall },
        usage: { inputTokens: null, cachedTokens: null, outputTokens: null, tokenLimit: null, actualProviderCostUsd: null } });
      unknownDispatchIds.set(qid, requestTurnId);
      hardFailures++; dispatchStopped = true; stopReason = reason;
      continue;
    }
    const responseTurn = response?.body?.turn;
    const responseTurnValid = !!responseTurn && typeof responseTurn === 'object' && !Array.isArray(responseTurn);
    if (!response || (response.status !== 200 && response.status !== 201) || !response.body || !responseTurnValid) {
      const status = response?.status ?? 'unread';
      const errorText = String(response?.body?.error?.message ?? response?.body?.message ?? 'response did not include the owning turn');
      const reason = 'POST turn failed with status ' + status + ': ' + errorText + '; no retry.';
      const stop = dispatchUnavailable(response?.status ?? 0, response?.body, null) || !response || !response.body || !responseTurnValid;
      compareRows.set(qid, { qid, answer: null, model: benchmarkModel, turnState: 'DISPATCH_FAILED', routeStatus: 'GLOBAL_DEFAULT',
        status: stop ? 'DISPATCH_UNAVAILABLE' : 'DISPATCH_FAILED', reason, factChecks: [{ name: 'dispatch', status: 'FAIL', detail: reason }], hardFailures: [reason],
        citationRanges: [], citationSummary: 'NOT_RUN', timing: { firstTokenMs: null, totalMs: null, wallMs: wall },
        usage: { inputTokens: null, cachedTokens: null, outputTokens: null, tokenLimit: null, actualProviderCostUsd: null } });
      hardFailures++;
      if (stop) { dispatchStopped = true; stopReason = reason; }
      continue;
    }
    turn = responseTurn;
    newCount++;
  }
  let persistenceError = null;
  if (src === 'new') {
    try { await saveTurn(qid, turn, { src, wall, question: Q.get(qid) }); }
    catch (error) { persistenceError = error instanceof Error ? error.message : String(error); }
  }
  let row;
  try { row = await inspectTurn(qid, turn, src, wall, benchmarkModel, false); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    row = { qid, answer: typeof turn?.answer === 'string' ? turn.answer : null, model: turn?.model ?? null,
      turnState: turn?.state ?? 'UNKNOWN', routeStatus: turn?.model === benchmarkModel ? 'GLOBAL_DEFAULT' : 'NON_DEFAULT_DIAGNOSTIC',
      status: 'QUALITY_FAIL', reason, factChecks: [], hardFailures: [reason], citationRanges: [], citationSummary: 'CHECK_FAILED',
      timing: { firstTokenMs: turn?.firstTokenMs ?? null, totalMs: turn?.totalMs ?? null, wallMs: wall },
      usage: { inputTokens: turn?.inputTokens ?? null, cachedTokens: turn?.cachedTokens ?? null, outputTokens: turn?.outputTokens ?? null,
        tokenLimit: turn?.tokenLimit ?? null, actualProviderCostUsd: actualProviderCostUsd(turn) } };
  }
  if (src === 'new' && turn.turnId !== requestTurnId) {
    const reason = 'Returned turnId does not match the one submitted; no replacement request was sent.';
    row.hardFailures = [...(row.hardFailures ?? []), reason];
    row.status = 'QUALITY_FAIL';
    dispatchStopped = true; stopReason = reason;
  }
  if (persistenceError) {
    const reason = 'Could not preserve the new raw turn artifact: ' + persistenceError;
    row.hardFailures = [...(row.hardFailures ?? []), reason];
    row.status = 'QUALITY_FAIL';
  }
  compareRows.set(qid, row);
  if (row.status === 'OWNER_REVIEW_REQUIRED') ownerRequired = true;
  else if (row.status !== 'MECHANICAL_PASS') hardFailures++;
  const limit = turn.tokenLimit;
  if (typeof limit === 'number' && Number.isSafeInteger(limit) && limit >= 0) {
    reportedTokenLimit += limit;
    if (src === 'new') newTokenLimit += limit;
  } else {
    unknownTokenLimits++;
    if (src === 'new') unknownNewTokenLimits++;
  }
  const actual = actualProviderCostUsd(turn);
  if (actual === null) { actualUnknown++; if (src === 'new') actualUnknownNew++; }
  else { actualKnownUsd += actual; actualKnownCount++; }
  if (typeof turn.firstTokenMs === 'number') firstMs.push(turn.firstTokenMs);
  if (typeof turn.totalMs === 'number') totalMs.push(turn.totalMs);
  if (turn.state === 'running') {
    dispatchStopped = true;
    stopReason = 'The turn remained running after the synchronous wait; no additional turn was dispatched.';
  } else if (dispatchUnavailable(200, null, turn)) {
    dispatchStopped = true;
    stopReason = 'The stored turn reports provider/auth/budget unavailability; no further questions were dispatched.';
  }
}
for (const qid of order) if (!compareRows.has(qid)) { hardFailures++; markQuestionNotRun(qid, 'No diagnostic row was produced.', 'NOT_RUN'); }
let finalChat = null, finalReadError = null;
try {
  finalChat = await getChat('after turns');
  const reread = await getChat('final re-read');
  if (JSON.stringify(reread.usage) !== JSON.stringify(finalChat.usage)) {
    hardFailures++; finalReadError = 'Daily token usage changed between final storage reads.';
  }
} catch (error) { hardFailures++; finalReadError = error instanceof Error ? error.message : String(error); }
if (!finalChat) stopReason = 'Final storage/usage re-read failed: ' + (finalReadError || 'unknown error');
else {
  // Final-read reconciliation: any still-unresolved dispatched id is looked up
  // once more in the final storage snapshot. Only an accepted matching terminal
  // turn (completed/partial/failed/cancelled) is adopted with its actual
  // state/body/citations/reserved tokenLimit (unknown input/output preserved);
  // a still-pending visible turn (started/streaming/running/unknown) or an
  // unresolvable id keeps DISPATCH_UNKNOWN with reservation UNKNOWN,
  // never zero. No POST anywhere.
  for (const pendingQid of unknownDispatchIds.keys()) {
    const pendingRow = compareRows.get(pendingQid);
    const pendingId = unknownDispatchIds.get(pendingQid);
    const stored = Array.isArray(finalChat.turns)
      ? finalChat.turns.find((t) => t && t.turnId === pendingId) : null;
    if (!stored) continue;
    if (!isTerminalReconciledTurn(stored)) continue;
    hardFailures--; // undo the DISPATCH_UNAVAILABLE increment; judge the reconciled row below.
    await adoptReconciledTurn(pendingQid, stored, pendingRow && pendingRow.timing ? pendingRow.timing.wallMs : null, 'reconciled-final-read');
  }
  const finalErrors = [];
  if (finalChat.turns.length !== h0.turns.length + newCount) { hardFailures++; finalErrors.push('Chat turn count does not match the pre-existing turns plus exactly one request per new question.'); }
  if (unknownNewTokenLimits > 0) { hardFailures++; finalErrors.push('At least one new turn has unknown tokenLimit; UNKNOWN is not treated as free.'); }
  const unresolvedCount = unknownDispatchIds.size;
  if (unresolvedCount > 0) { hardFailures++; finalErrors.push(unresolvedCount + ' dispatched turn(s) remain unresolved after bounded read reconciliation; any held reservation is UNKNOWN, not zero.'); }
  else if (unknownNewTokenLimits === 0) { const deltaIn = (finalChat.usage?.inputTokens ?? 0) - (m0?.inputTokens ?? 0); const deltaOut = (finalChat.usage?.outputTokens ?? 0) - (m0?.outputTokens ?? 0); if (deltaIn < 0 || deltaOut < 0 || deltaIn + deltaOut > newTokenLimit) { hardFailures++; finalErrors.push('Daily token usage delta exceeds the admitted tokenLimit sum for new turns.'); } }
  if (finalErrors.length) { finalReadError = finalErrors.join(' '); stopReason = [stopReason, finalReadError].filter(Boolean).join(' '); }
}
const status = hardFailures > 0 ? 'FAIL' : ownerRequired ? 'OWNER_REQUIRED' : 'MECHANICAL_PASS';
await writeCompare(compareRows, { mode: 'default-model benchmark; frozen global route; one request per unanswered question; no retry',
  defaultModel: benchmarkModel, projectModelOverride: projectModelOverride ?? 'none', chatId, status, stopReason,
  usageBefore: m0, usageAfter: finalChat?.usage ?? 'UNKNOWN',
  turnCountBefore: h0.turns.length, turnCountAfter: finalChat?.turns.length ?? 'UNKNOWN',
  newTokenLimit: newTokenLimit, reportedTokenLimit: reportedTokenLimit,
  actualProviderUsd: actualKnownCount ? actualKnownUsd : 'UNKNOWN', actualUnknownCount: actualUnknown,
  firstTokenP50P95: [pct(firstMs, 0.5), pct(firstMs, 0.95)], totalP50P95: [pct(totalMs, 0.5), pct(totalMs, 0.95)] });
if (hardFailures > 0) process.exit(1);
if (ownerRequired) process.exit(2);
process.exit(0);
